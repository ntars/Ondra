import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_actions.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_model.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-transfer/ui/transfer_engine_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-transfer/ui/transfer_model.dart';

/// 导入导出引擎的真目录测试。
///
/// 这里**不 mock 文件系统**：每个用例都在临时目录里造一个 `~/.ondra`，
/// 真的建库、真的写文件、真的把导出的东西再导入另一台"机器"。
/// 这样做慢一点，但它是唯一能验证「导出的东西真的能导回来」的方式——
/// 而这正是这一页存在的全部理由。
void main() {
  late Directory tmp;
  late TransferEngine engine;

  final fixedNow = DateTime(2026, 11, 17, 21, 30);
  final originalOverview = backupOverviewLoader;
  final originalCreate = backupCreate;
  final originalExport = backupExport;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('ondra-transfer-test-');
    engine = TransferEngine(home: tmp.path, now: () => fixedNow);
    // 备份引擎默认指向真实的 HOME。测试里换成空实现，绝不碰用户的备份目录。
    backupOverviewLoader = () async => BackupOverview.empty;
    backupCreate = ({BackupTrigger trigger = BackupTrigger.manual}) async =>
        const BackupOpResult(
          ok: true,
          message: '隔离测试的备份保护',
          snapshotId: 'fresh',
        );
    await _seedDb('${tmp.path}/.ondra/user/ondra.db');
  });

  tearDown(() async {
    backupOverviewLoader = originalOverview;
    backupCreate = originalCreate;
    backupExport = originalExport;
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  test('读得出真实的记忆、原文与关联条数', () async {
    final snap = await engine.load();
    expect(snap.facts, 3, reason: '两条在用 + 一条归档');
    expect(snap.archivedFacts, 1);
    expect(snap.raws, 2);
    expect(snap.links, 1);
    expect(snap.dbBytes, greaterThan(0));
    expect(snap.lastFactAt, isNotNull);
    expect(snap.note, isEmpty);
  });

  test('导出 Markdown：文件真的写出来，正文与注释都在', () async {
    final out = await Directory('${tmp.path}/out').create();

    final r = await engine.exportMemory(out.path, TransferFormat.markdown);
    expect(r.ok, isTrue, reason: r.message);
    expect(r.count, 3);

    final file = File(r.path!);
    expect(await file.exists(), isTrue);
    final text = await file.readAsString();
    expect(text, contains('用户名叫小林。'));
    expect(text, contains('<!-- ondra:memory id=m-a8f1fdb5c240'));
    expect(text, contains('原话：「我叫小林」'));
  });

  test('导出 JSON 再导入另一台机器：条数与正文都对得上', () async {
    final out = await Directory('${tmp.path}/out').create();
    final r = await engine.exportMemory(out.path, TransferFormat.json);
    expect(r.ok, isTrue, reason: r.message);

    // 另一台"机器"：只有空库，没有记忆。
    final other = await Directory('${tmp.path}/other').create();
    final otherEngine = TransferEngine(home: other.path, now: () => fixedNow);
    await _seedDb('${other.path}/.ondra/user/ondra.db', withRows: false);

    final imported = await otherEngine.importPath(r.path!);
    expect(imported.ok, isTrue, reason: imported.message);
    expect(imported.count, 3);

    final after = await otherEngine.load();
    expect(after.facts, 3);
    // 归档标记要跟着走：导回来的不能悄悄变成"在用的记忆"。
    expect(after.archivedFacts, 1);
    expect(after.links, 1);
    final again = await otherEngine.exportMemory(
      other.path,
      TransferFormat.json,
    );
    final beforeJson = jsonDecode(await File(r.path!).readAsString()) as Map;
    final afterJson = jsonDecode(await File(again.path!).readAsString()) as Map;
    expect(afterJson['facts'], beforeJson['facts']);
    expect(afterJson['links'], beforeJson['links']);
  });

  test('同一份文件导两次：第二次全部跳过，不长出两套记忆', () async {
    final out = await Directory('${tmp.path}/out').create();
    final r = await engine.exportMemory(out.path, TransferFormat.json);

    final first = await engine.importPath(r.path!);
    expect(first.ok, isTrue);
    expect(first.count, 0, reason: '导出的就是本机的记忆，一条都不该新增');
    expect(first.skipped, 3);

    final second = await engine.importPath(r.path!);
    expect(second.ok, isTrue);
    expect(second.skipped, 3);

    final after = await engine.load();
    expect(after.facts, 3, reason: '导两次不该变成六条');
  });

  test('Markdown 特殊标题与记忆使用记录往返，不丢整条记忆', () async {
    await _sql(
      engine.dbPath,
      "update memory_fact set times_said=8, hits=3, "
      "last_seen_at=created_at+60000, sealed=1, revisions=3, "
      "old_text='喜欢绿色', source_raw_id='r-1' where id='m-a8f1fdb5c240';",
    );
    final out = await Directory('${tmp.path}/roundtrip').create();
    final exported = await engine.exportMemory(
      out.path,
      TransferFormat.markdown,
    );
    final otherDir = await Directory('${tmp.path}/other-md').create();
    final other = TransferEngine(home: otherDir.path, now: () => fixedNow);
    await _seedDb(other.dbPath, withRows: false);
    final imported = await other.importPath(exported.path!);
    expect(imported.ok, isTrue, reason: imported.message);
    expect(imported.count, 3, reason: '「关联」「空谷记忆」标题不能被整段跳过');

    final json = await other.exportMemory(out.path, TransferFormat.json);
    final data = jsonDecode(File(json.path!).readAsStringSync()) as Map;
    final restored = (data['facts'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((f) => f['id'] == 'm-a8f1fdb5c240');
    expect(restored['sealed'], true);
    expect(restored['revisions'], 3);
    expect(restored['oldText'], '喜欢绿色');
    expect(restored['sourceRawId'], 'r-1');
    expect(restored['timesSaid'], 8);
    expect(restored['hits'], 3);
  });

  test('JSON 迁移带回原文表，事实的原文编号不再悬空', () async {
    final out = await Directory('${tmp.path}/json-raw').create();
    final exported = await engine.exportMemory(out.path, TransferFormat.json);
    final otherDir = await Directory('${tmp.path}/other-raw').create();
    final other = TransferEngine(home: otherDir.path, now: () => fixedNow);
    await _seedDb(other.dbPath, withRows: false);
    final imported = await other.importPath(exported.path!);
    expect(imported.ok, isTrue, reason: imported.message);
    expect(imported.message, contains('2 条原文随行'));
    final snap = await other.load();
    expect(snap.raws, 2);

    final data = jsonDecode(File(exported.path!).readAsStringSync()) as Map;
    final raws = (data['memory_raw'] as List).cast<Map<String, dynamic>>();
    expect(raws.first['id'], 'r-1');
    expect(raws.first['text'], '我叫小林');
  });

  test('目标已有同文事实时，重新导入会同步封存、修订与使用记录', () async {
    final input = File('${tmp.path}/duplicate-state.json')
      ..writeAsStringSync(
        jsonEncode({
          'facts': [
            {
              'id': 'remote-id',
              'category': 'person',
              'text': '用户名叫小林。',
              'subject': null,
              'sealed': true,
              'revisions': 3,
              'oldText': '喜欢绿色',
              'sourceRawId': 'r-1',
              'timesSaid': 8,
              'hits': 3,
              'lastSeenAt': 1700000060000,
            },
          ],
        }),
      );
    final result = await engine.importPath(input.path);
    expect(result.ok, isTrue, reason: result.message);
    expect(result.skipped, 1);
    final json = await engine.exportMemory(tmp.path, TransferFormat.json);
    final data = jsonDecode(File(json.path!).readAsStringSync()) as Map;
    final restored = (data['facts'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((f) => f['text'] == '用户名叫小林。');
    expect(restored['sealed'], isTrue);
    expect(restored['revisions'], 3);
    expect(restored['oldText'], '喜欢绿色');
    expect(restored['sourceRawId'], 'r-1');
    expect(restored['timesSaid'], 8);
    expect(restored['hits'], 3);
    expect(restored['lastSeenAt'], 1700000060000);
  });

  test('手写的 Markdown 也能导入：没有注释的段落当成一条新记忆', () async {
    final file = File('${tmp.path}/手写.md');
    await file.writeAsString('''
## 喜欢克制的设计
## 讨厌花哨的动效
''');

    final r = await engine.importPath(file.path);
    expect(r.ok, isTrue, reason: r.message);
    expect(r.count, 2);

    final after = await engine.load();
    expect(after.facts, 5);
  });

  test('人设与偏好导出成目录：偏好文件在里面', () async {
    await File('${tmp.path}/.ondra/prefs.json')
        .writeAsString('{"themeMode":"dark"}');
    final out = await Directory('${tmp.path}/out').create();

    final r = await engine.exportBundle(out.path);
    expect(r.ok, isTrue, reason: r.message);

    final dir = Directory(r.path!);
    expect(dir.existsSync(), isTrue);
    final prefs = File('${dir.path}/偏好.json');
    expect(prefs.existsSync(), isTrue);
    expect(await prefs.readAsString(), contains('dark'));
  });

  test('Markdown 往返保留证据、归档和关联', () async {
    final exported = await engine.exportMemory(
      tmp.path,
      TransferFormat.markdown,
    );
    final other = TransferEngine(home: '${tmp.path}/markdown');
    await _seedDb(other.dbPath, withRows: false);
    final result = await other.importPath(exported.path!);
    expect(result.ok, isTrue, reason: result.message);
    final json = await other.exportMemory(tmp.path, TransferFormat.json);
    final data = jsonDecode(File(json.path!).readAsStringSync()) as Map;
    expect((data['facts'] as List).first['evidence'], contains('我叫小林'));
    expect((await other.load()).links, 1);
    expect((await other.load()).archivedFacts, 1);
  });

  test('同 id 不同正文拒绝整批且不谎报成功', () async {
    final input = File('${tmp.path}/conflict.json')
      ..writeAsStringSync(
        jsonEncode({
          'facts': [
            {'id': 'new', 'text': '新增'},
            {'id': 'm-a8f1fdb5c240', 'text': '冲突'},
          ],
        }),
      );
    final result = await engine.importPath(input.path);
    expect(result.ok, isFalse);
    expect(result.message, contains('冲突'));
    expect(result.count, 0);
    expect((await engine.load()).facts, 3);
  });

  test('备份失败阻断记忆和偏好写入', () async {
    backupCreate = ({BackupTrigger trigger = BackupTrigger.manual}) async =>
        const BackupOpResult(ok: false, message: '磁盘已满');
    final input = File('${tmp.path}/incoming.md')..writeAsStringSync('## 不应写入');
    expect((await engine.importPath(input.path)).ok, isFalse);
    expect((await engine.load()).facts, 3);
    final prefs = File('${tmp.path}/prefs.json')
      ..writeAsStringSync('{"language":"en"}');
    expect((await engine.importPath(prefs.path)).ok, isFalse);
    expect(File('${engine.dataRoot}/prefs.json').existsSync(), isFalse);
  });

  test('SQL 中途失败由 bail 回滚，不能提交前半批', () async {
    await _sql(
      engine.dbPath,
      "create trigger reject_second before insert on memory_fact when new.id='bad' begin select raise(ABORT, 'test rejection'); end;",
    );
    final file = File('${tmp.path}/batch.json')
      ..writeAsStringSync(
        jsonEncode({
          'facts': [
            {'id': 'good', 'text': '先写'},
            {'id': 'bad', 'text': '随后出错'},
            {'id': 'last', 'text': '最后'},
          ],
        }),
      );
    final result = await engine.importPath(file.path);
    expect(result.ok, isFalse);
    expect((await engine.load()).facts, 3);
  });

  test('实际写入数来自 SQLite，trigger ignore 不算成功写入', () async {
    await _sql(
      engine.dbPath,
      "create trigger ignore_import before insert on memory_fact when new.id='ignored' begin select raise(IGNORE); end;",
    );
    final file = File('${tmp.path}/ignored.json')
      ..writeAsStringSync('[{"id":"ignored","text":"不会落库"}]');
    final result = await engine.importPath(file.path);
    expect(result.ok, isTrue, reason: result.message);
    expect(result.count, 0);
    expect((await engine.load()).facts, 3);
  });

  test('关联冲突导致同批事实一起回滚', () async {
    final file = File('${tmp.path}/link-conflict.json')
      ..writeAsStringSync(
        jsonEncode({
          'facts': [
            {'id': 'new', 'text': '新的事实'},
          ],
          'links': [
            {'id': 'l-1', 'from': 'new', 'to': 'm-a8f1fdb5c240', 'weight': 0.7},
          ],
        }),
      );
    final result = await engine.importPath(file.path);
    expect(result.ok, isFalse);
    expect((await engine.load()).facts, 3);
    expect((await engine.load()).links, 1);
  });

  test('文本去重后关联端点映射到已有编号', () async {
    final file = File('${tmp.path}/links.json')
      ..writeAsStringSync(
        jsonEncode({
          'facts': [
            {'id': 'alias', 'text': '用户名叫小林。'},
            {'id': 'new', 'text': '新事实'},
          ],
          'links': [
            {'from': 'alias', 'to': 'new', 'weight': 0.6},
          ],
        }),
      );
    final result = await engine.importPath(file.path);
    expect(result.ok, isTrue, reason: result.message);
    expect(result.count, 1);
    expect(result.skipped, 1);
    final rows = await _sql(
      engine.dbPath,
      "select from_id from memory_link where to_id='new';",
    );
    expect(rows.trim(), 'm-a8f1fdb5c240');
    final second = await engine.importPath(file.path);
    expect(second.count, 0);
    expect((await engine.load()).links, 2);
  });

  test('单独语言或 settings 偏好文件可识别并按键合并', () async {
    File('${engine.dataRoot}/prefs.json')
        .writeAsStringSync('{"persona.nickname":"保留","themeMode":"light"}');
    final file = File('${tmp.path}/prefs.json')
      ..writeAsStringSync('{"language":"en","settings.general.fontSize":14}');
    final result = await engine.importPath(file.path);
    expect(result.ok, isTrue, reason: result.message);
    expect(
      jsonDecode(File('${engine.dataRoot}/prefs.json').readAsStringSync()),
      {
        'persona.nickname': '保留',
        'themeMode': 'light',
        'language': 'en',
        'settings.general.fontSize': '14',
      },
    );
  });

  test('人设包、头像、配置和偏好完整往返且保留其他插件', () async {
    final pack = Directory('${engine.dataRoot}/personas/test')
      ..createSync(recursive: true);
    File('${pack.path}/SKILL.md').writeAsStringSync('persona');
    File('${engine.dataRoot}/avatar.png').writeAsBytesSync([1, 2, 3]);
    File('${engine.dataRoot}/prefs.json')
        .writeAsStringSync('{"language":"en"}');
    final config = File(
      '${engine.dataRoot}/dsh/profiles/ondra/cordis.patch.yml',
    );
    config.parent.createSync(recursive: true);
    config.writeAsStringSync(
      '- insert:\n    - id: ondra-persona-core\n      name: persona-core\n      config:\n        greeting: hello\n    - id: other\n      name: source-other\n',
    );
    final bundle = await engine.exportBundle(tmp.path);
    expect(bundle.ok, isTrue, reason: bundle.message);
    final other = TransferEngine(home: '${tmp.path}/bundle-target');
    final local = File('${other.dataRoot}/dsh/profiles/ondra/cordis.patch.yml');
    local.parent.createSync(recursive: true);
    local.writeAsStringSync(
      '- insert:\n    - id: ondra-persona-core\n      name: old\n    - id: keep\n      name: keep-me\n',
    );
    final oldPack = Directory('${other.dataRoot}/personas/test')
      ..createSync(recursive: true);
    File('${oldPack.path}/stale.txt').writeAsStringSync('old');
    File('${other.dataRoot}/prefs.json')
        .writeAsStringSync('{"themeMode":"dark"}');
    final imported = await other.importPath(bundle.path!);
    expect(imported.ok, isTrue, reason: imported.message);
    expect(imported.count, 4);
    expect(File('${other.dataRoot}/avatar.png').readAsBytesSync(), [1, 2, 3]);
    expect(File('${oldPack.path}/SKILL.md').readAsStringSync(), 'persona');
    expect(File('${oldPack.path}/stale.txt').existsSync(), isFalse);
    expect(local.readAsStringSync(), contains('greeting: hello'));
    expect(local.readAsStringSync(), contains('name: keep-me'));
    expect(local.readAsStringSync(), isNot(contains('source-other')));
    expect(
      jsonDecode(File('${other.dataRoot}/prefs.json').readAsStringSync()),
      {'themeMode': 'dark', 'language': 'en'},
    );
  });

  test('自定义 DSH_HOME 时会话、配置和内核人设 ZIP 都走实际目录', () async {
    final customHome = await Directory('${tmp.path}/custom-home').create();
    final customDsh = await Directory('${tmp.path}/custom-dsh').create();
    await _seedDb('${customHome.path}/.ondra/user/ondra.db');
    final engine = TransferEngine(
      home: customHome.path,
      dshHome: customDsh.path,
      dataIsOffline: () => true,
      now: () => fixedNow,
    );

    final session = Directory(
      '${customDsh.path}/sessions/project/session-custom',
    )..createSync(recursive: true);
    File('${session.path}/session.v4.jsonl').writeAsStringSync('{}\n');
    final defaultSession = Directory(
      '${customHome.path}/.ondra/dsh/sessions/project/default-session',
    )..createSync(recursive: true);
    File('${defaultSession.path}/session.v4.jsonl').writeAsStringSync('{}\n');

    final profile = File('${customDsh.path}/profiles/ondra/cordis.patch.yml');
    profile.parent.createSync(recursive: true);
    profile.writeAsStringSync('''
- insert:
    - id: ondra-persona-loader
      name: '@ondra/cordis-plugin-ondra-persona-loader'
      config:
        userSubdir: heroes
    - id: ondra-privacy
      name: '@ondra/cordis-plugin-ondra-privacy'
      config:
        approval-mode: supervised
''');
    final defaultProfile = File(
      '${customHome.path}/.ondra/dsh/profiles/ondra/cordis.patch.yml',
    );
    defaultProfile.parent.createSync(recursive: true);
    defaultProfile.writeAsStringSync('default profile must stay untouched\n');

    expect((await engine.load()).sessions, 1);

    final bundle = Directory('${tmp.path}/custom-bundle')..createSync();
    final pack = Directory('${bundle.path}/personas/hero')
      ..createSync(recursive: true);
    File('${pack.path}/SKILL.md').writeAsStringSync('hero persona');
    File('${bundle.path}/人设配置.yml').writeAsStringSync('''
- id: ondra-persona-loader
  name: '@ondra/cordis-plugin-ondra-persona-loader'
  config:
    userSubdir: heroes
    bundledDir: content/personas/bundled
''');

    final imported = await engine.importPath(bundle.path);
    expect(imported.ok, isTrue, reason: imported.message);
    expect(
      File('${customHome.path}/.ondra/user/heroes/hero.skill.zip').existsSync(),
      isTrue,
    );
    expect(
      File('${customHome.path}/.ondra/user/personas/hero.skill.zip')
          .existsSync(),
      isFalse,
    );
    expect(
      profile.readAsStringSync(),
      contains('bundledDir: content/personas/bundled'),
    );
    expect(
      defaultProfile.readAsStringSync(),
      'default profile must stay untouched\n',
    );

    final out = Directory('${tmp.path}/custom-export')..createSync();
    final exported = await engine.exportBundle(out.path);
    expect(exported.ok, isTrue, reason: exported.message);
    expect(
      File('${exported.path!}/人设配置.yml').readAsStringSync(),
      contains('bundledDir: content/personas/bundled'),
    );
  });

  test('非法 userSubdir 不越界，内核人设 ZIP 回退到 personas', () async {
    final customHome = await Directory('${tmp.path}/fallback-home').create();
    final customDsh = await Directory('${tmp.path}/fallback-dsh').create();
    await _seedDb('${customHome.path}/.ondra/user/ondra.db');
    final profile = File('${customDsh.path}/profiles/ondra/cordis.patch.yml');
    profile.parent.createSync(recursive: true);
    profile.writeAsStringSync('''
- insert:
    - id: ondra-persona-loader
      name: '@ondra/cordis-plugin-ondra-persona-loader'
      config:
        user-subdir: ../outside
''');
    final engine = TransferEngine(
      home: customHome.path,
      dshHome: customDsh.path,
      dataIsOffline: () => true,
    );
    final bundle = Directory('${tmp.path}/fallback-bundle')..createSync();
    final pack = Directory('${bundle.path}/personas/hero')
      ..createSync(recursive: true);
    File('${pack.path}/SKILL.md').writeAsStringSync('hero persona');

    final imported = await engine.importPath(bundle.path);
    expect(imported.ok, isTrue, reason: imported.message);
    expect(
      File('${customHome.path}/.ondra/user/personas/hero.skill.zip')
          .existsSync(),
      isTrue,
    );
    expect(Directory('${customHome.path}/outside').existsSync(), isFalse);
  });

  test('非法人设配置不留下已写入的偏好或头像', () async {
    final bundle = Directory('${tmp.path}/invalid-bundle')..createSync();
    File('${bundle.path}/偏好.json').writeAsStringSync('{"language":"en"}');
    File('${bundle.path}/人设配置.yml')
        .writeAsStringSync('- id: unrelated\n  name: nope\n');
    File('${engine.dataRoot}/prefs.json')
        .writeAsStringSync('{"themeMode":"dark"}');
    final result = await engine.importPath(bundle.path);
    expect(result.ok, isFalse);
    expect(
      File('${engine.dataRoot}/prefs.json').readAsStringSync(),
      '{"themeMode":"dark"}',
    );
  });

  test('多文件提交中途失败恢复已经替换的偏好', () async {
    final bundle = Directory('${tmp.path}/rollback-bundle')..createSync();
    File('${bundle.path}/偏好.json').writeAsStringSync('{"language":"en"}');
    final pack = Directory('${bundle.path}/personas/test')
      ..createSync(recursive: true);
    File('${pack.path}/SKILL.md').writeAsStringSync('persona');
    File('${engine.dataRoot}/prefs.json')
        .writeAsStringSync('{"themeMode":"dark"}');
    backupCreate = ({BackupTrigger trigger = BackupTrigger.manual}) async {
      File('${engine.dataRoot}/personas').writeAsStringSync('blocked parent');
      return const BackupOpResult(ok: true, message: 'backed up');
    };
    final result = await engine.importPath(bundle.path);
    expect(result.ok, isFalse);
    expect(
      File('${engine.dataRoot}/prefs.json').readAsStringSync(),
      '{"themeMode":"dark"}',
    );
    expect(
      File('${engine.dataRoot}/personas').readAsStringSync(),
      'blocked parent',
    );
  });

  test('活动数据保护拒绝人设覆盖且不调用备份', () async {
    var called = false;
    backupCreate = ({BackupTrigger trigger = BackupTrigger.manual}) async {
      called = true;
      return const BackupOpResult(ok: true, message: 'unexpected');
    };
    final bundle = Directory('${tmp.path}/active-bundle')..createSync();
    File('${bundle.path}/偏好.json').writeAsStringSync('{"language":"en"}');
    final active = TransferEngine(home: tmp.path, dataIsOffline: () => false);
    expect((await active.importPath(bundle.path)).ok, isFalse);
    expect(called, isFalse);
    expect(File('${engine.dataRoot}/prefs.json').existsSync(), isFalse);
  });

  test('在线偏好合并保留备份期间新写入的字段', () async {
    backupCreate = ({BackupTrigger trigger = BackupTrigger.manual}) async {
      File('${engine.dataRoot}/prefs.json')
          .writeAsStringSync('{"themeMode":"dark","onboardingDone":"1"}');
      return const BackupOpResult(ok: true, message: 'backed up');
    };
    final file = File('${tmp.path}/online-prefs.json')
      ..writeAsStringSync('{"language":"en"}');
    final active = TransferEngine(home: tmp.path, dataIsOffline: () => false);
    final result = await active.importPath(file.path);
    expect(result.ok, isTrue, reason: result.message);
    expect(
      jsonDecode(File('${engine.dataRoot}/prefs.json').readAsStringSync()),
      {'themeMode': 'dark', 'onboardingDone': '1', 'language': 'en'},
    );
  });

  test('高精度数值、多行正文和含空格类别可以往返', () async {
    await _sql(
      engine.dbPath,
      "update memory_fact set text='第一行' || char(10) || '第二行', category='a b', salience=12.3456789 where id='m-a8f1fdb5c240';",
    );
    final exported = await engine.exportMemory(
      tmp.path,
      TransferFormat.markdown,
    );
    final other = TransferEngine(home: '${tmp.path}/multiline');
    await _seedDb(other.dbPath, withRows: false);
    final imported = await other.importPath(exported.path!);
    expect(imported.ok, isTrue, reason: imported.message);
    final rows = jsonDecode(
      await _sql(
        other.dbPath,
        "select json_object('text', text, 'category', category, 'salience', salience) from memory_fact where id='m-a8f1fdb5c240';",
      ),
    );
    expect(rows, {
      'text': '第一行\n第二行',
      'category': 'a b',
      'salience': 12.3456789,
    });
  });

  test('不合法事实不允许静默跳过后导入半份', () async {
    final file = File('${tmp.path}/invalid-facts.json')
      ..writeAsStringSync('[{"id":"new","text":"有效"},{"id":"invalid"}]');
    expect((await engine.importPath(file.path)).ok, isFalse);
    expect((await engine.load()).facts, 3);
  });

  test('全部导出每次创建当前快照且使用返回编号', () async {
    final exported = <String>[];
    var creates = 0;
    backupCreate = ({BackupTrigger trigger = BackupTrigger.manual}) async =>
        BackupOpResult(
          ok: true,
          message: 'created',
          snapshotId: 'current-${++creates}',
        );
    backupOverviewLoader = () async => throw StateError('不应靠列表猜编号');
    backupExport = (id, dir) async {
      exported.add(id);
      return const BackupOpResult(ok: true, message: 'exported');
    };
    expect((await engine.exportArchive(tmp.path)).ok, isTrue);
    expect((await engine.exportArchive(tmp.path)).ok, isTrue);
    expect(exported, ['current-1', 'current-2']);
    backupCreate = ({BackupTrigger trigger = BackupTrigger.manual}) async =>
        const BackupOpResult(ok: false, message: 'no space');
    expect((await engine.exportArchive(tmp.path)).ok, isFalse);
    expect(exported.length, 2);
  });

  test('什么都没有时不硬导一份空文件', () async {
    final emptyHome = await Directory('${tmp.path}/empty').create();
    final emptyEngine = TransferEngine(home: emptyHome.path);
    final out = await Directory('${tmp.path}/out2').create();

    final r = await emptyEngine.exportBundle(out.path);
    expect(r.ok, isFalse);
    expect(r.message, contains('没有可携带'));

    final another = await Directory('${tmp.path}/out3').create();
    final m = await emptyEngine.exportMemory(another.path, TransferFormat.json);
    expect(m.ok, isFalse, reason: '没有记忆库时不该写出空文件');
    expect(another.listSync(), isEmpty);
  });

  test('摘要、唤醒度、稳定时长与来源渠道在两种格式往返中保留', () async {
    await _sql(
      engine.dbPath,
      "update memory_fact set summary='独立摘要', channel='gist', arousal=0.9, "
      "stability_hours=96, stability_mult=2, last_hit_at=123456 "
      "where id='m-a8f1fdb5c240';",
    );
    for (final format in TransferFormat.values.where(
      (f) => f == TransferFormat.json || f == TransferFormat.markdown,
    )) {
      final out = await Directory('${tmp.path}/attrs-${format.name}').create();
      final exported = await engine.exportMemory(out.path, format);
      expect(exported.ok, isTrue, reason: exported.message);
      final other = TransferEngine(
        home: '${tmp.path}/attrs-other-${format.name}',
        now: () => fixedNow,
      );
      await _seedDb(other.dbPath, withRows: false);
      final imported = await other.importPath(exported.path!);
      expect(imported.ok, isTrue, reason: '$format: ${imported.message}');
      final row = jsonDecode(
        await _sql(
          other.dbPath,
          "select json_object('summary', summary, 'channel', channel, "
          "'arousal', arousal, 'stability_hours', stability_hours, "
          "'stability_mult', stability_mult, 'last_hit_at', last_hit_at) "
          "from memory_fact where id='m-a8f1fdb5c240';",
        ),
      ) as Map;
      expect(row, {
        'summary': '独立摘要',
        'channel': 'gist',
        'arousal': 0.9,
        'stability_hours': 96.0,
        'stability_mult': 2.0,
        'last_hit_at': 123456,
      }, reason: '$format 迁移改变了记忆属性');
    }
  });
}

/// 造一个只有记忆三张表的库。
///
/// 不抄完整的 `ondra.db`（25 张表）：这里要验的是「导入导出能不能对上」，
/// 多建二十张空表只会让失败时的排查变难。
Future<String> _sql(String path, String sql) async {
  final result = await Process.run('/usr/bin/sqlite3', ['-bail', path, sql]);
  if (result.exitCode != 0) throw StateError('${result.stderr}');
  return result.stdout as String;
}

Future<void> _seedDb(String dbPath, {bool withRows = true}) async {
  await Directory(File(dbPath).parent.path).create(recursive: true);

  const schema = '''
create table memory_fact (
  id text primary key not null, kind text not null, category text not null,
  channel text not null, text text not null, summary text, subject text,
  salience real not null default 50, arousal real not null default 0.5,
  stability_hours real not null default 24, stability_mult real not null default 1,
  times_said integer not null default 0, hits integer not null default 0,
  revisions integer not null default 0, created_at integer not null,
  last_seen_at integer not null, last_hit_at integer, archived integer not null default 0,
  sealed integer not null default 0, source_raw_id text, old_text text, evidence text
) strict;
create table memory_raw (
  id text primary key not null, turn_id text not null, role text not null,
  text text not null, created_at integer not null, meta text
) strict;
create table memory_link (
  id text primary key not null, from_id text not null, to_id text not null,
  relation text not null, weight real not null, hits integer not null,
  last_fired_at integer not null, decayed_at integer not null,
  created_at integer not null, approved integer not null, surreal integer not null
) strict;
''';

  final b = StringBuffer(schema);
  if (withRows) {
    final at = DateTime(2026, 11, 17, 20, 0).millisecondsSinceEpoch;
    b
      ..writeln(
        "insert into memory_fact (id, kind, category, channel, text, salience, "
        "created_at, last_seen_at, evidence) values "
        "('m-a8f1fdb5c240','fact','person','gist','用户名叫小林。',62.0,$at,$at,"
        "'[{\"source\":\"USER\",\"quote\":\"我叫小林\"}]');",
      )
      ..writeln(
        "insert into memory_fact (id, kind, category, channel, text, salience, "
        "created_at, last_seen_at) values "
        "('m-c97348d90b1f','fact','person','gist','小林在做空谷这个桌面应用。',70.0,$at,$at);",
      )
      ..writeln(
        "insert into memory_fact (id, kind, category, channel, text, salience, "
        "created_at, last_seen_at, archived) values "
        "('m-archived00001','fact','event','gist','上次说要去爬山。',40.0,$at,$at,1);",
      )
      ..writeln(
        "insert into memory_raw (id, turn_id, role, text, created_at) values "
        "('r-1','t-1','user','我叫小林', $at);",
      )
      ..writeln(
        "insert into memory_raw (id, turn_id, role, text, created_at) values "
        "('r-2','t-1','assistant','记住了。', $at);",
      )
      ..writeln(
        "insert into memory_link (id, from_id, to_id, relation, weight, hits, "
        "last_fired_at, decayed_at, created_at, approved, surreal) values "
        "('l-1','m-a8f1fdb5c240','m-c97348d90b1f','related',0.8,0,$at,$at,$at,1,0);",
      );
  }

  final p = await Process.start('/usr/bin/sqlite3', [dbPath]);
  p.stdin.write(b.toString());
  await p.stdin.close();
  final code = await p.exitCode;
  if (code != 0) {
    final err = await p.stderr.transform(utf8.decoder).join();
    throw StateError('建库失败：$err');
  }
}
