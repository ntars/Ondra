import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import 'bundled_runtime.dart';
import 'home_dir.dart';
import 'version.dart';

/// 铺开结果。调用方拿它决定要不要在日志里留一行，以及要不要提示用户。
enum RuntimeSeedOutcome {
  /// 包里没有随包运行时（开发机没跑装配脚本，或用的是系统安装的内核）。
  noBundledRuntime,

  /// 用户的 `profiles/<name>` 已经存在，没动它。
  alreadyPresent,

  /// 刚从包里铺开。
  seeded,

  /// 复制失败（权限、磁盘满、包损坏）。应用照常启动，内核连接会报出真实原因。
  failed,
}

class RuntimeSeedResult {
  const RuntimeSeedResult(this.outcome, {this.targetPath, this.error});

  final RuntimeSeedOutcome outcome;
  final String? targetPath;
  final String? error;

  @override
  String toString() =>
      'RuntimeSeedResult(${outcome.name}${error == null ? '' : ': $error'})';
}

/// 内核读取 profile 时用的名字。与 `stdio_transport_io.dart` 的
/// `--profile` 参数、`tool/assemble_runtime.mjs` 的 `ONDRA_PROFILE_NAME` 三处一致。
const String ondraRuntimeProfileName = 'ondra';

/// 把随包的 profile 种子铺到 `$DSH_HOME/profiles/ondra`。
///
/// 幂等：已经有就按摘要补缺、升级仍归应用所有的文件。**同步**执行——
/// 现在它排在首帧之后，但必须在内核连接前铺好，否则会连到一个空 profile。
///
/// [dshHome] 只为测试存在：`Platform.environment` 在进程内不可改，不开口子
/// 就没法验证「铺到哪里」。生产调用一律不传，走 `ONDRA_DSH_HOME` / `~/.ondra/dsh`。
RuntimeSeedResult seedRuntimeProfile({String? dshHome}) {
  final runtime = ondraBundledRuntime;
  if (runtime == null) {
    return const RuntimeSeedResult(RuntimeSeedOutcome.noBundledRuntime);
  }
  if (!runtime.hasProfile) {
    return const RuntimeSeedResult(RuntimeSeedOutcome.noBundledRuntime);
  }

  final home =
      dshHome ??
      Platform.environment['ONDRA_DSH_HOME'] ??
      '$ondraUserHome/.ondra/dsh';
  final sep = Platform.pathSeparator;
  final target = '$home${sep}profiles$sep$ondraRuntimeProfileName';

  if (Directory(target).existsSync()) {
    // 已有安装：不覆盖已有内容（用户的插件可能是自己更新过的版本，
    // 用包里的旧快照盖回去等于把他们的更新吞掉）。
    //
    // 但「目录存在」不证明「铺设完成」——alpha.10 审查第 30 项：首次
    // 铺设中断留下的半套目录，永远停在半套。这里只做**补缺**：
    // 源快照里有、目标里没有的文件补上；两边都有、且用户没改过的旧随包
    // 文件，按逐文件摘要判断后再升级。
    final changed = <String>{};
    final manifestMissing = !File(_ownedManifestPath(target)).existsSync();
    try {
      changed.addAll(
        _fillMissing(Directory(runtime.profileDir), Directory(target)),
      );
      changed.addAll(
        _upgradeOwnedFiles(Directory(runtime.profileDir), Directory(target)),
      );
    } on FileSystemException {
      // 单个文件失败不覆盖已有内容；已经完成的补缺/升级仍按 seeded 返回，
      // 下次启动会再次尝试剩下的文件。
    }
    if (changed.isNotEmpty || manifestMissing) {
      try {
        if (manifestMissing) {
          _seedOwnedSnapshot(
            target,
            runtime.profileDir,
            Directory(runtime.profileDir),
            changed,
          );
        } else {
          _updateOwnedSnapshot(target, runtime.profileDir, changed);
        }
      } on FileSystemException {
        // 摘要清单写不进去只影响下一次升级判断，不影响本次已铺开的文件。
      }
      return RuntimeSeedResult(RuntimeSeedOutcome.seeded, targetPath: target);
    }
    return RuntimeSeedResult(
      RuntimeSeedOutcome.alreadyPresent,
      targetPath: target,
    );
  }

  try {
    _copyTree(Directory(runtime.profileDir), Directory(target));
    try {
      _writeOwnedSnapshot(Directory(target), runtime.profileDir);
    } on FileSystemException {
      // 文件已经完整铺开；摘要清单失败不应把成功启动报成 failed。
    }
    return RuntimeSeedResult(RuntimeSeedOutcome.seeded, targetPath: target);
  } on FileSystemException catch (e) {
    return RuntimeSeedResult(
      RuntimeSeedOutcome.failed,
      targetPath: target,
      error: '${e.message}（${e.path ?? target}）',
    );
  }
}

const String _ownedManifestName = '.ondra-seed.json';

/// 老安装（alpha.10 之前）没有归属清单。这里只认这几份必然由应用铺开的
/// 插件代码：人设/轮次控制的旧版本曾导致「升级后没有人设」，而它们不是用户配置。
/// 因为拿不到全部旧版本摘要，迁移时按路径直接刷新这几份；别的相对路径
/// 一律当作用户所有，绝不因为一次升级被覆盖。
const Set<String> _legacyUpgradeAllowlist = {
  'node_modules/@ondra/cordis-plugin-ondra-persona-loader/lib/settings.js',
  'node_modules/@ondra/cordis-plugin-ondra-persona-core/lib/service.js',
  'node_modules/@ondra/cordis-plugin-ondra-persona-core/lib/index.js',
  'node_modules/@ondra/cordis-plugin-ondra-persona-loader/lib/index.js',
  'node_modules/@ondra/cordis-plugin-ondra-turn-control/lib/index.js',
};

String _ownedManifestPath(String profileTarget) =>
    '$profileTarget${Platform.pathSeparator}$_ownedManifestName';

String _normalize(String path) =>
    path.replaceAll('\\', '/').replaceAll(RegExp(r'/+'), '/');

String _sha256OfFile(File file) =>
    sha256.convert(file.readAsBytesSync()).toString();

String? _snapshotPackageCount(String profileDir) {
  try {
    final manifest = jsonDecode(
      File('$profileDir/package.json').readAsStringSync(),
    );
    if (manifest is Map) {
      final snapshot = manifest['x-ondra-snapshot'];
      if (snapshot is Map) return snapshot['packages']?.toString();
    }
  } catch (_) {}
  return null;
}

/// 只替换仍与上次随包种子逐字节一致、且新快照确实不同的文件。
///
/// 清单缺失时只刷新 [_legacyUpgradeAllowlist] 里的随包代码（按路径视为应用
/// 所有）；其余文件一律保留，绝不猜测归属。
List<String> _upgradeOwnedFiles(Directory source, Directory target) {
  final manifest = File(_ownedManifestPath(target.path));
  Map<String, Object?> parsed;
  if (manifest.existsSync()) {
    try {
      parsed = jsonDecode(manifest.readAsStringSync()) as Map<String, Object?>;
    } catch (_) {
      return const [];
    }
  } else {
    parsed = {'files': _legacyOwnedHashes(source, target)};
  }
  final rawFiles = parsed['files'];
  if (rawFiles is! Map) return const [];
  final replaced = <String>[];
  void walk(Directory dir) {
    for (final entity in dir.listSync(followLinks: false)) {
      final rel = _normalize(entity.path.substring(source.path.length + 1));
      if (entity is Directory) {
        walk(entity);
        continue;
      }
      if (entity is! File) continue;
      final destination = File(
        '${target.path}${Platform.pathSeparator}${rel.replaceAll('/', Platform.pathSeparator)}',
      );
      if (!destination.existsSync()) continue;
      final ownedHash = rawFiles[rel];
      if (ownedHash is! String) continue;
      if (_sha256OfFile(destination) != ownedHash) {
        // 用户改过或自己升级过：保留本地版本。
        continue;
      }
      if (_sha256OfFile(entity) == ownedHash) continue;
      _copyFileContents(entity, destination);
      replaced.add(rel);
    }
  }

  walk(source);
  return replaced;
}

/// 无清单老安装的最小归属表：用目标文件的当前摘要当作「上次随包摘要」，
/// 好让白名单里的旧版本在本次被刷新（没有完整旧快照摘要可用）。
Map<String, String> _legacyOwnedHashes(Directory source, Directory target) {
  final files = <String, String>{};
  for (final rel in _legacyUpgradeAllowlist) {
    final bundled = File(
      '${source.path}${Platform.pathSeparator}${rel.replaceAll('/', Platform.pathSeparator)}',
    );
    final installed = File(
      '${target.path}${Platform.pathSeparator}${rel.replaceAll('/', Platform.pathSeparator)}',
    );
    if (!bundled.existsSync() || !installed.existsSync()) continue;
    files[rel] = _sha256OfFile(installed);
  }
  return files;
}

/// 老安装迁移时写一份保守归属表。
///
/// 只认白名单与本次确实写入的文件；摘要不同的其他文件归用户，下一轮也不会被覆盖。
void _seedOwnedSnapshot(
  String target,
  String source,
  Directory sourceDir,
  Iterable<String> changed,
) {
  final files = _legacyOwnedHashes(sourceDir, Directory(target));
  for (final rel in changed) {
    final file = File(
      '$target${Platform.pathSeparator}'
      '${rel.replaceAll('/', Platform.pathSeparator)}',
    );
    if (file.existsSync()) files[rel] = _sha256OfFile(file);
  }
  _writeOwnedManifest(target, source, files);
}

/// 记录随包快照的归属与文件摘要。
///
/// 只替换「上次确实由本应用铺开、且此后没有被用户改过」的文件。用户自己
/// 升级或手改的插件文件摘要不同，继续保留；半套安装缺的文件由补缺先补上。
void _writeOwnedSnapshot(Directory target, String source) {
  final files = <String, String>{};
  void walk(Directory dir) {
    for (final entity in dir.listSync(followLinks: false)) {
      final rel = _normalize(entity.path.substring(target.path.length + 1));
      if (rel == _ownedManifestName) continue;
      if (entity is Directory) {
        walk(entity);
      } else if (entity is File) {
        files[rel] = _sha256OfFile(entity);
      }
    }
  }

  walk(target);
  _writeOwnedManifest(target.path, source, files);
}

/// 只更新本次确实由随包快照写下的文件摘要。
///
/// 用户改过的文件不能因为一次别的文件升级就被重新记成“随包所有”，否则
/// 下一次升级会把用户版本盖掉。
void _updateOwnedSnapshot(
  String target,
  String source,
  Iterable<String> changed,
) {
  final files = <String, String>{};
  final manifest = File(_ownedManifestPath(target));
  if (manifest.existsSync()) {
    try {
      final parsed = jsonDecode(manifest.readAsStringSync());
      if (parsed is Map && parsed['files'] is Map) {
        for (final entry in (parsed['files'] as Map).entries) {
          if (entry.key is String && entry.value is String) {
            files[entry.key as String] = entry.value as String;
          }
        }
      }
    } catch (_) {
      // 旧清单损坏时从空清单重建，只记录本次确认写入的文件。
    }
  }
  for (final rel in changed) {
    final file = File(
      '$target${Platform.pathSeparator}'
      '${rel.replaceAll('/', Platform.pathSeparator)}',
    );
    if (file.existsSync()) files[rel] = _sha256OfFile(file);
  }
  _writeOwnedManifest(target, source, files);
}

void _writeOwnedManifest(
  String target,
  String source,
  Map<String, String> files,
) {
  File(_ownedManifestPath(target)).writeAsStringSync(
    '${const JsonEncoder.withIndent('  ').convert({'seededBy': 'Ondra', 'appVersion': '$ondraVersion+$ondraBuild', 'source': _normalize(source), 'snapshot': _snapshotPackageCount(source), 'files': files})}\n',
    flush: true,
  );
}

/// 递归复制，保留符号链接。
///
/// 不跟随链接的理由：pnpm 装的 profile 里 `node_modules/@ondra/*` 可能是指向
/// 别处的链接。跟随会把目标内容整棵复制进来（体积翻倍且失去升级语义），
/// 不复制又会丢包。原样搬过去才对。
/// 只补目标里缺失的文件；两边都有的不覆盖。返回补上的相对路径。
List<String> _fillMissing(Directory from, Directory to, {String? root}) {
  root ??= from.path;
  final filled = <String>[];
  for (final entity in from.listSync(followLinks: false)) {
    final name = entity.path.split(Platform.pathSeparator).last;
    final destination = '${to.path}${Platform.pathSeparator}$name';
    if (entity is Directory) {
      final child = Directory(destination);
      if (!child.existsSync()) child.createSync(recursive: true);
      filled.addAll(_fillMissing(entity, child, root: root));
    } else if (entity is Link) {
      final targetType = FileSystemEntity.typeSync(destination);
      if (targetType == FileSystemEntityType.notFound) {
        Link(destination).createSync(entity.targetSync());
        filled.add(_normalize(entity.path.substring(root.length + 1)));
      }
    } else if (entity is File) {
      if (!File(destination).existsSync()) {
        _copyFileContents(entity, File(destination));
        filled.add(_normalize(entity.path.substring(root.length + 1)));
      }
    }
  }
  return filled;
}

void _copyTree(Directory from, Directory to) {
  to.createSync(recursive: true);
  for (final entity in from.listSync(followLinks: false)) {
    final name = entity.path.split(Platform.pathSeparator).last;
    final destination = '${to.path}${Platform.pathSeparator}$name';

    if (entity is Link) {
      Link(destination).createSync(entity.targetSync());
    } else if (entity is Directory) {
      _copyTree(entity, Directory(destination));
    } else if (entity is File) {
      _copyFileContents(entity, File(destination));
    }
  }
}

void _copyFileContents(File source, File destination) {
  source.copySync(destination.path);
  // 可执行位：插件包里有 shell 脚本与原生小工具，丢了位就跑不起来。
  // `File.copySync` 只搬内容不搬权限，得自己补。
  //
  // 掩到 0xFFF：Dart 的 `FileStat.mode` 带文件类型位（如 0o100644），
  // 直接丢给 chmod 会被当成非法八进制串。Windows 上这段会抛异常，忽略即可。
  try {
    final perm = source.statSync().mode & 0xFFF;
    if (perm & 0x49 != 0) {
      Process.runSync('chmod', [perm.toRadixString(8), destination.path]);
    }
  } on Object {
    // 改不动就算了：多数文件不需要可执行位。
  }
}
