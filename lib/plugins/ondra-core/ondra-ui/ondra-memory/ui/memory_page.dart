import 'dart:async';
import 'dart:math' as math;

import 'package:material_ui/material_ui.dart';

import 'memory_layout.dart';
import 'memory_model.dart';
import 'memory_source.dart';
import 'memory_types.dart';
import '../../../../../design/page_frame.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';

/// 取数入口。默认读本机记忆库；测试里换成空实现——
/// widget 测试跑在 fake_async 的时间轴上，在 `initState` 里起子进程会留下
/// 一个永不完成的定时器，整棵树销毁后测试框架会直接判失败。
typedef MemorySnapshotLoader = Future<MemorySnapshot> Function();

MemorySnapshotLoader memorySnapshotLoader = loadMemorySnapshot;

/// 记忆星图：把记忆点画成神经元，把关联画成突触。
///
/// 这不是一张装饰插画——节点位置、强度、关联都来自 `ondra-memory` 插件的投影。
/// 插件还没接上时（[ _points ] 为空）显示空态，**不拿演示数据把版式撑起来**：
/// 一张看起来热闹但没有真实来源的图，比一张空图更糟。三条交互：
/// - 悬停节点：高亮它和它的一阶邻居，其余压暗；
/// - 点击节点：下方详情条显示这条记忆的类别、强度、关联与最近回想；
/// - 空闲时：连线上有缓慢移动的脉冲。它是**氛围动画**，不是活动指示——
///   内核目前没有对外暴露「正在回想」的事件流，接上之前这里不冒充状态。
class MemoryPage extends StatefulWidget {
  const MemoryPage({
    super.key,
    this.refreshInterval = const Duration(seconds: 12),
  });

  /// 停留在本页时的重读间隔。默认 12 秒：够及时，又不会反复读库。
  final Duration refreshInterval;

  @override
  State<MemoryPage> createState() => _MemoryPageState();
}

class _MemoryPageState extends State<MemoryPage>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 12),
  )..repeat();

  Timer? _refreshTimer;

  /// 记忆点：从内核的 `memory_fact` / `memory_link` 读出来再排版，
  /// 坐标由 `memory_layout` 按 id 确定性算出，重绘不跳。
  List<MemoryPoint> _points = const <MemoryPoint>[];

  /// 读不到数据时的原因（库不存在 / 预览环境 / sqlite3 缺失）。
  /// 为空表示「读到了，只是真的没有记忆」。
  String? _note;

  int? _hovered;
  int _selected = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refreshTimer = Timer.periodic(widget.refreshInterval, (_) => _load());
    _load();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _load();
  }

  Future<void> _load() async {
    final snapshot = await memorySnapshotLoader();
    if (!mounted) return;
    setState(() {
      _points = layoutMemoryPoints(snapshot);
      _note = snapshot.note;
      // 选中项可能指向已经不存在的下标（记忆被归档后重读）。
      if (_selected >= _points.length) _selected = 0;
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _refreshTimer?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  /// 命中测试：取光标 12px 内最近的节点。
  int? _hitTest(Offset local, Size size) {
    final rect = _NeuronPainter.plotRect(size);
    int? best;
    var bestDistance = 14.0;
    for (var i = 0; i < _points.length; i++) {
      final p = _points[i];
      final d =
          (Offset(rect.left + p.x * rect.width, rect.top + p.y * rect.height) -
                  local)
              .distance;
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    return best;
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    if (_points.isEmpty) return _EmptyMemory(note: _note);

    final point = _points[_selected];

    return OndraPage(
      tone: OndraPageTone.canvas,
      title: '记忆星图',
      subtitle: '以神经元呈现的记忆点',
      scroll: false,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      actions: [
        Container(
          height: 24,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: s.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: s.lineFaint),
          ),
          child: Text(
            '${_points.length} 个记忆点',
            style: ondraText(11, color: s.ink45),
          ),
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: LayoutBuilder(
              builder: (context, constraints) {
                final size = Size(constraints.maxWidth, constraints.maxHeight);
                return MouseRegion(
                  cursor: _hovered == null
                      ? SystemMouseCursors.basic
                      : SystemMouseCursors.click,
                  onHover: (e) {
                    final hit = _hitTest(e.localPosition, size);
                    if (hit != _hovered) setState(() => _hovered = hit);
                  },
                  onExit: (_) {
                    if (_hovered != null) setState(() => _hovered = null);
                  },
                  child: GestureDetector(
                    onTapUp: (e) {
                      final hit = _hitTest(e.localPosition, size);
                      if (hit != null) setState(() => _selected = hit);
                    },
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(OndraRadius.xl),
                      child: Container(
                        decoration: BoxDecoration(
                          color: s.surface,
                          borderRadius: BorderRadius.circular(OndraRadius.xl),
                          border: Border.all(color: s.lineFaint),
                        ),
                        child: CustomPaint(
                          painter: _NeuronPainter(
                            points: _points,
                            phase: _pulse,
                            hovered: _hovered,
                            selected: _selected,
                            labelStyle: ondraText(11, color: s.ink80),
                            edgeColor: s.ink,
                          ),
                          size: Size.infinite,
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
          const SizedBox(height: 12),
          const _Legend(),
          const SizedBox(height: 12),
          _MemoryDetail(point: point, links: point.links.length),
        ],
      ),
    );
  }
}

class _Legend extends StatelessWidget {
  const _Legend();

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Wrap(
      spacing: 14,
      runSpacing: 6,
      children: [
        for (final kind in MemoryKind.values)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: kind.color,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
              Text(kind.label, style: ondraText(11, color: s.ink45)),
            ],
          ),
      ],
    );
  }
}

/// 详情条：选中记忆的名称、类别、强度、关联数与最近回想。
class _MemoryDetail extends StatelessWidget {
  const _MemoryDetail({required this.point, required this.links});

  final MemoryPoint point;
  final int links;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return OndraPanel(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Row(
        children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
              color: point.kind.color.withValues(alpha: 0.12),
              shape: BoxShape.circle,
            ),
            child: Center(
              child: Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: point.kind.color,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  point.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(
                    14,
                    weight: 500,
                    color: s.ink,
                    height: 20 / 14,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  '${point.kind.label} · 关联 $links 条 · 强度 ${(point.strength * 100).round()}%',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(11, color: s.ink45, height: 15 / 11),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '最近回想 ${point.recalledAt}',
            style: ondraText(11, color: s.ink30),
          ),
        ],
      ),
    );
  }
}

/// 神经元画布。
///
/// 三层：突触（连线）→ 脉冲（沿线移动的点）→ 节点（辉光 + 环 + 核）。
/// 悬停时，命中节点与它的一阶邻居保持原亮度，其余整体压到 25%。
class _NeuronPainter extends CustomPainter {
  _NeuronPainter({
    required this.points,
    required this.phase,
    required this.hovered,
    required this.selected,
    required this.labelStyle,
    required this.edgeColor,
  }) : super(repaint: phase);

  final List<MemoryPoint> points;
  final Animation<double> phase;
  final int? hovered;
  final int selected;
  final TextStyle labelStyle;

  /// 突触颜色。四类节点各有一档灰，但**连线统一用正文黑**——若跟着节点上色，
  /// 浅灰节点的线会淡到看不见，图的骨架就散了。
  final Color edgeColor;

  /// 画布内缩，给节点辉光与边缘标签留出空间。
  static Rect plotRect(Size size) => Offset.zero & size;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = plotRect(size).deflate(2);
    Offset at(int i) => Offset(
      rect.left + points[i].x * rect.width,
      rect.top + points[i].y * rect.height,
    );

    final int focus = hovered ?? selected;
    final neighbours = <int>{focus, ...points[focus].links};

    // 1) 突触
    var edge = 0;
    for (var i = 0; i < points.length; i++) {
      for (final j in points[i].links) {
        if (j <= i) continue;
        final a = at(i);
        final b = at(j);
        final strength = (points[i].strength + points[j].strength) / 2;
        final dim =
            hovered != null &&
            !(neighbours.contains(i) && neighbours.contains(j));
        final paint = Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 0.6 + strength * 0.9
          ..strokeCap = StrokeCap.round
          ..color = edgeColor.withValues(
            alpha: dim ? 0.04 : 0.08 + strength * 0.14,
          );
        final path = _synapse(a, b, edge);
        canvas.drawPath(path, paint);

        // 2) 脉冲
        if (!dim) {
          final t = (phase.value + edge * 0.137) % 1.0;
          final p = _pointOn(a, b, edge, t);
          canvas.drawCircle(
            p,
            1.7,
            Paint()..color = edgeColor.withValues(alpha: 0.45),
          );
        }
        edge++;
      }
    }

    // 3) 节点
    for (var i = 0; i < points.length; i++) {
      final p = points[i];
      final center = at(i);
      final dim = hovered != null && !neighbours.contains(i);
      final alpha = dim ? 0.25 : 1.0;
      final radius = 3.4 + p.strength * 3.4;

      canvas.drawCircle(
        center,
        radius * 3.2,
        Paint()
          ..shader = RadialGradient(
            colors: [
              p.kind.color.withValues(alpha: 0.18 * alpha),
              p.kind.color.withValues(alpha: 0),
            ],
          ).createShader(Rect.fromCircle(center: center, radius: radius * 3.2)),
      );

      if (i == selected || i == hovered) {
        canvas.drawCircle(
          center,
          radius + 5,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1
            ..color = p.kind.color.withValues(alpha: 0.35),
        );
      }

      canvas.drawCircle(
        center,
        radius,
        Paint()..color = p.kind.color.withValues(alpha: alpha),
      );
      canvas.drawCircle(
        center,
        radius * 0.42,
        Paint()..color = Colors.white.withValues(alpha: alpha),
      );
    }

    // 4) 标签：只给强记忆与当前聚焦的点，避免 480 宽的画布被文字塞满。
    for (var i = 0; i < points.length; i++) {
      final p = points[i];
      final show = i == hovered || i == selected || p.strength >= 0.83;
      if (!show) continue;
      final center = at(i);
      final dim = hovered != null && !neighbours.contains(i);
      final painter = TextPainter(
        text: TextSpan(
          text: p.label,
          style: labelStyle.copyWith(
            color: labelStyle.color!.withValues(alpha: dim ? 0.3 : 1),
          ),
        ),
        textDirection: TextDirection.ltr,
        maxLines: 1,
      )..layout();

      final toLeft = p.x > 0.7;
      var dx = toLeft ? center.dx - 9 - painter.width : center.dx + 9;
      dx = dx.clamp(4.0, size.width - painter.width - 4);
      var dy = center.dy - painter.height / 2;
      dy = dy.clamp(2.0, size.height - painter.height - 2);
      painter.paint(canvas, Offset(dx, dy));
    }
  }

  /// 突触不是直线：控制点沿法线偏移，弯曲量由边的序号决定（同一张图每次一样）。
  Path _synapse(Offset a, Offset b, int seed) {
    final mid = Offset((a.dx + b.dx) / 2, (a.dy + b.dy) / 2);
    final d = b - a;
    final normal = Offset(-d.dy, d.dx);
    final len = normal.distance == 0 ? 1.0 : normal.distance;
    final bend = (math.sin(seed * 1.7) * 0.10 + 0.04) * d.distance;
    final control = mid + normal / len * bend;
    return Path()
      ..moveTo(a.dx, a.dy)
      ..quadraticBezierTo(control.dx, control.dy, b.dx, b.dy);
  }

  Offset _pointOn(Offset a, Offset b, int seed, double t) {
    final mid = Offset((a.dx + b.dx) / 2, (a.dy + b.dy) / 2);
    final d = b - a;
    final normal = Offset(-d.dy, d.dx);
    final len = normal.distance == 0 ? 1.0 : normal.distance;
    final bend = (math.sin(seed * 1.7) * 0.10 + 0.04) * d.distance;
    final control = mid + normal / len * bend;
    final u = 1 - t;
    return a * (u * u) + control * (2 * u * t) + b * (t * t);
  }

  @override
  bool shouldRepaint(covariant _NeuronPainter oldDelegate) =>
      oldDelegate.hovered != hovered ||
      oldDelegate.selected != selected ||
      oldDelegate.phase != phase;
}

/// 还没有记忆点时的空态。
///
/// 不摆示例节点：星图一旦画出来，用户会以为那就是自己的记忆。
/// 空态只说明「记忆从哪来」，并留出将来接 `ondra-memory` 投影的位置。
class _EmptyMemory extends StatelessWidget {
  const _EmptyMemory({this.note});

  /// 为什么没有点。为空表示「读到了，确实还没有记忆」。
  final String? note;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    // 两种空态给的信息完全不同：一种是「你还没跟她说值得记住的事」，
    // 另一种是「这个环境压根读不到库」。混成一句话会让人以为插件坏了。
    final why = note;
    final title = why == null ? '还没有记忆点' : '读不到记忆';
    final body =
        why ??
        '对话里值得留下的东西会在这里长成节点。提炼由 memory-intake 在每轮'
            '结束时完成，写进内核的 memory_fact 表。';
    return OndraPage(
      tone: OndraPageTone.canvas,
      title: '记忆星图',
      subtitle: '以神经元呈现的记忆点',
      // 关掉滚动：空态要占满可视高度才能垂直居中，否则 Center 会缩在标题下面，
      // 下面留一大片白。
      scroll: false,
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              title,
              style: ondraText(13, color: s.ink60, height: 18 / 13),
            ),
            const SizedBox(height: 6),
            SizedBox(
              width: 300,
              child: Text(
                body,
                textAlign: TextAlign.center,
                style: ondraText(11, color: s.ink30, height: 17 / 11),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
