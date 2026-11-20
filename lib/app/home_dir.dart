import 'dart:io';

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
String get ondraUserHome {
  final env = Platform.environment;
  final home = env['HOME'];
  if (home != null && home.isNotEmpty) return home;
  final profile = env['USERPROFILE'];
  if (profile != null && profile.isNotEmpty) return profile;
  // 安卓上 HOME 未设、当前目录不可写——不接这一分支的话，所有本地数据
  // （prefs / models.json / 日志）都会静默写失败，界面显示成「没有数据」。
  // TMPDIR 由系统设置为应用私有 cache（/data/user/0/<包名>/cache）：
  // 可写、其他应用读不到。持久的 files 目录需要 path_provider 通道，
  // 是下一轮的事；先保证写得进去。
  if (Platform.isAndroid) {
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
