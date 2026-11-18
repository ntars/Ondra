import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/rpc_frames.dart';

/// 线格式的编解码是这条链路上唯一能脱离进程测试的部分，所以把它测透：
/// 请求怎么发、坏行怎么丢、增量文本从哪个字段取、何时算一轮结束。
void main() {
  test('请求编码：jsonrpc 2.0 + id + method + params', () {
    final line = RpcFrame.encodeRequest(7, 'session/prompt', {
      'sessionId': 's1',
      'contentBlocks': [
        {'type': 'text', 'text': '你好'},
      ],
    });
    final json = jsonDecode(line) as Map<String, dynamic>;
    expect(json['jsonrpc'], '2.0');
    expect(json['id'], 7);
    expect(json['method'], 'session/prompt');
    expect((json['params'] as Map)['sessionId'], 's1');
  });

  test('无参请求不写 params 键', () {
    final json = jsonDecode(RpcFrame.encodeRequest(1, 'shutdown')) as Map;
    expect(json.containsKey('params'), isFalse);
  });

  test('响应与通知可区分；坏行返回 null', () {
    final resp = RpcFrame.decode('{"jsonrpc":"2.0","id":3,"result":{"ok":true}}')!;
    expect(resp.isResponse, isTrue);

    final note = RpcFrame.decode('{"jsonrpc":"2.0","method":"session.event","params":{}}')!;
    expect(note.isNotification, isTrue);

    expect(RpcFrame.decode('not json'), isNull);
    expect(RpcFrame.decode(''), isNull);
  });

  test('增量文本：text / delta / content[] 三种写法都能取到', () {
    String? text(Map<String, dynamic> event) =>
        textOfSessionEvent({'sessionId': 's1', 'event': event});

    expect(text({'type': 'assistant/delta', 'text': '你'}), '你');
    expect(text({'type': 'assistant/text', 'delta': '好'}), '好');
    expect(
      text({
        'type': 'assistant/message',
        'content': [
          {'type': 'text', 'text': '在'},
          {'type': 'text', 'text': '的'},
        ],
      }),
      '在的',
    );
    // 工具事件没有可显示文本，应返回 null 而不是空串
    expect(text({'type': 'tool/call', 'name': 'read'}), isNull);
  });

  test('turn/end 才算一轮结束', () {
    expect(isTurnEnd({'event': {'type': 'turn/end'}}), isTrue);
    expect(isTurnEnd({'event': {'type': 'assistant/delta', 'text': 'a'}}), isFalse);
  });
}
