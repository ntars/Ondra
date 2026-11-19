import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform, kIsWeb;

/// 当前平台有没有一层**原生玻璃**垫在 Flutter 画布底下。
///
/// ## 为什么需要这个判断
///
/// 侧栏的通透感**不是 Dart 画出来的**：`macos/Runner/MainFlutterWindow.swift`
/// 往 `contentView` 最底层插了一个 `NSGlassEffectView`（拿不到就回退
/// `NSVisualEffectView`），Dart 侧只负责「哪块透、哪块实」——侧栏画
/// `Colors.transparent`，让玻璃露出来。
///
/// 这套做法的前提是**那层玻璃真的存在**。Windows 与 Linux 的 runner 是
/// Flutter 默认模板（`windows/runner/main.cpp` + `win32_window.cpp`），
/// 里面没有任何玻璃层，窗口就是一块普通的不透明表面。此时再画透明，
/// 露出来的是窗口自己的底色：浅色下是一片与侧栏不搭的白，深色下更糟——
/// 侧栏本该是 `#20242D`，实际露出的是一块亮底，看起来像「深色纸上贴了
/// 一张白条」。
///
/// 所以平台判断必须显式：**只有 macOS 有玻璃**。这不是「哪个平台更好看」
/// 的取舍，而是「底下到底有没有那一层」的事实。
///
/// ## 替代纯色从哪来
///
/// 不新增令牌：直接取皮肤的 `shell` 角色。它本来就是「没有玻璃时侧栏该是
/// 什么颜色」——浅色 `#F6F7FA`、深色 `#20242D`，两套主题各自成立，
/// 且与玻璃版的观感同一档（玻璃版在浅色下实测就是这个色系）。
bool get ondraHasNativeGlass {
  // Web 没有原生窗口，浏览器里也不存在 behind-window 合成。
  if (kIsWeb) return false;
  return defaultTargetPlatform == TargetPlatform.macOS;
}
