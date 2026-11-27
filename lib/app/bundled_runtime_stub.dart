/// 浏览器里没有子进程，也就没有随包运行时。
///
/// 返回 null 而不是编一个路径：Web 预览本来就连不上内核，
/// 让它走「找不到 → 退回系统」那条正常分支即可。
class OndraBundledRuntime {
  const OndraBundledRuntime({
    required this.rootDir,
    required this.nodePath,
    required this.dshEntry,
    required this.profileDir,
    this.libDir,
  });

  final String rootDir;
  final String nodePath;
  final String dshEntry;
  final String profileDir;

  String get securityPatchPath => '';

  /// 动态库目录（桌面/Web 恒 null）。
  final String? libDir;

  bool get hasProfile => false;
}

OndraBundledRuntime? get ondraBundledRuntime => null;

void debugResetBundledRuntime() {}

/// Web 空操作：没有 assets 解压，也没有内核。
Future<void> initAndroidRuntimeAssets() async {}
