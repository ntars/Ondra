import 'dart:io';

import 'bundled_runtime.dart';
import 'home_dir.dart';

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
/// 幂等：已经有就什么都不做。**同步**执行——它发生在首帧之前，异步反而会让
/// 「界面已出、profile 还没铺好」出现一个可被点到的空窗。
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

  final home = dshHome ??
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
    // 源快照里有、目标里没有的文件补上；两边都有的不动。
    try {
      var filled = _fillMissing(Directory(runtime.profileDir), Directory(target));
      if (filled > 0) {
        return RuntimeSeedResult(RuntimeSeedOutcome.seeded, targetPath: target);
      }
    } on FileSystemException {
      // 补缺失败不覆盖已有内容，保持 alreadyPresent。
    }
    return RuntimeSeedResult(RuntimeSeedOutcome.alreadyPresent, targetPath: target);
  }

  try {
    _copyTree(Directory(runtime.profileDir), Directory(target));
    return RuntimeSeedResult(RuntimeSeedOutcome.seeded, targetPath: target);
  } on FileSystemException catch (e) {
    return RuntimeSeedResult(
      RuntimeSeedOutcome.failed,
      targetPath: target,
      error: '${e.message}（${e.path ?? target}）',
    );
  }
}

/// 递归复制，保留符号链接。
///
/// 不跟随链接的理由：pnpm 装的 profile 里 `node_modules/@ondra/*` 可能是指向
/// 别处的链接。跟随会把目标内容整棵复制进来（体积翻倍且失去升级语义），
/// 不复制又会丢包。原样搬过去才对。
/// 只补目标里缺失的文件；两边都有的不覆盖。返回补上的文件数。
int _fillMissing(Directory from, Directory to) {
  var filled = 0;
  for (final entity in from.listSync(followLinks: false)) {
    final name = entity.path.split(Platform.pathSeparator).last;
    final destination = '${to.path}${Platform.pathSeparator}$name';
    if (entity is Directory) {
      final child = Directory(destination);
      if (!child.existsSync()) child.createSync(recursive: true);
      filled += _fillMissing(entity, child);
    } else if (entity is File) {
      if (!File(destination).existsSync()) {
        entity.copySync(destination);
        filled++;
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
      entity.copySync(destination);
      // 可执行位：插件包里有 shell 脚本与原生小工具，丢了位就跑不起来。
      // `File.copySync` 只搬内容不搬权限，得自己补。
      //
      // 掩到 0xFFF：Dart 的 `FileStat.mode` 带文件类型位（如 0o100644），
      // 直接丢给 chmod 会被当成非法八进制串。Windows 上这段会抛异常，忽略即可。
      try {
        final perm = entity.statSync().mode & 0xFFF;
        if (perm & 0x49 != 0) {
          Process.runSync('chmod', [perm.toRadixString(8), destination]);
        }
      } on Object {
        // 改不动就算了：多数文件不需要可执行位。
      }
    }
  }
}
