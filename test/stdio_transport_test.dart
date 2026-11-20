import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport_io.dart';

void main() {
  late String node;
  late _Fixture fixture;

  setUpAll(() async {
    final result = await Process.run('node', ['-p', 'process.execPath']);
    expect(result.exitCode, 0, reason: '协议 fixture 需要本机 Node.js');
    node = (result.stdout as String).trim();
  });

  setUp(() async {
    fixture = _Fixture(
      await Directory.systemTemp.createTemp('ondra-stdio-'),
      node,
    );
  });

  tearDown(() => fixture.dispose());

  Matcher stateError(String message) => isA<StateError>().having(
    (error) => error.message,
    'message',
    contains(message),
  );

  test('initialize 拒绝后清理进程，重连重新握手且清除旧错误', () async {
    final transport = fixture.transport(scenario: 'reject-initialize-once');
    await expectLater(
      transport.connect(),
      throwsA(stateError('initialize rejected')),
    );
    expect(transport.lastError, contains('initialize rejected'));
    await transport.connect();
    expect(transport.lastError, isNull);
    expect(await transport.send('ok').toList(), ['reply:ok']);
    expect(fixture.requests('initialize'), hasLength(2));
    fixture.expectRetiredBeforeRestart();
  });

  test('并发 connect 共享握手，send 不会在 initialize 完成前发请求', () async {
    final transport = fixture.transport(scenario: 'delay-initialize');
    final first = transport.connect();
    final second = transport.connect();
    expect(identical(first, second), isTrue);
    var connected = false;
    final observed = first.then((_) => connected = true);
    final reply = transport.send('concurrent').toList();
    await fixture.waitForRequest('initialize');
    expect(connected, isFalse);
    expect(fixture.requests('session/prompt'), isEmpty);
    await Future.wait([observed, second]);
    expect(await reply, ['reply:concurrent']);
    expect(fixture.requests('initialize'), hasLength(1));
    expect(
      fixture.records.where((record) => record['event'] == 'start'),
      hasLength(1),
    );
  });

  test('并发 connect 在初始化失败时全部失败，不误报连接成功', () async {
    final transport = fixture.transport(scenario: 'reject-initialize-once');
    final first = transport.connect();
    final second = transport.connect();
    await Future.wait([
      expectLater(first, throwsA(stateError('initialize rejected'))),
      expectLater(second, throwsA(stateError('initialize rejected'))),
    ]);
    await transport.connect();
    expect(fixture.requests('initialize'), hasLength(2));
  });

  test('stop 立即结束活动流；下次发送等待旧进程退出并 resume 上下文', () async {
    final transport = fixture.transport(exitDelayMs: 450);
    expect(await transport.send('first').toList(), ['reply:first']);
    final received = Completer<void>();
    final finished = Completer<void>();
    final errors = <Object>[];
    final chunks = <String>[];
    transport
        .send('partial-hang')
        .listen(
          (chunk) {
            chunks.add(chunk);
            received.complete();
          },
          onError: errors.add,
          onDone: finished.complete,
        );
    await received.future.timeout(const Duration(seconds: 3));
    transport.stop();
    final next = transport.send('history').toList();
    await finished.future.timeout(const Duration(milliseconds: 250));
    expect(chunks, ['partial']);
    expect(errors.single, stateError('已停止'));
    expect(await next, ['first|partial-hang']);
    final prompts = fixture.requests('session/prompt');
    expect(
      prompts.map((request) => (request['params'] as Map)['sessionId']).toSet(),
      hasLength(1),
    );
    expect(fixture.requests('session/resume'), hasLength(1));
    fixture.expectRetiredBeforeRestart();
    // 新语义：stop 走 session/query 的 /cancel-turn（杀进程是兜底）。
    expect(fixture.requests('session/cancel'), isEmpty);
  });

  test('stop 结清未返回的 prompt 请求，不必等 requestTimeout', () async {
    final transport = fixture.transport(exitDelayMs: 100);
    final pending = expectLater(
      transport.send('hang-prompt').toList(),
      throwsA(stateError('已停止')),
    );
    await fixture.waitForRequest('session/prompt');
    transport.stop();
    final next = transport.send('history').toList();
    await pending.timeout(const Duration(milliseconds: 250));
    expect(await next, ['hang-prompt']);
    expect(fixture.requests('session/resume'), hasLength(1));
    fixture.expectRetiredBeforeRestart();
  });

  test('初始化中 stop 结清 connect 和 send，下次发送可自动握手', () async {
    final transport = fixture.transport(scenario: 'hang-initialize-once');
    final connecting = expectLater(
      transport.connect(),
      throwsA(stateError('已停止')),
    );
    final sending = expectLater(
      transport.send('cancelled').toList(),
      throwsA(stateError('已停止')),
    );
    await fixture.waitForRequest('initialize');
    transport.stop();
    final next = transport.send('next').toList();
    await Future.wait([connecting, sending])
        .timeout(const Duration(milliseconds: 250));
    expect(await next, ['reply:next']);
    expect(fixture.requests('session/resume'), isEmpty);
    expect(fixture.requests('session/prompt'), hasLength(1));
    fixture.expectRetiredBeforeRestart();
  });

  test('stop 可在 Process.start 前打断且不会残留子进程', () async {
    final transport = fixture.transport();
    final connecting = expectLater(
      transport.connect(),
      throwsA(stateError('已停止')),
    );
    transport.stop();
    final next = transport.send('next').toList();
    await connecting;
    expect(await next, ['reply:next']);
    expect(fixture.requests('initialize'), hasLength(1));
  });

  test('多次 stop/connect 交错不会让旧 exit 回调破坏新连接', () async {
    final transport = fixture.transport(exitDelayMs: 100);
    await transport.connect();
    transport.stop();
    final abandoned = expectLater(
      transport.connect(),
      throwsA(stateError('已停止')),
    );
    transport.stop();
    await abandoned;
    expect(await transport.send('next').toList(), ['reply:next']);
    expect(await transport.send('still-connected').toList(), [
      'reply:still-connected',
    ]);
    expect(transport.lastError, isNull);
    expect(fixture.requests('initialize'), hasLength(2));
    fixture.expectRetiredBeforeRestart();
  });

  test('resetSession 在同一进程明确创建新上下文', () async {
    final transport = fixture.transport();
    await transport.send('old').drain<void>();
    transport.resetSession();
    await transport.send('new').drain<void>();
    expect(await transport.send('history').toList(), ['new']);
    final prompts = fixture.requests('session/prompt');
    expect(
      (prompts[0]['params'] as Map)['sessionId'],
      isNot((prompts[1]['params'] as Map)['sessionId']),
    );
    expect(fixture.requests('initialize'), hasLength(1));
    expect(fixture.requests('session/resume'), isEmpty);
  });

  test('resetSession 会结束活动流，下一次发送建立全新上下文', () async {
    final transport = fixture.transport();
    final pending = expectLater(
      transport.send('hang-turn').toList(),
      throwsA(stateError('已停止')),
    );
    await fixture.waitForRequest('session/prompt');
    transport.resetSession();
    final next = transport.send('new').toList();
    await pending;
    expect(await next, ['reply:new']);
    expect(await transport.send('history').toList(), ['new']);
    expect(fixture.requests('session/resume'), isEmpty);
  });

  test('取消 send 订阅也释放活动轮次，随后可重连并恢复上下文', () async {
    final transport = fixture.transport();
    final subscription = transport.send('hang-turn').listen((_) {});
    await fixture.waitForRequest('session/prompt');
    await subscription.cancel();
    expect(await transport.send('history').toList(), ['hang-turn']);
    expect(fixture.requests('session/resume'), hasLength(1));
  });

  test('空闲进程异常退出也清除连接，下次发送自动 resume', () async {
    final transport = fixture.transport();
    expect(await transport.send('exit-idle').toList(), ['reply:exit-idle']);
    await fixture.waitFor(() => transport.lastError != null);
    expect(transport.lastError, contains('exit 21'));
    expect(await transport.send('history').toList(), ['exit-idle']);
    expect(fixture.requests('session/resume'), hasLength(1));
    expect(transport.lastError, isNull);
  });

  test('stop 后 resetSession 不恢复旧会话', () async {
    final transport = fixture.transport();
    await transport.send('old').drain<void>();
    transport.stop();
    transport.resetSession();
    await transport.send('new').drain<void>();
    expect(await transport.send('history').toList(), ['new']);
    expect(fixture.requests('session/resume'), isEmpty);
  });

  test('resume 失败明确报错，下一次连接仍恢复原 sessionId', () async {
    final transport = fixture.transport(scenario: 'reject-resume-once');
    await transport.send('old').drain<void>();
    transport.stop();
    await expectLater(
      transport.send('not-sent').toList(),
      throwsA(stateError('resume rejected')),
    );
    expect(await transport.send('history').toList(), ['old']);
    expect(fixture.requests('session/prompt'), hasLength(2));
    final resumes = fixture.requests('session/resume');
    expect(resumes, hasLength(2));
    expect(resumes[0]['params'], resumes[1]['params']);
    fixture.expectRetiredBeforeRestart();
  });

  test('初始化异常退出立即结清 pending，重连成功', () async {
    final transport = fixture.transport(scenario: 'exit-initialize-once');
    await expectLater(transport.connect(), throwsA(stateError('exit 23')));
    expect(await transport.send('ok').toList(), ['reply:ok']);
    expect(fixture.requests('initialize'), hasLength(2));
  });

  for (final command in ['exit-prompt', 'exit-turn']) {
    test('$command 异常退出报错并可自动恢复会话', () async {
      final transport = fixture.transport();
      await expectLater(
        transport.send(command).toList(),
        throwsA(stateError('内核进程已退出')),
      );
      expect(await transport.send('history').toList(), [command]);
      expect(fixture.requests('session/resume'), hasLength(1));
      fixture.expectRetiredBeforeRestart();
    });
  }

  test('turn/end 的真实 API 错误从错误通道返回，不泄露 reasoning', () async {
    final transport = fixture.transport();
    await expectLater(
      transport.send('api-error'),
      emitsInOrder([
        emitsError(stateError('API quota exceeded（quota_exceeded）')),
        emitsDone,
      ]),
    );
    expect(transport.lastError, contains('quota_exceeded'));
    expect(await transport.send('ok').toList(), ['reply:ok']);
    expect(fixture.requests('initialize'), hasLength(1));
  });

  test('部分正文后的 API 错误仍明确失败', () async {
    final transport = fixture.transport();
    await expectLater(
      transport.send('partial-error'),
      emitsInOrder([
        'partial',
        emitsError(stateError('API quota exceeded')),
        emitsDone,
      ]),
    );
  });

  test('prompt JSON-RPC 拒绝不是模型回答', () async {
    final transport = fixture.transport();
    await expectLater(
      transport.send('rpc-error'),
      emitsInOrder([emitsError(stateError('prompt rejected（403）')), emitsDone]),
    );
    expect(await transport.send('ok').toList(), ['reply:ok']);
  });

  test('initialize 请求超时会清理并允许重连', () async {
    final transport = fixture.transport(
      scenario: 'hang-initialize-once',
      requestTimeout: const Duration(milliseconds: 180),
    );
    await expectLater(transport.connect(), throwsA(isA<TimeoutException>()));
    expect(transport.lastError, contains('initialize'));
    expect(await transport.send('ok').toList(), ['reply:ok']);
    fixture.expectRetiredBeforeRestart();
  });

  test('prompt 请求超时明确失败，不静默成功，重启后 resume', () async {
    final transport = fixture.transport(
      requestTimeout: const Duration(milliseconds: 180),
    );
    await expectLater(
      transport.send('hang-prompt'),
      emitsInOrder([emitsError(isA<TimeoutException>()), emitsDone]),
    );
    expect(transport.lastError, contains('session/prompt'));
    expect(await transport.send('history').toList(), ['hang-prompt']);
    expect(fixture.requests('session/resume'), hasLength(1));
  });

  test('轮次超时明确失败并结束已有部分输出，下一轮自动恢复', () async {
    final transport = fixture.transport(
      turnTimeout: const Duration(milliseconds: 180),
    );
    await expectLater(
      transport.send('partial-hang'),
      emitsInOrder(['partial', emitsError(isA<TimeoutException>()), emitsDone]),
    );
    expect(transport.lastError, contains('turn/end'));
    expect(await transport.send('history').toList(), ['partial-hang']);
  });

  test('只统计当前 session usage，其他 session 不影响文本、结束或耗时', () async {
    final transport = fixture.transport();
    final usage = <StepUsage>[];
    final sub = transport.usage.listen(usage.add);
    addTearDown(sub.cancel);
    expect(await transport.send('usage').toList(), ['reply:usage']);
    expect(usage, hasLength(1));
    expect(usage.single.tokens.inputTokens, 10);
    expect(usage.single.tokens.outputTokens, 20);
    expect(usage.single.tokens.cacheReadTokens, 5);
    expect(usage.single.elapsed, const Duration(seconds: 2));
    transport.stop();
    expect(await transport.send('ok').toList(), ['reply:ok']);
    expect(usage, hasLength(1), reason: 'resume 回放不能重复记账');
  });

  test('所有附件缺失或不支持时只报明确错误，不产出伪回复或残缺请求', () async {
    final transport = fixture.transport();
    await expectLater(
      transport.send(
        'describe',
        attachments: [
          ChatAttachment(
            path: '${fixture.home.path}/missing.png',
            name: 'missing.png',
          ),
          ChatAttachment(
            path: '${fixture.home.path}/notes.txt',
            name: 'notes.txt',
          ),
        ],
      ),
      emitsInOrder([
        emitsError(stateError('附件发送失败：missing.png（无法读取）、notes.txt（不支持的附件类型）')),
        emitsDone,
      ]),
    );
    expect(fixture.requests('session/prompt'), isEmpty);
    expect(fixture.records, isEmpty);
    expect(await transport.send('ok').toList(), ['reply:ok']);
  });

  test('有效图片按 base64 发送；混合无效附件时整次发送失败而非偷偷丢附件', () async {
    final transport = fixture.transport();
    final file = File('${fixture.home.path}/pixel.png');
    final bytes = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=',
    );
    await file.writeAsBytes(bytes);
    final attachment = ChatAttachment(path: file.path, name: 'pixel.png');
    expect(await transport.send('image', attachments: [attachment]).toList(), [
      'reply:image',
    ]);
    final params = fixture.requests('session/prompt').single['params'] as Map;
    expect((params['contentBlocks'] as List)[1], {
      'type': 'image',
      'data': base64Encode(bytes),
      'mimeType': 'image/png',
      'name': 'pixel.png',
    });
    await expectLater(
      transport.send(
        'mixed',
        attachments: [
          attachment,
          ChatAttachment(
            path: '${fixture.home.path}/missing.jpg',
            name: 'missing.jpg',
          ),
        ],
      ),
      emitsInOrder([emitsError(stateError('missing.jpg')), emitsDone]),
    );
    expect(fixture.requests('session/prompt'), hasLength(1));
  });

  test('环境同时隔离 HOME 日志、DSH_HOME、PATH 和启动参数', () async {
    final transport = fixture.transport(
      dshHome: '${fixture.home.path}/custom-kernel',
    );
    await transport.connect();
    final start = fixture.records.singleWhere(
      (record) => record['event'] == 'start',
    );
    expect(start['home'], fixture.home.path);
    expect(start['dshHome'], '${fixture.home.path}/custom-kernel');
    expect(start['marker'], 'isolated');
    expect(start['args'], ['--fixture-argument', '--profile', 'ondra']);
    final separator = Platform.isWindows ? ';' : ':';
    expect(
      (start['path'] as String).split(separator).first,
      File(node).parent.path,
    );
    expect(
      await File('${fixture.home.path}/.ondra/logs/transport.log')
          .readAsString(),
      contains('initialize ok'),
    );
    expect(transport.lastError, isNull, reason: 'Node 警告不能冒充失败');
  });
}

class _Fixture {
  _Fixture(this.home, this.node);

  final Directory home;
  final String node;
  StdioDshTransport? _transport;

  StdioDshTransport transport({
    String scenario = '',
    int exitDelayMs = 0,
    String? dshHome,
    Duration requestTimeout = const Duration(seconds: 3),
    Duration turnTimeout = const Duration(seconds: 3),
  }) {
    final kernelHome = dshHome ?? '${home.path}/.ondra/dsh';
    // 预建隔离 profile，fixture 不加载真实内核或触发种子复制的权限操作。
    Directory('$kernelHome/profiles/ondra').createSync(recursive: true);
    return _transport = StdioDshTransport(
      binary: node,
      binaryArgs: [
        File('test/support/stdio_protocol_fixture.mjs').absolute.path,
        '--fixture-argument',
      ],
      environment: {
        'HOME': home.path,
        'USERPROFILE': home.path,
        'PATH': Platform.environment['PATH'] ?? '',
        if (Platform.environment['SystemRoot'] case final String root)
          'SystemRoot': root,
        'ONDRA_DSH_HOME': ?dshHome,
        'FIXTURE_HOME': home.path,
        'FIXTURE_SCENARIO': scenario,
        'FIXTURE_MARKER': 'isolated',
        'FIXTURE_EXIT_DELAY_MS': '$exitDelayMs',
      },
      requestTimeout: requestTimeout,
      turnTimeout: turnTimeout,
    );
  }

  List<Map<String, dynamic>> get records {
    final file = File('${home.path}/protocol.jsonl');
    if (!file.existsSync()) return [];
    return file
        .readAsLinesSync()
        .where((line) => line.isNotEmpty)
        .map((line) => jsonDecode(line) as Map<String, dynamic>)
        .toList();
  }

  List<Map<String, dynamic>> requests(String method) => records
      .where(
        (record) => record['event'] == 'request' && record['method'] == method,
      )
      .toList();

  Future<void> waitForRequest(String method) =>
      waitFor(() => requests(method).isNotEmpty);

  Future<void> waitFor(bool Function() predicate) async {
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (!predicate()) {
      if (DateTime.now().isAfter(deadline)) {
        throw TimeoutException('fixture protocol event not received');
      }
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  void expectRetiredBeforeRestart() {
    final trace = records;
    int? previous;
    for (var i = 0; i < trace.length; i++) {
      if (trace[i]['event'] != 'start') continue;
      if (previous != null) {
        expect(
          trace
              .take(i)
              .any(
                (record) =>
                    record['event'] == 'exit' && record['pid'] == previous,
              ),
          isTrue,
        );
      }
      previous = trace[i]['pid'] as int;
    }
  }

  Future<void> dispose() async {
    _transport?.stop();
    await waitFor(() {
      final trace = records;
      final started = trace
          .where((record) => record['event'] == 'start')
          .map((record) => record['pid'])
          .toSet();
      final exited = trace
          .where((record) => record['event'] == 'exit')
          .map((record) => record['pid'])
          .toSet();
      return started.difference(exited).isEmpty;
    });
    await home.delete(recursive: true);
  }
}
