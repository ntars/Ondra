/// 人设包落盘层的入口：桌面端接真实文件系统，浏览器预览里一律如实失败。
///
/// 判据是 `dart.library.io`——与备份、日志、记忆、导入导出四处同一套做法。
/// 两边导出同名同形的 `PersonaStore` 与 `PersonaInstall`，页面只 import 这一行。
library;

export 'persona_store_stub.dart' if (dart.library.io) 'persona_store_io.dart';
