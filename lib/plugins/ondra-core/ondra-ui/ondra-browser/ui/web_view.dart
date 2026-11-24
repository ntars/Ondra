// IO 平台按实现分流：macOS 为 WKWebView，Android 为系统 WebView，
// Windows 为 WebView2 宿主；非桌面/移动预览才显示不可用。
export 'web_view_stub.dart' if (dart.library.io) 'web_view_io.dart';
