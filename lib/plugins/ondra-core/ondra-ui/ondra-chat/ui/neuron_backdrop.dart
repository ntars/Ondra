import 'dart:math' as math;

import 'package:material_ui/material_ui.dart';

import '../../../../../design/skin.dart';

/// 神经元背景：一层极淡的矢量网，压在右栏内容下面。
///
/// 为什么是「神经」而不是别的纹理：右栏是跟 TA 说话的地方，这个网表达的是
/// 「连线」与「节点」——知识被接起来的样子。它不该抢戏，所以：
/// - 线宽 0.7，颜色是正文色的 5.5%；
/// - 节点半径 1.4~2.6，**全部同色同亮度**，没有高亮、没有彩色。
///
/// 「全部同色」是刻意的：早先给两三个节点上了蓝，想让网看起来「活着」，
/// 结果那两个蓝点在满是灰的右栏里变成了视觉焦点——用户会先去数那两个点，
/// 而不是读 TA 的回答。背景的职责是退后，不是提供重音。
///
/// 用 `CustomPaint` 而不是 SVG 资源：这张图必须随栏宽/栏高伸展，
/// 固定 viewBox 的 SVG 拉起来会变形，而节点位置在 `paint` 里按尺寸算最干净。
class OndraNeuronBackdrop extends StatelessWidget {
  const OndraNeuronBackdrop({super.key, this.seed = 7});

  /// 固定种子：同一台机器、同一尺寸每次画出来都一样。
  /// 换种子会换一张网——调参时可以改，产品里不要动。
  final int seed;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return IgnorePointer(
      child: CustomPaint(
        painter: _NeuronPainter(
          // 线与节点都用「正文色的淡版」：压在白纸上是一层极淡的灰，
          // 换成任何强调色都会让右栏看起来像另一个应用的皮肤。
          line: s.ink.withValues(alpha: 0.055),
          node: s.ink.withValues(alpha: 0.10),
          seed: seed,
        ),
        size: Size.infinite,
      ),
    );
  }
}

class _NeuronPainter extends CustomPainter {
  _NeuronPainter({required this.line, required this.node, required this.seed});

  final Color line;
  final Color node;
  final int seed;

  /// 一屏画多少个节点。72 在 280×600 的右栏里大约每 48×48 有一个，
  /// 疏到看得出「网」，密到不像噪点。
  static const int _count = 72;

  /// 超过这个距离就不连线。设成 88 是为了让网有断口——
  /// 全连满会变成一张均匀的网格，那种「纹理感」反而假。
  static const double _linkDistance = 88;

  /// 节点半径上限。超过 3 就从「纹理」变成「图形」了，所以封在 2.6。
  static const double _maxRadius = 2.6;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final rnd = math.Random(seed);
    final pts = <Offset>[
      for (var i = 0; i < _count; i++)
        Offset(rnd.nextDouble() * size.width, rnd.nextDouble() * size.height),
    ];

    // 先连线后画点：点压在线上，节点才像「交汇处」而不是「线上的珠子」。
    final wire = Paint()
      ..color = line
      ..strokeWidth = 0.7
      ..style = PaintingStyle.stroke;
    for (var i = 0; i < pts.length; i++) {
      for (var j = i + 1; j < pts.length; j++) {
        final d = (pts[i] - pts[j]).distance;
        if (d > _linkDistance) continue;
        // 越远越淡：近邻是实线，远邻几乎看不见，网的密度就有了层次。
        wire.color = line.withValues(
          alpha: line.a * (1 - d / _linkDistance) * 1.4,
        );
        canvas.drawLine(pts[i], pts[j], wire);
      }
    }

    final dot = Paint()..color = node;
    for (final p in pts) {
      canvas.drawCircle(p, 1.4 + rnd.nextDouble() * (_maxRadius - 1.4), dot);
    }
  }

  @override
  bool shouldRepaint(_NeuronPainter old) =>
      old.seed != seed || old.line != line || old.node != node;
}
