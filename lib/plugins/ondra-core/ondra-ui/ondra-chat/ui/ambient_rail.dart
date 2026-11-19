import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;

import '../../../../../app/desktop_picker.dart';
import '../../ui/shell_state.dart';
import '../../../../../design/brand.dart';
import '../../../../../design/dialog.dart';
import '../../../../../design/glyph.dart';
import '../../../../../design/motion.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import './chat_client.dart';
import './neuron_backdrop.dart';
import '../../ondra-settings/ondra-persona/ui/persona_client.dart';
import '../../ondra-settings/ondra-models/ui/model_client.dart';
import '../../ondra-settings/ui/settings_client.dart';

/// 右栏：跟 TA 说话的地方。
///
/// 它不是「当前页面的助手」。曾经按页声明名字与建议（状态助手 / 记忆助手 /
/// 插件助手……），结果是同一个 TA 被拆成十个身份，用户在右栏里问的每一句
/// 都会被页面「限定」在一个主题上。现在的规则很简单：
/// **右栏永远只代表空谷自己**，切页不换标题、不换建议、不换占位文案。
/// 页面的内容在中栏，右栏只负责对话。
///
/// 它**不自带宽度**，也不认识「开 / 关」：宽度轨道（0 ↔ 280 ↔ 整张纸）由外壳
/// 的 `_RailTrack` 用一条动画曲线驱动，这里只负责「给定多宽，就长什么样」。
///
/// 这么拆是因为开合有四条路径——收纳、展开、进沉浸、退沉浸——如果每条路径
/// 都各自写一份宽度过渡，就会出现「收纳是滑出、沉浸是瞬切」这种断档：
/// 同一颗按钮触发的动作，物理规律却不一样。现在四条路径共用同一个连续量
/// [focusAmount] 与同一个宽度值，中间态永远存在、且可被中途打断。
class OndraAmbientRail extends StatelessWidget {
  const OndraAmbientRail({super.key, this.focusAmount = 0});

  /// 0 = 常驻第三栏，1 = 沉浸（右栏即整页）。
  ///
  /// 只驱动两件「身份」层面的表现：左侧分界线与神经元底纹——它们是「一栏」的
  /// 特征，铺满整页时还画着就变成了第四块面板。宽度、留白、限宽都不看它，
  /// 由真实宽度自己算（见 `_RailBody`）。
  final double focusAmount;

  /// 常驻宽度，同时是**排版宽度下限**。
  ///
  /// 宽度收窄到 280 以下时（收纳途中），内容不再重排，直接按 280 布好、
  /// 由外壳从左侧裁掉。否则表头会一路挤到 0：标题被压成「空…」、输入盒从
  /// 140 高缩成一条线，那 200ms 里整栏都在抽搐，比瞬切还难看。
  static const double width = 280;

  /// 表头 48，与左栏 `h-12` 同高。
  ///
  /// 参考应用这里是 44（`h-11`），但两侧表头差 4px 会在同一条水平线上留下
  /// 一个能看出来的台阶：左栏第一项图标、中栏标题、右栏名字三者的基线
  /// 只要差一点点，读起来就像三栏没对齐。**以左栏为准**，因为红绿灯和
  /// 左栏表头是绑在一起的（系统就摆在 48 高的那格里）。
  static const double headerHeight = 48;

  /// 展开态的阅读宽度上限。720 是长文本的常见上限（一行约 40 个汉字），
  /// 再宽就要靠缩窄窗口才能读，那不如让内容自己收住。
  static const double _fillReadWidth = 720;

  @override
  Widget build(BuildContext context) {
    return _RailBody(focusAmount: focusAmount);
  }
}

class _RailBody extends StatelessWidget {
  const _RailBody({required this.focusAmount});

  final double focusAmount;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);

    return LayoutBuilder(
      builder: (context, box) {
        // 外壳给的是**紧约束**（宽度 = max(轨道宽度, 常驻宽度)），所以这里的
        // maxWidth 就是「这一栏现在多宽」，直接拿来排版。
        final width = box.maxWidth;
        // 沉浸时给内容一个阅读宽度上限并居中：纸宽了，字不该跟着变宽。
        // 一行 700 以上的正文，眼睛回行时容易串行；输入盒同理——
        // 一个横跨 700 的输入框，光标会离发送键很远。
        //
        // 这里**不按 focusAmount 插值**，而是按真实宽度算：宽度过 720 才产生
        // 留白，于是「栏变宽」和「文字开始居中」是同一件事的两个侧面，
        // 中途任何一帧都对得上。按进度插值会在 280 宽时就凭空多出内距。
        final inset = ((width - OndraAmbientRail._fillReadWidth) / 2).clamp(
          0.0,
          1e6,
        );

        return Container(
          decoration: BoxDecoration(
            // 右栏铺 `#f4f7fa`：不是为了「有底色」，而是为了让白底的输入盒浮起来。
            // 右栏和中栏现在同处一张白纸上，如果右栏也透明，输入盒就和纸一个颜色，
            // 那个 140 高的盒子会整个消失，只剩一颗加号和一个箭头飘着。
            // 参考应用的 copilot 栏本来就是这层浅灰（`--miclaw-copilot-background`）。
            color: s.rail,
            // 分界线随沉浸程度淡出：铺满时它不是「第三栏」，左侧就不该有分界
            // ——它自己就是整页。硬切会在 280→整宽的过程中留下一条钉住的直线。
            border: Border(
              left: BorderSide(
                color: s.divider.withValues(alpha: 1 - focusAmount),
              ),
            ),
          ),
          child: Stack(
            children: [
              // 神经元网压在最后面：它是「背景」，不是「装饰」。
              // 上下两端用透明渐变收掉——网要是整块铺满，会跟表头那行字和输入盒的
              // 白边一起变成一个方框，看着像贴图；淡出之后它只是「空气里的东西」。
              //
              // 沉浸时淡出：那时右栏是一整页，一整页铺满连线的底纹会变成壁纸，
              // 长对话读起来到处都是噪点。纯色才是阅读的底色。
              if (focusAmount < 1)
                Positioned.fill(
                  child: Opacity(
                    opacity: (1 - focusAmount).clamp(0.0, 1.0),
                    child: ShaderMask(
                      blendMode: BlendMode.dstIn,
                      shaderCallback: (rect) => const LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [
                          Color(0x00000000),
                          Color(0xFF000000),
                          Color(0xFF000000),
                          Color(0x00000000),
                        ],
                        stops: [0.0, 0.10, 0.72, 1.0],
                      ).createShader(rect),
                      child: const OndraNeuronBackdrop(),
                    ),
                  ),
                ),
              // 用 Positioned.fill 而不是裸 Column：Stack 给的是松约束，
              // 裸 Column 会退化成 shrink-wrap，里面的 Expanded 就拿不到高度。
              Positioned.fill(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _RailHeader(),
                    Expanded(
                      child: Padding(
                        padding: EdgeInsets.symmetric(horizontal: inset),
                        child: const _Conversation(),
                      ),
                    ),
                    // 离线提示压在输入盒上面：内核没接上时它必须在场——
                    // 之前 offlineReason 只是记在 client 里没人显示，
                    // 用户要发一句才知道没连上。带一颗「重连」。
                    Padding(
                      padding: EdgeInsets.symmetric(horizontal: inset),
                      child: const _OfflineBanner(),
                    ),
                    Padding(
                      padding: EdgeInsets.symmetric(horizontal: inset),
                      child: _RailComposer(
                        hint: '想聊点什么？',
                        onSend: chatClient.send,
                      ),
                    ),
                    // 用量条压在输入盒下面（dsh 的 composer dock 位置）：
                    // 它描述的是「刚才这一轮花了多少」，紧贴发起动作的地方读起来
                    // 才顺；放到表头或对话顶上，就变成一块永远在跳的装饰。
                    Padding(
                      padding: EdgeInsets.symmetric(horizontal: inset),
                      child: const _UsageDock(),
                    ),
                  ],
                ),
              ),
              // 收纳键**不在这里**：它已经提到外壳的纸片上（见 chassis 的
              // _WideSplit）。它是这一栏的开关，栏收起时不能跟着栏一起消失，
              // 所以必须活在栏的外面；表头右侧那 54 的内距仍然为它留着。
            ],
          ),
        );
      },
    );
  }
}

class _RailHeader extends StatelessWidget {
  const _RailHeader();

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return SizedBox(
      height: OndraAmbientRail.headerHeight,
      child: Padding(
        // 右 54 = 折叠键 14 + 36 + 4，两颗 24 的按钮排在它左边，不互相压。
        padding: const EdgeInsets.only(left: 16, right: 54),
        child: Row(
          // 整行垂直居中：48 高的表头，文字与图标都落在中线上，
          // 和左栏第一项图标、中栏标题同一条水平线。
          children: [
            Expanded(
              // 标题只有一行。上一版在名字下面还压了一句「内容由 AI 生成，仅供参考」，
              // 那是把免责声明当副标题用：它既不是信息，也不该常驻在每一次对话的顶端。
              child: AnimatedBuilder(
                animation: personaClient,
                builder: (context, _) => Text(
                  ondraPersonaName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  // 14/500/leading-none：`text-[14px] font-medium leading-none text-black/85`。
                  style: ondraText(
                    14,
                    weight: OndraWeight.control,
                    color: s.ink85,
                    height: 1,
                  ),
                ),
              ),
            ),
            const SizedBox(width: 8),
            // 新建对话：24 圆。图标按**墨迹**对齐，不是按画布：
            // 气泡那条 SVG 描边几乎顶满 24 的 viewBox，渲染 20 时墨迹 18px；
            // 旁边的双竖线框在 19 的 viewBox 里有大片内边距，渲染 19 才 14.8px。
            // 两个画布一样大、看着却一大一小，就是差在这里。16 / 19 之后
            // 墨迹是 14.4 与 14.8，并排看不出高低。
            _RailIconButton(
              glyph: Glyphs.navNewChat,
              glyphSize: 16,
              tooltip: '新建对话',
              onTap: () => chatClient.newConversation(),
            ),
          ],
        ),
      ),
    );
  }
}

/// 表头里的小图标键：24 圆、图标 20、hover 6% 黑。
class _RailIconButton extends StatefulWidget {
  const _RailIconButton({
    required this.glyph,
    required this.tooltip,
    required this.onTap,
    this.glyphSize = 20,
  });

  final String glyph;
  final String tooltip;
  final VoidCallback onTap;
  final double glyphSize;

  @override
  State<_RailIconButton> createState() => _RailIconButtonState();
}

class _RailIconButtonState extends State<_RailIconButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Tooltip(
      message: widget.tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: OndraPressable(
          onTap: widget.onTap,
          radius: OndraRadius.pill,
          child: Container(
            width: 24,
            height: 24,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: _hover ? const Color(0x0F000000) : Colors.transparent,
              shape: BoxShape.circle,
            ),
            child: Glyph(widget.glyph, size: widget.glyphSize, color: s.ink80),
          ),
        ),
      ),
    );
  }
}

/// 右栏那颗「收纳」键：36×36，浮在 `right:14 top:6`。
///
/// 它**不是开关，是入口**：点开是一张两行的小菜单，「收纳」和「展开」都在
/// 里面。之前这里塞了三颗图标（新建对话、沉浸、收起），每一颗都得靠 tooltip
/// 才能说清自己在干什么；现在右栏只有两颗——新建对话 + 收纳，处置这一栏的
/// 两种方式收进菜单，图标才回到「一个功能一枚图标」。
///
/// 两态外观不同：栏在时透明底、圆角 14；栏收起时白底正圆加软投影——
/// 那时它脱离了右栏、直接浮在页面内容上，透明底的按钮压在白纸与正文之间
/// 既看不清，也没人知道那能点。白底 + 投影把它抬成一个实体。
class OndraRailActionButton extends StatefulWidget {
  const OndraRailActionButton({super.key, required this.filled});

  /// `true` = 右栏收起后浮在页面上的那颗（白底圆 + 投影）。
  final bool filled;

  @override
  State<OndraRailActionButton> createState() => _OndraRailActionButtonState();
}

class _OndraRailActionButtonState extends State<OndraRailActionButton> {
  /// 菜单跟着按钮走：右栏开合时按钮会位移，用 LayerLink 而不是算绝对坐标。
  final _link = LayerLink();
  OverlayEntry? _entry;
  bool _hover = false;

  @override
  void dispose() {
    _entry?.remove();
    _entry = null;
    super.dispose();
  }

  void _close() {
    final entry = _entry;
    if (entry == null) return;
    _entry = null;
    entry.remove();
  }

  void _toggle() {
    if (_entry != null) {
      _close();
      return;
    }
    final st = ShellScope.of(context);
    final s = OndraSkin.of(context);
    // 菜单项随状态改写，不在打开时把两种可能都列出来：一处状态只给
    // 「现在能做的事」，用户不用先判断哪一项是灰的。
    final actions = <_RailAction>[
      if (st.railOpen)
        _RailAction(Glyphs.railCollapse, '收纳右栏', () => st.railOpen = false)
      else
        _RailAction(Glyphs.railCollapse, '展开右栏', () => st.railOpen = true),
      if (st.chatFocus)
        _RailAction(Glyphs.expand, '退出沉浸', () => st.chatFocus = false)
      else
        _RailAction(Glyphs.expand, '展开对话', () => st.chatFocus = true),
    ];
    _entry = OverlayEntry(
      builder: (_) => _RailMenuLayer(
        link: _link,
        skin: s,
        actions: actions,
        onDismiss: _close,
      ),
    );
    Overlay.of(context).insert(_entry!);
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final open = _entry != null;
    return CompositedTransformTarget(
      link: _link,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: OndraPressable(
          onTap: _toggle,
          radius: widget.filled ? OndraRadius.pill : 14,
          child: AnimatedContainer(
            duration: OndraMotion.snap,
            curve: OndraMotion.expo,
            width: 36,
            height: 36,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              // 白底那态 hover 落到 6% 面层；透明底那态同一档，
              // 底下没有白，深浅两种主题各自算得出来。
              color: widget.filled
                  ? (_hover ? s.fill : s.surface)
                  : (_hover || open ? s.fillHover : Colors.transparent),
              borderRadius: BorderRadius.circular(
                widget.filled ? OndraRadius.pill : 14,
              ),
              boxShadow: widget.filled
                  ? [
                      BoxShadow(
                        color: const Color(0xFF0F172A).withValues(alpha: 0.10),
                        blurRadius: 14,
                        offset: const Offset(0, 4),
                      ),
                    ]
                  : null,
            ),
            child: Glyph(Glyphs.railCollapse, size: 19, color: s.ink80),
          ),
        ),
      ),
    );
  }
}

/// 菜单里的一条动作。
class _RailAction {
  const _RailAction(this.icon, this.label, this.run);

  final String icon;
  final String label;
  final VoidCallback run;
}

/// 菜单浮层：一层透明遮罩负责「点空白处关掉」，卡片右对齐跟着按钮。
///
/// 不用 `PopupMenuButton`：它自带 Material 的 48 高行、方形涟漪与 4px 圆角，
/// 在这套界面里一眼就出戏。这里只有两行 30 高的文字，用普通 Stack 更直接。
class _RailMenuLayer extends StatelessWidget {
  const _RailMenuLayer({
    required this.link,
    required this.skin,
    required this.actions,
    required this.onDismiss,
  });

  final LayerLink link;
  final OndraSkin skin;
  final List<_RailAction> actions;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Material(
      // Overlay 挂在 Navigator 上，不在 home 那层 `Material` 之下：
      // 少了这一层，Text 会继承 WidgetsApp 的「错误文字样式」，
      // 菜单里的每一行都会带黄色双下划线（和红字）。
      type: MaterialType.transparency,
      child: Stack(
        children: [
          Positioned.fill(
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onDismiss,
              child: const SizedBox.expand(),
            ),
          ),
          CompositedTransformFollower(
            link: link,
            showWhenUnlinked: false,
            targetAnchor: Alignment.bottomRight,
            followerAnchor: Alignment.topRight,
            offset: const Offset(0, 6),
            // 入场：120ms 内从 95% 放大到 100% 并淡入，原点在右上角——
            // 也就是按钮那一侧。浮层要看起来是「从这颗按钮里长出来的」，
            // 而不是凭空出现在按钮下方（参考实现 `motionPopover`：
            // `initial {opacity:0, scale:.95, y:4}`，与 SPRING_SNAPPY 同族）。
            child: TweenAnimationBuilder<double>(
              tween: Tween(begin: 0, end: 1),
              duration: OndraMotion.snap,
              curve: OndraMotion.expo,
              builder: (context, t, child) => Opacity(
                opacity: t,
                child: Transform.scale(
                  scale: 0.95 + 0.05 * t,
                  alignment: Alignment.topRight,
                  child: child,
                ),
              ),
              child: Container(
                // 152 刚好容下「收纳右栏」加图标，再宽右侧会空出一条视觉噪声。
                width: 152,
                padding: const EdgeInsets.all(5),
                decoration: BoxDecoration(
                  color: skin.surface,
                  borderRadius: BorderRadius.circular(10),
                  // **双环**：浅色是「外环 1px 发丝线 + 两层弥散投影」，
                  // 深色把外环归零、改在**内侧**压 1px 10% 白——模拟实体
                  // 倒角在暗处接到的顶光。深色里黑描边等于没有，只靠投影
                  // 会和背景糊成一块（参考实现 `--cds-ring-inner/outer`
                  // 两套取值，`--cds-shadow-popover` 的浅 12%/8% 与深
                  // 65%/45% 两档）。
                  border: Border.all(
                    color: skin.dark ? const Color(0x1AFFFFFF) : skin.lineCard,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: const Color(0xFF0F172A)
                          .withValues(alpha: skin.dark ? 0.65 : 0.12),
                      blurRadius: skin.dark ? 28 : 24,
                      offset: const Offset(0, 8),
                    ),
                    BoxShadow(
                      color: const Color(0xFF0F172A)
                          .withValues(alpha: skin.dark ? 0.45 : 0.08),
                      blurRadius: skin.dark ? 8 : 6,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final a in actions)
                      _RailMenuRow(action: a, skin: skin, onDone: onDismiss),
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

class _RailMenuRow extends StatefulWidget {
  const _RailMenuRow({
    required this.action,
    required this.skin,
    required this.onDone,
  });

  final _RailAction action;
  final OndraSkin skin;
  final VoidCallback onDone;

  @override
  State<_RailMenuRow> createState() => _RailMenuRowState();
}

class _RailMenuRowState extends State<_RailMenuRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = widget.skin;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: OndraPressable(
        onTap: () {
          // 先收菜单再执行：动作会改壳层状态，可能把按钮本身拆掉，
          // 那时再 remove 就晚了（entry 还挂在已销毁的 Overlay 上）。
          widget.onDone();
          widget.action.run();
        },
        radius: OndraRadius.sm,
        child: AnimatedContainer(
          duration: OndraMotion.snap,
          curve: OndraMotion.expo,
          height: 30,
          padding: const EdgeInsets.symmetric(horizontal: 8),
          decoration: BoxDecoration(
            color: _hover ? s.fill : Colors.transparent,
            borderRadius: BorderRadius.circular(6),
          ),
          child: Row(
            children: [
              Glyph(widget.action.icon, size: 16, color: s.ink60),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  widget.action.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(
                    13,
                    weight: OndraWeight.body,
                    color: s.ink85,
                    height: 1,
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

/// 会话区：没有消息时是欢迎语，有消息时是对话流。
///
/// 消息只有三种：用户（右侧蓝底气泡）、TA（左侧白底卡片）、系统（居中小字）。
/// 系统消息用来如实交代「为什么没有回复」，不做假装成 TA 说的话。
class _Conversation extends StatelessWidget {
  const _Conversation();

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: chatClient,
      builder: (context, _) {
        if (!chatClient.hasConversation) return const _Welcome();
        final msgs = chatClient.messages;
        // 对话流上下各留 28 的羽化：滚动时消息从表头与输入盒底下「化开」，
        // 而不是被一条硬边切断。这是整条对话流里最容易被忽略、又最影响
        // 「是否精致」的一处——截图看不出来，滚起来立刻有感。
        return OndraScrollFade(
          child: ListView.builder(
            // 对话流 `padding: 0 12px`，整块离表头再留 22（`.xu-flow{margin:22px auto 0}`），
            // 每条之间 20（`.xu-flow-item{margin-top:20px}`）。
            padding: const EdgeInsets.fromLTRB(12, 22, 12, 12),
            itemCount: msgs.length,
            itemBuilder: (context, i) => Padding(
              padding: EdgeInsets.only(top: i == 0 ? 0 : 20),
              child: _Bubble(message: msgs[i]),
            ),
          ),
        );
      },
    );
  }
}

/// 一条消息。
///
/// TA 的话**有白底卡片**，用户的话是**蓝底气泡**——两者都不是透明文字。
/// 上一版把 TA 做成裸文字、用户做成灰底，读起来像「一个人在自说自话」：
/// 卡片把每条回答框成一个可以停下来的段落，蓝底则一眼分清谁在说。
class _Bubble extends StatelessWidget {
  const _Bubble({required this.message});

  final ChatMessage message;

  /// 设置里的「字号大小」：12–20，默认 14。
  ///
  /// 界面上标的是「仅影响会话内容的字号」，所以只有这一处折算，其余排版
  /// 保持原值。基准是 14：在 14 时系数正好 1.0，16 号的正文与设计稿一致；
  /// 用户把滑块推到 20 时正文 16 → 22.9，推到 12 时 16 → 13.7。
  double get _scale => settingsClient.number('general.fontSize') / 14;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    switch (message.role) {
      case ChatRole.user:
        // `.xu-user-content{max-width:min(720px,86%);padding:10px 15px;
        //  border-radius:10px;background:#3482ff1a}`。
        // 10% 蓝不是「强调色」，是为了让用户的话和 TA 的白卡在白纸上分开档次。
        //
        // 86% 是**相对对话流**的，不是相对窗口：右栏只有 280，按窗口算会得到
        // 一个几乎顶满整栏的气泡，和 TA 的白卡一样宽，「谁在说」就又分不出来了。
        return LayoutBuilder(
          builder: (context, box) => Align(
            alignment: Alignment.centerRight,
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: box.maxWidth * 0.86),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 15,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: OndraColor.userBubble,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Text(
                  message.text,
                  // 1.5 行高是参考应用 `.xu-user-content` 的原值。
                  style: ondraText(
                    16 * _scale,
                    color: s.bubbleInk,
                    height: 1.5,
                  ),
                ),
              ),
            ),
          ),
        );
      case ChatRole.assistant:
        // `.xu-answer-content{background:#fff;border-radius:12px}` +
        // `.xu-answer-text{padding:10px 14px}`，字 16、色 `#000000e0`。
        return Container(
          decoration: BoxDecoration(
            color: s.surface,
            borderRadius: BorderRadius.circular(12),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Text(
            message.streaming && message.text.isEmpty ? '…' : message.text,
            style: ondraText(
              16 * _scale,
              color: message.streaming && message.text.isEmpty
                  ? s.ink25
                  : s.answerInk,
              height: 1.5,
            ),
          ),
        );
      case ChatRole.system:
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Center(
            child: Text(
              message.text,
              textAlign: TextAlign.center,
              style: ondraText(12, color: s.ink40, height: 16 / 12),
            ),
          ),
        );
    }
  }
}

/// 欢迎区：标记 + 20/600 招呼，整体压着输入条。
///
/// 内距 `px-5 pb-3` + 内层 `px-2 pb-2` 是参考应用的写法（20 + 8 = 28 边距），
/// 比上一版的 24 略宽：这一屏只有两行元素，边距宽一点才撑得住留白。
class _Welcome extends StatelessWidget {
  const _Welcome();

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);

    return Column(
      mainAxisAlignment: MainAxisAlignment.end,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                OndraMark(size: 36, color: s.ink),
                const SizedBox(height: 12),
                AnimatedBuilder(
                  animation: personaClient,
                  builder: (context, _) => Text(
                    '嗨，我是$ondraPersonaName',
                    // `text-[20px] font-semibold leading-7 text-black`。
                    style: ondraText(
                      20,
                      weight: 600,
                      color: s.ink85,
                      height: 28 / 20,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

/// 输入条：140 高白盒，左上多行输入，左下附件、右下发送。
///
/// 它是真输入框（能打字、能聚焦），只是发送还没有后端接。把「能打字」
/// 做出来是有必要的：一个连光标都点不进去的框，看起来就像坏了一半。
/// 离线原因 + 重连：内核没接上时必须让用户当场知道，而不是等他发了话
/// 才在对话流里看到一条错误。之前 `offlineReason` 记在 client 里没人读。
class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner();

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: chatClient,
      builder: (context, _) {
        final reason = chatClient.offlineReason;
        if (reason == null || reason.isEmpty) return const SizedBox.shrink();
        final s = OndraSkin.of(context);
        return Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 8, 10, 8),
            decoration: BoxDecoration(
              color: s.surface,
              borderRadius: BorderRadius.circular(OndraRadius.md),
              border: Border.all(color: s.lineFaint),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    reason,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(11.5, color: s.ink60, height: 16 / 11.5),
                  ),
                ),
                const SizedBox(width: 8),
                OndraPressable(
                  onTap: () => chatClient.connect(),
                  radius: OndraRadius.md,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 5,
                    ),
                    decoration: BoxDecoration(
                      color: s.accentSoft,
                      borderRadius: BorderRadius.circular(OndraRadius.md),
                    ),
                    child: Text(
                      '重连',
                      style: ondraText(11.5, weight: 500, color: s.ink),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _RailComposer extends StatefulWidget {
  const _RailComposer({required this.hint, required this.onSend});

  final String hint;
  final void Function(String text) onSend;

  @override
  State<_RailComposer> createState() => _RailComposerState();
}

class _RailComposerState extends State<_RailComposer> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  bool _hasText = false;
  bool _busy = chatClient.busy;

  @override
  void initState() {
    super.initState();
    // 发送键的可用性取决于附件（只带图也能发），所以要跟着 chatClient 刷新；
    // 不监听的话，挂上附件后那颗键还是灰的，用户只能先打一个字。
    chatClient.addListener(_onChatChanged);
    _controller.addListener(_onChatChanged);
    // 设置里的「回车发送」改了要立刻反映到输入框：这项只在按键那一刻判定，
    // 不需要重建整棵树，但要让 setState 触发一次以更新 textInputAction。
    settingsClient.addListener(_onSettingsChanged);
  }

  void _onChatChanged() {
    if (!mounted) return;
    final canSend =
        _controller.text.trim().isNotEmpty || chatClient.attachments.isNotEmpty;
    if (canSend != _hasText || _busy != chatClient.busy) {
      setState(() {
        _hasText = canSend;
        _busy = chatClient.busy;
      });
    }
  }

  void _onSettingsChanged() {
    if (!mounted) return;
    setState(() {});
  }

  /// 「回车发送」。关掉后回车换行、⌘ Enter 才发送。
  bool get _enterSend => settingsClient.boolean('dialog.enterSend');

  @override
  void dispose() {
    chatClient.removeListener(_onChatChanged);
    settingsClient.removeListener(_onSettingsChanged);
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _submit() {
    final text = _controller.text.trim();
    final hasAttachments = chatClient.attachments.isNotEmpty;
    // 只带图不打字也允许：内核的 prompt 接受非文本块，图片本身就是一句话。
    // 生成期间不拦：交给 chatClient 按「繁忙时的发送行为」处理
    // （排队 / 插话）。这里再拦一次，那两个设置就永远轮不到生效。
    if (text.isEmpty && !hasAttachments) return;
    if (chatClient.maintenance) {
      widget.onSend(text);
      return;
    }
    _controller.clear();
    widget.onSend(text);
    // 附件的清理在 chatClient.send 里做：随消息一起发出，发完就撤——
    // 之前在发送前就清掉，附件从没真的交给内核，界面却像发过了。
  }

  /// 选附件。选完挂在 chatClient 上，输入盒上方会出现一行小标签。
  ///
  /// 一次最多 5 个：再多的话那行标签会占掉输入盒的两行，
  /// 而用户其实也记不清自己选了哪几个。
  Future<void> _pickAttachments() async {
    final picked = await DesktopPicker.pickFiles(
      prompt: '选择要一起发送的图片',
      limit: 5,
    );
    var rejected = 0;
    for (final path in picked) {
      final a = ChatAttachment.fromPath(path);
      // 内核的 prompt 只收图片块，其他文件没有传输形态——挑选时就拦下，
      // 不给「挂上了却发不出去」的假象。
      if (!a.isImage) {
        rejected++;
        continue;
      }
      chatClient.attach(a);
    }
    if (rejected > 0 && mounted) {
      OndraToast.show(context, '只支持图片附件，$rejected 个文件没有加入');
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Padding(
      // `shrink-0 px-3 pb-3 pt-3` 的外框不变，变的是里面那一层的高度。
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 附件行在输入盒**上面**：它属于「这条消息要带什么」，
          // 是发送前的状态；放到下面会和「刚才发了什么」混在一起。
          AnimatedBuilder(
            animation: chatClient,
            builder: (context, _) => chatClient.attachments.isEmpty
                ? const SizedBox.shrink()
                : Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: _AttachmentStrip(
                      items: chatClient.attachments,
                      onRemove: chatClient.detach,
                    ),
                  ),
          ),
          // 排队行：`queue` 策略下，用户在生成期间发的话攒在队列里，
          // 这一行告诉他「话没丢，等这一轮完了就发」。
          //
          // 没有这一行的话，「排队发送」与「点了没反应」在界面上长得一模一样——
          // 用户会以为自己的话被吞了，然后再打一遍。
          AnimatedBuilder(
            animation: chatClient,
            builder: (context, _) {
              final n = chatClient.queued.length;
              if (n == 0) return const SizedBox.shrink();
              return Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _QueueStrip(count: n, onClear: chatClient.clearQueue),
              );
            },
          ),
          _composerBox(s),
        ],
      ),
    );
  }

  Widget _composerBox(OndraSkin s) {
    return Container(
      // 70 高：与「一行文字 + 一颗 32 的按钮」等身。
      //
      // 上一版是 140 高的卡片（上行多行输入、下行附件与发送），占掉了右栏
      // 将近三分之一——三栏并置时它比对话本身还显眼。改成横排之后，输入框
      // 回到「一条输入栏」的本分，多行时自己长高（maxLines 3），不预占空位。
      constraints: const BoxConstraints(minHeight: 70),
      padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
      decoration: BoxDecoration(
        // 参考应用在 copilot 这一态下不画边框：白卡浮在 `#f4f7fa` 上已经够清楚，
        // 再描一条线会让它显得又薄又硬。
        color: s.surface,
        borderRadius: BorderRadius.circular(16),
      ),
      child: Row(
        // 按钮跟文字中线对齐：单行时三者同一水平线，换到两行也不会把按钮顶到角上。
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: CallbackShortcuts(
              // 「回车发送」关掉时，回车只换行；发送交给 ⌘ Enter。
              // 两种模式都保留 ⌘ Enter 作为发送键——它是 macOS 上的肌肉记忆，
              // 关掉回车发送的人往往正是想用这个组合。
              bindings: <ShortcutActivator, VoidCallback>{
                const SingleActivator(LogicalKeyboardKey.enter, meta: true):
                    _submit,
              },
              child: TextField(
                controller: _controller,
                focusNode: _focus,
                minLines: 1,
                maxLines: 3,
                cursorColor: OndraColor.accent,
                // 15/22：比旧版 16/24 小一档，因为这一栏现在更矮，
                // 16 的字在一行 70 的盒子里会显得顶天立地。
                style: ondraText(15, color: s.ink, height: 22 / 15),
                // 回车键的语义由设置决定：
                //  - 回车发送（默认）：textInputAction 为 send，软键盘上是「发送」，
                //    按下即发；换行改用 ⇧ Enter / ⌥ Enter。
                //  - 关掉：textInputAction 为 newline，回车就是换行，发送只能 ⌘ Enter。
                textInputAction: _enterSend
                    ? TextInputAction.send
                    : TextInputAction.newline,
                onSubmitted: _enterSend ? (_) => _submit() : null,
                decoration: InputDecoration(
                  isDense: true,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  contentPadding: const EdgeInsets.symmetric(vertical: 6),
                  hintText: widget.hint,
                  hintMaxLines: 1,
                  hintStyle: ondraText(15, color: s.hintInk, height: 22 / 15),
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _InputIconButton(
            glyph: Glyphs.plus,
            tooltip: '上传文件',
            onTap: _pickAttachments,
          ),
          if (_busy) ...[
            const SizedBox(width: 6),
            _InputIconButton(
              glyph: Glyphs.close,
              tooltip: '停止生成',
              onTap: chatClient.stop,
            ),
          ],
          const SizedBox(width: 6),
          _SendButton(
            // 生成期间也能按：这正是「繁忙时的发送行为」两项设置生效的地方——
            // 排队与插话都发生在 busy 的那一刻。上一版这里写了
            // `&& !chatClient.busy`，那颗键在生成时一直是灰的，
            // 于是那两个选项无论怎么设都没有机会被触发。
            // 有文字或有附件都允许发送：只带图不打字是一条完整的消息。
            // 附件状态在这里实时反映——这个 build 由输入区监听 chatClient
            // 触发，见下面 _submit 的说明。
            enabled: _hasText || chatClient.attachments.isNotEmpty,
            onTap: _submit,
          ),
        ],
      ),
    );
  }
}

/// 已选附件的一行小标签：文件名 + 一个叉。
class _AttachmentStrip extends StatelessWidget {
  const _AttachmentStrip({required this.items, required this.onRemove});

  final List<ChatAttachment> items;
  final void Function(String path) onRemove;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Wrap(
      spacing: 6,
      runSpacing: 6,
      children: [
        for (final a in items)
          Container(
            padding: const EdgeInsets.fromLTRB(9, 4, 5, 4),
            decoration: BoxDecoration(
              color: s.surface,
              borderRadius: BorderRadius.circular(OndraRadius.pill),
              border: Border.all(color: s.lineFaint),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 150),
                  child: Text(
                    a.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(11, color: s.ink80, height: 15 / 11),
                  ),
                ),
                const SizedBox(width: 3),
                OndraPressable(
                  radius: OndraRadius.pill,
                  onTap: () => onRemove(a.path),
                  child: Padding(
                    padding: const EdgeInsets.all(2),
                    child: Glyph(Glyphs.close, size: 11, color: s.ink30),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// 排队中的话：一行浅色提示 + 一个「撤掉」。
///
/// 形状与附件行一致（药丸 + 小字 + 一颗叉），因为它们是同一类东西：
/// 「已经交给你、但还没真正发出去的内容」。用两套样式会让人以为
/// 附件是附件、排队是别的什么状态。
class _QueueStrip extends StatelessWidget {
  const _QueueStrip({required this.count, required this.onClear});

  final int count;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          padding: const EdgeInsets.fromLTRB(9, 4, 5, 4),
          decoration: BoxDecoration(
            // 比附件行更淡：它是「还在等」的状态，不该比内容本身更抢眼。
            color: s.lineFaint.withValues(alpha: 0.5),
            borderRadius: BorderRadius.circular(OndraRadius.pill),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '$count 句排队中，本轮结束后依次发送',
                style: ondraText(11, color: s.ink60, height: 15 / 11),
              ),
              const SizedBox(width: 3),
              OndraPressable(
                radius: OndraRadius.pill,
                onTap: onClear,
                child: Padding(
                  padding: const EdgeInsets.all(2),
                  child: Glyph(Glyphs.close, size: 11, color: s.ink30),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// 输入盒左下那颗辅助按钮：36×36、圆角 12、`#f5f6f8` 底、`#4e5969` 图标。
///
/// 不复用 [GlyphButton]：那个的 hover 是「铺 6% 黑」，而这里本身已有浅底，
/// 再叠黑会变成脏灰。这里 hover 改走 `#eef0f4`，与折叠键的收起着色保持一致。
class _InputIconButton extends StatefulWidget {
  const _InputIconButton({
    required this.glyph,
    required this.tooltip,
    required this.onTap,
  });

  final String glyph;
  final String tooltip;
  final VoidCallback onTap;

  @override
  State<_InputIconButton> createState() => _InputIconButtonState();
}

class _InputIconButtonState extends State<_InputIconButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Tooltip(
      message: widget.tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: OndraPressable(
          onTap: widget.onTap,
          radius: 12,
          child: AnimatedContainer(
            duration: OndraMotion.snap,
            curve: OndraMotion.expo,
            width: 32,
            height: 32,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: _hover ? s.fillSelected : s.fill,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Glyph(widget.glyph, size: 17, color: s.ink80),
          ),
        ),
      ),
    );
  }
}

/// 发送键：36 圆。有内容时蓝底白箭头并带一层蓝投影，空内容时 6% 灰底淡箭头。
///
/// 参考应用是 `h-10 w-10 rounded-full` 蓝底 + `shadow-[0_8px_20px_rgba(47,123,255,.28)]`。
/// 这里 36 是因为输入盒内的按钮都统一到 36（辅助键也是 36），
/// 40 会把右下角撑出去、和左边的辅助键不齐。
class _SendButton extends StatelessWidget {
  const _SendButton({required this.enabled, required this.onTap});

  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Tooltip(
      message: '发送',
      child: OndraPressable(
        onTap: enabled ? onTap : null,
        radius: OndraRadius.pill,
        child: Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: enabled ? OndraColor.sendBlue : s.fill,
            shape: BoxShape.circle,
            boxShadow: enabled
                ? [
                    BoxShadow(
                      color: OndraColor.sendBlue.withValues(alpha: 0.28),
                      blurRadius: 20,
                      offset: const Offset(0, 8),
                    ),
                  ]
                : null,
          ),
          child: Glyph(
            Glyphs.arrowUp,
            size: 17,
            color: enabled ? Colors.white : s.ink25,
          ),
        ),
      ),
    );
  }
}

/// 性能用量条：与 DeepSeek Harness 的 composer dock 同构的三段读数。
///
/// | 段 | 内容 | 来源 |
/// |---|---|---|
/// | 输出速度 | `159 token/s` | 这一步的 `outputTokens ÷ 耗时` |
/// | 会话用量 | `79.8万 token · 缓存命中 63%` | 累计计费 token；`cacheRead ÷ 计费输入` |
/// | 上下文 | `◯ 4%` | 最近一次请求的输入 ÷ 模型的 contextWindow |
///
/// **没有数据时画 `—`，不画 0。** 这三项全部来自内核 `assistant/message`
/// 上的 `usage`；没连内核时它们是「不知道」，写成 0 会让用户以为「这一轮
/// 免费」或者「缓存全没命中」——两者都是编出来的事实。
class _UsageDock extends StatelessWidget {
  const _UsageDock();

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return AnimatedBuilder(
      animation: chatClient,
      builder: (context, _) {
        final u = chatClient.usage;
        final limit = _contextWindow();
        final ratio = (limit > 0 && u.contextTokens > 0)
            ? (u.contextTokens / limit).clamp(0.0, 1.0)
            : 0.0;

        final speed = u.hasSpeed ? '${u.tps.round()}' : '—';
        final total = u.totalTokens > 0 ? _formatTokens(u.totalTokens) : '—';
        final hit = u.hasCache ? '${(u.cacheHit * 100).round()}' : '—';
        final used = ratio > 0 ? '${(ratio * 100).round()}' : '—';

        return SizedBox(
          height: 26,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 4),
            child: LayoutBuilder(
              builder: (context, box) {
                // 常驻宽度（280）放不下「79.8万 token · 缓存命中 63%」这一整串，
                // 按可用宽度分两档收：先省掉「token」这个词（数字已经在那一格上，
                // 右边有圆盘图标），还不够就把「缓存命中」缩成「命中」。
                // 两档都是**同一个事实的缩写**，不换单位、不四舍五入、不丢位数。
                final roomy = box.maxWidth >= 360;
                return Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    _Stat(value: speed, unit: ' token/s', skin: s),
                    Flexible(
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const _CylinderGlyph(),
                          const SizedBox(width: 5),
                          _Stat(
                            value: total,
                            unit: roomy ? ' token' : '',
                            skin: s,
                          ),
                          Text(
                            roomy ? ' · 缓存命中 ' : ' · 命中 ',
                            maxLines: 1,
                            style: ondraText(10.5, color: s.ink25, height: 1),
                          ),
                          _Stat(value: hit, unit: '%', skin: s),
                        ],
                      ),
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _ContextRing(ratio: ratio, skin: s),
                        const SizedBox(width: 4),
                        _Stat(value: used, unit: '%', skin: s),
                      ],
                    ),
                  ],
                );
              },
            ),
          ),
        );
      },
    );
  }
}

/// 一段读数：数字用 60% 墨、单位用 25% 墨。
///
/// 用 [Text.rich] 而不是两个 `Text`：数字与单位必须共享同一条基线、
/// 同一个行高，并排两个 Text 在 10.5px 上会差半像素，看着像抖动。
class _Stat extends StatelessWidget {
  const _Stat({required this.value, this.unit = '', required this.skin});

  final String value;
  final String unit;
  final OndraSkin skin;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: value,
            style: ondraText(
              10.5,
              weight: OndraWeight.control,
              color: skin.ink60,
              height: 1,
            ),
          ),
          if (unit.isNotEmpty)
            TextSpan(
              text: unit,
              style: ondraText(10.5, color: skin.ink25, height: 1),
            ),
        ],
      ),
    );
  }
}

/// token 总数上的那枚「三层圆盘」。
///
/// 参考实现用的是图标字体里的一枚数据库字形；这里没有图标字体，用 1px 描边
/// 现画——两个椭圆 + 两条竖线就是「账本/库」在全世界的通用形状，10px 下
/// 仍能认出来，而且省掉一个只有 40 字节的 SVG 资产。
class _CylinderGlyph extends StatelessWidget {
  const _CylinderGlyph();

  @override
  Widget build(BuildContext context) => CustomPaint(
    size: const Size(9, 10),
    painter: _CylinderPainter(OndraSkin.of(context)),
  );
}

class _CylinderPainter extends CustomPainter {
  _CylinderPainter(this.skin);

  final OndraSkin skin;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = skin.ink30
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    final w = size.width;
    final h = size.height;
    final rx = w / 2 - 0.5;
    const ry = 2.0;
    // 上口、下口、两道侧壁：三段线拼成一个柱体，不需要填充面。
    canvas.drawOval(
      Rect.fromCenter(center: Offset(w / 2, ry), width: rx * 2, height: ry * 2),
      paint,
    );
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(w / 2, h - ry),
        width: rx * 2,
        height: ry * 2,
      ),
      paint,
    );
    canvas.drawLine(const Offset(0.5, ry), Offset(0.5, h - ry), paint);
    canvas.drawLine(Offset(w - 0.5, ry), Offset(w - 0.5, h - ry), paint);
  }

  @override
  bool shouldRepaint(covariant _CylinderPainter old) =>
      old.skin.ink30 != skin.ink30;
}

/// 上下文占用环：12px，轨道 12% 墨，已用部分强调色。
///
/// 不算精确比例也没关系——它在这里的作用是「一眼看出还剩多少余量」，
/// 精确数字就在它右边。环从 12 点方向顺时针长，和所有进度环同一个直觉。
class _ContextRing extends StatelessWidget {
  const _ContextRing({required this.ratio, required this.skin});

  final double ratio;
  final OndraSkin skin;

  @override
  Widget build(BuildContext context) =>
      CustomPaint(size: const Size(12, 12), painter: _RingPainter(ratio, skin));
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.ratio, this.skin);

  final double ratio;
  final OndraSkin skin;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = size.width / 2 - 1;
    final track = Paint()
      ..color = skin.ink20
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4;
    canvas.drawCircle(center, radius, track);
    if (ratio <= 0) return;
    final arc = Paint()
      ..color = OndraColor.accent
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -1.5707963267948966,
      6.283185307179586 * ratio,
      false,
      arc,
    );
  }

  @override
  bool shouldRepaint(covariant _RingPainter old) =>
      old.ratio != ratio || old.skin.ink20 != skin.ink20;
}

/// 当前模型的上下文窗口（token）。取不到返回 0，界面据此显示 `—`。
int _contextWindow() {
  final id = modelClient.defaultModelId;
  for (final (_, model) in modelClient.allModelEntries) {
    if (model.id != id) continue;
    return _parseCapacity(model.contextWindow);
  }
  return 0;
}

/// `128K` / `1M` / `131072` → token 数。认不出来返回 0（不猜一个默认值）。
int _parseCapacity(String raw) {
  final text = raw.trim().toUpperCase().replaceAll(' ', '');
  if (text.isEmpty) return 0;
  final match = RegExp(r'^([0-9]+(?:\.[0-9]+)?)([KMB]?)$').firstMatch(text);
  if (match == null) return 0;
  final n = double.tryParse(match.group(1)!);
  if (n == null || n <= 0) return 0;
  final unit = match.group(2) ?? '';
  final factor = switch (unit) {
    'K' => 1024,
    'M' => 1024 * 1024,
    'B' => 1024 * 1024 * 1024,
    _ => 1,
  };
  return (n * factor).round();
}

/// `798000` → `79.8万`；`800000` → `80万`；小于一万就原样。
///
/// 中文语境下「万」比 `k` 好读：79.8 万一眼知道量级，798k 要多换算一次。
String _formatTokens(int n) {
  if (n < 10000) return '$n';
  if (n < 100000000) {
    final v = n / 10000;
    return '${_trimZero(v.toStringAsFixed(1))}万';
  }
  final v = n / 100000000;
  return '${_trimZero(v.toStringAsFixed(1))}亿';
}

String _trimZero(String s) =>
    s.endsWith('.0') ? s.substring(0, s.length - 2) : s;
