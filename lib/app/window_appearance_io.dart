import 'package:flutter/services.dart' show MethodChannel;

/// 把 Flutter 当前是深还是浅告诉 AppKit。
///
/// **为什么非要有这条通道**：`ThemeMode` 只换 Flutter 的画布，动不了窗口的
/// `NSAppearance`。而磨砂玻璃是 AppKit 画的，它只看窗口外观——结果就是
/// 「纸片已经变深、玻璃还是浅的」，两者之间那条 4px 缝亮得像一道刻痕，
/// 深色下尤其难看。
///
/// 通道只在亮度**真的变化**时发一次：`builder` 每帧都会跑，不去重会变成
/// 每帧一次跨进程调用。
const MethodChannel _channel = MethodChannel('ondra/window');

bool? _lastDark;

void applyWindowBrightness({required bool dark}) {
  if (_lastDark == dark) return;
  _lastDark = dark;
  _channel.invokeMethod<void>('setAppearance', dark).catchError((_) {
    // 原生侧没接（比如刚启动、还没建好通道）就忽略：下一次变化会再发一次。
  });
}
