/// 记忆星图的数据源（条件导出）。
///
/// 桌面端真的去读内核的 SQLite 库；浏览器里没有文件系统，
/// 走 stub 如实说明「这个环境读不到本地库」，而不是画一张好看的空图。
library;

export 'memory_source_stub.dart' if (dart.library.io) 'memory_source_io.dart';
