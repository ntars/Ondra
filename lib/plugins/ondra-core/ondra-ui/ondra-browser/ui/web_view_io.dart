import 'package:flutter/services.dart' show StandardMessageCodec;
import 'package:material_ui/material_ui.dart';

/// macOS 的内嵌浏览器：WKWebView 平台视图。
///
/// 平台侧注册在 `macos/Runner/MainFlutterWindow.swift`（`ondra/webview`），
/// 用系统 WebKit，不引入任何第三方插件——少一套 CocoaPods 集成。
///
/// 导航靠「换 key 重建视图」：地址变了就换一个 viewType 实例，
/// 这也是为什么不需要维护一条方法通道。历史前进/后退暂不提供。
class OndraWebView extends StatelessWidget {
  const OndraWebView({super.key, required this.url});

  final String url;

  @override
  Widget build(BuildContext context) {
    return AppKitView(
      viewType: 'ondra/webview',
      creationParams: <String, dynamic>{'url': url},
      creationParamsCodec: const StandardMessageCodec(),
    );
  }
}
