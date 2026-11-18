import 'dart:async';

import 'package:material_ui/material_ui.dart' show ChangeNotifier;

/// 对话客户端：右栏与 DSH 内核之间的唯一通道。
///
/// 界面只认三种东西：一条消息、一个「正在生成」状态、一条如实的原因。
/// **不猜内核的行为**：内核没起来就说没起来，不假装回一句话。
///
/// 传输层是接口（[DshTransport]），因为内核有两种接法：
/// - 本机 sidecar（`dsh --profile sdk-minimal`，stdio JSON-RPC）；
/// - 已运行实例的 Typert RPC（`/api`，官方桌面端走这条）。
/// 两种都由后续的 `ondra-dsh` 插件提供实现，右栏不需要知道是哪种。
class ChatClient extends ChangeNotifier {
  ChatClient({DshTransport? transport})
    : _transport = transport ?? const UnavailableTransport();

  DshTransport _transport;

  final List<ChatMessage> _messages = [];
  bool _busy = false;
  String? _offlineReason;
  ChatUsage _usage = const ChatUsage();
  StreamSubscription<StepUsage>? _usageSub;

  /// 会话累计用量。内核没报过一项就是「未知」，界面据此显示 `—`。
  ChatUsage get usage => _usage;

  List<ChatMessage> get messages => List.unmodifiable(_messages);
  bool get busy => _busy;

  /// 内核不可用的原因。非空时右栏显示一条系统提示，而不是空转。
  String? get offlineReason => _offlineReason;

  bool get hasConversation => _messages.isNotEmpty;

  /// 换传输层（装配时调用）。接上内核后调用方只需传一个实现进来。
  void useTransport(DshTransport transport) {
    _usageSub?.cancel();
    _transport = transport;
    // 用量与文本走两条流：文本是「这一轮说了什么」，用量是「内核记了多少账」。
    // 合成一条会让 ChatClient 的 send 循环多一种元素类型，而这两件事的
    // 生命周期并不一致——用量在 turn/end 之后还可能补一条。
    _usageSub = transport.usage.listen(_ingestUsage);
    notifyListeners();
  }

  /// 吃一步的记账：总量的加法、命中率的除法都在这里，界面不做算术。
  void _ingestUsage(StepUsage step) {
    final tokens = step.tokens;
    final prompt = tokens.promptTokens;
    final seconds = step.elapsed.inMicroseconds / Duration.microsecondsPerSecond;
    _usage = ChatUsage(
      tps: seconds > 0 && tokens.outputTokens > 0
          ? tokens.outputTokens / seconds
          : _usage.tps,
      totalTokens: _usage.totalTokens + tokens.billedTokens,
      // 只要这一轮有输入就重算命中率；没有输入（极少）就沿用上一次。
      cacheHit: prompt > 0 ? tokens.cacheReadTokens / prompt : _usage.cacheHit,
      contextTokens: prompt > 0 ? prompt : _usage.contextTokens,
    );
    notifyListeners();
  }

  /// 新会话时把累计清零：用量是「这次对话」的成本，不是终身账本。
  void resetUsage() {
    _usage = const ChatUsage();
    notifyListeners();
  }

  Future<void> connect() async {
    try {
      await _transport.connect();
      _offlineReason = null;
    } catch (e) {
      _offlineReason = '$e';
    }
    notifyListeners();
  }

  /// 发送一条消息。失败时追加一条系统消息说明原因，不吞掉。
  Future<void> send(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || _busy) return;

    _messages.add(ChatMessage(role: ChatRole.user, text: trimmed));
    final reply = ChatMessage(role: ChatRole.assistant, text: '', streaming: true);
    _messages.add(reply);
    _busy = true;
    notifyListeners();

    try {
      await for (final chunk in _transport.send(trimmed)) {
        reply.text += chunk;
        notifyListeners();
      }
      reply.streaming = false;
      if (reply.text.isEmpty) {
        _messages.remove(reply);
        _messages.add(
          ChatMessage(
            role: ChatRole.system,
            text: _offlineReason ?? '内核没有返回内容',
          ),
        );
      }
    } catch (e) {
      _messages.remove(reply);
      _messages.add(ChatMessage(role: ChatRole.system, text: '$e'));
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  void stop() {
    _transport.stop();
    _busy = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _usageSub?.cancel();
    super.dispose();
  }

  void clear() {
    _messages.clear();
    notifyListeners();
  }
}

enum ChatRole { user, assistant, system }

/// 一条消息。[streaming] 为真时界面显示一个正在生成的占位。
class ChatMessage {
  ChatMessage({
    required this.role,
    required this.text,
    this.streaming = false,
  });

  final ChatRole role;
  String text;
  bool streaming;
}

/// 内核传输层。
///
/// `send` 返回增量文本流——内核是流式的，接口也必须是流式的，
/// 否则「接入」之后还得再改一次界面。
abstract class DshTransport {
  Future<void> connect();
  Stream<String> send(String text);
  void stop();

  /// 每一步模型调用的记账。内核不报（离线、适配器不支持）时就是空流，
  /// 界面因此显示「—」而不是 0——把「没测到」画成 0 是在编数据。
  Stream<StepUsage> get usage => const Stream.empty();
}

/// 一次模型调用的 token 记账，字段与上游 `TokenUsage` 同名同义。
///
/// 三个输入桶**互斥**：`inputTokens` 只含未命中的部分，命中的在
/// `cacheReadTokens`、写入在 `cacheWriteTokens`（上游文档明确要求适配器把
/// provider 的 `prompt_tokens` 里的命中量减出去）。所以命中率是
/// `cacheRead / (input + cacheRead + cacheWrite)`，不能拿 input 当分母。
class TokenUsage {
  const TokenUsage({
    required this.inputTokens,
    required this.outputTokens,
    this.cacheReadTokens = 0,
    this.cacheWriteTokens = 0,
    this.reasoningTokens = 0,
    this.totalTokens,
  });

  final int inputTokens;
  final int outputTokens;
  final int cacheReadTokens;
  final int cacheWriteTokens;
  final int reasoningTokens;

  /// 上游给的总量；缺省时由三个输入桶加输出自己算出来。
  final int? totalTokens;

  int get promptTokens => inputTokens + cacheReadTokens + cacheWriteTokens;

  int get billedTokens => totalTokens ?? (promptTokens + outputTokens);
}

/// 一步的记账 + 这一步花了多久（TPS 的分母）。
class StepUsage {
  const StepUsage({required this.tokens, required this.elapsed});

  final TokenUsage tokens;
  final Duration elapsed;
}

/// 会话累计用量。界面只读这一个不可变对象。
class ChatUsage {
  const ChatUsage({
    this.tps = 0,
    this.totalTokens = 0,
    this.cacheHit = -1,
    this.contextTokens = 0,
  });

  /// 输出速度（token/s）。0 表示还没有一轮完整数据。
  final double tps;

  /// 本次会话累计计费 token。
  final int totalTokens;

  /// 缓存命中率 0..1；-1 表示内核没报缓存字段。
  final double cacheHit;

  /// 最近一次请求的输入规模（含缓存读写），用来算上下文占比。
  final int contextTokens;

  bool get hasSpeed => tps > 0;

  bool get hasCache => cacheHit >= 0;
}

/// 未接内核时的占位实现：如实说明原因，不假装能对话。
class UnavailableTransport implements DshTransport {
  const UnavailableTransport();

  static const reason = '对话内核未连接：本机 dsh 运行时未启动';

  @override
  Future<void> connect() async {
    throw StateError(reason);
  }

  @override
  Stream<String> send(String text) async* {
    throw StateError(reason);
  }

  @override
  void stop() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}

/// 全局客户端。装配时由 `ondra-dsh` 插件换掉传输层。
final ChatClient chatClient = ChatClient();
