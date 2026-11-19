import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/prefs_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/maintenance_io.dart';

void main() {
  late Directory tmp;
  late String root;
  late OndraMaintenance maintenance;

  void put(String relative, [String text = 'data']) {
    final file = File('$root/$relative');
    file.parent.createSync(recursive: true);
    file.writeAsStringSync(text);
  }

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('ondra-maintenance-test-');
    root = '${tmp.path}/.ondra';
    maintenance = OndraMaintenance(home: root, dataIsOffline: () => true);
    setPrefHome(tmp.path);
  });

  tearDown(() {
    setPrefHome(null);
    tmp.deleteSync(recursive: true);
  });

  test('清空包含真实 dsh/sessions 且保留人设、头像和所有 profile', () async {
    for (final name in [
      'user/ondra.db',
      'sessions/old.json',
      'dsh/sessions/project/id/session.v4.jsonl',
      'storages/cache.json',
      'prefs.json',
      'personas/custom/SKILL.md',
      'profiles/keep.yml',
      'dsh/profiles/ondra/cordis.patch.yml',
      'avatar.png',
      'backups/keep',
    ]) {
      put(name);
    }
    final result = await maintenance.wipeAll();
    expect(result.ok, isTrue, reason: result.message);
    for (final name in ['user', 'sessions', 'dsh/sessions', 'storages']) {
      expect(Directory('$root/$name').existsSync(), isFalse);
    }
    expect(File('$root/prefs.json').existsSync(), isFalse);
    for (final name in [
      'personas/custom/SKILL.md',
      'profiles/keep.yml',
      'dsh/profiles/ondra/cordis.patch.yml',
      'avatar.png',
      'backups/keep',
    ]) {
      expect(File('$root/$name').readAsStringSync(), 'data');
    }
    expect(maintenance.lastWipe(), isNotNull);
    expect(result.message, contains('5 个文件'));
  });

  test('导出包含真实会话，不含保留的装配层和缓存', () async {
    put('dsh/sessions/project/id/session.v4.jsonl', 'session');
    put('user/ondra.db', 'database');
    put('prefs.json', '{}');
    put('dsh/profiles/ondra/cordis.patch.yml', 'profile');
    put('cache/cache.txt', 'cache');
    final out = Directory('${tmp.path}/out')..createSync();
    final result = await maintenance.exportAll(out.path);
    expect(result.ok, isTrue, reason: result.message);
    expect(
      File('${result.path}/dsh/sessions/project/id/session.v4.jsonl')
          .readAsStringSync(),
      'session',
    );
    expect(Directory('${result.path}/dsh/profiles').existsSync(), isFalse);
    expect(Directory('${result.path}/cache').existsSync(), isFalse);
  }, skip: !Platform.isMacOS);

  test('无法证明内核离线时所有活动清理和裸导出均拒绝', () async {
    put('user/ondra.db');
    put('dsh/sessions/test/session.v4.jsonl');
    put('cache/keep');
    final active = OndraMaintenance(home: root, dataIsOffline: () => false);
    expect((await active.wipeAll()).ok, isFalse);
    expect((await active.clearCache()).ok, isFalse);
    expect((await active.exportAll(tmp.path)).ok, isFalse);
    expect(File('$root/user/ondra.db').readAsStringSync(), 'data');
    expect(File('$root/cache/keep').existsSync(), isTrue);
    expect(Directory('${tmp.path}/ondra-export').existsSync(), isFalse);
  });

  test('危险目录链接在任何删除前拒绝，外部和已有数据不变', () async {
    put('user/ondra.db');
    final outside = Directory('${tmp.path}/outside')..createSync();
    File('${outside.path}/keep').writeAsStringSync('keep');
    Directory('$root/dsh').createSync();
    Link('$root/dsh/sessions').createSync(outside.path);
    final result = await maintenance.wipeAll();
    expect(result.ok, isFalse);
    expect(File('$root/user/ondra.db').existsSync(), isTrue);
    expect(File('${outside.path}/keep').readAsStringSync(), 'keep');
  });

  test('缓存目录链接不能扩大删除范围，嵌套链接只删链接', () async {
    put('personas/keep/SKILL.md', 'persona');
    Link('$root/cache').createSync('$root/personas');
    expect((await maintenance.clearCache()).ok, isFalse);
    expect(File('$root/personas/keep/SKILL.md').readAsStringSync(), 'persona');
    Link('$root/cache').deleteSync();
    put('cache/temp.txt');
    Link('$root/cache/persona-link').createSync('$root/personas');
    final result = await maintenance.clearCache();
    expect(result.ok, isTrue, reason: result.message);
    expect(Directory('$root/cache').listSync(), isEmpty);
    expect(File('$root/personas/keep/SKILL.md').readAsStringSync(), 'persona');
  });

  test('墓碑写失败时移回全部数据，不留下半次清空', () async {
    put('user/ondra.db');
    put('prefs.json', '{}');
    Directory('$root/.wiped').createSync();
    final result = await maintenance.wipeAll();
    expect(result.ok, isFalse);
    expect(File('$root/user/ondra.db').readAsStringSync(), 'data');
    expect(File('$root/prefs.json').readAsStringSync(), '{}');
  });

  test('删除偏好后 resetAll 式逐键写入不会复活旧非设置字段', () async {
    writePref('persona.nickname', 'old');
    writePref('onboardingDone', '1');
    writePref('settings.general.test', 'true');
    expect(readPref('persona.nickname'), 'old');
    final result = await maintenance.wipeAll();
    expect(result.ok, isTrue, reason: result.message);
    writePref('settings.general.test', '');
    writePref('language', 'zh');
    final stored =
        jsonDecode(File('$root/prefs.json').readAsStringSync()) as Map;
    expect(stored, {'language': 'zh'});
    expect(readPref('persona.nickname'), isEmpty);
  });

  test('外部替换 prefs 后读写都以新文件为准', () {
    writePref('themeMode', 'dark');
    expect(readPref('themeMode'), 'dark');
    put('prefs.json', '{"language":"en","persona.nickname":"new"}');
    expect(readPref('themeMode'), isEmpty);
    expect(readPref('language'), 'en');
    writePref('onboardingDone', '1');
    expect(jsonDecode(File('$root/prefs.json').readAsStringSync()), {
      'language': 'en',
      'persona.nickname': 'new',
      'onboardingDone': '1',
    });
  });
}
