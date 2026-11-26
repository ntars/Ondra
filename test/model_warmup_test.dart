import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/model_warmup_controller.dart';
import 'package:ondra/app/model_warmup_transport_io.dart';

void main() {
  test('预热启动立即返回，后台完成后状态才变为 ready', () async {
    final gate = Completer<ModelWarmupResult>();
    final requests = <ModelWarmupRequest>[];
    final controller = ModelWarmupController(
      run: (request) {
        requests.add(request);
        return gate.future;
      },
    );
    const request = ModelWarmupRequest(
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'qwen3-coder-next',
    );

    await controller.start(request);
    // start 的 Future 已返回，但真实生成仍挂在 gate 上——这正是“不阻塞首帧”。
    expect(requests, hasLength(1));
    expect(controller.phase, ModelWarmupPhase.warming);

    gate.complete(const ModelWarmupResult(Duration(milliseconds: 31)));
    await Future<void>.delayed(Duration.zero);
    expect(controller.phase, ModelWarmupPhase.ready);
    expect(controller.duration, const Duration(milliseconds: 31));
  });

  test('同端点同模型去重，换模型后才重新预热', () async {
    var calls = 0;
    final controller = ModelWarmupController(
      run: (request) async {
        calls += 1;
        return const ModelWarmupResult(Duration(milliseconds: 1));
      },
    );
    const one = ModelWarmupRequest(
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'qwen3-coder-next',
    );
    const two = ModelWarmupRequest(
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'another-model',
    );

    await controller.start(one);
    await controller.start(one);
    await Future<void>.delayed(Duration.zero);
    expect(calls, 1);

    await controller.start(two);
    await Future<void>.delayed(Duration.zero);
    expect(calls, 2);
  });

  test('预热失败不改写内核状态，只暴露可解释的失败原因', () async {
    final controller = ModelWarmupController(
      run: (request) async => throw StateError('模型未加载'),
    );
    await controller.start(
      const ModelWarmupRequest(
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'missing',
      ),
    );
    await Future<void>.delayed(Duration.zero);
    expect(controller.phase, ModelWarmupPhase.failed);
    expect(controller.error, contains('模型未加载'));
  });

  test('真实预热按 /models 校验后只请求一个输出 token', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    Map<String, dynamic>? completion;
    server.listen((request) async {
      if (request.uri.path == '/v1/models') {
        request.response.headers.contentType = ContentType.json;
        request.response.write(
          jsonEncode({
            'data': [
              {'id': 'qwen3-coder-next'},
            ],
          }),
        );
        await request.response.close();
        return;
      }
      if (request.uri.path == '/v1/chat/completions') {
        completion = jsonDecode(
          await utf8.decoder.bind(request).join(),
        ) as Map<String, dynamic>;
        request.response.headers.contentType = ContentType.json;
        request.response.write(jsonEncode({'choices': <Object>[]}));
        await request.response.close();
        return;
      }
      request.response.statusCode = 404;
      await request.response.close();
    });
    try {
      final result = await warmupOpenAiCompatibleModel(
        ModelWarmupRequest(
          baseUrl: 'http://127.0.0.1:${server.port}/v1',
          model: 'qwen3-coder-next',
        ),
      );
      expect(result.duration.inMicroseconds, greaterThanOrEqualTo(0));
      expect(completion, isNotNull);
      expect(completion!['model'], 'qwen3-coder-next');
      expect(completion!['max_tokens'], 1);
      expect(completion!['stream'], isFalse);
    } finally {
      await server.close(force: true);
    }
  });
}
