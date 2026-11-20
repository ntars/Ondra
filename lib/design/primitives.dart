import 'package:material_ui/material_ui.dart';

import 'glyph.dart';
import 'pressable.dart';

export 'pressable.dart';
import 'motion.dart';
import 'skin.dart';
import 'tokens.dart';

/// 发丝线。全应用不用投影分层，靠它与明度差。
class OndraHairline extends StatelessWidget {
  const OndraHairline({super.key, this.axis = Axis.horizontal, this.color});

  final Axis axis;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      width: axis == Axis.horizontal ? double.infinity : 1,
      height: axis == Axis.horizontal ? 1 : double.infinity,
      color: color ?? s.line,
    );
  }
}

/// 窗口拖拽区占位。
///
/// 真实拖拽要靠平台通道（窗口插件），骨架阶段先给出正确的命中范围与光标，
/// 接入窗口能力时把 [child] 换成 `DragToMoveArea` 即可，页面无需改动。
class DragStrip extends StatelessWidget {
  const DragStrip({
    super.key,
    required this.height,
    this.padding = EdgeInsets.zero,
    this.child,
  });

  final double height;
  final EdgeInsets padding;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.grab,
      child: Semantics(
        label: '窗口拖拽区',
        child: Container(
          height: height,
          padding: padding,
          alignment: Alignment.centerLeft,
          child: child,
        ),
      ),
    );
  }
}

/// 开关：轨道 36×16，钮 21×13（椭圆，不是圆），位移 12px。
class OndraSwitch extends StatelessWidget {
  const OndraSwitch({super.key, required this.value, this.onChanged});

  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final enabled = onChanged != null;
    return MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: enabled ? () => onChanged!(!value) : null,
        // 命中区垫到 44×24：轨道视觉 36×16 不变。整行 44 高会撑开
        // 设置行（行内已有自己的最小高度），24 高足够手指落点。
        child: SizedBox(
          width: 44,
          height: 24,
          child: Center(
            child: Opacity(
          opacity: enabled ? 1 : 0.45,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            curve: Curves.easeOut,
            width: 36,
            height: 16,
            decoration: BoxDecoration(
              color: value ? OndraColor.accentDeep : s.fill,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Stack(
              children: [
                AnimatedPositioned(
                  duration: const Duration(milliseconds: 160),
                  curve: Curves.easeOut,
                  left: value ? 13.5 : 1.5,
                  top: 1.5,
                  child: Container(
                    width: 21,
                    height: 13,
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(6.5),
                      boxShadow: const [
                        BoxShadow(
                          color: Color(0x0D000000),
                          blurRadius: 1,
                        ),
                        BoxShadow(
                          color: Color(0x0D000000),
                          blurRadius: 4,
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          ),  // Center（命中区垫层）
        ),  // Opacity
      ),  // SizedBox（命中区）
      ),  // GestureDetector
    );  // MouseRegion
  }
}

/// 分组卡：组标题在卡外，卡只包行。
class OndraSection extends StatelessWidget {
  const OndraSection({
    super.key,
    this.title,
    required this.child,
    this.titlePadding = EdgeInsets.zero,
  });

  final String? title;
  final Widget child;
  final EdgeInsets titlePadding;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null)
          Padding(
            padding: titlePadding,
            child: Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                title!,
                style: ondraText(13, weight: 400, color: s.ink60, height: 18 / 13),
              ),
            ),
          ),
        DecoratedBox(
          decoration: BoxDecoration(
            color: s.fill,
            borderRadius: BorderRadius.circular(OndraRadius.xl),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(OndraRadius.xl),
            child: child,
          ),
        ),
      ],
    );
  }
}

/// 设置行：标题 13/18、描述 12/16、右侧值 12/18。
///
/// 骨架阶段已把描述从 11 抬到 12：11px 不适合承载「决定要不要动手」的说明。
class OndraSettingRow extends StatelessWidget {
  const OndraSettingRow({
    super.key,
    required this.title,
    this.desc,
    this.value,
    this.action,
    this.chevron = false,
    this.danger = false,
    this.disabled = false,
    this.onTap,
    this.horizontalPadding = 16,
    this.showDivider = true,
  });

  final String title;
  final String? desc;
  final String? value;
  final Widget? action;
  final bool chevron;
  final bool danger;
  final bool disabled;
  final VoidCallback? onTap;
  final double horizontalPadding;
  final bool showDivider;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final Color titleColor = disabled
        ? s.ink30
        : danger
        ? OndraColor.danger
        : s.ink;
    final content = Container(
      constraints: const BoxConstraints(minHeight: 42),
      padding: EdgeInsets.symmetric(
        horizontal: horizontalPadding,
        vertical: OndraSpace.x2,
      ),
      decoration: BoxDecoration(
        border: showDivider
            ? Border(bottom: BorderSide(color: s.lineFaint, width: 1))
            : null,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: ondraText(13, color: titleColor, height: 18 / 13),
                ),
                if (desc != null) ...[
                  const SizedBox(height: 2),
                  Text(
                    desc!,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(
                      11,
                      color: disabled ? s.ink25 : s.ink45,
                      height: 14 / 11,
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (value != null) ...[
            const SizedBox(width: OndraSpace.x3),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 230),
              child: Text(
                value!,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: ondraText(12, color: s.ink45, height: 18 / 12),
              ),
            ),
          ],
          if (action != null) ...[
            const SizedBox(width: OndraSpace.x3),
            action!,
          ],
          if (chevron) ...[
            const SizedBox(width: OndraSpace.x2),
            Glyph(Glyphs.chevronRight, size: 16, color: s.ink25),
          ],
        ],
      ),
    );

    if (onTap == null || disabled) {
      return Opacity(opacity: disabled ? 0.45 : 1, child: content);
    }
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        hoverColor: s.fillHover,
        child: content,
      ),
    );
  }
}

/// 分段控件：外 36 高 / 圆角 18，内 32 高 / 圆角 16。
///
/// 选中块是**一块会滑的滑片**，不是逐格改色。
///
/// 上一版给每一格单独做 180ms 的底色过渡，结果是「旧的那格淡出、新的那格
/// 淡入」——两个方块在中间同时半亮，像两次闪烁。参考实现用的是单一滑片
/// （Framer Motion 的 `layoutId` 共享元素）：一个白块从 A 滑到 B，中间没有
/// 第二个亮块。这里用 [AnimatedAlign] 复刻同一件事：滑片只有一个，
/// 位置在 120ms 内咬合过去。
class OndraSegmented extends StatelessWidget {
  const OndraSegmented({
    super.key,
    required this.items,
    required this.index,
    this.onChanged,
    this.width = 396,
    this.height = 36,
  });

  final List<String> items;
  final int index;
  final ValueChanged<int>? onChanged;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final n = items.length;
    // 轨道宽 = 总宽 - 两侧各 2 的内距；每格严格等宽，滑片与格子用同一个值，
    // 少一个像素就会在某一侧露出轨道底色。
    final cellWidth = (width - 4) / n;
    final thumbRadius = height / 2 - 2;

    return Container(
      width: width,
      height: height,
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(
        // 轨道用 4% 填充块，选中项用白色「浮起」——这是 HIG 的标准做法。
        // 反过来的写法（白轨道 + 深选中块）只有 6% 的黑度差，几乎看不出选中态。
        color: s.fill,
        borderRadius: BorderRadius.circular(height / 2),
      ),
      child: Stack(
        children: [
          AnimatedAlign(
            // -1 = 最左，+1 = 最右；只有一格时居中。
            alignment: n == 1
                ? Alignment.center
                : Alignment(-1 + 2 * index / (n - 1), 0),
            duration: OndraMotion.snap,
            curve: OndraMotion.expo,
            child: Container(
              width: cellWidth,
              height: height - 4,
              decoration: BoxDecoration(
                // 深色下选中块要比轨道更亮：往白里提 10%，再压一条 12% 白的
                // 内环——这是 CDS 深色「双环」的做法（外环归零、内环当高光），
                // 在深色里比投影更能交代「这块浮在上面」。
                color: s.dark ? s.fillSelected : s.surface,
                borderRadius: BorderRadius.circular(thumbRadius),
                border: s.dark
                    ? Border.all(color: const Color(0x1FFFFFFF))
                    : Border.all(color: s.lineSoft, width: 0.5),
                // 浅色滑片的双层微投影（0,1,2px / 0,2,6px 各一档）：
                // 单层会显得像贴纸，两层才有纸张被轻微抬起的感觉。
                boxShadow: s.dark
                    ? null
                    : const [
                        BoxShadow(
                          color: Color(0x0A000000),
                          blurRadius: 2,
                          offset: Offset(0, 1),
                        ),
                        BoxShadow(
                          color: Color(0x0D000000),
                          blurRadius: 6,
                          spreadRadius: -1,
                          offset: Offset(0, 2),
                        ),
                      ],
              ),
            ),
          ),
          Row(
            children: [
              for (var i = 0; i < n; i++)
                OndraPressable(
                  onTap: onChanged == null ? null : () => onChanged!(i),
                  radius: thumbRadius,
                  scale: false,
                  // 蒙层会把滑片整个压暗，滑片本身已经在表达选中，
                  // 再叠一层就变成「按下时选中消失」。
                  tint: false,
                  child: SizedBox(
                    width: cellWidth,
                    height: height - 4,
                    child: Center(
                      child: AnimatedDefaultTextStyle(
                        duration: OndraMotion.snap,
                        curve: OndraMotion.expo,
                        style: ondraText(
                          13,
                          weight: i == index
                              ? OndraWeight.control
                              : OndraWeight.body,
                          color: i == index ? s.ink : s.ink60,
                          height: 20 / 13,
                        ),
                        child: Text(items[i]),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

/// 主行动按钮：胶囊形，强调色底。
class OndraPillButton extends StatelessWidget {
  const OndraPillButton({
    super.key,
    required this.label,
    this.onTap,
    this.width = 320,
    this.height = 48,
    this.fontSize = 17,
    this.icon,
    this.filled = true,
  });

  final String label;
  final VoidCallback? onTap;
  final double width;
  final double height;
  final double fontSize;
  final IconData? icon;
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final fg = filled ? Colors.white : s.ink;
    return OndraPressable(
      onTap: onTap,
      radius: height / 2,
      child: AnimatedContainer(
        duration: OndraMotion.snap,
        curve: OndraMotion.expo,
        width: width,
        height: height,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: filled ? OndraColor.accent : s.surface,
          borderRadius: BorderRadius.circular(height / 2),
          border: filled ? null : Border.all(color: s.line),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (icon != null) ...[
              Icon(icon, size: fontSize + 2, color: fg),
              const SizedBox(width: 6),
            ],
            Text(label, style: ondraText(fontSize, weight: 500, color: fg)),
          ],
        ),
      ),
    );
  }
}

/// 小号动作按钮：32–36 高，圆角 10。
class OndraSmallButton extends StatelessWidget {
  const OndraSmallButton({
    super.key,
    required this.label,
    this.onTap,
    this.height = 32,
    this.filled = true,
    this.fontSize = 13,
    this.icon,
  });

  final String label;
  final VoidCallback? onTap;
  final double height;
  final bool filled;
  final double fontSize;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return OndraPressable(
      onTap: onTap,
      radius: OndraRadius.md,
      child: Container(
        height: height,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          color: filled ? OndraColor.accent : s.surface,
          // 8 与侧栏菜单、右栏按钮、日志胶囊同一档圆角；10 会让并排的
          // 两个按钮看起来像两代设计。
          borderRadius: BorderRadius.circular(OndraRadius.md),
          border: filled ? null : Border.all(color: s.line),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(
                icon,
                size: fontSize + 2,
                color: filled ? Colors.white : s.ink60,
              ),
              const SizedBox(width: 4),
            ],
            Text(
              label,
              style: ondraText(
                fontSize,
                weight: 500,
                color: filled ? Colors.white : s.ink60,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 筛选标签：圆角 10，内距 12，选中淡蓝底 + 强调色字。
class OndraTag extends StatelessWidget {
  const OndraTag({
    super.key,
    required this.label,
    required this.selected,
    this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return OndraPressable(
      onTap: onTap,
      radius: OndraRadius.lg,
      // 这里刻意不传 alignment：Container 一旦有 alignment，在非紧约束下会
      // 把自己撑到父级最大宽度，放进 Wrap / Row 就会被拉成整行宽（标签「全部」
      // 占满整行就是这个原因）。改用上下等距内距达成垂直居中，宽度自适应文字。
      child: AnimatedContainer(
        duration: OndraMotion.snap,
        curve: OndraMotion.expo,
        constraints: const BoxConstraints(minHeight: 44),
        padding: const EdgeInsets.symmetric(
          horizontal: OndraSpace.x3,
          vertical: OndraSpace.x3,
        ),
        decoration: BoxDecoration(
          color: selected ? s.accentWash : Colors.transparent,
          borderRadius: BorderRadius.circular(OndraRadius.lg),
        ),
        child: Text(
          label,
          style: ondraText(
            14,
            weight: selected ? 500 : 400,
            color: selected ? OndraColor.accent : s.ink60,
          ),
        ),
      ),
    );
  }
}

/// 图标按钮。默认 28×28 命中区、18 图标。
class OndraIconButton extends StatelessWidget {
  const OndraIconButton({
    super.key,
    required this.icon,
    this.onTap,
    this.size = 28,
    this.iconSize = 18,
    this.color,
    this.tooltip,
  });

  final IconData icon;
  final VoidCallback? onTap;
  final double size;
  final double iconSize;
  final Color? color;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final button = OndraPressable(
      onTap: onTap,
      radius: OndraRadius.md,
      // 28 的命中区缩到 98% 只差 0.56，但投影/图标会整体轻颤一下，
      // 这正好是「按到了」的反馈，所以保留。
      child: Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(OndraRadius.md),
        ),
        child: Icon(icon, size: iconSize, color: color ?? s.ink60),
      ),
    );
    if (tooltip == null) return button;
    return Tooltip(message: tooltip!, child: button);
  }
}

/// 输入框：白底、圆角、聚焦描边。
class OndraField extends StatelessWidget {
  const OndraField({
    super.key,
    this.controller,
    this.hint,
    this.height = 44,
    this.radius = OndraRadius.xl,
    this.obscure = false,
    this.prefixIcon,
    this.fontSize = 14,
    this.autofocus = false,
  });

  final TextEditingController? controller;
  final String? hint;
  final double height;
  final double radius;
  final bool obscure;
  final IconData? prefixIcon;
  final double fontSize;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return SizedBox(
      height: height,
      child: TextField(
        controller: controller,
        obscureText: obscure,
        autofocus: autofocus,
        style: ondraText(fontSize, color: s.ink),
        cursorColor: OndraColor.accent,
        decoration: InputDecoration(
          isDense: true,
          filled: true,
          fillColor: s.surface,
          hintText: hint,
          hintStyle: ondraText(fontSize, color: s.ink25),
          contentPadding: EdgeInsets.symmetric(
            horizontal: prefixIcon == null ? 14 : 38,
            vertical: 12,
          ),
          prefixIcon: prefixIcon == null
              ? null
              : Padding(
                  padding: const EdgeInsets.only(left: 12, right: 8),
                  child: Icon(prefixIcon, size: 16, color: s.ink30),
                ),
          prefixIconConstraints: const BoxConstraints(
            minWidth: 0,
            minHeight: 0,
          ),
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(radius),
            borderSide: BorderSide(color: s.line),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(radius),
            borderSide: BorderSide(color: s.line),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(radius),
            borderSide: const BorderSide(color: OndraColor.accent, width: 1.4),
          ),
        ),
      ),
    );
  }
}

/// 无回弹、可横向滚动的滚动容器。
class OndraScroll extends StatelessWidget {
  const OndraScroll({
    super.key,
    required this.child,
    this.padding = EdgeInsets.zero,
    this.controller,
    this.showBar = true,
  });

  final Widget child;
  final EdgeInsets padding;
  final ScrollController? controller;

  /// 是否画滚动条。
  ///
  /// 侧栏传 false：参考应用的侧栏是 `scrollbar-hide`，而且它是整块玻璃——
  /// 一条 6px 的滚动条压上去，等于在通透的面上贴了一条实色贴纸。
  final bool showBar;

  @override
  Widget build(BuildContext context) {
    final list = SingleChildScrollView(
      controller: controller,
      padding: padding,
      child: child,
    );
    return ScrollConfiguration(
      behavior: const _FlatScrollBehavior(),
      child: showBar
          ? Scrollbar(
              controller: controller,
              thickness: 6,
              radius: const Radius.circular(3),
              child: list,
            )
          : list,
    );
  }
}

class _FlatScrollBehavior extends ScrollBehavior {
  const _FlatScrollBehavior();

  @override
  Widget buildOverscrollIndicator(
    BuildContext context,
    Widget child,
    ScrollableDetails details,
  ) => child;

  @override
  ScrollPhysics getScrollPhysics(BuildContext context) =>
      const ClampingScrollPhysics();
}

/// 滚动边缘渐隐：内容在切口处淡出，而不是被一条硬线切断。
///
/// 渐隐的透明度**不是线性**的。线性渐变（`transparent → black`）在人眼里会先
/// 显得「有一层灰膜」，再突然清晰——因为感知亮度与 α 大致是幂律关系。
/// 参考实现取了 7 档非线性采样，曲线贴合 y≈x^1.5（出处：open-claude-ui
/// `docs/v1` 第三篇「滚动边缘平滑渐变遮罩系统」，实测档位
/// 15%→5.1%、30%→14.9%、45%→30.2%、60%→50.2%、75%→70.2%、87%→85.1%）。
///
/// 另两条规矩同样来自那份取证：
/// - **触顶时顶端不淡出**（第一行必须完整可见），触底时底端不淡出；
/// - 遮罩只作用在滚动内容上，不能盖住外层的底色，否则深色下会出现一块灰斑
///   ——这里用 `dstIn` 只改透明度，不改颜色。
class OndraScrollFade extends StatefulWidget {
  const OndraScrollFade({super.key, required this.child, this.fade = 28});

  final Widget child;

  /// 羽化距离（像素）。28 是右栏这种窄栏的常用值：太短像没做完，
  /// 太长会把第一条消息吃掉半行。
  final double fade;

  @override
  State<OndraScrollFade> createState() => _OndraScrollFadeState();
}

class _OndraScrollFadeState extends State<OndraScrollFade> {
  /// 采样位置（占羽化距离的比例）。
  static const List<double> _stops = [0, 0.15, 0.30, 0.45, 0.60, 0.75, 0.87];

  /// 对应透明度，与 [_stops] 一一对应。
  static const List<double> _alphas = [
    0,
    0.051,
    0.149,
    0.302,
    0.502,
    0.702,
    0.851,
  ];

  bool _atTop = true;
  bool _atBottom = true;

  /// 只有状态真的变了才 setState：滚动每帧都在发通知，
  /// 无条件重建会让整条对话流每帧重排一次。
  bool _sync(bool atTop, bool atBottom) {
    if (atTop == _atTop && atBottom == _atBottom) return false;
    setState(() {
      _atTop = atTop;
      _atBottom = atBottom;
    });
    return true;
  }

  bool _onScroll(ScrollNotification n) {
    final m = n.metrics;
    _sync(m.pixels <= 0.5, m.pixels >= m.maxScrollExtent - 0.5);
    return false;
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, box) {
        final height = box.maxHeight.isFinite && box.maxHeight > 0
            ? box.maxHeight
            : 600.0;
        // 上下两段羽化各不超过视口的 40%，中间必须留出不透明的核心区；
        // 否则矮面板会整块变成半透明。
        final f = (widget.fade / height).clamp(0.0, 0.4);
        final colors = <Color>[];
        final stops = <double>[];

        if (!_atTop) {
          for (var i = 0; i < _stops.length; i++) {
            stops.add(f * _stops[i]);
            colors.add(Color.fromRGBO(0, 0, 0, _alphas[i]));
          }
        }
        final coreStart = _atTop ? 0.0 : f;
        colors.add(const Color(0xFF000000));
        stops.add(coreStart);

        if (!_atBottom) {
          colors.add(const Color(0xFF000000));
          stops.add(1 - f);
          // 底端是上端阶梯的镜像：从 85.1% 一路降到 0，色标必须保持升序，
          // 所以这里按位置正序、透明度倒序取。
          for (var i = 0; i < _stops.length; i++) {
            stops.add(1 - f + f * _stops[i]);
            colors.add(Color.fromRGBO(0, 0, 0, _alphas[_alphas.length - 1 - i]));
          }
        }
        // 两端都不淡出时渐变只剩一个色标；补齐成一段常量黑，
        // 这样 ShaderMask 不会因为色标不足而退化。
        if (colors.length < 2) {
          colors.add(const Color(0xFF000000));
          stops.add(1);
        }

        return NotificationListener<ScrollNotification>(
          onNotification: _onScroll,
          child: NotificationListener<ScrollMetricsNotification>(
            // 首次布局（内容是否超长、能否滚动）只有这条通知，
            // 少了它，短列表会在第一帧多出一段底端渐隐。
            onNotification: (n) {
              final m = n.metrics;
              _sync(m.pixels <= 0.5, m.pixels >= m.maxScrollExtent - 0.5);
              return false;
            },
            child: ShaderMask(
              blendMode: BlendMode.dstIn,
              shaderCallback: (rect) => LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: colors,
                stops: stops,
              ).createShader(rect),
              child: widget.child,
            ),
          ),
        );
      },
    );
  }
}

/// 空态外壳：垂直居中的图标 + 标题 + 说明 + 可选动作。
class OndraEmptyState extends StatelessWidget {
  const OndraEmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.desc,
    this.action,
    this.iconSize = 80,
  });

  final IconData icon;
  final String title;
  final String? desc;
  final Widget? action;
  final double iconSize;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Center(
      child: SizedBox(
        width: 458,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: iconSize,
              height: iconSize,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    OndraColor.accentWash,
                    OndraColor.accent.withValues(alpha: 0.02),
                  ],
                ),
                borderRadius: BorderRadius.circular(iconSize / 2),
              ),
              child: Icon(icon, size: iconSize * 0.42, color: OndraColor.accent),
            ),
            const SizedBox(height: OndraSpace.x5),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 352),
              child: Column(
                children: [
                  Text(
                    title,
                    textAlign: TextAlign.center,
                    style: ondraText(17, weight: 500, color: s.ink, height: 23 / 17),
                  ),
                  if (desc != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      desc!,
                      textAlign: TextAlign.center,
                      style: ondraText(13, color: s.ink60, height: 17 / 13),
                    ),
                  ],
                ],
              ),
            ),
            if (action != null) ...[
              const SizedBox(height: OndraSpace.x8),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}

/// 窗口三键（红黄绿）。骨架期自绘，接入平台窗口能力后应删掉，
/// 交给系统绘制——否则 macOS 上会出现真假两套按钮。
///
/// 尺寸取 macOS 默认：直径 12、中心间距 20（即间隙 8）。
/// 第三枚（最大化）在原应用里是不可用态，用 20% 黑表达而不是灰掉。
class WindowDots extends StatelessWidget {
  const WindowDots({super.key});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _dot(const Color(0xFFFF5F56)),
        const SizedBox(width: 8),
        _dot(const Color(0xFFFDBC2E)),
        const SizedBox(width: 8),
        _dot(const Color(0x33000000)),
      ],
    );
  }

  Widget _dot(Color color) => Container(
    width: 12,
    height: 12,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}
