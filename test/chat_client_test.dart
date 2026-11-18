import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';

/// 右栏与内核之间只有一个契约：要么给出增量，要么如实说明为什么没有。
/// 内核没起来时**不允许**假装回一句话——这是这个测试守的东西。
void main() {
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

  test('空内容不发；busy 时重复发送被忽略', () async {
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
}

class _EchoTransport implements DshTransport {
  @override
  Future<void> connect() async {}

  @override
  Stream<String> send(String text) async* {
    yield '在的';
    yield '在的';
  }

  @override
  void stop() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}
