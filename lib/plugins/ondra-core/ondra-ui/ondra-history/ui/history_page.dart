import 'package:material_ui/material_ui.dart';

import '../../../../../design/glyph.dart';
import '../../../../../design/page_frame.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import 'history_sessions.dart';

/// 历史对话：作为模块页时铺满内容槽，作为浮层时收成 520 宽的卡片。
///
/// 数据来自内核的会话库：每个会话一个目录，里面是 `session.v4.jsonl`
/// （追加写的 JSONL）。这一页只读——**会话的写入权在内核那边**，
/// 应用碰它就成了第二个真相来源。
class HistoryPage extends StatelessWidget {
  const HistoryPage({super.key});

  static Future<void> open(BuildContext context) {
    return Navigator.of(context).push(
      PageRouteBuilder<void>(
        opaque: false,
        barrierColor: Colors.black.withValues(alpha: 0.32),
        transitionDuration: const Duration(milliseconds: 160),
        pageBuilder: (_, _, _) => const _HistoryOverlay(),
        transitionsBuilder: (_, animation, _, child) =>
            FadeTransition(opacity: animation, child: child),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return const OndraPage(
      title: '历史对话',
      subtitle: '已保存的会话',
      scroll: false,
      child: _HistoryList(),
    );
  }
}

class _HistoryOverlay extends StatelessWidget {
  const _HistoryOverlay();

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Center(
      child: GestureDetector(
        // 拦住点在卡片上的那一下，别让它穿透到遮罩把浮层关掉。
        onTap: () {},
        child: Container(
          width: 520,
          height: 460,
          decoration: BoxDecoration(
            color: s.surface,
            borderRadius: BorderRadius.circular(OndraRadius.modal),
            boxShadow: const [
              BoxShadow(
                color: Color(0x2E000000),
                blurRadius: 48,
                offset: Offset(0, 16),
              ),
              BoxShadow(color: Color(0x2E000000), spreadRadius: 1),
            ],
          ),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 12, 8),
                child: Row(
                  children: [
                    Text(
                      '历史对话',
                      style: ondraText(15, weight: 500, color: s.ink),
                    ),
                    const Spacer(),
                    OndraIconButton(
                      icon: Icons.close,
                      tooltip: '关闭',
                      onTap: () => Navigator.of(context).maybePop(),
                    ),
                  ],
                ),
              ),
              OndraHairline(color: s.lineFaint),
              const Expanded(
                child: Padding(
                  padding: EdgeInsets.all(8),
                  child: _HistoryList(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HistoryList extends StatefulWidget {
  const _HistoryList();

  @override
  State<_HistoryList> createState() => _HistoryListState();
}

class _HistoryListState extends State<_HistoryList> {
  /// 会话列表：直接读内核落盘的会话库（`~/.ondra/dsh/sessions`）。
  /// 读不到就是空表——不摆「截图整理与重命名」这种演示标题。
  List<SessionSummary> _items = const [];
  bool _loading = true;

  /// 悬停到第几行；-1 表示没有。
  int _hover = -1;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final items = await readSessions();
    if (!mounted) return;
    setState(() {
      _items = items;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return OndraScroll(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (_items.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 48),
              child: Column(
                children: [
                  Text(
                    _loading ? '正在读会话库' : '还没有对话记录',
                    style: ondraText(13, color: s.ink40),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    _loading ? '~/.ondra/dsh/sessions' : '在右栏说第一句话，会话就会出现在这里。',
                    style: ondraText(11, color: s.ink25, height: 16 / 11),
                  ),
                ],
              ),
            ),
          for (var i = 0; i < _items.length; i++) ...[
            if (i > 0) OndraHairline(color: s.lineFaint),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              onEnter: (_) => setState(() => _hover = i),
              onExit: (_) => setState(() => _hover = -1),
              child: OndraPressable(
                onTap: () => _openSession(_items[i]),
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 10,
                  ),
                  decoration: BoxDecoration(
                    // 选中是 6% 灰底 + 加粗，不用颜色区分：单色界面里
                    // 「重」比「色」更稳，也不会和状态色打架。
                    color: _hover == i ? s.fillHover : Colors.transparent,
                    borderRadius: BorderRadius.circular(OndraRadius.md),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        _items[i].title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ondraText(
                          13,
                          weight: 500,
                          color: s.ink,
                          height: 18 / 13,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _subtitleOf(_items[i]),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ondraText(11, color: s.ink40, height: 15 / 11),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 打开一份会话的只读详情：按 id 从会话库里把正文读出来。
  ///
  /// 之前整行有 hover 高亮与点击光标、点了却没有任何反应——用户会以为
  /// 坏了。看历史是历史页的本职，读文件就够，不需要动右栏的活会话。
  Future<void> _openSession(SessionSummary item) async {
    final entries = await readSessionMessages(item.id);
    if (!mounted) return;
    await Navigator.of(context).push(
      PageRouteBuilder<void>(
        opaque: false,
        barrierColor: Colors.black.withValues(alpha: 0.32),
        transitionDuration: const Duration(milliseconds: 160),
        pageBuilder: (_, _, _) =>
            _SessionDetailOverlay(title: item.title, entries: entries),
        transitionsBuilder: (_, animation, _, child) =>
            FadeTransition(opacity: animation, child: child),
      ),
    );
  }

  /// 副标题：什么时候 · 几句 · 哪个目录。
  /// 「几句」是**用户消息条数**，不是轮数也不是事件数——数错了就成了假信息。
  String _subtitleOf(SessionSummary item) {
    final parts = <String>[_when(item.updatedAt), '${item.messages} 句'];
    // Windows 路径用反斜杠，只按 / 拆会把整条 `D:\示例\测试项目`
    // 当成目录名（alpha.10 审查第 19 项）——两种分隔符都拆。
    final dir = item.cwd
        .split(RegExp(r'[/\\]'))
        .where((s) => s.isNotEmpty)
        .lastOrNull;
    if (dir != null && dir.isNotEmpty) parts.add(dir);
    return parts.join(' · ');
  }

  /// 今天 / 昨天给出时刻，更早给出日期：列表里最常看的是「刚刚那次」。
  static String _when(DateTime t) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(t.year, t.month, t.day);
    final hm =
        '${t.hour.toString().padLeft(2, '0')}:'
        '${t.minute.toString().padLeft(2, '0')}';
    if (day == today) return '今天 $hm';
    if (today.difference(day).inDays == 1) return '昨天 $hm';
    return '${t.month} 月 ${t.day} 日';
  }
}

/// 一份会话的只读详情：520 宽的卡片，里面是按时间排的消息流。
class _SessionDetailOverlay extends StatelessWidget {
  const _SessionDetailOverlay({required this.title, required this.entries});

  final String title;
  final List<HistoryEntry> entries;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Center(
      child: GestureDetector(
        // 拦住点在卡片上的那一下，别让它穿透到遮罩把详情关掉。
        onTap: () {},
        child: Container(
          width: 520,
          height: 560,
          decoration: BoxDecoration(
            color: s.surface,
            borderRadius: BorderRadius.circular(OndraRadius.modal),
            boxShadow: const [
              BoxShadow(
                color: Color(0x2E000000),
                blurRadius: 48,
                offset: Offset(0, 16),
              ),
              BoxShadow(color: Color(0x2E000000), spreadRadius: 1),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 12, 12, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ondraText(
                              14,
                              weight: 500,
                              color: s.ink,
                              height: 20 / 14,
                            ),
                          ),
                          Text(
                            entries.isEmpty ? '' : '${entries.length} 条消息',
                            style: ondraText(
                              11,
                              color: s.ink40,
                              height: 15 / 11,
                            ),
                          ),
                        ],
                      ),
                    ),
                    OndraPressable(
                      radius: OndraRadius.pill,
                      onTap: () => Navigator.of(context).maybePop(),
                      child: Padding(
                        padding: const EdgeInsets.all(6),
                        child: Glyph(Glyphs.close, size: 16, color: s.ink40),
                      ),
                    ),
                  ],
                ),
              ),
              OndraHairline(color: s.lineFaint),
              Expanded(
                child: entries.isEmpty
                    ? Center(
                        child: Text(
                          '读不到这份会话的正文',
                          style: ondraText(12, color: s.ink40),
                        ),
                      )
                    : OndraScroll(
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              for (final e in entries) _EntryBubble(e: e),
                            ],
                          ),
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

/// 详情里的一条消息。用户靠左实底、助手靠左淡底——历史是回看，
/// 不复制聊天栏的左右对话版式，读起来更像一篇文章。
class _EntryBubble extends StatelessWidget {
  const _EntryBubble({required this.e});

  final HistoryEntry e;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final isUser = e.role == 'user';
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            isUser ? '你' : '空谷',
            style: ondraText(11, weight: 500, color: s.ink40, height: 14 / 11),
          ),
          const SizedBox(height: 4),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: isUser ? s.fillFaint : Colors.transparent,
              borderRadius: BorderRadius.circular(OndraRadius.md),
            ),
            child: Text(
              e.displayText,
              style: ondraText(12.5, color: s.ink85, height: 19 / 12.5),
            ),
          ),
        ],
      ),
    );
  }
}
