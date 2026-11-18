import 'package:material_ui/material_ui.dart';

/// 时间线的场景色。
///
/// 为什么允许在这里出现一组**深色**常量，而整个应用是浅色的：时间线不是
/// 这个应用的「一页」，它是一个**空间**——整窗接管，换成一片星场，让窗口
/// 悬在时间里。要的是这件事，不是把浅色页面调暗。
///
/// 颜色仍然只用一套：焦点辉光取 [OndraColor.sendBlue] 同一支蓝（#2F7BFF），
/// 这是全应用唯一的彩色，用它标记「此刻选中的那一份」，含义与发送键一致——
/// 一个不可轻率的动作。
class TimelinePalette {
  const TimelinePalette._();

  /// 深空底色：上端近黑、下端带一点冷调，让窗口下沿不糊在背景里。
  static const voidTop = Color(0xFF05070D);
  static const voidMid = Color(0xFF0A1020);
  static const voidBottom = Color(0xFF04060B);

  /// 星点与文字。
  static const star = Color(0xFFFFFFFF);
  static const ink = Color(0xFFE9EEF8);
  static const inkSoft = Color(0xB3E9EEF8);
  static const inkDim = Color(0x73E9EEF8);
  static const inkFaint = Color(0x40E9EEF8);

  /// 焦点辉光。
  static const glow = Color(0xFF2F7BFF);

  /// 前景窗口（被选中的那一份）。时间线里它是白的——它代表「真实存在过的
  /// 那一刻」，不该和周围的剪影一个亮度。
  static const frontSurface = Color(0xFFF8FAFD);
  static const frontLine = Color(0x14000000);

  /// 身后的剪影。
  ///
  /// 比背景亮一档**且明显偏蓝**：纯黑加一层透明在深空背景上是看不见的，
  /// 而时间线的纵深全靠「后面还叠着几扇窗」这件事撑着。边线给到 20% 白，
  /// 让每层退远的窗都留一道可辨的轮廓。
  static const ghostSurface = Color(0xFF17223A);
  static const ghostLine = Color(0x33FFFFFF);

  /// 「现在」这一档用暖一点的边：它不是一个快照，只是此刻的状态。
  static const nowEdge = Color(0x66FFFFFF);
}
