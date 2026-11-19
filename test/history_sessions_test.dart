import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-history/ui/history_sessions.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-history/ui/history_sessions_stub.dart'
    as stub;

Map<String, Object?> _message(
  String role,
  Object? content, {
  String? id,
  String? source,
}) => {
  'role': role,
  'content': content,
  'id': ?id,
  if (source != null) 'source': {'kind': source},
};

Map<String, Object?> _event(
  String type,
  Object? data, {
  int? seq,
  Object? time,
}) => {'type': type, 'data': data, 'seq': ?seq, 'time': ?time};

void main() {
  late Directory temp;
  late String dshHome;

  setUp(() async {
    temp = await Directory.systemTemp.createTemp('ondra-history-test-');
    dshHome = '${temp.path}/dsh';
  });

  tearDown(() async {
    await temp.delete(recursive: true);
  });

  Future<File> writeSession(
    String id,
    List<Object?> rows, {
    String project = 'project',
    String? directoryId,
    String? home,
    DateTime? modified,
  }) async {
    final file = File(
      '${home ?? dshHome}/sessions/$project/${directoryId ?? id}/session.v4.jsonl',
    );
    await file.parent.create(recursive: true);
    await file.writeAsString(
      [
        jsonEncode({
          'type': 'session',
          'version': 4,
          'id': id,
          'cwd': '/work/$project',
        }),
        ...rows.map(jsonEncode),
      ].join('\n'),
    );
    if (modified != null) await file.setLastModified(modified);
    return file;
  }

  Future<List<(String, String)>> messages(String id, {String? home}) async => [
    for (final entry in await readSessionMessages(id, dshHome: home ?? dshHome))
      (entry.role, entry.text),
  ];

  test('真实 v4：inbox 用户、user/message 投影和助手正文按追加顺序读取', () async {
    final user = _message(
      'user',
      [
        {'type': 'text', 'text': '你好'},
      ],
      id: 'u1',
      source: 'user',
    );
    final assistant = _message(
      'assistant',
      [
        {'type': 'reasoning', 'text': '不要展示的思考'},
        {'type': 'text', 'text': '你好，'},
        {'type': 'image', 'url': 'ignored'},
        {'type': 'tool-call', 'text': '不要展示的调用'},
        {'type': 'text', 'text': '我在。'},
      ],
      id: 'a1',
      source: 'model',
    );
    await writeSession('real', [
      _event('agent/inbox/spliced', {
        'target': 'next-turn',
        'start': 0,
        'inserted': [user],
      }, seq: 1),
      {..._event('user/message', user, seq: 2), 'surfaceOp': 'append'},
      _event('assistant/message', {'message': assistant}, seq: 3),
      // inbox 中的助手副本不是一次新回答。
      _event('agent/inbox/spliced', {
        'inserted': [assistant],
      }, seq: 4),
      _event(
        'user/message',
        _message('user', '继续', id: 'u2', source: 'user'),
        seq: 5,
      ),
      _event('assistant/message', {
        'message': _message('assistant', '好的', id: 'a2'),
      }, seq: 6),
    ]);

    expect(await messages('real'), [
      ('user', '你好'),
      ('assistant', '你好，我在。'),
      ('user', '继续'),
      ('assistant', '好的'),
    ]);
    final summary = (await readSessions(dshHome: dshHome)).single;
    expect(summary.title, '你好');
    expect(summary.messages, 2);
    expect(summary.cwd, '/work/project');
  });

  test('多 inserted 逐条计数；按 id 去重但不同 id 的相同正文不合并', () async {
    final first = _message('user', '重复文字', id: 'u1', source: 'user');
    final second = _message('user', '重复文字', id: 'u2', source: 'user');
    final answer = _message('assistant', '相同回答', id: 'a1');
    final withoutId = _event('assistant/message', {
      'message': _message('assistant', '没有 id 的回答'),
    }, seq: 8);
    await writeSession('duplicates', [
      _event('agent/inbox/spliced', {
        'inserted': [first, second, first],
      }, seq: 1),
      _event('user/message', first, seq: 2),
      _event('user/message', second, seq: 3),
      _event('assistant/message', {'message': answer}, seq: 4),
      _event('assistant/message', {'message': answer}, seq: 5),
      _event('assistant/message', {
        'message': _message('assistant', '相同回答', id: 'a2'),
      }, seq: 6),
      _event('user/message', {
        'message': _message('user', '单独的用户消息', id: 'u3'),
      }, seq: 7),
      withoutId,
      withoutId,
    ]);

    expect(await messages('duplicates'), [
      ('user', '重复文字'),
      ('user', '重复文字'),
      ('assistant', '相同回答'),
      ('assistant', '相同回答'),
      ('user', '单独的用户消息'),
      ('assistant', '没有 id 的回答'),
    ]);
    expect((await readSessions(dshHome: dshHome)).single.messages, 3);
    // 去重状态属于单次读取，不得污染随后再次打开的历史。
    expect(await messages('duplicates'), hasLength(6));
  });

  test('工具、系统、内部 user 上下文和助手尝试不进正文或摘要', () async {
    final hidden = _message('user', '隐藏的内部内容', id: 'hidden');
    await writeSession('filtered', [
      for (final type in [
        'tool/result',
        'system/message',
        'developer/message',
        'assistant/attempt',
        'assistant/delta',
        'session/title-llm-request',
      ])
        _event(type, {
          'inserted': [hidden],
          'message': hidden,
          'text': '隐藏',
        }),
      for (final kind in ['runtime-context', 'compaction', 'tool']) ...[
        _event('agent/inbox/spliced', {
          'inserted': [_message('user', '隐藏', source: kind)],
        }),
        _event('user/message', _message('user', '隐藏', source: kind)),
      ],
      _event('agent/inbox/spliced', {
        'inserted': [
          _message('system', '系统'),
          _message('tool', '工具'),
          _message('assistant', '不是助手完成事件'),
          _message('user', ' \n '),
          _message('user', [
            {'type': 'image', 'url': 'ignored'},
          ]),
        ],
      }),
      _event('assistant/message', {'message': _message('tool', '角色不符')}),
      _event('assistant/message', {
        'message': _message('assistant', [
          {'type': 'reasoning', 'text': '只有思考'},
          {'type': 'tool-call', 'text': '只有工具调用'},
        ]),
      }),
      _event('user/message', _message('user', '真正的问题', source: 'user')),
      _event('assistant/message', {
        'message': {'content': '真正的回答'},
      }),
    ]);

    expect(await messages('filtered'), [
      ('user', '真正的问题'),
      ('assistant', '真正的回答'),
    ]);
    final summary = (await readSessions(dshHome: dshHome)).single;
    expect(summary.messages, 1);
    expect(summary.title, '真正的问题');
  });

  test('坏 JSON、错误字段、越界时间和末尾半截行不吞掉后续有效消息', () async {
    final file = await writeSession('broken', [
      null,
      42,
      [],
      _event('agent/inbox/spliced', null),
      _event('agent/inbox/spliced', {'inserted': 'not a list'}),
      _event('assistant/message', {'message': false}),
      _event('user/message', _message('user', {'text': 'not content'})),
      _event('agent/inbox/spliced', {
        'inserted': [
          null,
          7,
          _message('user', [
            null,
            {'type': 'text', 'text': 42},
          ]),
          _message('user', [
            {'type': 'text', 'text': '第一'},
            {'type': 'text', 'text': '句'},
          ]),
        ],
      }, time: 9000000000000000),
    ]);
    await file.writeAsString(
      '\nnot json\n \n${jsonEncode(_event('assistant/message', {'message': _message('assistant', '坏行后仍能读到')}))}\n{"type":',
      mode: FileMode.append,
    );

    expect(await messages('broken'), [
      ('user', '第一句'),
      ('assistant', '坏行后仍能读到'),
    ]);
    final summary = (await readSessions(dshHome: dshHome)).single;
    expect(summary.messages, 1);
    expect(summary.title, '第一句');
  });

  test('摘要跨项目按最后活动倒序，支持秒、毫秒、ISO 并保留 mtime 下限', () async {
    final old = DateTime.utc(2000);
    final latest = DateTime.utc(2024);
    final middle = DateTime.utc(2023);
    final earlier = DateTime.utc(2022);
    await writeSession(
      'seconds',
      [_event('turn/end', {}, time: earlier.millisecondsSinceEpoch ~/ 1000)],
      project: 'a',
      modified: old,
    );
    await writeSession(
      'milliseconds',
      [
        _event('turn/end', {}, time: latest.millisecondsSinceEpoch),
        _event('turn/end', {}, time: earlier.millisecondsSinceEpoch),
      ],
      project: 'b',
      modified: old,
    );
    await writeSession(
      'iso',
      [_event('turn/end', {}, time: middle.toIso8601String())],
      project: 'a',
      modified: old,
    );
    await writeSession(
      'mtime',
      [
        _event('turn/end', {}, time: old.toIso8601String()),
        _event('turn/end', {}, time: 'invalid'),
      ],
      project: 'b',
      modified: DateTime.utc(2025),
    );

    final summaries = await readSessions(dshHome: dshHome);
    expect(summaries.map((s) => s.id), [
      'mtime',
      'milliseconds',
      'iso',
      'seconds',
    ]);
    expect(summaries.map((s) => s.updatedAt.toUtc()), [
      DateTime.utc(2025),
      latest,
      middle,
      earlier,
    ]);
    expect(
      summaries.every((s) => s.title == '空白会话' && s.messages == 0),
      isTrue,
    );
  });

  test('摘要标题整理截断，文件头 id 不同于目录名时仍可读取', () async {
    final longText = List.filled(80, '字').join();
    await writeSession('header-id', [
      _event('agent/inbox/spliced', {
        'inserted': [
          _message('user', ' \n 你好   世界\n$longText  '),
          _message('user', '第二句'),
        ],
      }),
    ], directoryId: 'legacy-directory');

    final summary = (await readSessions(dshHome: dshHome)).single;
    expect(summary.id, 'header-id');
    expect(summary.title, startsWith('你好 世界 '));
    expect(summary.title.length, 60);
    expect(summary.title, endsWith('…'));
    expect(summary.messages, 2);
    expect(await messages('header-id'), hasLength(2));
    expect(await messages('missing'), isEmpty);
  });

  test('缺失根目录、会话文件和空文件安全降级，忽略非目录杂项', () async {
    expect(await readSessions(dshHome: dshHome), isEmpty);
    expect(await messages('missing'), isEmpty);
    final root = await Directory('$dshHome/sessions').create(recursive: true);
    await File('${root.path}/not-a-project').writeAsString('ignored');
    final project = await Directory('${root.path}/project').create();
    await File('${project.path}/not-a-session').writeAsString('ignored');
    await Directory('${project.path}/no-file').create();
    expect(await readSessions(dshHome: dshHome), isEmpty);
    expect(await messages('no-file'), isEmpty);

    final empty = await writeSession('empty', []);
    await empty.writeAsString('');
    final summary = (await readSessions(dshHome: dshHome)).single;
    expect(summary.id, 'empty');
    expect(summary.title, '空白会话');
    expect(summary.messages, 0);
    expect(await messages('empty'), isEmpty);
    expect(await messages('missing'), isEmpty);
  });

  test('dshHome 同时隔离列表和正文，两个根目录不会串读', () async {
    final otherHome = '${temp.path}/other-dsh';
    await writeSession('same-id', [
      _event('user/message', _message('user', '第一个库')),
    ]);
    await writeSession('same-id', [
      _event('user/message', _message('user', '第二个库')),
    ], home: otherHome);

    expect((await readSessions(dshHome: dshHome)).single.title, '第一个库');
    expect((await readSessions(dshHome: otherHome)).single.title, '第二个库');
    expect(await messages('same-id'), [('user', '第一个库')]);
    expect(await messages('same-id', home: otherHome), [('user', '第二个库')]);
  });

  test('Web stub 保持可选 dshHome 签名和空结果', () async {
    expect(await stub.readSessions(dshHome: dshHome), isEmpty);
    expect(
      await stub.readSessionMessages('missing', dshHome: dshHome),
      isEmpty,
    );
  });
}
