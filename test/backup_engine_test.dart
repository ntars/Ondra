import 'dart:async';
import 'dart:convert';

import 'package:ondra/app/sqlite_cli.dart';

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
    DateTime clock() =>
        DateTime(2026, 11, 17, 21, 3).add(Duration(minutes: tick++));
    engine = BackupEngine(home: tmp.path, now: clock);
    engineClock = clock;

    await _write('user/beichen/profile.json', '{"name":"北宸"}');
    await _write('user/beichen/notes/a.md', '# 笔记\n第一行');
    await _write('prefs.json', '{"themeMode":"system"}');
    await _write('sessions/s1/session.v4.jsonl', '{"m":"hello"}');
    await _write('sessions/s1/session.lock', 'locked');
    await _write('dsh/sessions/project/s1/session.v4.jsonl', '{"m":"actual"}');
    await _write('personas/custom/meta.json', '{"name":"custom"}');
    await _write('personas/custom/SKILL.md', 'persona');
    await _write('user/personas/custom/meta.json', '{"name":"core persona"}');
    await _write(
      'user/personas/Hero.skill.zip',
      'opaque persona archive bytes',
    );
    await _write('models.json', '{"providers":[]}');
    await _write('browser-sites.json', '[]');
    await _write('avatar.png', 'avatar bytes');
    await _write('browser-allowlist.json', 'wrong storage name');
    await _write('user/plugin.js', 'runtime code');
    await _write('user/secrets.json', 'secret');
    await _write('personas/custom/.env', 'secret');
    await _write('personas/custom/package.json', '{"scripts":{}}');
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
    expect(
      paths,
      containsAll([
        'dsh/sessions/project/s1/session.v4.jsonl',
        'personas/custom/meta.json',
        'personas/custom/SKILL.md',
        'user/personas/custom/meta.json',
        'user/personas/Hero.skill.zip',
        'models.json',
        'browser-sites.json',
        'avatar.png',
      ]),
    );
    // dsh/profiles/ 的装配层整体不收；唯一例外是 cordis.patch.yml——
    // 人设选择与各插件的用户配置写在这里，快照不带它恢复后会回旧人设。
    expect(
      paths.where((path) => path.startsWith('dsh/profiles/')),
      ['dsh/profiles/ondra/cordis.patch.yml'],
    );
    expect(paths, isNot(contains('browser-allowlist.json')));
    expect(paths, isNot(contains('user/plugin.js')));
    expect(paths, isNot(contains('user/secrets.json')));
    expect(paths, isNot(contains('personas/custom/.env')));
    expect(paths, isNot(contains('personas/custom/package.json')));
    // 日志、密钥、依赖树、Finder 缓存、运行时锁都不收。
    expect(paths.any((p) => p.contains('node_modules')), isFalse);
    expect(paths.any((p) => p.startsWith('logs/')), isFalse);
    expect(paths.contains('.credentials.yaml'), isFalse);
    expect(paths.any((p) => p.endsWith('.DS_Store')), isFalse);
    expect(paths.any((p) => p.endsWith('.lock')), isFalse);

    // 第一份要把每个文件都写进对象库。
    expect(
      overview.snapshots.first.newFiles,
      overview.snapshots.first.fileCount,
    );
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

  test('人设归档只允许准确树下的规范名称，并参与导出导入恢复', () async {
    for (final name in ['Hero', 'My.Role', 'oh-jingjing', 'role_2']) {
      expect(BackupPaths.isAsset('user/personas/$name.skill.zip'), isTrue);
    }
    for (final path in [
      'user/Hero.skill.zip',
      'personas/Hero.skill.zip',
      'user/Personas/Hero.skill.zip',
      'user/personas/nested/Hero.skill.zip',
      'user/personas/.skill.zip',
      'user/personas/.hidden.skill.zip',
      'user/personas/name..bad.skill.zip',
      'user/personas/name..skill.zip',
      'user/personas/name .skill.zip',
      'user/personas/中文.skill.zip',
      'user/personas/${'a' * 129}.skill.zip',
      'user/personas/Hero.SKILL.ZIP',
      'user/personas/plugin.zip',
      'user/personas/plugin.tgz',
      'user/personas/plugin.js',
      'user/personas/credentials.skill.zip',
      'user/personas/package.json',
      'user/personas/cordis.patch.yml',
    ]) {
      expect(BackupPaths.isAsset(path), isFalse, reason: path);
    }
    final created = await engine.create();
    expect(created.ok, isTrue, reason: created.message);
    final out = await Directory.systemTemp.createTemp('ondra-persona-export-');
    addTearDown(() => out.delete(recursive: true));
    final exported = await engine.exportTo(created.snapshotId!, out.path);
    expect(exported.ok, isTrue, reason: exported.message);
    final imported = await engine.importFrom(out.path);
    expect(imported.ok, isTrue, reason: imported.message);
    await _write('user/personas/Hero.skill.zip', 'changed archive');
    final restored = await engine.restore(imported.snapshotId!);
    expect(restored.ok, isTrue, reason: restored.message);
    expect(
      await _read('user/personas/Hero.skill.zip'),
      'opaque persona archive bytes',
    );
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

  Future<Directory> scratch(String suffix) async {
    final dir = await Directory.systemTemp.createTemp('ondra-backup-$suffix-');
    addTearDown(() async {
      if (await dir.exists()) await dir.delete(recursive: true);
    });
    return dir;
  }

  Future<(String, Directory)> exported() async {
    final created = await engine.create();
    expect(created.ok, isTrue, reason: created.message);
    final dir = await scratch('export');
    final result = await engine.exportTo(created.snapshotId!, dir.path);
    expect(result.ok, isTrue, reason: result.message);
    return (created.snapshotId!, dir);
  }

  File localManifest(String id) =>
      File('${tmp.path}/backups/snapshots/$id/manifest.json');

  Future<void> mutate(
    File file,
    void Function(Map<String, dynamic>) change,
  ) async {
    final raw = jsonDecode(await file.readAsString()) as Map<String, dynamic>;
    change(raw);
    await file.writeAsString(jsonEncode(raw));
  }

  for (final path in [
    '../outside.json',
    '/tmp/outside.json',
    r'C:\outside.json',
    'C:outside.json',
    r'\\server\share\outside.json',
    'user/../../outside.json',
    'user/../prefs.json',
    'user//a.json',
    'user/./a.json',
    'user/a.json/',
    'user/a.json:stream',
    'user/a\u0000.json',
    'user/NUL.json',
    'user/a.json.',
    'user/a.json ',
    'dsh/profiles/ondra/cordis.patch.yml',
    'dsh/profiles/ondra/package.json',
    'runtime/main.js',
    'user/plugins/evil.json',
    'user/code.js',
    'user/.credentials.yaml',
    'user/token.json',
    'user/personas/plugin.zip',
    'user/personas/Hero.js',
    'personas/Hero.skill.zip',
    'user/personas/nested/Hero.skill.zip',
    'user/plugins/Hero.skill.zip',
    'user/personas/Hero..bad.skill.zip',
  ]) {
    test('不安全路径整份拒绝：$path', () async {
      final (id, dir) = await exported();
      final external = File('${dir.path}/ondra-snapshot.json');
      await mutate(external, (raw) => (raw['files'] as List).last['p'] = path);
      final before = await localManifest(id).readAsString();
      final imported = await engine.importFrom(dir.path);
      expect(imported.ok, isFalse, reason: path);
      expect((await engine.load()).snapshots, hasLength(1));
      await localManifest(id).writeAsString(await external.readAsString());
      final userBefore = await _read('prefs.json');
      expect((await engine.restore(id)).ok, isFalse);
      expect(await _read('prefs.json'), userBefore);
      final out = await scratch('rejected-export');
      expect((await engine.exportTo(id, out.path)).ok, isFalse);
      expect(await out.list().isEmpty, isTrue);
      await localManifest(id).writeAsString(before);
      expect((await engine.load()).snapshots, hasLength(1));
    });
  }

  test('重复、大小写别名与文件/目录冲突均拒绝，不能写出部分数据', () async {
    final (id, dir) = await exported();
    final external = File('${dir.path}/ondra-snapshot.json');
    final original = await external.readAsString();
    for (final pair in [
      ['user/a.json', 'user/a.json'],
      ['user/a.json', 'user/A.json'],
      ['user/a.json', 'user/a.json/b.json'],
    ]) {
      await external.writeAsString(original);
      await mutate(external, (raw) {
        (raw['files'] as List)[0]['p'] = pair[0];
        (raw['files'] as List)[1]['p'] = pair[1];
      });
      expect((await engine.importFrom(dir.path)).ok, isFalse);
      await localManifest(id).writeAsString(await external.readAsString());
      expect((await engine.restore(id)).ok, isFalse);
      final out = await scratch('duplicate');
      expect((await engine.exportTo(id, out.path)).ok, isFalse);
      expect(await out.list().isEmpty, isTrue);
    }
  });

  test('无效条目或非法 hash/size 不会被静默跳过', () async {
    final (id, dir) = await exported();
    final external = File('${dir.path}/ondra-snapshot.json');
    final original = await external.readAsString();
    for (final invalid in [
      null,
      {'p': 'prefs.json'},
      {'p': 'prefs.json', 's': -1, 'h': '1234567890abcdef', 'm': 0},
      {'p': 'prefs.json', 's': 1.5, 'h': '1234567890abcdef', 'm': 0},
      {'p': 'prefs.json', 's': 0, 'h': '../../outside', 'm': 0},
    ]) {
      await external.writeAsString(original);
      await mutate(external, (raw) => (raw['files'] as List).add(invalid));
      expect((await engine.importFrom(dir.path)).ok, isFalse);
      expect((await engine.load()).snapshots.single.id, id);
    }
  });

  for (final damage in ['missing', 'hash', 'size']) {
    test('对象 $damage：恢复/导出失败，预检前不存底不写用户数据', () async {
      final result = await engine.create();
      final snapshot = (await engine.load()).snapshots.single;
      final entry = snapshot.files.last;
      final object = File(
        '${tmp.path}/backups/objects/${entry.hash.substring(0, 2)}/${entry.hash}',
      );
      if (damage == 'missing') {
        await object.delete();
      } else if (damage == 'hash') {
        final bytes = await object.readAsBytes();
        bytes[0] ^= 1;
        await object.writeAsBytes(bytes);
      } else {
        await object.writeAsString('extra', mode: FileMode.append);
      }
      await _write('prefs.json', 'CURRENT MUST STAY');
      expect((await engine.restore(result.snapshotId!)).ok, isFalse);
      expect(await _read('prefs.json'), 'CURRENT MUST STAY');
      expect((await engine.load()).snapshots, hasLength(1));
      final out = await scratch('bad-object');
      expect((await engine.exportTo(result.snapshotId!, out.path)).ok, isFalse);
      expect(await out.list().isEmpty, isTrue);
      if (damage != 'missing') expect((await engine.create()).ok, isFalse);
    });
  }

  test('导入缺文件或内容损坏失败，不重算 hash 接受篡改', () async {
    final (id, dir) = await exported();
    final src = File('${dir.path}/prefs.json');
    final original = await src.readAsBytes();
    final changed = original.toList()..[0] ^= 1;
    await src.writeAsBytes(changed);
    expect((await engine.importFrom(dir.path)).ok, isFalse);
    await src.delete();
    expect((await engine.importFrom(dir.path)).ok, isFalse);
    expect((await engine.load()).snapshots.single.id, id);
  });

  test('快照 id 不可用作路径，manifest id 必须匹配目录', () async {
    final (id, _) = await exported();
    for (final malicious in ['../..', '/tmp', r'C:\tmp', 'a/b']) {
      expect((await engine.restore(malicious)).ok, isFalse);
      expect((await engine.delete(malicious)).ok, isFalse);
      expect(
        (await engine.exportTo(malicious, '${tmp.path}-unused')).ok,
        isFalse,
      );
    }
    await mutate(localManifest(id), (raw) => raw['id'] = 'other');
    expect((await engine.restore(id)).ok, isFalse);
    expect((await engine.create()).ok, isFalse, reason: '坏旧清单不能被 GC 忽略');
  });

  test('源文件在捕获后改变：hash 与写入对象仍来自同一份字节', () async {
    final original = await _read('prefs.json');
    final changing = BackupEngine(
      home: tmp.path,
      now: () {
        File('${tmp.path}/prefs.json')
            .writeAsStringSync('CHANGED AFTER CAPTURE');
        return DateTime(2026, 11, 18);
      },
    );
    final created = await changing.create();
    expect(created.ok, isTrue, reason: created.message);
    final out = await scratch('same-bytes');
    expect((await changing.exportTo(created.snapshotId!, out.path)).ok, isTrue);
    expect(await File('${out.path}/prefs.json').readAsString(), original);
    expect(await _read('prefs.json'), 'CHANGED AFTER CAPTURE');
  });

  test('单文件路径变成目录时读取失败，不能生成漏项快照', () async {
    await File('${tmp.path}/prefs.json').delete();
    await Directory('${tmp.path}/prefs.json').create();
    expect((await engine.create()).ok, isFalse);
    expect((await engine.load()).snapshots, isEmpty);
    expect((await engine.load()).note, contains('读取失败'));
  });

  test('采集拒绝目录、文件和悬空 symlink', () async {
    final outside = await scratch('outside');
    await File('${outside.path}/external.json').writeAsString('outside');
    for (final link in [
      ('user/link.json', '${outside.path}/external.json'),
      ('user/linked', outside.path),
      ('user/missing.json', '${outside.path}/missing.json'),
    ]) {
      final symlink = Link('${tmp.path}/${link.$1}');
      await symlink.create(link.$2);
      expect((await engine.create()).ok, isFalse);
      await symlink.delete();
    }
    await Directory('${tmp.path}/user').delete(recursive: true);
    await Link('${tmp.path}/user').create(outside.path);
    expect((await engine.create()).ok, isFalse, reason: '采集树本身也必须检查');
  });

  test('导入源 symlink 与清单 symlink 不得逃逸或产生部分快照', () async {
    final (id, dir) = await exported();
    final outside = await scratch('source-link');
    final src = File('${dir.path}/prefs.json');
    await src.copy('${outside.path}/prefs.json');
    await src.delete();
    await Link(src.path).create('${outside.path}/prefs.json');
    expect((await engine.importFrom(dir.path)).ok, isFalse);
    await Link(src.path).delete();
    await File('${outside.path}/prefs.json').copy(src.path);
    final manifest = File('${dir.path}/ondra-snapshot.json');
    await manifest.copy('${outside.path}/ondra-snapshot.json');
    await manifest.delete();
    await Link(manifest.path).create('${outside.path}/ondra-snapshot.json');
    expect((await engine.importFrom(dir.path)).ok, isFalse);
    expect((await engine.load()).snapshots.single.id, id);
  });

  test('恢复和导出完整检查所有目标，symlink 后的外部文件不变', () async {
    final (id, _) = await exported();
    final outside = await scratch('target-link');
    final sentinel = File('${outside.path}/profile.json');
    await sentinel.writeAsString('DO NOT TOUCH');
    await Directory('${tmp.path}/user/beichen').delete(recursive: true);
    await Link('${tmp.path}/user/beichen').create(outside.path);
    await _write('prefs.json', 'CURRENT');
    expect((await engine.restore(id)).ok, isFalse);
    expect(await _read('prefs.json'), 'CURRENT');
    expect(await sentinel.readAsString(), 'DO NOT TOUCH');
    final out = await scratch('export-link');
    await Directory('${out.path}/user').create();
    await Link('${out.path}/user/beichen').create(outside.path);
    expect((await engine.exportTo(id, out.path)).ok, isFalse);
    expect(await File('${out.path}/prefs.json').exists(), isFalse);
    expect(await sentinel.readAsString(), 'DO NOT TOUCH');
  });

  test('即使 symlink 留在 home 内也不能绕到运行时代码', () async {
    final created = await engine.create();
    await File('${tmp.path}/prefs.json').delete();
    final runtime = File('${tmp.path}/dsh/profiles/ondra/package.json');
    final before = await runtime.readAsString();
    await Link('${tmp.path}/prefs.json').create(runtime.path);
    expect((await engine.restore(created.snapshotId!)).ok, isFalse);
    expect(await runtime.readAsString(), before);
  });

  test('对象、分片、仓库目录中的 symlink 一律拒绝', () async {
    final created = await engine.create();
    final entry = (await engine.load()).snapshots.single.files.first;
    final object = File(
      '${tmp.path}/backups/objects/${entry.hash.substring(0, 2)}/${entry.hash}',
    );
    final outside = await scratch('repo-link');
    final copy = await object.copy('${outside.path}/object');
    await object.delete();
    await Link(object.path).create(copy.path);
    expect((await engine.restore(created.snapshotId!)).ok, isFalse);
    expect(
      (await engine.exportTo(created.snapshotId!, '${outside.path}/export')).ok,
      isFalse,
    );
    await Link(object.path).delete();
    await copy.copy(object.path);
    final shard = object.parent;
    await shard.rename('${outside.path}/shard');
    await Link(shard.path).create('${outside.path}/shard');
    expect((await engine.restore(created.snapshotId!)).ok, isFalse);
    await Link(shard.path).delete();
    await Directory('${outside.path}/shard').rename(shard.path);
    await Directory('${tmp.path}/backups').rename('${outside.path}/backups');
    await Link('${tmp.path}/backups').create('${outside.path}/backups');
    expect((await engine.create()).ok, isFalse);
    expect((await engine.delete(created.snapshotId!)).ok, isFalse);
  });

  test('导出不允许覆盖数据根或上级目录', () async {
    final created = await engine.create();
    expect((await engine.exportTo(created.snapshotId!, tmp.path)).ok, isFalse);
    expect(
      (await engine.exportTo(created.snapshotId!, '${tmp.path}/export')).ok,
      isFalse,
    );
    expect(
      (await engine.exportTo(created.snapshotId!, tmp.parent.path)).ok,
      isFalse,
    );
  });

  Future<String> sql(String database, String statement) async {
    final result = await Process.run(ondraSqliteCli!, [
      '-batch',
      '-bail',
      database,
      statement,
    ]);
    expect(result.exitCode, 0, reason: '${result.stderr}');
    return '${result.stdout}'.trim();
  }

  Future<Process> holdDatabase(String database, String statements) async {
    final process = await Process.start(ondraSqliteCli!, [
      '-batch',
      '-bail',
      database,
    ]);
    final ready = Completer<void>();
    final output = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          if (line == 'ready' && !ready.isCompleted) ready.complete();
        });
    final errors = process.stderr.transform(utf8.decoder).join();
    addTearDown(() async {
      process.kill();
      await process.exitCode;
      await process.stdin.close();
      await output.cancel();
      await errors;
    });
    process.stdin.writeln('$statements SELECT \'ready\';');
    await process.stdin.flush();
    await ready.future.timeout(const Duration(seconds: 10));
    return process;
  }

  Future<Map<String, (int, String)>> inventory() async {
    final out = <String, (int, String)>{};
    await for (final entity in tmp.list(recursive: true, followLinks: false)) {
      if (entity is File) {
        out[entity.path] = (
          (await entity.stat()).modified.microsecondsSinceEpoch,
          base64Encode(await entity.readAsBytes()),
        );
      }
    }
    return out;
  }

  test('SQLite 恢复必须显式独占：不同 home 及 false 均零写入，随后持有 lease 可恢复', () async {
    final database = '${tmp.path}/user/ondra.db';
    await sql(
      database,
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('old');",
    );
    final created = await engine.create();
    expect(created.ok, isTrue, reason: created.message);
    await sql(database, "UPDATE evidence SET value='current';");
    await _write('prefs.json', 'CURRENT');
    final before = await inventory();
    final defaultResult = await engine.restore(created.snapshotId!);
    expect(defaultResult.ok, isFalse);
    expect(defaultResult.snapshotId, isNull);
    expect(await inventory(), before, reason: '不同 home 不代表数据库已经停机');
    var offline = false;
    var checks = 0;
    final guarded = BackupEngine(
      home: tmp.path,
      now: engineClock,
      dataIsOffline: () {
        checks++;
        return offline;
      },
    );
    final denied = await guarded.restore(created.snapshotId!);
    expect(denied.ok, isFalse);
    expect(denied.message, contains('维护独占'));
    expect(checks, 1);
    expect(denied.snapshotId, isNull);
    expect(await inventory(), before, reason: '拒绝时连存底、WAL/SHM 也不能写入');
    offline = true;
    final restored = await guarded.restore(created.snapshotId!);
    expect(restored.ok, isTrue, reason: restored.message);
    expect(
      await sql(
        database,
        'PRAGMA integrity_check; SELECT value FROM evidence;',
      ),
      'ok\nold',
    );
  });

  test('SQLite 各后缀及按文件头识别的库往返恢复，恢复前快照可回滚', () async {
    final databases = [
      'user/a.db',
      'user/b.sqlite',
      "user/quoted 'db'.sqlite3",
      'user/header.json',
    ];
    for (final rel in databases) {
      await sql(
        '${tmp.path}/$rel',
        "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('old');",
      );
    }
    final created = await engine.create();
    expect(created.ok, isTrue, reason: created.message);
    for (final rel in databases) {
      await sql(
        '${tmp.path}/$rel',
        "UPDATE evidence SET value='current'; CREATE TABLE added(id INTEGER);",
      );
    }
    await _write('prefs.json', 'CURRENT');
    final guarded = BackupEngine(
      home: tmp.path,
      now: engineClock,
      dataIsOffline: () => true,
    );
    final restored = await guarded.restore(created.snapshotId!);
    expect(restored.ok, isTrue, reason: restored.message);
    expect(restored.snapshotId, isNotNull);
    for (final rel in databases) {
      expect(
        await sql(
          '${tmp.path}/$rel',
          'PRAGMA integrity_check; SELECT value FROM evidence;',
        ),
        'ok\nold',
      );
      expect(
        await sql(
          '${tmp.path}/$rel',
          "SELECT count(*) FROM sqlite_master WHERE name='added';",
        ),
        '0',
      );
    }
    final snapshots = (await guarded.load()).snapshots;
    expect(
      snapshots.singleWhere((s) => s.id == restored.snapshotId).trigger,
      BackupTrigger.preRestore,
    );
    final rollback = await guarded.restore(restored.snapshotId!);
    expect(rollback.ok, isTrue, reason: rollback.message);
    expect(await _read('prefs.json'), 'CURRENT');
    for (final rel in databases) {
      expect(
        await sql('${tmp.path}/$rel', 'SELECT value FROM evidence;'),
        'current',
      );
    }
  });

  test('SQLite 恢复允许目标库及父目录不存在', () async {
    final directory = Directory('${tmp.path}/storages/deleted');
    await directory.create(recursive: true);
    final database = '${directory.path}/new.db';
    await sql(
      database,
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('old');",
    );
    final created = await engine.create();
    expect(created.ok, isTrue, reason: created.message);
    await directory.delete(recursive: true);
    final guarded = BackupEngine(
      home: tmp.path,
      now: engineClock,
      dataIsOffline: () => true,
    );
    final restored = await guarded.restore(created.snapshotId!);
    expect(restored.ok, isTrue, reason: restored.message);
    expect(
      await sql(
        database,
        'PRAGMA integrity_check; SELECT value FROM evidence;',
      ),
      'ok\nold',
    );
  });

  test('SQLite 残留 WAL 由恢复 API 处理，不重放旧数据；存底包含已提交 WAL', () async {
    final database = '${tmp.path}/user/ondra.db';
    await sql(
      database,
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('old');",
    );
    final created = await engine.create();
    expect(created.ok, isTrue, reason: created.message);
    final writer = await holdDatabase(
      database,
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; "
      "INSERT INTO evidence VALUES ('current WAL'); "
      "BEGIN IMMEDIATE; INSERT INTO evidence VALUES ('uncommitted');",
    );
    writer.kill(ProcessSignal.sigkill);
    await writer.exitCode;
    expect(await File('$database-wal').length(), greaterThan(0));
    expect(await File('$database-shm').exists(), isTrue);
    var offline = false;
    final guarded = BackupEngine(
      home: tmp.path,
      now: engineClock,
      dataIsOffline: () => offline,
    );
    final before = await inventory();
    expect((await guarded.restore(created.snapshotId!)).ok, isFalse);
    expect(await inventory(), before, reason: '未停机时不打开目标库，残留 WAL/SHM 原样保留');
    offline = true;
    final restored = await guarded.restore(created.snapshotId!);
    expect(restored.ok, isTrue, reason: restored.message);
    expect(
      await sql(
        database,
        'PRAGMA integrity_check; SELECT value FROM evidence;',
      ),
      'ok\nold',
    );
    expect(
      await sql(database, 'SELECT value FROM evidence;'),
      'old',
      reason: '再次打开也不能重放旧 WAL',
    );
    final rollback = await guarded.restore(restored.snapshotId!);
    expect(rollback.ok, isTrue, reason: rollback.message);
    expect(
      await sql(
        database,
        'PRAGMA integrity_check; SELECT value FROM evidence;',
      ),
      'ok\nold\ncurrent WAL',
    );
  });

  test('SQLite 异常写锁导致明确失败：保留部分恢复报告及可用回滚快照', () async {
    final database = '${tmp.path}/user/ondra.db';
    await sql(
      database,
      "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('old');",
    );
    final originalPrefs = await _read('prefs.json');
    final created = await engine.create();
    expect(created.ok, isTrue, reason: created.message);
    await sql(database, "UPDATE evidence SET value='current';");
    await _write('prefs.json', 'CURRENT');
    final writer = await holdDatabase(
      database,
      "BEGIN IMMEDIATE; INSERT INTO evidence VALUES ('uncommitted');",
    );
    final guarded = BackupEngine(
      home: tmp.path,
      now: engineClock,
      dataIsOffline: () => true,
    );
    final restored = await guarded.restore(created.snapshotId!);
    expect(restored.ok, isFalse);
    expect(restored.message, contains('SQLite 恢复失败'));
    expect(
      restored.message,
      matches(RegExp('locked|busy', caseSensitive: false)),
    );
    expect(restored.message, contains('部分恢复'));
    expect(restored.snapshotId, isNotNull);
    expect(restored.message, contains(restored.snapshotId!));
    expect(
      await sql(
        database,
        'PRAGMA integrity_check; SELECT value FROM evidence;',
      ),
      'ok\ncurrent',
    );
    expect(
      await _read('prefs.json'),
      originalPrefs,
      reason: '前面的普通文件已写入，不能声称整批原子成功',
    );
    final out = await scratch('locked-safety');
    final exported = await guarded.exportTo(restored.snapshotId!, out.path);
    expect(exported.ok, isTrue, reason: exported.message);
    expect(await File('${out.path}/prefs.json').readAsString(), 'CURRENT');
    expect(
      await sql('${out.path}/user/ondra.db', 'SELECT value FROM evidence;'),
      'current',
    );
    writer.stdin.writeln('ROLLBACK;');
    await writer.stdin.close();
    await writer.exitCode;
    final rollback = await guarded.restore(restored.snapshotId!);
    expect(rollback.ok, isTrue, reason: rollback.message);
    expect(await _read('prefs.json'), 'CURRENT');
    expect(await sql(database, 'SELECT value FROM evidence;'), 'current');
  });

  test('SQLite 全部预检先于 offline：缺 CLI、坏对象、旁文件 symlink 都不询问 lease', () async {
    final database = '${tmp.path}/user/ondra.db';
    await sql(database, 'CREATE TABLE evidence(value TEXT);');
    final created = await engine.create();
    expect(created.ok, isTrue, reason: created.message);
    var checks = 0;
    final guarded = BackupEngine(
      home: tmp.path,
      dataIsOffline: () {
        checks++;
        return false;
      },
    );
    final before = await inventory();
    debugOverrideSqliteCli(null);
    try {
      final result = await guarded.restore(created.snapshotId!);
      expect(result.ok, isFalse);
      expect(result.message, contains('缺少 sqlite3'));
      expect(checks, 0);
      expect(await inventory(), before);
    } finally {
      debugResetSqliteCli();
    }
    final outside = await scratch('restore-sidecar');
    final sentinel = File('${outside.path}/sentinel');
    await sentinel.writeAsString('UNCHANGED');
    for (final suffix in ['-wal', '-shm', '-journal']) {
      final link = Link('$database$suffix');
      await link.create(sentinel.path);
      final result = await guarded.restore(created.snapshotId!);
      expect(result.ok, isFalse);
      expect(result.message, contains('符号链接'));
      expect(checks, 0);
      expect(await inventory(), before);
      expect(await sentinel.readAsString(), 'UNCHANGED');
      await link.delete();
    }
    final snapshot = (await engine.load()).snapshots.single;
    final entry = snapshot.files.last;
    final object = File(
      '${tmp.path}/backups/objects/${entry.hash.substring(0, 2)}/${entry.hash}',
    );
    await object.writeAsString('broken');
    final damaged = await inventory();
    final result = await guarded.restore(created.snapshotId!);
    expect(result.ok, isFalse);
    expect(result.message, contains('hash/size'));
    expect(checks, 0);
    expect(await inventory(), damaged);
  });

  test('SQLite 在线副本包含 WAL 已提交数据，不含未提交事务；恢复保守拒绝', () async {
    final cli = ondraSqliteCli;
    expect(cli, isNotNull, reason: '此验收需要已有 sqlite3；不自动安装');
    final database = '${tmp.path}/user/ondra.db';
    final writer = await Process.start(cli!, ['-batch', database]);
    final ready = Completer<void>();
    final output = writer.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          if (line == 'ready' && !ready.isCompleted) ready.complete();
        });
    final errors = writer.stderr.transform(utf8.decoder).join();
    addTearDown(() async {
      await writer.stdin.close();
      await writer.exitCode;
      await output.cancel();
      await errors;
    });
    writer.stdin.writeln(
      'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; '
      'CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES (\'committed in WAL\'); '
      'BEGIN; INSERT INTO evidence VALUES (\'uncommitted\'); SELECT \'ready\';',
    );
    await writer.stdin.flush();
    await ready.future.timeout(const Duration(seconds: 10));
    expect(await File('$database-wal').length(), greaterThan(0));
    final created = await engine.create();
    expect(created.ok, isTrue, reason: created.message);
    final snapshot = (await engine.load()).snapshots.single;
    expect(
      snapshot.files.any(
        (file) => file.path.endsWith('-wal') || file.path.endsWith('-shm'),
      ),
      isFalse,
    );
    final out = await scratch('sqlite-export');
    expect((await engine.exportTo(created.snapshotId!, out.path)).ok, isTrue);
    final query = await Process.run(cli, [
      '-readonly',
      '${out.path}/user/ondra.db',
      'PRAGMA integrity_check; SELECT value FROM evidence;',
    ]);
    expect(query.exitCode, 0, reason: '${query.stderr}');
    expect('${query.stdout}'.trim(), 'ok\ncommitted in WAL');
    await _write('prefs.json', 'CURRENT');
    final result = await engine.restore(created.snapshotId!);
    expect(result.ok, isFalse);
    expect(result.message, contains('暂停内核'));
    expect(await _read('prefs.json'), 'CURRENT');
    expect((await engine.load()).snapshots, hasLength(1));
    expect((await engine.importFrom(out.path)).ok, isTrue);
  });

  test('导出预检最终文件、清单及根目录 symlink，不覆盖外部文件', () async {
    final created = await engine.create();
    final outside = await scratch('export-sentinel');
    final sentinel = File('${outside.path}/sentinel');
    await sentinel.writeAsString('UNCHANGED');
    for (final rel in ['prefs.json', 'ondra-snapshot.json']) {
      final out = await scratch('export-leaf');
      await Link('${out.path}/$rel').create(sentinel.path);
      expect(
        (await engine.exportTo(created.snapshotId!, out.path)).ok,
        isFalse,
      );
      expect(await File('${out.path}/avatar.png').exists(), isFalse);
      expect(await sentinel.readAsString(), 'UNCHANGED');
    }
    final links = await scratch('export-root');
    final link = Link('${links.path}/link');
    await link.create(outside.path);
    expect((await engine.exportTo(created.snapshotId!, link.path)).ok, isFalse);
    expect(await sentinel.readAsString(), 'UNCHANGED');
  });

  test('全部目标预检发现晚出现的目录冲突时，较早文件也不恢复', () async {
    final created = await engine.create();
    await _write('prefs.json', 'CURRENT');
    await File('${tmp.path}/user/beichen/profile.json').delete();
    await Directory('${tmp.path}/user/beichen/profile.json').create();
    expect((await engine.restore(created.snapshotId!)).ok, isFalse);
    expect(await _read('prefs.json'), 'CURRENT');
    expect((await engine.load()).snapshots, hasLength(1));
  });

  test('import 在本机资产目录存在 symlink 时也应拒绝而不入库', () async {
    final (id, dir) = await exported();
    final outside = await scratch('import-destination');
    await Directory('${tmp.path}/personas').delete(recursive: true);
    await Link('${tmp.path}/personas').create(outside.path);
    expect((await engine.importFrom(dir.path)).ok, isFalse);
    expect((await engine.load()).snapshots.single.id, id);
    expect(await outside.list().isEmpty, isTrue);
  });

  test('SQLite sidecar symlink 必须在调用备份工具前拒绝', () async {
    final cli = ondraSqliteCli!;
    final database = '${tmp.path}/user/ondra.db';
    final create = await Process.run(cli, [
      database,
      'CREATE TABLE evidence(value TEXT);',
    ]);
    expect(create.exitCode, 0);
    final outside = await scratch('wal-link');
    final sentinel = File('${outside.path}/sentinel');
    await sentinel.writeAsString('unchanged');
    await Link('$database-wal').create(sentinel.path);
    expect((await engine.create()).ok, isFalse);
    expect(await sentinel.readAsString(), 'unchanged');
    expect((await engine.load()).snapshots, isEmpty);
  });

  test('preRestore 不受 keep=1 裁剪影响，原快照及存底都保留', () async {
    final created = await engine.create();
    await engine.writeSettings(const BackupSettings(keep: 1));
    await _write('prefs.json', 'CURRENT');
    final restored = await engine.restore(created.snapshotId!);
    expect(restored.ok, isTrue, reason: restored.message);
    final snapshots = (await engine.load()).snapshots;
    expect(snapshots, hasLength(2));
    expect(snapshots.any((s) => s.id == created.snapshotId), isTrue);
    expect(snapshots.any((s) => s.trigger == BackupTrigger.preRestore), isTrue);
  });

  test('SQLite CLI 缺失、坏库和孤立 WAL 都不能退化成复制主库', () async {
    await _write('user/ondra.db', 'not a database');
    expect((await engine.create()).ok, isFalse);
    debugOverrideSqliteCli(null);
    try {
      final result = await engine.create();
      expect(result.ok, isFalse);
      expect(result.message, contains('缺少 sqlite3'));
    } finally {
      debugResetSqliteCli();
    }
    await File('${tmp.path}/user/ondra.db').delete();
    await _write('user/orphan.db-wal', 'wal');
    expect((await engine.create()).ok, isFalse);
    expect((await engine.load()).snapshots, isEmpty);
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

Future<String> _read(String rel) =>
    File('${_tmpRoot.path}/$rel').readAsString();

/// 当前用例的临时根目录。辅助函数在 `setUp` 之外定义，拿不到局部变量，
/// 只能共用一个顶层引用——它在 `setUp` 里每次重新绑定。
late Directory _tmpRoot;
