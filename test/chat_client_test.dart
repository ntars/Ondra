import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/notifier.dart';
import 'package:ondra/app/prefs.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_client.dart';

/// 右栏与内核之间只有一个契约：要么给出增量，要么如实说明为什么没有。
/// 内核没起来时**不允许**假装回一句话——这是这个测试守的东西。
void main() {
  // 偏好要重定向到临时目录：`settingsClient.set` 会同步写 `prefs.json`，
  // 不隔离的话跑一遍测试就把用户真实的通知/发送策略改成测试值。
  late Directory prefHome;
  setUp(() {
    prefHome = Directory.systemTemp.createTempSync('ondra-prefs-');
    setPrefHome(prefHome.path);
    // 「繁忙时的发送行为」默认是排队。每个用例显式写清自己要的策略，
    // 免得测试之间靠执行顺序串味。
    settingsClient.set('dialog.busySend', 'queue');
    // 通知的全局开关也是**真值**：某个用例关掉它之后，下一个用例
    // 会看到「一条通知都没发」，然后错怪被测代码。每轮都推回默认值。
    settingsClient.set('general.notify', true);
    settingsClient.set('general.notifySound', true);
    // 每轮成功/失败都会发系统通知。测试里换掉，否则跑一遍就在用户的
    // 通知中心留下十几条「空谷回你了 · 在的在的」。
    Notifier.probe = NotifierProbe();
  });

  tearDown(() {
    Notifier.probe = null;
    setPrefHome(null);
    try {
      prefHome.deleteSync(recursive: true);
    } catch (_) {}
  });

  test('内核不可用时：消息入列，并追加一条系统提示说明原因', () async {
    final client = ChatClient();
    await client.connect();
    expect(client.offlineReason, isNotNull);

    await client.send('你好');

    expect(client.messages.length, 2);
    expect(client.messages.first.role, ChatRole.user);
    expect(client.messages.last.role, ChatRole.system);
    expect(client.messages.last.text, contains('未启动'));
    expect(client.busy, isFalse);
  });

  test('空内容不发；上一轮结束后还能接着发', () async {
    final client = ChatClient();
    await client.send('   ');
    expect(client.messages, isEmpty);

    await client.send('第一句');
    await client.send('第二句'); // 上一轮结束后 busy 为假，这里也应能发
    expect(client.messages.where((m) => m.role == ChatRole.user).length, 2);
  });

  test('有增量时按流拼接成一条回复', () async {
    final client = ChatClient(transport: _EchoTransport());
    await client.send('在吗');
    final reply = client.messages.last;
    expect(reply.role, ChatRole.assistant);
    expect(reply.text, '在的在的');
    expect(reply.streaming, isFalse);
  });

  test('排队发送：生成期间发的话进队列，这一轮结束后依次发出', () async {
    settingsClient.set('dialog.busySend', 'queue');
    final gate = Completer<void>();
    final transport = _GatedTransport(gate);
    final client = ChatClient(transport: transport);

    // 第一轮卡在 gate 上不结束。
    final first = client.send('第一句');
    await Future<void>.delayed(Duration.zero);
    expect(client.busy, isTrue);

    // 生成期间发第二句：不该丢，也不该插进去，而是进队列。
    await client.send('第二句');
    expect(client.queued, ['第二句']);
    // 队列里的还没有变成界面上的用户消息。
    expect(client.messages.where((m) => m.role == ChatRole.user).length, 1);

    // 放行第一轮，队列里的话应当自动接着发。
    gate.complete();
    await first;

    expect(client.queued, isEmpty);
    final users = client.messages
        .where((m) => m.role == ChatRole.user)
        .toList();
    expect(users.map((m) => m.text), ['第一句', '第二句']);
    expect(client.busy, isFalse);
  });

  test('插话发送：生成期间发的话立刻发，并作废上一轮的半条回答', () async {
    settingsClient.set('dialog.busySend', 'steer');
    final gate = Completer<void>();
    final transport = _GatedTransport(gate, stallFirst: true);
    final client = ChatClient(transport: transport);

    final first = client.send('第一句');
    await Future<void>.delayed(Duration.zero);
    expect(client.busy, isTrue);

    // 插话：不等第一轮，直接发。
    final second = client.send('第二句');
    await second;

    // 第一轮被作废：不会往队列里塞，也不会留下一条说到一半的回答。
    gate.complete();
    await first;

    final users = client.messages
        .where((m) => m.role == ChatRole.user)
        .toList();
    expect(users.map((m) => m.text), ['第一句', '第二句']);
    expect(client.queued, isEmpty);
    // 被作废那轮的流式气泡不能挂在界面上。
    expect(client.messages.where((m) => m.streaming), isEmpty);
    expect(client.busy, isFalse);
  });

  test('停止会清掉队列：上一轮没发出去的话不跟到下一轮', () async {
    settingsClient.set('dialog.busySend', 'queue');
    final gate = Completer<void>();
    final client = ChatClient(transport: _GatedTransport(gate));

    final first = client.send('第一句');
    await Future<void>.delayed(Duration.zero);
    await client.send('第二句');
    expect(client.queued, isNotEmpty);

    client.stop();
    expect(client.queued, isEmpty);
    expect(client.busy, isFalse);

    gate.complete();
    await first;
  });

  test('仅图片也可发送，发送后立即清理本条附件', () async {
    final gate = Completer<void>();
    final transport = _GatedTransport(gate);
    final client = ChatClient(transport: transport);
    addTearDown(client.dispose);
    client.attach(const ChatAttachment(path: '/tmp/one.png', name: 'one.png'));
    final sending = client.send('');
    expect(client.attachments, isEmpty);
    expect(client.messages.first.text, contains('one.png'));
    gate.complete();
    await sending;
    expect(transport.sent.single.attachments.single.name, 'one.png');
  });

  test('队列保留各条附件，上一轮结束不清掉后来添加的草稿', () async {
    final gate = Completer<void>();
    final transport = _GatedTransport(gate);
    final client = ChatClient(transport: transport);
    addTearDown(client.dispose);
    client.attach(
      const ChatAttachment(path: '/tmp/first.png', name: 'first.png'),
    );
    final first = client.send('第一句');
    client.attach(
      const ChatAttachment(path: '/tmp/second.png', name: 'second.png'),
    );
    await client.send('第二句');
    client.attach(
      const ChatAttachment(path: '/tmp/draft.png', name: 'draft.png'),
    );
    gate.complete();
    await first;
    expect(transport.sent.map((item) => item.attachments.single.name), [
      'first.png',
      'second.png',
    ]);
    expect(client.attachments.single.name, 'draft.png');
  });

  test('停止立即撤掉流式气泡，新建会话清理附件', () async {
    final gate = Completer<void>();
    final client = ChatClient(transport: _GatedTransport(gate));
    addTearDown(client.dispose);
    final sending = client.send('第一句');
    client.stop();
    expect(client.messages.any((message) => message.streaming), isFalse);
    client.attach(
      const ChatAttachment(path: '/tmp/draft.png', name: 'draft.png'),
    );
    await client.newConversation();
    expect(client.attachments, isEmpty);
    expect(client.messages, isEmpty);
    gate.complete();
    await sending;
    expect(client.messages, isEmpty);
  });

  test('构造时传入的传输层也接收用量', () async {
    final transport = _UsageTransport();
    final client = ChatClient(transport: transport);
    addTearDown(client.dispose);
    addTearDown(transport.steps.close);
    transport.steps.add(
      const StepUsage(
        tokens: TokenUsage(inputTokens: 5, outputTokens: 3),
        elapsed: Duration(seconds: 1),
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(client.usage.totalTokens, 8);
    expect(client.usage.tps, 3);
  });

  test('旧连接完成不能覆盖新连接的失败原因', () async {
    final gate = Completer<void>();
    final client = ChatClient(transport: _ConnectingTransport(gate));
    addTearDown(client.dispose);
    final old = client.connect();
    client.useTransport(const UnavailableTransport());
    await client.connect();
    final reason = client.offlineReason;
    gate.complete();
    await old;
    expect(client.offlineReason, reason);
    expect(reason, isNotNull);
  });

  test('Windows 附件路径提取文件名', () {
    expect(ChatAttachment.fromPath(r'C:\Pictures\photo.png').name, 'photo.png');
  });

  test('通知开关：关掉就不发，提示音单独控制', () async {
    final probe = NotifierProbe();
    Notifier.probe = probe;
    addTearDown(() => Notifier.probe = null);

    // 默认两条都开：回答完成要发一条、带声音。
    final a = ChatClient(transport: _EchoTransport());
    await a.send('在吗');
    expect(probe.sent, hasLength(1));
    expect(probe.sent.single.title, '空谷回你了');
    expect(probe.sent.single.sound, isTrue);

    // 关掉提示音：仍然发（用户要「安静地知道」），只是不响。
    settingsClient.set('general.notifySound', false);
    final b = ChatClient(transport: _EchoTransport());
    await b.send('在吗');
    expect(probe.sent, hasLength(2));
    expect(probe.sent.last.sound, isFalse);

    // 关掉总开关：一条都不发。
    settingsClient.set('general.notify', false);
    final c = ChatClient(transport: _EchoTransport());
    await c.send('在吗');
    expect(probe.sent, hasLength(2));
  });

  test('通知正文太长要截断：横幅放不下整段回答', () async {
    final probe = NotifierProbe();
    Notifier.probe = probe;
    addTearDown(() => Notifier.probe = null);

    final client = ChatClient(transport: _LongTransport());
    await client.send('讲个长故事');
    expect(probe.sent, hasLength(1));
    expect(probe.sent.single.body.length, lessThanOrEqualTo(61)); // 60 字 + 省略号
    expect(probe.sent.single.body, endsWith('…'));
  });

  test('出错也要发通知：用户可能已经切走了', () async {
    final probe = NotifierProbe();
    Notifier.probe = probe;
    addTearDown(() => Notifier.probe = null);

    final client = ChatClient(transport: _FailingTransport());
    await client.send('在吗');
    expect(probe.sent, hasLength(1));
    expect(probe.sent.single.title, '这一轮没走通');
    expect(probe.sent.single.body, contains('断了'));
  });
}

/// 一段超过横幅长度的回答。
class _LongTransport implements DshTransport {
  @override
  void dispose() {}
  @override
  Future<void> connect() async {}

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) async* {
    yield '这是一段很长的回答，' * 12;
  }

  @override
  void resetSession() {}

  @override
  void stop() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}

/// 半路断掉的传输层。
class _FailingTransport implements DshTransport {
  @override
  void dispose() {}
  @override
  Future<void> connect() async {}

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) async* {
    throw Exception('连接断了');
  }

  @override
  void resetSession() {}

  @override
  void stop() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}

/// 一条流由测试控制的传输层：用来制造「生成还没结束」的那一刻。
///
/// [stallFirst] 为真时**只有第一轮**会卡住，之后的轮次立刻返回。
/// 插话场景必须这样：如果每一轮都等同一个 gate，第二句自己也会被挡住，
/// 那就不是「插话能不能发出」，而是「桩写得对不对」了。
class _GatedTransport implements DshTransport {
  @override
  void dispose() {}
  _GatedTransport(this.gate, {this.stallFirst = false});

  final Completer<void> gate;
  final bool stallFirst;
  int _round = 0;
  final List<({String text, List<ChatAttachment> attachments})> sent = [];

  @override
  Future<void> connect() async {}

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) async* {
    final round = _round++;
    sent.add((text: text, attachments: attachments));
    if (!stallFirst || round == 0) await gate.future;
    yield '$text 的回答';
  }

  @override
  void resetSession() {}

  @override
  void stop() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}

class _UsageTransport extends _EchoTransport {
  final steps = StreamController<StepUsage>.broadcast();

  @override
  Stream<StepUsage> get usage => steps.stream;
}

class _ConnectingTransport extends _EchoTransport {
  _ConnectingTransport(this.gate);

  final Completer<void> gate;

  @override
  Future<void> connect() => gate.future;
}

class _EchoTransport implements DshTransport {
  @override
  void dispose() {}
  @override
  Future<void> connect() async {}

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) async* {
    yield '在的';
    yield '在的';
  }

  @override
  void resetSession() {}

  @override
  void stop() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}
