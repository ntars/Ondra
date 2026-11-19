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
    expect(writeProfileConfigField('privacy', 'approval-mode', 'supervised'), isTrue);

    final text = read();
    expect(text, contains('    - id: ondra-privacy\n'
        '      name: \'@ondra/cordis-plugin-ondra-privacy\'\n'
        '      config:\n'
        '        approval-mode: supervised\n'));
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
