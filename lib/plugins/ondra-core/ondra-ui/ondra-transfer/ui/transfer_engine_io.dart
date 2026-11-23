import 'dart:convert';

import 'package:archive/archive.dart';

import 'dart:io';

import '../../../../../app/desktop_picker.dart';

import '../../../../../app/sqlite_cli.dart';
import '../../ondra-backup/ui/backup_actions.dart'
    show backupCreate, backupExport, backupImport, backupOverviewLoader;
import 'transfer_model.dart';
import '../../ondra-settings/ui/maintenance_io.dart'
    show maintenanceDataIsOffline, maintenanceOfflineHint;
import '../../../../../app/home_dir.dart';
import '../../../../../app/data_maintenance.dart';
import '../../../../../app/runtime_seed.dart';

/// 本机的 `sqlite3` 命令行。解析交给 `app/sqlite_cli.dart`：
/// 从前这里写死 `/usr/bin/sqlite3`，在 Windows 上导入导出会直接失败。
String get _sqlite {
  final path = ondraSqliteCli;
  if (path == null) {
    throw ProcessException('sqlite3', [], ondraSqliteMissingHint);
  }
  return path;
}

/// 导出文件名的前缀。带时间戳是为了「同一天导两次」不会互相覆盖，
/// 用户不必先想「放哪、叫什么」。
const String _prefix = '空谷';

/// 导入导出的执行体。
///
/// 三件事全部落到真文件上：
/// - **导出记忆**：读 `~/.ondra/user/ondra.db` 的 `memory_fact` / `memory_link`，
///   写成 Markdown（给人读）或 JSON（给程序读，可再导回）；
/// - **导出人设与偏好**：`prefs.json` + `personas/`（与人设插件同一个目录）；
/// - **整包**：不另起一套打包逻辑，直接复用备份引擎的自包含导出——
///   备份能带走的东西，正好就是「换台机器还是同一个空谷」需要的东西。
///
/// 导入是**会写库**的，因此有一条硬规矩：写之前先存一份备份。记忆是用户的东西，
/// 一次写坏就是永久损失，而这个动作的成本只有几百毫秒。
class TransferEngine {
  /// [home] 是桌面壳数据根所在的 OS 用户目录；[dshHome] 是内核 DSH_HOME。
  ///
  /// 两者不能强行合并：设置了 `ONDRA_DSH_HOME` 的用户可以让内核数据与
  /// `~/.ondra/user/ondra.db` 分居不同卷。显式参数用于隔离测试，生产不传。
  TransferEngine({
    String? home,
    String? dshHome,
    DateTime Function()? now,
    this.dataIsOffline,
  }) : _home = home ?? ondraUserHome,
       _dshHome =
           dshHome ??
           (home != null
               ? '$home/.ondra/dsh'
               : Platform.environment['ONDRA_DSH_HOME'] ??
                     '$ondraUserHome/.ondra/dsh'),
       _now = now ?? DateTime.now;

  final bool Function()? dataIsOffline;
  bool get _offline =>
      dataIsOffline?.call() ?? maintenanceDataIsOffline(dataRoot);
  final String _home;
  final String _dshHome;
  final DateTime Function() _now;

  String get home => _home;
  String get dataRoot => '$_home/.ondra';
  String get dbPath => '$dataRoot/user/ondra.db';
  String get dshHome => _dshHome;

  String get _profilePatch =>
      '$_dshHome/profiles/$ondraRuntimeProfileName/cordis.patch.yml';

  /// 暂存区里的固定键。真实 profile 可能位于 dataRoot 外，不能用它直接
  /// 拼暂存路径；提交时再由 [_targetPath] 映射到内核实际读取的位置。
  static const _profileStageKey = '.profile/cordis.patch.yml';

  String get _personaSubdir => _readPersonaSubdir(_profilePatch);

  // ── 读取 ────────────────────────────────────────────────────────────────

  /// 读一次「本机有什么」。页面上每个数字都来自这里，没有一项是估的。
  Future<TransferSnapshot> load() async {
    final backups = await _backupStats();
    final db = File(dbPath);
    if (!db.existsSync()) {
      return TransferSnapshot(
        facts: 0,
        raws: 0,
        links: 0,
        sessions: _sessionCount(),
        personaPacks: _personaPacks().length,
        archivedFacts: 0,
        dbBytes: 0,
        logBytes: _logBytes(),
        snapshotCount: backups.$1,
        snapshotBytes: backups.$2,
        note: '还没有记忆库（内核第一次收到对话后才会建）；人设与偏好仍可导出。',
      );
    }

    try {
      final facts = await _count('select count(*) from memory_fact');
      final archived = await _count(
        'select count(*) from memory_fact where archived = 1',
      );
      final raws = await _count('select count(*) from memory_raw');
      final links = await _count('select count(*) from memory_link');
      final lastRows = await _query(
        'select max(created_at) as at from memory_fact',
      );
      final lastAt = lastRows.isEmpty ? null : _time(lastRows.first['at']);

      return TransferSnapshot(
        facts: facts,
        raws: raws,
        links: links,
        sessions: _sessionCount(),
        personaPacks: _personaPacks().length,
        archivedFacts: archived,
        dbBytes: _fileSize(dbPath) + _fileSize('$dbPath-wal'),
        logBytes: _logBytes(),
        snapshotCount: backups.$1,
        snapshotBytes: backups.$2,
        lastFactAt: lastAt,
      );
    } on ProcessException catch (e) {
      return TransferSnapshot(
        facts: 0,
        raws: 0,
        links: 0,
        sessions: _sessionCount(),
        personaPacks: _personaPacks().length,
        archivedFacts: 0,
        dbBytes: _fileSize(dbPath),
        logBytes: _logBytes(),
        snapshotCount: backups.$1,
        snapshotBytes: backups.$2,
        note: '读不到记忆库：${_clean(e)}',
      );
    }
  }

  // ── 导出 ────────────────────────────────────────────────────────────────

  /// 导出记忆。返回的文件名带时间戳，写完后回读一次确认不是空文件。
  Future<TransferResult> exportMemory(String dir, TransferFormat format) async {
    final out = Directory(dir);
    if (!out.existsSync()) {
      return const TransferResult.fail('目标目录不存在。');
    }
    try {
      final facts = await _readFacts();
      final links = await _readLinks();
      if (facts.isEmpty) {
        return const TransferResult.fail('记忆库里还没有事实，导出会是一份空文件。先去聊几句再回来。');
      }

      final stamp = _stamp();
      final name = '$_prefix记忆-$stamp.${format.extension}';
      // 同一秒导出两次会撞名（时间戳只到秒）：有重名就在名字里加序号，
      // 而不是把上一份悄悄覆盖掉（alpha.10 审查第 12 项）。
      var target = File('${out.path}/$name');
      var n = 2;
      while (target.existsSync()) {
        final dot = name.lastIndexOf('.');
        final stem = dot > 0 ? name.substring(0, dot) : name;
        final ext = dot > 0 ? name.substring(dot) : '';
        target = File('${out.path}/$stem-$n$ext');
        n++;
      }
      final file = target;
      // 导出的是完整记忆库快照：原文表存着事实引用的完整说话记录，
      // 只带 facts 会让换机后的 source_raw_id 变成悬空编号。
      final rawTexts = await _readRawTexts();
      final text = format == TransferFormat.markdown
          ? _markdownOf(facts, links)
          : _jsonOf(facts, links, rawTexts);

      await file.writeAsString(text, flush: true);

      // 回读一次。写成功但内容为空，是磁盘满或权限问题的典型表现，
      // 只看 writeAsString 有没有抛异常是发现不了的。
      final written = await file.length();
      if (written == 0) {
        return TransferResult.fail('写出来是个空文件，可能是磁盘空间不足。', path: file.path);
      }
      return TransferResult(
        ok: true,
        message:
            '导出 ${facts.length} 条记忆'
            '${links.isEmpty ? '' : '、${links.length} 条关联'}，'
            '${_humanSize(written)}。',
        path: file.path,
        count: facts.length,
      );
    } catch (e) {
      return TransferResult.fail('导出失败：${_clean(e)}');
    }
  }

  /// 导出人设与偏好。做成一个目录：`人设.json` + `偏好.json` + `personas/`。
  ///
  /// 为什么不是一个 `.ondra` 单文件：人设里有 Markdown 正文，打包成二进制之后
  /// 用户在 Finder 里看不见内容，也就没法判断「导出的到底是不是我要的那份」。
  Future<TransferResult> exportBundle(String dir) async {
    final out = Directory(dir);
    if (!out.existsSync()) {
      return const TransferResult.fail('目标目录不存在。');
    }
    Directory? partial;
    try {
      final sourceRoot = Directory(dataRoot);
      if (sourceRoot.existsSync() &&
          '${out.resolveSymbolicLinksSync()}/'.startsWith(
            '${sourceRoot.resolveSymbolicLinksSync()}/',
          )) {
        return const TransferResult.fail('不能把人设导出到当前数据目录内部。');
      }
      final root = await out.createTemp('$_prefix人设-${_stamp()}-');
      partial = root;

      var files = 0;

      final prefs = File('$dataRoot/prefs.json');
      if (prefs.existsSync()) {
        await prefs.copy('${root.path}/偏好.json');
        files++;
      }

      final personas = _personaPacks();
      for (final pack in personas) {
        final name = pack.uri.pathSegments.where((s) => s.isNotEmpty).last;
        await _copyTree(pack, Directory('${root.path}/personas/$name'));
        files++;
      }

      final personaConfig = _personaConfig();
      if (personaConfig.isNotEmpty) {
        await File('${root.path}/人设配置.yml')
            .writeAsString(personaConfig, flush: true);
        files++;
      }

      final avatar = File('$dataRoot/avatar.png');
      if (avatar.existsSync()) {
        await avatar.copy('${root.path}/头像.png');
        files++;
      }

      if (files == 0) {
        await root.delete(recursive: true);
        return const TransferResult.fail('没有可携带的人设或偏好：人设还是内置的那份，偏好也没改过。');
      }

      partial = null;
      return TransferResult(
        ok: true,
        message: '导出人设与偏好，共 $files 项。',
        path: root.path,
        count: files,
      );
    } catch (e) {
      return TransferResult.fail('导出失败：${_clean(e)}');
    } finally {
      if (partial != null && partial.existsSync()) {
        try {
          partial.deleteSync(recursive: true);
        } catch (_) {}
      }
    }
  }

  /// 整包导出：交给备份引擎，不另写一套打包逻辑。
  ///
  /// 每次都现场捕获当前状态，使用 create 返回的编号，不复用过期快照。
  Future<TransferResult> exportArchive(String dir) async {
    try {
      // 每次采集当前状态，不能把历史快照冒充「全部当前数据」。
      final created = await backupCreate();
      if (!created.ok) {
        return TransferResult.fail('先存一份快照失败：${created.message}');
      }
      final id = created.snapshotId;
      if (id == null) {
        return const TransferResult.fail('快照没有返回编号，未导出旧快照。');
      }
      final r = await backupExport(id, dir);
      return TransferResult(
        ok: r.ok,
        message: r.ok ? '整包已导出：${r.message}' : r.message,
        path: dir,
        count: r.ok ? 1 : 0,
      );
    } catch (e) {
      return TransferResult.fail('整包导出失败：${_clean(e)}');
    }
  }

  // ── 导入 ────────────────────────────────────────────────────────────────

  /// 按路径自动判断这份东西是什么，然后走对应的导入。
  ///
  /// 不要求用户先在下拉框里选「这是记忆还是人设」：文件名和内容本身说得清，
  /// 让用户选只是在把一个可以自动判断的事推回给他。
  Future<TransferResult> importPath(String path) async {
    try {
      final entity = FileSystemEntity.typeSync(path, followLinks: false);
      if (entity == FileSystemEntityType.notFound) {
        return const TransferResult.fail('找不到这个路径。');
      }
      if (entity == FileSystemEntityType.directory) {
        return await _importDir(path);
      }
      if (entity != FileSystemEntityType.file) {
        return const TransferResult.fail('不接受符号链接或特殊文件。');
      }
      return await _importFile(File(path));
    } catch (e) {
      return TransferResult.fail('导入失败：${_clean(e)}');
    }
  }

  Future<TransferResult> _importDir(String path) async {
    // 备份目录与「人设包目录」长得不一样：一个有 manifest，一个有偏好/人设文件。
    if (File('$path/ondra-snapshot.json').existsSync()) {
      final r = await backupImport(path);
      return TransferResult(
        ok: r.ok,
        message: r.ok ? '备份已导入：${r.message}' : r.message,
        path: path,
        count: r.ok ? 1 : 0,
      );
    }
    return _importBundle(path);
  }

  /// 先校验、暂存全部内容，再逐项 rename；任何失败都恢复被替换的旧内容。
  /// 不覆盖整个 profile，仅替换人设条目；同名包整体替换以免残留旧文件。
  Future<TransferResult> _importBundle(
    String path, {
    Map<String, String>? prefs,
  }) async {
    // 独立偏好是 UI 的小文件，不是内核活动库；原子合并可在线进行。
    if (prefs == null && !_offline) {
      return const TransferResult.fail(maintenanceOfflineHint);
    }
    final staged = await Directory.systemTemp.createTemp('ondra-transfer-');
    final targets = <String>[];
    var personaSubdir = _personaSubdir;
    try {
      if (prefs == null) {
        for (final relative in ['偏好.json', '人设配置.yml', '头像.png', 'personas']) {
          if (FileSystemEntity.isLinkSync('$path/$relative')) {
            throw FileSystemException('不接受符号链接', '$path/$relative');
          }
        }
      }
      void stageText(String relative, String text) {
        final file = File('${staged.path}/$relative');
        file.parent.createSync(recursive: true);
        file.writeAsStringSync(text, flush: true);
        targets.add(relative);
      }

      final prefsSrc = File('$path/偏好.json');
      if (prefs != null || prefsSrc.existsSync()) {
        final incoming =
            prefs ?? _prefsFromJson(jsonDecode(prefsSrc.readAsStringSync()));
        final local = File('$dataRoot/prefs.json');
        final merged = local.existsSync()
            ? _prefsFromJson(jsonDecode(local.readAsStringSync()))
            : <String, String>{};
        merged.addAll(incoming);
        stageText('prefs.json', jsonEncode(merged));
      }
      if (prefs == null) {
        final config = File('$path/人设配置.yml');
        if (config.existsSync()) {
          final profileFile = File(_profilePatch);
          final merged = _mergePersonaConfig(
            profileFile.existsSync()
                ? profileFile.readAsStringSync()
                : '- insert:\n',
            config.readAsStringSync(),
          );
          // loader 下一次启动读的是合并后的配置；ZIP 必须和它写在同一个
          // user 子目录，不能继续用本机导入前的旧值。
          personaSubdir = _readPersonaSubdirText(merged);
          stageText(_profileStageKey, merged);
        }
        final personas = Directory('$path/personas');
        if (personas.existsSync()) {
          for (final pack in personas.listSync(followLinks: false)) {
            if (pack is! Directory) throw const FormatException('人设目录含非目录项');
            final name = pack.uri.pathSegments.where((s) => s.isNotEmpty).last;
            final relative = 'personas/$name';
            await _copyTree(pack, Directory('${staged.path}/$relative'));
            targets.add(relative);
            // 内核读的是 user/personas/<slug>.skill.zip（PersonaStore.kernelRoot）：
            // 只复制 UI 解压目录会让换机后的内核看不到人设（alpha.10 审查
            // 第 14 项）。UI 目录里有 SKILL.md 就现场重打一份内核 ZIP；
            // 导出目录里已有 .skill.zip 的也一并带上。
            final kernelDir = Directory('${staged.path}/user/$personaSubdir');
            await kernelDir.create(recursive: true);
            final existingZip = File('${pack.path}/$name.skill.zip');
            if (existingZip.existsSync()) {
              await existingZip.copy('${kernelDir.path}/$name.skill.zip');
              targets.add('user/$personaSubdir/$name.skill.zip');
            } else if (File('${pack.path}/SKILL.md').existsSync()) {
              final packed = await _packSkillZip(pack, name);
              if (packed != null) {
                await packed.copy('${kernelDir.path}/$name.skill.zip');
                targets.add('user/$personaSubdir/$name.skill.zip');
              }
            }
          }
        }
        final avatar = File('$path/头像.png');
        if (avatar.existsSync()) {
          if (FileSystemEntity.isLinkSync(avatar.path)) {
            throw const FormatException('头像不能是符号链接');
          }
          await avatar.copy('${staged.path}/avatar.png');
          targets.add('avatar.png');
        }
      }
      if (targets.isEmpty) {
        return const TransferResult.fail('这个目录里既没有备份清单，也没有偏好或人设，认不出来。');
      }
      // 验证目标在备份前完成，绝不通过符号链接写出数据根目录。
      for (final relative in targets) {
        _checkTarget(relative);
      }
      final guard = await backupCreate();
      if (!guard.ok) return TransferResult.fail('写前备份失败，未导入：${guard.message}');
      await _commitBundle(staged, targets, preferences: prefs);
      return TransferResult(
        ok: true,
        message: '导入了 ${targets.length} 项人设与偏好，重启后生效。',
        path: path,
        // kernel zip 是 UI 人设目录的伴随产物，不计入迁移条目数。
        count:
            targets.where((t) => t.startsWith('personas/')).length +
            targets
                .where(
                  (t) =>
                      !t.startsWith('personas/') &&
                      !t.startsWith('user/$personaSubdir/'),
                )
                .length,
      );
    } finally {
      if (staged.existsSync()) await staged.delete(recursive: true);
    }
  }

  Map<String, String> _prefsFromJson(Object? value) {
    if (value is! Map ||
        value.keys.any((key) => key is! String) ||
        value.values.any((v) => v is! String && v is! num && v is! bool)) {
      throw const FormatException('偏好必须是键值对象，值只能是字符串、数字或布尔值');
    }
    return {
      for (final entry in value.entries) entry.key as String: '${entry.value}',
    };
  }

  void _checkTarget(String relative) {
    final isProfile = relative == _profileStageKey;
    var current = isProfile ? _dshHome : dataRoot;
    final parts = isProfile
        ? ['profiles', ondraRuntimeProfileName, 'cordis.patch.yml']
        : relative.split('/');
    if (FileSystemEntity.isLinkSync(current)) {
      throw const FileSystemException('数据根目录是符号链接');
    }
    for (var i = 0; i < parts.length; i++) {
      current = '$current/${parts[i]}';
      final type = FileSystemEntity.typeSync(current, followLinks: false);
      if (type == FileSystemEntityType.link ||
          (i < parts.length - 1 &&
              type != FileSystemEntityType.notFound &&
              type != FileSystemEntityType.directory)) {
        throw FileSystemException('目标路径不是安全的目录/文件', current);
      }
    }
  }

  String _targetPath(String relative) {
    if (relative == _profileStageKey) return _profilePatch;
    return '$dataRoot/$relative';
  }

  Future<void> _commitBundle(
    Directory staged,
    List<String> targets, {
    Map<String, String>? preferences,
  }) async {
    if (preferences == null && !_offline) {
      throw StateError(maintenanceOfflineHint);
    }
    Directory(dataRoot).createSync(recursive: true);
    final transaction = Directory(dataRoot).createTempSync('.transfer-');
    final committed = <String>[];
    final originals = <String>[];
    var safeToDelete = false;
    try {
      for (final relative in targets) {
        final src = '${staged.path}/$relative';
        // 目标可能在 dataRoot 外（自定义 DSH_HOME），因此新副本必须放在
        // 目标所在卷；否则跨卷 rename 会在提交中途失败。
        final next = _stagingPath(transaction, relative);
        Directory(File(next).parent.path).createSync(recursive: true);
        if (FileSystemEntity.isDirectorySync(src)) {
          await _copyTree(Directory(src), Directory(next));
        } else {
          await File(src).copy(next);
        }
      }
      for (final relative in targets) {
        _checkTarget(relative);
        final target = _targetPath(relative);
        File(target).parent.createSync(recursive: true);
        if (relative == 'prefs.json' && preferences != null) {
          // 备份/暂存期间 UI 可能又改了偏好，提交前同步重读合并，避免覆盖新值。
          final local = File(target);
          final merged = local.existsSync()
              ? _prefsFromJson(jsonDecode(local.readAsStringSync()))
              : <String, String>{};
          merged.addAll(preferences);
          File(_stagingPath(transaction, relative))
              .writeAsStringSync(jsonEncode(merged), flush: true);
        }
        if (FileSystemEntity.typeSync(target) !=
            FileSystemEntityType.notFound) {
          final old = _backupPath(transaction, relative);
          File(old).parent.createSync(recursive: true);
          _rename(target, old);
          originals.add(relative);
        }
        _rename(_stagingPath(transaction, relative), target);
        committed.add(relative);
      }
      safeToDelete = true;
    } catch (_) {
      for (final relative in committed.reversed) {
        final target = _targetPath(relative);
        if (FileSystemEntity.isDirectorySync(target)) {
          Directory(target).deleteSync(recursive: true);
        } else {
          File(target).deleteSync();
        }
      }
      for (final relative in originals.reversed) {
        _rename(_backupPath(transaction, relative), _targetPath(relative));
      }
      safeToDelete = true;
      rethrow;
    } finally {
      // 回滚失败时保留 old，不能在 finally 里把唯一旧副本也删掉。
      if (safeToDelete) {
        for (final relative in targets) {
          for (final path in [
            _stagingPath(transaction, relative),
            _backupPath(transaction, relative),
          ]) {
            try {
              final entity = FileSystemEntity.typeSync(
                path,
                followLinks: false,
              );
              if (entity == FileSystemEntityType.directory) {
                Directory(path).deleteSync(recursive: true);
              } else if (entity != FileSystemEntityType.notFound) {
                File(path).deleteSync();
              }
            } catch (_) {
              // 清理失败不改变已经提交成功的结果；事务目录仍会保留。
            }
          }
        }
        try {
          transaction.deleteSync(recursive: true);
        } catch (_) {}
      }
    }
  }

  String _stagingPath(Directory transaction, String relative) {
    if (relative == _profileStageKey) {
      final target = File(_profilePatch);
      return '${target.parent.path}/.ondra-transfer-new-$pid-${transaction.uri.pathSegments.last}';
    }
    return '${transaction.path}/new/$relative';
  }

  String _backupPath(Directory transaction, String relative) {
    if (relative == _profileStageKey) {
      final target = File(_profilePatch);
      return '${target.parent.path}/.ondra-transfer-old-$pid-${transaction.uri.pathSegments.last}';
    }
    return '${transaction.path}/old/$relative';
  }

  void _rename(String source, String target) {
    if (FileSystemEntity.isDirectorySync(source)) {
      Directory(source).renameSync(target);
    } else {
      File(source).renameSync(target);
    }
  }

  Future<TransferResult> _importFile(File file) async {
    final lower = file.path.toLowerCase();
    final String text;
    try {
      text = await file.readAsString();
    } catch (e) {
      return TransferResult.fail('读不了这个文件：${_clean(e)}');
    }

    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      return _importFacts(
        _parseMarkdown(text),
        links: _markdownLinks(text),
        source: file.path,
      );
    }
    if (lower.endsWith('.json')) {
      final Object? decoded;
      try {
        decoded = jsonDecode(text);
      } catch (e) {
        return TransferResult.fail('这不是合法的 JSON：${_clean(e)}');
      }
      if (decoded is List ||
          decoded is Map &&
              (decoded.containsKey('facts') ||
                  decoded['format'] == 'ondra.memory')) {
        return _importFacts(
          _factsFromJson(decoded),
          links: _linksFromJson(decoded),
          rawTexts: _rawsFromJson(decoded),
          source: file.path,
        );
      }
      // prefs 是扁平字符串表，并不要求用户改过主题。按真实应用使用的键识别。
      if (decoded is Map &&
          decoded.keys.any(
            (key) =>
                key is String &&
                (key.startsWith('settings.') || _prefKeys.contains(key)),
          )) {
        return _importBundle(file.path, prefs: _prefsFromJson(decoded));
      }
      return const TransferResult.fail('这份 JSON 里没有记忆（找不到 facts 数组），也不像偏好文件。');
    }
    return TransferResult.fail('不认识的格式：${file.path.split('/').last}');
  }

  /// 真正写库的地方。
  ///
  /// 同 id 异文拒绝整批；同文异 id 去重并重映射关联端点。
  /// 事实和关联在同一个 bail-on-error 事务提交，按数据库实际 changes() 计数。
  static const _prefKeys = {
    'themeMode',
    'language',
    'onboardingDone',
    'persona.activeId',
    'persona.nickname',
    'channels.qqAppId',
  };

  Future<TransferResult> _importFacts(
    List<TransferFact> facts, {
    List<TransferLink> links = const [],
    List<Map<String, Object?>> rawTexts = const [],
    required String source,
  }) async {
    if (facts.isEmpty) {
      return const TransferResult.fail('这份文件里没有可导入的记忆。');
    }
    final db = File(dbPath);
    if (!db.existsSync()) {
      return const TransferResult.fail('还没有记忆库。先让空谷收到一次对话，它会自己建库，再来导入。');
    }

    try {
      // 去重键 = 正文 + 人物：同一句话 A 和 B 各说一遍是两条独立记忆，
      // 只比正文会把 B 的记录吞掉（alpha.10 审查第 8 项）。
      final existing = await _query(
        'select id, text, subject from memory_fact',
      );
      String dedupeKey(String text, String subject) =>
          '${text.trim()}\u{1}\u{1}${subject.trim()}';
      final byId = {
        for (final row in existing) _text(row['id']): _text(row['text']).trim(),
      };
      final byText = {
        for (final row in existing)
          dedupeKey(_text(row['text']), _text(row['subject'])): _text(
            row['id'],
          ),
      };
      final remapped = <String, String>{};
      final toWrite = <TransferFact>[];
      final stateUpdates = <TransferFact>[];
      for (final f in facts) {
        if (byId.containsKey(f.id) && byId[f.id] != f.text.trim()) {
          return TransferResult.fail('记忆编号 ${f.id} 的内容冲突，整份导入已取消，未覆盖本机记忆。');
        }
        final key = dedupeKey(f.text, f.subject);
        final target = byText[key];
        if (target != null) {
          remapped[f.id] = target;
          stateUpdates.add(
            TransferFact(
              id: target,
              category: f.category,
              text: f.text,
              salience: f.salience,
              createdAt: f.createdAt,
              evidence: f.evidence,
              subject: f.subject,
              archived: f.archived,
              sealed: f.sealed,
              revisions: f.revisions,
              oldText: f.oldText,
              sourceRawId: f.sourceRawId,
              timesSaid: f.timesSaid,
              hits: f.hits,
              lastSeenAt: f.lastSeenAt,
            ),
          );
        } else {
          toWrite.add(f);
          remapped[f.id] = f.id;
          byText[key] = f.id;
        }
        byId[f.id] = f.text.trim();
      }
      final known = {
        ...existing.map((r) => _text(r['id'])),
        ...toWrite.map((f) => f.id),
      };
      for (final link in links) {
        if (!known.contains(remapped[link.from] ?? link.from) ||
            !known.contains(remapped[link.to] ?? link.to)) {
          return const TransferResult.fail('关联引用了不存在的记忆，整份导入已取消。');
        }
      }
      final guard = await backupCreate();
      if (!guard.ok) return TransferResult.fail('写前备份失败，未写库：${guard.message}');
      final result = await _exec(
        _insertSql(toWrite, links, remapped, rawTexts, stateUpdates),
      );
      final written = _int(result['facts']);
      final linked = _int(result['links']);
      final raws = _int(result['raws']);
      final skipped = facts.length - toWrite.length;
      final unwritten = toWrite.length - written;
      return TransferResult(
        ok: true,
        message:
            '导入 $written 条记忆、$linked 条关联，$skipped 条重复记忆跳过；'
            '${unwritten == 0 ? '' : '$unwritten 条被数据库规则忽略；'}'
            '${links.length == linked ? '' : '${links.length - linked} 条关联未新增；'}'
            '${raws == 0 ? '' : '$raws 条原文随行；'}'
            '记忆库现有 ${result['total']} 条。',
        path: source,
        count: written,
        skipped: skipped,
      );
    } catch (e) {
      return TransferResult.fail('写库失败（本批未提交）：${_clean(e)}');
    }
  }

  // ── 系统面板 ────────────────────────────────────────────────────────────

  /// 让用户挑一个目录。走系统的选目录面板，不自己造文件浏览器。
  /// Windows 也走系统面板（DesktopPicker，alpha.10 审查第 3 项：此处原来
  /// 只调 macOS 的 osascript，代码页 936 的机器报「找不到指定的文件」）。
  Future<String?> pickDirectory(String prompt) async {
    return DesktopPicker.pickDirectory(prompt);
  }

  /// 让用户挑一个文件。扩展名列表给空表示不限。
  Future<String?> pickFile(String prompt, List<String> extensions) async {
    return DesktopPicker.pickFile(prompt: prompt);
  }

  /// 在系统文件管理器里选中导出的东西。用户刚写完一个文件，下一步一定是
  /// 去找它。macOS 走 `open -R`；Windows 走 explorer /select。
  Future<TransferResult> reveal(String path) async {
    try {
      final List<String> args;
      final String command;
      if (Platform.isWindows) {
        command = 'explorer';
        args = ['/select,', path];
      } else {
        command = 'open';
        args = ['-R', path];
      }
      final result = await Process.run(command, args);
      if (result.exitCode != 0) {
        return TransferResult.fail('打不开文件管理器：${result.stderr}');
      }
      return TransferResult(ok: true, message: '已在文件管理器中打开。', path: path);
    } catch (e) {
      return TransferResult.fail('打不开文件管理器：${_clean(e)}');
    }
  }

  // ── 内部：读库 ──────────────────────────────────────────────────────────

  Future<List<TransferFact>> _readFacts() async {
    final rows = await _query(
      'select id, category, text, salience, created_at, subject, evidence, '
      'archived, sealed, revisions, old_text, source_raw_id, '
      'times_said, hits, last_seen_at '
      'from memory_fact where text is not null and text <> \'\' '
      'order by created_at asc',
    );
    return [
      for (final row in rows)
        if (_text(row['id']).isNotEmpty)
          TransferFact(
            id: _text(row['id']),
            category: _text(row['category']),
            text: _text(row['text']).trim(),
            salience: _number(row['salience'], 50),
            createdAt: _time(row['created_at']) ?? _now(),
            subject: _text(row['subject']),
            evidence: _text(row['evidence']),
            archived: _int(row['archived']) == 1,
            sealed: _int(row['sealed']) == 1,
            revisions: _int(row['revisions']),
            oldText: _text(row['old_text']),
            sourceRawId: _text(row['source_raw_id']),
            timesSaid: _int(row['times_said']),
            hits: _int(row['hits']),
            lastSeenAt: _int(row['last_seen_at']),
          ),
    ];
  }

  Future<List<TransferLink>> _readLinks() async {
    final rows = await _query('select * from memory_link');
    return [
      for (final row in rows)
        TransferLink(
          from: _text(row['from_id']),
          to: _text(row['to_id']),
          weight: _number(row['weight'], 0.5),
          id: _text(row['id']),
          relation: _text(row['relation']),
          hits: _int(row['hits']),
          lastFiredAt: _int(row['last_fired_at']),
          decayedAt: _int(row['decayed_at']),
          createdAt: _int(row['created_at']),
          approved: _int(row['approved']),
          surreal: _int(row['surreal']),
        ),
    ];
  }

  Future<List<Map<String, Object?>>> _readRawTexts() async {
    final rows = await _query(
      'select id, turn_id, role, text, created_at, meta from memory_raw '
      'order by created_at asc',
    );
    return [
      for (final row in rows)
        {
          'id': _text(row['id']),
          'turnId': _text(row['turn_id']),
          'role': _text(row['role']),
          'text': _text(row['text']),
          'createdAt': _int(row['created_at']),
          if (_text(row['meta']).isNotEmpty) 'meta': _text(row['meta']),
        },
    ];
  }

  List<Map<String, Object?>> _rawsFromJson(Object? decoded) {
    if (decoded is! Map || decoded['memory_raw'] is! List) return const [];
    final out = <Map<String, Object?>>[];
    for (final item in (decoded['memory_raw'] as List)) {
      if (item is! Map || _text(item['id']).isEmpty) continue;
      out.add({
        'id': _text(item['id']),
        'turnId': _text(item['turnId']),
        'role': _text(item['role']),
        'text': _text(item['text']),
        'createdAt': _int(item['createdAt']),
        if (_text(item['meta']).isNotEmpty) 'meta': _text(item['meta']),
      });
    }
    return out;
  }

  Future<int> _count(String sql) async {
    final rows = await _query(sql);
    if (rows.isEmpty) return 0;
    return _int(rows.first.values.first);
  }

  /// 跑一条查询，把 `-json` 输出解析成行列表。零行时 sqlite3 输出空串，不是 `[]`。
  Future<List<Map<String, dynamic>>> _query(String sql) async {
    // 首次调用就显式 UTF-8（alpha.10 审查：常规查询按系统编码解码，代码页
    // 936 下导出的中文是乱码、JSON 解析失败；备用查询反而是对的）。
    var r = await Process.run(
      _sqlite,
      ['-readonly', '-json', dbPath, sql],
      stdoutEncoding: utf8,
      stderrEncoding: utf8,
    );
    if (r.exitCode != 0) {
      // WAL 模式下 `-readonly` 需要能打开 `-wal` / `-shm`；这两个文件缺失
      // （刚被杀进程、或库是拷贝来的）时会报 CANTOPEN。这时退回 URI 只读，
      // 读主库里的内容——宁可少一条刚落盘的，也不该显示成「没有记忆」。
      r = await Process.run(
        _sqlite,
        ['-json', 'file:$dbPath?mode=ro', sql],
        // 同 memory_source_io：UTF-8 输出显式解码，防 Windows 代码页 936 乱码。
        stdoutEncoding: utf8,
        stderrEncoding: utf8,
      );
    }
    if (r.exitCode != 0) {
      throw ProcessException(
        _sqlite,
        const [],
        '${r.stderr}'.trim().isEmpty
            ? 'exit ${r.exitCode}'
            : '${r.stderr}'.trim(),
        r.exitCode,
      );
    }
    final text = '${r.stdout}'.trim();
    if (text.isEmpty) return const [];
    final decoded = jsonDecode(text);
    if (decoded is! List) return const [];
    return [
      for (final row in decoded)
        if (row is Map) row.cast<String, dynamic>(),
    ];
  }

  /// 跑一段写库脚本。走 stdin 而不是命令行参数：SQL 里带换行与引号，
  /// 拼进 argv 迟早会在某条记忆上炸掉。
  Future<Map<String, dynamic>> _exec(String sql) async {
    // CLI 默认出错继续执行，最终 COMMIT 会留下半批；-bail 让连接退出并回滚。
    final p = await Process.start(_sqlite, ['-bail', '-json', dbPath]);
    final output = p.stdout.transform(utf8.decoder).join();
    final errors = p.stderr.transform(utf8.decoder).join();
    p.stdin.write(sql);
    await p.stdin.close();
    final code = await p.exitCode;
    final err = await errors;
    final text = await output;
    if (code != 0) throw ProcessException(_sqlite, const [], err.trim(), code);
    return (jsonDecode(text) as List).single as Map<String, dynamic>;
  }

  /// 事实和关联同一事务；计数来自 SQLite changes()，不是尝试写入的条数。
  String _insertSql(
    List<TransferFact> facts,
    List<TransferLink> links,
    Map<String, String> remapped, [
    List<Map<String, Object?>> rawTexts = const [],
    List<TransferFact> stateUpdates = const [],
  ]) {
    final b = StringBuffer(
      'pragma foreign_keys=on;\nbegin immediate;\n'
      'create temp table imported(facts integer, links integer, raws integer);\n'
      'insert into imported values(0, 0, 0);\n',
    );
    for (final f in facts) {
      b
        ..write('insert into memory_fact (')
        ..write(
          'id, kind, category, channel, text, summary, subject, salience, '
          'arousal, stability_hours, stability_mult, times_said, hits, '
          'revisions, created_at, last_seen_at, archived, sealed, evidence, '
          'old_text, source_raw_id',
        )
        ..write(') values (')
        ..write(
          [
            _q(f.id),
            "'fact'",
            _q(f.category.isEmpty ? 'general' : f.category),
            "'import'",
            _q(f.text),
            _q(f.text),
            f.subject.isEmpty ? 'null' : _q(f.subject),
            _real(f.salience),
            _real(0.5),
            _real(24),
            _real(1),
            '${f.timesSaid}',
            '${f.hits}',
            '${f.revisions}',
            '${f.createdAt.millisecondsSinceEpoch}',
            '${f.lastSeenAt > 0 ? f.lastSeenAt : f.createdAt.millisecondsSinceEpoch}',
            f.archived ? '1' : '0',
            f.sealed ? '1' : '0',
            f.evidence.isEmpty ? 'null' : _q(f.evidence),
            f.oldText.isEmpty ? 'null' : _q(f.oldText),
            f.sourceRawId.isEmpty ? 'null' : _q(f.sourceRawId),
          ].join(', '),
        )
        ..write(');\nupdate imported set facts = facts + changes();\n');
    }
    // 目标库已有同文同人的事实时不插新行，但封存/修订/溯源与使用记录
    // 仍要由这份导出同步；否则两台都已用过的电脑永远停在各自旧状态。
    for (final f in stateUpdates) {
      final seen = f.lastSeenAt > 0
          ? f.lastSeenAt
          : f.createdAt.millisecondsSinceEpoch;
      b
        ..write('update memory_fact set ')
        ..write('sealed=${f.sealed ? 1 : 0}, ')
        ..write('revisions=${f.revisions}, ')
        ..write('old_text=${f.oldText.isEmpty ? 'null' : _q(f.oldText)}, ')
        ..write(
          'source_raw_id=${f.sourceRawId.isEmpty ? 'null' : _q(f.sourceRawId)}, ',
        )
        ..write('times_said=${f.timesSaid}, hits=${f.hits}, ')
        ..write('last_seen_at=$seen where id=${_q(f.id)};\n');
    }
    for (final raw in rawTexts) {
      b
        ..write(
          'insert or ignore into memory_raw '
          '(id, turn_id, role, text, created_at, meta) values (',
        )
        ..write(
          [
            _q(_text(raw['id'])),
            _q(_text(raw['turnId'])),
            _q(_text(raw['role'])),
            _q(_text(raw['text'])),
            '${_int(raw['createdAt'])}',
            _text(raw['meta']).isEmpty ? 'null' : _q(_text(raw['meta'])),
          ].join(', '),
        )
        ..write(');\nupdate imported set raws = raws + changes();\n');
    }
    for (final link in links) {
      final from = remapped[link.from] ?? link.from;
      final to = remapped[link.to] ?? link.to;
      final id = link.id.isEmpty
          ? 'l-${_factId(jsonEncode([from, to, link.relation]))}'
          : link.id;
      // 相同 id 但不同端点/关系不能被静默丢弃。相同语义的已有边保持本机值。
      b.writeln(
        'insert into memory_link '
        '(id, from_id, to_id, relation, weight, hits, last_fired_at, decayed_at, created_at, approved, surreal) '
        'select ${[_q(id), _q(from), _q(to), _q(link.relation), _real(link.weight), link.hits, link.lastFiredAt, link.decayedAt, link.createdAt, link.approved, link.surreal].join(', ')} '
        'where not exists (select 1 from memory_link where from_id=${_q(from)} and to_id=${_q(to)} and relation=${_q(link.relation)});',
      );
      b.writeln('update imported set links = links + changes();');
    }
    b.write(
      'commit;\nselect facts, links, raws, (select count(*) from memory_fact) as total from imported;\n',
    );
    return b.toString();
  }

  // ── 内部：两种读法 ──────────────────────────────────────────────────────

  String _markdownOf(List<TransferFact> facts, List<TransferLink> links) {
    final at = _stampHuman(_now());
    final b = StringBuffer()
      ..writeln('# 空谷记忆')
      ..writeln()
      ..writeln(
        '$at 导出于本机。共 ${facts.length} 条记忆'
        '${links.isEmpty ? '' : '、${links.length} 条关联'}。',
      )
      ..writeln()
      ..writeln(
        '一条一段。段首那行注释是给程序看的——有它，导回来就能和原记忆对上；'
        '删掉也不影响阅读，导回来时会当成新记忆。',
      )
      ..writeln()
      ..writeln('---')
      ..writeln();

    // 归档的排在最后：它们仍然属于用户，只是不在星图上画。
    final live = facts.where((f) => !f.archived);
    final archived = facts.where((f) => f.archived);
    for (final f in [...live, ...archived]) {
      b
        ..writeln('## ${f.text.replaceAll(RegExp(r'[\r\n]+'), ' ')}')
        ..writeln()
        ..writeln(
          '<!-- ondra:memory id=${f.id} category=${f.category} '
          'salience=${_real(f.salience)} '
          'created_at=${f.createdAt.millisecondsSinceEpoch}'
          ' times_said=${f.timesSaid} hits=${f.hits}'
          ' last_seen_at=${f.lastSeenAt}'
          '${f.oldText.isEmpty ? '' : ' old_text_b64=${base64Encode(utf8.encode(f.oldText))}'}'
          '${f.sourceRawId.isEmpty ? '' : ' source_raw_id_b64=${base64Encode(utf8.encode(f.sourceRawId))}'}'
          ' id_b64=${base64Encode(utf8.encode(f.id))}'
          ' category_b64=${base64Encode(utf8.encode(f.category))}'
          '${f.text.contains('\n') || f.text.contains('\r') ? ' text_b64=${base64Encode(utf8.encode(f.text))}' : ''}'
          '${f.subject.isEmpty ? '' : ' subject_b64=${base64Encode(utf8.encode(f.subject))}'}'
          '${f.evidence.isEmpty ? '' : ' evidence_b64=${base64Encode(utf8.encode(f.evidence))}'}'
          '${f.archived ? ' archived=1' : ''}'
          '${f.sealed ? ' sealed=1' : ''}'
          '${f.revisions > 0 ? ' revisions=${f.revisions}' : ''} -->',
        )
        ..writeln()
        ..writeln('- 类别：${f.category}')
        ..writeln('- 显著度：${f.salience.round()}')
        ..writeln('- 记录于：${_stampHuman(f.createdAt)}');
      if (f.archived) b.writeln('- 状态：已归档');
      if (f.sealed) b.writeln('- 状态：已封存');
      final quote = _firstQuote(f.evidence);
      if (quote != null) b.writeln('- 原话：「$quote」');
      b
        ..writeln()
        ..writeln('---')
        ..writeln();
    }

    if (links.isNotEmpty) {
      b
        ..writeln('## 关联')
        ..writeln()
        ..writeln(
          '<!-- ondra:links ${base64Encode(utf8.encode(jsonEncode({'links': links.map((l) => l.toJson()).toList()})))} -->',
        )
        ..writeln()
        ..writeln('| 从 | 到 | 权重 |')
        ..writeln('| --- | --- | --- |');
      for (final l in links) {
        b.writeln(
          '| `${l.from}` | `${l.to}` | ${l.weight.toStringAsFixed(2)} |',
        );
      }
      b.writeln();
    }
    return b.toString();
  }

  String _jsonOf(
    List<TransferFact> facts,
    List<TransferLink> links, [
    List<Map<String, Object?>> rawTexts = const [],
  ]) {
    final body = <String, Object?>{
      'format': 'ondra.memory',
      'version': 1,
      'exportedAt': _now().toUtc().toIso8601String(),
      'facts': [
        for (final f in facts)
          {
            'id': f.id,
            'category': f.category,
            'text': f.text,
            'salience': f.salience,
            'createdAt': f.createdAt.millisecondsSinceEpoch,
            if (f.subject.isNotEmpty) 'subject': f.subject,
            if (f.evidence.isNotEmpty) 'evidence': f.evidence,
            if (f.archived) 'archived': true,
            if (f.sealed) 'sealed': true,
            if (f.revisions > 0) 'revisions': f.revisions,
            if (f.oldText.isNotEmpty) 'oldText': f.oldText,
            if (f.sourceRawId.isNotEmpty) 'sourceRawId': f.sourceRawId,
            if (f.timesSaid > 0) 'timesSaid': f.timesSaid,
            if (f.hits > 0) 'hits': f.hits,
            if (f.lastSeenAt > 0) 'lastSeenAt': f.lastSeenAt,
          },
      ],
      'links': [for (final l in links) l.toJson()],
      if (rawTexts.isNotEmpty) 'memory_raw': rawTexts,
    };
    return const JsonEncoder.withIndent('  ').convert(body);
  }

  /// 解析 Markdown。规则只有三条，够用且不会误读：
  /// 1. `## ` 开一段，段标题就是记忆正文；
  /// 2. 段内 `<!-- ondra:memory ... -->` 给出 id / 类别 / 显著度 / 时间；
  /// 3. 没有注释的段落也收——用户手写的清单同样是一份记忆。
  List<TransferFact> _parseMarkdown(String text) {
    final out = <TransferFact>[];
    final lines = const LineSplitter().convert(text);
    String? title;
    final body = StringBuffer();

    void flush() {
      final t = (title ?? '').trim();
      if (t.isEmpty) {
        body.clear();
        return;
      }
      // 只有没有正规记忆编号的章节才是表格/标题。若标题本身就是一条
      // 记忆（例如用户真的记了「关联」「空谷记忆」），不能整条丢掉。
      final meta = _metaOf(body.toString());
      if ((t == '关联' || t == '空谷记忆') &&
          meta['id'] == null &&
          meta['id_b64'] == null) {
        title = null;
        body.clear();
        return;
      }
      out.add(
        TransferFact(
          id: meta['id_b64'] == null
              ? meta['id'] ?? _factId(t)
              : utf8.decode(base64Decode(meta['id_b64']!)),
          category: meta['category_b64'] == null
              ? meta['category'] ?? 'general'
              : utf8.decode(base64Decode(meta['category_b64']!)),
          text: meta['text_b64'] == null
              ? t
              : utf8.decode(base64Decode(meta['text_b64']!)),
          salience: double.tryParse(meta['salience'] ?? '') ?? 50,
          createdAt: meta['created_at'] == null
              ? _now()
              : DateTime.fromMillisecondsSinceEpoch(
                  int.tryParse(meta['created_at']!) ??
                      _now().millisecondsSinceEpoch,
                ),
          archived: meta['archived'] == '1',
          sealed: meta['sealed'] == '1',
          revisions: int.tryParse(meta['revisions'] ?? '') ?? 0,
          subject: meta['subject_b64'] == null
              ? ''
              : utf8.decode(base64Decode(meta['subject_b64']!)),
          evidence: meta['evidence_b64'] == null
              ? ''
              : utf8.decode(base64Decode(meta['evidence_b64']!)),
          oldText: meta['old_text_b64'] == null
              ? ''
              : utf8.decode(base64Decode(meta['old_text_b64']!)),
          sourceRawId: meta['source_raw_id_b64'] == null
              ? ''
              : utf8.decode(base64Decode(meta['source_raw_id_b64']!)),
          timesSaid: int.tryParse(meta['times_said'] ?? '') ?? 0,
          hits: int.tryParse(meta['hits'] ?? '') ?? 0,
          lastSeenAt: int.tryParse(meta['last_seen_at'] ?? '') ?? 0,
        ),
      );
      title = null;
      body.clear();
    }

    for (final line in lines) {
      if (line.startsWith('## ')) {
        flush();
        title = line.substring(3);
        continue;
      }
      if (title != null) body.writeln(line);
    }
    flush();
    return out;
  }

  /// 从 JSON 里认记忆。接受两种形状：我们导出的对象，或一个裸的数组。
  List<TransferFact> _factsFromJson(Object? decoded) {
    final List<Object?> raw;
    if (decoded is List) {
      raw = decoded;
    } else if (decoded is Map && decoded['facts'] is List) {
      raw = (decoded['facts'] as List).cast<Object?>();
    } else {
      return const [];
    }
    final out = <TransferFact>[];
    for (final item in raw) {
      if (item is! Map ||
          item['text'] is! String ||
          (item['text'] as String).trim().isEmpty) {
        throw const FormatException('事实条目必须含非空 text，整份导入已取消');
      }
      final text = (item['text'] as String).trim();
      final created = _int(item['createdAt']);
      out.add(
        TransferFact(
          id: _text(item['id']).isEmpty ? _factId(text) : _text(item['id']),
          category: _text(item['category']).isEmpty
              ? 'general'
              : _text(item['category']),
          text: text,
          salience: _number(item['salience'], 50),
          createdAt: created > 0
              ? DateTime.fromMillisecondsSinceEpoch(created)
              : _now(),
          subject: _text(item['subject']),
          evidence: _text(item['evidence']),
          archived: item['archived'] == true || _int(item['archived']) == 1,
          sealed: item['sealed'] == true || _int(item['sealed']) == 1,
          revisions: _int(item['revisions']),
          oldText: _text(item['oldText']),
          sourceRawId: _text(item['sourceRawId']),
          timesSaid: _int(item['timesSaid']),
          hits: _int(item['hits']),
          lastSeenAt: _int(item['lastSeenAt']),
        ),
      );
    }
    return out;
  }

  List<TransferLink> _linksFromJson(Object? decoded) {
    if (decoded is! Map || decoded['links'] == null) return const [];
    if (decoded['links'] is! List) throw const FormatException('links 必须是数组');
    return [for (final row in decoded['links'] as List) _linkFromJson(row)];
  }

  TransferLink _linkFromJson(Object? row) {
    if (row is! Map || _text(row['from']).isEmpty || _text(row['to']).isEmpty) {
      throw const FormatException('关联缺少 from/to');
    }
    return TransferLink(
      from: _text(row['from']),
      to: _text(row['to']),
      weight: _number(row['weight'], 0.5),
      id: _text(row['id']),
      relation: _text(row['relation']).isEmpty
          ? 'related'
          : _text(row['relation']),
      hits: _int(row['hits']),
      lastFiredAt: _int(row['lastFiredAt']),
      decayedAt: _int(row['decayedAt']),
      createdAt: _int(row['createdAt']),
      approved: row['approved'] == null ? 1 : _int(row['approved']),
      surreal: _int(row['surreal']),
    );
  }

  List<TransferLink> _markdownLinks(String text) {
    final encoded = RegExp(r'<!-- ondra:links ([A-Za-z0-9+/=]+) -->')
        .firstMatch(text);
    if (encoded != null) {
      return _linksFromJson(jsonDecode(utf8.decode(base64Decode(encoded[1]!))));
    }
    return [
      for (final m in RegExp(
        r'^\| `([^`]+)` \| `([^`]+)` \| ([\d.eE+-]+) \|$',
        multiLine: true,
      ).allMatches(text))
        TransferLink(from: m[1]!, to: m[2]!, weight: double.parse(m[3]!)),
    ];
  }

  Map<String, String> _metaOf(String block) {
    final m = RegExp(r'<!--\s*ondra:memory\s+([^>]*)-->').firstMatch(block);
    if (m == null) return const {};
    final out = <String, String>{};
    for (final pair in (m.group(1) ?? '').split(RegExp(r'\s+'))) {
      final i = pair.indexOf('=');
      if (i <= 0) continue;
      out[pair.substring(0, i)] = pair.substring(i + 1);
    }
    return out;
  }

  String? _firstQuote(String evidence) {
    if (evidence.isEmpty) return null;
    try {
      final decoded = jsonDecode(evidence);
      if (decoded is List && decoded.isNotEmpty) {
        final first = decoded.first;
        if (first is Map) {
          final q = _text(first['quote']).trim();
          if (q.isNotEmpty) return q;
        }
      }
    } catch (_) {
      // 证据链不是合法 JSON 就不显示原话，不该因此让整份导出失败。
    }
    return null;
  }

  // ── 内部：目录与时间 ────────────────────────────────────────────────────

  /// 备份引擎的份数与占用。读失败按 0 算：这一页的主语是「记忆能不能带走」，
  /// 不该因为备份目录读不了就整页报错。
  Future<(int, int)> _backupStats() async {
    try {
      final overview = await backupOverviewLoader();
      return (overview.snapshots.length, overview.storedBytes);
    } catch (_) {
      return (0, 0);
    }
  }

  int _sessionCount() {
    final root = Directory('$_dshHome/sessions');
    if (!root.existsSync()) return 0;
    var n = 0;
    for (final project in root.listSync().whereType<Directory>()) {
      for (final s in project.listSync().whereType<Directory>()) {
        if (File('${s.path}/session.v4.jsonl').existsSync()) n++;
      }
    }
    return n;
  }

  List<Directory> _personaPacks() {
    final root = Directory('$dataRoot/personas');
    if (!root.existsSync()) return const [];
    return root.listSync().whereType<Directory>().toList(growable: false);
  }

  int _logBytes() {
    final root = Directory('$dataRoot/logs');
    if (!root.existsSync()) return 0;
    var n = 0;
    for (final f in root.listSync().whereType<File>()) {
      if (f.path.endsWith('.log')) n += f.lengthSync();
    }
    return n;
  }

  /// 内核 profile 里与人设有关的那几段配置。
  ///
  /// 只抓 `- id: ondra-persona*` 起的整块（含其下的 `name` / `config` / `inject`），
  /// 抓到下一个同缩进的 `- id:` 为止。这是「人设是怎么组装的」唯一的事实来源。
  String _personaConfig() {
    final source = File(_profilePatch).existsSync()
        ? File(_profilePatch).readAsStringSync()
        : '';
    if (source.isEmpty) return '';
    final parsed = _profileEntries(source);
    return parsed.entries
        .where((e) => e.id.startsWith('ondra-persona'))
        .map(
          (e) => parsed.lines
              .sublist(e.start, e.end)
              .map(
                (line) => line.length >= parsed.indent
                    ? line.substring(parsed.indent)
                    : '',
              )
              .join('\n'),
        )
        .join('\n');
  }

  /// 与 persona loader 的 `completeConfig` 同口径：空值、路径分隔符和
  /// `..` 都回退到 `personas`，防止迁移把 ZIP 写进内核不会扫描的位置。
  String _readPersonaSubdir(String patchPath) {
    try {
      return _readPersonaSubdirText(File(patchPath).readAsStringSync());
    } catch (_) {
      return 'personas';
    }
  }

  String _readPersonaSubdirText(String source) {
    try {
      final parsed = _profileEntries(source);
      final entry = parsed.entries
          .where((e) => e.id == 'ondra-persona-loader')
          .firstOrNull;
      if (entry == null) return 'personas';
      final configAt = parsed.lines
          .sublist(entry.start, entry.end)
          .indexWhere((line) => RegExp(r'^\s*config:\s*$').hasMatch(line));
      if (configAt < 0) return 'personas';
      final configIndent =
          parsed.lines[entry.start + configAt].length -
          parsed.lines[entry.start + configAt].trimLeft().length;
      for (var i = entry.start + configAt + 1; i < entry.end; i++) {
        final line = parsed.lines[i];
        if (line.trim().isEmpty || line.trimLeft().startsWith('#')) continue;
        final indent = line.length - line.trimLeft().length;
        if (indent <= configIndent) break;
        final match = RegExp(
          r'''^\s*(?:user-subdir|userSubdir):\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$''',
        ).firstMatch(line);
        if (match == null) continue;
        final raw = match[1]!.trim();
        if (raw.isEmpty ||
            raw == '.' ||
            raw == '..' ||
            raw.contains('/') ||
            raw.contains(r'\') ||
            raw.contains('\x00')) {
          return 'personas';
        }
        return raw;
      }
    } catch (_) {
      // 配置不完整或无法解析时与 loader 一致，回退默认目录。
    }
    return 'personas';
  }

  ({
    List<String> lines,
    int indent,
    List<({String id, int start, int end})> entries,
  })
  _profileEntries(String source, {bool fragment = false}) {
    final lines = source.replaceAll('\r\n', '\n').split('\n');
    if (lines.any((l) => l.startsWith('\t'))) {
      throw const FormatException('不支持制表符缩进的人设配置');
    }
    if (!fragment &&
        lines
                .where((l) => RegExp(r'^-\s+insert:\s*(?:#.*)?$').hasMatch(l))
                .length !=
            1) {
      throw const FormatException('人设配置仅支持单个块式 insert 补丁，未修改装配层');
    }
    final starts = <({String id, int start, int indent})>[];
    for (var i = 0; i < lines.length; i++) {
      final m = RegExp(r'''^( *)-\s+id:\s*['"]?([\w@./-]+)['"]?\s*(?:#.*)?$''')
          .firstMatch(lines[i]);
      if (m != null) starts.add((id: m[2]!, start: i, indent: m[1]!.length));
    }
    final indent = fragment
        ? 0
        : (starts.isEmpty
              ? 4
              : starts.map((e) => e.indent).reduce((a, b) => a < b ? a : b));
    if (starts.any(
          (e) => e.indent != indent && e.id.startsWith('ondra-persona'),
        ) ||
        lines.any(
          (l) =>
              l.contains('# ondra-plugin-off:') && l.contains('ondra-persona'),
        )) {
      throw const FormatException('嵌套或停用的人设条目尚不支持安全迁移，未改写配置');
    }
    if (!fragment &&
        lines.any((l) => l.startsWith('- ') && !l.startsWith('- insert:'))) {
      throw const FormatException('含额外顶层补丁，无法安全合并人设配置');
    }
    final roots = starts.where((e) => e.indent == indent).toList();
    final entries = <({String id, int start, int end})>[];
    final ids = <String>{};
    for (final root in roots) {
      if (!ids.add(root.id)) throw FormatException('重复的人设/插件编号：${root.id}');
      var end = root.start + 1;
      while (end < lines.length) {
        final line = lines[end];
        if (line.trim().isNotEmpty &&
            !line.trimLeft().startsWith('#') &&
            line.length - line.trimLeft().length <= indent) {
          break;
        }
        end++;
      }
      entries.add((id: root.id, start: root.start, end: end));
    }
    if (fragment &&
        (entries.isEmpty ||
            entries.any((e) => !e.id.startsWith('ondra-persona')))) {
      throw const FormatException('导入配置必须只包含人设条目');
    }
    if (fragment) {
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim().isNotEmpty &&
            !lines[i].trimLeft().startsWith('#') &&
            !entries.any((e) => i >= e.start && i < e.end)) {
          throw const FormatException('人设配置含无法识别的顶层内容');
        }
      }
    }
    return (lines: lines, indent: indent, entries: entries);
  }

  String _mergePersonaConfig(String current, String incoming) {
    // 兼容旧导出的 trim()：第一行的缩进丢了，其余行还保留原缩进。
    var lines = incoming.trim().split('\n');
    if (lines.length > 1) {
      final field = lines
          .skip(1)
          .where((l) => RegExp(r'^ +name:').hasMatch(l))
          .firstOrNull;
      final legacyIndent = field == null
          ? 0
          : field.length - field.trimLeft().length - 2;
      if (legacyIndent > 0) {
        lines = [
          lines.first,
          ...lines
              .skip(1)
              .map(
                (l) =>
                    l.length >= legacyIndent ? l.substring(legacyIndent) : '',
              ),
        ];
      }
    }
    final imported = _profileEntries(lines.join('\n'), fragment: true);
    final local = _profileEntries(current);
    final replacements = <String, List<String>>{
      for (final entry in imported.entries)
        entry.id: imported.lines
            .sublist(entry.start, entry.end)
            .map((l) => l.isEmpty ? '' : '${' ' * local.indent}$l')
            .toList(),
    };
    final result = <String>[];
    var cursor = 0;
    for (final entry in local.entries) {
      result.addAll(local.lines.sublist(cursor, entry.start));
      result.addAll(
        replacements.remove(entry.id) ??
            local.lines.sublist(entry.start, entry.end),
      );
      cursor = entry.end;
    }
    result.addAll(local.lines.sublist(cursor));
    for (final block in replacements.values) {
      result.addAll(block);
    }
    return '${result.join('\n').trimRight()}\n';
  }

  Future<void> _copyTree(Directory from, Directory to) async {
    if (FileSystemEntity.isLinkSync(from.path)) {
      throw const FileSystemException('不接受符号链接人设');
    }
    await to.create(recursive: true);
    for (final e in from.listSync(recursive: true, followLinks: false)) {
      final rel = e.path.substring(from.path.length + 1);
      if (e is Directory) {
        await Directory('${to.path}/$rel').create(recursive: true);
      } else if (e is File) {
        final target = File('${to.path}/$rel');
        await target.parent.create(recursive: true);
        await e.copy(target.path);
      } else {
        throw FileSystemException('人设包含符号链接或特殊文件', e.path);
      }
    }
  }

  /// 把 UI 解压目录打包成内核认的 .skill.zip（archive 包，Dart 实现——
  /// alpha.10 审查第 25 项：原打包走外部 python3，Windows 上必失败）。
  Future<File?> _packSkillZip(Directory pack, String slug) async {
    try {
      final encoder = ZipEncoder();
      final archive = Archive();
      final files = pack
          .listSync(recursive: true, followLinks: false)
          .whereType<File>()
          .toList();
      for (final f in files) {
        final rel = f.path
            .substring(pack.path.length + 1)
            .replaceAll('\\', '/');
        archive.addFile(
          ArchiveFile(rel, f.lengthSync(), await f.readAsBytes()),
        );
      }
      final bytes = encoder.encode(archive);
      if (bytes.isEmpty) return null;
      final tmp = await Directory.systemTemp.createTemp('ondra-pack-');
      final out = File('${tmp.path}/$slug.skill.zip');
      await out.writeAsBytes(bytes, flush: true);
      return out;
    } catch (_) {
      return null;
    }
  }

  int _fileSize(String path) {
    final f = File(path);
    return f.existsSync() ? f.lengthSync() : 0;
  }

  String _stamp() {
    final t = _now();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}${two(t.month)}${two(t.day)}-'
        '${two(t.hour)}${two(t.minute)}${two(t.second)}';
  }

  String _stampHuman(DateTime t) {
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)} '
        '${two(t.hour)}:${two(t.minute)}';
  }
}

/// 页面与测试共用的那一个实例：默认读真实 `~/.ondra`。
final TransferEngine transferEngine = TransferEngine(
  dataIsOffline: () => dataMaintenance.offline,
);

/// 两条 32 位 FNV 变体并成 12 位十六进制。
///
/// 这里要回答的只是「这两句话是不是同一句」，不是「有没有被篡改」——
/// 与备份引擎里的指纹同一个算法，同一个理由：不引密码学哈希。
String _factId(String text) {
  var h1 = 0x811c9dc5;
  var h2 = 0x01000193;
  for (final byte in utf8.encode(text)) {
    h1 = (h1 ^ byte) * 0x01000193 & 0xFFFFFFFF;
    h2 = (h2 + byte) * 0x85ebca6b & 0xFFFFFFFF;
  }
  return 'm-${_hex8(h1)}${_hex8(h2).substring(0, 4)}';
}

String _hex8(int v) => v.toRadixString(16).padLeft(8, '0');

String _humanSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  final kb = bytes / 1024;
  if (kb < 1024) return '${kb.toStringAsFixed(1)} KB';
  final mb = kb / 1024;
  return '${mb.toStringAsFixed(1)} MB';
}

String _q(String v) => "'${v.replaceAll("'", "''")}'";

/// STRICT 表要求类型精确：REAL 列写 `50` 会被拒，必须写成 `50.0`。
String _real(double v) {
  if (!v.isFinite) throw const FormatException('记忆数值必须是有限数');
  return v.toString();
}

String _text(Object? v) => v is String ? v : (v?.toString() ?? '');

int _int(Object? v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? 0;
  return 0;
}

double _number(Object? v, double fallback) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v) ?? fallback;
  return fallback;
}

DateTime? _time(Object? v) {
  if (v is num) {
    if (v <= 0) return null;
    return DateTime.fromMillisecondsSinceEpoch(v.toInt());
  }
  if (v is String && v.isNotEmpty) {
    final n = int.tryParse(v);
    if (n != null && n > 0) return DateTime.fromMillisecondsSinceEpoch(n);
    return DateTime.tryParse(v);
  }
  return null;
}

String _clean(Object e) => '$e'.replaceFirst('ProcessException: ', '').trim();
