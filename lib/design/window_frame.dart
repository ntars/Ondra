import 'dart:math' as math;

import 'package:material_ui/material_ui.dart';

/// 把一块内容以「独立窗口」的形态浮在主窗之上。
///
/// 骨架期没有多窗口能力（那要平台通道），因此用带遮罩的全屏路由模拟：
/// 尺寸、圆角、阴影、关闭行为都与真实子窗一致，接入多窗口后把这里
/// 换成真正的窗口创建即可，页面代码不动。
Future<void> showFloatingWindow(
  BuildContext context, {
  required Widget child,
  double? width,
  double? height,
  bool dismissible = true,
}) {
  return Navigator.of(context).push(
    PageRouteBuilder<void>(
      opaque: false,
      barrierDismissible: dismissible,
      barrierColor: Colors.black.withValues(alpha: 0.28),
      transitionDuration: const Duration(milliseconds: 150),
      reverseTransitionDuration: const Duration(milliseconds: 120),
      // 尺寸按视口夹取：桌面给足 960×640，手机上退化为「视口减 32」。
      pageBuilder: (context, animation, secondaryAnimation) => LayoutBuilder(
        builder: (context, constraints) {
          final w = width == null
              ? null
              : math
                    .min(width, constraints.maxWidth - 32)
                    .clamp(0.0, double.infinity);
          final h = height == null
              ? null
              : math
                    .min(height, constraints.maxHeight - 32)
                    .clamp(0.0, double.infinity);
          return Center(
            child: SizedBox(width: w, height: h, child: child),
          );
        },
      ),
      transitionsBuilder: (context, animation, secondaryAnimation, child) {
        final curved = CurvedAnimation(
          parent: animation,
          curve: Curves.easeOut,
        );
        return FadeTransition(
          opacity: curved,
          child: ScaleTransition(
            scale: Tween<double>(begin: 0.98, end: 1).animate(curved),
            child: child,
          ),
        );
      },
    ),
  );
}
