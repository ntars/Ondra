import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_engine_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_model.dart';

/// 备份引擎的验收：在临时目录里跑真实的读写。
///
/// 不用 mock 文件系统——这个引擎全部的难点都在「内容寻址 + 覆盖写 + 清理」
/// 这三件事的先后顺序上，把它们换成一个假的目录结构，测出来的就不是它了。
void main() {
  late Directory tmp;
  late BackupEngine engine;
  var tick = 0;
  late DateTime Function() engineClock;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('ondra-backup-test-');
    _tmpRoot = tmp;
    tick = 0;
    // 每问一次时间就往前拨一分钟：目录名要能区分开，否则同一秒里建的几份
    // 会互相加 `-2`，测起来分不清谁是谁。时钟同时喂给引擎与调度器——
    // 两者用不同的时钟，「刚建完就查」会被算成「隔了两小时」，测试会误报。
    DateTime clock() => DateTime(2026, 11, 17, 21, 3).add(Duration(minutes: tick++));
    engine = BackupEngine(home: tmp.path, now: clock);
    engineClock = clock;

    await _write('user/beichen/profile.json', '{"name":"北宸"}');
    await _write('user/beichen/notes/a.md', '# 笔记\n第一行');
    await _write('prefs.json', '{"themeMode":"system"}');
    await _write('sessions/s1/session.v4.jsonl', '{"m":"hello"}');
    await _write('sessions/s1/session.lock', 'locked');
    await _write('dsh/profiles/ondra/cordis.patch.yml', 'plugins: []');
    await _write('dsh/profiles/ondra/package.json', '{"name":"ondra"}');
    // 以下都不该进快照。
    await _write('dsh/profiles/ondra/node_modules/x/index.js', 'x');
    await _write('logs/ondra-code.log', 'noise');
    await _write('.credentials.yaml', 'apiKey: secret');
    await _write('user/.DS_Store', 'junk');
  });

  tearDown(() async {
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  test('首次备份：收该收的，跳过该跳的', () async {
    final result = await engine.create();
    expect(result.ok, isTrue, reason: result.message);

    final overview = await engine.load();
    expect(overview.snapshots, hasLength(1));

    final paths = overview.snapshots.first.files.map((f) => f.path).toSet();
    expect(paths, contains('user/beichen/profile.json'));
    expect(paths, contains('prefs.json'));
    expect(paths, contains('dsh/profiles/ondra/cordis.patch.yml'));
    // 日志、密钥、依赖树、Finder 缓存、运行时锁都不收。
    expect(paths.any((p) => p.contains('node_modules')), isFalse);
    expect(paths.any((p) => p.startsWith('logs/')), isFalse);
    expect(paths.contains('.credentials.yaml'), isFalse);
    expect(paths.any((p) => p.endsWith('.DS_Store')), isFalse);
    expect(paths.any((p) => p.endsWith('.lock')), isFalse);

    // 第一份要把每个文件都写进对象库。
    expect(overview.snapshots.first.newFiles, overview.snapshots.first.fileCount);
    expect(overview.storedBytes, greaterThan(0));
  });

  test('内容没变时不重复存：第二份只写清单', () async {
    await engine.create();
    final first = await engine.load();
    final storedAfterFirst = first.storedBytes;

    final second = await engine.create();
    expect(second.ok, isTrue, reason: second.message);

    final after = await engine.load();
    expect(after.snapshots, hasLength(2));
    expect(after.storedBytes, storedAfterFirst, reason: '一个字节都没变，对象库不该增长');
    expect(after.snapshots.first.newFiles, 0);
    expect(after.snapshots.first.newBytes, 0);
    expect(after.snapshots.first.savedBytes, after.snapshots.first.sourceBytes);
  });

  test('只改一个文件：只新增那一个对象', () async {
    await engine.create();
    await _write('user/beichen/profile.json', '{"name":"北宸","mood":"calm"}');

    await engine.create();
    final overview = await engine.load();
    expect(overview.snapshots.first.newFiles, 1);
    expect(
      overview.snapshots.first.newBytes,
      lessThan(overview.snapshots.first.sourceBytes),
      reason: '增量备份的字节数必须小于整份大小',
    );
  });

  test('恢复：内容回滚，且先存一份「恢复前」的底', () async {
    final older = await engine.create();
    final original = await _read('user/beichen/notes/a.md');
    await _write('user/beichen/notes/a.md', '改坏了');
    await engine.create();

    final result = await engine.restore(older.snapshotId!);
    expect(result.ok, isTrue, reason: result.message);
    expect(await _read('user/beichen/notes/a.md'), original);

    final overview = await engine.load();
    final pre = overview.snapshots.where(
      (s) => s.trigger == BackupTrigger.preRestore,
    );
    expect(pre, hasLength(1), reason: '恢复前必须留一份能反悔的底');
    // 反悔：把「改坏了」那版找回来。
    final bad = overview.snapshots.firstWhere(
      (s) => s.trigger == BackupTrigger.manual && s.id != older.snapshotId,
    );
    await engine.restore(bad.id);
    expect(await _read('user/beichen/notes/a.md'), '改坏了');
  });

  test('恢复不删快照外多出来的文件', () async {
    final older = await engine.create();
    await _write('user/beichen/new.md', '这段时间新写的');
    await engine.create();

    await engine.restore(older.snapshotId!);
    expect(await File('${tmp.path}/user/beichen/new.md').exists(), isTrue);
  });

  test('删除快照会回收只被它引用的对象', () async {
    final only = await engine.create();
    final before = (await engine.load()).storedBytes;

    final result = await engine.delete(only.snapshotId!);
    expect(result.ok, isTrue, reason: result.message);

    final after = await engine.load();
    expect(after.snapshots, isEmpty);
    expect(after.storedBytes, lessThan(before));
  });

  test('两份快照共用内容时，删一份不回收被另一份引用的对象', () async {
    final first = await engine.create();
    await engine.create();
    final before = (await engine.load()).storedBytes;

    await engine.delete(first.snapshotId!);
    final after = await engine.load();
    expect(after.storedBytes, before, reason: '内容还被第二份用着');
    expect(after.snapshots, hasLength(1));
  });

  test('超额时从最旧的开始裁掉', () async {
    for (var i = 0; i < 4; i++) {
      await engine.create();
    }
    await engine.writeSettings(const BackupSettings(keep: 2));
    // 再建一份触发裁剪。
    await engine.create();

    final overview = await engine.load();
    expect(overview.snapshots.length, lessThanOrEqualTo(2));
  });

  test('导出成一个自包含目录，再导回来', () async {
    await engine.create();
    final snapshot = (await engine.load()).snapshots.first;
    final outDir = '${tmp.path}-export';
    addTearDown(() async {
      final d = Directory(outDir);
      if (await d.exists()) await d.delete(recursive: true);
    });

    final exported = await engine.exportTo(snapshot.id, outDir);
    expect(exported.ok, isTrue, reason: exported.message);
    expect(await File('$outDir/ondra-snapshot.json').exists(), isTrue);
    expect(
      await File('$outDir/user/beichen/profile.json').exists(),
      isTrue,
      reason: '导出的目录里必须是原样的文件，不是指纹',
    );

    final imported = await engine.importFrom(outDir);
    expect(imported.ok, isTrue, reason: imported.message);

    final overview = await engine.load();
    final back = overview.snapshots.firstWhere(
      (s) => s.trigger == BackupTrigger.imported,
    );
    expect(
      back.files.map((f) => f.path).toSet(),
      contains('user/beichen/profile.json'),
    );
    // 内容与已有快照一致，导入不该再占一份空间。
    expect(back.newFiles, 0);
  });

  test('数据目录为空时如实报错，不建空快照', () async {
    final emptyHome = await Directory.systemTemp.createTemp('ondra-empty-');
    addTearDown(() async {
      if (await emptyHome.exists()) await emptyHome.delete(recursive: true);
    });
    final bare = BackupEngine(home: emptyHome.path);
    final result = await bare.create();
    expect(result.ok, isFalse);
    expect((await bare.load()).snapshots, isEmpty);
  });

  test('清单可读：时间、触发来源、总量都能还原', () async {
    await engine.create();
    final raw = jsonDecode(
      await File(
        '${tmp.path}/backups/snapshots/'
        '${(await engine.load()).snapshots.first.id}/manifest.json',
      ).readAsString(),
    ) as Map<String, dynamic>;

    expect(raw['version'], 1);
    expect(raw['trigger'], 'manual');
    expect(raw['files'], isA<List<dynamic>>());
    final totals = raw['totals'] as Map<String, dynamic>;
    expect(totals['files'], (raw['files'] as List<dynamic>).length);
  });

  test('自动备份：没到点不动手，到点才建', () async {
    final scheduler = BackupScheduler(engine, now: engineClock);
    // 默认 auto = true，但 lastAt 为空 → 立刻建一份。
    await scheduler.tick();
    expect((await engine.load()).snapshots, hasLength(1));
    expect((await engine.load()).snapshots.first.trigger, BackupTrigger.auto);

    // 刚建完，再查一次不该多出一份。
    await scheduler.tick();
    expect((await engine.load()).snapshots, hasLength(1));

    // 关掉之后永远不动。
    await engine.writeSettings(
      (await engine.readSettings()).copyWith(auto: false),
    );
    await scheduler.tick();
    expect((await engine.load()).snapshots, hasLength(1));
  });
}

Future<void> _write(String rel, String content) async {
  final file = File('${_tmpRoot.path}/$rel');
  await file.parent.create(recursive: true);
  await file.writeAsString(content);
}

Future<String> _read(String rel) => File('${_tmpRoot.path}/$rel').readAsString();

/// 当前用例的临时根目录。辅助函数在 `setUp` 之外定义，拿不到局部变量，
/// 只能共用一个顶层引用——它在 `setUp` 里每次重新绑定。
late Directory _tmpRoot;
