import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/services.dart';
import 'package:material_ui/material_ui.dart';

import '../../../../../../design/dialog.dart';
import '../../../../../../design/glyph.dart';
import '../../../../../../design/motion.dart';
import '../../../../../../design/tokens.dart';
import '../backup_actions.dart';
import '../backup_model.dart';
import 'timeline_card.dart';
import 'star_field.dart';
import 'timeline_rail.dart';
import 'timeline_palette.dart';

/// 时间线：一整窗的星场，窗口从远到近堆叠，右侧一条时间轴。
///
/// 复刻的是**交互模型**，不是像素：
/// - 前方那扇窗是「被选中的那一刻」，白底、带一圈蓝光；
/// - 比它新的版本在身后一档档缩小、变暗、往上退；
/// - 右侧时间轴上滚轮 / 上下键穿梭，`⏎` 恢复，`esc` 退出；
/// - 恢复前自动存底，所以「恢复」这一步是可后悔的（见 `BackupEngine.restore`）。
///
/// 它不是 `Navigator` 里的一页：时间线会把整个窗口接管过来，包括左栏和
/// 右栏——壳层用 `timelineOpen` 把它铺在 Stack 最上层，退出就是回到原来
/// 那一页。这也是它不自己画关闭按钮之外的任何导航的原因。
class TimelineStage extends StatefulWidget {
  const TimelineStage({super.key, required this.onClose});

  final VoidCallback onClose;

  @override
  State<TimelineStage> createState() => _TimelineStageState();
}

class _TimelineStageState extends State<TimelineStage> {
  BackupOverview? _overview;

  /// 0 是「现在」，1 起是新到旧的快照。
  int _index = 0;

  bool _busy = false;
  String _message = '';
  bool _messageOk = true;

  /// 入场：从「原来的页面」切到星场。用透明度与一点点缩放，
  /// 不做位移——时间线的入口不是滑出来的，是「淡入另一个空间」。
  bool _entered = false;

  @override
  void initState() {
    super.initState();
    _load();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) setState(() => _entered = true);
    });
  }

  Future<void> _load() async {
    try {
      final overview = await backupOverviewLoader();
      if (!mounted) return;
      setState(() {
        _overview = overview;
        _index = _index.clamp(0, overview.snapshots.length);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _overview = BackupOverview.empty;
        _message = '读取备份失败：$e';
        _messageOk = false;
      });
    }
  }

  List<BackupSnapshot?> get _entries {
    final snaps = _overview?.snapshots ?? const <BackupSnapshot>[];
    return <BackupSnapshot?>[null, ...snaps];
  }

  BackupSnapshot? get _selected {
    final entries = _entries;
    if (_index < 0 || _index >= entries.length) return null;
    return entries[_index];
  }

  void _go(int delta) {
    if (_busy) return;
    final max = (_entries.length - 1).clamp(0, 1 << 30);
    final next = (_index + delta).clamp(0, max);
    if (next == _index) return;
    setState(() => _index = next);
  }

  void _onSignal(PointerSignalEvent event) {
    if (event is! PointerScrollEvent) return;
    final dy = event.scrollDelta.dy;
    if (dy == 0) return;
    _go(dy > 0 ? 1 : -1);
  }

  Future<void> _restore() async {
    if (_busy) return;
    final target = _selected;
    if (target == null) {
      setState(() {
        _message = '「现在」不是一份快照——右侧选一份过去的备份才能恢复。';
        _messageOk = false;
      });
      return;
    }
    await _run(
      () => backupRestore(target.id),
      confirm: () async =>
          await OndraDialog.show<bool>(
            context,
            OndraDialog(
              title: '恢复这份备份？',
              body:
                  '${backupWhen(target.createdAt)} · ${target.fileCount} 个文件。'
                  '将覆盖同名数据，快照外文件保留；恢复前会先存底。'
                  'SQLite 恢复尚需维护模式，当前会拒绝。',
              actions: const [
                OndraDialogButton(label: '取消', value: false),
                OndraDialogButton(
                  label: '确认恢复',
                  value: true,
                  filled: true,
                  danger: true,
                ),
              ],
            ),
          ) ==
          true,
    );
  }

  Future<void> _backupNow() => _run(() => backupCreate());

  Future<void> _run(
    Future<BackupOpResult> Function() action, {
    Future<bool> Function()? confirm,
  }) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = '';
    });
    try {
      if (confirm != null && !await confirm()) return;
      if (!mounted) return;
      final result = await action();
      if (!mounted) return;
      setState(() {
        _message = result.message;
        _messageOk = result.ok;
      });
      final fresh = await backupOverviewLoader();
      if (!mounted) return;
      setState(() {
        _overview = fresh;
        _index = result.ok ? 0 : _index.clamp(0, fresh.snapshots.length);
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _message = '${_message.isEmpty ? '' : '$_message；'}操作或刷新失败：$e';
        _messageOk = false;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      // 整窗接管：这一层吸掉所有指针事件，底下的页面不该在时间线开着时
      // 还能被点到。
      behavior: HitTestBehavior.opaque,
      onPointerSignal: _onSignal,
      child: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.escape): widget.onClose,
          const SingleActivator(LogicalKeyboardKey.arrowUp): () => _go(-1),
          const SingleActivator(LogicalKeyboardKey.arrowLeft): () => _go(-1),
          const SingleActivator(LogicalKeyboardKey.arrowDown): () => _go(1),
          const SingleActivator(LogicalKeyboardKey.arrowRight): () => _go(1),
          const SingleActivator(LogicalKeyboardKey.enter): () =>
              unawaited(_restore()),
        },
        child: Focus(
          autofocus: true,
          child: AnimatedOpacity(
            opacity: _entered ? 1 : 0,
            duration: const Duration(milliseconds: 240),
            curve: OndraMotion.decel,
            child: AnimatedScale(
              scale: _entered ? 1 : 0.985,
              duration: const Duration(milliseconds: 320),
              curve: OndraMotion.expo,
              child: _scene(context),
            ),
          ),
        ),
      ),
    );
  }

  Widget _scene(BuildContext context) {
    final overview = _overview;
    final entries = _entries;

    return Container(
      color: TimelinePalette.voidTop,
      child: Stack(
        children: [
          Positioned.fill(
            // 视差跟着选中的位置走：越往过去，星星越「远」地退开。
            child: OndraStarField(parallax: _index.toDouble()),
          ),
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _header(overview),
              // 手机（<560dp）：竖排 132dp 导轨会把主区压到 ~200dp，
              // 改成横排滚动条放在主区上方，点按逻辑一致。
              Expanded(
                child: MediaQuery.sizeOf(context).width < 560
                    ? Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          TimelineRail(
                            entries: entries,
                            selected: _index,
                            onSelect: (i) {
                              if (!_busy) setState(() => _index = i);
                            },
                            horizontal: true,
                          ),
                          Expanded(
                            child: overview == null
                                ? const _Loading()
                                : _stack(overview),
                          ),
                        ],
                      )
                    : Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Expanded(
                            child: overview == null
                                ? const _Loading()
                                : _stack(overview),
                          ),
                          Padding(
                            padding: const EdgeInsets.fromLTRB(0, 4, 18, 12),
                            child: TimelineRail(
                              entries: entries,
                              selected: _index,
                              onSelect: (i) {
                                if (!_busy) setState(() => _index = i);
                              },
                            ),
                          ),
                        ],
                      ),
              ),
              _footer(overview),
            ],
          ),
        ],
      ),
    );
  }

  Widget _header(BackupOverview? overview) {
    final count = overview?.snapshots.length ?? 0;
    final last = overview?.lastAt;
    final subtitle = overview == null
        ? '正在读取快照…'
        : count == 0
        ? '还没有快照——这一屏要有一份备份才有过去可看'
        : '共 $count 份快照 · 最近一次 ${last == null ? '—' : backupWhen(last)}';

    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 18, 10),
      child: Row(
        children: [
          _IconAction(
            glyph: Glyphs.chevronLeft,
            tooltip: '退出时间线（esc）',
            onTap: widget.onClose,
          ),
          const SizedBox(width: 6),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '时间线',
                style: ondraText(
                  14,
                  weight: 500,
                  color: TimelinePalette.ink,
                  height: 19 / 14,
                ),
              ),
              const SizedBox(height: 1),
              Text(
                subtitle,
                style: ondraText(
                  10.5,
                  color: TimelinePalette.inkDim,
                  height: 14 / 10.5,
                ),
              ),
            ],
          ),
          const Spacer(),
          _TextAction(
            label: _busy ? '请稍候…' : '备份现在',
            onTap: _busy ? null : () => unawaited(_backupNow()),
          ),
          const SizedBox(width: 8),
          _IconAction(
            glyph: Glyphs.close,
            tooltip: '退出（esc）',
            onTap: widget.onClose,
          ),
        ],
      ),
    );
  }

  /// 纵深堆叠：选中的在前，新的版本在身后一档档退远。
  Widget _stack(BackupOverview overview) {
    // 最多显示 6 层：再往后的影子缩到看不清，只会把画面糊成一团。
    final visible = math.min(_index, 5);

    return LayoutBuilder(
      builder: (context, c) {
        final cardW = math.min(660.0, c.maxWidth - 12);
        final cardH = math.min(300.0, c.maxHeight * 0.72);

        return Stack(
          alignment: Alignment.bottomCenter,
          clipBehavior: Clip.hardEdge,
          children: [
            // 从远到近画：近的压在上面。
            for (var d = visible; d >= 0; d--)
              _stackLayer(d, cardW, cardH, overview),
          ],
        );
      },
    );
  }

  Widget _stackLayer(
    int depth,
    double cardW,
    double cardH,
    BackupOverview overview,
  ) {
    final entryIndex = _index - depth;
    if (entryIndex < 0) return const SizedBox.shrink();
    final snapshot = _entries[entryIndex];

    // 每一档的位移是**递减**的：越远的层挤得越紧，透视才成立。
    // 等距排会让影子像一串等间距的卡片，不像退到远处的窗口。
    var dy = 0.0;
    for (var i = 1; i <= depth; i++) {
      dy += 40 / (1 + (i - 1) * 0.40);
    }
    final scale = math.max(0.66, 1 - 0.052 * depth);
    final opacity = math.max(0.07, 1 - 0.17 * depth);

    return AnimatedPositioned(
      // 该层离底边的高度：0 是贴底（前台），越大越靠上。
      // 底下留 10 是给底栏一条缝，卡片贴着底栏会把两者的边线粘在一起。
      duration: const Duration(milliseconds: 320),
      curve: OndraMotion.decel,
      left: 0,
      right: 0,
      bottom: 10 + dy,
      child: AnimatedOpacity(
        duration: const Duration(milliseconds: 320),
        opacity: opacity,
        child: AnimatedScale(
          duration: const Duration(milliseconds: 320),
          curve: OndraMotion.decel,
          scale: scale,
          // 缩放锚点在底边中点：卡片是「往上退」，不是整体缩小。
          alignment: Alignment.bottomCenter,
          child: Center(
            child: TimelineCard(
              snapshot: snapshot,
              overview: overview,
              width: cardW,
              height: cardH,
              focused: depth == 0,
            ),
          ),
        ),
      ),
    );
  }

  Widget _footer(BackupOverview? overview) {
    final selected = _selected;
    final canRestore = selected != null && !_busy;

    final hint = selected == null
        ? '现在 · ${overview?.liveFiles ?? 0} 个文件 · ${backupBytes(overview?.liveBytes ?? 0)}'
        : '${backupWhen(selected.createdAt)} · ${selected.trigger.label}备份 · '
              '${selected.fileCount} 个文件 · ${backupBytes(selected.sourceBytes)}';

    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 0, 18, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (_message.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                children: [
                  Container(
                    width: 5,
                    height: 5,
                    decoration: BoxDecoration(
                      color: _messageOk
                          ? TimelinePalette.glow
                          : OndraColor.warning,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _message,
                      maxLines: 2,
                      style: ondraText(
                        11.5,
                        color: _messageOk
                            ? TimelinePalette.inkSoft
                            : OndraColor.warning,
                        height: 16 / 11.5,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          Row(
            children: [
              Expanded(
                child: Text(
                  hint,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(
                    11,
                    color: TimelinePalette.inkDim,
                    height: 16 / 11,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Text(
                MediaQuery.sizeOf(context).width < 560
                    ? '滑动上方时间轴选择'
                    : '↑↓ 或滚轮切换 · ⏎ 恢复 · esc 退出',
                style: ondraText(
                  10,
                  color: TimelinePalette.inkFaint,
                  height: 14 / 10,
                ),
              ),
              const SizedBox(width: 16),
              _TextAction(label: '退出', onTap: widget.onClose),
              const SizedBox(width: 8),
              _PrimaryAction(
                label: _busy ? '正在恢复…' : (canRestore ? '恢复此备份' : '选一份过去的备份'),
                onTap: canRestore ? () => unawaited(_restore()) : null,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text(
        '正在读取快照…',
        style: ondraText(12, color: TimelinePalette.inkDim, height: 16 / 12),
      ),
    );
  }
}

/// 深色场景里的图标按钮：悬停铺一层 8% 白，而不是浅色皮肤的 4% 黑。
class _IconAction extends StatefulWidget {
  const _IconAction({
    required this.glyph,
    required this.onTap,
    required this.tooltip,
  });

  final String glyph;
  final VoidCallback onTap;
  final String tooltip;

  @override
  State<_IconAction> createState() => _IconActionState();
}

class _IconActionState extends State<_IconAction> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: widget.tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          child: AnimatedContainer(
            duration: OndraMotion.snap,
            width: 28,
            height: 28,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: _hover
                  ? Colors.white.withValues(alpha: 0.08)
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(OndraRadius.md),
            ),
            child: Glyph(
              widget.glyph,
              size: 16,
              color: _hover ? TimelinePalette.ink : TimelinePalette.inkSoft,
            ),
          ),
        ),
      ),
    );
  }
}

class _TextAction extends StatefulWidget {
  const _TextAction({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  State<_TextAction> createState() => _TextActionState();
}

class _TextActionState extends State<_TextAction> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: OndraMotion.snap,
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _hover && enabled
                ? Colors.white.withValues(alpha: 0.08)
                : Colors.transparent,
            borderRadius: BorderRadius.circular(OndraRadius.md),
          ),
          child: Text(
            widget.label,
            style: ondraText(
              12,
              weight: 500,
              color: enabled
                  ? TimelinePalette.inkSoft
                  : TimelinePalette.inkFaint,
              height: 16 / 12,
            ),
          ),
        ),
      ),
    );
  }
}

/// 主行动：白底深字。深色场景里的「主要」是白，不是黑。
class _PrimaryAction extends StatefulWidget {
  const _PrimaryAction({required this.label, required this.onTap});

  final String label;
  final VoidCallback? onTap;

  @override
  State<_PrimaryAction> createState() => _PrimaryActionState();
}

class _PrimaryActionState extends State<_PrimaryAction> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null;
    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: OndraMotion.snap,
          curve: OndraMotion.expo,
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 16),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: enabled
                ? (_hover ? Colors.white : const Color(0xFFEDF1F8))
                : Colors.white.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(OndraRadius.md),
            boxShadow: enabled
                ? [
                    BoxShadow(
                      color: TimelinePalette.glow.withValues(alpha: 0.35),
                      blurRadius: 18,
                      offset: const Offset(0, 4),
                    ),
                  ]
                : null,
          ),
          child: Text(
            widget.label,
            style: ondraText(
              12,
              weight: 600,
              color: enabled
                  ? const Color(0xFF0B101B)
                  : TimelinePalette.inkFaint,
              height: 16 / 12,
            ),
          ),
        ),
      ),
    );
  }
}
