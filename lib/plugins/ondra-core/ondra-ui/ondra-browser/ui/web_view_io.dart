import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform;
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import 'web_view_stub.dart' as fallback;

/// IO 不等于 AppKit；既检查实际系统，也支持 Flutter 的平台能力测试。
bool get embeddedBrowserAvailable =>
    Platform.isMacOS && defaultTargetPlatform == TargetPlatform.macOS;

/// 每个原生视图单独的通道：接收被拦截导航的原因，不打开外部浏览器兜底。
class OndraWebView extends StatefulWidget {
  const OndraWebView({
    super.key,
    required this.url,
    required this.allowedSites,
  });

  final String url;
  final List<String> allowedSites;

  @override
  State<OndraWebView> createState() => _OndraWebViewState();
}

class _OndraWebViewState extends State<OndraWebView> {
  MethodChannel? _channel;
  String? _error;

  Map<String, Object> get _params => {
    'url': widget.url,
    'allowedSites': widget.allowedSites,
  };

  @override
  void didUpdateWidget(OndraWebView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.url != widget.url ||
        jsonEncode(oldWidget.allowedSites) != jsonEncode(widget.allowedSites)) {
      _detach();
      _error = null;
    }
  }

  void _detach() {
    final channel = _channel;
    _channel = null;
    if (channel == null) return;
    channel.setMethodCallHandler(null);
    // 销毁/更换规则后先停掉旧视图，避免旧白名单仍能导航。
    channel.invokeMethod<void>('stop').catchError((Object _) {});
  }

  Future<void> _created(int id, String paramsKey) async {
    final channel = MethodChannel('ondra/webview/$id');
    if (!mounted || paramsKey != jsonEncode(_params)) {
      await channel.invokeMethod<void>('stop').catchError((Object _) {});
      return;
    }
    _channel = channel;
    channel.setMethodCallHandler((call) async {
      if (!mounted || _channel != channel) return;
      if (call.method == 'navigationRejected' || call.method == 'loadFailed') {
        final args = call.arguments;
        final reason = args is Map ? args['reason'] : null;
        setState(() => _error = reason is String ? reason : '页面无法打开');
      }
    });
    try {
      // 原生等待 Dart 接好错误处理再加载，首个 URL 的拒绝也不会丢失。
      await channel.invokeMethod<void>('start');
    } on PlatformException catch (e) {
      if (mounted && _channel == channel) {
        setState(() => _error = e.message ?? '内嵌浏览器启动失败');
      }
    } on MissingPluginException {
      if (mounted && _channel == channel) {
        setState(() => _error = '这个构建没有内嵌浏览器');
      }
    }
  }

  @override
  void dispose() {
    _detach();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!embeddedBrowserAvailable) {
      return fallback.OndraWebView(
        url: widget.url,
        allowedSites: widget.allowedSites,
      );
    }
    final s = OndraSkin.of(context);
    final paramsKey = jsonEncode(_params);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (_error != null)
          Container(
            color: s.surface,
            padding: const EdgeInsets.all(10),
            child: Text(
              _error!,
              style: ondraText(12, color: OndraColor.danger, height: 18 / 12),
            ),
          ),
        Expanded(
          child: AppKitView(
            // 规则变化也重建原生视图，撤销站点立即生效。
            key: ValueKey(paramsKey),
            viewType: 'ondra/webview',
            creationParams: _params,
            creationParamsCodec: const StandardMessageCodec(),
            onPlatformViewCreated: (id) => _created(id, paramsKey),
          ),
        ),
      ],
    );
  }
}
