import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'backup_model.dart';
import '../../../../../app/home_dir.dart';

/// 备份引擎：把 `~/.ondra` 里「值得带走的东西」按内容存进一个对象库，
/// 每次备份只写一份清单。
///
/// 为什么不是「每次整目录复制一份」：一轮对话下来 `sessions/` 里可能几十个文件
/// 一个字节都没变，整目录复制等于把同样的内容存十遍——十份备份占十倍空间，
/// 用户会在第三次之后关掉这个功能。这里的做法是**内容寻址**：
///
/// ```text
/// ~/.ondra/backups/
///   objects/3d/3d9f...a1        ← 文件内容，同名同内容只存一次
///   snapshots/20261117-210305/
///     manifest.json             ← 文件清单：路径 → 指纹
/// ```
///
/// 于是「第 10 次备份只多写了 3 个文件」这件事是可验证的，也是页面上
/// 「去重节省」那个数字的来源。
///
/// 顺带说明一个**取舍**：`.credentials.yaml`（密钥）不进快照。备份目录本身
/// 是 0700，但把密钥复制成 N 份、每份都可能被导出到别处，风险和收益不成比例；
/// 恢复时也不会删它，所以密钥一直在原地。
class BackupEngine {
  BackupEngine({String? home, DateTime Function()? now})
    : home = home ?? '$ondraUserHome/.ondra',
      _now = now ?? DateTime.now;

  /// `~/.ondra` 的绝对路径。测试里换成临时目录。
  final String home;

  final DateTime Function() _now;

  String get root => '$home/backups';
  String get _snapshotsDir => '$root/snapshots';
  String get _objectsDir => '$root/objects';
  String get _settingsFile => '$root/settings.json';

  /// 备份范围：整棵收的目录。
  ///
  /// `logs/` 与 `cache/`、`tmp/` 不收：它们要么是追加写的排障材料（一份日志
  /// 回滚回去没有意义，还会把上小时的错误盖回来），要么是随时可重建的缓存。
  /// `electron/` 是旧版应用残留，`workspace/` 是工作区指针，都不属于「我的数据」。
  static const List<String> _trees = ['user', 'sessions', 'storages', 'profiles'];

  /// 单个文件。
  static const List<String> _singleFiles = ['prefs.json'];

  /// 只收配置文件的树：`dsh/profiles/<name>/` 里 `node_modules` 有十几兆，
  /// 收进去会让每份快照都多背一份依赖树，而它随时能重装。
  static const String _configTree = 'dsh/profiles';

  static const Set<String> _configFileNames = {
    'cordis.yml',
    'cordis.patch.yml',
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
  };

  static const Set<String> _skipDirNames = {
    'node_modules',
    '.git',
    '.venv',
    '__pycache__',
    '.cache',
  };

  /// 直接跳过的文件名。
  ///
  /// `.credentials.yaml` 是密钥（见类注释）；`.DS_Store` 是 Finder 的目录
  /// 布局缓存，收进快照只会让「文件数」这个数字虚高。
  static const Set<String> _skipFileNames = {'.credentials.yaml', '.DS_Store'};

  /// 跳过这些后缀：运行时锁、写到一半的临时文件、本引擎自己的还原临时文件。
  static const Set<String> _skipSuffixes = {
    '.lock',
    '.tmp',
    '.part',
    '.ondra-restore',
  };

  /// 串行队列：两次备份叠在一起跑会同时往对象库写同一个指纹，
  /// 后写的把先写的覆盖掉，清单和对象就对不上了。
  Future<void> _queue = Future<void>.value();

  Future<T> _serial<T>(Future<T> Function() action) {
    final next = _queue.then((_) => action());
    // 队列只关心「上一件事做完了没有」，不关心它成没成——失败的那次
    // 不该把后面排队的一起卡死，所以这里把错误吞掉。
    _queue = next.then((_) {}, onError: (_) {});
    return next;
  }

  // ── 读 ────────────────────────────────────────────────────────────────

  /// 页面一次加载需要的全部：所有快照 + 容量 + 设置 + 当前数据规模。
  Future<BackupOverview> load() async {
    final snapshots = await _readAllManifests();
    final settings = await readSettings();

    var stored = 0;
    await for (final entity in _listObjects()) {
      if (entity is! File) continue;
      stored += await entity.length();
    }

    var source = 0;
    for (final s in snapshots) {
      source += s.sourceBytes;
    }

    var liveFiles = 0;
    var liveBytes = 0;
    try {
      // 只统计大小，不算指纹：这一项要在一屏之内出来，读字节会让
      // 页面打开时多等几百毫秒，而它只是个参考数字。
      for (final f in await _scan(hashing: false)) {
        liveFiles += 1;
        liveBytes += f.size;
      }
    } catch (_) {
      // 统计不出来不影响已有快照的展示。
    }

    final rootDir = Directory(root);
    return BackupOverview(
      snapshots: snapshots,
      storedBytes: stored,
      sourceBytes: source,
      liveFiles: liveFiles,
      liveBytes: liveBytes,
      rootPath: root,
      settings: settings,
      note: rootDir.existsSync() ? '' : '备份目录还没有建立，第一次备份时自动创建。',
    );
  }

  Future<BackupSettings> readSettings() async {
    try {
      final raw = await File(_settingsFile).readAsString();
      return BackupSettings.fromJson(jsonDecode(raw));
    } catch (_) {
      return const BackupSettings();
    }
  }

  Future<void> writeSettings(BackupSettings settings) async {
    await Directory(root).create(recursive: true);
    await _writeAtomic(_settingsFile, const JsonEncoder.withIndent('  ').convert(settings.toJson()));
  }

  // ── 写 ────────────────────────────────────────────────────────────────

  /// 建一份快照。
  ///
  /// 顺序是刻意的：**先扫、再写对象、最后写清单**。清单是「这份快照存在」的
  /// 唯一凭据，它最后落盘就意味着——中途崩了，最多留下几个没人引用的对象
  /// （下次 GC 收掉），不会留下一份指向半个目录的清单。
  Future<BackupOpResult> create({BackupTrigger trigger = BackupTrigger.manual}) {
    return _serial(() async {
      try {
        final files = await _scan(hashing: true);
        if (files.isEmpty) {
          return const BackupOpResult(
            ok: false,
            message: '没有可备份的文件：数据目录还是空的。',
          );
        }

        final settings = await readSettings();
        final now = _now();
        final id = await _allocateId(now);

        var newBytes = 0;
        var newFiles = 0;
        for (final f in files) {
          final stored = await _storeObject(f, home);
          if (stored) {
            newBytes += f.size;
            newFiles += 1;
          }
        }

        final sourceBytes = files.fold<int>(0, (sum, f) => sum + f.size);
        final manifest = <String, Object?>{
          'version': 1,
          'id': id,
          'createdAt': now.toIso8601String(),
          'trigger': trigger.code,
          'totals': {
            'files': files.length,
            'sourceBytes': sourceBytes,
            'newBytes': newBytes,
            'newFiles': newFiles,
          },
          'files': [for (final f in files) f.toJson()],
        };

        await Directory('$_snapshotsDir/$id').create(recursive: true);
        await _writeAtomic(
          '$_snapshotsDir/$id/manifest.json',
          jsonEncode(manifest),
        );

        // 自动备份记下这一笔，手动的不记：否则「每小时一次」会被手动备份
        // 不断推后，永远等不到自动的那一次。
        if (trigger == BackupTrigger.auto) {
          await writeSettings(settings.copyWith(lastAt: now));
        }

        final pruned = await _prune(settings.keep);
        final freed = await _collectGarbage();

        final tail = [
          if (newFiles < files.length)
            '其中 ${files.length - newFiles} 个文件与之前的快照内容相同，没有重复存',
          if (pruned.isNotEmpty) '清理最旧的 ${pruned.length} 份',
          if (freed > 0) '回收 ${backupBytes(freed)}',
        ];
        return BackupOpResult(
          ok: true,
          snapshotId: id,
          message: tail.isEmpty
              ? '已备份 ${files.length} 个文件（${backupBytes(sourceBytes)}）。'
              : '已备份 ${files.length} 个文件（${backupBytes(sourceBytes)}）；${tail.join('；')}。',
        );
      } catch (e) {
        return BackupOpResult(ok: false, message: '备份失败：$e');
      }
    });
  }

  /// 回到某一份快照。
  ///
  /// 动手之前**先给现在的状态存一份底**（`preRestore`）：恢复是覆盖写，
  /// 用户按下那一刻想的是「回到昨天」，而不是「把今天盖掉且不可挽回」。
  /// 这份底让他能在事后反悔，且它会带一个明确的「恢复前」标签。
  ///
  /// 只覆盖快照里有的文件；快照里没有、当前存在的文件**保留**。
  /// 这不是偷懒：删除是不可逆的，而「快照里没有」既可能是当时没这个文件，
  /// 也可能是它根本不在备份范围内（见 `_trees`）。分不清就不删。
  Future<BackupOpResult> restore(String id) {
    return _serial(() async {
      final manifest = await _readManifest(id);
      if (manifest == null) {
        return const BackupOpResult(ok: false, message: '找不到这份快照的清单。');
      }

      try {
        final safety = await _createInner(BackupTrigger.preRestore);
        if (!safety.ok) {
          // 存不了底就别动：恢复本身会改文件，没有退路不动手。
          return BackupOpResult(
            ok: false,
            message: '恢复前存底失败，已中止：${safety.message}',
          );
        }

        var written = 0;
        var bytes = 0;
        var missing = 0;
        for (final f in manifest.files) {
          final object = File(_objectPath(f.hash));
          if (!await object.exists()) {
            missing += 1;
            continue;
          }
          final target = File('$home/${f.path}');
          await target.parent.create(recursive: true);
          // 先写临时文件再改名：恢复中途断电时，目标文件要么是旧内容，
          // 要么是新内容，不会是一半。
          final tmp = File('${target.path}.ondra-restore');
          await object.copy(tmp.path);
          await tmp.rename(target.path);
          written += 1;
          bytes += f.size;
        }

        final kept = await _countExtras(manifest);

        final parts = <String>[
          '已恢复 $written 个文件（${backupBytes(bytes)}）',
          if (missing > 0) '$missing 个文件的对象已缺失，跳过',
          if (kept > 0) '当前比这份快照多出的 $kept 个文件已保留，未删除',
          '恢复前的状态已存为「${backupWhen(safety.stamp ?? _now())}」',
        ];
        return BackupOpResult(
          ok: written > 0,
          snapshotId: safety.snapshotId,
          message: '${parts.join('；')}。',
        );
      } catch (e) {
        return BackupOpResult(ok: false, message: '恢复失败：$e');
      }
    });
  }

  /// 删掉一份快照，并回收没有别处引用的对象。
  Future<BackupOpResult> delete(String id) {
    return _serial(() async {
      final dir = Directory('$_snapshotsDir/$id');
      if (!await dir.exists()) {
        return const BackupOpResult(ok: false, message: '这份快照已经不在了。');
      }
      try {
        await dir.delete(recursive: true);
        final freed = await _collectGarbage();
        return BackupOpResult(
          ok: true,
          message: freed > 0
              ? '已删除这份快照，回收 ${backupBytes(freed)}。'
              : '已删除这份快照；它的内容还被别的快照用着，没有回收空间。',
        );
      } catch (e) {
        return BackupOpResult(ok: false, message: '删除失败：$e');
      }
    });
  }

  /// 把一份快照导出成一个**自包含**的目录：里面是原始文件 + 一份清单，
  /// 拷到 U 盘、发给另一台机器都能读。
  Future<BackupOpResult> exportTo(String id, String targetDir) async {
    final manifest = await _readManifest(id);
    if (manifest == null) {
      return const BackupOpResult(ok: false, message: '找不到这份快照的清单。');
    }
    try {
      var bytes = 0;
      var copied = 0;
      for (final f in manifest.files) {
        final object = File(_objectPath(f.hash));
        if (!await object.exists()) continue;
        final target = File('$targetDir/${f.path}');
        await target.parent.create(recursive: true);
        await object.copy(target.path);
        copied += 1;
        bytes += f.size;
      }
      await _writeAtomic(
        '$targetDir/ondra-snapshot.json',
        jsonEncode({
          'version': 1,
          'id': id,
          'createdAt': manifest.createdAt.toIso8601String(),
          'trigger': manifest.trigger.code,
          'totals': {
            'files': manifest.files.length,
            'sourceBytes': manifest.sourceBytes,
          },
          'files': [for (final f in manifest.files) f.toJson()],
        }),
      );
      return BackupOpResult(
        ok: true,
        message: '已导出 $copied 个文件（${backupBytes(bytes)}）到 $targetDir。',
      );
    } catch (e) {
      return BackupOpResult(ok: false, message: '导出失败：$e');
    }
  }

  /// 从导出的目录导回来。文件内容重新算指纹——目录可能被人动过，
  /// 清单里那一列此时只是参考，不能拿它当真。
  Future<BackupOpResult> importFrom(String sourceDir) {
    return _serial(() async {
      final file = File('$sourceDir/ondra-snapshot.json');
      if (!await file.exists()) {
        return const BackupOpResult(
          ok: false,
          message: '这个目录里没有 ondra-snapshot.json，不是一份导出的备份。',
        );
      }
      try {
        final raw = jsonDecode(await file.readAsString());
        final list = raw is Map ? raw['files'] : null;
        if (list is! List) {
          return const BackupOpResult(ok: false, message: '清单格式不对，读不出文件列表。');
        }

        final entries = <BackupFileEntry>[];
        var newBytes = 0;
        var newFiles = 0;
        for (final item in list) {
          final parsed = BackupFileEntry.fromJson(item);
          if (parsed == null) continue;
          final src = File('$sourceDir/${parsed.path}');
          if (!await src.exists()) continue;
          final bytes = await src.readAsBytes();
          final entry = BackupFileEntry(
            path: parsed.path,
            size: bytes.length,
            hash: _fingerprint(bytes),
            modified: parsed.modified,
          );
          entries.add(entry);
          if (await _storeObject(entry, sourceDir)) {
            newBytes += entry.size;
            newFiles += 1;
          }
        }
        if (entries.isEmpty) {
          return const BackupOpResult(ok: false, message: '清单里的文件一个都没找到。');
        }

        final now = _now();
        final id = await _allocateId(now);
        final sourceBytes = entries.fold<int>(0, (sum, f) => sum + f.size);
        await Directory('$_snapshotsDir/$id').create(recursive: true);
        await _writeAtomic(
          '$_snapshotsDir/$id/manifest.json',
          jsonEncode({
            'version': 1,
            'id': id,
            'createdAt': now.toIso8601String(),
            'trigger': BackupTrigger.imported.code,
            'totals': {
              'files': entries.length,
              'sourceBytes': sourceBytes,
              'newBytes': newBytes,
              'newFiles': newFiles,
            },
            'files': [for (final f in entries) f.toJson()],
          }),
        );
        return BackupOpResult(
          ok: true,
          snapshotId: id,
          message:
              '已导入 ${entries.length} 个文件（${backupBytes(sourceBytes)}）；'
              '其中 $newFiles 个是新的，其余与已有快照重复。',
        );
      } catch (e) {
        return BackupOpResult(ok: false, message: '导入失败：$e');
      }
    });
  }

  /// 打开备份目录。桌面端才有 Finder。
  Future<BackupOpResult> reveal() async {
    try {
      await Directory(root).create(recursive: true);
      final r = await Process.run('open', [root]);
      if (r.exitCode != 0) {
        return BackupOpResult(ok: false, message: '打不开目录：${r.stderr}');
      }
      return BackupOpResult(ok: true, message: '已在访达中打开 $root。');
    } catch (e) {
      return BackupOpResult(ok: false, message: '打不开目录：$e');
    }
  }

  /// 让用户选一个目录。用系统自带的选目录面板，不自己造一个文件浏览器——
  /// 「导出到哪」「从哪导入」是系统的活。
  ///
  /// 走 `osascript` 的 `choose folder`：这是 macOS 上唯一不需要引入原生代码
  /// 就能唤起选目录面板的办法。用户取消时退出码非 0，如实返回 null。
  Future<String?> pickDirectory(String prompt) async {
    try {
      final r = await Process.run('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt "$prompt")',
      ]);
      if (r.exitCode != 0) return null;
      final path = (r.stdout as String).trim();
      return path.isEmpty ? null : path;
    } catch (_) {
      return null;
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  /// 恢复流程里要「再存一份底」，但 [restore] 已经占着串行队列了，
  /// 不能从里面再调 [create]（会自己等自己）。所以拆一个不加锁的版本。
  Future<_Created> _createInner(BackupTrigger trigger) async {
    final files = await _scan(hashing: true);
    if (files.isEmpty) {
      return const _Created(ok: false, message: '没有可备份的文件', tid: null, stamp: null);
    }
    var newBytes = 0;
    var newFiles = 0;
    for (final f in files) {
      if (await _storeObject(f, home)) {
        newBytes += f.size;
        newFiles += 1;
      }
    }
    final settings = await readSettings();
    final now = _now();
    final id = await _allocateId(now);
    final sourceBytes = files.fold<int>(0, (sum, f) => sum + f.size);
    await Directory('$_snapshotsDir/$id').create(recursive: true);
    await _writeAtomic(
      '$_snapshotsDir/$id/manifest.json',
      jsonEncode({
        'version': 1,
        'id': id,
        'createdAt': now.toIso8601String(),
        'trigger': trigger.code,
        'totals': {
          'files': files.length,
          'sourceBytes': sourceBytes,
          'newBytes': newBytes,
          'newFiles': newFiles,
        },
        'files': [for (final f in files) f.toJson()],
      }),
    );
    await _prune(settings.keep);
    return _Created(ok: true, message: '', tid: id, stamp: now);
  }

  /// 扫一遍备份范围。[hashing] 为 false 时不算指纹，只取大小与时间。
  Future<List<BackupFileEntry>> _scan({required bool hashing}) async {
    final out = <BackupFileEntry>[];
    for (final rel in _trees) {
      await _walk('$home/$rel', rel, out, hashing: hashing);
    }
    for (final rel in _singleFiles) {
      final f = File('$home/$rel');
      if (!await f.exists()) continue;
      final entry = await _entryOf(f, rel, hashing: hashing);
      if (entry != null) out.add(entry);
    }
    await _walk(
      '$home/$_configTree',
      _configTree,
      out,
      hashing: hashing,
      onlyNames: _configFileNames,
    );
    out.sort((a, b) => a.path.compareTo(b.path));
    return out;
  }

  Future<void> _walk(
    String absDir,
    String relDir,
    List<BackupFileEntry> out, {
    required bool hashing,
    Set<String>? onlyNames,
  }) async {
    final dir = Directory(absDir);
    if (!await dir.exists()) return;

    List<FileSystemEntity> entities;
    try {
      entities = await dir.list(followLinks: false).toList();
    } catch (_) {
      // 权限不足的目录跳过：一份备份不该因为某个目录读不了就整体失败。
      return;
    }

    for (final entity in entities) {
      final leaf = _leaf(entity.path);
      if (entity is Link) continue;
      if (entity is Directory) {
        if (_skipDirNames.contains(leaf)) continue;
        await _walk(
          entity.path,
          '$relDir/$leaf',
          out,
          hashing: hashing,
          onlyNames: onlyNames,
        );
        continue;
      }
      if (entity is! File) continue;
      if (_skipFileNames.contains(leaf)) continue;
      if (_skipSuffixes.any((s) => leaf.endsWith(s))) continue;
      if (onlyNames != null && !onlyNames.contains(leaf)) continue;
      final entry = await _entryOf(entity, '$relDir/$leaf', hashing: hashing);
      if (entry != null) out.add(entry);
    }
  }

  Future<BackupFileEntry?> _entryOf(
    File file,
    String rel, {
    required bool hashing,
  }) async {
    try {
      if (!hashing) {
        final st = await file.stat();
        return BackupFileEntry(
          path: rel,
          size: st.size,
          hash: '',
          modified: st.modified.millisecondsSinceEpoch,
        );
      }
      final bytes = await file.readAsBytes();
      final st = await file.stat();
      return BackupFileEntry(
        path: rel,
        size: bytes.length,
        hash: _fingerprint(bytes),
        modified: st.modified.millisecondsSinceEpoch,
      );
    } catch (_) {
      return null;
    }
  }

  /// 存一个对象。返回 true 表示这次真的写了新内容（没去重掉）。
  Future<bool> _storeObject(BackupFileEntry entry, String sourceRoot) async {
    final target = File(_objectPath(entry.hash));
    if (await target.exists()) return false;
    await target.parent.create(recursive: true);
    final src = File('$sourceRoot/${entry.path}');
    if (!await src.exists()) return false;
    // 先写 `.part` 再改名：对象库是「同指纹永远同内容」的，一个写了一半的
    // 对象被后续快照当成「已经有了」，那份快照就永远缺这个文件的内容。
    final part = File('${target.path}.part');
    await src.copy(part.path);
    await part.rename(target.path);
    return true;
  }

  String _objectPath(String hash) {
    // 前两位分片：容器目录里几千个文件挤在一层，`ls` 和 Finder 都会卡。
    final shard = hash.length >= 2 ? hash.substring(0, 2) : '00';
    return '$_objectsDir/$shard/$hash';
  }

  Stream<FileSystemEntity> _listObjects() {
    final dir = Directory(_objectsDir);
    if (!dir.existsSync()) return const Stream<FileSystemEntity>.empty();
    return dir.list(recursive: true, followLinks: false);
  }

  Future<List<BackupSnapshot>> _readAllManifests() async {
    final dir = Directory(_snapshotsDir);
    if (!await dir.exists()) return const [];
    final out = <BackupSnapshot>[];
    await for (final entity in dir.list(followLinks: false)) {
      if (entity is! Directory) continue;
      final snapshot = await _readManifest(_leaf(entity.path));
      if (snapshot != null) out.add(snapshot);
    }
    out.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return out;
  }

  Future<BackupSnapshot?> _readManifest(String id) async {
    final file = File('$_snapshotsDir/$id/manifest.json');
    if (!await file.exists()) return null;
    try {
      final raw = jsonDecode(await file.readAsString());
      if (raw is! Map) return null;
      final files = <BackupFileEntry>[];
      final list = raw['files'];
      if (list is List) {
        for (final item in list) {
          final parsed = BackupFileEntry.fromJson(item);
          if (parsed != null) files.add(parsed);
        }
      }
      final totals = raw['totals'];
      final map = totals is Map ? totals : const <String, Object?>{};
      final sourceBytes =
          (map['sourceBytes'] as num?)?.toInt() ??
          files.fold<int>(0, (sum, f) => sum + f.size);
      return BackupSnapshot(
        id: raw['id'] as String? ?? id,
        createdAt:
            DateTime.tryParse(raw['createdAt'] as String? ?? '') ??
            DateTime.fromMillisecondsSinceEpoch(0),
        trigger: BackupTrigger.fromCode(raw['trigger'] as String?),
        files: files,
        sourceBytes: sourceBytes,
        newBytes: (map['newBytes'] as num?)?.toInt() ?? sourceBytes,
        newFiles: (map['newFiles'] as num?)?.toInt() ?? files.length,
      );
    } catch (_) {
      // 坏清单跳过，不让一份坏文件把整页打成空。
      return null;
    }
  }

  /// 超出保留份数的从最旧的删。返回被删掉的 id。
  Future<List<String>> _prune(int keep) async {
    final snapshots = await _readAllManifests();
    if (snapshots.length <= keep) return const [];
    final removed = <String>[];
    for (final s in snapshots.skip(keep)) {
      try {
        await Directory('$_snapshotsDir/${s.id}').delete(recursive: true);
        removed.add(s.id);
      } catch (_) {}
    }
    return removed;
  }

  /// 回收没有任何快照引用的对象。返回释放的字节数。
  Future<int> _collectGarbage() async {
    final referenced = <String>{};
    final snapshots = await _readAllManifests();
    for (final s in snapshots) {
      for (final f in s.files) {
        if (f.hash.isNotEmpty) referenced.add(f.hash);
      }
    }

    var freed = 0;
    final deadShards = <String>{};
    await for (final entity in _listObjects()) {
      if (entity is! File) continue;
      final name = _leaf(entity.path);
      // `.part` 是上次中途退出留下的半截对象，一并收掉。
      if (name.endsWith('.part') || !referenced.contains(name)) {
        try {
          freed += await entity.length();
          await entity.delete();
          deadShards.add(entity.parent.path);
        } catch (_) {}
      }
    }
    // 清掉空的分片目录，否则 `objects/` 下会慢慢攒出一堆空壳。
    for (final path in deadShards) {
      try {
        final dir = Directory(path);
        if (await dir.list().isEmpty) await dir.delete();
      } catch (_) {}
    }
    return freed;
  }

  /// 统计「当前有、但这份快照里没有」的文件数。只统计不删除。
  Future<int> _countExtras(BackupSnapshot snapshot) async {
    final known = {for (final f in snapshot.files) f.path};
    var extras = 0;
    try {
      for (final f in await _scan(hashing: false)) {
        if (!known.contains(f.path)) extras += 1;
      }
    } catch (_) {}
    return extras;
  }

  Future<String> _allocateId(DateTime at) async {
    final base =
        '${at.year}'
        '${_two(at.month)}'
        '${_two(at.day)}-'
        '${_two(at.hour)}'
        '${_two(at.minute)}'
        '${_two(at.second)}';
    var id = base;
    var n = 2;
    // 同一秒里连按两次「立即备份」不该互相覆盖。
    while (await Directory('$_snapshotsDir/$id').exists()) {
      id = '$base-$n';
      n += 1;
    }
    return id;
  }

  Future<void> _writeAtomic(String path, String content) async {
    final tmp = File('$path.tmp');
    await tmp.parent.create(recursive: true);
    await tmp.writeAsString(content, flush: true);
    await tmp.rename(path);
  }
}

class _Created {
  const _Created({
    required this.ok,
    required this.message,
    required this.tid,
    required this.stamp,
  });

  final bool ok;
  final String message;
  final String? tid;
  final DateTime? stamp;

  String? get snapshotId => tid;
}

String _leaf(String path) {
  final parts = path.split('/').where((s) => s.isNotEmpty).toList();
  return parts.isEmpty ? path : parts.last;
}

String _two(int v) => v < 10 ? '0$v' : '$v';

/// 内容指纹：两条 32 位 FNV 变体并成 16 位十六进制。
///
/// 为什么自己写而不引 `crypto`：这里要回答的是「两份文件是不是同一份内容」，
/// 不是「有没有被篡改」。SHA-256 每读一个字节要做几十次位运算，备份 500KB
/// 文件树时纯属浪费；FNV 一轮就够，两条通道把碰撞空间拉到 2^64。
///
/// 每一步都 `& 0xFFFFFFFF`：Dart 的 int 在原生端是 64 位、在 web 上是 double，
/// 只保留低 32 位能让两边算出同一个值（虽然引擎只跑在桌面端）。
String _fingerprint(List<int> bytes) {
  var a = 0x811c9dc5;
  var b = 0x9e3779b9;
  for (var i = 0; i < bytes.length; i++) {
    final v = bytes[i];
    a = ((a ^ v) * 0x01000193) & 0xFFFFFFFF;
    b = ((b ^ (v + i)) * 0x85EBCA6B) & 0xFFFFFFFF;
    b ^= b >> 13;
  }
  return _hex8(a) + _hex8(b);
}

String _hex8(int v) => (v & 0xFFFFFFFF).toRadixString(16).padLeft(8, '0');

/// 自动备份：应用在跑的时候每分钟查一次「到点没有」。
///
/// 为什么不做成系统级守护进程：空谷是随用随开的桌面伴体，它不在跑的时候
/// 也没有新数据产生。开机自启 + 常驻调度会为了「数据没变也每小时存一份」
/// 付一份始终在跑的代价，不划算。这里只在应用活着的时候工作，是诚实的边界。
class BackupScheduler {
  /// [now] 可注入：调度判断用「现在 - 上次」比间隔，若时钟不能替换，
  /// 测试就只能依赖运行时刻——白天跑过、晚上再跑就挂，那种测试不算测试。
  BackupScheduler(this.engine, {DateTime Function()? now})
    : _now = now ?? DateTime.now;

  final BackupEngine engine;
  final DateTime Function() _now;

  Timer? _timer;
  bool _busy = false;

  bool get running => _timer != null;

  void start() {
    if (_timer != null) return;
    _timer = Timer.periodic(const Duration(minutes: 1), (_) => tick());
    // 启动后先查一次：应用关了两小时再打开，不该非要等下一个整点。
    unawaited(tick());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// 到点就备份。`_busy` 防止上一轮还没写完就叠下一轮。
  Future<void> tick() async {
    if (_busy) return;
    _busy = true;
    try {
      final settings = await engine.readSettings();
      if (!settings.auto) return;
      final last = settings.lastAt;
      final interval = Duration(minutes: settings.intervalMinutes.clamp(1, 24 * 60));
      if (last != null && _now().difference(last) < interval) return;
      await engine.create(trigger: BackupTrigger.auto);
    } catch (_) {
      // 自动备份失败不打扰用户：页面上「上次备份」的时间会自己显出异常，
      // 弹一个提示只会让人以为数据出了问题。
    } finally {
      _busy = false;
    }
  }
}

/// 全局一份：页面与启动期共用同一个串行队列。
final BackupEngine backupEngine = BackupEngine();
final BackupScheduler backupScheduler = BackupScheduler(backupEngine);
