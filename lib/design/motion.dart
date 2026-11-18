import 'package:material_ui/material_ui.dart';

/// 动效令牌：时间常数与非对称贝塞尔。
///
/// 出处：`Caho1/open-claude-ui`（Claude Design System 逆向工程手册）。
/// - `docs/v1/01-设计哲学与设计令牌体系.md` §1.6：物理时间常数矩阵
///   ——70ms 触觉微震、120ms 几何咬合、300ms 面板滑入；
/// - `code-examples/ClaudeMotionPresets.ts` 的 `CDS_EASING`：四条生产曲线，
///   逐条抄录，没有自行调参。
///
/// 为什么要这套而不是 Flutter 默认的 `Curves.easeOut`（≈cubic-bezier(.42,0,.58,1)）：
/// 默认曲线两头都缓，按下去的前 30ms 几乎没有位移，手感是「黏」的。参考实现
/// 的四条曲线都是**起始段极陡**（`SHARP_PRESS` 的 0.72、`EASE_OUT_EXPO` 的 1），
/// 手指落下的那一帧就开始动，收尾才慢下来——这是「跟手」与「等动画」的分界。
class OndraMotion {
  const OndraMotion._();

  /// 触觉微震：按压缩放的行程。短到用户感觉不到「动画在播」，只觉得按到了。
  static const Duration press = Duration(milliseconds: 70);

  /// 几何咬合：滑块、悬停底色、颜色过渡。形状变化要能被看见，但不能慢。
  static const Duration snap = Duration(milliseconds: 120);

  /// 悬停：比 snap 略长，鼠标扫过时底色渐变，不出现整块跳色。
  static const Duration hover = Duration(milliseconds: 150);

  /// 面板滑入：抽屉、设置面板这类「整块出现」的位移。
  static const Duration panel = Duration(milliseconds: 300);

  /// 瞬时按压缩放（`SHARP_PRESS`，`cubic-bezier(.32,.72,0,1)`）。
  static const Cubic pressCurve = Cubic(0.32, 0.72, 0, 1);

  /// 阴影、焦点微光、高斯模糊渐变（`EASE_OUT_EXPO`，`cubic-bezier(.16,1,.3,1)`）。
  static const Cubic expo = Cubic(0.16, 1, 0.3, 1);

  /// 消息气泡与药丸胶囊的微弹入场（`OVERSHOOT`，`cubic-bezier(.34,1.3,.64,1)`）。
  static const Cubic overshoot = Cubic(0.34, 1.3, 0.64, 1);

  /// 抽屉面板滑入（`DECEL`，`cubic-bezier(.165,.84,.44,1)`）。
  static const Cubic decel = Cubic(0.165, 0.84, 0.44, 1);

  /// 按压时按钮缩到原尺寸的 98%。
  ///
  /// 98% 是参考实现的观测值（`docs/v1/01` §1.5「按压态触发 scale(0.98)
  /// 轻量回弹压感」）。这个量级是刻意的：看得见形变、量不出位移，
  /// 像真实按键被压下去一点点；再大就会变成「抖一下」。
  static const double pressedScale = 0.98;
}

/// 深色模式的光学补偿。
///
/// 出处：`open-claude-ui` 的 `code-examples/cds-theme.css`
/// ——`.dark .font-medium{font-variation-settings:"wght" 465}`，
/// 以及同一段里 600 → 560 的那条（`docs/v1/07` 摘要：「暗色模式视网膜字重
/// 逆补偿（`wght 465`, `wght 560`）」）。逆推规则是**每个字重档减 35～40**。
///
/// 依据：`docs/v1/01` §1.5 第 3 小节——高对比度的白字压在黑底上，**视网膜光渗
/// （Irradiation）**会让笔画外缘向外发散一圈光晕，同一枚字形在深色下比浅色下
/// 视觉上粗 10%～15%，文字发胀、边缘发糊。所以深色**不是**加深，而是反向减细。
///
/// 这一层只改显示用的字重轴值，不改 [OndraWeight] 的语义：
/// 调用点照旧写 `OndraWeight.control`，深色由这里统一减细。
class OndraOptics {
  const OndraOptics._();

  static bool _dark = false;

  /// 当前是否处于深色模式。由应用根在每次重建时同步（`MaterialApp.builder`），
  /// 因为文字样式是在各页面 build 里现算的，同步点必须在它们之上。
  static bool get dark => _dark;

  /// 同步当前亮度。幂等，可以每帧调用。
  static void sync({required bool dark}) => _dark = dark;

  /// 把语义字重换成**深色下实际该用的轴值**。
  ///
  /// 只动 450 以上的档位：330 / 380 是正文与说明，本身已经很细，
  /// 再减会掉到「发灰」；参考实现也只对 medium / semibold 做了逆补偿。
  static int weight(int w) {
    if (!_dark) return w;
    if (w >= 600) return w - 40;
    if (w >= 450) return w - 35;
    return w;
  }
}
