import 'dart:convert';
import 'dart:async' show unawaited;

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform;
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import 'web_view_stub.dart' as fallback;

/// IO 不等于 AppKit；既检查实际系统，也支持 Flutter 的平台能力测试。
/// 安卓走系统 WebView 的 PlatformView（OndraWebView.kt），Windows 走
/// WebView2 后端（web_view_win.cpp），三者同一协议。
bool get embeddedBrowserAvailable =>
    defaultTargetPlatform == TargetPlatform.macOS ||
    defaultTargetPlatform == TargetPlatform.android ||
    defaultTargetPlatform == TargetPlatform.windows;

/// Flutter 3.50 的 Windows embedder 还没有可用的 HWND PlatformView 工厂
/// （FlutterDesktopEngineRegisterPlatformViewType 是未实现的 stub）。
/// 因此 Windows 用独立的宿主通道创建原生视图，`WindowsView` 只负责
/// 把同一套创建参数和视图 ID 接到 `ondra/webview/<id>` 协议上。
///
/// 这个常量在测试里也会用到：平台分支可以单独验证，不需要 WebView2 运行时。
const String ondraWebViewHostChannel = 'ondra/webview/host';

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
          // 规则变化也重建原生视图，撤销站点立即生效。四个平台同一
          // viewType、同一通道协议，各自一套原生实现。
          child: _platformView(paramsKey),
        ),
      ],
    );
  }

  Widget _platformView(String paramsKey) {
    if (defaultTargetPlatform == TargetPlatform.windows) {
      return WindowsView(
        key: ValueKey(paramsKey),
        viewType: 'ondra/webview',
        creationParams: _params,
        creationParamsCodec: const StandardMessageCodec(),
        onPlatformViewCreated: (id) => _created(id, paramsKey),
      );
    }
    if (defaultTargetPlatform == TargetPlatform.android) {
      return AndroidView(
        key: ValueKey(paramsKey),
        viewType: 'ondra/webview',
        creationParams: _params,
        creationParamsCodec: const StandardMessageCodec(),
        onPlatformViewCreated: (id) => _created(id, paramsKey),
      );
    }
    return AppKitView(
      key: ValueKey(paramsKey),
      viewType: 'ondra/webview',
      creationParams: _params,
      creationParamsCodec: const StandardMessageCodec(),
      onPlatformViewCreated: (id) => _created(id, paramsKey),
    );
  }
}

// ignore: camel_case_types
typedef WindowsView = _OndraWindowsView;

/// Flutter 3.50 的 `services` 没有内置 WindowsView；这里提供同名 shim。
/// 它用宿主方法通道创建原生 WebView2 后端，并以 registry 生成的 ID 接上
/// 同一协议。它不是 WebView2 实现本身。
class _OndraWindowsView extends StatefulWidget {
  const _OndraWindowsView({
    super.key,
    required this.viewType,
    this.creationParams,
    this.creationParamsCodec,
    this.onPlatformViewCreated,
  });

  final String viewType;
  final dynamic creationParams;
  final MessageCodec<dynamic>? creationParamsCodec;
  final ValueChanged<int>? onPlatformViewCreated;

  @override
  State<_OndraWindowsView> createState() => _WindowsViewState();
}

class _WindowsViewState extends State<_OndraWindowsView> {
  int? _textureId;
  late final int _viewId;

  @override
  void initState() {
    super.initState();
    _viewId = platformViewsRegistry.getNextPlatformViewId();
    _create();
  }

  Future<void> _create() async {
    final args = <String, dynamic>{
      'viewType': widget.viewType,
      'id': _viewId,
    };
    if (widget.creationParams != null) {
      // StandardMessageCodec 不收 ByteData 视图，转成 Uint8List 再过宿主通道。
      final encoded = widget.creationParamsCodec!.encodeMessage(
        widget.creationParams,
      );
      args['params'] = encoded == null
          ? null
          : Uint8List.sublistView(
              encoded, encoded.offsetInBytes, encoded.lengthInBytes);
    }
    try {
      const channel = MethodChannel(ondraWebViewHostChannel);
      final textureId = await channel.invokeMethod<int>('create', args);
      if (!mounted) return;
      setState(() => _textureId = textureId);
      widget.onPlatformViewCreated?.call(_viewId);
    } on PlatformException catch (error) {
      if (!mounted) return;
      // 让共享的 per-view 通道把错误显示出来，避免白名单页面静默为空。
      widget.onPlatformViewCreated?.call(_viewId);
      unawaited(
        MethodChannel('ondra/webview/$_viewId')
            .invokeMethod<void>('loadFailed', <String, String>{
          'reason': error.message ?? 'WebGL 纹理后端不可用',
        }).catchError((Object _) {}),
      );
    } on MissingPluginException {
      if (!mounted) return;
      widget.onPlatformViewCreated?.call(_viewId);
      unawaited(
        MethodChannel('ondra/webview/$_viewId')
            .invokeMethod<void>('loadFailed', <String, String>{
          'reason': '这个构建没有内嵌浏览器',
        }).catchError((Object _) {}),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final textureId = _textureId;
    if (textureId == null) return const SizedBox.expand();
    // Texture 默认通过 BoxConstraints.tightFor 用自己报的像素尺寸布局；
    //  Windows CapturePreview 的帧大小与 Flutter 容器可能不同，放任它按
    //  1280×720 布局会把中栏撑出视口。这里强制填满父级，由 GPU 做缩放。
    return SizedBox.expand(
      child: FittedBox(
        fit: BoxFit.cover,
        child: SizedBox(
          width: 1280,
          height: 720,
          child: Texture(textureId: textureId),
        ),
      ),
    );
  }
}
