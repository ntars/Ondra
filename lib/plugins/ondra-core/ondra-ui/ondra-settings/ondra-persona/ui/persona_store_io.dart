import 'dart:async';
import 'dart:convert';
import 'dart:io';

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

  static Future<String> _zip(
    String mode,
    String source,
    String target, {
    String? id,
  }) async {
    Process process;
    try {
      process = await Process.start('python3', [
        '-I',
        '-c',
        _zipTool,
        mode,
        source,
        target,
        id ?? '',
      ]);
    } on ProcessException {
      throw const FormatException('需要系统 Python 3 校验 ZIP；未找到工具，未解压。');
    }
    final stdout = process.stdout.transform(utf8.decoder).join();
    final stderr = process.stderr.transform(utf8.decoder).join();
    final timer = Timer(
      const Duration(seconds: 30),
      () => process.kill(ProcessSignal.sigkill),
    );
    try {
      final code = await process.exitCode;
      final output = await stdout;
      final error = (await stderr).trim();
      if (code != 0) {
        throw FormatException(
          'ZIP 校验/打包失败：${error.isEmpty ? '工具超时或异常退出' : error}',
        );
      }
      return output;
    } finally {
      timer.cancel();
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

// 标准库 zipfile 负责格式/CRC，不调用 extractall/ditto。全部路径、类型、
// 声明大小及实际内容在第一次磁盘写入之前检查；系统工具不可用时 fail closed。
const _zipTool = r'''
import io, json, os, re, stat, struct, sys, tempfile, unicodedata, zipfile, zlib
MAX_ARCHIVE, MAX_ENTRY, MAX_TOTAL, MAX_COUNT = 33554432, 4194304, 33554432, 2048

def fail(message):
    raise ValueError(message)

def paths(entries):
    seen, total = {}, 0
    if not entries or len(entries) > MAX_COUNT:
        fail('empty archive or too many entries')
    for name, directory, size in entries:
        if not name or len(name) > 1024 or '\\' in name or ':' in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
            fail('unsafe archive path')
        parts = name.rstrip('/').split('/')
        if any(p in ('', '.', '..') or p.endswith((' ', '.')) or len(p) > 255 for p in parts):
            fail('absolute/traversal/ambiguous archive path: ' + name)
        key = unicodedata.normalize('NFC', '/'.join(parts)).casefold()
        if key in seen:
            fail('duplicate archive path: ' + name)
        seen[key] = directory
        if size < 0 or size > MAX_ENTRY or (directory and size != 0):
            fail('entry exceeds size limit')
        total += size
        if total > MAX_TOTAL:
            fail('archive exceeds expanded size limit')
    for key in seen:
        parts = key.split('/')
        for i in range(1, len(parts)):
            parent = '/'.join(parts[:i])
            if parent in seen and not seen[parent]:
                fail('file/directory path collision')

def unique_object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            fail('duplicate JSON key')
        out[key] = value
    return out

def metadata(data):
    files = {name: content for name, directory, content in data if not directory}
    if 'meta.json' not in files:
        tops = {name.rstrip('/').split('/')[0] for name, _, _ in data}
        if len(tops) != 1:
            fail('expected one persona package')
        prefix = next(iter(tops)) + '/'
        files = {name[len(prefix):]: content for name, content in files.items() if name.startswith(prefix)}
    meta = json.loads(files.get('meta.json', b'').decode('utf-8'), object_pairs_hook=unique_object,
                      parse_constant=lambda value: fail('non-finite JSON value'))
    if not isinstance(meta, dict) or not meta:
        fail('meta.json must be a nonempty object')
    if not files.get('SKILL.md', b'').decode('utf-8').strip():
        fail('SKILL.md is missing or empty')
    return meta

def stable_identity(data, identity):
    if not re.fullmatch(r'[a-z][a-z0-9_-]{1,63}', identity):
        fail('invalid kernel identity')
    meta = metadata(data)
    # Pin filename-derived IDs in generated ZIPs only. Renaming an export must
    # not turn it into a different persona; the legacy directory is untouched.
    if not any(isinstance(meta.get(key), str) and re.fullmatch(r'[a-z][a-z0-9_-]{1,63}', meta[key].strip().lower()) for key in ('slug', 'name')):
        meta['slug'] = identity
        encoded = json.dumps(meta, ensure_ascii=False, indent=2).encode('utf-8')
        return [(name, is_dir, encoded if name == 'meta.json' else content) for name, is_dir, content in data]
    return data

def archive(source):
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_ARCHIVE:
            fail('archive is not a regular bounded file')
        raw = stream.read(MAX_ARCHIVE + 1)
    if len(raw) > MAX_ARCHIVE:
        fail('archive exceeds size limit')
    if raw[:4] != b'PK\x03\x04':
        fail('not a standard ZIP')
    with zipfile.ZipFile(io.BytesIO(raw), 'r', allowZip64=False) as z:
        infos = z.infolist()
        paths([(i.orig_filename, i.is_dir(), i.file_size) for i in infos])
        for i in infos:
            kind = stat.S_IFMT(i.external_attr >> 16)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or (kind == stat.S_IFDIR and not i.is_dir()) or (kind == stat.S_IFREG and i.is_dir()):
                fail('symlink or special archive entry')
            if '\x00' in i.orig_filename or i.flag_bits & 1 or i.compress_type not in (0, 8) or i.extract_version > 20:
                fail('encrypted/unsupported/ZIP64 archive entry')
            offset = 0
            while offset < len(i.extra):
                if offset + 4 > len(i.extra):
                    fail('damaged ZIP extra field')
                tag, length = struct.unpack_from('<HH', i.extra, offset)
                offset += 4 + length
                if tag == 1 or offset > len(i.extra):
                    fail('ZIP64 or damaged ZIP extra field')
            if i.file_size > 1048576 and i.file_size > max(1, i.compress_size) * 1000:
                fail('abnormal compression ratio')
        data = []
        # read all entries (including otherwise-unused references) to verify CRC/local headers.
        for i in infos:
            with z.open(i) as entry:
                content = entry.read(MAX_ENTRY + 1)
                if len(content) != i.file_size or len(content) > MAX_ENTRY or entry.read(1):
                    fail('damaged entry size')
            # ZipExtFile stops at the declared size. Check the actual bounded
            # deflate stream too, so a forged short size/CRC cannot hide a tail.
            name_size, extra_size = struct.unpack_from('<HH', raw, i.header_offset + 26)
            start = i.header_offset + 30 + name_size + extra_size
            compressed = raw[start:start + i.compress_size]
            if len(compressed) != i.compress_size:
                fail('truncated compressed entry')
            if i.compress_type == zipfile.ZIP_DEFLATED:
                decoder = zlib.decompressobj(-15)
                actual = decoder.decompress(compressed, MAX_ENTRY + 1)
                if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail or actual != content:
                    fail('damaged or oversized deflate stream')
            elif compressed != content:
                fail('damaged stored entry size')
            data.append((i.filename, i.is_dir(), content))
        metadata(data)
        return data

def directory(source):
    if not stat.S_ISDIR(os.lstat(source).st_mode):
        fail('source must be a real directory')
    entries = []
    for root, dirs, files in os.walk(source, followlinks=False):
        for name in sorted(dirs + files):
            full = os.path.join(root, name)
            info = os.lstat(full)
            is_dir = stat.S_ISDIR(info.st_mode)
            if not is_dir and not stat.S_ISREG(info.st_mode):
                fail('symlink or special file in package')
            relative = os.path.relpath(full, source).replace(os.sep, '/')
            entries.append((relative + ('/' if is_dir else ''), is_dir, 0 if is_dir else info.st_size))
            if len(entries) > MAX_COUNT:
                fail('too many files')
    paths(entries)
    data = []
    for name, is_dir, size in entries:
        content = b''
        if not is_dir:
            fd = os.open(os.path.join(source, name), os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as stream:
                content = stream.read(MAX_ENTRY + 1)
            if len(content) != size or len(content) > MAX_ENTRY:
                fail('source changed or exceeds size limit')
        data.append((name, is_dir, content))
    metadata(data)
    return data

def pack(data, target):
    with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED, allowZip64=False) as z:
        for name, is_dir, content in data:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = ((stat.S_IFDIR | 0o700) if is_dir else (stat.S_IFREG | 0o600)) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, content)
    archive(target)

try:
    mode, source, target, identity = sys.argv[1:]
    if mode == 'extract':
        data = archive(source)
        os.mkdir(target, 0o700)
        for name, is_dir, content in data:
            dest = os.path.join(target, name)
            if is_dir:
                os.makedirs(dest, mode=0o700, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(dest), mode=0o700, exist_ok=True)
                with open(dest, 'xb') as stream:
                    stream.write(content)
    elif mode == 'inspect':
        print(json.dumps(metadata(archive(source))))
    elif mode == 'pack':
        pack(stable_identity(directory(source), identity), target)
    elif mode == 'export':
        data = stable_identity(directory(source), identity)
        with tempfile.TemporaryDirectory(prefix='.persona-export-', dir=os.path.dirname(target)) as stage:
            zip_path = os.path.join(stage, 'pack.skill.zip')
            pack(data, zip_path)
            os.link(zip_path, target)  # atomic, fails if any user file/link already exists
    else:
        fail('unknown operation')
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
''';
