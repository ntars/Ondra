import 'package:material_ui/material_ui.dart';

import '../../../../../design/page_frame.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import 'status_source.dart';
import 'status_types.dart';
import '../../ondra-chat/ui/chat_client.dart';

/// 状态面板：空谷的数字生命监测。
///
/// 这一页的每条读数都来自本机真实文件：记忆库的几张表、会话目录、三份日志、
/// 备份目录，以及本机网关能不能连上。**没有一条是估的，也没有一条是演示数据**——
/// 状态面板最不该做的事，是拿一条好看的曲线掩盖「其实什么都没接上」。
///
/// 它同时是启动后的默认页：进门第一眼该看到的是「空谷现在怎么样」，
/// 而不是某个待办列表。
class StatusPage extends StatefulWidget {
  const StatusPage({super.key});

  @override
  State<StatusPage> createState() => _StatusPageState();
}

class _StatusPageState extends State<StatusPage> {
  StatusSnapshot? _snapshot;

  @override
  void initState() {
    super.initState();
    chatClient.addListener(_onChatChanged);
    _load();
  }

  @override
  void dispose() {
    chatClient.removeListener(_onChatChanged);
    super.dispose();
  }

  /// 统计变化发生在整轮回答结束之后。只听在线灯会让卡片停在聊天前。
  void _onChatChanged() {
    if (!chatClient.busy) _load();
  }

  Future<void> _load() async {
    final snapshot = await statusSnapshotLoader();
    if (!mounted) return;
    setState(() => _snapshot = snapshot);
  }

  /// 情绪的副标题：标签 + 时刻。标签可能为空，那就只写时刻。
  static String _emotionMeta(EmotionReading e) {
    String two(int v) => v.toString().padLeft(2, '0');
    final clock = '${two(e.at.hour)}:${two(e.at.minute)}';
    return e.label.isEmpty ? clock : '${e.label} · $clock';
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final snap = _snapshot;

    return OndraPage(
      tone: OndraPageTone.canvas,
      title: '状态面板',
      subtitle: '空谷的数字生命监测',
      actions: [
        AnimatedBuilder(
          animation: chatClient,
          builder: (context, _) => StatusLivePill(online: chatClient.connected),
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (snap != null && snap.note.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: _Pending(label: snap.note),
            ),
          _Overview(snapshot: snap),
          const SizedBox(height: 12),
          OndraPanel(
            title: '生命体征',
            meta: '此刻',
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Column(
              children: [
                if (snap == null)
                  const _Pending(label: '正在读数')
                else if (snap.metrics.isEmpty)
                  const _Pending(label: '还没有读数')
                else
                  for (final m in snap.metrics) _MetricRow(reading: m),
              ],
            ),
          ),
          const SizedBox(height: 12),
          OndraPanel(
            title: '情绪',
            // 「平静 · 22:01」一行说完：是什么情绪、什么时候的。
            // 正文里再重复一遍标签与时间，就等于一句话写两遍。
            meta: snap?.emotion == null
                ? '还没有落定'
                : _emotionMeta(snap!.emotion!),
            child: snap == null
                ? const _Pending(label: '正在读数')
                : snap.emotion == null
                ? const _NoEmotion()
                : _EmotionBody(reading: snap.emotion!),
          ),
          const SizedBox(height: 12),
          OndraPanel(
            title: '监测源',
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: Column(
              children: [
                if (snap == null)
                  const _Pending(label: '正在读数')
                else
                  for (var i = 0; i < snap.sources.length; i++)
                    _SourceRow(
                      source: snap.sources[i],
                      last: i == snap.sources.length - 1,
                    ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          OndraPanel(
            title: '内核装配',
            meta: snap == null
                ? ''
                : snap.bootClean
                ? '干净'
                : '${snap.bootErrors} 错误 · ${snap.bootWarnings} 警告',
            padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
            child: snap == null
                ? const _Pending(label: '正在读数')
                : snap.bootClean
                ? const _Pending(label: '本次启动没有降级项')
                : Column(
                    children: [
                      for (var i = 0; i < snap.bootIssues.length; i++)
                        _IssueRow(
                          issue: snap.bootIssues[i],
                          last: i == snap.bootIssues.length - 1,
                        ),
                    ],
                  ),
          ),
          const SizedBox(height: 12),
          Text(
            '读数来自本机记忆库、会话目录、日志与备份；'
            '接入状态跟随右栏对话内核，与所选模型提供商无关。',
            style: ondraText(10.5, color: s.ink25, height: 15 / 10.5),
          ),
        ],
      ),
    );
  }
}

/// 状态面板的取数入口。测试把它换成空实现，页面就能在 `fake_async` 里跑完
/// ——`initState` 里起子进程会让测试卡在「Timer is still pending」。
StatusSnapshotLoader statusSnapshotLoader = loadStatus;

typedef StatusSnapshotLoader = Future<StatusSnapshot> Function();

/// 表头接入状态与对话客户端保持一致。
class StatusLivePill extends StatelessWidget {
  const StatusLivePill({super.key, required this.online});

  final bool online;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      height: 24,
      padding: const EdgeInsets.symmetric(horizontal: 10),
      decoration: BoxDecoration(
        color: s.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: s.lineCard),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          OndraStatusDot(color: online ? OndraColor.accent : s.ink25, size: 6),
          const SizedBox(width: 6),
          Text(
            online ? '已接入' : '未接入',
            style: ondraText(11, color: online ? s.ink60 : s.ink45),
          ),
        ],
      ),
    );
  }
}

/// 第一屏的四个总数：记忆、对话、备份、插件。
///
/// 放在最前面是因为它回答的是「我这台机器上到底有多少东西」，
/// 而下面三块回答的是「它现在怎么样」。先有量，才有状态。
class _Overview extends StatelessWidget {
  const _Overview({required this.snapshot});

  final StatusSnapshot? snapshot;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final snap = snapshot;

    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      decoration: BoxDecoration(
        color: s.surface,
        borderRadius: BorderRadius.circular(OndraRadius.lg),
        border: Border.all(color: s.lineCard),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Num(value: snap == null ? '—' : '${snap.facts}', label: '条记忆'),
          _Num(value: snap == null ? '—' : '${snap.sessions}', label: '份对话'),
          _Num(value: snap == null ? '—' : '${snap.backupCount}', label: '份备份'),
          _Num(
            value: snap == null ? '—' : '${snap.plugins}',
            label: '个插件',
            last: true,
          ),
        ],
      ),
    );
  }
}

class _Num extends StatelessWidget {
  const _Num({required this.value, required this.label, this.last = false});

  final String value;
  final String label;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: ondraText(
              19,
              weight: 500,
              color: s.ink,
              height: 24 / 19,
            ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
          ),
          const SizedBox(height: 2),
          Text(
            label,
            style: ondraText(10.5, color: s.ink30, height: 14 / 10.5),
          ),
        ],
      ),
    );
  }
}

/// 一条指标：左名称右数值，下面一条 2px 轨道。
///
/// 轨道是实心的 4% 灰、不是虚线。虚线在界面语言里等于「这里还没画完」，
/// 而这条轨道是**成品**——它表达的是「有这条通道，现在走到这里」。
class _MetricRow extends StatelessWidget {
  const _MetricRow({required this.reading});

  final MetricReading reading;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final ratio = reading.ratio.clamp(0.0, 1.0);

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                reading.label,
                style: ondraText(
                  14,
                  weight: 500,
                  color: s.ink,
                  height: 20 / 14,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  reading.hint,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(12, color: s.ink40, height: 16 / 12),
                ),
              ),
              Text(
                reading.value ?? '—',
                style: ondraText(
                  13,
                  color: s.ink60,
                  height: 16 / 13,
                ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(1.5),
            child: SizedBox(
              height: 3,
              // Stack 里的非定位子组件拿不到紧约束，比例条必须自己算宽度：
              // 直接放 FractionallySizedBox 会收缩成 0 宽（这里踩过一次，
              // 表现是「轨道整条不见了」）。
              child: LayoutBuilder(
                builder: (context, c) => Stack(
                  children: [
                    // 底槽用 20% 黑而不是 `fill`：这一页的面板底是纯白，
                    // 4% 的 fill 在白上等于没有，轨道会只剩下一截深色而看不出全长。
                    Positioned.fill(child: ColoredBox(color: s.ink20)),
                    SizedBox(
                      width: c.maxWidth * ratio,
                      height: 3,
                      child: const ColoredBox(color: OndraColor.accent),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 情绪的第一份状态还没有。
///
/// 这句必须和「数据源没接上」分开说：情绪是靠对话真的被触动才产生的，
/// 没聊过就没有情绪——这不是故障，是这台机器还没被用过。
class _NoEmotion extends StatelessWidget {
  const _NoEmotion();

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      height: 96,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: s.interconnect,
        borderRadius: BorderRadius.circular(OndraRadius.md),
        border: Border.all(color: s.lineFaint),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text('情绪还没有第一次落定', style: ondraText(12, color: s.ink45)),
          const SizedBox(height: 3),
          Text(
            '需要在对话里真的被触动一次，它才会产生第一份状态',
            style: ondraText(11, color: s.ink30),
          ),
        ],
      ),
    );
  }
}

/// 情绪的两条轴：愉悦度（双极）与唤醒度（单极）。
///
/// 不画曲线：`emotion_state` 只有当前值，一份历史都没有。硬画一条线出来
/// 就是编数据，而这一页的整条原则是不编。
class _EmotionBody extends StatelessWidget {
  const _EmotionBody({required this.reading});

  final EmotionReading reading;

  @override
  Widget build(BuildContext context) {
    // -1..1 映射到 0..1：0.5 就是「不悲不喜」，双极轴的中点。
    final v = ((reading.valence + 1) / 2).clamp(0.0, 1.0);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Axis(
          label: '愉悦',
          ratio: v,
          left: '低落',
          right: '愉快',
          value: reading.valence.toStringAsFixed(2),
          showCenter: true,
        ),
        const SizedBox(height: 10),
        _Axis(
          label: '唤醒',
          ratio: reading.arousal.clamp(0.0, 1.0),
          left: '平静',
          right: '激动',
          value: reading.arousal.toStringAsFixed(2),
        ),
        const SizedBox(height: 14),
      ],
    );
  }
}

class _Axis extends StatelessWidget {
  const _Axis({
    required this.label,
    required this.ratio,
    required this.left,
    required this.right,
    required this.value,
    this.showCenter = false,
  });

  final String label;
  final double ratio;
  final String left;
  final String right;
  final String value;

  /// 双极轴在正中画一条竖线：没有它，读者会以为左边是 0。
  final bool showCenter;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            SizedBox(
              width: 30,
              child: Text(
                label,
                style: ondraText(11, color: s.ink40, height: 16 / 11),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(2),
                child: SizedBox(
                  height: 4,
                  // 同上：比例条要自己算宽度。刻度线用 Positioned 挂，
                  // 因为它只需要一个位置，不需要参与布局。
                  child: LayoutBuilder(
                    builder: (context, c) {
                      final center = c.maxWidth * 0.5;
                      final end = c.maxWidth * ratio;
                      // 双极轴从中心开始长：正负两个方向都读得出来。
                      // 从左端画到数值点的话，「0.20」和「0.80」会长得一样。
                      final left = showCenter
                          ? (center < end ? center : end)
                          : 0.0;
                      final width = showCenter ? (end - center).abs() : end;
                      return Stack(
                        children: [
                          Positioned.fill(child: ColoredBox(color: s.ink20)),
                          Positioned(
                            left: left,
                            top: 0,
                            bottom: 0,
                            width: width,
                            child: ColoredBox(
                              color: OndraColor.accent.withValues(alpha: 0.85),
                            ),
                          ),
                          // 基准线落在深色段上时必须还能看见，所以用白而不是墨色。
                          if (showCenter)
                            Positioned(
                              left: center,
                              top: 0,
                              bottom: 0,
                              child: Container(
                                width: 1,
                                color: Colors.white.withValues(alpha: 0.8),
                              ),
                            ),
                        ],
                      );
                    },
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(
              width: 26,
              child: Text(
                value,
                textAlign: TextAlign.right,
                style: ondraText(
                  11,
                  color: s.ink45,
                  height: 16 / 11,
                ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ),
          ],
        ),
        const SizedBox(height: 3),
        Padding(
          padding: const EdgeInsets.only(left: 38, right: 34),
          child: Row(
            children: [
              Text(
                left,
                style: ondraText(10, color: s.ink25, height: 13 / 10),
              ),
              const Spacer(),
              Text(
                right,
                style: ondraText(10, color: s.ink25, height: 13 / 10),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 内核装配里被降级的一项：级别圆点 + 插件名 + 那句原话。
///
/// 文案是内核自己写的（它最清楚自己在降级什么），界面只负责把它摆出来——
/// 在这里改写措辞等于替内核隐瞒。
class _IssueRow extends StatelessWidget {
  const _IssueRow({required this.issue, required this.last});

  final BootIssue issue;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: OndraStatusDot(
                  color: issue.isError ? s.ink : s.ink25,
                  size: 6,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      issue.scope,
                      style: ondraText(
                        12.5,
                        weight: 500,
                        color: s.ink,
                        height: 17 / 12.5,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      issue.message,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: ondraText(11, color: s.ink40, height: 15 / 11),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              // 不给固定宽的话，Expanded 的消息文本会把它挤到只剩一个字。
              SizedBox(
                width: 26,
                child: Text(
                  issue.isError ? '错误' : '降级',
                  textAlign: TextAlign.right,
                  style: ondraText(10.5, color: s.ink30, height: 15 / 10.5),
                ),
              ),
            ],
          ),
        ),
        if (!last) Divider(height: 1, thickness: 1, color: s.lineFaint),
      ],
    );
  }
}

/// 一条监测源：名称 + 说明 + 读数 + 最近时间，行间一条发丝线。
class _SourceRow extends StatelessWidget {
  const _SourceRow({required this.source, required this.last});

  final StatusSource source;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    // 日志源的 count 是字节数，写成「条」就是谎报，所以统一在这里换算。
    final value = source.count == 0
        ? '—'
        : source.unit == 'B'
        ? _bytes(source.count)
        : '${source.count}${source.unit}';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 10),
          child: Row(
            children: [
              OndraStatusDot(
                color: source.online ? OndraColor.accent : s.ink20,
                size: 6,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      source.label,
                      style: ondraText(14, color: s.ink, height: 20 / 14),
                    ),
                    Text(
                      source.lastAt == null
                          ? source.detail
                          : '${source.detail} · 最近 ${_ago(source.lastAt!)}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ondraText(11, color: s.ink40, height: 15 / 11),
                    ),
                  ],
                ),
              ),
              Text(value, style: ondraText(11, color: s.ink45)),
            ],
          ),
        ),
        // 最后一行的分隔线是多余的：卡片底边已经是一条线。
        if (!last) Divider(height: 1, thickness: 1, color: s.lineFaint),
      ],
    );
  }

  String _ago(DateTime at) {
    final diff = DateTime.now().difference(at);
    if (diff.inMinutes < 1) return '刚刚';
    if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
    if (diff.inHours < 24) return '${diff.inHours} 小时前';
    return '${diff.inDays} 天前';
  }

  String _bytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    final kb = bytes / 1024;
    if (kb < 1024) return '${kb.toStringAsFixed(0)} KB';
    return '${(kb / 1024).toStringAsFixed(1)} MB';
  }
}

class _Pending extends StatelessWidget {
  const _Pending({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Text(
        label,
        style: ondraText(12, color: s.ink30, height: 16 / 12),
      ),
    );
  }
}
