import 'package:material_ui/material_ui.dart';

import '../../../../../design/form_factor.dart';
import '../../../../../design/glyph.dart';
import '../../../../../design/page_frame.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';

/// 使用教程：把「这应用到底怎么用」写成一页可展开的短问答。
///
/// 不做外链、不做分步引导：空谷的主界面只有三栏，用户真正会卡的只有
/// 「右栏是干什么的」「记忆从哪来」「数据在哪」这三个问题，一页说清即可。
class GuidePage extends StatefulWidget {
  const GuidePage({super.key});

  @override
  State<GuidePage> createState() => _GuidePageState();
}

class _GuidePageState extends State<GuidePage> {
  /// 只允许展开一条：多条同时展开会把整页拉成一堵墙，反而更难找。
  int? _open = 0;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);

    return OndraPage(
      title: '使用教程',
      subtitle: '三分钟看完，知道空谷怎么用',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var i = 0; i < _currentTopics.length; i++) ...[
            if (i > 0) OndraHairline(color: s.lineFaint),
            _TopicRow(
              topic: _currentTopics[i],
              index: i,
              open: _open == i,
              onTap: () => setState(() => _open = _open == i ? null : i),
            ),
          ],
          const SizedBox(height: 20),
          Text(
            '还有没说清的？设置 → 问题反馈里写给我们。',
            style: ondraText(11, color: s.ink30, height: 16 / 11),
          ),
        ],
      ),
    );
  }
}

class _TopicRow extends StatefulWidget {
  const _TopicRow({
    required this.topic,
    required this.index,
    required this.open,
    required this.onTap,
  });

  final _Topic topic;
  final int index;
  final bool open;
  final VoidCallback onTap;

  @override
  State<_TopicRow> createState() => _TopicRowState();
}

class _TopicRowState extends State<_TopicRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final t = widget.topic;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          padding: const EdgeInsets.fromLTRB(8, 10, 8, 10),
          decoration: BoxDecoration(
            color: widget.open
                ? s.fillFaint
                : (_hover ? s.fillHover : Colors.transparent),
            borderRadius: BorderRadius.circular(OndraRadius.md),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  SizedBox(
                    width: 20,
                    child: Text(
                      '${widget.index + 1}',
                      style: ondraText(12, color: s.ink25, height: 18 / 12)
                          .copyWith(
                            fontFeatures: const [FontFeature.tabularFigures()],
                          ),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      t.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ondraText(
                        13,
                        weight: 500,
                        color: s.ink,
                        height: 18 / 13,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Glyph(
                    widget.open ? Glyphs.chevronDown : Glyphs.chevronRight,
                    size: 16,
                    color: s.ink25,
                  ),
                ],
              ),
              // 展开用 AnimatedSize：高度变化是这段交互唯一需要动的地方，
              // 不做淡入，文字在动的时候不该同时变虚。
              AnimatedSize(
                duration: const Duration(milliseconds: 160),
                curve: Curves.easeOut,
                alignment: Alignment.topCenter,
                child: widget.open
                    ? Padding(
                        padding: const EdgeInsets.only(
                          left: 20,
                          top: 6,
                          right: 24,
                        ),
                        child: Text(
                          t.body,
                          style: ondraText(12, color: s.ink60, height: 19 / 12),
                        ),
                      )
                    : const SizedBox(width: double.infinity),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Topic {
  const _Topic({required this.title, required this.body});

  final String title;
  final String body;
}

/// 桌面讲三栏，手机讲单列+抽屉——同一页两套文案，按形态取。
List<_Topic> get _currentTopics =>
    ondraIsMobile ? _topicsMobile : _topicsDesktop;

const List<_Topic> _topicsDesktop = [
  _Topic(
    title: '三栏分别是什么',
    body:
        '左栏是目录与入口，中栏是当前这一项的内容，右栏是跟 TA 说话的地方。'
        '右栏可以随时折叠，折叠后中栏会变宽；左栏收起时，左上角会出现一颗圆角按钮把它拉回来。',
  ),
  _Topic(
    title: '怎么开始一次对话',
    body:
        '直接在右栏底部输入，回车发送。对话与「记忆」是两件事：聊天记录留在历史对话里，'
        '值得长期记住的东西才会沉成记忆点。',
  ),
  _Topic(
    title: '记忆是怎么形成的',
    body:
        '你说过的偏好、定下来的事，会被写成记忆点；反复出现的做法会沉成偏好。'
        '记忆星图把它们画成一张网，越常一起出现的东西，连线越粗。',
  ),
  _Topic(
    title: '插件决定 TA 能做什么',
    body:
        '插件是空谷的手：读网页、看日历、检索文件，都要靠插件。'
        '权限逐项授予，关掉一个插件不会影响已经产生的对话与记忆。',
  ),
  _Topic(
    title: '数据在谁手里',
    body:
        '全部在本机。对话框里的每次调用、每条记忆、每份备份都只写本地磁盘；'
        '导入导出走明文，你可以随时把一切带走。',
  ),
];

/// 手机形态：没有三栏，聊天是主界面，功能收进左上角的抽屉。
const List<_Topic> _topicsMobile = [
  _Topic(
    title: '界面长什么样',
    body:
        '跟 TA 说话的对话是主界面；左上角的按钮打开抽屉，里面是状态面板、'
        '记忆星图、备份这些功能页——选一项就会盖住对话，用页面左上角的返回键回来。',
  ),
  _Topic(
    title: '怎么开始一次对话',
    body:
        '直接在底部输入框打字，回车发送。对话与「记忆」是两件事：聊天记录留在历史对话里，'
        '值得长期记住的东西才会沉成记忆点。',
  ),
];
