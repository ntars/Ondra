import 'dart:async';

import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import '../../../../../app/data_maintenance.dart';
import '../../ondra-settings/ui/settings_client.dart';
import '../../ondra-settings/ui/notify.dart';

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
    : _transport = transport ?? const UnavailableTransport() {
    _usageSub = _transport.usage.listen(_ingestUsage);
  }

  DshTransport _transport;

  final List<ChatMessage> _messages = [];
  bool _busy = false;

  /// 轮次编号：每发一轮 +1。用来认出「我这一轮是不是已经被插话作废了」。
  /// 见 [_sendNow] 的说明。
  int _generation = 0;
  int _connectionGeneration = 0;

  String? _offlineReason;
  bool _connected = false;
  bool get connected => _connected;
  bool get maintenance => dataMaintenance.locked;

  ChatUsage _usage = const ChatUsage();
  StreamSubscription<StepUsage>? _usageSub;

  /// 下一条消息要带上的附件（本机路径）。
  ///
  /// **不读文件内容**：这一层只记住「用户选了哪几个文件」，真正的读取、
  /// 分片、编码是内核那边的事。在 UI 层把几十兆的图片读成字节，
  /// 只会让点击的瞬间卡一下，而且那份字节没有任何人去用。
  final List<ChatAttachment> _attachments = [];

  List<ChatAttachment> get attachments => List.unmodifiable(_attachments);

  /// 正在生成时用户又发来的话。`queue` 策略下攒在这里，这一轮结束后依次发出。
  final List<({String text, List<ChatAttachment> attachments})> _queued = [];

  List<String> get queued =>
      List.unmodifiable(_queued.map((item) => item.text));

  /// 繁忙时的发送策略：`queue`（排队）或 `steer`（插话）。
  ///
  /// 每次读取都问一遍设置，不缓存：用户在设置里改完回到聊天，
  /// 下一句就该按新策略走，而不是等重启。
  String get busyPolicy => settingsClient.choice('dialog.busySend');

  /// 清掉排队中的话。新建会话 / 停止生成时调用——
  /// 那些句子属于「上一轮没说完的」，跟着新会话一起发出去会让它莫名接话。
  void clearQueue() {
    if (_queued.isEmpty) return;
    _queued.clear();
    notifyListeners();
  }

  /// 挂上一个附件。同一个路径不重复挂。
  void attach(ChatAttachment a) {
    if (_attachments.any((e) => e.path == a.path)) return;
    _attachments.add(a);
    notifyListeners();
  }

  void detach(String path) {
    final before = _attachments.length;
    _attachments.removeWhere((e) => e.path == path);
    if (_attachments.length != before) notifyListeners();
  }

  void clearAttachments() {
    if (_attachments.isEmpty) return;
    _attachments.clear();
    notifyListeners();
  }

  /// 会话累计用量。内核没报过一项就是「未知」，界面据此显示 `—`。
  ChatUsage get usage => _usage;

  List<ChatMessage> get messages => List.unmodifiable(_messages);
  bool get busy => _busy;

  /// 内核不可用的原因。非空时右栏显示一条系统提示，而不是空转。
  String? get offlineReason => _offlineReason;

  bool get hasConversation => _messages.isNotEmpty;

  /// 换传输层（装配时调用）。接上内核后调用方只需传一个实现进来。
  void useTransport(DshTransport transport) {
    if (identical(_transport, transport)) return;
    stop();
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
    final seconds =
        step.elapsed.inMicroseconds / Duration.microsecondsPerSecond;
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

  Future<void> connect({bool duringMaintenance = false}) async {
    if (dataMaintenance.locked && !duringMaintenance) return;
    final generation = ++_connectionGeneration;
    try {
      await _transport.connect();
      if (generation != _connectionGeneration) return;
      _connected = true;
      // 连接成功后允许设置层做启动同步（首次启动 profile 刚 seed 完的场景）。
      settingsClient.markConnected();
      _offlineReason = null;
    } catch (e) {
      if (generation != _connectionGeneration) return;
      _connected = false;
      _offlineReason = '$e';
    }
    notifyListeners();
  }

  /// 发送一条消息。失败时追加一条系统消息说明原因，不吞掉。
  ///
  /// 正在生成时怎么办，由设置里的「繁忙时的发送行为」决定：
  /// - `queue`（排队发送）：记下来，这一轮结束后自动接着发；
  /// - `steer`（插话发送）：先停掉当前这轮，再把这句话发出去。
  ///
  /// 上一版两个选项都是摆设：`busy` 时直接 `return`，按发送键既不发也
  /// 不提示，用户只看到「点了没反应」。这里把两条语义真的做出来，
  /// 而「排队」这件事必须在客户端做——内核的发送通道一次只接一轮，
  /// 它不知道用户在这一轮里又敲了几句。
  Future<void> send(String text) async {
    if (dataMaintenance.locked) {
      _offlineReason = '数据维护期间暂停发送，完成后可重试；输入与附件未清除。';
      notifyListeners();
      return;
    }
    final trimmed = text.trim();
    if (trimmed.isEmpty && _attachments.isEmpty) return;
    final attachments = List<ChatAttachment>.of(_attachments);
    _attachments.clear();

    if (_busy) {
      if (busyPolicy == 'steer') {
        stop();
      } else {
        _queued.add((text: trimmed, attachments: attachments));
        notifyListeners();
        return;
      }
    }

    var pending = _sendNow(trimmed, attachments: attachments);
    var generation = _generation;
    await pending;
    while (generation == _generation && _queued.isNotEmpty) {
      final next = _queued.removeAt(0);
      pending = _sendNow(next.text, attachments: next.attachments);
      generation = _generation;
      await pending;
    }
  }

  /// 真正发一轮。调用方负责判断「现在能不能发」。
  ///
  /// ## 为什么要记 [generation]
  ///
  /// 「插话」会让两轮真正并发：旧那轮还卡在 `await for` 里，新的已经开始。
  /// 旧那轮的 `finally` 一旦无条件把 `_busy` 置回 false，界面就会在
  /// **新一轮正在生成时**显示「空闲」，发送按钮亮起来、停止按钮消失。
  /// 所以每一轮给自己领一个号，只有「当前号」才有资格改 [_busy]。
  /// 谁先把号丢掉，谁的收尾就一概不认——包括错误提示，否则旧轮被插话
  /// 打断时报的错会盖在新一轮的回答上。
  Future<void> _sendNow(
    String trimmed, {
    List<ChatAttachment> attachments = const [],
  }) async {
    final gen = ++_generation;
    bool stale() => gen != _generation;

    // 用户气泡把附件名列出来：它已经随消息发出去了，界面上得能看见带了什么。
    if (attachments.isNotEmpty) {
      final names = attachments.map((a) => a.name).join('、');
      _messages.add(
        ChatMessage(role: ChatRole.user, text: '$trimmed\n[附件] $names'),
      );
    } else {
      _messages.add(ChatMessage(role: ChatRole.user, text: trimmed));
    }
    final reply = ChatMessage(
      role: ChatRole.assistant,
      text: '',
      streaming: true,
    );
    _messages.add(reply);
    _busy = true;
    notifyListeners();

    // 这一轮是不是正常收尾。被作废 / 抛错时为 false，收尾时要把气泡撤掉。
    var answered = false;
    try {
      await for (final chunk in _transport.send(
        trimmed,
        attachments: attachments,
      )) {
        if (stale()) return;
        reply.text += chunk;
        notifyListeners();
      }
      if (stale()) return;
      reply.streaming = false;
      _connected = true;
      // 连接成功后允许设置层做启动同步（首次启动 profile 刚 seed 完的场景）。
      settingsClient.markConnected();
      _offlineReason = null;
      answered = true;
      if (reply.text.isEmpty) {
        _messages.remove(reply);
        answered = false;
        _messages.add(
          ChatMessage(
            role: ChatRole.system,
            text: _offlineReason ?? '内核没有返回内容',
          ),
        );
      } else if (!stale()) {
        // 回答完成时说一句。只在「回到了别的事上」才有意义——
        // 用户正盯着这一屏时，通知是多余的；但这里拿不到窗口焦点，
        // 所以交给通知中心去合并（同一应用连发会被折叠成一条）。
        //
        // 只在**正常有回答**时发：空回答与报错下面各有自己的分支。
        OndraNotify.tell('空谷回你了', _preview(reply.text));
      }
    } catch (e) {
      if (stale()) return;
      _messages.remove(reply);
      answered = false;
      _connected = false;
      _offlineReason = '$e';
      _messages.add(ChatMessage(role: ChatRole.system, text: '$e'));
      // 出错也要说：用户可能已经切走了，回来只看到一条红色的系统消息
      // 而不知道是几分钟前就发生了。
      OndraNotify.tell('这一轮没走通', '$e');
    } finally {
      // 被作废那轮留下的半条流式气泡必须在这里撤掉。
      //
      // 不能在 `await for` 里的 `if (stale()) return;` 顺手删：`return`
      // 直接跳出去，后面那句 `_messages.remove(reply)` 根本走不到，
      // 界面上就会挂着一条永远处于「正在生成」的半截回答。
      // 收尾统一放 finally，两条出口（正常返回 / 提前 return / 抛错）都能覆盖。
      if (!answered && reply.streaming && _messages.contains(reply)) {
        _messages.remove(reply);
      }
      // 只有当前这一轮能改 _busy。旧轮被插话后走到这里时，_busy 属于新那轮。
      if (!stale()) {
        _busy = false;
        notifyListeners();
      }
    }
  }

  /// 通知横幅里的正文摘要。
  ///
  /// 取前 60 个字并把换行压成空格：通知横幅只有一行多一点的位置，
  /// 整段回答塞进去会被系统截断成「前半句…」，那个省略号的位置不是我们
  /// 决定的，看起来像生成中断了。这里自己截，至少断在顺眼的地方。
  static String _preview(String text) {
    final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (flat.length <= 60) return flat;
    return '${flat.substring(0, 60)}…';
  }

  void stop() {
    _generation += 1;
    _connectionGeneration += 1;
    _transport.stop();
    _connected = false;
    _busy = false;
    _queued.clear();
    _messages.removeWhere((message) => message.streaming);
    notifyListeners();
  }

  @override
  void dispose() {
    _generation += 1;
    _connectionGeneration += 1;
    _usageSub?.cancel();
    _transport.stop();
    super.dispose();
  }

  void clear() {
    _messages.clear();
    notifyListeners();
  }

  /// 新建一轮对话：清掉消息、把用量归零。
  ///
  /// 「新建对话」与 [clear] 的区别在**语义**而不是实现：
  /// - [clear] 是「把这一屏清掉」（历史页选中另一条会话时用）；
  /// - [newConversation] 是「开始新的一轮」（表头那颗按钮）。
  ///
  /// 现在两者的动作一样，但分成两个名字，是因为将来接上内核之后
  /// 「新建」还要多做一件事——向内核发 `session/new` 拿到新的会话 id，
  /// 再把这屏挂到那个 id 上。把两个动作合在一个方法里，那天就得在
  /// 所有 `clear()` 的调用点上判断「这次是不是真的新建」。
  Future<void> newConversation() async {
    // 正在生成时先停：留着一条永远不结束的 streaming 消息，
    // 界面会一直显示「正在输入」，而内核那边这一轮已经没人接了。
    if (_busy) stop();
    _queued.clear();
    _attachments.clear();
    _messages.clear();
    _usage = const ChatUsage();
    notifyListeners();
    // 换掉内核会话：内核按 sessionId 建会话，「新建」就是换一个 id，
    // 上下文从这一句起真正归零。之前只调 connect——已连接时它直接返回，
    // 界面像新会话，内核还在原来的上下文里续写。
    _transport.resetSession();
  }
}

enum ChatRole { user, assistant, system }

/// 一次对话里挂上的附件。
///
/// 只存路径与显示名，不存内容。名字抽出来是因为界面上要显示「图.png」，
/// 而路径可能是 `/Users/…/Downloads/图.png`——在 280 宽的右栏里，
/// 路径会把整行撑爆，用户反而认不出是哪个文件。
class ChatAttachment {
  const ChatAttachment({required this.path, required this.name});

  /// 本机绝对路径。
  final String path;

  /// 文件名（路径的最后一段）。
  final String name;

  factory ChatAttachment.fromPath(String path) {
    final normalized = path.replaceAll(r'\', '/');
    final i = normalized.lastIndexOf('/');
    return ChatAttachment(
      path: path,
      name: i < 0 ? normalized : normalized.substring(i + 1),
    );
  }

  /// 发送时的 MIME 类型；认不出的扩展名返回 null。
  ///
  /// 内核的 `session/prompt` 只收图片块（`{type:'image', data, mimeType}`），
  /// 其他文件类型没有对应的传输形态——所以界面只让选图片。
  String? get mimeType {
    final lower = name.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    return null;
  }

  bool get isImage => mimeType != null;
}

/// 一条消息。[streaming] 为真时界面显示一个正在生成的占位。
class ChatMessage {
  ChatMessage({required this.role, required this.text, this.streaming = false});

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

  /// 发一句话。附件是这一条消息要带的图片（本机路径与文件名），
  /// 传输层负责把它读成内核认的 contentBlocks；不支持附件的实现忽略它。
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  });

  /// 丢掉当前会话，下一次 [send] 用新会话。内核按 sessionId 建会话，
  /// 「新建对话」就是换一个 id——不需要新进程。
  void resetSession() {}

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
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) async* {
    throw StateError(reason);
  }

  @override
  void resetSession() {}

  @override
  void stop() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}

/// 全局客户端。装配时由 `ondra-dsh` 插件换掉传输层。
final ChatClient chatClient = ChatClient();
