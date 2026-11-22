/// 用户主目录（桌面 / Android 实现）。
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
///
/// Web 不能用这份实现：`dart:io.Platform` 在浏览器里的任何 getter 都会
/// 抛 `Unsupported operation`，而 `ondraUserHome` 在首帧前就会被调用——
/// 条件导出到 `home_dir_stub.dart` 才能避免整页白屏。
library;

export 'home_dir_stub.dart' if (dart.library.io) 'home_dir_io.dart';
