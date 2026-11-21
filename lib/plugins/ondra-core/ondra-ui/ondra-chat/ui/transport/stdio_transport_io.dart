import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../../../../../app/bundled_runtime.dart';
import '../../../../../../app/runtime_seed.dart';
import '../../../../../../app/login_shell_environment.dart';
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
  /// 本次连接的模型配置错误（缺密钥/配置无效）。非空时聊天栏提示
  /// 「内核在跑，但当前模型不可用」，而不是让用户以为应用坏了。
  String? _modelConfigError;

  @override
  String? get modelConfigError => _modelConfigError;

  StdioDshTransport({
    this.binary,
    this.modelId = 'group/ntars',
    this.provider = 'magpie',
    Map<String, String>? environment,

    /// 是否继承登录 shell 环境（fixture 传 false：隔离环境不该被真实
    /// rc 文件污染，10s 探测也会拖死测试）。
    this.inheritLoginShellEnvironment = true,
    List<String> binaryArgs = const [],
    this.requestTimeout = const Duration(seconds: 30),
    this.turnTimeout = const Duration(minutes: 10),
    this.modelConfig,
    this.secretResolver,
    this.workingDirectory,
    this.previousClosed,
    String? resumeSessionId,
  })  : environment = Map.unmodifiable(environment ?? Platform.environment),
       binaryArgs = List.unmodifiable(binaryArgs),
       _sessionId = resumeSessionId;

  final String? binary;
  final String modelId;
  final String provider;

  /// 提供时替代父进程环境，供子进程、profile 种子和日志共用。
  final Map<String, String> environment;

  /// 是否继承登录 shell 环境。
  final bool inheritLoginShellEnvironment;
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
      final seed = seedRuntimeProfile(dshHome: _dshHome);
      if (seed.outcome != RuntimeSeedOutcome.alreadyPresent) {
        _log('profile seed: $seed');
      }
      // 登录 shell 环境继承（照抄官方 login-shell-environment 协议）：
      // Dock/Finder 启动只继承会话管理器环境，用户在 rc 文件里的
      // PATH/代理/模型变量内核子进程看不到。探测失败（超时/无 shell）
      // 不拦启动，退回继承环境。
      var childEnvironment = environment;
      if (!Platform.isWindows && inheritLoginShellEnvironment) {
        try {
          final shellEnv = await LoginShellEnvironment.read().timeout(
            const Duration(seconds: 12),
          );
          if (shellEnv != null && shellEnv.isNotEmpty) {
            childEnvironment = LoginShellEnvironment.merge(
              environment,
              shellEnv,
            );
            _log('login shell environment: +${shellEnv.length} vars');
          }
        } catch (_) {
          // 探测挂了不该拦内核。
        }
      }
      final config = modelConfig?.call();
      // 模型配置失败绝不拦内核启动（2026-11-21 用户反馈：不用 DeepSeek、
      // 换其他模型或网关时内核整个起不来）。内核没有模型也能跑——工具、
      // 记忆、对话协议都在；只有聊天需要模型。配置解析/密钥解析/补丁写
      // 入失败时跳过模型段，内核照常起，聊天栏显示具体原因。
      if (config != null) {
        try {
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
        } catch (e) {
          _log('模型配置未生效，内核仍启动：$e');
          _modelConfigError = '$e';
          childEnvironment = environment;
        }
      }
      final launch = await _resolveLaunch();
      _checkConnection(connection);
      _log('launch: $launch');
      final path = [
        File(launch.exe).parent.path,
        childEnvironment['PATH'] ??
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
        environment: {
          ...childEnvironment,
          'DSH_HOME': _dshHome,
          'PATH': path,
          // 安卓：node 的动态依赖（openssl/icu/…）全在 nativeLibraryDir，
          // bionic linker 只看 LD_LIBRARY_PATH 与自己的默认路径。
          if (Platform.isAndroid)
            'LD_LIBRARY_PATH':
                ondraBundledRuntime?.libDir ?? '',
        },
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
      final settled = _turnSettled;
      if (settled != null) {
        // 上一次 stop 的取消流程（命令往返 + idle 等待/兜底重启）还没走完：
        // 期间不占 _active——兜底断连的 finish 不能误伤这条还没开始的轮次；
        // settle 后要么 idle（消息立即执行），要么走重启后的新连接。
        unawaited(settled.whenComplete(() {
          if (_active != null || turn.done) {
            turn.finish(StateError('已有一轮对话正在生成'));
            return;
          }
          _active = turn;
          unawaited(_send(turn, text, attachments));
        }));
        return;
      }
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
      // prompt 应答前的 turn/end 属于上一轮的取消收尾（stop() 经
      // /cancel-turn 中断的那一轮），不是本轮的——同一会话的事件流不区分
      // 轮次，不过滤的话取消收尾会被紧随其后的新轮消费掉，表现为「新消息
      // 立刻空结束」。frames 广播流只放行 notification（response 走
      // pending 分发），所以「prompt 已受理」不能在 sub 里判断，改由
      // _call 返回后置位：事件先缓冲在 turn.events，await for 开始时按序
      // 读取，顺序不失真。
      var promptSettled = false;
      sub = connection.frames.stream.listen((frame) {
        if (turn.done || frame.method != 'session.event') return;
        final payload = frame.params;
        if (payload == null || payload['sessionId'] != sessionId) return;
        if (!promptSettled && isTurnEnd(payload)) return;
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
      // prompt 被 kernel 受理（RPC 应答已回），此后的事件都是本轮的。
      promptSettled = true;
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
  void dispose() {
    final connection = _connection;
    if (connection != null) _disconnect(connection, StateError('传输层已释放'));
  }

  @override
  void stop() {
    final turn = _active;
    final connection = _connection;
    // 没有活动轮次时（如握手未完成被叫停），stop 就是「把当前连接断开」，
    // 与旧语义一致——没有可取消的轮次，命令无从执行。
    if (turn == null) {
      if (connection != null && connection.failure == null) {
        _disconnect(connection, StateError('生成已停止'));
      }
      return;
    }
    _active = null;
    turn.finish(StateError('生成已停止'));
    // 健康连接走内核命令 /cancel-turn（ondra-turn-control 插件提供，处理
    // 器走官方 sessionController 的 cancel 语义：cause={kind:'user'} +
    // keepInbox）：agent.abort 中断本轮，内核以 aborted turn/end 收尾，
    // 连接与进程保持，下一句在同一会话里继续（alpha.2 审查第 9 项——旧
    // 实现直接杀进程）。命令失败时兜底退回杀进程，保证 stop 永远真的停。
    if (connection == null || connection.failure != null) return;
    final sessionId = _sessionId;
    if (sessionId == null) {
      // 还没有会话（握手阶段被打断）：没有可取消的轮次，直接断开。
      _disconnect(connection, StateError('生成已停止'));
      return;
    }
    // settle 期间（取消命令往返 + idle 等待）新的 send 必须等它结束：
    // 提前发出的 prompt 会作为 followup 排队，若兜底杀进程则被误杀。
    _turnSettled = _cancelTurn(connection, sessionId);
    unawaited(_turnSettled!);
  }

  /// 最近一次 stop 的取消流程完成信号；send 前等待它，避免把新消息排进
  /// 一个即将被杀死的内核的 inbox 里。
  Future<void>? _turnSettled;

  /// 发 `session/query` 执行内核命令 `/cancel-turn`（白名单内——stdio
  /// 协议没有 session/cancel 方法，命令系统是唯一的 agent 级中断通道）。
  ///
  /// 两段超时兜底，保证 stop 永远真的停：
  /// 1. 命令应答 10 秒——超时/失败（插件缺席/不支持/管道断）退回杀进程；
  /// 2. session/wait 等 idle 10 秒——正常生成中 cancel 立刻 idle、连接
  ///    保持；agent 卡死在无法中断的调用里永不 idle 时杀进程保下一轮。
  Future<void> _cancelTurn(_Connection connection, String sessionId) async {
    try {
      await _call(connection, 'session/query', {
        'sessionId': sessionId,
        'contentBlocks': [
          {'type': 'text', 'text': '/cancel-turn'},
        ],
      }).timeout(const Duration(seconds: 10));
    } catch (_) {
      if (_active == null || _connection != connection) {
        _disconnect(connection, StateError('生成已停止'));
      }
      return;
    }
    // 等内核回到 idle：agent.cancel 的 abort 在下一个事件边界生效（turn
    // 驱动循环的每个 chunk 都过 signal.throwIfAborted()），正常生成中
    // 立刻 idle；内核不把取消收敛进 turn/end 事件，所以这里用白名单内的
    // session/wait（等 idle + 子代理收敛）做权威判定。超时（agent 卡死
    // 在无法中断的调用里，永不 idle）退回杀进程——排队的新 prompt 也
    // 永远执行不到，重启内核是唯一生路。
    try {
      await _call(connection, 'session/wait', {
        'sessionId': sessionId,
      }).timeout(const Duration(seconds: 10));
    } catch (_) {
      // turn 没收尾：退回杀进程，排队的新 prompt 也永远执行不到。
      _disconnect(connection, StateError('生成已停止（内核未响应取消）'));
    }
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
