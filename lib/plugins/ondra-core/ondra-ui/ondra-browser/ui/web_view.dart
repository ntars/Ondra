// 仅 macOS 使用 WKWebView；其他 IO 平台及 Web 都明确显示不可用。
export 'web_view_stub.dart' if (dart.library.io) 'web_view_io.dart';
