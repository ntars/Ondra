import 'dart:math' as math;

import 'package:material_ui/material_ui.dart';

import 'timeline_palette.dart';

/// 深空背景：一段渐变 + 一层星点 + 一团极淡的辉光。
///
/// 三层星点用不同的视差系数：越"远"的层移动越少。切换时间点时 [parallax]
/// 变化，星星跟着微微位移——这一步是「在时间里移动」与「换了一页」的区别，
/// 没有它，堆叠的窗口看起来只是几张叠起来的卡片。
///
/// 星点用固定种子生成：同一个尺寸每次画出来都是同一片星空，不会重绘一次
/// 就换一批星星（那会像噪点，不像空间）。
class OndraStarField extends StatelessWidget {
  const OndraStarField({
    super.key,
    this.parallax = 0,
    this.seed = 20261117,
    this.dim = false,
  });

  /// 时间位移量，单位是「快照格」。正数往后（更旧），负数往前。
  final double parallax;

  final int seed;

  /// 缩小的场合（页面上那张入口卡）用：星点少一半、辉光弱一半，
  /// 免得一张 120 高的卡片里挤满星星，看起来像撒了盐。
  final bool dim;

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: CustomPaint(
        painter: _StarPainter(parallax: parallax, seed: seed, dim: dim),
        size: Size.infinite,
      ),
    );
  }
}

class _StarPainter extends CustomPainter {
  _StarPainter({required this.parallax, required this.seed, required this.dim});

  final double parallax;
  final int seed;
  final bool dim;

  /// 三层星的数量比例与视差系数。
  static const List<(double share, double factor, double maxR)> _layers = [
    (0.58, 3.0, 0.9), // 远：细、几乎不动
    (0.30, 7.0, 1.3),
    (0.12, 14.0, 1.9), // 近：大、移动明显
  ];

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final rect = Offset.zero & size;

    // 底色：三段渐变。中间那段稍亮，画面重心才在窗口那一带。
    canvas.drawRect(
      rect,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [
            TimelinePalette.voidTop,
            TimelinePalette.voidMid,
            TimelinePalette.voidBottom,
          ],
          stops: [0, 0.55, 1],
        ).createShader(rect),
    );

    // 辉光：压在画面中心偏下，是「此刻」那一份窗口的光。
    final glowCenter = Offset(size.width * 0.56, size.height * 0.62);
    final glowRadius = size.shortestSide * (dim ? 0.5 : 0.72);
    canvas.drawCircle(
      glowCenter,
      glowRadius,
      Paint()
        ..shader = RadialGradient(
          colors: [
            TimelinePalette.glow.withValues(alpha: dim ? 0.10 : 0.17),
            TimelinePalette.glow.withValues(alpha: 0.0),
          ],
        ).createShader(Rect.fromCircle(center: glowCenter, radius: glowRadius)),
    );

    _paintStars(canvas, size);
  }

  void _paintStars(Canvas canvas, Size size) {
    final rnd = math.Random(seed);
    final total = dim ? 70 : 168;
    // 位移封顶：一口气退回二十份备份时，星星不该滚出画面外。
    final shift = (parallax.clamp(-24.0, 24.0)) * 1.0;

    for (final (share, factor, maxR) in _layers) {
      final count = (total * share).round();
      for (var i = 0; i < count; i++) {
        final x = rnd.nextDouble() * size.width;
        final y = rnd.nextDouble() * size.height;
        final r = 0.4 + rnd.nextDouble() * (maxR - 0.4);
        final a = 0.10 + rnd.nextDouble() * 0.55;

        // 纵向位移 + 轻微横向：只上下动会像在滚屏，加一点横移才像「穿过去」。
        final dy = shift * factor * 0.55;
        final dx = shift * factor * 0.12;
        final pos = Offset(
          (x + dx) % size.width,
          (y + dy + size.height) % size.height,
        );

        canvas.drawCircle(
          pos,
          r,
          Paint()..color = TimelinePalette.star.withValues(alpha: a),
        );
      }
    }

    // 少数几颗带光晕的亮星：没有它们，整片星空是均匀的噪点。
    final glowCount = dim ? 3 : 7;
    for (var i = 0; i < glowCount; i++) {
      final pos = Offset(
        rnd.nextDouble() * size.width,
        rnd.nextDouble() * size.height,
      );
      final r = 1.0 + rnd.nextDouble() * 1.2;
      canvas.drawCircle(
        pos,
        r * 3.2,
        Paint()
          ..color = TimelinePalette.star.withValues(alpha: 0.10)
          ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 3),
      );
      canvas.drawCircle(
        pos,
        r,
        Paint()..color = TimelinePalette.star.withValues(alpha: 0.85),
      );
    }
  }

  @override
  bool shouldRepaint(_StarPainter old) =>
      old.parallax != parallax || old.seed != seed || old.dim != dim;
}
