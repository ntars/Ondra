import 'dart:math' as math;

import 'package:material_ui/material_ui.dart';

import '../../../../../../design/tokens.dart';
import '../backup_model.dart';
import '../snapshot_summary.dart';
import 'timeline_palette.dart';

/// 时间线里的一扇「窗口」：某一份快照的内容。
///
/// 被选中的那一份是**白的**：时间线里前方那扇窗代表「真实存在过的那一刻」，
/// 身后的所有版本都是它的影子——影子只需要轮廓，所以 [focused] 为 false 时
/// 里面的文字全部换成灰条，谁也不该去读一份影子的细节。
class TimelineCard extends StatelessWidget {
  const TimelineCard({
    super.key,
    required this.snapshot,
    required this.overview,
    required this.width,
    required this.height,
    this.focused = true,
  });

  /// null 表示「现在」——这一档不入库，只是此刻的状态。
  final BackupSnapshot? snapshot;

  final BackupOverview overview;
  final double width;
  final double height;
  final bool focused;

  bool get _isNow => snapshot == null;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      height: height,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: focused ? TimelinePalette.frontSurface : TimelinePalette.ghostSurface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: focused
                ? (_isNow ? TimelinePalette.nowEdge : const Color(0x99FFFFFF))
                : TimelinePalette.ghostLine,
          ),
          boxShadow: focused
              ? [
                  // 辉光不是装饰：它标出「你现在看到的是哪一份」，
                  // 而身后的影子再暗也不会被误认成焦点。
                  BoxShadow(
                    color: TimelinePalette.glow.withValues(alpha: 0.34),
                    blurRadius: 34,
                    spreadRadius: 1,
                  ),
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.45),
                    blurRadius: 26,
                    offset: const Offset(0, 10),
                  ),
                ]
              : [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.35),
                    blurRadius: 18,
                    offset: const Offset(0, 6),
                  ),
                ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(10),
          child: focused ? _FrontBody(card: this) : _GhostBody(isNow: _isNow),
        ),
      ),
    );
  }

  /// 窗口标题：日期或「现在」。
  String get title {
    final snap = snapshot;
    if (snap == null) return '现在';
    return backupWhen(snap.createdAt);
  }

  String get tag => snapshot?.trigger.label ?? '当前状态';
}

/// 灰条：影子窗口里的骨架线。
class _Bar extends StatelessWidget {
  const _Bar({required this.width, this.height = 7, this.opacity = 0.10});

  final double width;
  final double height;
  final double opacity;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: TimelinePalette.ink.withValues(alpha: opacity),
        borderRadius: BorderRadius.circular(height / 2),
      ),
    );
  }
}

class _TrafficDots extends StatelessWidget {
  const _TrafficDots();

  @override
  Widget build(BuildContext context) {
    // 中性的三颗点：它在这里是「一扇窗口」的记号，不是可以点的红绿灯。
    return Row(
      children: [
        for (var i = 0; i < 3; i++) ...[
          if (i > 0) const SizedBox(width: 5),
          Container(
            width: 8,
            height: 8,
            decoration: BoxDecoration(
              color: Colors.black.withValues(alpha: 0.18),
              shape: BoxShape.circle,
            ),
          ),
        ],
      ],
    );
  }
}

/// 影子窗口：只有标题条与几根灰条。
class _GhostBody extends StatelessWidget {
  const _GhostBody({required this.isNow});

  final bool isNow;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          height: 34,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          alignment: Alignment.centerLeft,
          child: Row(
            children: [
              for (var i = 0; i < 3; i++) ...[
                if (i > 0) const SizedBox(width: 5),
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: TimelinePalette.ink.withValues(alpha: 0.16),
                    shape: BoxShape.circle,
                  ),
                ),
              ],
              const SizedBox(width: 12),
              _Bar(width: isNow ? 44 : 86, height: 8, opacity: 0.14),
            ],
          ),
        ),
        const Divider(height: 1, thickness: 1, color: TimelinePalette.ghostLine),
        const Expanded(
          child: Padding(
            padding: EdgeInsets.fromLTRB(18, 18, 18, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _Bar(width: 220, height: 9, opacity: 0.13),
                SizedBox(height: 10),
                _Bar(width: 300, height: 7, opacity: 0.08),
                SizedBox(height: 8),
                _Bar(width: 260, height: 7, opacity: 0.08),
                SizedBox(height: 8),
                _Bar(width: 180, height: 7, opacity: 0.06),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// 前景窗口：真的把这份快照的内容读出来。
class _FrontBody extends StatelessWidget {
  const _FrontBody({required this.card});

  final TimelineCard card;

  @override
  Widget build(BuildContext context) {
    final snap = card.snapshot;
    final isNow = snap == null;
    final groups = snap == null ? const <SnapshotGroup>[] : summarizeSnapshot(snap);
    final files = snap?.fileCount ?? card.overview.liveFiles;
    final bytes = snap?.sourceBytes ?? card.overview.liveBytes;

    // 版面按卡高分配：先给分组几行，剩下的给文件清单。
    // 分组是「有哪些类别」，文件是「具体带走了什么」——前者回答有没有，
    // 后者回答是不是我那一份，两个都需要，且卡片高度是给定的。
    final contentH = card.height - 122;
    final groupRows = math.min(groups.length, 4);
    final fileBudget = contentH - groupRows * 23 - 24;
    final fileRows = math.max(0, fileBudget ~/ 18).clamp(0, 6).toInt();
    final listed = snap == null
        ? const <BackupFileEntry>[]
        : ([...snap.files]..sort((a, b) => b.size.compareTo(a.size)))
              .take(fileRows)
              .toList(growable: false);
    final newStat = snap == null
        ? const _Stat(value: '不入库', label: '此刻状态')
        : _Stat(
            value: snap.newBytes == 0 ? '0' : backupBytes(snap.newBytes),
            label: snap.newBytes == 0 ? '本次新增（全部去重）' : '本次新增',
          );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          height: 36,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: Row(
            children: [
              const _TrafficDots(),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  card.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(
                    13,
                    weight: 500,
                    color: OndraColor.ink,
                    height: 18 / 13,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              _Tag(label: card.tag, isNow: isNow),
            ],
          ),
        ),
        const Divider(height: 1, thickness: 1, color: TimelinePalette.frontLine),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
          child: Row(
            children: [
              _Stat(value: '$files', label: '个文件'),
              const SizedBox(width: 22),
              _Stat(value: backupBytes(bytes), label: '总大小'),
              const SizedBox(width: 22),
              newStat,
            ],
          ),
        ),
        const Divider(height: 1, thickness: 1, color: TimelinePalette.frontLine),
        Expanded(
          child: isNow
              ? const _NowHint()
              : Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final g in groups.take(groupRows))
                        _GroupRow(group: g, maxBytes: _maxBytes(groups)),
                      if (listed.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Padding(
                          padding: const EdgeInsets.only(bottom: 2),
                          child: Text(
                            '文件',
                            style: ondraText(
                              9.5,
                              color: const Color(0x66000000),
                              height: 13 / 9.5,
                              spacing: 0.4,
                            ),
                          ),
                        ),
                        for (final f in listed) _FileRow(entry: f),
                      ],
                    ],
                  ),
                ),
        ),
        Container(
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          alignment: Alignment.centerLeft,
          child: Text(
            isNow
                ? '这一刻还没有存成快照'
                : '恢复会覆盖上面这些路径；快照里没有的文件会保留，不会被删',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: ondraText(10.5, color: const Color(0x8A000000), height: 14 / 10.5),
          ),
        ),
      ],
    );
  }

  int _maxBytes(List<SnapshotGroup> groups) {
    var max = 0;
    for (final g in groups) {
      if (g.bytes > max) max = g.bytes;
    }
    return max == 0 ? 1 : max;
  }
}

class _NowHint extends StatelessWidget {
  const _NowHint();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.fromLTRB(16, 14, 16, 0),
      child: Text(
        '现在不是一份快照——它是本机此刻的样子。\n'
        '要回到过去，在右侧时间轴上选一份；要留住此刻，先按「备份现在」。',
        style: TextStyle(
          fontFamily: ondraFontFamily,
          fontFamilyFallback: ondraFontFallback,
          fontSize: 11.5,
          height: 19 / 11.5,
          color: Color(0x73000000),
        ),
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag({required this.label, required this.isNow});

  final String label;
  final bool isNow;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 18,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: isNow
            ? const Color(0x0F000000)
            : TimelinePalette.glow.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: ondraText(
          10,
          color: isNow ? const Color(0x73000000) : const Color(0xFF1F5FD0),
          height: 14 / 10,
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.label});

  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          value,
          maxLines: 1,
          style: ondraText(
            15,
            weight: 500,
            color: OndraColor.ink,
            height: 20 / 15,
          ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
        ),
        const SizedBox(height: 1),
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: ondraText(10, color: const Color(0x73000000), height: 13 / 10),
        ),
      ],
    );
  }
}

/// 一条文件：路径 + 大小。路径是相对 `~/.ondra` 的，所以读起来就是
/// 「这份备份里到底有哪些东西」，不需要再点开一层。
class _FileRow extends StatelessWidget {
  const _FileRow({required this.entry});

  final BackupFileEntry entry;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 18,
      child: Row(
        children: [
          Expanded(
            child: Text(
              entry.path,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: ondraText(10.5, color: const Color(0x8A000000), height: 14 / 10.5),
            ),
          ),
          const SizedBox(width: 10),
          SizedBox(
            width: 62,
            child: Text(
              backupBytes(entry.size),
              textAlign: TextAlign.right,
              maxLines: 1,
              style: ondraText(10.5, color: const Color(0x66000000), height: 14 / 10.5)
                  .copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
            ),
          ),
        ],
      ),
    );
  }
}

class _GroupRow extends StatelessWidget {
  const _GroupRow({required this.group, required this.maxBytes});

  final SnapshotGroup group;
  final int maxBytes;

  @override
  Widget build(BuildContext context) {
    final share = math.max(0.03, group.bytes / maxBytes);
    return SizedBox(
      height: 23,
      child: Row(
        children: [
          SizedBox(
            width: 92,
            child: Text(
              group.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: ondraText(11.5, color: const Color(0xC7000000), height: 16 / 11.5),
            ),
          ),
          Expanded(
            child: Align(
              alignment: Alignment.centerLeft,
              child: FractionallySizedBox(
                widthFactor: share.toDouble(),
                child: Container(
                  height: 4,
                  decoration: BoxDecoration(
                    color: const Color(0x1F000000),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          SizedBox(
            width: 52,
            child: Text(
              '${group.files} 个',
              textAlign: TextAlign.right,
              maxLines: 1,
              style: ondraText(10.5, color: const Color(0x73000000), height: 16 / 10.5)
                  .copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
            ),
          ),
          SizedBox(
            width: 62,
            child: Text(
              backupBytes(group.bytes),
              textAlign: TextAlign.right,
              maxLines: 1,
              style: ondraText(10.5, color: const Color(0x73000000), height: 16 / 10.5)
                  .copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
            ),
          ),
        ],
      ),
    );
  }
}
