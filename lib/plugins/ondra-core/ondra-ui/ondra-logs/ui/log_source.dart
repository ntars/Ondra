/// 三类日志的读取层（条件导出）。
///
/// 桌面端读 `~/.ondra/logs/*.log` 的尾部；浏览器里没有文件系统，
/// 走 stub 说明这一点。
library;

export 'log_source_stub.dart' if (dart.library.io) 'log_source_io.dart';
