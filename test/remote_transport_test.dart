import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/remote_transport.dart';

void main() {
  test(
    'R3 auth, session, follow, prompt, race and cancel use real endpoints',
    () async {
      final overrides = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = overrides);
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final methods = <String>[];
      WebSocket? socket;
      var streamId = '';
      final gotPrompt = Completer<void>();
      final gotCancel = Completer<void>();
      addTearDown(() => socket?.close());

      void event(String type, {Map<String, dynamic> data = const {}}) {
        socket?.add(
          jsonEncode({
            'type': 'item',
            'streamId': streamId,
            'value': {
              'type': 'event',
              'event': {'type': type, 'data': data},
            },
          }),
        );
      }

      server.listen((request) async {
        if (request.uri.path == '/') {
          expect(request.uri.queryParameters['token'], 'launch-secret');
          request.response
            ..statusCode = HttpStatus.seeOther
            ..headers.add(
              HttpHeaders.setCookieHeader,
              'dsh-auth-session=signed; Path=/',
            )
            ..headers.set(HttpHeaders.locationHeader, '/?ok=1');
          await request.response.close();
          return;
        }

        if (request.uri.path == '/api/remote.mux') {
          expect(
            request.headers.value(HttpHeaders.cookieHeader),
            contains('dsh-auth-session=signed'),
          );
          socket = await WebSocketTransformer.upgrade(request);
          socket!.listen((raw) {
            final frame = jsonDecode('$raw') as Map<String, dynamic>;
            if (frame['type'] == 'open') {
              streamId = '${frame['streamId']}';
              socket!.add(
                jsonEncode({
                  'type': 'item',
                  'streamId': streamId,
                  'value': {'type': 'snapshot'},
                }),
              );
            }
          });
          return;
        }

        final method = request.uri.path.replaceFirst('/api/', '');
        final body = jsonDecode(
          await utf8.decoder.bind(request).join(),
        ) as Map<String, dynamic>;
        methods.add(method);
        expect(body['type'], 'client-request');
        expect(body['payload']['args']['request'], isA<Map<String, dynamic>>());
        final rpcId = '${body['rpcId']}';

        Future<void> reply(Object value) async {
          request.response.headers.contentType = ContentType.json;
          request.response.write(
            jsonEncode({
              'type': 'server-response',
              'rpcId': rpcId,
              'result': {'ok': true, 'value': value},
            }),
          );
          await request.response.close();
        }

        switch (method) {
          case 'session/create':
            await reply({'sessionId': 'session-1'});
          case 'session/selectModel':
            expect(body['payload']['args']['request'], {
              'sessionId': 'session-1',
              'provider': 'local-qwen',
              'model': 'qwen3-coder-next',
            });
            await reply({});
          case 'session/prompt':
            final prompt = body['payload']['args']['request'] as Map;
            expect(prompt['sessionId'], 'session-1');
            expect(prompt['content'], [
              {'type': 'text', 'text': '你好'},
            ]);
            // 正文可能在 prompt 的 HTTP 响应之前到达。传输层必须仍能收下。
            event(
              'assistant/message',
              data: {
                'message': {
                  'role': 'assistant',
                  'content': [
                    {'type': 'text', 'text': '你好，我在。'},
                    {'type': 'reasoning', 'text': '不应显示'},
                  ],
                },
              },
            );
            event(
              'turn/end',
              data: {
                'reason': {'kind': 'completed'},
              },
            );
            await reply({'accepted': true});
            if (!gotPrompt.isCompleted) gotPrompt.complete();
          case 'session/cancel':
            await reply({'accepted': true});
            if (!gotCancel.isCompleted) gotCancel.complete();
          default:
            expect(method, isNot('unknown'));
            await reply({});
        }
      });

      final transport = RemoteDshTransport(
        baseUrl: 'http://127.0.0.1:${server.port}',
        launchToken: 'launch-secret',
        provider: 'local-qwen',
        model: 'qwen3-coder-next',
        workingDirectory: '/tmp',
        requestTimeout: const Duration(seconds: 3),
        turnTimeout: const Duration(seconds: 3),
      );
      addTearDown(transport.close);

      await transport.connect();
      expect(transport.isConnected, isTrue);
      expect(transport.sessionId, 'session-1');
      final text = await transport.send('你好').join();
      expect(text, '你好，我在。');
      await gotPrompt.future.timeout(const Duration(seconds: 2));
      expect(
        methods,
        containsAllInOrder([
          'session/create',
          'session/selectModel',
          'session/prompt',
        ]),
      );

      transport.stop();
      await gotCancel.future.timeout(const Duration(seconds: 2));
      expect(methods, contains('session/cancel'));
    },
  );

  test('R3 reports a missing token without opening a connection', () async {
    // 构造函数持有运行时 HttpClient，不能是 const；lint 在这里误报。
    // ignore: prefer_const_constructors
    final transport = RemoteDshTransport(
      baseUrl: 'http://127.0.0.1:9',
      launchToken: '',
      requestTimeout: const Duration(milliseconds: 100),
    );
    addTearDown(transport.close);
    await expectLater(
      transport.connect(),
      throwsA(
        isA<StateError>().having(
          (error) => error.message,
          'message',
          contains('launch token'),
        ),
      ),
    );
  });
}
