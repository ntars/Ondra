// 启动期调试入口：桌面没有 URL 参数，用环境变量指一个初始页。
export 'debug_launch_stub.dart' if (dart.library.io) 'debug_launch_io.dart';
