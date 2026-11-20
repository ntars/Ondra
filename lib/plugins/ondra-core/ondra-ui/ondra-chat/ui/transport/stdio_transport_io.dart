import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../../../../../app/bundled_runtime.dart';
import '../../../../../../app/runtime_seed.dart';
import '../chat_client.dart';
import '../../../ondra-settings/ondra-models/ui/runtime_model_config.dart';
import '../../../ondra-settings/ondra-models/ui/runtime_model_config_io.dart';
import 'rpc_frames.dart';

class _KernelLaunch {
  const _KernelLaunch({
    required this.exe,
    required this.leadingArgs,
    this.bundledRoot,
  });

  final String exe;
  final List<String> leadingArgs;
  final String? bundledRoot;

  @override
  String toString() =>
      '${[exe, ...leadingArgs].join(' ')}'
      '${bundledRoot == null ? '' : '  [bundled $bundledRoot]'}';
}

class _Connection {
  final ready = Completer<void>();
  final closed = Completer<void>();
  final pending = <int, Completer<RpcFrame>>{};
  final frames = StreamController<RpcFrame>.broadcast();
  Process? process;
  StreamSubscription<String>? lines;
  StreamSubscription<String>? stderr;
  String? stderrLast;
  Object? failure;
  bool opening = true;
  bool closing = false;
}

class _Turn {
  final output = StreamController<String>();
  final events = StreamController<Map<String, dynamic>>();
  bool done = false;

  void finish([Object? error, StackTrace? stack]) {
    if (done) return;
    done = true;
    if (error != null) output.addError(error, stack);
    unawaited(output.close());
    unawaited(events.close());
  }
}

/// 通过自有子进程收发按行分帧的 SDK JSON-RPC。
class StdioDshTransport implements DshTransport {
  StdioDshTransport({
    this.binary,
    this.modelId = 'group/ntars',
    this.provider = 'magpie',
    Map<String, String>? environment,
    List<String> binaryArgs = const [],
    this.requestTimeout = const Duration(seconds: 30),
    this.turnTimeout = const Duration(minutes: 10),
    this.modelConfig,
    this.secretResolver,
    this.workingDirectory,
    this.previousClosed,
    String? resumeSessionId,
  }) : environment = Map.unmodifiable(environment ?? Platform.environment),
       binaryArgs = List.unmodifiable(binaryArgs),
       _sessionId = resumeSessionId;

  final String? binary;
  final String modelId;
  final String provider;

  /// 提供时替代父进程环境，供子进程、profile 种子和日志共用。
  final Map<String, String> environment;
  final List<String> binaryArgs;
  final Duration requestTimeout;

  /// 整轮硬上限，不是首 token 上限；本地长推理可由调用方进一步调高。
  final Duration turnTimeout;
  final RuntimeModelConfig Function()? modelConfig;
  final Future<String?> Function(String providerId)? secretResolver;
  final String? workingDirectory;
  final Future<void>? previousClosed;
  String? _resolvedSecret;

  /// 不扩充 DshTransport 接口，现有 mocks 无需实现；装配层换实例前必须 await。
  Future<void> close() async {
    stop();
    await _retired;
  }

  _Connection? _connection;
  Future<void> _retired = Future.value();
  _Turn? _active;
  final _usage = StreamController<StepUsage>.broadcast();
  DateTime? _stepStart;
  int _nextId = 1;
  static int _nextSession = 1;
  String? _sessionId;
  String? _lastError;

  @override
  Stream<StepUsage> get usage => _usage.stream;
  String? get lastError => _lastError;
  String? get sessionId => _sessionId;

  String get _home {
    for (final key in ['HOME', 'USERPROFILE']) {
      final value = environment[key];
      if (value != null && value.isNotEmpty) return value;
    }
    return Directory.current.path;
  }

  String get _dshHome => environment['ONDRA_DSH_HOME'] ?? '$_home/.ondra/dsh';

  static bool _isWarningNoise(String line) {
    if (line.startsWith('(node:') && line.contains('Warning:')) return true;
    if (line.startsWith('(Use `node --trace-')) return true;
    if (line.startsWith('ExperimentalWarning:')) return true;
    if (line.startsWith('DeprecationWarning:')) return true;
    return false;
  }

  String _redact(String value) {
    final secret = _resolvedSecret;
    return secret == null || secret.isEmpty
        ? value
        : value.replaceAll(secret, '[redacted]');
  }

  void _log(String message) {
    message = _redact(message);
    try {
      final dir = Directory('$_home/.ondra/logs');
      if (!dir.existsSync()) dir.createSync(recursive: true);
      File('${dir.path}/transport.log').writeAsStringSync(
        '${DateTime.now().toIso8601String()}  $message\n',
        mode: FileMode.append,
        flush: true,
      );
    } catch (_) {
      // 日志失败不能影响连接。
    }
  }

  @override
  Future<void> connect() {
    final current = _connection;
    if (current != null) return current.ready.future;
    final connection = _Connection();
    _connection = connection;
    unawaited(_open(connection, _retired));
    return connection.ready.future;
  }

  void _checkConnection(_Connection connection) {
    if (connection.failure != null) throw connection.failure!;
    if (!identical(_connection, connection)) throw StateError('内核连接已失效');
  }

  Future<void> _open(_Connection connection, Future<void> retired) async {
    try {
      // 上一个进程彻底退出后才可打开同一份会话库。
      await retired;
      await previousClosed;
      _checkConnection(connection);
      // 安卓的沙箱不允许应用执行任意子进程（exec 权限被系统约束），也没有
      // node 运行时——内核在安卓上跑不了。这个守卫必须放在**最前**：
      // 后面的 seed 与模型受管段写入各自会抛「缺随包运行时」之类的话，
      // 会把真正的原因盖住（那句话在安卓上没有意义——装了也跑不了）。
      if (Platform.isAndroid) {
        throw StateError(
          '安卓版还没有可用的内核运行时：系统不允许应用启动 node 子进程。'
          '请使用桌面版，或等待远程网关接入。',
        );
      }
      final seed = seedRuntimeProfile(dshHome: _dshHome);
      if (seed.outcome != RuntimeSeedOutcome.alreadyPresent) {
        _log('profile seed: $seed');
      }
      final config = modelConfig?.call();
      var childEnvironment = environment;
      if (config != null) {
        childEnvironment = await config.resolveEnvironment(
          environment,
          secretResolver ?? (_) async => null,
        );
        _resolvedSecret = childEnvironment[config.apiKeyEnv];
        _checkConnection(connection);
        await writeRuntimeModelPatch(
          dshHome: _dshHome,
          model: config,
          environment: environment,
        );
        _checkConnection(connection);
      }
      final launch = await _resolveLaunch();
      _checkConnection(connection);
      _log('launch: $launch');
      final path = [
        File(launch.exe).parent.path,
        environment['PATH'] ??
            (Platform.isWindows ? '' : '/usr/bin:/bin:/usr/sbin:/sbin'),
      ].join(Platform.isWindows ? ';' : ':');
      final process = await Process.start(
        launch.exe,
        [
          ...launch.leadingArgs,
          ...binaryArgs,
          '--profile',
          ondraRuntimeProfileName,
        ],
        environment: {...childEnvironment, 'DSH_HOME': _dshHome, 'PATH': path},
        workingDirectory: workingDirectory,
        includeParentEnvironment: false,
      );
      connection.process = process;
      _checkConnection(connection);
      connection.lines = process.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
            (line) {
              if (connection.failure != null) return;
              final frame = RpcFrame.decode(line);
              if (frame == null) return;
              if (frame.isResponse && frame.id != null) {
                connection.pending.remove(frame.id)?.complete(frame);
              } else if (frame.isNotification) {
                if (connection.ready.isCompleted) _ingestUsage(frame);
                connection.frames.add(frame);
              }
            },
            onError: (Object error, StackTrace stack) {
              _disconnect(connection, error, stack);
            },
          );
      connection.stderr = process.stderr
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(
            (line) {
              final text = line.trim();
              if (text.isNotEmpty && !_isWarningNoise(text)) {
                connection.stderrLast = _redact(text);
                _log('stderr: ${_redact(text)}');
              }
            },
            onError: (Object error, StackTrace stack) {
              _disconnect(connection, error, stack);
            },
          );
      unawaited(
        process.stdin.done.then<void>(
          (_) {},
          onError: (Object error, StackTrace stack) {
            _disconnect(connection, error, stack);
          },
        ),
      );
      unawaited(
        process.exitCode.then((code) {
          final detail = connection.stderrLast;
          _disconnect(
            connection,
            StateError(
              '内核进程已退出（exit $code）${detail == null ? '' : '：$detail'}',
            ),
          );
        }),
      );
      _log('process started, pid=${process.pid}; sending initialize');
      await _call(connection, 'initialize', {
        'cwd': workingDirectory ?? Directory.current.path,
        'provider': config?.route ?? provider,
        'model': config?.modelId ?? modelId,
        // 推理能力/默认档位由受管 profile 提供。SDK 的 adapterDefaults 投影
        // 会在 resume 时重新解析，不能给非推理模型硬传 reasoningEffort: off。
      });
      _checkConnection(connection);
      final sessionId = _sessionId;
      if (sessionId != null) {
        await _call(connection, 'session/resume', {'sessionId': sessionId});
        _checkConnection(connection);
      }
      _lastError = null;
      connection.ready.complete();
      _log('initialize ok');
    } catch (error, stack) {
      _disconnect(connection, error, stack);
    } finally {
      connection.opening = false;
      if (connection.failure != null) await _close(connection);
    }
  }

  void _ingestUsage(RpcFrame frame) {
    if (frame.method != 'session.event') return;
    final payload = frame.params;
    if (payload == null ||
        _sessionId == null ||
        payload['sessionId'] != _sessionId) {
      return;
    }
    if (sessionEventType(payload) == 'step/start') {
      _stepStart = sessionEventTime(payload);
      return;
    }
    final tokens = usageOfSessionEvent(payload);
    if (tokens == null) return;
    final at = sessionEventTime(payload);
    final elapsed = (_stepStart != null && at != null)
        ? at.difference(_stepStart!)
        : Duration.zero;
    _stepStart = null;
    _usage.add(StepUsage(tokens: tokens, elapsed: elapsed));
  }

  @override
  void resetSession() {
    if (_active != null) stop();
    _sessionId = null;
    _stepStart = null;
  }

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) {
    final turn = _Turn();
    turn.output.onListen = () {
      if (_active != null) {
        turn.finish(StateError('已有一轮对话正在生成'));
        return;
      }
      _active = turn;
      unawaited(_send(turn, text, attachments));
    };
    turn.output.onCancel = () {
      if (!turn.done && identical(_active, turn)) stop();
    };
    return turn.output.stream;
  }

  Future<void> _send(
    _Turn turn,
    String text,
    List<ChatAttachment> attachments,
  ) async {
    StreamSubscription<RpcFrame>? sub;
    Timer? timer;
    try {
      final blocks = <Map<String, dynamic>>[
        {'type': 'text', 'text': text},
      ];
      final invalid = <String>[];
      for (final attachment in attachments) {
        final mime = attachment.mimeType;
        if (mime == null) {
          invalid.add('${attachment.name}（不支持的附件类型）');
          continue;
        }
        try {
          final bytes = await File(attachment.path).readAsBytes();
          if (turn.done) return;
          if (bytes.isEmpty) {
            invalid.add('${attachment.name}（空文件）');
            continue;
          }
          blocks.add({
            'type': 'image',
            'data': base64Encode(bytes),
            'mimeType': mime,
            'name': attachment.name,
          });
        } on FileSystemException {
          invalid.add('${attachment.name}（无法读取）');
        }
      }
      if (turn.done) return;
      // 附件错误走错误通道，不能伪装成模型正文或偷偷发送残缺内容。
      if (invalid.isNotEmpty) throw StateError('附件发送失败：${invalid.join('、')}');
      await connect();
      if (turn.done) return;
      final connection = _connection!;
      _checkConnection(connection);
      final sessionId = _sessionId ??=
          'ondra-${DateTime.now().microsecondsSinceEpoch}-${_nextSession++}';
      _stepStart = null;
      sub = connection.frames.stream.listen((frame) {
        if (turn.done || frame.method != 'session.event') return;
        final payload = frame.params;
        if (payload == null || payload['sessionId'] != sessionId) return;
        turn.events.add(payload);
      });
      timer = Timer(turnTimeout, () {
        if (!turn.done) {
          _disconnect(
            connection,
            TimeoutException('内核轮次超时（未收到 turn/end）', turnTimeout),
          );
        }
      });
      await _call(connection, 'session/prompt', {
        'sessionId': sessionId,
        'contentBlocks': blocks,
      });
      if (turn.done) return;
      await for (final payload in turn.events.stream) {
        if (turn.done) return;
        final error = errorOfSessionEvent(payload);
        if (error != null) throw StateError(error);
        final chunk = textOfSessionEvent(payload);
        if (chunk != null) turn.output.add(chunk);
        if (isTurnEnd(payload)) break;
      }
      if (turn.done) return;
      _lastError = null;
      if (identical(_active, turn)) _active = null;
      turn.finish();
    } catch (error, stack) {
      if (!turn.done) {
        _lastError = '$error';
        if (identical(_active, turn)) _active = null;
        turn.finish(error, stack);
      }
    } finally {
      timer?.cancel();
      await sub?.cancel();
      if (identical(_active, turn)) _active = null;
    }
  }

  Future<_KernelLaunch> _resolveLaunch() async {
    if (binary != null && binary!.isNotEmpty) {
      return _KernelLaunch(exe: binary!, leadingArgs: const []);
    }
    final fromEnv = environment['ONDRA_DSH_BIN'];
    if (fromEnv != null && fromEnv.isNotEmpty) {
      return _KernelLaunch(exe: fromEnv, leadingArgs: const []);
    }
    final bundled = ondraBundledRuntime;
    if (bundled != null) {
      return _KernelLaunch(
        exe: bundled.nodePath,
        leadingArgs: [bundled.dshEntry],
        bundledRoot: bundled.rootDir,
      );
    }
    return _KernelLaunch(exe: _systemDsh(), leadingArgs: const []);
  }

  String _systemDsh() {
    final home = _home;
    final candidates = <String>[
      '/opt/homebrew/bin/dsh',
      '/usr/local/bin/dsh',
      '/usr/bin/dsh',
      '$home/.npm-global/bin/dsh',
      '$home/.local/bin/dsh',
      '$home/.volta/bin/dsh',
      '$home/.bun/bin/dsh',
      '$home/.local/share/pnpm/dsh',
    ];
    void expandVersions(String pattern) {
      try {
        for (final dir in Directory(pattern).listSync()) {
          final candidate = '${dir.path}/bin/dsh';
          if (File(candidate).existsSync()) candidates.add(candidate);
        }
      } on FileSystemException {
        // 未安装对应版本管理器时跳过。
      }
    }

    expandVersions('$home/.nvm/versions/node');
    expandVersions('$home/.workbuddy/binaries/node/versions');
    expandVersions('$home/.asdf/installs/nodejs');
    for (final candidate in candidates) {
      if (File(candidate).existsSync()) return candidate;
    }
    return 'dsh';
  }

  @override
  void stop() {
    final error = StateError('生成已停止');
    _active?.finish(error);
    _active = null;
    final connection = _connection;
    if (connection != null) _disconnect(connection, error);
  }

  void _disconnect(_Connection connection, Object error, [StackTrace? stack]) {
    if (connection.failure != null) return;
    if (_redact('$error') != '$error') error = StateError(_redact('$error'));
    connection.failure = error;
    if (identical(_connection, connection)) {
      _connection = null;
      _retired = connection.closed.future;
      _lastError = '$error';
      _stepStart = null;
      _active?.finish(error, stack);
      _active = null;
      _log('disconnected: $error');
    }
    for (final pending in connection.pending.values) {
      pending.completeError(error, stack);
    }
    connection.pending.clear();
    if (!connection.ready.isCompleted) {
      connection.ready.completeError(error, stack);
    }
    if (!connection.opening) unawaited(_close(connection));
  }

  Future<void> _close(_Connection connection) async {
    if (connection.closing) return connection.closed.future;
    connection.closing = true;
    try {
      final process = connection.process;
      if (process != null) {
        process.kill();
        try {
          await process.exitCode.timeout(const Duration(seconds: 2));
        } on TimeoutException {
          process.kill(ProcessSignal.sigkill);
          await process.exitCode;
        }
        try {
          await process.stdin.close();
        } on Object {
          // 退出后的断管错误已由连接失败通道处理。
        }
      }
      await connection.lines?.cancel();
      await connection.stderr?.cancel();
      await connection.frames.close();
    } finally {
      connection.closed.complete();
    }
  }

  Future<RpcFrame> _call(
    _Connection connection,
    String method,
    Map<String, dynamic> params,
  ) async {
    _checkConnection(connection);
    final process = connection.process;
    if (process == null) throw StateError('内核未连接');
    final id = _nextId++;
    final completer = Completer<RpcFrame>();
    connection.pending[id] = completer;
    try {
      // 先订阅 future，再写管道，避免同步写入失败遗留未处理的 completer。
      final response = completer.future.timeout(
        requestTimeout,
        onTimeout: () {
          throw TimeoutException('内核请求超时（$method）', requestTimeout);
        },
      );
      try {
        process.stdin.writeln(RpcFrame.encodeRequest(id, method, params));
      } catch (error, stack) {
        _disconnect(connection, error, stack);
      }
      final frame = await response;
      if (frame.error != null) {
        final message = frame.error!['message'] ?? '$method 失败';
        final code = frame.error!['code'];
        throw StateError('$message${code == null ? '' : '（$code）'}');
      }
      return frame;
    } on TimeoutException catch (error, stack) {
      _disconnect(connection, error, stack);
      rethrow;
    } finally {
      connection.pending.remove(id);
    }
  }
}
