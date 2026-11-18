import 'package:flutter/gestures.dart' show kPrimaryButton;
import 'package:material_ui/material_ui.dart';

import 'motion.dart';
import 'skin.dart';
import 'tokens.dart';

/// 按下反馈：整颗控件缩到 98%，并压一层极淡的蒙层。
///
/// 为什么值得单独抽一个组件：整套界面没有涟漪（`NoSplash`），也没有投影
/// 抬升，鼠标点下去如果只是「颜色变了一下」，在触控板上几乎感知不到
/// ——用户会怀疑是不是没点上。参考实现在按压态做 `scale(0.98)`，就是补这一下
/// 「被按下去」的物理确认（出处见 [OndraMotion.pressedScale]）。
///
/// [tint] 是叠在**前景**的一层：它必须压在子控件的白底/蓝底之上才能让
/// 整颗按钮一起变暗。浅色压 4% 黑，深色压 6% 白——深色的「按下」是变亮，
/// 因为深色面层本来就靠提亮来表示选中与激活。
///
/// 只负责按压与命中，不负责 hover：各控件的 hover 底色差别太大
/// （透明、6% 面、浅灰实底各有各的规矩），硬统一会把它们抹平。
class OndraPressable extends StatefulWidget {
  const OndraPressable({
    super.key,
    required this.child,
    this.onTap,
    this.radius = OndraRadius.md,
    this.scale = true,
    this.tint = true,
  });

  final Widget child;
  final VoidCallback? onTap;

  /// 蒙层的圆角，应当与被按控件的外形一致（圆形传 [OndraRadius.pill]）。
  final double radius;

  /// 小尺寸控件（≤24）关掉缩放：0.98 只差半个像素，缩不缩都一样，
  /// 反而可能让图标在像素网格上糊掉。
  final bool scale;
  final bool tint;

  @override
  State<OndraPressable> createState() => _OndraPressableState();
}

class _OndraPressableState extends State<OndraPressable> {
  bool _down = false;

  void _set(bool v) {
    if (_down != v) setState(() => _down = v);
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final enabled = widget.onTap != null;
    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: Listener(
        // 用 Listener 而不是 GestureDetector 的 onTapDown：鼠标按下后拖出
        // 控件再松手，`onTapCancel` 会补一次抬起，状态不会卡在「按着」。
        // 只认主键：右键 / 中键不产生按压形变，那是另一种手势。
        onPointerDown: enabled
            ? (e) {
                if (e.buttons == kPrimaryButton) _set(true);
              }
            : null,
        onPointerUp: enabled ? (_) => _set(false) : null,
        onPointerCancel: enabled ? (_) => _set(false) : null,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          child: AnimatedScale(
            scale: _down && widget.scale ? OndraMotion.pressedScale : 1,
            duration: OndraMotion.press,
            curve: OndraMotion.pressCurve,
            child: Container(
              foregroundDecoration: _down && widget.tint
                  ? BoxDecoration(
                      color: s.dark
                          ? const Color(0x0FFFFFFF)
                          : const Color(0x0A000000),
                      borderRadius: BorderRadius.circular(widget.radius),
                    )
                  : null,
              child: widget.child,
            ),
          ),
        ),
      ),
    );
  }
}
