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
  });

  final String rootDir;
  final String nodePath;
  final String dshEntry;
  final String profileDir;

  bool get hasProfile => false;
}

OndraBundledRuntime? get ondraBundledRuntime => null;

void debugResetBundledRuntime() {}
