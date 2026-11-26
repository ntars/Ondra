import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/rpc_frames.dart';

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
    final resp = RpcFrame.decode(
      '{"jsonrpc":"2.0","id":3,"result":{"ok":true}}',
    )!;
    expect(resp.isResponse, isTrue);

    final note = RpcFrame.decode(
      '{"jsonrpc":"2.0","method":"session.event","params":{}}',
    )!;
    expect(note.isNotification, isTrue);

    expect(RpcFrame.decode('not json'), isNull);
    expect(RpcFrame.decode(''), isNull);
  });

  test('只有 assistant/message 的 data.message.content[] 能显示正文', () {
    String? text(Map<String, dynamic> event) =>
        textOfSessionEvent({'sessionId': 's1', 'event': event});

    expect(text({'type': 'assistant/delta', 'text': '你'}), isNull);
    expect(text({'type': 'assistant/text', 'delta': '好'}), isNull);
    expect(
      text({
        'type': 'assistant/message',
        'data': {
          'message': {
            'content': [
              {'type': 'text', 'text': '在'},
              {'type': 'text', 'text': '的'},
            ],
          },
        },
      }),
      '在的',
    );
    expect(
      text({
        'type': 'assistant/message',
        'content': [
          {'type': 'text', 'text': '历史兼容位置'},
        ],
      }),
      isNull,
    );
    expect(
      text({'type': 'assistant/message', 'text': '历史兼容字段', 'delta': '历史兼容增量'}),
      isNull,
    );
    // 工具事件没有可显示文本，应返回 null 而不是空串
    expect(text({'type': 'tool/call', 'name': 'read'}), isNull);
  });

  test('非法 method 类型忽略整帧，不抛 cast 异常或误认作响应', () {
    for (final method in [42, true, [], {}, null]) {
      expect(RpcFrame.decode(jsonEncode({'id': 1, 'method': method})), isNull);
    }
    expect(RpcFrame.decode('[1,2,3]'), isNull);
    expect(RpcFrame.decode('null'), isNull);
    expect(
      RpcFrame.decode('{"id":1,"method":"initialize"}')!.isRequest,
      isTrue,
    );
  });

  test('真实 assistant/message 只显示 data.message.content 的 text 块', () {
    expect(
      textOfSessionEvent({
        'event': {
          'type': 'assistant/message',
          'data': {
            'message': {
              'content': [
                {'type': 'reasoning', 'text': 'private'},
                {'type': 'text', 'text': 'answer'},
                {'type': 'tool_call', 'text': 'internal'},
                {'type': 'text', 'text': '!'},
              ],
            },
          },
        },
      }),
      'answer!',
    );
  });

  test('reasoning、工具、错误事件不能因含 assistant 或 text 而冒充正文', () {
    for (final type in [
      'assistant/reasoning',
      'assistant/reasoning/text',
      'assistant/thinking',
      'assistant/tool_call',
      'tool/text',
      'context/text',
      'assistant/error',
      'turn/end',
    ]) {
      expect(
        textOfSessionEvent({
          'event': {
            'type': type,
            'text': 'private',
            'delta': 'private',
            'data': {
              'delta': 'private',
              'message': {
                'content': [
                  {'type': 'text', 'text': 'private'},
                ],
              },
            },
          },
        }),
        isNull,
        reason: type,
      );
    }
  });

  test('真实 turn/end reason.error 返回 message 与 code，不返回内部结构', () {
    Map<String, dynamic> payload(Object? reason) => {
      'event': {
        'type': 'turn/end',
        'data': {'reason': reason},
      },
    };
    final failure = payload({
      'kind': 'error',
      'error': {'message': 'quota exceeded', 'code': 'quota'},
    });
    expect(errorOfSessionEvent(failure), 'quota exceeded（quota）');
    expect(textOfSessionEvent(failure), isNull);
    expect(
      errorOfSessionEvent(
        payload({
          'kind': 'error',
          'error': {
            'message': 'pi-ai detected context overflow for model "x"',
            'code': 'CONTEXT_WINDOW_EXCEEDED',
          },
        }),
      ),
      '上下文超限，请缩短输入或开启新会话（CONTEXT_WINDOW_EXCEEDED）',
    );
    expect(
      errorOfSessionEvent(
        payload({
          'kind': 'error',
          'error': {'code': 429},
        }),
      ),
      '内核生成失败（429）',
    );
    expect(
      errorOfSessionEvent(
        payload({
          'kind': 'error',
          'error': {
            'message': {'reasoning': 'private'},
          },
        }),
      ),
      '内核生成失败',
    );
    expect(errorOfSessionEvent(payload({'kind': 'error'})), '内核生成失败');
    expect(
      errorOfSessionEvent(
        payload({
          'kind': 'completed',
          'error': {'message': 'not an error'},
        }),
      ),
      isNull,
    );
    expect(errorOfSessionEvent(payload(null)), isNull);
    expect(
      errorOfSessionEvent({
        'event': {
          'type': 'assistant/reasoning',
          'data': {
            'reason': {'kind': 'error'},
          },
        },
      }),
      isNull,
    );
  });

  test('usage 支持 data.message.usage 及已有层级，缺失不冒充零用量', () {
    final usage = {
      'inputTokens': 10,
      'outputTokens': 20,
      'cacheReadTokens': 30,
      'cacheWriteTokens': 40,
      'reasoningTokens': 5,
      'totalTokens': 100,
    };
    for (final body in [
      {'usage': usage},
      {
        'data': {'usage': usage},
      },
      {
        'message': {'usage': usage},
      },
      {
        'data': {
          'message': {'usage': usage},
        },
      },
    ]) {
      final tokens = usageOfSessionEvent({
        'event': {'type': 'assistant/message', ...body},
      })!;
      expect(tokens.inputTokens, 10);
      expect(tokens.outputTokens, 20);
      expect(tokens.cacheReadTokens, 30);
      expect(tokens.cacheWriteTokens, 40);
      expect(tokens.reasoningTokens, 5);
      expect(tokens.totalTokens, 100);
    }
    expect(
      usageOfSessionEvent({
        'event': {
          'type': 'assistant/message',
          'data': {'message': {}},
        },
      }),
      isNull,
    );
    expect(
      usageOfSessionEvent({
        'event': {
          'usage': {'inputTokens': '10', 'outputTokens': 2},
        },
      }),
      isNull,
    );
  });

  test('turn/end 才算一轮结束', () {
    expect(
      isTurnEnd({
        'event': {'type': 'turn/end'},
      }),
      isTrue,
    );
    expect(
      isTurnEnd({
        'event': {'type': 'assistant/delta', 'text': 'a'},
      }),
      isFalse,
    );
  });
}
