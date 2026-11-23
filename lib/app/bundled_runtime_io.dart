import 'dart:io';
import 'dart:typed_data' show Uint8List;

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart' show MethodChannel;

import 'android_native.dart';
import 'home_dir.dart';

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
    this.libDir,
  });

  /// 动态库目录（安卓 = nativeLibraryDir，node 的依赖库都在那里；
  /// 桌面 = null，依赖走系统路径）。启动子进程时要喂给 LD_LIBRARY_PATH。
  final String? libDir;

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
  // 安卓：内核与闭包不在 runtime/<plat>/ 里，而在 jniLibs（libnode.so）
  // 与应用私有目录（assets 解压出来的 dsh）。initAndroidRuntimeAssets()
  // 在启动序列里已把解压做完；这里只做探测，失败如实 null。
  if (Platform.isAndroid) {
    return _cache = _androidRuntime();
  }
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

/// 安卓的解压目标：应用私有目录下的 runtime-android。
String get _androidRuntimeDir =>
    '${ondraUserDataRoot.replaceAll(r'\', '/')}/runtime-android';

String? _androidLibDirCache;

/// 安卓运行时探测：闭包解压 + libnode.so 就位即返回。
OndraBundledRuntime? _androidRuntime() {
  final dshEntry = File('$_androidRuntimeDir/lib/bin.js');
  final libDir = _androidLibDirCache;
  if (!dshEntry.existsSync() || libDir == null) return null;
  final node = File('$libDir/libnode.so');
  if (!node.existsSync()) return null;
  final profile = Directory('$_androidRuntimeDir/profile');
  return OndraBundledRuntime(
    rootDir: _androidRuntimeDir,
    nodePath: node.path,
    dshEntry: dshEntry.path,
    profileDir: profile.existsSync()
        ? profile.path
        : '$_androidRuntimeDir/dsh',
    libDir: libDir,
  );
}

/// 启动序列调用（安卓专属，其他平台空操作）：把 assets 里的内核闭包
/// 解压到应用私有目录。幂等——MANIFEST 记录 APK 内 zip 的 SHA-256，
/// 没变就跳过（省去每次启动 14MB 的解压）；变了（升级 APK 或重建产物）
/// 整体重铺。只比对 `ondraBuild` 会让「构建号没动但 zip 重新生成」的
/// 安装包沿用旧目录，典型症状就是升级后仍报 profile 不存在。
///
/// 为什么不直接从 assets 跑：node 的模块解析、dsh 的会话库都要真实
/// 文件路径，assets 是只读的内存映射。
Future<void> initAndroidRuntimeAssets() async {
  if (!Platform.isAndroid) return;
  _androidLibDirCache = await androidNativeLibDir();
  final zipDir = Directory(_androidRuntimeDir);
  final manifestFile = File('$_androidRuntimeDir/MANIFEST');
  final flockPath = '$_androidRuntimeDir/node_modules/@deepseek-ai/node-addon-system/lib/flock.js';
  try {
    // Gradle 把 `app/src/main/assets` 原样放进 APK 根的 assets/，而
    // rootBundle 只映射 Flutter 自己的 flutter_assets/。这个闭包不放在
    // pubspec 里——否则桌面/Web 构建要么找不到文件，要么多打 15MB 副本。
    // 走 AssetManager 读的同一份原生打包产物。
    const channel = MethodChannel('ondra/assets');
    final bytes = await channel.invokeMethod<Uint8List>(
      'read',
      'ondra-dsh.zip',
    );
    if (bytes == null || bytes.isEmpty) {
      throw StateError('APK 里没有 assets/ondra-dsh.zip');
    }
    final expected = '${sha256.convert(bytes)}\n';
    // 旧 MANIFEST 只写了 build=；旧目录也可能在解压中途被杀掉，留下
    // MANIFEST 缺失但有半份文件的残骸。两种情况都整体重铺。
    if (manifestFile.existsSync() &&
        manifestFile.readAsStringSync().startsWith(expected) &&
        _androidRuntimeLayoutComplete(zipDir)) {
      // 老版本已经解压过同一份 APK，但那时没有这段补丁；不要因为跳过
      // 解压就把它漏掉。
      _patchAndroidFlockPlatform(flockPath);
      return; // 已经解压过，同一份 zip。
    }
    final archive = ZipDecoder().decodeBytes(bytes);
    await _extractArchive(archive, zipDir, manifestFile, expected);
    // 上游 flock.js 的平台白名单只有 linux/darwin，但 Android 内核一样有
    // flock(2)。这里补一个 android 分支，避免每次会话写入都被判为平台不支持。
    // 幂等标记先查，引擎升级后锚点变了就跳过，不让启动失败。
    _patchAndroidFlockPlatform(flockPath);
  } on Exception {
    // 解压失败（存储满、通道缺）：如实清空 MANIFEST，探测会返回 null，
    // 界面按「内核不可用」处理——好过半解压的残骸被当成完整闭包。
    if (manifestFile.existsSync()) manifestFile.deleteSync();
  }
}

/// MANIFEST 丢失时不能完全相信目录里的文件：上次解压被系统杀掉会
/// 留下半份闭包，而缺失的常常正是 `profile/package.json` 这种启动
/// 必需文件。用几个入口文件当完整性代理，成本只有几次 stat。
bool _androidRuntimeLayoutComplete(Directory zipDir) => [
      'lib/bin.js',
      'profile/package.json',
      'profile/cordis.yml',
      'node_modules/@deepseek-ai/dsh-app-boot/package.json',
    ].every((name) => File('${zipDir.path}/$name').existsSync());

void _patchAndroidFlockPlatform(String path) {
  const guard = "if (platform !== 'linux' && platform !== 'darwin') {";
  const patched = "if (platform !== 'linux' && platform !== 'darwin' && platform !== 'android') {";
  const marker = "&& platform !== 'android'";
  final file = File(path);
  if (!file.existsSync()) return;
  final source = file.readAsStringSync();
  if (source.contains(marker) || !source.contains(guard)) return;
  file.writeAsStringSync(source.replaceFirst(guard, patched), flush: true);
}

/// 把 APK asset 里的 zip 解压到应用私有目录。MANIFEST 只在全部写完后落盘，
/// 中途失败不会让半份闭包被当成可用版本。
Future<void> _extractArchive(
  Archive archive,
  Directory zipDir,
  File manifestFile,
  String expected,
) async {
  if (zipDir.existsSync()) {
    zipDir.deleteSync(recursive: true);
  }
  zipDir.createSync(recursive: true);
  var files = 0;
  for (final entry in archive) {
    if (entry.isFile) {
      final out = File('${zipDir.path}/${entry.name}');
      out.createSync(recursive: true);
      out.writeAsBytesSync(entry.content as List<int>);
      files++;
    } else {
      Directory('${zipDir.path}/${entry.name}').createSync(recursive: true);
    }
  }
  manifestFile.writeAsStringSync('$expected\nfiles=$files\n', flush: true);
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
