import 'package:material_ui/material_ui.dart';

import '../../ondra-settings/ui/settings_client.dart';
import 'log_source.dart';
import 'log_types.dart';
import '../../../../../design/page_frame.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import '../../ondra-settings/ui/settings_spec.dart';

/// 取数入口。默认读 `~/.ondra/logs`；测试里换成空实现——
/// 理由同记忆星图：在 fake_async 的时间轴上起子进程会留下悬空定时器。
typedef LogEntriesLoader = Future<List<LogEntry>> Function(
  LogKind kind, {
  int maxLines,
});

LogEntriesLoader logEntriesLoader = loadLogEntries;

/// 日志页：三类日志共用一套骨架，只有标题、副标与过滤后的条目不同。
///
/// 480 宽的内容区放不下「时间 + 级别 + 来源 + 正文」四列，所以时间压成
/// 52 宽的窄列、级别收成标题前的一个点、来源做成标题旁的小标签。
class LogPage extends StatefulWidget {
  const LogPage({super.key, required this.kind, this.loader, this.settings});

  final LogKind kind;
  final LogEntriesLoader? loader;
  final SettingsClient? settings;

  @override
  State<LogPage> createState() => _LogPageState();
}

class _LogPageState extends State<LogPage> {
  /// null 表示「全部」。
  LogLevel? _level;

  /// 日志条目：桌面端读 `~/.ondra/logs` 的尾部（三类各对应真实文件），
  /// 浏览器预览里读不到文件系统，如实为空。
  List<LogEntry> _all = const <LogEntry>[];

  /// 加载完成前不下「没有日志」的结论：那会让一个 200ms 的读取
  /// 看起来像「这里什么都没有」。
  bool _loaded = false;
  bool _loading = false;
  String? _error;
  int _generation = 0;
  late String _density;

  SettingsClient get _settings => widget.settings ?? settingsClient;

  @override
  void initState() {
    super.initState();
    _density = _settings.choice('logs.usageDetail');
    _settings.addListener(_settingsChanged);
    _load();
  }

  @override
  void didUpdateWidget(covariant LogPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldSettings = oldWidget.settings ?? settingsClient;
    if (oldSettings != _settings) {
      oldSettings.removeListener(_settingsChanged);
      _settings.addListener(_settingsChanged);
    }
    final density = _settings.choice('logs.usageDetail');
    if (oldWidget.kind != widget.kind ||
        oldWidget.loader != widget.loader ||
        density != _density) {
      _density = density;
      _all = const [];
      _loaded = false;
      _load();
    }
  }

  void _settingsChanged() {
    final density = _settings.choice('logs.usageDetail');
    if (density == _density) return;
    _density = density;
    _load();
  }

  @override
  void dispose() {
    _settings.removeListener(_settingsChanged);
    _generation++;
    super.dispose();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final entries = await (widget.loader ?? logEntriesLoader)(
        widget.kind,
        maxLines: _density == 'compact' ? 60 : 200,
      );
      if (!mounted || generation != _generation) return;
      setState(() => _all = entries);
    } catch (e) {
      if (!mounted || generation != _generation) return;
      setState(() => _error = '读取日志失败：$e');
    } finally {
      if (mounted && generation == _generation) {
        setState(() {
          _loaded = true;
          _loading = false;
        });
      }
    }
  }

  List<LogEntry> get _entries {
    if (_level == null) return _all;
    return _all.where((e) => e.level == _level).toList(growable: false);
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final entries = _entries;

    return OndraPage(
      title: widget.kind.title,
      subtitle: widget.kind.subtitle,
      actions: [TextButton(onPressed: _load, child: const Text('刷新'))],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              OndraTag(
                label: '全部',
                selected: _level == null,
                onTap: () => setState(() => _level = null),
              ),
              for (final level in LogLevel.values)
                OndraTag(
                  label: level.label,
                  selected: _level == level,
                  onTap: () => setState(() => _level = level),
                ),
            ],
          ),
          const SizedBox(height: 14),
          if (_loading && _loaded)
            Text('正在刷新…', style: ondraText(12, color: s.ink40)),
          if (_error != null)
            Text(_error!, style: ondraText(12, color: OndraColor.danger)),
          if (entries.isEmpty && _error == null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 48),
              child: Column(
                children: [
                  Text(
                    _loaded ? '没有匹配的日志' : '正在读取…',
                    style: ondraText(13, color: s.ink40),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    widget.kind.emptyHint,
                    style: ondraText(11, color: s.ink25),
                  ),
                ],
              ),
            )
          else
            for (var i = 0; i < entries.length; i++) ...[
              if (i > 0) OndraHairline(color: s.lineFaint),
              _LogRow(entry: entries[i]),
            ],
          const SizedBox(height: 18),
          // 性能与用量放日志页底部：它决定的是「日志里显示多少」，属于这一页
          // 的显示密度，不是全局偏好——按官方应用的口径，默认「详细」。
          _UsageBar(settings: _settings),
        ],
      ),
    );
  }
}

class _LogRow extends StatefulWidget {
  const _LogRow({required this.entry});

  final LogEntry entry;

  @override
  State<_LogRow> createState() => _LogRowState();
}

class _LogRowState extends State<_LogRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final e = widget.entry;

    return MouseRegion(
      cursor: SystemMouseCursors.basic,
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
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              // 58 是「10:24:31」在 11 号等宽数字下不折行的最小宽度；
              // 50 会让最后一位被挤到第二行。
              width: 58,
              child: Text(
                e.time,
                maxLines: 1,
                softWrap: false,
                // 等宽数字：时间列不抖，扫读时才顺。
                style: ondraText(
                  11,
                  color: s.ink40,
                  height: 18 / 11,
                ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      if (e.level != LogLevel.info) ...[
                        OndraStatusDot(color: e.level.color, size: 5),
                        const SizedBox(width: 6),
                      ],
                      Flexible(
                        child: Text(
                          e.title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ondraText(
                            13,
                            weight: e.level == LogLevel.error ? 600 : 500,
                            color: s.ink,
                            height: 18 / 13,
                          ),
                        ),
                      ),
                      if (e.tag != null) ...[
                        const SizedBox(width: 6),
                        _Tag(label: e.tag!),
                      ],
                    ],
                  ),
                  if (e.detail.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      e.detail,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: ondraText(12, color: s.ink60, height: 17 / 12),
                    ),
                  ],
                  TextButton(
                    onPressed: () => showDialog<void>(
                      context: context,
                      builder: (context) => AlertDialog(
                        title: const Text('日志全文'),
                        content: SizedBox(
                          width: 560,
                          child: SingleChildScrollView(
                            child: SelectableText(
                              '${e.time} · ${e.level.label}'
                              '${e.tag == null ? '' : ' · ${e.tag}'}\n\n'
                              '${e.title}${e.detail.isEmpty ? '' : '\n${e.detail}'}',
                            ),
                          ),
                        ),
                        actions: [
                          TextButton(
                            onPressed: () => Navigator.of(context).pop(),
                            child: const Text('关闭'),
                          ),
                        ],
                      ),
                    ),
                    child: const Text('查看全文'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      height: 18,
      padding: const EdgeInsets.symmetric(horizontal: 6),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: s.fill,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: ondraText(11, color: s.ink45, height: 18 / 11),
      ),
    );
  }
}

/// 日志页底部的「性能与用量」条：左侧说明，右侧两档分段。
class _UsageBar extends StatelessWidget {
  const _UsageBar({required this.settings});

  final SettingsClient settings;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final spec = ondraSettingSpec('logs.usageDetail');
    return AnimatedBuilder(
      animation: settings,
      builder: (context, _) {
        final current = settings.choice('logs.usageDetail');
        final index = spec.options.indexWhere((o) => o.value == current);
        return Padding(
          padding: const EdgeInsets.only(top: 10),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      spec.label,
                      style: ondraText(
                        12,
                        weight: 500,
                        color: s.ink80,
                        height: 16 / 12,
                      ),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      spec.description ?? '',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ondraText(11, color: s.ink40, height: 15 / 11),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              _UsageSegmented(
                value: index < 0 ? 1 : index,
                items: [for (final o in spec.options) o.label],
                onChanged: (i) =>
                    settings.set('logs.usageDetail', spec.options[i].value),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// 28 高的两档分段：轨道 6% 黑，选中项白底浮起（与全局分段控件同一手法）。
class _UsageSegmented extends StatelessWidget {
  const _UsageSegmented({
    required this.value,
    required this.items,
    required this.onChanged,
  });

  final int value;
  final List<String> items;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      height: 28,
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        color: s.fill,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < items.length; i++)
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                onTap: () => onChanged(i),
                child: Container(
                  height: 24,
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: i == value ? s.surface : Colors.transparent,
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(
                      color: i == value ? s.line : Colors.transparent,
                      width: 0.5,
                    ),
                  ),
                  child: Text(
                    items[i],
                    style: ondraText(
                      11,
                      weight: i == value ? 500 : 400,
                      color: i == value ? s.ink : s.ink60,
                      height: 15 / 11,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
