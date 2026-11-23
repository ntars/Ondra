import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;
import 'package:material_ui/material_ui.dart';

/// 当前是不是**手机**（而不是「一个很窄的桌面窗口」）。
///
/// ## 为什么不能用宽度判断
///
/// 桌面窗口可以被拖到 600 宽，但那时它仍然是三栏的应用：用户有鼠标、
/// 有键盘、有可拖动的窗口。手机没有这些——没有 hover、没有拖窗、
/// 手指的目标尺寸比鼠标大一圈、屏幕顶上还有刘海和状态栏。
///
/// 这两件事的**处置方式完全不同**：
/// - 窄窗口：栏收起来当抽屉，其余照旧（这是 `chassis.dart` 的紧凑形态）；
/// - 手机：聊天就是主界面，别的功能收进抽屉，布局按单列重排。
///
/// 拿宽度当判据会让「把窗口拖窄」意外触发手机布局，用户会看到侧栏突然
/// 变成全屏抽屉、页面标题挪位置——而他从没要求过这些。
///
/// ## 为什么 Web 不算
///
/// 浏览器里既可能是手机也可能是桌面，`defaultTargetPlatform` 在移动浏览器上
/// 也会报 android/iOS。但 Web 版的定位是**桌面预览**（见 `chassis.dart`
/// 的紧凑形态注释），把它当手机处理会让桌面浏览器也变成单列。
/// 真要支持移动浏览器，应当另开一条判据（比如 `MediaQuery` 的
/// 最窄边 + 触摸能力），而不是把这条改松。
bool get ondraIsMobile {
  if (kIsWeb) return false;
  return defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS;
}

/// 手机上的底部安全距离：刘海屏的「home 指示条」会压住内容。
///
/// 键盘弹出时返回 0：那时系统键盘已经盖住了指示条所在的位置，
/// 再留一条空白会在键盘和输入框之间多出一道缝，看起来像输入区飘起来了。
double ondraMobileBottomInset(BuildContext context) {
  final media = MediaQuery.of(context);
  if (media.viewInsets.bottom > 0) return 0;
  return media.padding.bottom;
}
