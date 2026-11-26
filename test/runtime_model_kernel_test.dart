@Timeout(Duration(minutes: 4))
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/bundled_runtime.dart';
import 'package:ondra/app/runtime_seed.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_types.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/runtime_model_config.dart';

/// 真正启动 bundled DSH，只有 HTTP 模型端是假服务。绝不使用真实 HOME/钥匙串。
void main() {
  for (final category in [
    ProviderCategory.custom,
    ProviderCategory.local,
    ProviderCategory.official,
  ]) {
    test('真实 DSH ${category.name}: HTTP映射、usage、持久化、第二轮及 stop-resume', () async {
      expect(ondraBundledRuntime, isNotNull, reason: '本测试要求已经装配的 bundled DSH');
      final home = await Directory.systemTemp.createTemp('ondra-kernel-model-');
      // 本测试守的是「模型路由映射」，不该被对话过滤链的九道规则干扰——
      // fixture 的机械回复本来就会被复读/越线规则正确拦下（那是功能不是 bug）。
      // 先手动铺种子，再往 patch 追加过滤链关闭段：connect 时 seed 见目录
      // 已存在会跳过，受管段按标记拼在文件末尾，两边互不干扰。
      final seed = seedRuntimeProfile(dshHome: '${home.path}/.ondra/dsh');
      expect(
        seed.outcome,
        RuntimeSeedOutcome.seeded,
        reason: '本测试要求已经装配的 bundled DSH',
      );
      File(
        '${home.path}/.ondra/dsh/profiles/ondra/cordis.patch.yml',
      ).writeAsStringSync(
        '${File('${home.path}/.ondra/dsh/profiles/ondra/cordis.patch.yml').readAsStringSync()}'
        '- insert:\n'
        "    - id: ondra-filter-chain\n"
        "      name: '@ondra/cordis-plugin-ondra-filter-chain'\n"
        "      config:\n"
        "        enable: false\n",
      );
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final requests =
          <({String path, String? auth, Map<String, dynamic> body})>[];
      final stalled = Completer<void>();
      final liveResponses = <HttpResponse>[];
      server.listen((request) async {
        final body = jsonDecode(
          await utf8.decoder.bind(request).join(),
        ) as Map<String, dynamic>;
        requests.add((
          path: request.uri.path,
          auth: request.headers.value('authorization'),
          body: body,
        ));
        final messages = body['messages'] as List;
        final userTexts = messages
            .where((m) => m['role'] == 'user')
            .map((m) {
              final content = m['content'];
              return content is String
                  ? content
                  : (content as List)
                        .where((b) => b['type'] == 'text')
                        .map((b) => b['text'])
                        .join();
            })
            .join('\n');
        final text = RegExp(r'(first|second|stall|resume|switch)-turn')
            .allMatches(userTexts)
            .last
            .group(0)!;
        final response = request.response;
        liveResponses.add(response);
        response.headers.contentType = ContentType(
          'text',
          'event-stream',
          charset: 'utf-8',
        );
        response.headers.set('cache-control', 'no-cache');
        void chunk(Map<String, Object?> value) =>
            response.write('data: ${jsonEncode(value)}\n\n');
        final base = {
          'id': 'chatcmpl-fixture',
          'object': 'chat.completion.chunk',
          'created': 1700000000,
          'model': body['model'],
        };
        chunk({
          ...base,
          'choices': [
            {
              'index': 0,
              'delta': {
                'role': 'assistant',
                'content': text.contains('stall-turn')
                    ? 'partial'
                    : '她轻轻应了「$text」，这一轮的回应围绕这个话题展开，细节与此前每一轮都不同。',
              },
              'finish_reason': null,
            },
          ],
        });
        await response.flush();
        if (text.contains('stall-turn')) {
          if (!stalled.isCompleted) stalled.complete();
          return;
        }
        chunk({
          ...base,
          'choices': [
            {'index': 0, 'delta': <String, Object?>{}, 'finish_reason': 'stop'},
          ],
        });
        chunk({
          ...base,
          'choices': <Object>[],
          'usage': {
            'prompt_tokens': 23,
            'completion_tokens': 7,
            'total_tokens': 30,
          },
        });
        response.write('data: [DONE]\n\n');
        await response.close();
        liveResponses.remove(response);
      });
      final entry = OndraModelEntry(
        id: 'fixture-${category.name}',
        name: 'Fixture # 中文',
        contextWindow: '256K',
        maxTokens: '4K',
        inputs: ['text', 'image'],
        reasoning: [OndraReasoningLevel.high],
      );
      final provider = OndraProvider(
        id: category.name,
        name: 'test provider',
        category: category,
        baseUrl: 'http://127.0.0.1:${server.port}/selected/v1',
        apiKeyEnv: 'FIXTURE_API_KEY',
        models: [entry],
      );
      final config = RuntimeModelConfig.from(provider, entry);
      var resolutions = 0;
      final transport = StdioDshTransport(
        environment: {
          'HOME': home.path,
          'PATH': '/usr/bin:/bin',
          'DSH_TELEMETRY': '0',
        },
        workingDirectory: home.path,
        modelConfig: () => config,
        secretResolver: (id) async {
          expect(id, category.name);
          resolutions++;
          return category == ProviderCategory.local
              ? null
              : 'injected-test-secret';
        },
      );
      StdioDshTransport? switched;
      final usage = <StepUsage>[];
      final usageSub = transport.usage.listen(usage.add);
      try {
        expect(
          (await transport.send('first-turn').toList()).join(),
          contains('「first-turn」'),
        );
        expect(
          (await transport.send('second-turn').toList()).join(),
          contains('「second-turn」'),
        );
        expect(usage, hasLength(2));
        expect(usage.first.tokens.outputTokens, 7);
        expect(usage.first.tokens.promptTokens, 23);
        // 内核的对话评审插件会用自己的 prompt 打模型分（它引用助手回复，
        // 所以也含 'second-turn' 字样），不能假设最后一个请求就是主对话。
        // 持久化断言选「含 second-turn 用户消息的主对话请求」：第二轮的
        // messages 里必须还能看到 first-turn，才算上下文没断。
        final second = requests
            .map((r) => r.body['messages'] as List)
            .lastWhere((m) {
              final j = jsonEncode(m);
              // 评审插件的 prompt 也引用助手回复（含 second-turn 字样），
              // 用它的固定开场白排除掉。
              return j.contains('second-turn') && !j.contains('对话回复的评审');
            });
        expect(jsonEncode(second), contains('「first-turn」'));
        final interrupted = expectLater(
          transport.send('stall-turn').toList(),
          throwsStateError,
        );
        await stalled.future.timeout(const Duration(seconds: 20));
        transport.stop();
        await interrupted;
        expect(
          (await transport.send('resume-turn').toList()).join(),
          contains('「resume-turn」'),
        );
        expect(resolutions, 2);
        // stop-resume 后：恢复的会话里必须还留着第二轮的内容。
        // requests.last 可能是评审插件的打分请求（只含 resume-turn），
        // 所以同样排除评审 prompt 再找主对话请求。
        final resumed = requests
            .map((r) => r.body['messages'] as List)
            .lastWhere((m) {
              final j = jsonEncode(m);
              return j.contains('second-turn') && !j.contains('对话回复的评审');
            });
        expect(jsonEncode(resumed), contains('「second-turn」'));
        // 两消息的后台提炼请求是异步发出的：轮询等它出现（最多 10 秒），
        // 避免主流程太快结束时提炼还没发生。
        // 提炼的触发时机由内核的记忆管道决定，不保证在本轮结束前发生：
        // 出现了就验它的路由与预算，没出现不算失败。
        for (var i = 0; i < 20; i++) {
          final hits = requests
              .where((r) => (r.body['messages'] as List).length == 2)
              .toList();
          if (hits.isNotEmpty) break;
          await Future<void>.delayed(const Duration(milliseconds: 500));
        }
        for (final request in requests) {
          expect(request.path, '/selected/v1/chat/completions');
          expect(
            request.auth,
            'Bearer ${category == ProviderCategory.local ? 'ondra-local-loopback' : 'injected-test-secret'}',
          );
          expect(request.body['model'], entry.id);
          final messages = request.body['messages'] as List;
          // 预算分三档：评审插件 200（它也是两条 messages），
          // 后台提炼 1200（同样两条），主对话 4096。按内容区分而不是按条数。
          final isReview = jsonEncode(messages).contains('对话回复的评审');
          expect(
            request.body['max_tokens'] ?? request.body['max_completion_tokens'],
            isReview
                ? 200
                : messages.length == 2
                ? 1200
                : 4096,
          );
          expect(request.body['reasoning_effort'], 'high');
        }
        final patch = File(
          '${home.path}/.ondra/dsh/profiles/ondra/cordis.patch.yml',
        ).readAsStringSync();
        expect(patch, contains('"ondra-ui-${category.name}"'));
        expect(patch, contains('"contextWindow":262144'));
        expect(patch, contains('"input":["text","image"]'));
        expect(patch, contains('"provider":"ondra-ui-${category.name}"'));
        expect(patch, isNot(contains('injected-test-secret')));
        final logs = File('${home.path}/.ondra/logs/transport.log')
            .readAsStringSync();
        expect(logs, isNot(contains('injected-test-secret')));
        // 与 main 一样跨实例换配置：旧实例完全退出才允许新实例 resume 同一会话。
        provider.baseUrl = 'http://127.0.0.1:${server.port}/changed/v1';
        // local 保留模型 ID，覆盖 SDK resume 沿用旧 reasoningEffort 的分支。
        if (category != ProviderCategory.local) {
          entry.id = 'changed-${category.name}';
        }
        entry.maxTokens = '2K';
        entry.reasoning = [];
        final changed = RuntimeModelConfig.from(provider, entry);
        switched = StdioDshTransport(
          environment: {
            'HOME': home.path,
            'PATH': '/usr/bin:/bin',
            'DSH_TELEMETRY': '0',
          },
          workingDirectory: home.path,
          modelConfig: () => changed,
          secretResolver: (_) async => 'replacement-test-secret',
          previousClosed: transport.close(),
          resumeSessionId: transport.sessionId,
        );
        expect(
          (await switched.send('switch-turn').toList()).join(),
          contains('「switch-turn」'),
        );
        final afterSwitch = requests
            .where((r) => r.path == '/changed/v1/chat/completions')
            .toList();
        expect(afterSwitch, isNotEmpty);
        final chatRequest = afterSwitch.firstWhere(
          (r) => (r.body['messages'] as List).length > 2,
        );
        expect(chatRequest.auth, 'Bearer replacement-test-secret');
        expect(chatRequest.body['model'], changed.modelId);
        expect(
          chatRequest.body['max_tokens'] ??
              chatRequest.body['max_completion_tokens'],
          2048,
        );
        expect(chatRequest.body['reasoning_effort'], isNull);
        expect(
          jsonEncode(chatRequest.body['messages']),
          contains('「first-turn」'),
        );
        await switched.close();
        final sessions = Directory('${home.path}/.ondra/dsh/sessions')
            .listSync(recursive: true)
            .whereType<File>()
            .where((file) => file.path.endsWith('.jsonl'))
            .toList();
        expect(sessions, isNotEmpty);
        final history = sessions.map((file) => file.readAsStringSync()).join();
        expect(history, contains('「first-turn」'));
        expect(history, contains('「resume-turn」'));
        expect(history, contains('「switch-turn」'));
        final updatedPatch = File(
          '${home.path}/.ondra/dsh/profiles/ondra/cordis.patch.yml',
        ).readAsStringSync();
        expect(updatedPatch, isNot(contains('"reasoningEfforts"')));
        expect(updatedPatch, isNot(contains('replacement-test-secret')));
      } catch (_) {
        final log = File('${home.path}/.ondra/logs/transport.log');
        if (log.existsSync()) {
          // ignore: avoid_print
          print(log.readAsStringSync());
        }
        rethrow;
      } finally {
        await switched?.close();
        await transport.close();
        await usageSub.cancel();
        for (final response in liveResponses) {
          unawaited(response.close().catchError((_) {}));
        }
        await server.close(force: true);
        await home.delete(recursive: true);
      }
    });
  }
}
