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

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('ondra-transfer-test-');
    engine = TransferEngine(home: tmp.path, now: () => fixedNow);
    // 备份引擎默认指向真实的 HOME。测试里换成空实现，绝不碰用户的备份目录。
    backupOverviewLoader = () async => BackupOverview.empty;
    backupCreate = ({BackupTrigger trigger = BackupTrigger.manual}) async =>
        const BackupOpResult(ok: false, message: '测试环境不做备份');
    await _seedDb('${tmp.path}/.ondra/user/ondra.db');
  });

  tearDown(() async {
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
    await File(
      '${tmp.path}/.ondra/prefs.json',
    ).writeAsString('{"themeMode":"dark"}');
    final out = await Directory('${tmp.path}/out').create();

    final r = await engine.exportBundle(out.path);
    expect(r.ok, isTrue, reason: r.message);

    final dir = Directory(r.path!);
    expect(dir.existsSync(), isTrue);
    final prefs = File('${dir.path}/偏好.json');
    expect(prefs.existsSync(), isTrue);
    expect(await prefs.readAsString(), contains('dark'));
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
}

/// 造一个只有记忆三张表的库。
///
/// 不抄完整的 `ondra.db`（25 张表）：这里要验的是「导入导出能不能对上」，
/// 多建二十张空表只会让失败时的排查变难。
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
