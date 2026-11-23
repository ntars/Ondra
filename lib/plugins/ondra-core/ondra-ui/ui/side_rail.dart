import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:material_ui/material_ui.dart';

import './module.dart';
import './registry.dart';
import './shell_state.dart';
import '../../../../app/i18n.dart';
import '../../../../design/brand.dart';
import '../../../../design/glyph.dart';
import '../../../../design/native_glass.dart';
import '../../../../design/primitives.dart';
import '../../../../design/skin.dart';
import '../../../../design/tokens.dart';
import '../ondra-settings/ondra-persona/ui/persona_client.dart';

/// 左侧导航：200 宽，折叠时宽度归零并淡出，不推挤内容之外的东西。
///
/// 尺寸与间隙都取自原实现：表头 48（`h-12`，左右各 14）、菜单区左右 10、
/// 顶部 6、项间 1px、菜单项 32 高、圆角 8、图标 18 见方。
class OndraSideRail extends StatelessWidget {
  const OndraSideRail({super.key, this.onSelected});

  /// 选中某一项时**额外**要做的事。
  ///
  /// 桌面传 null：切页就是 `activeId = id`，三栏并置，人还站在原地。
  /// 手机必须传：那边聊天是主界面，选中一项意味着「离开聊天去看那一页」，
  /// 要同时把功能页盖上来、把抽屉收掉（见 `ShellState.openMobilePage`）。
  ///
  /// 做成参数而不是「让 `ShellState` 自己猜」：同一个侧栏在两种形态下的
  /// 行为不同，把它写进状态类等于让 `ShellState` 知道「现在是不是手机」，
  /// 那一层就不该认识界面形态。
  final ValueChanged<String>? onSelected;

  static const double width = 200;
  static const double headerHeight = 48;

  @override
  Widget build(BuildContext context) {
    final st = ShellScope.of(context);
    final open = st.sidebarOpen;
    return AnimatedContainer(
      duration: const Duration(milliseconds: 200),
      curve: Curves.easeOut,
      width: open ? width : 0,
      child: ClipRect(
        child: OverflowBox(
          alignment: Alignment.centerLeft,
          minWidth: width,
          maxWidth: width,
          child: Opacity(
            opacity: open ? 1 : 0,
            child: IgnorePointer(
              ignoring: !open,
              child: _SideBody(onSelected: onSelected),
            ),
          ),
        ),
      ),
    );
  }
}

class _SideBody extends StatelessWidget {
  const _SideBody({this.onSelected});

  final ValueChanged<String>? onSelected;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      width: OndraSideRail.width,
      decoration: BoxDecoration(
        // **有原生玻璃时这里必须是全透明。**
        // 参考应用 `.miclaw-shell-surface` 是 `background:transparent` +
        // `backdrop-filter:none`，`.miclaw-shell-sidebar{background:transparent}`，
        // 也就是说侧栏本身**不画任何东西**，通透感 100% 来自窗口底下那层
        // NSGlassEffectView / NSVisualEffectView。之前这里叠了
        // `--miclaw-glass-background`(10% 白)——那个令牌在参考应用的 CSS 里
        // 定义了却没有任何规则引用（唯一使用者是 win32 的 fallback tint），
        // 叠上去会把 Liquid Glass 的折射压掉一层，看起来发奶、发闷。
        //
        // **没有玻璃时必须实色。** Windows / Linux 的 runner 是 Flutter 默认
        // 模板，底下没有那一层，画透明就露窗口底色：深色主题下侧栏本该是
        // #20242D，实际露出的是一片亮底。`s.shell` 本来就是「无玻璃时侧栏
        // 该是什么颜色」，浅色深色各自成立。
        color: ondraHasNativeGlass ? Colors.transparent : s.shell,
        // **不画右缘分界线。** 以前这里有一条 `glassEdge`（42% 白）的发丝线，
        // 那是侧栏还紧贴中栏时的做法：两块实色相接，必须有根线分层。
        // 现在侧栏与纸片之间隔了 4px 玻璃缝——缝本身就是分界，再贴一根白线，
        // 就等于在玻璃上画了一道亮痕，深色下尤其刺眼（浅色下也显得脏）。
      ),
      child: Column(
        children: [
          const _SideHeader(),
          Expanded(
            child: OndraScroll(
              showBar: false,
              padding: const EdgeInsets.fromLTRB(10, 6, 10, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final group in OndraGroup.values)
                    if (OndraRegistry.byGroup(group).isNotEmpty)
                      _GroupBlock(group: group, onSelected: onSelected),
                ],
              ),
            ),
          ),
          const _AccountRow(),
        ],
      ),
    );
  }
}

/// 侧栏表头：只放红绿灯。
///
/// 折叠键不在这里：它要随侧栏开合在「侧栏内右缘」与「内容区左缘」之间滑动，
/// 放在侧栏里就会被裁掉。壳层用 `AnimatedPositioned` 统一放那一颗按钮，
/// 参考应用也是这么做的（标题组 `translate-x` + 200ms ease-out）。
class _SideHeader extends StatelessWidget {
  const _SideHeader();

  @override
  Widget build(BuildContext context) {
    // 只在浏览器预览里画三键：桌面构建的红绿灯是系统画的，Dart 再画一遍
    // 就会在同一个位置出现两组圆点。系统那三颗在 (24,24)，圆心约 y=31。
    final showDots = kIsWeb && MediaQuery.sizeOf(context).width >= 620;

    return DragStrip(
      height: OndraSideRail.headerHeight,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      child: Stack(
        children: [
          if (showDots) const Positioned(left: 0, top: 18, child: WindowDots()),
        ],
      ),
    );
  }
}

/// 折叠 / 展开键：32×32、圆角 8、hover 6% 黑底，图标 19。
///
/// 取自参考应用的 `Pct()`（浮动折叠键）：
/// `top-[15px] h-[32px] w-[32px] rounded-lg ... hover:bg-black/[0.06]
/// transition-[left] duration-200`，`left` 展开 `160`、收起 `96`。
/// 也就是说**动的是按钮，不是侧栏宽度**：`sidebar-transition{transition:none}`
/// 让宽度瞬变，只有这颗按钮在 200ms 里滑过去，所以整组开合看起来是一次滑动。
/// 位置由壳层决定（160 = 200 - 8 - 32，收起落到 96，正好避开 (24,24) 的红绿灯）。
class OndraRailToggle extends StatefulWidget {
  const OndraRailToggle({super.key, required this.onTap, this.color});

  final VoidCallback onTap;
  final Color? color;

  @override
  State<OndraRailToggle> createState() => _OndraRailToggleState();
}

class _OndraRailToggleState extends State<OndraRailToggle> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: OndraPressable(
        onTap: widget.onTap,
        radius: OndraRadius.md,
        child: Container(
          width: 32,
          height: 32,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _hover ? s.fill : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Glyph(
            Glyphs.railToggle,
            size: 19,
            color: widget.color ?? s.ink80,
          ),
        ),
      ),
    );
  }
}

class _GroupBlock extends StatelessWidget {
  const _GroupBlock({required this.group, this.onSelected});

  final OndraGroup group;
  final ValueChanged<String>? onSelected;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    // 分组标题也要翻：侧栏是切语言后第一眼看到的东西，
    // 只翻页面内容、不翻侧栏，切过去会像「一半没生效」。
    //
    // 用 `OndraI18nScope.translate(context, …)` 而不是全局的 `t(…)`：
    // 只有前者会把当前 element 登记成依赖者，语言一变框架才会
    // `markNeedsBuild` 它。用 `t(…)` 读到的值同样对，但不会重建——
    // 而这整条链上有 `const`，重建传不下来（见 `i18n.dart`）。
    final rawLabel = group.label;
    final label = rawLabel == null
        ? null
        : OndraI18nScope.translate(context, rawLabel);
    final modules = OndraRegistry.byGroup(group);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (label != null)
          Padding(
            // mt-17 / pb-12 / pl-8 pr-12，11px/700 40% 黑。
            padding: const EdgeInsets.only(
              left: 8,
              right: 12,
              top: 17,
              bottom: 12,
            ),
            child: Text(
              label,
              style: ondraText(
                11,
                weight: 700,
                color: s.ink40,
                height: 14 / 11,
              ),
            ),
          ),
        for (final m in modules) _MenuItem(module: m, onSelected: onSelected),
      ],
    );
  }
}

/// 菜单项：32 高 / 圆角 8 / 选中 6% 黑底 + 近黑字。
///
/// 逐项对齐参考应用的 `Act` 串：
/// `h-8 gap-[6px] rounded-lg pl-2 pr-2.5 text-[14px] font-medium leading-4 text-black/80`，
/// 以及 `.miclaw-sidebar-menu-item:hover{background:#0000000f}`（6%）、
/// `-selected{background:#3482ff14}`（选中只换底色与字色，**不改字重**）。
///
/// 图标比参考小 4px（18 而非 22，用户定的），所以间距补 4：8 + 18 + 10 = 36，
/// 与参考 `8 + 22 + 6 = 36` 的文字起点完全一致，整列的左边线仍然对齐。
class _MenuItem extends StatefulWidget {
  const _MenuItem({required this.module, this.onSelected});

  final OndraModule module;
  final ValueChanged<String>? onSelected;

  @override
  State<_MenuItem> createState() => _MenuItemState();
}

class _MenuItemState extends State<_MenuItem> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final st = ShellScope.of(context);
    final s = OndraSkin.of(context);
    final selected = st.activeId == widget.module.id;
    // 参考应用：hover 6% 黑、按下 4% 黑、选中 6% 黑——hover 与选中同深。
    final bg = selected ? s.accentWash : (_hover ? s.fill : Colors.transparent);

    return Padding(
      padding: const EdgeInsets.only(bottom: 1),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          onTap: () {
            // 手机形态要先做「盖住聊天 + 收抽屉」，再谈切页；桌面形态没有
            // 回调，直接切页即可。顺序不能反：`openMobilePage` 内部会一次性
            // 设好三件事，先设 `activeId` 会多触发一次通知。
            final hook = widget.onSelected;
            if (hook != null) {
              hook(widget.module.id);
            } else {
              st.activeId = widget.module.id;
            }
          },
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 140),
            height: 32,
            padding: const EdgeInsets.only(left: 8, right: 10),
            decoration: BoxDecoration(
              color: bg,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                _MenuGlyph(module: widget.module, selected: selected),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    OndraI18nScope.translate(context, widget.module.label),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(
                      14,
                      // 选中不加重：参考应用的 selected 只改底色与字色。
                      weight: 500,
                      color: selected ? s.ink : s.ink80,
                      height: 16 / 14,
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

/// 图标 18 见方，统一 lucide 线稿；选中近黑，其余 80% 黑。
class _MenuGlyph extends StatelessWidget {
  const _MenuGlyph({required this.module, required this.selected});

  final OndraModule module;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Glyph(module.glyph, size: 18, color: selected ? s.ink : s.ink80);
  }
}

/// 身份行：头像固定是空谷标记，名字是当前人设包。
///
/// 空谷没有「登录」这一步，所以这里不是账号入口，而是**人设入口**：
/// 点它打开设置的「人设」页，那里换人设包。
class _AccountRow extends StatefulWidget {
  const _AccountRow();

  @override
  State<_AccountRow> createState() => _AccountRowState();
}

class _AccountRowState extends State<_AccountRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final st = ShellScope.of(context);
    final s = OndraSkin.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hover = true),
        onExit: (_) => setState(() => _hover = false),
        child: GestureDetector(
          onTap: () {
            st.settingsPane = ShellPane.persona;
            st.settingsOpen = true;
          },
          child: Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: _hover ? s.fillHover : Colors.transparent,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                const OndraAvatar(size: 28),
                const SizedBox(width: 10),
                // 名字来自 `ondra-persona` 插件，切人设时这一行自己会变。
                Expanded(
                  child: AnimatedBuilder(
                    animation: personaClient,
                    builder: (context, _) => Text(
                      ondraPersonaName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ondraText(
                        13,
                        weight: 500,
                        color: s.ink85,
                        height: 16 / 13,
                      ),
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
