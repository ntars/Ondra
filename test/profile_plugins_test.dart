import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/design/primitives.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-plugins/ui/plugins_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-plugins/ui/plugins_page.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-plugins/ui/profile_plugins.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-plugins/ui/profile_plugins_io.dart'
    show debugProfileFileOverride;
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-plugins/ui/profile_plugins_stub.dart'
    as web;

// 所有写入（含备份/故障注入）只发生在临时目录，绝不修改真实 profile。
const _fixture = '''
# 与实际 profile 相同的 insert / config.providers.models 结构
- insert:
    - id: ondra-identity
      name: '@ondra/cordis-plugin-ondra-identity'
    - id: ondra-clock
      name: '@ondra/cordis-plugin-ondra-clock'
    - id: "optional-route" # 行尾说明
      # name 不必紧跟 id，原注释也不能被去掉
      inject:
        - ondra-clock
      name: '@example/route'
      config:
        providers:
          magpie:
            baseURL: http://127.0.0.1:3425/v1
            models:
              - id: group/ntars
                name: 星玖优选
                options: {temperature: 0.7, stop: ["a", "b"]}
        items:
          - id: not-a-plugin
            name: nested-model
        prompt: |-
          line one: keep # literal
          # literal comment in a scalar
          - id: not-a-plugin-either
            name: text

        # 内部注释不能被误还原成配置
        flags: [true, false]
    # 后一条的说明不应随前一条消失
    - id: consumer
      name: '@example/consumer'
      inject: [optional-route]
    # 手工关闭的条目（实际 profile 的写法）
    # - id: legacy-off
    #   name: '@example/legacy'
    #   inject:
    #     - ondra-clock
    #   config:
    #     # 已有注释
    #     nested:
    #       value: 'keep # text'
- insert:
    - id: plugins-group
      group: true
      config:
        - name: '@example/child'
          id: nested-child
          config:
            models:
              - id: nested-model
                name: not-plugin
        - id: sibling
          name: '@example/sibling'
''';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory tmp;
  late File patch;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('ondra_profile_test_');
    patch = File('${tmp.path}/cordis.patch.yml')..writeAsStringSync(_fixture);
    debugProfileFileOverride = patch.path;
    final package = Directory('${tmp.path}/node_modules/@example/route')
      ..createSync(recursive: true);
    File('${package.path}/package.json')
        .writeAsStringSync('{"version":"2.1.2","description":"真实包简介。后续说明。"}');
  });

  tearDown(() {
    debugProfileFileOverride = null;
    tmp.deleteSync(recursive: true);
  });

  Future<void> success(String id, bool enabled) async {
    final result = await updateProfilePluginEnabled(id, enabled);
    expect(result.ok, isTrue, reason: result.error);
  }

  test('只沿 insert / group:true 条目树读取，不匹配 models 或普通 items', () async {
    final entries = await readProfilePlugins();
    expect(entries.map((e) => e.id), [
      'ondra-identity',
      'ondra-clock',
      'optional-route',
      'consumer',
      'legacy-off',
      'plugins-group',
      'nested-child',
      'sibling',
    ]);
    final route = entries.firstWhere((e) => e.id == 'optional-route');
    expect(route.package, '@example/route');
    expect(route.version, '2.1.2');
    expect(route.desc, '真实包简介。后续说明。');
    expect(route.enabled, isTrue);
    expect(entries.first.version, '-');
    expect(entries.first.blockedReason, isNotNull);
    expect(entries.firstWhere((e) => e.id == 'legacy-off').enabled, isFalse);
    expect(await setProfilePluginEnabled('group/ntars', false), isFalse);
    expect(patch.readAsStringSync(), _fixture);
    expect(File('${patch.path}.bak').existsSync(), isFalse);
  });

  test('完整块启停：注释、inject、嵌套、字面文本、行尾注释逐字节往返', () async {
    await success('consumer', false);
    final before = patch.readAsStringSync();
    await success('optional-route', false);
    final off = patch.readAsStringSync();
    final begin = before.indexOf('    - id: "optional-route"');
    final end = before.indexOf('    # 后一条');
    final block = before.substring(begin, end);
    final expected = block
        .split('\n')
        .where((line) => line.isNotEmpty)
        .map((line) => '# ondra-plugin-off: $line');
    for (final line in expected) {
      expect(off, contains(line));
    }
    expect(off, contains('    # 后一条的说明不应随前一条消失\n'));
    expect(
      (await readProfilePlugins())
          .firstWhere((e) => e.id == 'optional-route')
          .enabled,
      isFalse,
    );
    expect(File('${patch.path}.bak').readAsStringSync(), _fixture);
    await success('optional-route', true);
    expect(patch.readAsStringSync(), before);
    await success('consumer', true);
    expect(patch.readAsStringSync(), _fixture);
  });

  test('保留 CRLF 与无末尾换行，重复启用为无写入幂等操作', () async {
    final source = _fixture.trimRight().replaceAll('\n', '\r\n');
    patch.writeAsStringSync(source);
    await success('consumer', true);
    expect(File('${patch.path}.bak').existsSync(), isFalse);
    await success('consumer', false);
    await success('consumer', true);
    expect(patch.readAsStringSync(), source);
  });

  test('启用旧格式完整注释块，不激活原有人类注释；后续可逆', () async {
    await success('legacy-off', true);
    final active = patch.readAsStringSync();
    expect(
      active,
      contains("    - id: legacy-off\n      name: '@example/legacy'"),
    );
    expect(active, contains('        # 已有注释\n'));
    expect(active, contains("          value: 'keep # text'"));
    await success('legacy-off', false);
    await success('legacy-off', true);
    expect(patch.readAsStringSync(), active);
  });

  test('兼容旧 UI 逐行注释的两行条目', () async {
    patch.writeAsStringSync(
      "- insert:\n    # - id: old\n      # name: '@example/old'\n",
    );
    await success('old', true);
    expect(
      patch.readAsStringSync(),
      "- insert:\n    - id: old\n      name: '@example/old'\n",
    );
  });

  test('嵌套组只改目标子条目，不改兄弟、组或模型配置', () async {
    await success('nested-child', false);
    expect(
      (await readProfilePlugins())
          .firstWhere((e) => e.id == 'nested-child')
          .enabled,
      isFalse,
    );
    expect(
      patch.readAsStringSync(),
      contains("        - id: sibling\n          name: '@example/sibling'"),
    );
    await success('nested-child', true);
    expect(patch.readAsStringSync(), _fixture);
    expect(await setProfilePluginEnabled('plugins-group', false), isFalse);
  });

  test('显式下游依赖拒绝关闭；上游关闭时拒绝先启用下游', () async {
    final blocked = await updateProfilePluginEnabled('optional-route', false);
    expect(blocked.error, contains('consumer'));
    expect(blocked.error, contains('拒绝关闭'));
    expect(patch.readAsStringSync(), _fixture);
    await success('consumer', false);
    await success('optional-route', false);
    final off = patch.readAsStringSync();
    final missing = await updateProfilePluginEnabled('consumer', true);
    expect(missing.error, contains('optional-route'));
    expect(patch.readAsStringSync(), off);
    await success('optional-route', true);
    await success('consumer', true);
    expect(patch.readAsStringSync(), _fixture);
  });

  test('inject 映射与包名服务别名也保护下游（包括 optional）', () async {
    patch.writeAsStringSync('''
- insert:
    - id: clock-alias
      name: '@ondra/cordis-plugin-ondra-clock'
    - id: client
      name: '@example/client'
      inject:
        ondra-clock:
          required: false
''');
    final before = patch.readAsStringSync();
    expect(
      (await updateProfilePluginEnabled('clock-alias', false)).error,
      contains('client'),
    );
    expect(patch.readAsStringSync(), before);
  });

  test('基础依赖按 id 和包名锁定，不允许绕开 UI；内存后端也不可开启', () async {
    const protected = [
      'ondra-identity',
      'ondra-path-layout',
      'ondra-store-sqlite',
      'ondra-store-json',
      'ondra-memory-core',
      'ondra-persona-loader',
      'ondra-persona-core',
      'ondra-persona-assemble',
      'ondra-runtime',
      'ondra-process-host',
      'ondra-boot-settle',
      'ondra-llm-gateway',
    ];
    for (final id in protected) {
      for (final alias in [id, 'alias']) {
        final source =
            "- insert:\n    - id: $alias\n      name: '@ondra/cordis-plugin-$id'\n";
        patch.writeAsStringSync(source);
        final entry = (await readProfilePlugins()).single;
        expect(entry.blockedReason, isNotNull, reason: id);
        expect(
          await setProfilePluginEnabled(alias, false),
          isFalse,
          reason: id,
        );
        expect(patch.readAsStringSync(), source);
      }
    }
    patch.writeAsStringSync(
      "- insert:\n    - id: model-runtime\n      name: '@deepseek-ai/dsh-llm-pi-ai'\n",
    );
    expect(await setProfilePluginEnabled('model-runtime', false), isFalse);
    patch.writeAsStringSync(
      "- insert:\n    # - id: ondra-store-memory\n    #   name: '@ondra/cordis-plugin-ondra-store-memory'\n",
    );
    expect(await setProfilePluginEnabled('ondra-store-memory', true), isFalse);
  });

  test('真实仓库 profile 只复制到隔离目录；不误认模型且复杂条目往返', () async {
    final sourceFile = File(
      '${Directory.current.path}/plugin-profile/cordis.patch.yml',
    );
    final source = sourceFile.readAsStringSync();
    patch.writeAsStringSync(source);
    final entries = await readProfilePlugins();
    expect(entries.any((e) => e.id == 'group/ntars'), isFalse);
    expect(entries.any((e) => e.id == 'magpie-local'), isFalse);
    expect(
      entries.firstWhere((e) => e.id == 'llm-magpie').blockedReason,
      isNotNull,
    );
    expect(
      entries.firstWhere((e) => e.id == 'ondra-store-memory').enabled,
      isFalse,
    );
    await success('ondra-memory-dream', false);
    await success('ondra-memory-dream', true);
    expect(patch.readAsStringSync(), source);
    expect(sourceFile.readAsStringSync(), source);
  });

  test('重复 id、部分注释的遗留坏块、覆盖补丁与不支持的 inject 拒绝写入', () async {
    const invalid = [
      "- insert:\n    - id: x\n      name: x\n    - id: x\n      name: y\n",
      "- insert:\n    # - id: x\n      # name: x\n      config:\n        orphan: true\n",
      "- insert:\n    - id: x\n      name: x\n- id: x\n  disabled: true\n",
      "- insert:\n    - id: x\n      name: x\n      inject: *unknown\n",
      "- insert: [{id: x, name: x}]\n",
    ];
    for (final source in invalid) {
      patch.writeAsStringSync(source);
      expect((await updateProfilePluginEnabled('x', false)).ok, isFalse);
      expect(patch.readAsStringSync(), source);
      expect(File('${patch.path}.bak').existsSync(), isFalse);
      await expectLater(readProfilePlugins(), throwsFormatException);
    }
  });

  test('disabled 字段不会被注释开关假装启用', () async {
    const source =
        "- insert:\n    - id: x\n      name: x\n      disabled: true\n";
    patch.writeAsStringSync(source);
    expect((await readProfilePlugins()).single.enabled, isFalse);
    expect(await setProfilePluginEnabled('x', true), isFalse);
    expect(patch.readAsStringSync(), source);
  });

  test('锚点提供者不能关闭，否则会破坏其他条目的 YAML 别名', () async {
    const source = '''
- insert:
    - id: provider
      name: '@example/provider'
      config:
        defaults: &shared
          enabled: true
    - id: client
      name: '@example/client'
      config:
        defaults: *shared
''';
    patch.writeAsStringSync(source);
    expect(
      (await updateProfilePluginEnabled('provider', false)).error,
      contains('锚点'),
    );
    expect(patch.readAsStringSync(), source);
  });

  test('父组已关闭时不能假装启用子插件', () async {
    const source = '''
- insert:
    # - id: group
    #   group: true
    #   config:
    #     - id: child
    #       name: '@example/child'
''';
    patch.writeAsStringSync(source);
    final child = (await readProfilePlugins()).firstWhere(
      (e) => e.id == 'child',
    );
    expect(child.enabled, isFalse);
    expect(child.blockedReason, contains('父插件组'));
    expect(await setProfilePluginEnabled('child', true), isFalse);
    expect(patch.readAsStringSync(), source);
  });

  test('串行写入不会丢失另一插件的开关', () async {
    final results = await Future.wait([
      updateProfilePluginEnabled('consumer', false),
      updateProfilePluginEnabled('nested-child', false),
    ]);
    expect(results.every((e) => e.ok), isTrue);
    final entries = await readProfilePlugins();
    expect(entries.firstWhere((e) => e.id == 'consumer').enabled, isFalse);
    expect(entries.firstWhere((e) => e.id == 'nested-child').enabled, isFalse);
    expect(tmp.listSync().whereType<Directory>().map((d) => d.path), [
      '${tmp.path}/node_modules',
    ]);
  });

  test('缺失文件/写入失败返回原因且不改变内容；Web 不伪造写入', () async {
    Directory('${patch.path}.bak').createSync(); // 故障注入，不修改权限。
    expect(
      (await updateProfilePluginEnabled('consumer', false)).error,
      contains('保存失败'),
    );
    expect(patch.readAsStringSync(), _fixture);
    patch.deleteSync();
    expect(await readProfilePlugins(), isEmpty);
    expect(await setProfilePluginEnabled('consumer', false), isFalse);
    expect(
      (await web.updateProfilePluginEnabled('consumer', false)).ok,
      isFalse,
    );
  });

  test('client 正确分类基础项，禁止清单假开关，同名状态取 profile', () async {
    final client = PluginsClient();
    addTearDown(client.dispose);
    await client.load();
    expect(client.error, isNull);
    final identity = client.entries.firstWhere((e) => e.id == 'ondra-identity');
    expect(identity.kind, 'core');
    expect(identity.switchable, isFalse);
    await client.toggle('ondra-identity', false);
    expect(client.error, contains('必要基础依赖'));
    await client.toggle('cordis', false);
    expect(client.error, contains('没有可写入'));
    expect(patch.readAsStringSync(), _fixture);
    patch.writeAsStringSync(
      "- insert:\n    # - id: ondra-runtime\n    #   name: '@ondra/cordis-plugin-ondra-runtime'\n",
    );
    await client.load();
    final runtime = client.entries.where((e) => e.id == 'ondra-runtime');
    expect(runtime.length, 1);
    expect(runtime.single.enabled, isFalse);
    expect(runtime.single.switchable, isFalse);
    expect(client.profileCount, 1);
  });

  testWidgets('UI 显示写入/依赖失败，配置计数不称已加载，成功告知重启且保留会话', (tester) async {
    final client = PluginsClient();
    addTearDown(client.dispose);
    await tester.runAsync(client.load);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: PluginsPage(client: client)),
      ),
    );
    expect(find.textContaining('项配置启用'), findsOneWidget);
    expect(find.textContaining('项已加载'), findsNothing);
    expect(find.byType(OndraSwitch), findsWidgets);
    await tester.runAsync(() => client.toggle('optional-route', false));
    await tester.pump();
    expect(find.textContaining('拒绝关闭 optional-route'), findsOneWidget);
    expect(
      client.entries.firstWhere((e) => e.id == 'optional-route').enabled,
      isTrue,
    );
    Directory('${patch.path}.bak').createSync();
    await tester.runAsync(() => client.toggle('consumer', false));
    await tester.pump();
    expect(find.textContaining('装配层保存失败'), findsOneWidget);
    expect(
      client.entries.firstWhere((e) => e.id == 'consumer').enabled,
      isTrue,
    );
    Directory('${patch.path}.bak').deleteSync();
    await tester.runAsync(() => client.toggle('consumer', false));
    await tester.pump();
    expect(client.error, isNull);
    expect(client.saving, isFalse);
    expect(find.textContaining('装配层保存失败'), findsNothing);
    expect(find.textContaining('下次重启内核后生效；当前运行状态未改变'), findsOneWidget);
    expect(find.textContaining('未自动重启，也未中断对话'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
