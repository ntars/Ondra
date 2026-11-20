import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_actions.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_model.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-status/ui/status_source_io.dart';

/// 状态面板读数的真目录测试。
///
/// 每个用例在临时目录里造一个 `~/.ondra`：建库、放会话文件、写三份日志。
/// 断言的是「读到的数字是不是文件里真的有的那些」——这一页的全部价值在于
/// 它说的是真话，所以测试也只能对着真文件说。
void main() {
  late Directory tmp;
  final now = DateTime(2026, 11, 17, 21, 30);

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('ondra-status-test-');
    backupOverviewLoader = () async => BackupOverview.empty;
  });

  tearDown(() async {
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  test('没有库时如实说没有，不报错', () async {
    final snap = await loadStatus(now: () => now, home: tmp.path);
    expect(snap.facts, 0);
    expect(snap.note, contains('还没有记忆库'));
    // 三行监测源仍然在：没有数据不等于没有这条通道。
    expect(snap.sources.length, 3);
    expect(snap.sources.every((s) => s.count == 0), isTrue);
  });

  test('接入状态来自对话连接，不依赖特定网关或记忆库是否存在', () async {
    chatClient.useTransport(_ConnectedTransport());
    addTearDown(() {
      chatClient.stop();
      chatClient.useTransport(const UnavailableTransport());
    });
    await chatClient.connect();
    var snap = await loadStatus(home: tmp.path);
    expect(snap.kernelOnline, isTrue);
    expect(snap.kernelDetail, '对话内核已连接');
    chatClient.stop();
    snap = await loadStatus(home: tmp.path);
    expect(snap.kernelOnline, isFalse);
  });

  test('读得出记忆、今日活跃与沉淀率', () async {
    await _seedDb('${tmp.path}/.ondra/user/ondra.db', now: now);
    final snap = await loadStatus(now: () => now, home: tmp.path);

    expect(snap.facts, 2);
    expect(snap.raws, 3);
    expect(snap.links, 1);
    expect(snap.rawsLastDay, 2, reason: '三条原文里两条在 24 小时内');
    expect(snap.sinkRate, '67%', reason: '2 / 3');
    expect(snap.metrics.length, 3);
    expect(snap.metrics.first.value, '2 条');
  });

  test('会话与插件条目按目录真数', () async {
    await _seedDb('${tmp.path}/.ondra/user/ondra.db', now: now);
    final session = Directory('${tmp.path}/.ondra/dsh/sessions/proj/s1');
    await session.create(recursive: true);
    await File('${session.path}/session.v4.jsonl').writeAsString('{}\n');

    final patch = File(
      '${tmp.path}/.ondra/dsh/profiles/ondra/cordis.patch.yml',
    );
    await patch.parent.create(recursive: true);
    await patch.writeAsString('''
plugins:
  - id: ondra-identity
  - id: ondra-memory-core
  # - id: ondra-store-memory
''');

    final snap = await loadStatus(now: () => now, home: tmp.path);
    expect(snap.sessions, 1);
    expect(snap.plugins, 2, reason: '注释掉的那条不算在装配里');
  });

  test('三份日志各算一条源，字节数与最近时间都是真的', () async {
    await _seedDb('${tmp.path}/.ondra/user/ondra.db', now: now);
    final logs = Directory('${tmp.path}/.ondra/logs');
    await logs.create(recursive: true);
    await File('${logs.path}/ondra-code.log').writeAsString('x' * 2048);
    await File('${logs.path}/window.log').writeAsString('y' * 16);

    final snap = await loadStatus(now: () => now, home: tmp.path);
    final plugin = snap.sources.firstWhere((s) => s.label == '插件事件');
    final system = snap.sources.firstWhere((s) => s.label == '系统事件');

    expect(plugin.count, 2048);
    expect(plugin.unit, 'B');
    expect(plugin.online, isTrue, reason: '刚写的文件，24 小时内');
    expect(system.count, 16);
  });

  test('启动体检：从日志尾部取窗口内的告警，同因只留一条', () async {
    await _seedDb('${tmp.path}/.ondra/user/ondra.db', now: now);
    final logs = Directory('${tmp.path}/.ondra/logs');
    await logs.create(recursive: true);
    final stamp = '${now.year.toString().padLeft(4, '0')}-11-17 21:16:25';
    final log = [
      '$stamp INFO  [ondra.store-sqlite] 存储就绪',
      '$stamp WARN  [ondra.memory-pool] 没有可用存储端口（store 与 memory 都缺席）：池归属无处可放',
      '$stamp WARN  [ondra.memory-pool] 没有可用存储端口（store 与 memory 都缺席）：八池服务转不可用',
      '$stamp ERROR [ondra.persona-loader] 出厂人设不在位',
      '2026-11-16 09:00:00 WARN  [ondra.stale] 这是上一次启动的，不该算进来',
    ].join('\n');
    await File('${logs.path}/ondra-code.log').writeAsString(log);

    final snap = await loadStatus(now: () => now, home: tmp.path);
    expect(snap.bootWarnings, 2);
    expect(snap.bootErrors, 1);
    // 同一个插件同一件事的两句话合并成一条；错误排最前。
    expect(snap.bootIssues.first.scope, 'ondra.persona-loader');
    expect(snap.bootIssues.first.isError, isTrue);
    expect(snap.bootIssues.length, 2);
    expect(snap.bootClean, isFalse);
  });

  test('情绪表有值就出读数，零行时给的是空而不是 0', () async {
    await _seedDb('${tmp.path}/.ondra/user/ondra.db', now: now);
    var snap = await loadStatus(now: () => now, home: tmp.path);
    expect(snap.emotion, isNull);

    await _runSql('${tmp.path}/.ondra/user/ondra.db', '''
create table emotion_state (
  id text primary key not null, axes text not null, labels text not null,
  hormones text not null, dynamic text not null default '[]',
  temperament text not null, settled_at integer not null, updated_at integer not null
) strict;
insert into emotion_state (id, axes, labels, hormones, temperament, settled_at, updated_at)
values ('main', '{"valence":-0.4,"arousal":0.7}', '["有点低落"]', '{}', 'calm', ${now.millisecondsSinceEpoch}, ${now.millisecondsSinceEpoch});
''');

    snap = await loadStatus(now: () => now, home: tmp.path);
    expect(snap.emotion, isNotNull);
    expect(snap.emotion!.valence, closeTo(-0.4, 0.001));
    expect(snap.emotion!.arousal, closeTo(0.7, 0.001));
    expect(snap.emotion!.label, '有点低落');
  });
}

class _ConnectedTransport implements DshTransport {
  @override
  void dispose() {}
  @override
  Future<void> connect() async {}

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) => const Stream.empty();

  @override
  void stop() {}

  @override
  void resetSession() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}

Future<void> _seedDb(String dbPath, {required DateTime now}) async {
  await Directory(File(dbPath).parent.path).create(recursive: true);
  final at = now.millisecondsSinceEpoch;
  final old = now.subtract(const Duration(days: 3)).millisecondsSinceEpoch;

  await _runSql(dbPath, '''
create table memory_fact (
  id text primary key not null, kind text not null, category text not null,
  channel text not null, text text not null, salience real not null default 50,
  created_at integer not null, archived integer not null default 0
) strict;
create table memory_raw (
  id text primary key not null, turn_id text not null, role text not null,
  text text not null, created_at integer not null
) strict;
create table memory_link (
  id text primary key not null, from_id text not null, to_id text not null,
  relation text not null, weight real not null, approved integer not null default 1
) strict;
insert into memory_fact (id, kind, category, channel, text, created_at)
  values ('m-1','fact','person','gist','用户名叫小林。',$at);
insert into memory_fact (id, kind, category, channel, text, created_at)
  values ('m-2','fact','person','gist','小林在做空谷。',$at);
insert into memory_raw (id, turn_id, role, text, created_at) values ('r-1','t','user','a',$at);
insert into memory_raw (id, turn_id, role, text, created_at) values ('r-2','t','assistant','b',$at);
insert into memory_raw (id, turn_id, role, text, created_at) values ('r-3','t0','user','c',$old);
insert into memory_link (id, from_id, to_id, relation, weight) values ('l-1','m-1','m-2','related',0.8);
''');
}

Future<void> _runSql(String dbPath, String sql) async {
  final p = await Process.start('/usr/bin/sqlite3', [dbPath]);
  p.stdin.write(sql);
  await p.stdin.close();
  final code = await p.exitCode;
  if (code != 0) {
    final err = await p.stderr.transform(utf8.decoder).join();
    throw StateError('SQL 失败：$err');
  }
}
