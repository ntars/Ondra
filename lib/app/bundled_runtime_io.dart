import 'dart:io';

/// 一份随包运行时的三个入口路径。
///
/// 三者必须来自同一个 `runtime/<平台>-<架构>/` 目录：混用会出现
/// 「用包里 108MB 的 node 去跑系统装的 dsh」这种半随包状态，出错时极难判断。
class OndraBundledRuntime {
  const OndraBundledRuntime({
    required this.rootDir,
    required this.nodePath,
    required this.dshEntry,
    required this.profileDir,
  });

  /// `runtime/macos-arm64` 本身。排障时把它打进日志，一眼看出用的哪一份。
  final String rootDir;

  /// node 可执行文件。
  final String nodePath;

  /// dsh 的命令行入口 `dsh/lib/bin.js`。
  ///
  /// 启动方式是 `node <dshEntry> --profile ondra`，而不是直接执行 `dsh`——
  /// 后者是个带 `#!/usr/bin/env node` 的脚本，靠 PATH 找解释器；GUI 应用
  /// 拿到的 PATH 是极简版，找不到 node 就会静默退出。显式传解释器绕开了
  /// 整条 PATH 依赖。
  final String dshEntry;

  /// profile 种子目录（`cordis.yml` + `node_modules/@ondra/*`）。
  final String profileDir;

  bool get hasProfile => Directory(profileDir).existsSync();

  @override
  String toString() => 'OndraBundledRuntime($rootDir)';
}

OndraBundledRuntime? _cache;
bool _probed = false;

/// 找随包运行时；找不到返回 null。
///
/// 只探测一次并缓存：这个函数会在每次连接内核时被调到，而结果在一次运行内
/// 不会变（用户不会中途把 runtime 目录塞进应用包里）。
OndraBundledRuntime? get ondraBundledRuntime {
  if (_probed) return _cache;
  _probed = true;
  for (final base in _runtimeBases()) {
    final found = _pickIn(base);
    if (found != null) {
      _cache = found;
      break;
    }
  }
  return _cache;
}

/// 测试用：清掉缓存，让下一页探测重新读磁盘。
void debugResetBundledRuntime() {
  _probed = false;
  _cache = null;
}

String get _sep => Platform.pathSeparator;

/// 候选的 `runtime/` 父目录，按优先级排列。
///
/// 顺序有讲究：**离可执行文件最近的最优先**。开发期这份（工作目录下的）
/// 排在最后，因为它只该在打包版找不到时才生效——否则开发者一跑测试就会
/// 用上仓库里那份，验不到真实安装形态。
Iterable<String> _runtimeBases() sync* {
  final exeDir = File(Platform.resolvedExecutable).parent.path;

  // macOS 应用包：可执行在 Contents/MacOS，随包资源在 Contents/Resources。
  if (Platform.isMacOS) {
    yield _normalize('$exeDir/../Resources/runtime');
  }
  // Windows / Linux 单目录分发：runtime 就在可执行文件旁边。
  yield _normalize('$exeDir/runtime');

  // Linux 的系统级安装布局（/usr/bin/ondra）。
  if (!Platform.isMacOS && !Platform.isWindows) {
    yield _normalize('$exeDir/../lib/ondra/runtime');
    yield _normalize('$exeDir/../share/ondra/runtime');
  }

  // 开发期兜底：`flutter run` 的可执行在 build/ 深处，那里不会有 runtime；
  // 从当前目录往上找仓库根的那一份。限 4 层，避免一路翻到文件系统根。
  var dir = _normalize(Directory.current.path);
  for (var i = 0; i < 4; i++) {
    yield '$dir/runtime';
    final parent = Directory(dir).parent.path;
    if (parent == dir || parent.isEmpty) break;
    dir = _normalize(parent);
  }
}

/// 在 `base` 下挑一个可用的平台目录。
///
/// 不写死架构名：Dart 没有 `Platform.architecture`，而 Mach-O/PE 头里读
/// 架构要么加依赖要么写一堆字节解析。改成**按平台前缀扫目录**——每个安装包
/// 只装一个平台的一份运行时，扫到的就是对的。
OndraBundledRuntime? _pickIn(String base) {
  final dir = Directory(base);
  if (!dir.existsSync()) return null;

  final os = Platform.operatingSystem; // macos / windows / linux
  List<FileSystemEntity> entries;
  try {
    entries = dir.listSync()..sort((a, b) => a.path.compareTo(b.path));
  } on FileSystemException {
    return null;
  }

  for (final entry in entries) {
    if (entry is! Directory) continue;
    final name = entry.path.split(_sep).last;
    if (!name.startsWith('$os-')) continue;

    final node = _firstExisting([
      '${entry.path}${_sep}node$_suffix',
      // Windows 上装配脚本产出的名字是 node.exe；两种都认，免得平台判断
      // 一旦写错就整条链路找不到。
      '${entry.path}${_sep}node',
    ]);
    final dshEntry = File(
      '${entry.path}${_sep}dsh${_sep}lib${_sep}bin.js',
    );
    if (node == null || !dshEntry.existsSync()) continue;

    return OndraBundledRuntime(
      rootDir: entry.path,
      nodePath: node,
      dshEntry: dshEntry.path,
      profileDir: '${entry.path}${_sep}profile',
    );
  }
  return null;
}

/// Windows 的 `.exe` 后缀：装配脚本按平台命名，读取侧两种都试。
String get _suffix => Platform.isWindows ? '.exe' : '';

String? _firstExisting(List<String> paths) {
  for (final p in paths) {
    if (File(p).existsSync()) return p;
  }
  return null;
}

/// 消掉 `..` 与重复分隔符。
///
/// 不引 `package:path`（项目没有这个依赖，为四个函数加一个包不值得），
/// 也避免把 `…/Contents/MacOS/../Resources/…` 这种路径写进日志和错误提示——
/// 用户看到带 `..` 的路径会以为是拼接出错。
String _normalize(String path) {
  // 只有 POSIX 的绝对路径需要补前导 `/`；Windows 的 `C:\…` 首段本身就是
  // `C:`，补斜杠会拼出 `/C:/…` 这种不认的路径。
  final posixAbsolute = path.startsWith('/');
  final parts = <String>[];
  for (final segment in path.split(RegExp(r'[/\\]'))) {
    if (segment.isEmpty || segment == '.') continue;
    if (segment == '..') {
      if (parts.isNotEmpty && parts.last != '..') {
        parts.removeLast();
        continue;
      }
      if (posixAbsolute) continue; // 已经在根上，`..` 无意义
    }
    parts.add(segment);
  }
  final joined = parts.join('/');
  return posixAbsolute ? '/$joined' : joined;
}
