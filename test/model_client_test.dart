import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/keychain.dart';
import 'package:ondra/app/notifier_io.dart';
import 'package:ondra/app/prefs.dart';
import 'package:ondra/main.dart' show ModelRuntimeBinding;
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/runtime_model_config.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/runtime_model_config_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_types.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/probe_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/profile_config_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_client.dart';

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

  test('密钥引用名就是 apiKeyEnv，与内核解析用的名字同源', () async {
    // 内核侧 llm-pi-ai 按 provider.apiKeyEnv 去 credentials.resolve(ref) 找密钥，
    // 官方 provider 只接受 POSIX 标识符。若壳用 provider.<id>.key 存，
    // 两个后果同时成立：官方解析器整份拒收 + 内核按另一个名字永远读不到。
    final written = <String, String>{};
    final keyed = ModelClient(
      storePath: '${home.path}/refs/models.json',
      secretResolver: (ref) async => written[ref],
      secretWriter: (ref, key) async {
        written[ref] = key;
        return const KeychainSecret(ok: true, message: 'ok');
      },
    );
    try {
      final deepseek = keyed.byId('deepseek')!;
      expect(deepseek.apiKeyEnv, 'DEEPSEEK_API_KEY');
      expect(ModelClient.credentialRefOf(deepseek), 'DEEPSEEK_API_KEY');

      await keyed.writeProviderKey('deepseek', 'sk-x');
      expect(written.keys, contains('DEEPSEEK_API_KEY'));
      expect(written.keys, isNot(contains('provider.deepseek.key')));
      expect(
        RegExp(r'^[A-Za-z_][A-Za-z0-9_]*$').hasMatch(written.keys.first),
        isTrue,
      );
      expect(await keyed.readProviderSecret('deepseek'), 'sk-x');
    } finally {
      keyed.dispose();
    }
  });

  test('apiKeyEnv 为空的提供商按同一条兜底规则生成引用名', () {
    final p = OndraProvider(
      id: 'my-free-model',
      name: 'f',
      category: ProviderCategory.free,
      baseUrl: 'https://example.com/v1',
      models: [OndraModelEntry(id: 'm')],
    );
    expect(
      ModelClient.credentialRefOf(p),
      'ONDRA_UI_MY_FREE_MODEL_API_KEY',
    );
  });

  test('旧密钥只在旧存储中时，读一次后迁到新引用并清掉旧键', () async {
    // 这里同时守住两个真实故障：老用户升级后密钥突然失效；以及把含点号的
    // provider.<id>.key 写回官方 .credentials.yaml 导致整份文件被拒。
    final legacy = ModelClient.legacyKeyName('deepseek');
    final written = <String, String>{};
    final erased = <String>[];
    final keyed = ModelClient(
      storePath: '${home.path}/migration/models.json',
      secretResolver: (ref) async => written[ref],
      secretWriter: (ref, key) async {
        written[ref] = key;
        return const KeychainSecret(ok: true, message: 'ok');
      },
    );
    final originalReadLegacy = Keychain.readLegacyProbe;
    final originalErase = Keychain.eraseProbe;
    Keychain.readLegacyProbe = (key) async => key == legacy ? 'sk-old' : null;
    Keychain.eraseProbe = (key) async {
      erased.add(key);
      return true;
    };
    try {
      expect(await keyed.readProviderSecret('deepseek'), 'sk-old');
      expect(written['DEEPSEEK_API_KEY'], 'sk-old');
      expect(erased, contains(legacy));
      expect(written.keys, isNot(contains(legacy)));
      expect(await keyed.readProviderSecret('deepseek'), 'sk-old');
      expect(erased.where((k) => k == legacy).length, 1);
    } finally {
      keyed.dispose();
      Keychain.readLegacyProbe = originalReadLegacy;
      Keychain.eraseProbe = originalErase;
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

  test('重连成功后消解「待内核重载」标记，失败则保留', () async {
    // 这条守的是一个真实的死结：写入配置时标 restartRequired，而消解它的
    // 唯一入口是 markKernelApplied。如果装配层不在重连时调用它，设置页那句
    // 「有配置待内核重载」就永久挂着——每改一次多积一条，用户永远清不掉。
    final enabled = <bool>[];
    final transports = <_BindingTransport>[];
    final chat = ChatClient();
    // 装配层操作的是全局单例，另建一个实例不会与它共享标记。
    final settings = settingsClient;
    debugProfileConfigFileOverride =
        '${home.path}/profiles/ondra/cordis.patch.yml';
    File(debugProfileConfigFileOverride!)
      ..createSync(recursive: true)
      ..writeAsStringSync(
        '- insert:\n    - id: ondra-tts\n      name: plugin-tts\n',
      );
    setPrefHome(home.path);
    settings.load();

    final binding = ModelRuntimeBinding(
      models: client,
      chat: chat,
      createTransport: (previous) {
        final next = _BindingTransport(previous, failOpen: enabled.removeAt(0));
        transports.add(next);
        return next;
      },
    );
    final oldNotifier = Notifier.debugOperatingSystemOverride;
    Notifier.debugOperatingSystemOverride = 'test';
    try {
      // 第一次连上：把配置写进装配层，标记应当出现。
      enabled.add(false);
      await binding.start();
      expect(await settings.set('voice.tts', true), isTrue);
      expect(settings.restartRequiredKeys, contains('voice.tts'));

      // 一次失败的重连不能把标记误清掉。
      enabled.add(true);
      client.updateProviderAddress('magpie', 'http://localhost:9911/v1');
      await _settle(transports);
      expect(chat.connected, isFalse);
      expect(settings.restartRequiredKeys, contains('voice.tts'));

      // 成功的重连才算内核真的读了这份配置。
      enabled.add(false);
      client.updateProviderAddress('magpie', 'http://localhost:9912/v1');
      await _settle(transports);
      expect(chat.connected, isTrue);
      expect(settings.restartRequired, isFalse);
    } finally {
      for (final t in transports) {
        if (!t.closeGate.isCompleted) t.closeGate.complete();
      }
      await binding.dispose();
      chat.dispose();
      // 单例不能 dispose：同一进程里后面的测试还要用它。
      settings.reloadFromDisk();
      Notifier.debugOperatingSystemOverride = oldNotifier;
      debugProfileConfigFileOverride = null;
      setPrefHome(null);
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

/// 让装配层的重连有机会跑完：它要等旧进程关闭、再开新进程，
/// 全部走微任务与 Future，单帧 `Duration.zero` 不够。
Future<void> _settle(List<_BindingTransport> transports) async {
  for (var i = 0; i < 8; i++) {
    await Future<void>.delayed(Duration.zero);
    for (final t in transports) {
      if (t.closeStarted && !t.closeGate.isCompleted) t.closeGate.complete();
    }
  }
}

class _BindingTransport extends StdioDshTransport {
  _BindingTransport(this.previous, {this.failOpen = false});
  final Future<void>? previous;

  /// `true` 时 `connect()` 抛错，用来模拟「内核没起来」。
  final bool failOpen;
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
    if (failOpen) throw StateError('内核启动失败');
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
