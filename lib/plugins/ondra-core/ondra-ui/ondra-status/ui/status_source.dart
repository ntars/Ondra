/// 状态面板取数的入口：桌面端读真实库与日志，浏览器预览里返回空。
///
/// 条件导入的判据是 `dart.library.io`——与备份、日志、记忆、导入导出同一套做法。
library;

export 'status_source_stub.dart'
    if (dart.library.io) 'status_source_io.dart';
