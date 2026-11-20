import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// 用户主目录。
///
/// **为什么不能直接用 `$HOME`**：Windows 不给进程设 `HOME`（它用 `USERPROFILE`
/// 与 `HOMEDRIVE`+`HOMEPATH`）。原来的写法是
/// `Platform.environment['HOME'] ?? '.'`，在 Windows 上会退化成**相对路径**
/// `./.ondra`——从开始菜单启动时当前目录是程序安装目录，通常在
/// `C:\Program Files\…` 下，普通用户没有写权限。
///
/// 那个失败还很安静：`dart:io` 写到不可写目录会抛 `FileSystemException`，
/// 而多数调用点把它当「文件不存在」处理，界面于是显示成「没有数据」。
///
/// 顺序：`HOME` → `USERPROFILE`（Windows）→ 当前目录。
/// 最后一级只是兜底：宁可写到能写的地方，也不要抛在启动路径上。
/// 安卓的持久数据目录（`getApplicationDocumentsDirectory`），
/// 在 `main()` 的启动序列里初始化一次。null = 尚未就绪或拿不到，
/// 此时 `ondaUserHome` 回退到 TMPDIR（可写但可能被系统清理）。
String? _androidOverride;

/// 启动时调用（`main()` 里 `await`）。安卓专属，其他平台是空操作。
Future<void> initAndroidHome() async {
  if (!Platform.isAndroid) return;
  try {
    final dir = await getApplicationDocumentsDirectory();
    if (dir.path.isNotEmpty) _androidOverride = dir.path;
  } catch (_) {
    // path_provider 不可用（冷启动竞态等）：保持 TMPDIR 回退，
    // 数据功能仍可用，只是可能被系统清理——好过整个应用起不来。
  }
}

String get ondraUserHome {
  final env = Platform.environment;
  final home = env['HOME'];
  if (home != null && home.isNotEmpty) return home;
  final profile = env['USERPROFILE'];
  if (profile != null && profile.isNotEmpty) return profile;
  // 安卓上 HOME 未设、当前目录不可写——不接这一分支的话，所有本地数据
  // （prefs / models.json / 日志）都会静默写失败，界面显示成「没有数据」。
  // 持久落点 = 应用私有 files 目录（path_provider，见 initAndroidHome）；
  // 未就绪时退到 TMPDIR（应用私有 cache，可写但可能被系统清理）。
  if (Platform.isAndroid) {
    final override = _androidOverride;
    if (override != null && override.isNotEmpty) return override;
    final tmp = env['TMPDIR'];
    if (tmp != null && tmp.isNotEmpty) return tmp;
    return Directory.systemTemp.path;
  }
  return Directory.current.path;
}

/// `~/.ondra` —— 数据根目录的绝对路径。
///
/// 各处的 `'$home/.ondra'` 统一走这里，避免同一件事在十几个文件里各写一遍
/// 路径分隔符与兜底逻辑。正斜杠在 Windows 上也成立，`dart:io` 两种都认。
String get ondraUserDataRoot => '${ondraUserHome.replaceAll(r'\', '/')}/.ondra';
