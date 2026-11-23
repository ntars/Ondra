/// 应用级维护动作的入口：桌面端接真实文件系统，浏览器预览里如实拒绝。
library;

export 'maintenance_stub.dart' if (dart.library.io) 'maintenance_io.dart';
