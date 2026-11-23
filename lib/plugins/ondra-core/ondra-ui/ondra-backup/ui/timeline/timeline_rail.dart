import 'package:material_ui/material_ui.dart';

import '../../../../../../design/tokens.dart';
import '../backup_model.dart';
import 'timeline_palette.dart';

/// 右侧的时间轴：一条竖线，从上到下是从现在到更早。
///
/// 刻度密密地排，但只有**日期分界**和**当前选中的那一刻**给文字——
/// 时间线里那条轴也是这样：位置靠密度表达，标签只标「这是哪天」。
/// 一行行都写上 `21:03` 只会让轴变成一张表格。
class TimelineRail extends StatelessWidget {
  const TimelineRail({
    super.key,
    required this.entries,
    required this.selected,
    required this.onSelect,
    this.width = 132,
    this.horizontal = false,
  });

  /// index 0 是「现在」，其余是新到旧的快照。
  final List<BackupSnapshot?> entries;

  final int selected;
  final ValueChanged<int> onSelect;
  final double width;

  /// 手机（<560dp）：竖排 132dp 的导轨没有生存空间（主区只剩 ~200），
  /// 改为横排滚动条放在主区上方，点按逻辑与竖排一致。
  final bool horizontal;

  @override
  Widget build(BuildContext context) {
    final items = _buildItems();
    if (horizontal) return _buildHorizontal(items);

    return SizedBox(
      width: width,
      child: LayoutBuilder(
        builder: (context, c) {
          final entryCount = items.where((i) => i.snapshotIndex != null).length;
          final headerCount = items.length - entryCount;
          final need = entryCount * 20.0 + headerCount * 22.0;
          final k = need > c.maxHeight && need > 0 ? c.maxHeight / need : 1.0;
          final entryH = (20.0 * k).clamp(12.0, 20.0);
          final headerH = (22.0 * k).clamp(12.0, 22.0);

          return Stack(
            children: [
              // 轴线画在点后面：点压在线上，读起来才是「轴上的刻度」。
              Positioned(
                left: 22,
                top: 8,
                bottom: 8,
                child: Container(width: 1, color: TimelinePalette.inkFaint),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final item in items)
                    item.snapshotIndex == null
                        ? SizedBox(
                            height: headerH,
                            child: Padding(
                              padding: const EdgeInsets.only(left: 34, top: 8),
                              child: Text(
                                item.header!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: ondraText(
                                  9.5,
                                  color: TimelinePalette.inkDim,
                                  height: 12 / 9.5,
                                  spacing: 0.4,
                                ),
                              ),
                            ),
                          )
                        : _HoverTick(
                            height: entryH,
                            label: item.label,
                            selected: item.snapshotIndex == selected,
                            onTap: () => onSelect(item.snapshotIndex!),
                          ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildHorizontal(List<_Item> items) {
    return SizedBox(
      height: 44,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        child: Row(
          children: [
            for (final item in items)
              item.snapshotIndex == null
                  ? Padding(
                      padding: const EdgeInsets.only(left: 12, right: 4),
                      child: Text(
                        item.header!,
                        maxLines: 1,
                        style: ondraText(
                          10,
                          color: TimelinePalette.inkDim,
                          height: 1,
                          spacing: 0.4,
                        ),
                      ),
                    )
                  : Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 3),
                      child: _HoverTick(
                        // 横排的命中块：44 宽 × 44 高（触控标准），
                        // 点与标签横着排。
                        height: 44,
                        label: item.label,
                        selected: item.snapshotIndex == selected,
                        onTap: () => onSelect(item.snapshotIndex!),
                        horizontal: true,
                      ),
                    ),
          ],
        ),
      ),
    );
  }

  /// 把「现在 + 每份快照」摊平成行，日期变化处插一个组头。
  List<_Item> _buildItems() {
    final out = <_Item>[];
    String? lastDay;
    for (var i = 0; i < entries.length; i++) {
      final snap = entries[i];
      if (snap == null) {
        out.add(_Item(snapshotIndex: i, label: '现在'));
        continue;
      }
      final day = backupDay(snap.createdAt);
      if (day != lastDay) {
        lastDay = day;
        out.add(_Item(header: day));
      }
      final t = snap.createdAt;
      out.add(
        _Item(snapshotIndex: i, label: '${_two(t.hour)}:${_two(t.minute)}'),
      );
    }
    return out;
  }
}

class _Item {
  const _Item({this.snapshotIndex, this.header, this.label = ''});

  /// null 表示这是一个日期组头。
  final int? snapshotIndex;
  final String? header;
  final String label;
}

class _HoverTick extends StatefulWidget {
  const _HoverTick({
    required this.height,
    required this.label,
    required this.selected,
    required this.onTap,
    this.horizontal = false,
  });

  final double height;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  /// 横排：点在左、标签在右，整块 44 宽起（触控标准）。
  final bool horizontal;

  @override
  State<_HoverTick> createState() => _HoverTickState();
}

class _HoverTickState extends State<_HoverTick> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final active = widget.selected || _hover;
    final dotSize = widget.selected ? 7.0 : 4.0;
    if (widget.horizontal) {
      // 横排 pill：整块 44×44 命中，点与 HH:MM 横排，选中态与竖排一致。
      return MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          child: Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: active
                  ? TimelinePalette.ink.withValues(alpha: 0.12)
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AnimatedContainer(
                  duration: const Duration(milliseconds: 140),
                  width: dotSize,
                  height: dotSize,
                  decoration: BoxDecoration(
                    color: widget.selected
                        ? Colors.white
                        : TimelinePalette.ink.withValues(
                            alpha: _hover ? 0.65 : 0.30,
                          ),
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 5),
                Text(
                  widget.label,
                  style:
                      ondraText(
                        widget.selected ? 11.5 : 11,
                        weight: widget.selected ? 500 : 330,
                        color: active
                            ? TimelinePalette.ink
                            : TimelinePalette.inkSoft,
                        height: 1,
                      ).copyWith(
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: Container(
          height: widget.height,
          color: Colors.transparent,
          child: Row(
            children: [
              SizedBox(
                width: 22,
                child: Center(
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 140),
                    width: dotSize,
                    height: dotSize,
                    decoration: BoxDecoration(
                      color: widget.selected
                          ? Colors.white
                          : TimelinePalette.ink.withValues(
                              alpha: _hover ? 0.65 : 0.30,
                            ),
                      shape: BoxShape.circle,
                      boxShadow: widget.selected
                          ? [
                              BoxShadow(
                                color: TimelinePalette.glow.withValues(
                                  alpha: 0.9,
                                ),
                                blurRadius: 8,
                              ),
                            ]
                          : null,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  widget.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style:
                      ondraText(
                        widget.selected ? 11.5 : 11,
                        weight: widget.selected ? 500 : 330,
                        color: active
                            ? TimelinePalette.ink
                            : TimelinePalette.inkSoft,
                        height: 15 / 11.5,
                      ).copyWith(
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

String _two(int v) => v < 10 ? '0$v' : '$v';
