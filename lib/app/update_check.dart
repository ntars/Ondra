/// 检查更新：问 GitHub Releases，跟当前版本比。
///
/// 桌面端真发请求；浏览器预览里如实说明做不到（CORS 会挡住，假装成功更糟）。
library;

export 'update_check_stub.dart' if (dart.library.io) 'update_check_io.dart';
