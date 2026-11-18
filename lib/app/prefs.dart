/// 轻量偏好存储：只存少量「下次启动要记得」的开关，不是配置中心。
///
/// 桌面写 `~/.ondra/prefs.json`（与 `~/.ondra/logs/window.log` 同一个目录，
/// 卸载应用时一起清掉，不污染 `~/Library`）；Web 无持久文件系统，留在内存里。
library;

export 'prefs_stub.dart' if (dart.library.io) 'prefs_io.dart';
