import 'dart:convert';
import 'dart:io';

import 'persona_model.dart';

/// 人设包的落盘层：把 `.skill` / `.zip` 装进 `~/.ondra/personas/<slug>/`，
/// 并从那里读回来。
///
/// ## 为什么放在 `~/.ondra` 而不是资产目录
///
/// 资产目录是**只读的**（打进包里），而且换一份包要重新构建应用。
/// 用户导入的包必须能随装随用、能删能换，所以落在用户数据目录。
/// 读取顺序：先用户目录，再资产目录——同 slug 时用户的那份赢，
/// 这样「导入一个同名包」的语义是替换，不是并存。
///
/// ## 为什么用系统 `ditto` 而不是引一个 zip 包
///
/// 桌面上 zip 解压有系统自带的 `ditto -x -k`，它对 macOS 的扩展属性、
/// UTF-8 文件名、权限位处理都是对的；引 `archive` 包要自己处理这些，
/// 还多一份依赖。代价是不支持 Windows——但这一层本身就是条件导出的
/// 桌面实现，Windows 端另有分支。
class PersonaStore {
  PersonaStore({String? home}) : home = home ?? _defaultHome();

  final String home;

  static String _defaultHome() =>
      '${Platform.environment['HOME'] ?? '.'}/.ondra';

  /// 用户装的包都放这儿，一个包一个目录。
  String get root => '$home/personas';

  /// 列出用户目录下的全部包 slug。
  List<String> installedSlugs() {
    final dir = Directory(root);
    if (!dir.existsSync()) return const [];
    final out = <String>[];
    for (final e in dir.listSync()) {
      if (e is! Directory) continue;
      final name = e.uri.pathSegments.where((s) => s.isNotEmpty).last;
      // 只认带 meta.json 的目录：半截解压出来的残目录不该出现在清单里。
      if (File('${e.path}/meta.json').existsSync()) out.add(name);
    }
    out.sort();
    return out;
  }

  /// 读一个已装的包。
  ///
  /// 返回 null 表示这个 slug 在用户目录里不存在或读不动——调用方据此回落到
  /// 资产目录里的同名包，而不是报一个空名字。
  OndraPersona? readInstalled(String slug) {
    final dir = '$root/$slug';
    final metaFile = File('$dir/meta.json');
    if (!metaFile.existsSync()) return null;
    try {
      final meta = jsonDecode(metaFile.readAsStringSync());
      if (meta is! Map<String, dynamic>) return null;
      var skill = '';
      final skillFile = File('$dir/SKILL.md');
      if (skillFile.existsSync()) skill = skillFile.readAsStringSync();
      return parsePersona(
        meta: meta,
        skillMarkdown: skill,
        assetDir: dir,
        builtIn: false,
      );
    } catch (_) {
      return null;
    }
  }

  /// 装一个包：解压 → 校验 → 落到 `~/.ondra/personas/<slug>/`。
  ///
  /// 校验顺序是有讲究的：
  /// 1. **先解到临时目录**，不直接往目标目录倒。半路失败时用户目录里
  ///    不会留下一个残缺的包；
  /// 2. 找 `meta.json`。允许它在根目录，也允许外面包一层同名目录
  ///    （很多打包工具会带一层，用户不会注意）；
  /// 3. `slug` 缺失就用目录名。它决定落盘地址，不能空；
  /// 4. 内置包不许被覆盖——那会让「重置为默认」失去参照物。
  ///
  /// 返回 [PersonaInstall]，带一条可以直接显示的中文结论。
  Future<PersonaInstall> install({
    required String archivePath,
    required Set<String> builtInSlugs,
  }) async {
    final src = File(archivePath);
    if (!await src.exists()) {
      return const PersonaInstall(ok: false, message: '这个文件不在了。');
    }
    // 后缀与文件头都在这里判：调用方（界面层）不认识文件系统，
    // 也就不需要为了读四个字节去 import dart:io。
    final lower = archivePath.toLowerCase();
    if (!lower.endsWith('.zip') &&
        !lower.endsWith('.skill') &&
        !lower.endsWith('.ondra')) {
      return const PersonaInstall(
        ok: false,
        message: '后缀应为 .zip / .skill / .ondra。',
      );
    }
    try {
      final raf = await src.open();
      try {
        final head = await raf.read(4);
        if (head.length < 4 || head[0] != 0x50 || head[1] != 0x4B) {
          return const PersonaInstall(
            ok: false,
            message: '这个文件不是 zip（缺少 PK 头），可能选错了文件。',
          );
        }
      } finally {
        await raf.close();
      }
    } catch (e) {
      return PersonaInstall(ok: false, message: '读不了这个文件：$e');
    }
    final staging = Directory(
      '${Directory.systemTemp.path}/ondra-persona-'
      '${DateTime.now().microsecondsSinceEpoch}',
    );
    try {
      await staging.create(recursive: true);
      final unzip = await Process.run('ditto', [
        '-x',
        '-k',
        archivePath,
        staging.path,
      ]);
      if (unzip.exitCode != 0) {
        return PersonaInstall(
          ok: false,
          message: '解压失败：${(unzip.stderr as String).trim()}',
        );
      }

      // 找 meta.json：根目录优先，其次只往下探一层。
      var metaFile = File('${staging.path}/meta.json');
      var packDir = staging.path;
      if (!await metaFile.exists()) {
        for (final e in await staging.list().toList()) {
          if (e is! Directory) continue;
          final candidate = File('${e.path}/meta.json');
          if (await candidate.exists()) {
            metaFile = candidate;
            packDir = e.path;
            break;
          }
        }
      }
      if (!await metaFile.exists()) {
        return const PersonaInstall(
          ok: false,
          message: '这个包里没有 meta.json，不是人设包。',
        );
      }

      final Object? meta;
      try {
        meta = jsonDecode(await metaFile.readAsString());
      } catch (_) {
        return const PersonaInstall(ok: false, message: 'meta.json 不是合法 JSON。');
      }
      if (meta is! Map) {
        return const PersonaInstall(ok: false, message: 'meta.json 顶层应为对象。');
      }

      final rawSlug = (meta['slug'] as String?)?.trim();
      final slug = (rawSlug == null || rawSlug.isEmpty)
          ? _basename(packDir)
          : rawSlug;
      if (!_isSafeSlug(slug)) {
        return PersonaInstall(
          ok: false,
          message: 'slug「$slug」不合法：只能用字母、数字、点、下划线与短横线。',
        );
      }
      if (builtInSlugs.contains(slug)) {
        return PersonaInstall(
          ok: false,
          message: '「$slug」是随应用分发的内置包，不能被覆盖。',
        );
      }

      final target = Directory('$root/$slug');
      // 同名包替换：先把旧的挪开，成功了再删。直接 delete 会在新包写到
      // 一半失败时把用户原来那份也弄丢。
      Directory? old;
      if (await target.exists()) {
        old = Directory('$root/.$slug.replaced');
        if (await old.exists()) await old.delete(recursive: true);
        await target.rename(old.path);
      }
      try {
        await Directory(root).create(recursive: true);
        await _copyTree(Directory(packDir), target);
      } catch (e) {
        // 落盘失败：把旧的放回去，别让用户既没装上新的、也丢了旧的。
        if (await target.exists()) await target.delete(recursive: true);
        if (old != null && await old.exists()) await old.rename(target.path);
        return PersonaInstall(ok: false, message: '落盘失败：$e');
      }
      if (old != null && await old.exists()) await old.delete(recursive: true);

      final name = (meta['name'] as String?)?.trim();
      return PersonaInstall(
        ok: true,
        slug: slug,
        message: '已装好「${(name == null || name.isEmpty) ? slug : name}」。',
      );
    } finally {
      // 临时目录无论如何都要清掉，包括上面 return 的各条失败路径。
      try {
        if (await staging.exists()) await staging.delete(recursive: true);
      } catch (_) {
        // 清不掉只是留了个临时目录，不影响本次结果。
      }
    }
  }

  /// 把一个已装的包导出成 zip。用户挑目标路径。
  ///
  /// 导出的是**目录内容**而不是外层目录：装回来时两条路径都认，但内容在根
  /// 更符合「一个包 = 一份 meta.json + SKILL.md + references/」的直觉。
  Future<PersonaInstall> export(
    String slug, {
    required String targetZip,
  }) async {
    final dir = Directory('$root/$slug');
    if (!await dir.exists()) {
      return const PersonaInstall(ok: false, message: '这个包不在用户目录里。');
    }
    try {
      // ditto 的 --keepParent 会把目录名带进压缩包；这里不要它，让内容落在根。
      final r = await Process.run('ditto', [
        '-c',
        '-k',
        '--norsrc',
        '--noextattr',
        dir.path,
        targetZip,
      ]);
      if (r.exitCode != 0) {
        return PersonaInstall(
          ok: false,
          message: '打包失败：${(r.stderr as String).trim()}',
        );
      }
      final bytes = await File(targetZip).length();
      return PersonaInstall(
        ok: true,
        slug: slug,
        message: '已导出（${(bytes / 1024).toStringAsFixed(0)} KB）：$targetZip',
      );
    } catch (e) {
      return PersonaInstall(ok: false, message: '打包失败：$e');
    }
  }

  /// 删一个用户装的包。内置包与不存在的包都会如实拒绝。
  Future<PersonaInstall> remove(String slug, {required bool builtIn}) async {
    if (builtIn) {
      return const PersonaInstall(ok: false, message: '内置包不能删除。');
    }
    final dir = Directory('$root/$slug');
    if (!await dir.exists()) {
      return const PersonaInstall(ok: false, message: '这个包不在用户目录里。');
    }
    try {
      await dir.delete(recursive: true);
      return PersonaInstall(ok: true, slug: slug, message: '已删除「$slug」。');
    } catch (e) {
      return PersonaInstall(ok: false, message: '删除失败：$e');
    }
  }

  /// 递归复制目录。不复制符号链接——人设包里不该有链接，
  /// 有的话跟着链接可能把别处的文件也带进来。
  Future<void> _copyTree(Directory from, Directory to) async {
    await to.create(recursive: true);
    await for (final entity in from.list(followLinks: false)) {
      final name = entity.uri.pathSegments.where((s) => s.isNotEmpty).last;
      final dest = '${to.path}/$name';
      if (entity is Directory) {
        await _copyTree(entity, Directory(dest));
      } else if (entity is File) {
        await entity.copy(dest);
      }
    }
  }

  /// slug 会变成目录名，必须挡住 `..` 与路径分隔符。
  static bool _isSafeSlug(String slug) =>
      slug.isNotEmpty &&
      !slug.contains('..') &&
      !slug.contains('/') &&
      !slug.contains('\\') &&
      RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(slug);

  static String _basename(String path) {
    final i = path.lastIndexOf('/');
    return i < 0 ? path : path.substring(i + 1);
  }
}

/// 装包 / 导出 / 删除的结果。带一句能直接显示的中文结论。
class PersonaInstall {
  const PersonaInstall({
    required this.ok,
    required this.message,
    this.slug,
  });

  final bool ok;
  final String message;
  final String? slug;
}

/// 供 Web 端使用：没有文件系统的实现，所有动作如实失败。
///
/// 与 `persona_store.dart` 的导出名一致，页面只 import 那一行。
abstract final class PersonaStoreStub {
  static bool get supported => false;
}
