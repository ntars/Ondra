import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-plugins/ui/profile_plugins.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-plugins/ui/profile_plugins_io.dart'
    show debugProfileFileOverride;

/// 装配层读写：解析 `cordis.patch.yml` 的 `insert` 列表，开关靠注释翻转。
///
/// 全部跑在临时目录里：装配层是内核唯一入口，测试绝不能碰到真机上的那份。
void main() {
  late Directory tmp;
  late File patch;

  const yml = '''
# 测试用装配层
- insert:
    - id: ondra-absence
      name: '@ondra/cordis-plugin-ondra-absence'
    - id: ondra-clock
      name: '@ondra/cordis-plugin-ondra-clock'
''';

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('ondra_profile_test');
    patch = File('${tmp.path}/cordis.patch.yml')..writeAsStringSync(yml);
    debugProfileFileOverride = patch.path;

    // 两条包元数据：一条齐全，一条没有 package.json（版本应给 `-`）。
    final pkg = Directory('${tmp.path}/node_modules/@ondra/cordis-plugin-ondra-absence')
      ..createSync(recursive: true);
    File('${pkg.path}/package.json').writeAsStringSync(
      '{"name":"@ondra/cordis-plugin-ondra-absence","version":"2.1.2",'
      '"description":"空窗期礼仪。第二句不该出现在列表里。"}',
    );
  });

  tearDown(() {
    debugProfileFileOverride = null;
    tmp.deleteSync(recursive: true);
  });

  test('解析 insert 列表：id、包名、版本、简介都来自真实文件', () async {
    final entries = await readProfilePlugins();
    expect(entries.length, 2);

    final absence = entries.firstWhere((e) => e.id == 'ondra-absence');
    expect(absence.package, '@ondra/cordis-plugin-ondra-absence');
    expect(absence.version, '2.1.2');
    expect(absence.desc, contains('空窗期礼仪'));
    expect(absence.enabled, isTrue);

    // 没有 package.json 的条目：版本如实写 `-`，不编一个 0.0.0。
    final clock = entries.firstWhere((e) => e.id == 'ondra-clock');
    expect(clock.version, '-');
    expect(clock.enabled, isTrue);
  });

  test('关掉一条：两行都被注释，重新读得到 enabled=false', () async {
    expect(await setProfilePluginEnabled('ondra-absence', false), isTrue);

    final text = patch.readAsStringSync();
    expect(text, contains('# - id: ondra-absence'));
    expect(text, contains("# name: '@ondra/cordis-plugin-ondra-absence'"));
    // 另一条不能受牵连。
    expect(text, contains('\n    - id: ondra-clock\n'));

    final entries = await readProfilePlugins();
    expect(entries.firstWhere((e) => e.id == 'ondra-absence').enabled, isFalse);
    expect(entries.firstWhere((e) => e.id == 'ondra-clock').enabled, isTrue);

    // 第一次写入留了备份：改坏了有回头路。
    expect(File('${patch.path}.bak').readAsStringSync(), yml);
  });

  test('再打开：注释去掉，缩进与内容原样回来', () async {
    await setProfilePluginEnabled('ondra-absence', false);
    expect(await setProfilePluginEnabled('ondra-absence', true), isTrue);
    expect(patch.readAsStringSync(), yml);
    expect(
      (await readProfilePlugins()).firstWhere((e) => e.id == 'ondra-absence').enabled,
      isTrue,
    );
  });

  test('找不到的 id 返回 false，文件一个字节都不动', () async {
    expect(await setProfilePluginEnabled('ondra-nope', false), isFalse);
    expect(patch.readAsStringSync(), yml);
  });
}
