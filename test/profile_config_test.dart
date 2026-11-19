import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/profile_config_io.dart';

/// 装配层配置段的读写。落点是 `cordis.patch.yml` 条目下的 `config` 块——
/// 内核在启动时把它传给 `apply(ctx, config)`，这是**唯一**真生效的位置。
void main() {
  late Directory tmp;
  late File patch;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('ondra-patch-');
    patch = File('${tmp.path}/cordis.patch.yml');
    debugProfileConfigFileOverride = patch.path;
    addTearDown(() {
      debugProfileConfigFileOverride = null;
      try {
        tmp.deleteSync(recursive: true);
      } catch (_) {}
    });
  });

  void write(String text) => patch.writeAsStringSync(text);

  String read() => patch.readAsStringSync();

  const sample = '''
# 装配层：注释必须原样保留
- insert:
    # ── L2 ──────────────────────────────────────────
    - id: ondra-privacy
      name: '@ondra/cordis-plugin-ondra-privacy'
    - id: ondra-tts
      name: '@ondra/cordis-plugin-ondra-tts'
      config:
        enable: true
        preset: soft
    - id: ondra-dialogue
      name: '@ondra/cordis-plugin-ondra-dialogue'
''';

  test('条目没有 config 块时插入一个，缩进与相邻条目一致', () {
    write(sample);
    expect(
      writeProfileConfigField('privacy', 'approval-mode', 'supervised'),
      isTrue,
    );

    final text = read();
    expect(
      text,
      contains(
        '    - id: ondra-privacy\n'
        '      name: \'@ondra/cordis-plugin-ondra-privacy\'\n'
        '      config:\n'
        '        approval-mode: supervised\n',
      ),
    );
    // 注释与别的条目一个字节不动。
    expect(text, contains('# ── L2 ──'));
    expect(text, contains('    - id: ondra-tts'));
    expect(readProfileConfigField('privacy', 'approval-mode'), 'supervised');
  });

  test('已有 config 块时原地更新，不产生第二个字段', () {
    write(sample);
    expect(writeProfileConfigField('tts', 'preset', 'lively'), isTrue);
    final text = read();
    expect(text, contains('        preset: lively'));
    expect('preset:'.allMatches(text).length, 1);
    expect(text, isNot(contains('preset: soft')));
  });

  test('删除字段：块空了连 config: 行一起删', () {
    write(sample);
    expect(writeProfileConfigField('tts', 'enable', null), isTrue);
    expect(writeProfileConfigField('tts', 'preset', null), isTrue);
    final text = read();
    expect(text, isNot(contains('config:')));
    // 条目本身还在。
    expect(text, contains('    - id: ondra-tts'));
    expect(text, contains("      name: '@ondra/cordis-plugin-ondra-tts'"));
  });

  test('条目不存在：拒绝写入，文件不变', () {
    write(sample);
    final before = read();
    expect(writeProfileConfigField('nonexistent', 'x', 1), isFalse);
    expect(read(), before);
  });

  test('值类型：bool / num / 需要引号的字符串', () {
    write(sample);
    writeProfileConfigField('tts', 'auto-scan', true);
    writeProfileConfigField('tts', 'rate', -0.25);
    writeProfileConfigField('tts', 'remark', 'a: b # c');
    final text = read();
    expect(text, contains('        auto-scan: true'));
    expect(text, contains('        rate: -0.25'));
    expect(text, contains("        remark: 'a: b # c'"));
    expect(readProfileConfigField('tts', 'rate'), '-0.25');
    expect(readProfileConfigField('tts', 'remark'), 'a: b # c');
  });

  test('带行尾注释的既有值能正确读出，不被当成值的一部分', () {
    write('''
- insert:
    - id: ondra-tts
      name: '@ondra/cordis-plugin-ondra-tts'
      config:
        rate: 0.25  # 原速偏快一点
''');
    expect(readProfileConfigField('tts', 'rate'), '0.25');
  });

  test('仅遍历 insert/group；managed route 的嵌套 JSON 与伪 id 原样保留', () {
    const route = '''
    - id: model-route
      name: route
      config: {"models": [{"id": "ondra-tts", "config": {"preset": "manual"}}]}
    - id: nested-data
      name: data
      config:
        items:
          - id: ondra-tts
            config:
              preset: manual
''';
    write('''
- insert:
$route    - id: group
      group: true
      config:
        - id: ondra-tts
          name: tts
          config:
            preset: soft
''');
    expect(writeProfileConfigField('tts', 'preset', 'lively'), isTrue);
    expect(read(), contains(route));
    expect(read(), contains('            preset: lively'));
  });

  test('JSON config 仅改目标 token，不覆盖手工字段或嵌套对象', () {
    const config =
        '{"preset": "soft", "manual": {"preset":"keep", "text":"a, } b"}, "rate":0.25}';
    write(
      '- insert:\n    - id: ondra-tts\n      name: tts\n      config: $config\n',
    );
    expect(writeProfileConfigField('tts', 'preset', 'lively'), isTrue);
    expect(read(), contains(config.replaceFirst('"soft"', '"lively"')));
    expect(writeProfileConfigField('tts', 'enable', false), isTrue);
    expect(readProfileConfigField('tts', 'enable'), 'false');
    expect(writeProfileConfigField('tts', 'rate', null), isTrue);
    expect(readProfileConfigField('tts', 'rate'), isNull);
    expect(read(), contains('"manual": {"preset":"keep", "text":"a, } b"}'));
  });

  test('引用/嵌套/重复字段不被破坏，失败报告原因', () {
    for (final config in [
      '        preset: &voice soft\n',
      '        preset:\n          manual: soft\n',
      '        preset: soft\n        preset: lively\n',
    ]) {
      write(
        '- insert:\n    - id: ondra-tts\n      name: tts\n      config:\n$config',
      );
      final before = read();
      final result = writeProfileConfigFieldResult(
        'tts',
        'preset',
        'broadcast',
      );
      expect(result.ok, isFalse);
      expect(result.error, isNotEmpty);
      expect(read(), before);
    }
  });

  test('空行/行尾注释/CRLF 不截断 config 或丢失手工内容', () {
    const text =
        '- insert:\r\n'
        '    - id: "ondra-tts" # id\r\n'
        '      name: tts\r\n'
        '      config: # keep\r\n'
        '        preset: soft  # voice\r\n'
        '\r\n'
        '        manual: 42\r\n'
        '    - id: other\r\n'
        '      name: other';
    write(text);
    expect(writeProfileConfigField('tts', 'preset', 'lively'), isTrue);
    expect(read(), text.replaceFirst('preset: soft', 'preset: lively'));
    expect(writeProfileConfigField('tts', 'rate', 0.1), isTrue);
    expect(readProfileConfigField('tts', 'manual'), '42');
  });

  test('禁用条目/禁用组/只读 profile 拒绝写入而不偷偷启用', () {
    for (final source in [
      '- insert:\n    - id: ondra-tts\n      name: tts\n      disabled: true\n',
      '- insert:\n# ondra-plugin-off:     - id: ondra-tts\n# ondra-plugin-off:       name: tts\n',
      '- insert:\n    # - id: ondra-tts\n    #   name: tts\n',
      '- insert:\n    - id: group\n      group: true\n      disabled: true\n      config:\n        - id: ondra-tts\n          name: tts\n',
    ]) {
      write(source);
      final result = writeProfileConfigFieldResult('tts', 'enable', true);
      expect(result.ok, isFalse);
      expect(result.error, contains('禁用'));
      expect(read(), source);
    }
    write(sample);
    expect(Process.runSync('chmod', ['444', patch.path]).exitCode, 0);
    final result = writeProfileConfigFieldResult('tts', 'preset', 'lively');
    expect(result.ok, isFalse);
    expect(result.error, contains('只读'));
    expect(read(), sample);
    Process.runSync('chmod', ['600', patch.path]);
  });

  test('真实 profile 快照可以逐项配置，保留其余结构', () {
    // fixture 只读，所有修改只发生在临时目录。
    final fixture = File(
      '${Directory.current.path}/plugin-profile/cordis.patch.yml',
    );
    write(fixture.readAsStringSync());
    expect(writeProfileConfigFieldResult('tts', 'preset', 'lively').ok, isTrue);
    expect(readProfileConfigField('tts', 'preset'), 'lively');
  });

  test('第一次修改留一份 .bak，后来的修改不覆盖它', () {
    write(sample);
    writeProfileConfigField('tts', 'preset', 'lively');
    final bak = File('${patch.path}.bak');
    expect(bak.existsSync(), isTrue);
    expect(bak.readAsStringSync(), sample);

    writeProfileConfigField('tts', 'preset', 'broadcast');
    expect(bak.readAsStringSync(), sample, reason: '.bak 应是改动前的原样');
  });

  test('写入是原子替换：不留下临时文件', () {
    write(sample);
    writeProfileConfigField('tts', 'preset', 'lively');
    expect(File('${patch.path}.tmp').existsSync(), isFalse);
  });
}
