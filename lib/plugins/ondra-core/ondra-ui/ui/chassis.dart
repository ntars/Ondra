import 'dart:math' as math;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:material_ui/material_ui.dart';

import './registry.dart';
import './shell_state.dart';
import '../../../../app/i18n.dart';
import '../../../../design/form_factor.dart';
import '../../../../design/glyph.dart';
import '../../../../design/motion.dart';
import '../../../../design/native_glass.dart';
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
/// 三种形态：
/// - **手机**（`ondraIsMobile`）：**聊天就是主界面**，其余功能收进侧边抽屉。
///   判据是平台，不是宽度——见 `design/form_factor.dart` 的说明。
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
    // 手机不走宽度阈值，直接按平台决定形态。
    if (ondraIsMobile) return const _MobileBody();
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
      // 整窗透明的前提是**底下真的有一层玻璃**：macOS 由
      // `macos/Runner/MainFlutterWindow.swift` 往 contentView 最底层插
      // `NSGlassEffectView`（取不到就回退 `NSVisualEffectView`），
      // 侧栏画透明让那层露出来，内容区与右栏自己画实色。
      //
      // Windows / Linux 的 runner 是 Flutter 默认模板，**没有任何玻璃层**，
      // 此时画透明露出来的是窗口自己的底色：深色主题下侧栏本该是 #20242D，
      // 实际是一片亮底，像深色纸上贴了条白胶布。所以那两处必须退回实色
      // `s.shell`（它就是「没有玻璃时侧栏该是什么颜色」）。
      //
      // Web 同理：浏览器里不存在 behind-window 合成。
      color: ondraHasNativeGlass ? Colors.transparent : s.shell,
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
            //
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

/// 手机形态：**聊天是主界面**，其余功能收进左侧抽屉。
///
/// ## 为什么是聊天而不是「页面」
///
/// 桌面是三栏并置：左栏导航、中栏看页、右栏说话。手机只有一列，必须选一个
/// 常驻。选聊天，因为它是**每天都发生的事**；状态面板、日志、备份是偶尔才
/// 翻的。把偶尔的那件事放在首屏，等于每天打开应用先看到一堆不用管的数字。
///
/// 这也是「空谷」这个产品的形状：它是一个会说话的东西，不是一个仪表盘。
///
/// ## 层次
///
/// 1. 最底：聊天，铺满整屏（`OndraAmbientRail` 在满宽下自己会做阅读限宽）；
/// 2. 之上：功能页。选中侧栏里的一项就盖上来，左上角有返回键回到聊天；
/// 3. 再上：侧边抽屉（导航）、设置面板、时间线。
///
/// 功能页是**盖上来**而不是「换掉聊天」：换掉就得在返回时重建聊天页，
/// 滚动位置与输入框草稿都会丢。盖着时聊天仍在树上，只是被覆盖。
///
/// ## 安全区
///
/// 顶部交给聊天/页面自己的表头（它们本来就留了 48 的画布），底部留
/// [ondraMobileBottomInset]：刘海屏的 home 指示条会压住输入框。
class _MobileBody extends StatelessWidget {
  const _MobileBody();

  @override
  Widget build(BuildContext context) {
    final st = ShellScope.of(context);
    final s = OndraSkin.of(context);

    final module = OndraRegistry.byId(st.activeId) ??
        (OndraRegistry.available.isEmpty ? null : OndraRegistry.available.first);
    final page = module == null
        ? const _NoModuleView()
        : KeyedSubtree(
            key: ValueKey(module.id),
            child: Builder(builder: module.build),
          );

    // 网页与桌面同一套规则：它被动出现，顶替当前页。
    final content = AnimatedBuilder(
      animation: browserClient,
      builder: (context, _) => browserClient.visible
          ? BrowserPage(onClose: browserClient.close)
          : page,
    );

    final bottom = ondraMobileBottomInset(context);
    // 键盘弹出时把聊天整体顶上去。
    //
    // 桌面没有这回事：窗口高度固定，键盘是外设。手机上键盘会盖住屏幕下方
    // 三分之一，而输入框就在底部——不顶的话，用户正在打的字被键盘压住，
    // 只能盲打。
    //
    // 为什么不用 `Scaffold` 的 `resizeToAvoidBottomInset`：整个应用没有
    // `Scaffold`（三栏是自绘的），而且那条逻辑会连功能页一起顶，功能页
    // 不需要——它们没有输入框在底部。所以只给聊天这一层加。
    final keyboard = MediaQuery.viewInsetsOf(context).bottom;
    // 顶部安全区：刘海与状态栏。外壳的底色铺到最顶（刘海后面也是同一块底），
    // 但**内容**要让开——聊天表头 48 高，正好在状态栏下面，不让开会被盖住。
    final top = MediaQuery.paddingOf(context).top;

    return ColoredBox(
      color: s.shell,
      child: Stack(
        children: [
          // 第一层：聊天。`focusAmount: 1` 让它按整页处理——不画左分界线、
          // 不铺神经元底纹，正文做 720 的阅读限宽并居中。
          Positioned.fill(
            child: Padding(
              padding: EdgeInsets.only(top: top, bottom: bottom + keyboard),
              child: const OndraAmbientRail(focusAmount: 1),
            ),
          ),

          // 第二层：功能页 + 它的返回键。
          if (st.mobilePageOpen)
            Positioned.fill(
              child: Padding(
                // 功能页自己顶上有一条 48 的 DragStrip（`OndraPage` 的画布），
                // 那在手机上不是拖拽区，只是留白。让开状态栏后它刚好当
                // 「导航栏下面的一条呼吸区」，所以这里只补顶部安全区。
                padding: EdgeInsets.only(top: top),
                child: _MobilePageLayer(
                  bottomInset: bottom,
                  onBack: st.closeMobilePage,
                  child: content,
                ),
              ),
            ),

          // 第三层：侧边抽屉。导航就是桌面那条左栏，宽度按屏宽收窄。
          if (st.sidebarOpen) _MobileDrawer(topInset: top, onClose: () => st.sidebarOpen = false),

          // 抽屉入口。功能页盖着时用页面自己的返回键，这里就不再画一颗，
          // 否则左上角会出现两个按钮，一个返回聊天、一个开抽屉，含义打架。
          if (!st.mobilePageOpen && !st.sidebarOpen)
            Positioned(
              left: 8,
              // 让开状态栏：这颗按钮是聊天页的操作入口，压在刘海下面点不到。
              top: top + 6,
              child: _MobileBarButton(
                glyph: Glyphs.railToggle,
                tooltip: '打开导航',
                onTap: () => st.sidebarOpen = true,
              ),
            ),

          if (st.settingsOpen)
            Positioned.fill(
              child: ConsoleSheet(onClose: () => st.settingsOpen = false),
            ),
          if (st.timelineOpen)
            Positioned.fill(
              child: TimelineStage(onClose: () => st.timelineOpen = false),
            ),
        ],
      ),
    );
  }
}

/// 手机上盖在聊天之上的功能页：一条返回条 + 页面本身。
class _MobilePageLayer extends StatelessWidget {
  const _MobilePageLayer({
    required this.child,
    required this.onBack,
    required this.bottomInset,
  });

  final Widget child;
  final VoidCallback onBack;
  final double bottomInset;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return ColoredBox(
      color: s.content,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 返回条：44 高是 iOS 导航栏的常规高度，也是拇指点得准的下限。
          // 它与下面的页面共用同一个底色，所以看起来是页面顶上多了一条
          // 可点的区域，而不是「页面上又压了一个工具条」。
          SizedBox(
            height: 44,
            child: Row(
              children: [
                _MobileBarButton(
                  glyph: Glyphs.chevronLeft,
                  tooltip: '返回对话',
                  onTap: onBack,
                ),
                Expanded(
                  child: Text(
                    OndraI18nScope.translate(
                      context,
                      OndraRegistry.byId(ShellScope.of(context).activeId)?.label ?? '',
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(15, weight: 600, color: s.ink, height: 1),
                  ),
                ),
                const SizedBox(width: 12),
              ],
            ),
          ),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: bottomInset),
              child: child,
            ),
          ),
        ],
      ),
    );
  }
}

/// 从左侧滑出的导航抽屉。
///
/// 宽度取屏宽的 78%（上限 300）：再宽会把内容全遮住，失去「这是盖在上面
/// 的一层」的感觉；再窄则菜单文字会挤成两行。
class _MobileDrawer extends StatelessWidget {
  const _MobileDrawer({required this.onClose, required this.topInset});

  final VoidCallback onClose;

  /// 顶部安全区：抽屉里的侧栏表头同样会被刘海压住。
  final double topInset;

  @override
  Widget build(BuildContext context) {
    final st = ShellScope.of(context);
    final screenWidth = MediaQuery.sizeOf(context).width;
    final width = (screenWidth * 0.78).clamp(200.0, 300.0);

    return Stack(
      children: [
        // 遮罩：点一下关掉。28% 是「能看出底下的东西还在，但明显不是当前层」
        // 的常用档位，比 16% 更能表明这是一层模态。
        Positioned.fill(
          child: GestureDetector(
            onTap: onClose,
            child: ColoredBox(color: Colors.black.withValues(alpha: 0.28)),
          ),
        ),
        Align(
          alignment: Alignment.centerLeft,
          child: SizedBox(
            width: width,
            child: _Drawer(
              fromLeft: true,
              child: Material(
                type: MaterialType.transparency,
                child: SizedBox(
                  width: width,
                  // 抽屉比侧栏宽（侧栏写死 200），留着一条空白边会让它看起来
                  // 「没做完」。这里铺一层抽屉底色，侧栏浮在上面。
                  child: ColoredBox(
                    color: OndraSkin.of(context).shell,
                    // 手机上选中一项 = 离开聊天去看那一页。桌面传 null 走默认。
                    child: Padding(
                      padding: EdgeInsets.only(top: topInset),
                      child: OndraSideRail(onSelected: st.openMobilePage),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// 手机上的一颗图标按钮：44×44 触摸目标，图标 20。
///
/// 44 是 Apple HIG 的最小可点尺寸，也是 Material 的 48 之下能接受的下限。
/// 桌面的 24 圆按钮在手机上点不准——那是给鼠标 1px 精度的目标设计的。
class _MobileBarButton extends StatelessWidget {
  const _MobileBarButton({
    required this.glyph,
    required this.onTap,
    this.tooltip,
  });

  final String glyph;
  final VoidCallback onTap;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final button = GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: SizedBox(
        width: 44,
        height: 44,
        child: Center(child: Glyph(glyph, size: 20, color: s.ink80)),
      ),
    );
    if (tooltip == null) return button;
    // 手机上没有 hover，tooltip 靠长按出现；它同时是给读屏用的语义标签。
    return Tooltip(message: tooltip!, child: button);
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
