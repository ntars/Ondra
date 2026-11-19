import 'package:material_ui/material_ui.dart';
import 'package:ondra/app/desktop_picker.dart';

import '../../../../../design/dialog.dart';
import '../../../../../design/glyph.dart';
import '../../../../../design/page_frame.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import '../../ui/shell_state.dart';
import 'backup_actions.dart';
import 'backup_model.dart';
import 'timeline/star_field.dart';
import 'timeline/timeline_palette.dart';

/// 备份还原：本机快照的清单、容量，以及进「时间线」的那扇门。
///
/// 全部读写 `~/.ondra/backups`：快照是**内容寻址**的，每次备份只把变过的文件
/// 写进对象库，所以「十份备份」不等于「十倍空间」。页面上「去重节省」那个
/// 数字就是这条机制的直接读数，不是估算。
///
/// 这一页只做三件事：看现在存了多少、看/删某一份、进时间线去挑一个时刻。
/// 恢复动作本身放在时间线里——它天然属于那个空间。
class BackupPage extends StatefulWidget {
  const BackupPage({super.key});

  @override
  State<BackupPage> createState() => _BackupPageState();
}

class _BackupPageState extends State<BackupPage> {
  BackupOverview? _overview;
  bool _busy = false;
  String _message = '';
  bool _messageOk = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  /// 时间线关掉时重新读一遍。
  ///
  /// 恢复可以在时间线里完成，那里还会顺手存一份「恢复前」的底；不重读的话，
  /// 退出时间线看到的还是恢复之前那份列表——看起来像恢复没生效。
  bool _wasTimelineOpen = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final open = ShellScope.of(context).timelineOpen;
    if (_wasTimelineOpen && !open) _load();
    _wasTimelineOpen = open;
  }

  Future<void> _load() async {
    try {
      final overview = await backupOverviewLoader();
      if (mounted) setState(() => _overview = overview);
    } catch (e) {
      if (mounted) {
        setState(
          () => _overview = BackupOverview.empty.copyWithNote('读取备份失败：$e'),
        );
      }
    }
  }

  /// 所有动作都走这一个壳：先置忙、做完重新读一遍总览、把引擎的原文案显示出来。
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
      final overview = await backupOverviewLoader();
      if (mounted) setState(() => _overview = overview);
    } catch (e) {
      if (mounted) {
        setState(() {
          _message = '${_message.isEmpty ? '' : '$_message；'}操作或刷新失败：$e';
          _messageOk = false;
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<bool> _confirm(
    BackupSnapshot snapshot, {
    required bool deleting,
  }) async {
    return await OndraDialog.show<bool>(
          context,
          OndraDialog(
            title: deleting ? '删除这份备份？' : '恢复这份备份？',
            body:
                '${backupWhen(snapshot.createdAt)} · ${snapshot.fileCount} 个文件。'
                '${deleting ? '删除后不可撤销；不会删除当前数据。' : '将覆盖同名数据，快照外文件保留；恢复前会先存底。SQLite 恢复尚需维护模式，当前会拒绝。'}',
            actions: [
              const OndraDialogButton(label: '取消', value: false),
              OndraDialogButton(
                label: deleting ? '确认删除' : '确认恢复',
                value: true,
                filled: true,
                danger: true,
              ),
            ],
          ),
        ) ==
        true;
  }

  Future<void> _toggleAuto(bool value) async {
    final overview = _overview;
    if (overview == null) return;
    final next = overview.settings.copyWith(auto: value);
    // 先落盘再改界面：开关是「承诺」，不是「感觉」。写失败时界面不该先亮起来。
    await _run(() async {
      await backupSaveSettings(next);
      return const BackupOpResult(ok: true, message: '备份设置已保存。');
    });
  }

  Future<void> _cycleKeep() async {
    final overview = _overview;
    if (overview == null) return;
    const options = [12, 24, 48];
    final i = options.indexOf(overview.settings.keep);
    final next = overview.settings.copyWith(
      keep: options[(i + 1) % options.length],
    );
    await _run(() async {
      await backupSaveSettings(next);
      return const BackupOpResult(ok: true, message: '备份设置已保存。');
    });
  }

  Future<void> _export(String id) async {
    if (!DesktopPicker.supported) {
      OndraToast.show(context, '这台系统还没有接入文件选择面板', ok: false);
      return;
    }
    await _run(() async {
      final dir = await backupPickDirectory('选择要把这份备份导出到哪里');
      if (dir == null || !mounted) {
        return const BackupOpResult.failure('已取消导出。');
      }
      return backupExport(id, dir);
    });
  }

  Future<void> _import() async {
    if (!DesktopPicker.supported) {
      OndraToast.show(context, '这台系统还没有接入文件选择面板', ok: false);
      return;
    }
    await _run(() async {
      final dir = await backupPickDirectory('选择一份导出的备份目录');
      if (dir == null || !mounted) {
        return const BackupOpResult.failure('已取消导入。');
      }
      return backupImport(dir);
    });
  }

  void _openTimeline() => ShellScope.of(context).timelineOpen = true;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final overview = _overview;

    return OndraPage(
      title: '备份还原',
      subtitle: '本机快照，不上传云端',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _TimelineEntry(
            count: overview?.snapshots.length ?? 0,
            last: overview?.lastAt,
            onTap: _openTimeline,
          ),
          const SizedBox(height: 16),
          _StoragePanel(overview: overview),
          const SizedBox(height: 18),
          OndraSection(
            title: '自动备份',
            child: Column(
              children: [
                OndraSettingRow(
                  title: '定时存一份',
                  desc: overview == null
                      ? '读取中…'
                      : '每 ${overview.settings.intervalMinutes} 分钟；'
                            '应用不在运行时不会备份',
                  // 开关自己带命中区，这一行不再响应点击，免得点文字也翻。
                  action: OndraSwitch(
                    value: overview?.settings.auto ?? false,
                    onChanged: overview == null ? null : _toggleAuto,
                  ),
                  showDivider: true,
                ),
                OndraSettingRow(
                  title: '保留份数',
                  desc: '超出后从最旧的开始删；点一下在 12 / 24 / 48 之间切换',
                  value: '${overview?.settings.keep ?? 24} 份',
                  onTap: _cycleKeep,
                  showDivider: false,
                ),
              ],
            ),
          ),
          const SizedBox(height: 18),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Row(
              children: [
                Text(
                  '备份记录',
                  style: ondraText(
                    11,
                    weight: 600,
                    color: s.ink40,
                    height: 14 / 11,
                    spacing: 0.3,
                  ),
                ),
                const Spacer(),
                if (_busy)
                  Text(
                    '处理中…',
                    style: ondraText(11, color: s.ink30, height: 14 / 11),
                  ),
              ],
            ),
          ),
          if (_message.isNotEmpty) ...[
            _MessageStrip(text: _message, ok: _messageOk),
            const SizedBox(height: 6),
          ],
          ..._records(overview),
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: OndraSmallButton(
                  label: '立即备份',
                  height: 34,
                  onTap: _busy ? null : () => _run(backupCreate),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OndraSmallButton(
                  label: '打开备份目录',
                  filled: false,
                  height: 34,
                  onTap: () => _run(backupReveal),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          OndraSmallButton(
            label: '从目录导入一份备份',
            filled: false,
            height: 34,
            onTap: _busy ? null : _import,
          ),
          const SizedBox(height: 10),
          Text(
            '备份内容：人设与资料、记忆库、真实会话存档、模型目录、网页白名单、头像与偏好。'
            '不含插件代码、内核装配层与密钥。SQLite 使用一致性副本；恢复须接入暂停内核的维护流程，当前拒绝。',
            style: ondraText(10.5, color: s.ink25, height: 15 / 10.5),
          ),
        ],
      ),
    );
  }

  List<Widget> _records(BackupOverview? overview) {
    final s = OndraSkin.of(context);
    if (overview == null) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 32),
          child: Center(
            child: Text('正在读取快照…', style: ondraText(12, color: s.ink30)),
          ),
        ),
      ];
    }
    if (overview.snapshots.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 32),
          child: Column(
            children: [
              Text('还没有备份', style: ondraText(13, color: s.ink40)),
              const SizedBox(height: 4),
              Text(
                overview.note.isEmpty ? '快照写在本机，随时可以回滚；空谷不会上传。' : overview.note,
                textAlign: TextAlign.center,
                style: ondraText(11, color: s.ink25, height: 16 / 11),
              ),
            ],
          ),
        ),
      ];
    }

    final out = <Widget>[];
    for (var i = 0; i < overview.snapshots.length; i++) {
      if (i > 0) out.add(OndraHairline(color: s.lineFaint));
      out.add(
        _SnapshotRow(
          snapshot: overview.snapshots[i],
          busy: _busy,
          onRestore: () => _run(
            () => backupRestore(overview.snapshots[i].id),
            confirm: () => _confirm(overview.snapshots[i], deleting: false),
          ),
          onExport: () => _export(overview.snapshots[i].id),
          onDelete: () => _run(
            () => backupDelete(overview.snapshots[i].id),
            confirm: () => _confirm(overview.snapshots[i], deleting: true),
          ),
        ),
      );
    }
    return out;
  }
}

/// 进时间线的入口卡：一片小星空 + 三张退远的窗口。
///
/// 它先把「里面长什么样」交代清楚，再让人点进去——一个纯文字的「进入时间线」
/// 按钮不会让人期待一个星场。
class _TimelineEntry extends StatefulWidget {
  const _TimelineEntry({
    required this.count,
    required this.last,
    required this.onTap,
  });

  final int count;
  final DateTime? last;
  final VoidCallback onTap;

  @override
  State<_TimelineEntry> createState() => _TimelineEntryState();
}

class _TimelineEntryState extends State<_TimelineEntry> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
          height: 140,
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            color: TimelinePalette.voidTop,
            borderRadius: BorderRadius.circular(OndraRadius.xl),
            boxShadow: [
              BoxShadow(
                color: TimelinePalette.glow.withValues(
                  alpha: _hover ? 0.30 : 0.16,
                ),
                blurRadius: _hover ? 22 : 14,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Stack(
            children: [
              const Positioned.fill(
                child: OndraStarField(dim: true, parallax: 2),
              ),
              const Positioned(
                right: 10,
                top: 0,
                bottom: 0,
                width: 208,
                child: Stack(
                  alignment: Alignment.center,
                  children: [
                    _MiniWindow(scale: 0.88, dy: -22, opacity: 0.42),
                    _MiniWindow(scale: 0.94, dy: -11, opacity: 0.70),
                    _MiniWindow(scale: 1, dy: 0, opacity: 1, front: true),
                  ],
                ),
              ),
              Positioned(
                left: 16,
                top: 18,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
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
                    const SizedBox(height: 3),
                    SizedBox(
                      width: 168,
                      child: Text(
                        widget.count == 0
                            ? '还没有过去可看，先存一份'
                            : '${widget.count} 个时刻 · 最近 ${backupWhen(widget.last ?? DateTime.now())}',
                        style: ondraText(
                          10.5,
                          color: TimelinePalette.inkDim,
                          height: 15 / 10.5,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              Positioned(
                left: 16,
                bottom: 16,
                child: Container(
                  height: 26,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: Colors.white.withValues(alpha: _hover ? 0.18 : 0.10),
                    borderRadius: BorderRadius.circular(OndraRadius.md),
                    border: Border.all(
                      color: Colors.white.withValues(alpha: 0.16),
                    ),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        '进入时间线',
                        style: ondraText(
                          11,
                          weight: 500,
                          color: TimelinePalette.ink,
                          height: 15 / 11,
                        ),
                      ),
                      const SizedBox(width: 4),
                      const Glyph(
                        Glyphs.chevronRight,
                        size: 12,
                        color: TimelinePalette.ink,
                      ),
                    ],
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

/// 入口卡里的迷你窗口。
class _MiniWindow extends StatelessWidget {
  const _MiniWindow({
    required this.scale,
    required this.dy,
    required this.opacity,
    this.front = false,
  });

  final double scale;
  final double dy;
  final double opacity;
  final bool front;

  @override
  Widget build(BuildContext context) {
    return Transform.translate(
      offset: Offset(0, dy),
      child: Transform.scale(
        scale: scale,
        alignment: Alignment.bottomCenter,
        child: Opacity(
          opacity: opacity,
          child: Container(
            width: 178,
            height: 72,
            decoration: BoxDecoration(
              color: front
                  ? TimelinePalette.frontSurface
                  : TimelinePalette.ghostSurface,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(
                color: front
                    ? const Color(0x99FFFFFF)
                    : Colors.white.withValues(alpha: 0.24),
              ),
              boxShadow: front
                  ? [
                      BoxShadow(
                        color: TimelinePalette.glow.withValues(alpha: 0.40),
                        blurRadius: 16,
                      ),
                    ]
                  : null,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  height: 16,
                  padding: const EdgeInsets.symmetric(horizontal: 7),
                  child: Row(
                    children: [
                      for (var i = 0; i < 3; i++) ...[
                        if (i > 0) const SizedBox(width: 3),
                        Container(
                          width: 3.4,
                          height: 3.4,
                          decoration: BoxDecoration(
                            color: front
                                ? const Color(0x33000000)
                                : Colors.white.withValues(alpha: 0.22),
                            shape: BoxShape.circle,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(8, 2, 8, 0),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _MiniBar(
                          width: 78,
                          color: front ? const Color(0x1F000000) : null,
                        ),
                        const SizedBox(height: 5),
                        _MiniBar(
                          width: 120,
                          color: front ? const Color(0x14000000) : null,
                        ),
                        const SizedBox(height: 4),
                        _MiniBar(
                          width: 96,
                          color: front ? const Color(0x14000000) : null,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _MiniBar extends StatelessWidget {
  const _MiniBar({required this.width, this.color});

  final double width;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: 4,
      decoration: BoxDecoration(
        color: color ?? Colors.white.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(2),
      ),
    );
  }
}

/// 存储占用：一个数字、一条比例、一句换算。
class _StoragePanel extends StatelessWidget {
  const _StoragePanel({required this.overview});

  final BackupOverview? overview;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final o = overview;
    final stored = o?.storedBytes ?? 0;
    final source = o?.sourceBytes ?? 0;
    final saved = o?.savedBytes ?? 0;
    final ratio = source <= 0
        ? 0.0
        : (stored / source).clamp(0.02, 1.0).toDouble();

    return OndraPanel(
      title: '存储占用',
      meta: o == null
          ? '读取中…'
          : (o.snapshots.isEmpty ? '尚无快照' : '${o.snapshots.length} 份快照'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                backupBytes(stored),
                style: ondraText(
                  22,
                  weight: 600,
                  color: s.ink,
                  height: 28 / 22,
                ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
              ),
              const SizedBox(width: 6),
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  '实际占用',
                  style: ondraText(11, color: s.ink40, height: 14 / 11),
                ),
              ),
              const Spacer(),
              if (saved > 0)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text(
                    '去重省下 ${backupBytes(saved)}',
                    style: ondraText(11, color: s.ink45, height: 14 / 11),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(3),
            child: SizedBox(
              height: 6,
              // Stack 里的非定位子组件拿不到紧约束，比例条必须自己算宽度：
              // 这里量一次父宽，再按比例给一个实宽，不依赖 FractionallySizedBox。
              child: LayoutBuilder(
                builder: (context, c) => Stack(
                  children: [
                    Positioned.fill(child: ColoredBox(color: s.fill)),
                    SizedBox(
                      width: c.maxWidth * ratio,
                      height: 6,
                      child: const ColoredBox(color: OndraColor.accent),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            o == null
                ? '正在统计'
                : '原始 ${backupBytes(source)} 去重后 ${backupBytes(stored)}；'
                      '本机待备份 ${o.liveFiles} 个文件 · ${backupBytes(o.liveBytes)}',
            style: ondraText(11, color: s.ink40, height: 15 / 11),
          ),
        ],
      ),
    );
  }
}

class _MessageStrip extends StatelessWidget {
  const _MessageStrip({required this.text, required this.ok});

  final String text;
  final bool ok;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: s.fillFaint,
        borderRadius: BorderRadius.circular(OndraRadius.md),
        border: Border.all(color: s.lineFaint),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 5),
            child: OndraStatusDot(
              color: ok ? s.ink45 : OndraColor.danger,
              size: 5,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: ondraText(
                11.5,
                color: ok ? s.ink60 : OndraColor.danger,
                height: 16 / 11.5,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SnapshotRow extends StatefulWidget {
  const _SnapshotRow({
    required this.snapshot,
    required this.busy,
    required this.onRestore,
    required this.onExport,
    required this.onDelete,
  });

  final BackupSnapshot snapshot;
  final bool busy;
  final VoidCallback onRestore;
  final VoidCallback onExport;
  final VoidCallback onDelete;

  @override
  State<_SnapshotRow> createState() => _SnapshotRowState();
}

class _SnapshotRowState extends State<_SnapshotRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final b = widget.snapshot;

    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
        decoration: BoxDecoration(
          color: _hover ? s.fillHover : Colors.transparent,
          borderRadius: BorderRadius.circular(OndraRadius.md),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        backupWhen(b.createdAt),
                        style: ondraText(
                          13,
                          weight: 500,
                          color: s.ink,
                          height: 18 / 13,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Container(
                        height: 16,
                        padding: const EdgeInsets.symmetric(horizontal: 5),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: s.fill,
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          b.trigger.label,
                          style: ondraText(10, color: s.ink45, height: 16 / 10),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    '${b.fileCount} 个文件 · ${backupBytes(b.sourceBytes)}'
                    '${b.newFiles == 0 ? ' · 全部去重' : ' · 新增 ${backupBytes(b.newBytes)}'}',
                    style: ondraText(11, color: s.ink45, height: 15 / 11),
                  ),
                ],
              ),
            ),
            // 动作常显：备份是低频操作，藏在 hover 里等于让人猜。
            Row(
              children: [
                _RowAction(
                  label: '恢复',
                  enabled: !widget.busy,
                  primary: true,
                  onTap: widget.onRestore,
                ),
                _RowAction(
                  label: '导出',
                  enabled: !widget.busy,
                  onTap: widget.onExport,
                ),
                const SizedBox(width: 2),
                GlyphButton(
                  glyph: Glyphs.trash,
                  size: 24,
                  glyphSize: 14,
                  color: _hover ? OndraColor.ink45 : s.ink30,
                  tooltip: '删除这份备份',
                  onTap: widget.busy ? () {} : widget.onDelete,
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _RowAction extends StatelessWidget {
  const _RowAction({
    required this.label,
    required this.onTap,
    this.enabled = true,
    this.primary = false,
  });

  final String label;
  final VoidCallback onTap;
  final bool enabled;
  final bool primary;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: GestureDetector(
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 4),
          child: Text(
            label,
            style: ondraText(
              12,
              color: !enabled
                  ? s.ink20
                  : primary
                  ? OndraColor.accent
                  : s.ink45,
            ),
          ),
        ),
      ),
    );
  }
}
