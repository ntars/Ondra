import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../../../../app/home_dir.dart';
import '../../../../../app/data_maintenance.dart';
import '../../../../../app/sqlite_cli.dart';
import 'backup_model.dart';

/// 内容寻址的本机数据快照。先完整预检和捕获字节，最后发布清单。
/// 不包含内核装配层、插件代码、凭据；清单不能授予额外的文件写入权限。
class BackupEngine {
  BackupEngine({String? home, DateTime Function()? now, this.dataIsOffline})
    : home = home ?? '$ondraUserHome/.ondra',
      _now = now ?? DateTime.now;

  final String home;
  final DateTime Function() _now;

  /// 由共享维护独占流程提供：内核已停止、transport 已 await close，且禁止
  /// 重连/发送。调用方必须持有 lease 直到 restore 完成；路径或连接状态不作凭据。
  /// 未注入时（包括自定义 home）拒绝 SQLite 恢复。
  final bool Function()? dataIsOffline;
  String get root => '$home/backups';
  Future<void> _queue = Future<void>.value();

  Future<T> _serial<T>(Future<T> Function() action) {
    final next = _queue.then((_) => action());
    _queue = next.then((_) {}, onError: (_) {});
    return next;
  }

  Future<_Boundary> _repository() async {
    final boundary = await _Boundary.open(home);
    for (final rel in ['backups', 'backups/objects', 'backups/snapshots']) {
      await boundary.check(rel, directory: true);
    }
    await boundary.check('backups/settings.json');
    return boundary;
  }

  Future<BackupOverview> load() async {
    final boundary = await _repository();
    final snapshots = await _readAllManifests(boundary);
    final settings = await readSettings();
    var stored = 0;
    for (final file in await _objects(boundary)) {
      stored += await file.length();
    }
    var liveFiles = 0;
    var liveBytes = 0;
    var note = '';
    try {
      for (final file in await _scan(boundary, capture: false)) {
        liveFiles++;
        liveBytes += file.entry.size;
      }
    } catch (e) {
      note = '当前数据读取失败：$e';
    }
    return BackupOverview(
      snapshots: snapshots,
      storedBytes: stored,
      sourceBytes: snapshots.fold(0, (sum, s) => sum + s.sourceBytes),
      liveFiles: liveFiles,
      liveBytes: liveBytes,
      rootPath: root,
      settings: settings,
      note: note,
    );
  }

  Future<BackupSettings> readSettings() async {
    final boundary = await _repository();
    final file = File(await boundary.check('backups/settings.json'));
    if (!await file.exists()) return const BackupSettings();
    return BackupSettings.fromJson(jsonDecode(await file.readAsString()));
  }

  Future<void> writeSettings(BackupSettings settings) async {
    final boundary = await _repository();
    await _writeAtomic(
      boundary,
      'backups/settings.json',
      utf8.encode(jsonEncode(settings.toJson())),
    );
  }

  Future<BackupOpResult> create({
    BackupTrigger trigger = BackupTrigger.manual,
  }) {
    return _serial(() async {
      try {
        final boundary = await _repository();
        final files = await _scan(boundary, capture: true);
        if (files.isEmpty) {
          return const BackupOpResult.failure('没有可备份的文件：数据目录还是空的。');
        }
        final settings = await readSettings();
        // 不让损坏的旧清单被 GC 当成「没有引用」。
        await _readAllManifests(boundary);
        final created = await _publish(boundary, files, trigger);
        if (trigger == BackupTrigger.auto) {
          await writeSettings(settings.copyWith(lastAt: created.createdAt));
        }
        await _prune(boundary, settings.keep);
        await _collectGarbage(boundary);
        return BackupOpResult(
          ok: true,
          snapshotId: created.id,
          message:
              '已备份 ${files.length} 个文件（${backupBytes(created.sourceBytes)}）。',
        );
      } catch (e) {
        return BackupOpResult.failure('备份失败：$e');
      }
    });
  }

  Future<BackupOpResult> restore(String id) {
    return _serial(() async {
      var written = 0;
      String? safetyId;
      String? writing;
      Directory? staging;
      try {
        final boundary = await _repository();
        final manifest = await _readManifest(boundary, id);
        // 全部对象、目标/旁文件路径和 SQLite 副本先预检，再请求停机凭据。
        // 预检只打开临时副本，不打开用户库，避免 SQLite 恢复日志或创建 SHM。
        final files = await _preflightObjects(boundary, manifest);
        final sqlitePaths = await _preflightRestoreTargets(boundary, files);
        final sources = <String, String>{};
        if (sqlitePaths.isNotEmpty) {
          final cli = ondraSqliteCli;
          if (cli == null) throw StateError('缺少 sqlite3，不能恢复 SQLite。');
          staging = await Directory.systemTemp.createTemp(
            'ondra-sqlite-restore-',
          );
          for (final file in files) {
            if (!sqlitePaths.contains(file.entry.path)) continue;
            final source = File('${staging.path}/${sources.length}.db');
            await source.writeAsBytes(file.bytes, flush: true);
            final check = await Process.run(cli, [
              '-batch',
              '-bail',
              '-readonly',
              source.path,
              'PRAGMA integrity_check;',
            ]);
            if (check.exitCode != 0 || '${check.stdout}'.trim() != 'ok') {
              throw StateError(
                'SQLite 恢复副本完整性检查失败：${file.entry.path} '
                '${check.stderr} ${check.stdout}',
              );
            }
            sources[file.entry.path] = source.path;
          }
          _requireDataOffline();
        }
        final current = await _scan(boundary, capture: true);
        if (sources.isNotEmpty) _requireDataOffline();
        // 恢复前不能裁剪快照；尤其不能把正在恢复的那份删掉。
        if (current.isNotEmpty) {
          safetyId = (await _publish(
            boundary,
            current,
            BackupTrigger.preRestore,
          )).id;
        }
        await _preflightRestoreTargets(boundary, files);
        for (final file in files) {
          if (sources.isNotEmpty) _requireDataOffline();
          writing = file.entry.path;
          final source = sources[writing];
          if (source != null) {
            await _sqliteRestore(boundary, writing, source);
          } else {
            await _writeAtomic(boundary, writing, file.bytes);
          }
          written++;
          writing = null;
        }
        return BackupOpResult(
          ok: true,
          snapshotId: safetyId,
          message:
              '已恢复 $written 个文件；快照外文件保留。'
              '${safetyId == null ? '恢复前数据为空。' : '恢复前状态已存底。'}',
        );
      } catch (e) {
        return BackupOpResult(
          ok: false,
          snapshotId: safetyId,
          message:
              '恢复失败：$e'
              '${written == 0 ? '' : '；已写入 $written 个文件，发生部分恢复。'}'
              '${writing == null ? '' : '；失败目标：$writing，请检查其状态。'}'
              '${safetyId == null ? '' : '；可用恢复前快照 $safetyId 回滚。'}',
        );
      } finally {
        try {
          await staging?.delete(recursive: true);
        } on FileSystemException {
          // 临时副本清理失败不改变已完成恢复的结果。
        }
      }
    });
  }

  Future<BackupOpResult> delete(String id) {
    return _serial(() async {
      try {
        _validateId(id);
        final boundary = await _repository();
        final dir = Directory(
          await boundary.check('backups/snapshots/$id', directory: true),
        );
        if (!await dir.exists()) {
          return const BackupOpResult.failure('这份快照已经不在了。');
        }
        await _readAllManifests(boundary);
        await dir.delete(recursive: true);
        final freed = await _collectGarbage(boundary);
        return BackupOpResult(
          ok: true,
          message: '已删除这份快照，回收 ${backupBytes(freed)}。',
        );
      } catch (e) {
        return BackupOpResult.failure('删除失败：$e');
      }
    });
  }

  Future<BackupOpResult> exportTo(String id, String targetDir) {
    return _serial(() async {
      try {
        final boundary = await _repository();
        final manifest = await _readManifest(boundary, id);
        final files = await _preflightObjects(boundary, manifest);
        final target = await _Boundary.open(targetDir);
        if (_within(boundary.path, target.path) ||
            _within(target.path, boundary.path)) {
          throw StateError('导出目录不能与用户数据目录重叠');
        }
        await _checkTargets(target, files);
        await target.check('ondra-snapshot.json');
        // 所有对象都已在内存中验证；缺最后一个也不能先导出前面的文件。
        for (final file in files) {
          await _writeAtomic(target, file.entry.path, file.bytes);
        }
        await _writeAtomic(
          target,
          'ondra-snapshot.json',
          utf8.encode(jsonEncode(_manifestJson(manifest))),
        );
        return BackupOpResult(
          ok: true,
          message: '已导出 ${files.length} 个文件到 $targetDir。',
        );
      } catch (e) {
        return BackupOpResult.failure('导出失败：$e');
      }
    });
  }

  Future<BackupOpResult> importFrom(String sourceDir) {
    return _serial(() async {
      try {
        final source = await _Boundary.open(sourceDir);
        final manifestFile = File(
          await source.check('ondra-snapshot.json', required: true),
        );
        final raw = jsonDecode(await manifestFile.readAsString());
        final manifest = _parseManifest(raw);
        final boundary = await _repository();
        final files = <_Captured>[];
        // 先检查全部路径，再读取全部字节；不能静默重算并接受已损坏的导出。
        for (final entry in manifest.files) {
          await source.check(entry.path, required: true);
          await boundary.check(entry.path);
        }
        for (final entry in manifest.files) {
          final bytes = await File(
            await source.check(entry.path, required: true),
          ).readAsBytes();
          _verify(entry, bytes);
          files.add(_Captured(entry, bytes));
        }
        final created = await _publish(boundary, files, BackupTrigger.imported);
        return BackupOpResult(
          ok: true,
          snapshotId: created.id,
          message:
              '已导入 ${files.length} 个文件（${backupBytes(created.sourceBytes)}）。',
        );
      } catch (e) {
        return BackupOpResult.failure('导入失败：$e');
      }
    });
  }

  Future<BackupOpResult> reveal() async {
    try {
      final boundary = await _repository();
      final path = await boundary.check('backups', directory: true);
      await Directory(path).create(recursive: true);
      final result = await Process.run('open', [path]);
      if (result.exitCode != 0) throw StateError('${result.stderr}');
      return BackupOpResult(ok: true, message: '已在访达中打开 $root。');
    } catch (e) {
      return BackupOpResult.failure('打不开目录：$e');
    }
  }

  Future<String?> pickDirectory(String prompt) async {
    try {
      final result = await Process.run('osascript', [
        '-e',
        'POSIX path of (choose folder with prompt ${jsonEncode(prompt)})',
      ]);
      if (result.exitCode != 0) return null;
      final path = (result.stdout as String).trim();
      return path.isEmpty ? null : path;
    } catch (_) {
      return null;
    }
  }

  Future<List<_Captured>> _scan(
    _Boundary boundary, {
    required bool capture,
  }) async {
    final paths = <String>[];
    Future<void> walk(String rel) async {
      final path = await boundary.check(rel, directory: true);
      final dir = Directory(path);
      if (!await dir.exists()) return;
      // list/read/stat 的错误必须冒泡；不能把不可读误报成「不需要备份」。
      await for (final entity in dir.list(followLinks: false)) {
        final leaf = entity.uri.pathSegments.where((s) => s.isNotEmpty).last;
        if (BackupPaths.excludedDirectories.contains(leaf.toLowerCase())) {
          continue;
        }
        final next = '$rel/$leaf';
        if (entity is Link) throw FileSystemException('数据资产不允许符号链接', next);
        if (entity is Directory) {
          await walk(next);
        } else if (entity is File) {
          if (_sqliteSidecars.any(leaf.endsWith)) {
            final suffix = _sqliteSidecars.firstWhere(leaf.endsWith);
            final main = next.substring(0, next.length - suffix.length);
            final database = File(await boundary.check(main, required: true));
            if (!BackupPaths.isAsset(main) ||
                !await _hasSqliteHeader(database)) {
              throw FileSystemException('孤立或未知的 SQLite 日志', next);
            }
            // WAL/SHM/journal 由在线备份 API 合并，不单独打包。
            continue;
          }
          if (BackupPaths.isAsset(next)) paths.add(next);
        } else {
          throw FileSystemException('不支持的数据文件类型', next);
        }
      }
    }

    for (final tree in BackupPaths.trees) {
      await walk(tree);
    }
    for (final path in BackupPaths.singleFiles) {
      if (await File(await boundary.check(path)).exists()) paths.add(path);
    }
    paths.sort();
    final out = <_Captured>[];
    for (final path in paths) {
      final file = File(await boundary.check(path, required: true));
      final stat = await file.stat();
      var bytes = const <int>[];
      if (capture) {
        if (await _hasSqliteHeader(file) || _sqliteName(path)) {
          bytes = await _sqliteSnapshot(boundary, path);
        } else {
          bytes = await file.readAsBytes();
          // 文件可能在探测头之后被替换；捕获的字节若是 SQLite 也不能 raw copy。
          if (_isSqlite(bytes)) bytes = await _sqliteSnapshot(boundary, path);
        }
      }
      out.add(
        _Captured(
          BackupFileEntry(
            path: path,
            size: capture ? bytes.length : stat.size,
            hash: capture ? _fingerprint(bytes) : '',
            modified: stat.modified.millisecondsSinceEpoch,
          ),
          bytes,
        ),
      );
    }
    if (capture && out.isNotEmpty) {
      BackupPaths.parseFiles([for (final file in out) file.entry.toJson()]);
    }
    return out;
  }

  static const _sqliteSidecars = ['-wal', '-shm', '-journal'];
  static bool _sqliteName(String path) =>
      RegExp(r'\.(db|sqlite3?)$', caseSensitive: false).hasMatch(path);
  static bool _isSqlite(List<int> bytes) =>
      bytes.length >= 16 &&
      ascii.decode(bytes.take(16).toList(), allowInvalid: true) ==
          'SQLite format 3\x00';

  Future<bool> _hasSqliteHeader(File file) async {
    final input = await file.open();
    try {
      return _isSqlite(await input.read(16));
    } finally {
      await input.close();
    }
  }

  Future<List<int>> _sqliteSnapshot(_Boundary boundary, String rel) async {
    final cli = ondraSqliteCli;
    if (cli == null) throw StateError('缺少 sqlite3，不能一致性备份 SQLite；未退回复制主库。');
    final path = await boundary.check(rel, required: true);
    for (final suffix in _sqliteSidecars) {
      await boundary.check('$rel$suffix');
    }
    final staging = await Directory.systemTemp.createTemp(
      'ondra-sqlite-backup-',
    );
    try {
      final snapshot = File('${staging.path}/snapshot.db');
      // .backup 调用 sqlite3_backup API，包含已提交但尚未 checkpoint 的 WAL。
      // -readonly 禁止修改源库；不用 immutable，它会忽略活动 WAL。
      final result = await Process.run(cli, [
        '-batch',
        '-bail',
        '-readonly',
        '-cmd',
        '.timeout 5000',
        path,
        '.backup ${jsonEncode(snapshot.path)}',
      ]);
      if (result.exitCode != 0) {
        throw StateError('SQLite 一致性备份失败：${result.stderr}');
      }
      // 副本可能继承 WAL 标志。仅在临时副本上切回 DELETE，导出的单文件
      // 才能在没有 -wal/-shm、甚至只读介质上独立打开。
      final check = await Process.run(cli, [
        '-batch',
        '-bail',
        snapshot.path,
        'PRAGMA journal_mode=DELETE; PRAGMA integrity_check;',
      ]);
      if (check.exitCode != 0 || '${check.stdout}'.trim() != 'delete\nok') {
        throw StateError('SQLite 副本完整性检查失败：${check.stderr} ${check.stdout}');
      }
      return await snapshot.readAsBytes();
    } finally {
      await staging.delete(recursive: true);
    }
  }

  Future<Set<String>> _preflightRestoreTargets(
    _Boundary boundary,
    List<_Captured> files,
  ) async {
    await _checkTargets(boundary, files);
    // 即使主文件不存在/不是 SQLite，也不允许旁文件是 symlink 或目录。
    for (final file in files) {
      for (final suffix in _sqliteSidecars) {
        await boundary.check('${file.entry.path}$suffix');
      }
    }
    final sqlitePaths = <String>{};
    for (final file in files) {
      final rel = file.entry.path;
      final target = File(await boundary.check(rel));
      var sqlite =
          _isSqlite(file.bytes) ||
          _sqliteName(rel) ||
          (await target.exists() && await _hasSqliteHeader(target));
      for (final suffix in _sqliteSidecars) {
        if (await File(await boundary.check('$rel$suffix')).exists()) {
          sqlite = true;
        }
      }
      if (!sqlite) continue;
      // 不允许用普通文件覆盖数据库并遗留会重放的旧日志。
      if (!_isSqlite(file.bytes)) {
        throw FormatException('SQLite 目标必须使用有效的 SQLite 副本恢复：$rel');
      }
      sqlitePaths.add(rel);
    }
    return sqlitePaths;
  }

  void _requireDataOffline() {
    if (dataIsOffline?.call() != true) {
      throw StateError('SQLite 恢复需要共享维护流程暂停内核并持有维护独占。');
    }
  }

  Future<void> _sqliteRestore(
    _Boundary boundary,
    String rel,
    String source,
  ) async {
    _requireDataOffline();
    final cli = ondraSqliteCli;
    if (cli == null) throw StateError('缺少 sqlite3，不能恢复 SQLite。');
    final target = File(await boundary.check(rel));
    for (final suffix in _sqliteSidecars) {
      await boundary.check('$rel$suffix');
    }
    await target.parent.create(recursive: true);
    await boundary.check(rel);
    for (final suffix in _sqliteSidecars) {
      await boundary.check('$rel$suffix');
    }
    _requireDataOffline();
    // .restore 调用 sqlite3_backup API，在目标库事务内恢复。让 SQLite 自己
    // 协调 WAL/SHM/journal，不 rename 主库、不手工删除残留日志。异常占锁时报错，
    // 上层保留存底及已完成数量；维护独占不是绕过数据库锁的理由。
    final result = await Process.run(cli, [
      '-batch',
      '-bail',
      '-cmd',
      '.timeout 1000',
      target.path,
      '.restore ${jsonEncode(source)}',
    ]);
    if (result.exitCode != 0) {
      throw StateError('SQLite 恢复失败：$rel ${result.stderr}');
    }
  }

  Future<void> _checkTargets(_Boundary boundary, List<_Captured> files) async {
    final targets = <String>{};
    for (final file in files) {
      final path = await boundary.check(file.entry.path);
      if (!targets.add(path.toLowerCase())) {
        throw FormatException('目标路径重复：$path');
      }
    }
  }

  Future<List<_Captured>> _preflightObjects(
    _Boundary boundary,
    BackupSnapshot manifest,
  ) async {
    final files = <_Captured>[];
    for (final entry in manifest.files) {
      final object = File(
        await boundary.check(_objectRel(entry.hash), required: true),
      );
      final bytes = await object.readAsBytes();
      _verify(entry, bytes);
      files.add(_Captured(entry, bytes));
    }
    return files;
  }

  void _verify(BackupFileEntry entry, List<int> bytes) {
    if (bytes.length != entry.size || _fingerprint(bytes) != entry.hash) {
      throw FormatException('对象 hash/size 不匹配：${entry.path}');
    }
  }

  String _objectRel(String hash) {
    if (!RegExp(r'^[0-9a-f]{16}$').hasMatch(hash)) {
      throw const FormatException('无效对象指纹');
    }
    return 'backups/objects/${hash.substring(0, 2)}/$hash';
  }

  Future<BackupSnapshot> _publish(
    _Boundary boundary,
    List<_Captured> files,
    BackupTrigger trigger,
  ) async {
    BackupPaths.parseFiles([for (final file in files) file.entry.toJson()]);
    final missing = <String>{};
    final captured = <String, List<int>>{};
    // 已有对象及本批次重复的指纹都必须验证，不能只凭同名就去重。
    for (final file in files) {
      _verify(file.entry, file.bytes);
      final previous = captured[file.entry.hash];
      if (previous != null && !_equalBytes(previous, file.bytes)) {
        throw StateError('对象指纹碰撞');
      }
      captured[file.entry.hash] = file.bytes;
      final rel = _objectRel(file.entry.hash);
      final object = File(await boundary.check(rel));
      if (await object.exists()) {
        final existing = await object.readAsBytes();
        _verify(file.entry, existing);
        if (!_equalBytes(existing, file.bytes)) throw StateError('对象指纹碰撞');
      } else {
        missing.add(rel);
      }
    }
    final now = _now();
    final id = await _allocateId(boundary, now);
    await boundary.check('backups/snapshots/$id/manifest.json');
    var newBytes = 0;
    var newFiles = 0;
    for (final file in files) {
      final rel = _objectRel(file.entry.hash);
      if (missing.remove(rel)) {
        // 捕获的同一份字节用于 hash 与存储，绝不第二次读取源文件。
        await _writeAtomic(boundary, rel, file.bytes);
        newBytes += file.bytes.length;
        newFiles++;
      }
    }
    final snapshot = BackupSnapshot(
      id: id,
      createdAt: now,
      trigger: trigger,
      files: [for (final file in files) file.entry],
      sourceBytes: files.fold(0, (sum, file) => sum + file.entry.size),
      newBytes: newBytes,
      newFiles: newFiles,
    );
    await _writeAtomic(
      boundary,
      'backups/snapshots/$id/manifest.json',
      utf8.encode(jsonEncode(_manifestJson(snapshot))),
    );
    return snapshot;
  }

  Map<String, Object?> _manifestJson(BackupSnapshot snapshot) => {
    'version': 1,
    'id': snapshot.id,
    'createdAt': snapshot.createdAt.toIso8601String(),
    'trigger': snapshot.trigger.code,
    'totals': {
      'files': snapshot.fileCount,
      'sourceBytes': snapshot.sourceBytes,
      'newBytes': snapshot.newBytes,
      'newFiles': snapshot.newFiles,
    },
    'files': [for (final file in snapshot.files) file.toJson()],
  };

  BackupSnapshot _parseManifest(Object? raw, {String? expectedId}) {
    if (raw is! Map || raw['version'] != 1) {
      throw const FormatException('不支持的清单格式');
    }
    final id = raw['id'];
    if (id is! String) throw const FormatException('缺少快照 id');
    _validateId(id);
    if (expectedId != null && id != expectedId) {
      throw const FormatException('快照 id 与目录不符');
    }
    final files = BackupPaths.parseFiles(raw['files']);
    final stamp = raw['createdAt'];
    final created = stamp is String ? DateTime.tryParse(stamp) : null;
    if (created == null) throw const FormatException('无效快照时间');
    final bytes = files.fold<int>(0, (sum, file) => sum + file.size);
    final totals = raw['totals'];
    if (totals is! Map ||
        totals['files'] != files.length ||
        totals['sourceBytes'] != bytes) {
      throw const FormatException('清单总量与文件列表不符');
    }
    return BackupSnapshot(
      id: id,
      createdAt: created,
      trigger: BackupTrigger.fromCode(raw['trigger'] as String?),
      files: files,
      sourceBytes: bytes,
      newBytes: totals['newBytes'] as int? ?? bytes,
      newFiles: totals['newFiles'] as int? ?? files.length,
    );
  }

  void _validateId(String id) {
    if (!RegExp(r'^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$').hasMatch(id)) {
      throw const FormatException('不安全的快照 id');
    }
  }

  Future<BackupSnapshot> _readManifest(_Boundary boundary, String id) async {
    _validateId(id);
    final file = File(
      await boundary.check(
        'backups/snapshots/$id/manifest.json',
        required: true,
      ),
    );
    return _parseManifest(
      jsonDecode(await file.readAsString()),
      expectedId: id,
    );
  }

  Future<List<BackupSnapshot>> _readAllManifests(_Boundary boundary) async {
    final dir = Directory(
      await boundary.check('backups/snapshots', directory: true),
    );
    if (!await dir.exists()) return [];
    final out = <BackupSnapshot>[];
    await for (final entity in dir.list(followLinks: false)) {
      if (entity is! Directory) {
        throw FileSystemException('快照目录中有异常条目', entity.path);
      }
      final id = entity.uri.pathSegments.where((s) => s.isNotEmpty).last;
      out.add(await _readManifest(boundary, id));
    }
    out.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return out;
  }

  Future<List<File>> _objects(_Boundary boundary) async {
    final dir = Directory(
      await boundary.check('backups/objects', directory: true),
    );
    if (!await dir.exists()) return [];
    final out = <File>[];
    await for (final shard in dir.list(followLinks: false)) {
      if (shard is! Directory) throw FileSystemException('无效对象分片', shard.path);
      await for (final entity in shard.list(followLinks: false)) {
        if (entity is! File) throw FileSystemException('无效对象文件', entity.path);
        final name = entity.uri.pathSegments.last;
        final expected = await boundary.check(_objectRel(name), required: true);
        if (expected != entity.path) {
          throw FileSystemException('对象分片不匹配', entity.path);
        }
        out.add(entity);
      }
    }
    return out;
  }

  Future<void> _prune(_Boundary boundary, int keep) async {
    final snapshots = await _readAllManifests(boundary);
    for (final snapshot in snapshots.skip(keep.clamp(1, 10000))) {
      final path = await boundary.check(
        'backups/snapshots/${snapshot.id}',
        directory: true,
        required: true,
      );
      await Directory(path).delete(recursive: true);
    }
  }

  Future<int> _collectGarbage(_Boundary boundary) async {
    final referenced = {
      for (final snapshot in await _readAllManifests(boundary))
        for (final file in snapshot.files) file.hash,
    };
    var freed = 0;
    for (final file in await _objects(boundary)) {
      if (!referenced.contains(file.uri.pathSegments.last)) {
        freed += await file.length();
        await file.delete();
      }
    }
    return freed;
  }

  Future<String> _allocateId(_Boundary boundary, DateTime now) async {
    String two(int value) => '$value'.padLeft(2, '0');
    final base =
        '${now.year}${two(now.month)}${two(now.day)}-'
        '${two(now.hour)}${two(now.minute)}${two(now.second)}';
    var id = base;
    var n = 2;
    while (await Directory(
      await boundary.check('backups/snapshots/$id', directory: true),
    ).exists()) {
      id = '$base-${n++}';
    }
    return id;
  }

  Future<void> _writeAtomic(
    _Boundary boundary,
    String rel,
    List<int> bytes,
  ) async {
    final target = File(await boundary.check(rel));
    await target.parent.create(recursive: true);
    await boundary.check(rel);
    // 随机私有临时目录避免固定 .tmp/.part 名称被预先植入 symlink。
    final staging = await target.parent.createTemp('.ondra-backup-');
    try {
      final file = File('${staging.path}/content');
      await file.writeAsBytes(bytes, flush: true);
      await boundary.check(rel);
      await file.rename(target.path);
    } finally {
      await staging.delete(recursive: true);
    }
  }
}

class _Captured {
  const _Captured(this.entry, this.bytes);
  final BackupFileEntry entry;
  final List<int> bytes;
}

/// 以解析后的目录为边界，检查每个已存在的组件。为避免别名目标与代码目录
/// 互相绕过白名单，边界内的 symlink（即使仍指向边界内）一律拒绝。
/// Dart IO 没有 openat/O_NOFOLLOW；这不是抵御其他进程并发替换目录的沙箱。
class _Boundary {
  const _Boundary(this.path);
  final String path;

  static Future<_Boundary> open(String base) async {
    final absolute = Directory(base).absolute;
    final type = await FileSystemEntity.type(absolute.path, followLinks: false);
    if (type == FileSystemEntityType.link) {
      throw FileSystemException('根目录不能是符号链接', base);
    }
    if (type != FileSystemEntityType.notFound &&
        type != FileSystemEntityType.directory) {
      throw FileSystemException('根路径不是目录', base);
    }
    if (type == FileSystemEntityType.directory) {
      return _Boundary(await absolute.resolveSymbolicLinks());
    }
    final parent = await open(absolute.parent.path);
    final leaf = absolute.uri.pathSegments.where((s) => s.isNotEmpty).last;
    if (!BackupPaths.isRelative(leaf)) {
      throw FileSystemException('不安全的根目录名', base);
    }
    return _Boundary('${parent.path}${Platform.pathSeparator}$leaf');
  }

  Future<String> check(
    String rel, {
    bool directory = false,
    bool required = false,
  }) async {
    if (!BackupPaths.isRelative(rel)) throw FormatException('不安全的相对路径：$rel');
    var current = path;
    final parts = rel.split('/');
    for (var i = 0; i < parts.length; i++) {
      current = '$current${Platform.pathSeparator}${parts[i]}';
      final type = await FileSystemEntity.type(current, followLinks: false);
      if (type == FileSystemEntityType.link) {
        throw FileSystemException('路径中不允许符号链接', current);
      }
      if (type == FileSystemEntityType.notFound) {
        if (required) throw FileSystemException('缺少文件或对象', current);
        continue;
      }
      final isDir = i < parts.length - 1 || directory;
      if (type !=
          (isDir
              ? FileSystemEntityType.directory
              : FileSystemEntityType.file)) {
        throw FileSystemException('路径类型冲突', current);
      }
      final resolved = await (isDir
          ? Directory(current).resolveSymbolicLinks()
          : File(current).resolveSymbolicLinks());
      if (!_within(path, resolved)) {
        throw FileSystemException('解析后的路径越界', current);
      }
    }
    return current;
  }
}

bool _within(String root, String target) {
  if (Platform.isWindows) {
    root = root.toLowerCase();
    target = target.toLowerCase();
  }
  return target == root || target.startsWith('$root${Platform.pathSeparator}');
}

bool _equalBytes(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

/// v1 清单的双 FNV 指纹：用于完整性/去重，不是签名或可信来源证明。
String _fingerprint(List<int> bytes) {
  var a = 0x811c9dc5;
  var b = 0x9e3779b9;
  for (var i = 0; i < bytes.length; i++) {
    final v = bytes[i];
    a = ((a ^ v) * 0x01000193) & 0xFFFFFFFF;
    b = ((b ^ (v + i)) * 0x85EBCA6B) & 0xFFFFFFFF;
    b ^= b >> 13;
  }
  String hex(int value) =>
      (value & 0xFFFFFFFF).toRadixString(16).padLeft(8, '0');
  return hex(a) + hex(b);
}

/// 自动备份只在应用运行时调度；页面与调度器共用同一个串行队列。
class BackupScheduler {
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
    unawaited(tick());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  Future<void> tick() async {
    if (_busy) return;
    _busy = true;
    try {
      final settings = await engine.readSettings();
      if (!settings.auto) return;
      final last = settings.lastAt;
      final interval = Duration(
        minutes: settings.intervalMinutes.clamp(1, 24 * 60),
      );
      if (last != null && _now().difference(last) < interval) return;
      await engine.create(trigger: BackupTrigger.auto);
    } catch (_) {
      // 不刷新成功时间；失败不会让后续调度永久卡住。
    } finally {
      _busy = false;
    }
  }
}

final BackupEngine backupEngine = BackupEngine(
  dataIsOffline: () => dataMaintenance.offline,
);
final BackupScheduler backupScheduler = BackupScheduler(backupEngine);
