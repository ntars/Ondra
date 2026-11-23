/// 备份引擎的入口：桌面端接真实文件系统，浏览器预览里一律落空。
///
/// 条件导入的判据是 `dart.library.io`——和 `log_source`、`memory_source`
/// 同一套做法。两边导出**同名同形**的 `backupEngine` / `backupScheduler`，
/// 页面只 import 这一行，不需要知道自己在哪。
library;

export 'backup_engine_stub.dart' if (dart.library.io) 'backup_engine_io.dart';
