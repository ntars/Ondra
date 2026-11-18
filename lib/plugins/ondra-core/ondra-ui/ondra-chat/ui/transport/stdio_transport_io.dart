import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../chat_client.dart';
import 'rpc_frames.dart';

/// 通过**本机子进程**连 DSH 内核：`dsh --profile ondra`。
///
/// 上游 SDK profile 就是这条路径：按换行分帧的 JSON-RPC 2.0，stdin 发请求、
/// stdout 收响应与通知。这里只做三件事：起进程、把 `session/prompt` 发出去、
/// 把 `session.event` 里的文本增量转成 [send] 的流。
///
/// 为什么不用 HTTP：SDK profile 只讲 stdio；Web 端的 Typert RPC 需要生成
/// InvocationDescriptor，那是另一条路，不是这条。
class StdioDshTransport implements DshTransport {
  StdioDshTransport({
    this.binary,
    this.modelId = 'group/ntars',
    this.provider = 'magpie',
  });

  /// 可执行文件；默认取环境变量 `ONDRA_DSH_BIN`，再退回 `dsh`。
  final String? binary;

  /// 走哪条模型路由。默认 `magpie`：本机网关 `/Applications/magpie.app`
  /// （127.0.0.1:3425），路由声明在 profile 的 `cordis.patch.yml` 里，
  /// 是 pi-ai 的手工路由。换模型只改这两行，不动装配层。
  final String modelId;
  final String provider;

  Process? _process;
  final _frames = StreamController<RpcFrame>.broadcast();
  /// 用量单独一条广播流：右栏的用量条与对话文本是两件事，混在一条流里
  /// 会让 `send()` 的返回值多一种类型，而那两种东西的生命周期并不同。
  final _usage = StreamController<StepUsage>.broadcast();
  StreamSubscription<RpcFrame>? _usageSub;
  /// 当前这一步的开始时刻：TPS 的分母是「step/start → assistant/message」。
  DateTime? _stepStart;

  @override
  Stream<StepUsage> get usage => _usage.stream;
  StreamSubscription<String>? _lines;
  StreamSubscription<String>? _stderr;
  int _nextId = 1;
  final Map<int, Completer<RpcFrame>> _pending = {};
  String? _sessionId;
  String? _lastError;

  /// stderr 里最后一行非告警输出：只在真出事时当解释用，平时不改 `lastError`。
  String? _stderrLast;

  /// 最近一次失败原因，界面直接显示，不猜。
  String? get lastError => _lastError;

  /// Node 的告警不是失败原因。
  ///
  /// 插件树里有人用 `node:sqlite`，每次启动都会打一条
  /// `ExperimentalWarning`，后面跟一行 `(Use `node --trace-warnings ...)`。
  /// 真正崩掉时我们想要的是最后一条有信息量的输出，而不是这两行模板话术，
  /// 所以按行把它们滤掉，免得异常退出的解释变成「SQLite 是实验特性」。
  static bool _isWarningNoise(String line) {
    if (line.startsWith('(node:') && line.contains('Warning:')) return true;
    if (line.startsWith('(Use `node --trace-')) return true;
    if (line.startsWith('ExperimentalWarning:')) return true;
    if (line.startsWith('DeprecationWarning:')) return true;
    return false;
  }

  /// GUI 应用没有终端可看，连接过程的每一步都落盘一份，排障时直接读文件。
  void _log(String message) {
    try {
      final home = Platform.environment['HOME'] ?? '.';
      final dir = Directory('$home/.ondra/logs');
      if (!dir.existsSync()) dir.createSync(recursive: true);
      final stamp = DateTime.now().toIso8601String();
      File('$home/.ondra/logs/transport.log')
          .writeAsStringSync('$stamp  $message\n', mode: FileMode.append, flush: true);
    } catch (_) {
      // 日志失败不能影响连接本身
    }
  }

  @override
  Future<void> connect() async {
    if (_process != null) return;
    final exe = await _resolveBinary();
    _log('resolved binary: $exe');
    // 独立的 DSH_HOME：桌面端的会话库是 .jsonl.zstd，SDK profile 默认写未压缩 JSONL，
    // 共用一个目录会直接报 “uses .jsonl.zstd, but this backend is configured for …”。
    // 顺带的好处是空谷的数据不混进用户自己的 dsh 目录。
    final home = Platform.environment['ONDRA_DSH_HOME'] ??
        '${Platform.environment['HOME'] ?? '.'}/.ondra/dsh';
    final Process process;
    try {
      // dsh 是个带 `#!/usr/bin/env node` 的脚本：GUI 应用的 PATH 里没有 node，
      // 子进程会立刻退出（表现为 initialize 一直等到超时）。把 dsh 所在目录
      // 顶到 PATH 前面，node 与 dsh 通常就在同一个 bin 下。
      final binDir = exe.contains('/')
          ? File(exe).parent.path
          : '';
      final path = [
        if (binDir.isNotEmpty) binDir,
        Platform.environment['PATH'] ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      ].join(':');
      process = await Process.start(
        exe,
        // `ondra` 是应用自己的 profile：sdk-minimal 的完整树 + 旧插件包的
        // 75 个根插件（记忆、人设、情感、主动、TTS、世界书……）。
        // 它是 `~/.ondra/dsh/profiles/ondra` 里的一份 YAML 装配层，
        // 不是打进包里的代码——插件包更新时不用重新构建应用。
        ['--profile', 'ondra'],
        environment: {
          ...Platform.environment,
          'DSH_HOME': home,
          'PATH': path,
          // magpie 不校验密钥（只监听 127.0.0.1），但 pi-ai 的手工路由必须
          // 解析出一个非空凭据才肯发请求——空值会直接失败在
          // 「No API key for provider: magpie」。这里给占位值，
          // 语义是「本机环回，不需要钥匙」，不是一串真凭据。
          'MAGPIE_API_KEY':
              Platform.environment['MAGPIE_API_KEY'] ?? 'local-loopback',
        },
      );
      // 进程异常退出时说清楚，而不是让 initialize 空等到超时。
      process.exitCode.then((code) {
        _log('process exited with code $code');
      });
    } on ProcessException catch (e) {
      _lastError = '找不到 dsh 可执行文件（$exe）：${e.message}';
      _log('spawn failed: ${e.message}');
      throw StateError(_lastError!);
    }
    _process = process;

    // 一行一帧；坏行由 RpcFrame.decode 返回 null 后丢弃。
    _lines = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          final frame = RpcFrame.decode(line);
          if (frame == null) return;
          if (frame.isResponse && frame.id != null) {
            _pending.remove(frame.id!)?.complete(frame);
          } else if (frame.isNotification) {
            _frames.add(frame);
          }
        });

    // stderr 是**证据**，不是结论。
    //
    // 内核把大量诊断信息写这里：插件装载期配置、Node 的实验特性告警、
    // pnpm 的提示……这些都不代表失败。所以这里只留最后一行可疑输出，
    // 等真的出事（initialize 报错 / 进程异常退出）时才拿它当解释。
    // 逐行处理而不是逐块：Node 习惯一次 write 吐多行，整块判噪声会误伤真错误。
    _stderr = process.stderr
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          final text = line.trim();
          if (text.isEmpty || _isWarningNoise(text)) return;
          _stderrLast = text;
        });

    // 进程若在握手途中断掉，挂起的请求不能干等 30 秒超时——
    // 直接把 stderr 的最后一行当原因交出去。
    unawaited(process.exitCode.then((code) {
      if (_pending.isEmpty) return;
      final reason = _stderrLast ?? '内核进程已退出（exit $code）';
      _lastError = reason;
      for (final pending in _pending.values) {
        if (!pending.isCompleted) {
          pending.complete(RpcFrame(id: 0, error: {'message': reason}));
        }
      }
      _pending.clear();
    }));

    _log('process started, pid=${process.pid}; sending initialize');
    final init = await _call('initialize', {
      'cwd': Directory.current.path,
      'provider': provider,
      'model': modelId,
    });
    if (init.error != null) {
      _lastError = '${init.error!['message'] ?? '初始化失败'}';
      _log('initialize failed: $_lastError');
      throw StateError(_lastError!);
    }
    _log('initialize ok');

    // 记账监听：内核把 usage 挂在 `assistant/message` 上，一步一条。
    // 这里不参与文本解析，只做两件事——记下这一步什么时候开始、算出花了多久。
    _usageSub = _frames.stream.listen((frame) {
      if (frame.method != 'session.event') return;
      final payload = frame.params;
      if (payload == null) return;
      final type = sessionEventType(payload);
      if (type == 'step/start') {
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
      _log('usage in=${tokens.inputTokens} out=${tokens.outputTokens} '
          'cacheRead=${tokens.cacheReadTokens} ${elapsed.inMilliseconds}ms');
    });
  }

  @override
  Stream<String> send(String text) async* {
    if (_process == null) throw StateError('内核未连接：先调用 connect()');

    final sessionId = _sessionId ?? 'ondra-${DateTime.now().millisecondsSinceEpoch}';
    _sessionId = sessionId;

    // 先挂监听再发请求：增量可能比 prompt 的回执更早到。
    final events = StreamController<Map<String, dynamic>>();
    final sub = _frames.stream.listen((frame) {
      if (frame.method != 'session.event') return;
      final payload = frame.params;
      if (payload == null) return;
      final id = payload['sessionId'];
      if (id != null && id != sessionId) return;
      events.add(payload);
    });

    try {
      final receipt = await _call('session/prompt', {
        'sessionId': sessionId,
        'contentBlocks': [
          {'type': 'text', 'text': text},
        ],
      });
      if (receipt.error != null) {
        throw StateError('${receipt.error!['message'] ?? '发送失败'}');
      }

      // 一轮的边界是 turn/end；运行时没发（崩溃、上游改协议）时 30 秒收尾，
      // 避免界面永远停在「正在生成」。
      await for (final payload in events.stream.timeout(
        const Duration(seconds: 30),
        onTimeout: (sink) => sink.close(),
      )) {
        final chunk = textOfSessionEvent(payload);
        if (chunk != null) yield chunk;
        if (isTurnEnd(payload)) break;
      }
    } finally {
      await sub.cancel();
      await events.close();
    }
  }

  /// 找到 dsh 可执行文件。
  ///
  /// 从 Finder 启动的应用拿到的是最小 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
  /// 那里没有 Homebrew 或 npm 全局装的 dsh——所以除了 `which`，还要探几个常见位置。
  /// 优先级：显式传入 → 环境变量 → PATH → 常见安装目录。
  Future<String> _resolveBinary() async {
    if (binary != null && binary!.isNotEmpty) return binary!;
    final fromEnv = Platform.environment['ONDRA_DSH_BIN'];
    if (fromEnv != null && fromEnv.isNotEmpty) return fromEnv;

    // 从 Finder 启动时 PATH 是极简版，且 `zsh -lc` 只走登录脚本（不读 .zshrc），
    // 用户用 nvm/npm/pnpm 装的 dsh 都不在其中。所以逐条探常见安装位置——
    // 版本目录（nvm / workbuddy 自带 node）用 glob 展开，不写死版本号。
    final home = Platform.environment['HOME'] ?? '';
    // 顺序很关键：绝对路径优先，`dsh`（走 PATH）放最后——
    // 之前把它放第一个，函数见到「不含 / 的名字」就立刻返回，后面的探测全白做。
    final candidates = <String>[
      '/opt/homebrew/bin/dsh',
      '/usr/local/bin/dsh',
      '/usr/bin/dsh',
      if (home.isNotEmpty) '$home/.npm-global/bin/dsh',
      if (home.isNotEmpty) '$home/.local/bin/dsh',
      if (home.isNotEmpty) '$home/.volta/bin/dsh',
      if (home.isNotEmpty) '$home/.bun/bin/dsh',
      if (home.isNotEmpty) '$home/.local/share/pnpm/dsh',
    ];

    /// nvm / asdf / 自带 node 的版本目录：展开一层 `versions/<v>/bin/dsh`。
    void expandVersions(String pattern) {
      try {
        for (final dir in Directory(pattern).listSync()) {
          final candidate = '${dir.path}/bin/dsh';
          if (File(candidate).existsSync()) candidates.add(candidate);
        }
      } catch (_) {
        // 目录不存在就跳过
      }
    }

    if (home.isNotEmpty) {
      expandVersions('$home/.nvm/versions/node');
      expandVersions('$home/.workbuddy/binaries/node/versions');
      expandVersions('$home/.asdf/installs/nodejs');
    }

    for (final c in candidates) {
      if (File(c).existsSync()) return c;
    }
    return 'dsh'; // 最后交给 PATH；找不到会有明确的 spawn 报错
  }

  @override
  void stop() {
    _usageSub?.cancel();
    _usageSub = null;
    _lines?.cancel();
    _stderr?.cancel();
    _stderr = null;
    _process?.kill();
    _process = null;
    _sessionId = null;
  }

  Future<RpcFrame> _call(String method, Map<String, dynamic> params) {
    final p = _process;
    if (p == null) return Future.error(StateError('内核未连接'));
    final id = _nextId++;
    final completer = Completer<RpcFrame>();
    _pending[id] = completer;
    p.stdin.writeln(RpcFrame.encodeRequest(id, method, params));
    return completer.future.timeout(
      const Duration(seconds: 30),
      onTimeout: () {
        _pending.remove(id);
        return const RpcFrame(id: 0, error: {'message': '请求超时'});
      },
    );
  }
}
