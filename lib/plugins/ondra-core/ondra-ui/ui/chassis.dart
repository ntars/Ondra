import 'dart:math' as math;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:material_ui/material_ui.dart';

import './registry.dart';
import './shell_state.dart';
import '../../../../design/glyph.dart';
import '../../../../design/motion.dart';
import '../../../../design/primitives.dart';
import '../../../../design/skin.dart';
import '../../../../design/tokens.dart';
import '../ondra-settings/ui/console_sheet.dart';
import '../ondra-backup/ui/timeline/timeline_stage.dart';
import '../ondra-browser/ui/browser_client.dart';
import '../ondra-browser/ui/browser_page.dart';
import '../ondra-chat/ui/ambient_rail.dart';
import 'side_rail.dart';

/// 主壳：左导航 + 内容槽 + 右助手栏。
///
/// 与原实现一致，**没有横跨整窗的标题栏**：三栏各有各的表头，窗口左上角的
/// 红绿灯落在侧栏表头里。页面自带顶部的拖拽条（52 或 44 高），所以内容槽
/// 直接铺页面，不再额外叠一层。
///
/// 两种形态：
/// - **展开**（宽 ≥ 930）：三栏在流内，两侧栏做 200ms 宽度过渡；
/// - **紧凑**（更窄，只可能出现在 web 预览里）：两栏收起，展开时以覆盖式抽屉出现。
///
/// 桌面端的窗口最小就是 960×600，所以**真机上永远是三栏**：这条阈值只是给
/// 浏览器预览留的退路，不是产品形态。960 时中栏剩 480，页面按这个宽度设计。
class OndraChassis extends StatelessWidget {
  const OndraChassis({super.key});

  /// 右栏宽度槽的定位键。
  ///
  /// 右栏内容是按「排版宽度」布局后再裁切的（收纳途中内容宽 280、槽只有 120），
  /// 所以 `OndraAmbientRail` 自身的尺寸恒等于排版宽度，不是栏宽。要量真实的
  /// 开合进度，只能量这个槽——界面本身不用它，给测试与调试定位用。
  static const Key railSlotKey = Key('ondra.rail.slot');

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return _Shell(compact: constraints.maxWidth < 930);
      },
    );
  }
}

class _Shell extends StatefulWidget {
  const _Shell({required this.compact});

  final bool compact;

  @override
  State<_Shell> createState() => _ShellState();
}

class _ShellState extends State<_Shell> {
  bool _synced = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_synced) return;
    _synced = true;
    if (!widget.compact) return;
    // **只在 Web 上自动收起。** 桌面端的最小窗口就是 960，永远不会真的紧凑；
    // 但窗口刚起来的那一帧，LayoutBuilder 拿到的可能是还没被设成 960 的宽度，
    // 一旦因此走进这里，侧栏就会被永久关掉——启动后左栏凭空消失，而用户
    // 从没点过任何按钮。桌面端不接这一段，就没有这个假状态。
    if (!kIsWeb) return;
    // 首次进入紧凑形态：两栏默认收起。放到帧后执行，避免在构建期通知。
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final st = ShellScope.of(context);
      st.sidebarOpen = false;
      st.railOpen = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final st = ShellScope.of(context);
    final s = OndraSkin.of(context);
    final module =
        OndraRegistry.byId(st.activeId) ??
        (OndraRegistry.available.isEmpty ? null : OndraRegistry.available.first);
    final page = module == null
        ? const _NoModuleView()
        : KeyedSubtree(
            key: ValueKey(module.id),
            child: Builder(builder: module.build),
          );

    // 网页是**被动出现的面**：别的东西要打开网页时，它顶替中栏那一页，
    // 关掉就回到原来那页。左栏没有它的入口——浏览不该是一个「目的地」。
    final content = AnimatedBuilder(
      animation: browserClient,
      builder: (context, _) => browserClient.visible
          ? BrowserPage(onClose: browserClient.close)
          : page,
    );

    return Container(
      // 桌面：整窗透明，玻璃由 AppKit 的 NSVisualEffectView 画在内容下面，
      // 侧栏那层 10% 白叠上去就是毛玻璃。内容区与右栏自己画实色，所以只有侧栏透。
      // Web 没有底层玻璃，用实色兜底。
      color: kIsWeb ? s.shell : Colors.transparent,
      child: Stack(
        children: [
          widget.compact ? _CompactBody(page: content) : _WideBody(page: content),
          if (st.settingsOpen)
            Positioned.fill(
              child: ConsoleSheet(onClose: () => st.settingsOpen = false),
            ),
          // 时间线压在最上层：它要吞掉三栏，包括侧栏的毛玻璃。
          // 用 State 而不是 Navigator——退出是「回到刚才那一页」，不是「返回」。
          if (st.timelineOpen)
            Positioned.fill(
              child: TimelineStage(
                onClose: () => st.timelineOpen = false,
              ),
            ),
        ],
      ),
    );
  }
}

class _WideBody extends StatelessWidget {
  const _WideBody({required this.page});

  final Widget page;

  @override
  Widget build(BuildContext context) {
    final st = ShellScope.of(context);
    final s = OndraSkin.of(context);

    return Stack(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // 左栏照常，**不受展开影响**：展开讲的是「让对话接管中栏」，
            // 不是「把左栏收走」。左栏开不开一直是用户自己的选择，
            // 一个和它无关的按钮不该顺手改掉它。
            const OndraSideRail(),
            // 中栏 + 右栏同处一张「纸片」上：纸片圆角 12、四周让出 4px，
            // 那 4px 露出的就是窗口底下的原生玻璃。侧栏不在这张纸上——
            // 它本身就是玻璃的一部分，压上白纸就变成第四块灰了。
            //
            // 纸内只有**一条**宽度轨道（[_RailTrack]）：右栏收纳、展开、
            // 进沉浸、退沉浸四种切换都只是在改这条轨道的目标值，中栏宽度
            // 是它的余量。四套动画合成一套，才不会出现「这个按钮是滑的、
            // 那个按钮是跳的」。
            Expanded(
              child: _Paper(
                child: LayoutBuilder(
                  builder: (context, box) => _RailTrack(
                    paperWidth: box.maxWidth,
                    focus: st.chatFocus,
                    open: st.railOpen,
                    builder: (context, railWidth) => _WideSplit(
                      page: page,
                      paperWidth: box.maxWidth,
                      railWidth: railWidth,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
        // 侧栏折叠键：**只这一颗**，浮在最上层随侧栏滑动。
        // 展开时贴在侧栏右缘内 8（200 - 8 - 32 = 160），收起时落到 96——
        // 两个位置都是参考应用的 `left-[160px]` / `left-[96px]`，top 也是它的 15。
        // 200ms ease-out 与它的 `transition-[left] duration-200` 同一时长：
        // 侧栏宽度瞬变、按钮滑过去，所以开合看起来是一次滑动。
        AnimatedPositioned(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
          left: st.sidebarOpen ? OndraSideRail.width - 8 - 32 : 96,
          top: 15,
          child: OndraRailToggle(onTap: st.toggleSidebar, color: s.ink80),
        ),
      ],
    );
  }
}

/// 右栏的宽度轨道：把四个开关状态下压成**一个连续量**。
///
/// 右栏宽度只有三个稳定取值——0（收纳）、280（常驻）、整张纸（沉浸），
/// 但切换有四种。若每个状态各自挂一个 `AnimatedContainer`，会出现三类毛病：
/// ①「右栏被 if 直接换掉」时根本没有中间帧；② 沉浸要从 280 跳到纸宽，
/// 而容器宽度动画只能表达固定目标；③ 收纳到一半点「展开」会把动画打断成
/// 一次跳变。
///
/// 这里只持有一条 [AnimationController]，`_width` 是当前像素宽度：
/// - 状态切换 → 从**当前值**补间到新目标，中途改主意就就地折返；
/// - 只是窗口变宽变窄 → 直接落在目标值，不播动画（否则拖窗口时每一帧都会
///   重新起一次动画，右栏永远慢纸宽半拍）。
///
/// 时长与曲线用 `panel` + `decel`：260～300ms 是「整块面板位移」的量级，
/// `decel` 前段快、后段收，按下第一帧就开始动，收尾才慢慢停住。
class _RailTrack extends StatefulWidget {
  const _RailTrack({
    required this.paperWidth,
    required this.focus,
    required this.open,
    required this.builder,
  });

  final double paperWidth;
  final bool focus;
  final bool open;
  final Widget Function(BuildContext context, double railWidth) builder;

  @override
  State<_RailTrack> createState() => _RailTrackState();
}

class _RailTrackState extends State<_RailTrack>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late double _from;
  late double _to;
  late double _width;

  double get _target => widget.focus
      ? widget.paperWidth
      : (widget.open ? OndraAmbientRail.width : 0.0);

  @override
  void initState() {
    super.initState();
    // 首帧直接落在目标值：应用启动时右栏不该表演一次「自己滑进来」。
    _to = _target;
    _from = _to;
    _width = _to;
    _controller = AnimationController(
      vsync: this,
      duration: OndraMotion.panel,
      value: 1,
    )..addListener(_tick);
  }

  void _tick() {
    final t = OndraMotion.decel.transform(_controller.value);
    final w = _from + (_to - _from) * t;
    if (w == _width) return;
    setState(() => _width = w);
  }

  @override
  void didUpdateWidget(covariant _RailTrack oldWidget) {
    super.didUpdateWidget(oldWidget);
    final target = _target;
    final modeChanged =
        oldWidget.focus != widget.focus || oldWidget.open != widget.open;

    if (!modeChanged) {
      // 状态没变，但上层重建了（切页、改设置、主题切换都会走到这里）。
      // **不能**顺手把宽度归位——那会把正在跑的开合动画掐断成一次跳变。
      // 只有目标值真的被纸宽推着动了（沉浸态下拖窗口），才直接落位：
      // 窗口本身是连续变化的，这里每帧补一次间等于给拖拽加了一层弹性延迟。
      if ((target - _to).abs() < 0.5) return;
      _controller.stop();
      _from = target;
      _to = target;
      _width = target;
      return;
    }

    if ((target - _to).abs() < 0.5) {
      // 动画还在路上、目标却没变（同一次切换被重复通知）：直接归位。
      _controller.stop();
      _width = target;
      return;
    }

    // 起点是**当前**宽度而不是上一个目标：连续点两次菜单时，
    // 第二段从半路接上，不会先弹回起点再走。
    _from = _width;
    _to = target;
    _controller.forward(from: 0);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.builder(context, _width);
}

/// 纸内的横向切分：中栏 + 右栏，由 [railWidth] 一个量推出来。
///
/// 两条重要的规则都写在这里，因为它们必须**同时**成立才不打架：
///
/// 1. **右栏比 280 窄时，内容不重排**（宽度按 280 裁掉左侧）。否则收纳途中
///    表头会一路挤到 0、输入盒从 140 高缩成一条线，200ms 里整栏都在抽搐。
/// 2. **右栏比 280 宽时，中栏不重排**（内容冻结在三栏宽度，被右栏从右侧盖住）。
///    沉浸要的是「对话接管这一屏」，不是「把页面挤成一条」——挤扁的页面
///    会先重排成畸形，再消失，那一段比直接切还难看。
///
/// 于是整个过渡里没有任何一栏发生变形：只有右栏在长，中栏在让。
class _WideSplit extends StatelessWidget {
  const _WideSplit({
    required this.page,
    required this.paperWidth,
    required this.railWidth,
  });

  final Widget page;
  final double paperWidth;
  final double railWidth;

  @override
  Widget build(BuildContext context) {
    final rail = railWidth.clamp(0.0, paperWidth);
    final stage = paperWidth - rail;

    // 中栏排版宽度：右栏窄于 280（收纳途中）时跟着中栏一起变宽；
    // 宽于 280（沉浸途中）时冻结在三栏宽度。
    final stageLayout = math.max(
      stage,
      math.max(paperWidth - OndraAmbientRail.width, 1.0),
    );
    // 右栏排版宽度：低于 280 时冻结，高于 280 时跟随——它要真的变宽，
    // 沉浸才不是「一张 280 宽的图被拉大」。
    final railLayout = math.max(rail, OndraAmbientRail.width);
    // 沉浸程度：0 = 第三栏，1 = 整页。只喂给分界线与神经元底纹。
    final focusAmount = ((rail - OndraAmbientRail.width) /
            math.max(paperWidth - OndraAmbientRail.width, 1.0))
        .clamp(0.0, 1.0);

    return Stack(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              width: stage,
              child: ClipRect(
                child: OverflowBox(
                  alignment: Alignment.centerLeft,
                  minWidth: stageLayout,
                  maxWidth: stageLayout,
                  child: page,
                ),
              ),
            ),
            SizedBox(
              key: OndraChassis.railSlotKey,
              width: rail,
              child: ClipRect(
                // 贴右裁切：右栏是贴着纸的右边缘收进去的，所以变窄时被吃掉的是
                // **左侧**——视觉上像被推进纸边里，而不是被从窗口左侧抽走。
                child: OverflowBox(
                  alignment: Alignment.centerRight,
                  minWidth: railLayout,
                  maxWidth: railLayout,
                  // 收起后这一栏还在树上（保住对话列表的滚动位置与输入框里的
                  // 草稿），但它已经看不见了——所以既要挡住点击，也要挡住
                  // 键盘：否则 Tab 会走进一个宽 0 的输入框，用户打得进去、
                  // 却永远看不到自己打了什么。
                  child: ExcludeFocus(
                    excluding: rail < 1,
                    child: IgnorePointer(
                      ignoring: rail < 1,
                      child: OndraAmbientRail(focusAmount: focusAmount),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
        // 收纳键钉在纸的右上角，**不随右栏开合移动**：右栏本来就贴着纸右缘，
        // 栏内 `right:14` 与栏外 `right:14` 是同一个点。所以开合时它不是
        // 「消失再出现」，而是原地换一身皮（白底 ↔ 透明底，120ms 过渡）。
        //
        // 阈值取半宽：白底要等右栏真的让出位置后再撤，否则会出现一帧
        // 「透明按钮压在中栏内容上」的中间态。
        Positioned(
          right: 14,
          top: 6,
          child: OndraRailActionButton(
            filled: rail < OndraAmbientRail.width * 0.5,
          ),
        ),
      ],
    );
  }
}

/// 压在玻璃上的一张「纸片」。
///
/// 层次只有两层，谁也不叠色：
/// 1. **最底**是窗口那层原生玻璃（AppKit 的 `NSGlassEffectView`），Dart 碰不到；
/// 2. **上面**是这张纸，圆角 12、四周让出 4px，让玻璃沿四边露出一条窄边。
///
/// 那 4px 窄边就是全部的通透感来源：纸与窗缘之间留一道缝，桌面从缝里透出来。
/// 所以纸**必须**是实色不透明的——半透明会让缝与面糊成一片，看不出「纸浮在
/// 玻璃上」这件事。同理纸缘只给一条极淡的投影，用来交代纸张厚度，不能再压
/// 白描边，否则缝里会出现第二根线。
///
/// 纸要 `ClipRRect` 而不是只给 `BorderRadius`：里面的中栏页面自带白底，
/// 不裁的话直角会顶出圆角，四个角就破了。
class _Paper extends StatelessWidget {
  const _Paper({required this.child});

  final Widget child;

  /// 纸与窗缘之间的缝宽。4 是参考应用的实测值，也是肉眼刚好能看出「浮起来」的下限。
  static const double inset = 4;

  /// 纸的圆角。比外壳圆角小 4，两层同心：纸角与窗角平行，看着才是一张对齐的纸。
  static const double radius = 12;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Padding(
      padding: const EdgeInsets.all(inset),
      child: DecoratedBox(
        // 投影画在裁剪之外，否则会被自己的圆角切掉，纸看起来就不浮了。
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(radius),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.06),
              blurRadius: 10,
              offset: const Offset(0, 1),
            ),
          ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(radius),
          child: Container(
            // 实色白：纸下是玻璃，纸本身不能透。
            color: s.content,
            child: child,
          ),
        ),
      ),
    );
  }
}

/// 紧凑形态：内容铺满，两栏改成覆盖式抽屉（左 200 / 右 280）。
class _CompactBody extends StatelessWidget {
  const _CompactBody({required this.page});

  final Widget page;

  @override
  Widget build(BuildContext context) {
    final st = ShellScope.of(context);
    final railOpen = st.railOpen;
    final anyOpen = st.sidebarOpen || railOpen;

    return Stack(
      children: [
        // 紧凑形态同样落在纸上：纸的 4px 缝是整窗的层，不该因为窄窗口就消失。
        Positioned.fill(child: _Paper(child: ClipRect(child: page))),
        // 紧凑形态下两颗浮键都放在左上角一行里：右栏是聊天窗口，永远在场，
        // 它的入口不能跟着页面有无助手声明时隐时现。
        if (!st.sidebarOpen || !st.railOpen)
          Positioned(
            left: 12,
            top: 10,
            child: Row(
              children: [
                if (!st.sidebarOpen) const _FloatingToggle.left(),
                if (!st.sidebarOpen && !st.railOpen) const SizedBox(width: 8),
                if (!st.railOpen) const OndraRailActionButton(filled: true),
              ],
            ),
          ),
        if (anyOpen)
          Positioned.fill(
            child: GestureDetector(
              onTap: () {
                st.sidebarOpen = false;
                st.railOpen = false;
              },
              child: ColoredBox(color: Colors.black.withValues(alpha: 0.16)),
            ),
          ),
        if (st.sidebarOpen)
          const Positioned(
            left: 0,
            top: 0,
            bottom: 0,
            child: _Drawer(fromLeft: true, child: OndraSideRail()),
          ),
        if (railOpen)
          const Positioned(
            right: 0,
            top: 0,
            bottom: 0,
            // [_RailBody] 自己不定宽（宽度由轨道给），抽屉里得有人定：
            // 常驻宽度就是抽屉宽度。
            child: _Drawer(
              fromLeft: false,
              child: SizedBox(
                width: OndraAmbientRail.width,
                child: OndraAmbientRail(),
              ),
            ),
          ),
      ],
    );
  }
}

/// 收起后浮在内容左上角的小按钮（左栏用）。
///
/// 右栏那颗不走这里：它有自己两种形态（见 [OndraRailExpandButton]），
/// 尺寸、圆角、投影都不同，硬塞进同一个开关只会让两边都不对。
class _FloatingToggle extends StatefulWidget {
  const _FloatingToggle.left();

  @override
  State<_FloatingToggle> createState() => _FloatingToggleState();
}

class _FloatingToggleState extends State<_FloatingToggle> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final st = ShellScope.of(context);
    final s = OndraSkin.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: OndraPressable(
        onTap: () => st.toggleSidebar(),
        radius: OndraRadius.md,
        child: Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _hover ? s.fillHover : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Glyph(Glyphs.railToggle, size: 20, color: s.ink80),
        ),
      ),
    );
  }
}

class _Drawer extends StatelessWidget {
  const _Drawer({required this.child, required this.fromLeft});

  final Widget child;
  final bool fromLeft;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.18),
            blurRadius: 20,
            offset: Offset(fromLeft ? 8 : -8, 0),
          ),
        ],
      ),
      child: child,
    );
  }
}

/// 一个模块都没装时的兜底：应用仍然起得来、能开设置、能退出。
class _NoModuleView extends StatelessWidget {
  const _NoModuleView();

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.widgets_outlined, size: 48, color: s.ink25),
          const SizedBox(height: 16),
          Text('没有可用的模块', style: ondraText(15, weight: 500, color: s.ink)),
          const SizedBox(height: 6),
          Text('侧栏为空，但骨架与设置仍然可用', style: ondraText(13, color: s.ink60)),
          const SizedBox(height: 20),
          TextButton(
            onPressed: () => ShellScope.of(context).settingsOpen = true,
            child: Text('打开设置', style: ondraText(13, color: OndraColor.accent)),
          ),
        ],
      ),
    );
  }
}
