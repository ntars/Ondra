/// 导入导出引擎的入口：桌面端接真实文件与数据库，浏览器预览里一律落空。
///
/// 条件导入的判据是 `dart.library.io`——与备份、日志、记忆三处同一套做法。
/// 两边导出**同名同形**的 `transferEngine`，页面只 import 这一行。
library;

export 'transfer_engine_stub.dart'
    if (dart.library.io) 'transfer_engine_io.dart';
