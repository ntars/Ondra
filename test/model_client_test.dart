import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/keychain.dart';
import 'package:ondra/app/notifier_io.dart';
import 'package:ondra/main.dart' show ModelRuntimeBinding;
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/runtime_model_config.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/runtime_model_config_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_types.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/probe_io.dart';

void main() {
  late Directory home;
  late ModelClient client;
  late Future<bool> Function(String) originalProbe;

  setUp(() async {
    home = await Directory.systemTemp.createTemp('ondra-models-');
    client = ModelClient(storePath: '${home.path}/config/models.json');
    originalProbe = Keychain.existsProbe;
    Keychain.existsProbe = (_) async => false;
  });
  tearDown(() async {
    client.dispose();
    Keychain.existsProbe = originalProbe;
    await home.delete(recursive: true);
  });

  test('所有兼容类别使用独立路由，空地址或无效模型不能设默认', () {
    for (final category in ProviderCategory.values) {
      final p = OndraProvider(
        id: 'test-${category.name}',
        name: category.name,
        category: category,
        baseUrl: 'http://localhost:9999/v1',
        models: [OndraModelEntry(id: 'fixture')],
      );
      expect(client.addProvider(p), isNull);
      expect(client.kernelRouteOf(p), 'ondra-ui-test-${category.name}');
      expect(client.setDefaultModel(p, p.models.single), isNull);
    }
    final pending = OndraProvider(
      id: 'pending',
      name: 'pending',
      category: ProviderCategory.partner,
      models: [OndraModelEntry(id: 'fixture')],
    );
    expect(client.addProvider(pending), isNull);
    expect(client.kernelRouteOf(pending), isNull);
    expect(
      client.setDefaultModel(pending, pending.models.single),
      contains('地址'),
    );
    expect(
      client.setDefaultModel(
        client.providers.first,
        OndraModelEntry(id: 'unknown'),
      ),
      isNotNull,
    );
  });

  test('运行时快照安全映射容量、协议、输入与推理，后续编辑不污染快照', () {
    final p = client.byId('magpie')!;
    final m = p.models.first;
    client.updateModel(
      p.id,
      m,
      maxTokens: '1.5K',
      contextWindow: '1M',
      inputs: ['text', 'image'],
      reasoning: [const OndraReasoningLevel(label: '高', apiValue: 'enabled')],
    );
    final config = client.currentRuntimeConfig();
    final model = (config.profile['models'] as List).single as Map;
    expect(model['maxTokens'], 1536);
    expect(model['contextWindow'], 1048576);
    expect(model['input'], ['text', 'image']);
    expect(model['reasoningEfforts'], {'high': 'enabled'});
    expect(config.profile['reasoning'], 'high');
    expect(client.updateModel(p.id, m, maxTokens: '0.1'), isNotNull);
    expect(client.updateModel(p.id, m, inputs: ['audio']), isNotNull);
    expect(
      client.updateModel(
        p.id,
        m,
        reasoning: [const OndraReasoningLevel(label: 'bad', apiValue: 'bad')],
      ),
      isNotNull,
    );
    expect(client.updateProviderProtocol(p.id, 'openai-responses'), isNull);
    expect(client.currentRuntimeConfig().profile['api'], 'openai-responses');
    expect(config.profile['api'], 'openai-completions');
    expect(client.updateProviderProtocol(p.id, 'anthropic-messages'), isNull);
    final loaded = ModelClient(storePath: '${home.path}/config/models.json')
      ..load();
    expect(loaded.currentRuntimeConfig().profile['api'], 'anthropic-messages');
    loaded.dispose();
  });

  test('secret resolver 优先于环境；仅 loopback 可无密钥，远端本地类别也拒绝', () async {
    final p = client.byId('magpie')!;
    var config = client.currentRuntimeConfig();
    expect(
      (await config.resolveEnvironment({
        'MAGPIE_API_KEY': 'environment',
      }, (_) async => 'keychain'))['MAGPIE_API_KEY'],
      'keychain',
    );
    expect(
      (await config.resolveEnvironment({
        'MAGPIE_API_KEY': 'environment',
      }, (_) async => null))['MAGPIE_API_KEY'],
      'environment',
    );
    expect(
      (await config.resolveEnvironment(
        {},
        (_) async => null,
      ))['MAGPIE_API_KEY'],
      'ondra-local-loopback',
    );
    p.baseUrl = 'https://remote.example.test/v1';
    p.category = ProviderCategory.local;
    config = client.currentRuntimeConfig();
    await expectLater(
      config.resolveEnvironment({}, (_) async => null),
      throwsStateError,
    );
    for (final host in [
      '127.0.0.1.evil.test',
      'localhost.evil.test',
      '192.168.0.1',
    ]) {
      expect(RuntimeModelConfig.isLoopbackHost(host), isFalse);
    }
  });

  test('替换已配置密钥仍通知并改变运行指纹；密钥从不持久化', () async {
    final keys = <String, String>{};
    final keyed = ModelClient(
      storePath: '${home.path}/keys/models.json',
      secretResolver: (id) async => keys[id],
      secretWriter: (id, key) async {
        keys[id] = key;
        return const KeychainSecret(ok: true, message: 'ok');
      },
    );
    try {
      var notifications = 0;
      keyed.addListener(() => notifications++);
      await keyed.writeProviderKey('magpie', 'first-secret');
      final first = keyed.runtimeFingerprint;
      await keyed.writeProviderKey('magpie', 'replacement-secret');
      expect(keyed.runtimeFingerprint, isNot(first));
      expect(notifications, 2);
      expect(await keyed.readProviderSecret('magpie'), 'replacement-secret');
      final saved = File('${home.path}/keys/models.json').readAsStringSync();
      expect(saved, isNot(contains('secret')));
      expect(keyed.runtimeFingerprint, isNot(contains('secret')));
    } finally {
      keyed.dispose();
    }
  });

  test('受管段保留其它字节和禁用项、复用 pi-ai 实例、安全编码并幂等替换', () async {
    final dir = Directory('${home.path}/dsh/profiles/ondra')
      ..createSync(recursive: true);
    final file = File('${dir.path}/cordis.patch.yml');
    const original =
        '# preserve user comments\r\n- insert:\r\n    - id: custom-adapter\r\n      name: "@deepseek-ai/dsh-llm-pi-ai"\r\n      disabled: true\r\n      config:\r\n        providers: {}\r\n    - id: ondra-llm-gateway\r\n      name: "@ondra/cordis-plugin-ondra-llm-gateway"\r\n      disabled: true\r\n      config:\r\n        maxAttempts: 1\r\n        sources: []\r\n';
    file.writeAsStringSync(original);
    final p = client.byId('magpie')!;
    p.name = 'quote"\n- insert: # not YAML';
    final config = client.currentRuntimeConfig();
    Future<void> write() => writeRuntimeModelPatch(
      dshHome: '${home.path}/dsh',
      model: config,
      environment: {'HOME': home.path, 'PATH': '/usr/bin:/bin'},
    );
    await write();
    final first = file.readAsStringSync();
    expect(first.startsWith(original), isTrue);
    expect(first, contains('"id":"custom-adapter"'));
    expect(first, contains('"maxAttempts":1'));
    expect(first, contains('"provider":"ondra-ui-magpie"'));
    expect(first, contains(r'quote\"\n- insert: # not YAML'));
    expect(first.substring(original.length), isNot(contains('"disabled"')));
    await write();
    expect(file.readAsStringSync(), first);
    file.writeAsStringSync('$first# appended user comment\r\n');
    await write();
    expect(
      file.readAsStringSync().endsWith('# appended user comment\r\n'),
      isTrue,
    );
  });

  test('损坏/重复 marker 与坏 YAML 拒绝，原文件不变', () async {
    final dir = Directory('${home.path}/dsh/profiles/ondra')
      ..createSync(recursive: true);
    final file = File('${dir.path}/cordis.patch.yml');
    for (final bad in [
      '$runtimeModelBegin\n- insert: []\n',
      '$runtimeModelEnd\n$runtimeModelBegin\n',
      '$runtimeModelBegin\n$runtimeModelEnd\n$runtimeModelEnd\n',
      '# BEGIN ONDRA APP-MANAGED MODEL v2\n$runtimeModelEnd\n',
      '  $runtimeModelBegin\n$runtimeModelEnd\n',
      '- insert: [broken\n',
    ]) {
      file.writeAsStringSync(bad);
      await expectLater(
        writeRuntimeModelPatch(
          dshHome: '${home.path}/dsh',
          model: client.currentRuntimeConfig(),
          environment: {'HOME': home.path, 'PATH': '/usr/bin:/bin'},
        ),
        throwsA(anything),
      );
      expect(file.readAsStringSync(), bad);
    }
  });

  test('配置保存不中断生成，空闲后真实换传输且等待旧实例关闭', () async {
    final transports = <_BindingTransport>[];
    final chat = ChatClient();
    final binding = ModelRuntimeBinding(
      models: client,
      chat: chat,
      createTransport: (previous) {
        final next = _BindingTransport(previous);
        transports.add(next);
        return next;
      },
    );
    final oldNotifier = Notifier.debugOperatingSystemOverride;
    Notifier.debugOperatingSystemOverride = 'test';
    try {
      await binding.start();
      final old = transports.single;
      final reply = chat.send('ongoing');
      final before = old.stops;
      client.updateProviderAddress('magpie', 'http://localhost:8765/v1');
      await Future<void>.delayed(Duration.zero);
      expect(client.runtimePending, isTrue);
      expect(chat.busy, isTrue);
      expect(old.stops, before);
      old.output.add('done');
      await old.output.close();
      await reply;
      await Future<void>.delayed(Duration.zero);
      expect(transports, hasLength(2));
      expect(old.closeStarted, isTrue);
      expect(transports.last.opened, isFalse);
      old.closeGate.complete();
      await Future<void>.delayed(Duration.zero);
      expect(transports.last.opened, isTrue);
      expect(client.runtimePending, isFalse);
      // 仅内部运行状态变化不重启。
      client.touch();
      await Future<void>.delayed(Duration.zero);
      expect(transports, hasLength(2));
      final p = client.byId('deepseek')!;
      client.setDefaultModel(p, p.models.first);
      await Future<void>.delayed(Duration.zero);
      expect(transports, hasLength(3));
      transports[1].closeGate.complete();
      await Future<void>.delayed(Duration.zero);
      expect(transports.last.opened, isTrue);
    } finally {
      for (final t in transports) {
        if (!t.closeGate.isCompleted) t.closeGate.complete();
      }
      await binding.dispose();
      chat.dispose();
      Notifier.debugOperatingSystemOverride = oldNotifier;
    }
  });

  test('所有模型编辑持久化并通知，重启后仍保留', () async {
    var updates = 0;
    client.addListener(() => updates++);
    final p = client.byId('magpie')!;
    final m = p.models.first;
    expect(
      client.updateProviderAddress(p.id, 'http://127.0.0.1:9090/v1'),
      isNull,
    );
    expect(
      client.updateModel(
        p.id,
        m,
        id: 'custom/model',
        name: '自建',
        contextWindow: '256K',
        maxTokens: '16K',
        inputs: ['text', 'image'],
        reasoning: [OndraReasoningLevel.high],
      ),
      isNull,
    );
    expect(updates, 2);
    expect(client.defaultModelId, 'custom/model');
    final reloaded = ModelClient(storePath: '${home.path}/config/models.json')
      ..load();
    await Future<void>.delayed(Duration.zero);
    final saved = reloaded.byId('magpie')!;
    expect(saved.baseUrl, p.baseUrl);
    expect(saved.models.first.name, '自建');
    expect(saved.models.first.maxTokens, '16K');
    expect(saved.models.first.contextWindow, '256K');
    expect(saved.models.first.acceptsImage, isTrue);
    expect(saved.models.first.reasoning.single.apiValue, 'high');
    expect(reloaded.defaultModelId, 'custom/model');
    expect(
      File('${home.path}/config/models.json').readAsStringSync(),
      isNot(contains('keyConfigured')),
    );
    reloaded.dispose();
  });

  test('新增模型必须提供非空不重复 ID，非法容量不覆盖现值', () {
    final p = client.byId('magpie')!;
    final m = p.models.first;
    expect(client.addModel(p.id, id: ''), isNotNull);
    expect(client.addModel(p.id, id: m.id), isNotNull);
    expect(client.addModel(p.id, id: 'new-model'), isNull);
    expect(client.updateModel(p.id, m, id: 'new-model'), isNotNull);
    expect(client.updateModel(p.id, m, maxTokens: '0'), isNotNull);
    expect(client.updateModel(p.id, m, contextWindow: '-1'), isNotNull);
    expect(m.id, 'group/ntars');
    expect(m.maxTokens, '8K');
    expect(p.models.length, 2);
  });

  test('地址校验拒绝非 HTTP 及明文 URL 凭据', () {
    for (final address in [
      'file:///etc/passwd',
      'https://secret:token@example.test/v1',
      'https://example.test/v1?key=secret',
      'http://',
    ]) {
      expect(client.updateProviderAddress('magpie', address), isNotNull);
    }
    expect(client.byId('magpie')!.baseUrl, 'http://127.0.0.1:3425/v1');
  });

  test('保存失败可见而不是宣称已落盘', () {
    File('${home.path}/blocked').writeAsStringSync('not a directory');
    final blocked = ModelClient(storePath: '${home.path}/blocked/models.json');
    expect(
      blocked.updateProviderAddress('magpie', 'http://localhost:8888/v1'),
      contains('未保存'),
    );
    expect(blocked.persistenceError, isNotNull);
    blocked.dispose();
  });

  test('连接检测携带凭据并按协议返回真实模型目录', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final requests = <Map<String, String?>>[];
    server.listen((request) async {
      requests.add({
        'path': request.uri.path,
        'authorization': request.headers.value('authorization'),
        'key': request.headers.value('x-api-key'),
        'version': request.headers.value('anthropic-version'),
      });
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'data': [
            {'id': 'fixture-model'},
          ],
        }),
      );
      await request.response.close();
    });
    try {
      final base = 'http://127.0.0.1:${server.port}/v1';
      expect((await probeOpenAiEndpoint(base, apiKey: 'test-key')).models, [
        'fixture-model',
      ]);
      expect(
        (await probeOpenAiEndpoint(
          base,
          apiKey: 'test-anthropic',
          protocol: 'anthropic-messages',
        )).ok,
        isTrue,
      );
      expect(requests[0]['path'], '/v1/models');
      expect(requests[0]['authorization'], 'Bearer test-key');
      expect(requests[1]['authorization'], isNull);
      expect(requests[1]['key'], 'test-anthropic');
      expect(requests[1]['version'], '2023-06-01');
    } finally {
      await server.close(force: true);
    }
  });

  test('连接检测不跟随重定向泄露凭据，HTTP错误不算成功', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    var requests = 0;
    server.listen((request) async {
      requests++;
      request.response.statusCode = HttpStatus.temporaryRedirect;
      request.response.headers.set('location', '/other');
      await request.response.close();
    });
    try {
      final result = await probeOpenAiEndpoint(
        'http://127.0.0.1:${server.port}',
        apiKey: 'test-key',
      );
      expect(result.ok, isFalse);
      expect(result.error, 'HTTP 307');
      expect(requests, 1);
    } finally {
      await server.close(force: true);
    }
  });
}

class _BindingTransport extends StdioDshTransport {
  _BindingTransport(this.previous);
  final Future<void>? previous;
  final closeGate = Completer<void>();
  final output = StreamController<String>();
  bool opened = false;
  bool closeStarted = false;
  int stops = 0;

  @override
  Stream<StepUsage> get usage => const Stream.empty();
  @override
  Future<void> connect() async {
    await previous;
    opened = true;
  }

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) => output.stream;
  @override
  void stop() {
    stops++;
  }

  @override
  Future<void> close() async {
    closeStarted = true;
    await closeGate.future;
  }
}
