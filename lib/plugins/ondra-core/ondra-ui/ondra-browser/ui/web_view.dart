// 内嵌 WebView 的条件导出：桌面用 WKWebView 平台视图，Web 落下到说明页。
export 'web_view_stub.dart' if (dart.library.io) 'web_view_io.dart';
