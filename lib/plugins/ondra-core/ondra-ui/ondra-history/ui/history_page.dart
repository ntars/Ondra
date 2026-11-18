import 'package:material_ui/material_ui.dart';

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
        transitionsBuilder: (_, animation, _, child) => FadeTransition(
          opacity: animation,
          child: child,
        ),
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
        onTap: () {},
        child: Container(
          width: 520,
          height: 460,
          decoration: BoxDecoration(
            color: s.surface,
            borderRadius: BorderRadius.circular(OndraRadius.modal),
            boxShadow: const [
              BoxShadow(color: Color(0x2E000000), blurRadius: 48, offset: Offset(0, 16)),
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
                    _loading
                        ? '~/.ondra/dsh/sessions'
                        : '在右栏说第一句话，会话就会出现在这里。',
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
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
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
                      style: ondraText(13, weight: 500, color: s.ink, height: 18 / 13),
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
          ],
        ],
      ),
    );
  }

  /// 副标题：什么时候 · 几句 · 哪个目录。
  /// 「几句」是**用户消息条数**，不是轮数也不是事件数——数错了就成了假信息。
  String _subtitleOf(SessionSummary item) {
    final parts = <String>[
      _when(item.updatedAt),
      '${item.messages} 句',
    ];
    final dir = item.cwd.split('/').where((s) => s.isNotEmpty).lastOrNull;
    if (dir != null && dir.isNotEmpty) parts.add(dir);
    return parts.join(' · ');
  }

  /// 今天 / 昨天给出时刻，更早给出日期：列表里最常看的是「刚刚那次」。
  static String _when(DateTime t) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(t.year, t.month, t.day);
    final hm = '${t.hour.toString().padLeft(2, '0')}:'
        '${t.minute.toString().padLeft(2, '0')}';
    if (day == today) return '今天 $hm';
    if (today.difference(day).inDays == 1) return '昨天 $hm';
    return '${t.month} 月 ${t.day} 日';
  }
}
