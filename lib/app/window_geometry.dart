// 平台窗口能力的入口：桌面走 window_manager，web 上是空实现。
// 用条件导出而不是 `kIsWeb` 分支：`window_manager` 只在桌面编译，
// 这样 web 构建里根本不会出现这个依赖，打包体积与编译都干净。
export 'window_geometry_stub.dart'
    if (dart.library.io) 'window_geometry_desktop.dart';
