import 'package:flutter/foundation.dart';

/// 桌面窗口的几何：**960×600、最小尺寸同值、每次启动重置**。
///
/// 实现已经下沉到各平台的原生入口：macOS 在
/// `macos/Runner/MainFlutterWindow.swift` 的 `awakeFromNib` 里设置，
/// 这样 Dart 侧不必依赖 `window_manager`（少一个原生插件、少一套 CocoaPods）。
///
/// 为什么不在 Dart 里做：窗口尺寸是平台能力，交给平台最稳——尤其是
/// 「在窗口显示前就定好尺寸」这件事，Dart 侧只能在首帧之后补，会闪一帧。
///
/// Windows / Linux 的同类实现待补（各自的 `win32_window.cpp` / `my_application.cc`）；
/// 在那之前这两个平台的窗口沿用系统默认尺寸，功能不受影响。
Future<void> applyWindowGeometry() async {
  if (kIsWeb) return;
  // 原生侧已处理；这里保留调用点，避免将来接别的平台时改动调用方。
}
