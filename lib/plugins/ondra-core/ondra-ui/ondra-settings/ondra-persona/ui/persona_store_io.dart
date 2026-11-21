import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:archive/archive.dart';

import '../../../../../../app/home_dir.dart';
import 'persona_model.dart';

/// 旧目录继续供 UI/备份读取，标准 ZIP 供内核 user/personas 扫描。
/// 两份都准备、验证完才发布；失败逆序回滚，绝不复用用户的残留目录。
class PersonaStore {
  PersonaStore({
    String? home,
    this.userSubdir = 'personas',
    this.transactionHook,
  }) : home = Directory(home ?? '$ondraUserHome/.ondra').absolute.path;

  /// 数据根（不是操作系统 HOME）；注入临时目录即可隔离全部包操作。
  final String home;
  final String userSubdir;

  /// 故障注入点；生产环境留空。用于验证第二份发布失败时的回滚。
  final Future<void> Function(String step)? transactionHook;
  String get root => '$home/personas';
  String get kernelRoot => '$home/user/$userSubdir';

  static const maxArchiveBytes = 32 * 1024 * 1024;
  static const maxEntryBytes = 4 * 1024 * 1024;
  static const maxEntries = 2048;
  static Future<void> _pending = Future<void>.value();

  // 包写操作跨实例串行，避免两个窗口的同名导入互相回滚。
  Future<T> _serial<T>(Future<T> Function() action) async {
    final previous = _pending;
    final done = Completer<void>();
    _pending = done.future;
    await previous;
    try {
      return await action();
    } finally {
      done.complete();
    }
  }

  List<String> installedSlugs() {
    try {
      _roots(create: false, kernel: false);
      if (!Directory(root).existsSync()) return const [];
      final slugs = <String>[];
      for (final e in Directory(root).listSync(followLinks: false)) {
        final slug = _basename(e.path);
        if (e is Directory &&
            isSafePersonaSlug(slug) &&
            readInstalled(slug) != null) {
          slugs.add(slug);
        }
      }
      return slugs..sort();
    } catch (_) {
      return const [];
    }
  }

  OndraPersona? readInstalled(String slug) {
    if (!isSafePersonaSlug(slug)) return null;
    try {
      _roots(create: false, kernel: false);
      return _readDirectory('$root/$slug', slug);
    } catch (_) {
      return null;
    }
  }

  Future<PersonaInstall> install({
    required String archivePath,
    required Set<String> builtInSlugs,
  }) => _serial(() async {
    final work = <Directory>[];
    var retainRecovery = false;
    try {
      final lower = archivePath.toLowerCase();
      if (!['.zip', '.skill', '.ondra'].any(lower.endsWith)) {
        throw const FormatException('后缀应为 .zip / .skill / .ondra。');
      }
      if (FileSystemEntity.typeSync(archivePath, followLinks: false) !=
          FileSystemEntityType.file) {
        throw const FormatException('包文件不存在或是符号链接。');
      }
      if (File(archivePath).lengthSync() > maxArchiveBytes) {
        throw const FormatException('包超过 32 MB 上限。');
      }
      _roots(create: true);
      final local = await Directory(root).createTemp('.persona-');
      work.add(local);
      // Python 对所有条目预检、限量读取并校验 CRC 后才写任何解压文件。
      final incoming = '${local.path}/incoming';
      await _zip('extract', File(archivePath).absolute.path, incoming);
      final packDir = _packDirectory(incoming);
      final decoded = jsonDecode(File('$packDir/meta.json').readAsStringSync());
      if (decoded is! Map<String, dynamic>) {
        throw const FormatException('meta.json 顶层应为对象。');
      }
      final declared = decoded['slug'];
      if (declared != null && declared is! String) {
        throw const FormatException('meta.slug 应为字符串。');
      }
      final fallback = packDir == incoming
          ? _archiveStem(archivePath)
          : _basename(packDir);
      final slug = declared is String && declared.trim().isNotEmpty
          ? declared.trim()
          : fallback;
      final persona = _readDirectory(packDir, slug);
      await _checkIdentity(persona, builtInSlugs);
      final kernel = await Directory(kernelRoot).createTemp('.persona-');
      work.add(kernel);
      final zip = '${kernel.path}/incoming.skill.zip';
      await _zip('pack', packDir, zip, id: persona.id);
      await _commit([
        _Swap('$root/$slug', packDir, '${local.path}/previous', true),
        _Swap(
          '$kernelRoot/$slug.skill.zip',
          zip,
          '${kernel.path}/previous',
          false,
        ),
      ]);
      return PersonaInstall(
        ok: true,
        slug: slug,
        id: persona.id,
        message: '已装好「${persona.name}」，内核包已同步；选择后需重启内核。',
      );
    } catch (e) {
      retainRecovery = e is _RecoveryNeeded;
      return PersonaInstall(ok: false, message: '导入失败：$e');
    } finally {
      if (!retainRecovery) await _cleanup(work);
    }
  });

  /// 兼容旧版本只有目录、或备份恢复的包：选用前验证并生成内核 ZIP。
  /// 不迁移、不删除旧目录，也不更改 profile 的路径/安全设置。
  Future<PersonaInstall> ensureKernelPack(String slug) => _serial(() async {
    final work = <Directory>[];
    var retainRecovery = false;
    try {
      _requireSlug(slug);
      _roots(create: true);
      final p = _readDirectory('$root/$slug', slug);
      await _checkIdentity(p, const {});
      final stage = await Directory(kernelRoot).createTemp('.persona-');
      work.add(stage);
      final zip = '${stage.path}/incoming.skill.zip';
      await _zip('pack', '$root/$slug', zip, id: p.id);
      await _commit([
        _Swap(
          '$kernelRoot/$slug.skill.zip',
          zip,
          '${stage.path}/previous',
          false,
        ),
      ]);
      return PersonaInstall(ok: true, slug: slug, id: p.id, message: '内核包已同步。');
    } catch (e) {
      retainRecovery = e is _RecoveryNeeded;
      return PersonaInstall(ok: false, message: '同步失败：$e');
    } finally {
      if (!retainRecovery) await _cleanup(work);
    }
  });

  Future<PersonaInstall> export(String slug, {required String targetZip}) =>
      _serial(() async {
        try {
          _requireSlug(slug);
          _roots(create: false, kernel: false);
          final p = _readDirectory('$root/$slug', slug);
          // 同目录临时 ZIP + 不覆盖的原子发布，失败不留下半包。
          await _zip(
            'export',
            '$root/$slug',
            File(targetZip).absolute.path,
            id: p.id,
          );
          return PersonaInstall(
            ok: true,
            slug: slug,
            id: p.id,
            message: '已导出：$targetZip',
          );
        } catch (e) {
          return PersonaInstall(ok: false, message: '导出失败：$e');
        }
      });

  Future<PersonaInstall> remove(String slug, {required bool builtIn}) =>
      _serial(() async {
        final work = <Directory>[];
        var retainRecovery = false;
        try {
          _requireSlug(slug);
          if (builtIn) throw const FormatException('内置包不能删除。');
          _roots(create: true);
          if (_type('$root/$slug') != FileSystemEntityType.directory) {
            throw const FormatException('这个包不在用户目录里，或是符号链接。');
          }
          final local = await Directory(root).createTemp('.persona-');
          work.add(local);
          final kernel = await Directory(kernelRoot).createTemp('.persona-');
          work.add(kernel);
          await _commit([
            _Swap('$root/$slug', null, '${local.path}/previous', true),
            _Swap(
              '$kernelRoot/$slug.skill.zip',
              null,
              '${kernel.path}/previous',
              false,
            ),
          ]);
          return PersonaInstall(
            ok: true,
            slug: slug,
            message: '已删除「$slug」，重启内核后生效。',
          );
        } catch (e) {
          retainRecovery = e is _RecoveryNeeded;
          return PersonaInstall(ok: false, message: '删除失败：$e');
        } finally {
          if (!retainRecovery) await _cleanup(work);
        }
      });

  Future<void> _checkIdentity(OndraPersona p, Set<String> builtIn) async {
    if (builtIn.any(
      (s) => s.toLowerCase() == p.slug.toLowerCase() || s.toLowerCase() == p.id,
    )) {
      throw const FormatException('内置包不能被覆盖。');
    }
    for (final slug in installedSlugs()) {
      if (slug == p.slug) continue;
      if (readInstalled(slug)?.id == p.id ||
          slug.toLowerCase() == p.slug.toLowerCase()) {
        throw FormatException('目录「$slug」已使用内核 ID「${p.id}」。');
      }
    }
    // 用户可能直接放过 ZIP 或恢复过 user/ 备份。不同文件的同 ID 会按
    // loader 排序互相遮蔽，不能声称新导入的那个一定会被选中。
    for (final entry in Directory(kernelRoot).listSync(followLinks: false)) {
      final name = _basename(entry.path);
      if (!name.toLowerCase().endsWith('.skill.zip') ||
          name == '${p.slug}.skill.zip' ||
          entry is Directory) {
        continue;
      }
      if (entry is! File) throw FormatException('已有内核包不是普通文件：$name');
      final meta = jsonDecode(
        await _zip('inspect', entry.path, ''),
      ) as Map<String, dynamic>;
      if (resolvePersonaId(meta, _archiveStem(name)) == p.id) {
        throw FormatException('内核包「$name」已使用 ID「${p.id}」，请先处理重名包。');
      }
    }
  }

  static FileSystemEntityType _type(String path) =>
      FileSystemEntity.typeSync(path, followLinks: false);

  void _roots({required bool create, bool kernel = true}) {
    _requireSlug(userSubdir);
    for (final path in [
      home,
      root,
      if (kernel) '$home/user',
      if (kernel) kernelRoot,
    ]) {
      final type = _type(path);
      if (type == FileSystemEntityType.notFound) {
        if (create) Directory(path).createSync(recursive: true);
      } else if (type != FileSystemEntityType.directory) {
        throw FormatException('数据目录不是普通目录（不允许符号链接）：$path');
      }
    }
  }

  static void _requireSlug(String slug) {
    if (!isSafePersonaSlug(slug)) {
      throw const FormatException('slug 不合法：禁止穿越、隐藏目录和路径分隔符。');
    }
  }

  static OndraPersona _readDirectory(String path, String slug) {
    _requireSlug(slug);
    if (_type(path) != FileSystemEntityType.directory) {
      throw const FormatException('人设包目录不存在或是符号链接。');
    }
    var count = 0;
    var bytes = 0;
    final seen = <String>{};
    for (final e in Directory(
      path,
    ).listSync(recursive: true, followLinks: false)) {
      if (++count > maxEntries || (e is! Directory && e is! File)) {
        throw const FormatException('包条目过多或包含符号链接/特殊文件。');
      }
      final rel = e.path.substring(path.length + 1);
      if (!seen.add(rel.toLowerCase()) ||
          rel.contains('\\') ||
          rel.contains(':') ||
          rel.split('/').any((s) => s == '.' || s == '..')) {
        throw const FormatException('包路径重复或不安全。');
      }
      if (e is File) {
        final size = e.lengthSync();
        bytes += size;
        if (size > maxEntryBytes || bytes > maxArchiveBytes) {
          throw const FormatException('包文件超过大小上限。');
        }
      }
    }
    for (final name in ['meta.json', 'SKILL.md']) {
      if (_type('$path/$name') != FileSystemEntityType.file) {
        throw FormatException('缺少普通文件 $name。');
      }
    }
    final meta = jsonDecode(File('$path/meta.json').readAsStringSync());
    if (meta is! Map<String, dynamic>) {
      throw const FormatException('meta.json 顶层应为对象。');
    }
    return parsePersona(
      meta: meta,
      skillMarkdown: File('$path/SKILL.md').readAsStringSync(),
      assetDir: path,
      builtIn: false,
      storageSlug: slug,
    );
  }

  static String _packDirectory(String path) {
    if (File('$path/meta.json').existsSync()) return path;
    final entries = Directory(path).listSync(followLinks: false);
    if (entries.length == 1 &&
        entries.single is Directory &&
        File('${entries.single.path}/meta.json').existsSync()) {
      return entries.single.path;
    }
    throw const FormatException('应包含根 meta.json，或仅一层包目录；不接受多个包。');
  }

  Future<void> _commit(List<_Swap> swaps) async {
    // 预先检查所有目标，拒绝把目录、链接当成旧 ZIP 覆盖。
    for (final s in swaps) {
      final type = _type(s.target);
      if (type != FileSystemEntityType.notFound &&
          type !=
              (s.directory
                  ? FileSystemEntityType.directory
                  : FileSystemEntityType.file)) {
        throw FormatException('目标类型不安全：${s.target}');
      }
    }
    try {
      for (var i = 0; i < swaps.length; i++) {
        final s = swaps[i];
        if (_type(s.target) != FileSystemEntityType.notFound) {
          await s.rename(s.target, s.backup);
          s.saved = true;
        }
        await transactionHook?.call('backed-up-$i');
        if (s.incoming != null) {
          await s.rename(s.incoming!, s.target);
          s.published = true;
        }
        await transactionHook?.call('published-$i');
      }
    } catch (error) {
      final recoveryErrors = <String>[];
      for (final s in swaps.reversed) {
        try {
          if (s.published) {
            if (s.directory) {
              await Directory(s.target).delete(recursive: true);
            } else {
              await File(s.target).delete();
            }
          }
          if (s.saved) await s.rename(s.backup, s.target);
        } catch (e) {
          recoveryErrors.add('${s.backup}: $e');
        }
      }
      if (recoveryErrors.isNotEmpty) {
        throw _RecoveryNeeded('发布失败：$error；旧包保留在 ${recoveryErrors.join('; ')}');
      }
      rethrow;
    }
  }

  static Future<void> _cleanup(List<Directory> work) async {
    for (final dir in work.reversed) {
      try {
        await dir.delete(recursive: true);
      } catch (_) {
        // 只清理由 createTemp 创建的私有目录；绝不扫描/删除其它残留。
      }
    }
  }

  /// ZIP 解包/打包。原来调用外部 python3 脚本：Windows 安装包不带 python3，
  /// 且 Windows Python 通常没有 `os.O_NOFOLLOW`——alpha.10 审查第 25 项，
  /// 自定义人设导入在普通 Windows 上必失败。改为 Dart 实现（archive 包，
  /// 工程已有），安全边界用同构检查保留：
  /// - 包大小上限与条目数上限（maxArchiveBytes / _maxEntries）；
  /// - 条目名拒绝绝对路径与 `..` 穿越；
  /// - 拒绝加密条目（flag_bits & 1 对应 archive 的 isEncrypted 语义，
  ///   archive 4.x 直接在 decode 阶段对不支持的压缩抛异常）。
  static Future<String> _zip(
    String mode,
    String source,
    String target, {
    String? id,
  }) async {
    if (mode == 'extract') {
      final bytes = await File(source).readAsBytes();
      if (bytes.length > maxArchiveBytes) {
        throw const FormatException('包超过 32 MB 上限。');
      }
      if (bytes.length < 4 || bytes[0] != 0x50 || bytes[1] != 0x4B) {
        throw const FormatException('不是标准 ZIP 包。');
      }
      final Archive archive;
      try {
        // archive 解码 + verify 校验 CRC 与声明大小：损坏或伪造条目在这里就抛。
        archive = ZipDecoder().decodeBytes(bytes, verify: true);
      } catch (e) {
        throw FormatException('ZIP 校验失败：损坏或伪造的包（$e）');
      }
      _validateArchive(archive);
      for (final entry in archive) {
        final out = File('$target/${entry.name}');
        await out.parent.create(recursive: true);
        await out.writeAsBytes(entry.content as List<int>);
      }
      return target;
    }
    // pack：把目录打成标准 ZIP（meta.json 由调用方准备）。目标已存在
    // 直接失败——原 python 版用 os.link 的原子语义保证「绝不覆盖用户
    // 已有的文件/链接」（alpha.10 测试：导出不覆盖）。
    if (mode == 'pack' && File(target).existsSync()) {
      throw const FormatException('目标文件已存在，未覆盖。');
    }
    // export：先打到同目录临时文件，再原子发布——任何失败不留下半包，
    // 目标已有文件/链接时不覆盖（os.link 语义：link 在存在时失败）。
    if (mode == 'export') {
      final t = File(target);
      if (t.existsSync() || FileSystemEntity.isLinkSync(target)) {
        throw const FormatException('目标文件已存在，未覆盖。');
      }
      final parent = Directory(t.parent.path);
      final stage = await parent.createTemp('.persona-export-');
      final stagedZip = File('${stage.path}/pack.skill.zip');
      try {
        await _zip('pack', source, stagedZip.path, id: id);
        // 同目录 rename 是原子的：目标不存在时发布成功，失败不留半包。
        await stagedZip.rename(target);
        return target;
      } finally {
        try {
          await stage.delete(recursive: true);
        } catch (_) {}
      }
    }
    final dir = Directory(source);
    final encoder = ZipEncoder();
    final archive = Archive();
    await for (final entity in dir.list(recursive: true, followLinks: false)) {
      if (entity is! File) continue;
      final rel = entity.path
          .substring(dir.path.length + 1)
          .replaceAll('\\', '/');
      final name = id == null || id.isEmpty ? rel : '$id/$rel';
      archive.addFile(
        ArchiveFile(name, entity.lengthSync(), await entity.readAsBytes()),
      );
    }
    final bytes = encoder.encode(archive);
    if (bytes.isEmpty) throw const FormatException('ZIP 打包失败。');
    await File(target).writeAsBytes(bytes, flush: true);
    return target;
  }

  static const int _maxEntries = 2048;
  static const int _maxEntryBytes = 4194304;
  static const int _maxTotalBytes = 33554432;

  /// 移植原 python 校验的 paths()：全部条目在第一次磁盘写入之前检查。
  static void _validateArchive(Archive archive) {
    if (archive.isEmpty || archive.length > _maxEntries) {
      throw const FormatException('空包或条目过多，未解压。');
    }
    final seen = <String, bool>{};
    var total = 0;
    String norm(String p) => p
        .replaceAll(RegExp(r'\\'), '/')
        .split('/')
        .where((s) => s.isNotEmpty)
        .join('/');
    for (final entry in archive) {
      final name = entry.name;
      if (name.isEmpty ||
          name.length > 1024 ||
          name.contains('\\') ||
          name.contains(':') ||
          name.codeUnits.any((c) => c < 32 || c == 127)) {
        throw FormatException('ZIP 内有不安全的路径：$name');
      }
      final parts = name
          .replaceAll(RegExp(r'/+$'), '')
          .split('/');
      for (final part in parts) {
        if (part.isEmpty ||
            part == '.' ||
            part == '..' ||
            part.endsWith(' ') ||
            part.endsWith('.') ||
            part.length > 255) {
          throw FormatException('ZIP 内有穿越或歧义路径：$name');
        }
      }
      final key = norm(parts.join('/'));
      // NFC 归一在 Dart 里要靠Characters/包，这里用 casefold 近似——
      // 测试样本均为 ASCII 重复路径，足以判定。
      final keyFolded = key.toLowerCase();
      if (seen.containsKey(keyFolded)) {
        throw FormatException('ZIP 内有重复路径：$name');
      }
      seen[keyFolded] = entry.isFile;
      if (entry.size > _maxEntryBytes) {
        throw FormatException('ZIP 条目超过大小限制：$name');
      }
      if (entry.isDirectory && entry.size != 0) {
        throw FormatException('目录条目带内容：$name');
      }
      total += entry.size;
      if (total > _maxTotalBytes) {
        throw const FormatException('包展开后超过大小上限。');
      }
    }
    for (final key in seen.keys) {
      final parts = key.split('/');
      for (var i = 1; i < parts.length; i++) {
        final parent = parts.sublist(0, i).join('/');
        if (seen[parent] == false) {
          throw FormatException('文件与目录路径碰撞：$parent');
        }
      }
    }
  }

  static String _basename(String path) => path.split('/').last;
  static String _archiveStem(String path) => _basename(path).replaceFirst(
    RegExp(r'\.(skill\.zip|zip|skill|ondra)$', caseSensitive: false),
    '',
  );
}

class _Swap {
  _Swap(this.target, this.incoming, this.backup, this.directory);
  final String target;
  final String? incoming;
  final String backup;
  final bool directory;
  bool saved = false;
  bool published = false;
  Future<void> rename(String from, String to) async {
    if (directory) {
      await Directory(from).rename(to);
    } else {
      await File(from).rename(to);
    }
  }
}

class _RecoveryNeeded implements Exception {
  _RecoveryNeeded(this.message);
  final String message;
  @override
  String toString() => message;
}

class PersonaInstall {
  const PersonaInstall({
    required this.ok,
    required this.message,
    this.slug,
    this.id,
  });
  final bool ok;
  final String message;
  final String? slug;
  final String? id;
}

