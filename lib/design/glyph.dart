import 'package:flutter_svg/flutter_svg.dart';
import 'package:material_ui/material_ui.dart';

import 'pressable.dart';

/// 图标资源清单。
///
/// 侧栏十项与通用小图标都取自 lucide 0.577（24 画布、2px 描边、圆角端点）。
/// 统一一套几何是刻意的：侧栏原来的图标来自「小米互联服务」的 22×22 实心
/// 手绘图形，语义全是小米那套（相册 / 笔记 / 查找设备）；信息架构换成空谷
/// 自己的之后，那些图形既表不出意思，又会和新画的混成两种笔重。
///
/// 导入时把 `currentColor` 换成 `#000000`，运行时靠 [BlendMode.srcIn] 上色。
class Glyphs {
  const Glyphs._();

  // 侧栏：状态面板 / 记忆星图 / 日志三项 / 空谷生命五项。
  static const String navStatus = 'assets/icons/nav_status.svg';
  static const String navMemory = 'assets/icons/nav_memory.svg';
  static const String navLogDialog = 'assets/icons/nav_log_dialog.svg';
  static const String navLogPlugin = 'assets/icons/nav_log_plugin.svg';
  static const String navLogSystem = 'assets/icons/nav_log_system.svg';
  static const String navNewChat = 'assets/icons/nav_newchat.svg';
  static const String navPlugin = 'assets/icons/nav_plugin.svg';
  static const String navKnowledge = 'assets/icons/nav_knowledge.svg';
  static const String navHistory = 'assets/icons/nav_history.svg';
  static const String navBackup = 'assets/icons/nav_backup.svg';
  static const String navTransfer = 'assets/icons/nav_transfer.svg';
  static const String navGuide = 'assets/icons/nav_guide.svg';
  static const String navBrowser = 'assets/icons/nav_browser.svg';

  /// 插件列表统一用的应用图标（白底圆角 + 空谷标记），取自插件包 icon.svg。
  /// dsh 内核不用它：那边用 dsh 官方图标（`assets/icons/dsh.png`）。
  static const String plugin = 'assets/icons/plugin.svg';

  static const String railToggle = 'assets/icons/rail_toggle.svg';
  static const String arrowUp = 'assets/icons/arrow_up.svg';

  /// 右栏折叠键的图标，**两态共用一枚**。
  ///
  /// 曾经这里有两枚：展开态用这个框、收起态用一枚蓝色四弧环（取自参考应用
  /// 的两个组件）。但同一颗按钮在两种状态下换掉整个图形，等于让它看起来像
  /// 两个不同的东西——用户得先认出「这是同一颗」，才能理解「我刚才是点了它」。
  /// 一枚图标 + 一个位置，点一下就是切换，认知成本最低。
  static const String railCollapse = 'assets/icons/rail_collapse.svg';

  /// 展开：四角向外。用在「让对话接管中栏」这颗键上，
  /// 两态也共用一个图形——它表达的是同一个动作的两个方向。
  static const String expand = 'assets/icons/expand.svg';
  static const String trash = 'assets/icons/trash.svg';
  static const String edit = 'assets/icons/edit.svg';
  static const String download = 'assets/icons/download.svg';

  // 通用小图标：与侧栏同一套 lucide，只是画得更小。
  static const String chevronRight = 'assets/icons/chevron_right.svg';
  static const String chevronDown = 'assets/icons/chevron_down.svg';
  static const String chevronLeft = 'assets/icons/chevron_left.svg';
  static const String close = 'assets/icons/close.svg';
  static const String check = 'assets/icons/check.svg';
  static const String search = 'assets/icons/search.svg';
  static const String plus = 'assets/icons/plus.svg';
  static const String info = 'assets/icons/info.svg';
  static const String send = 'assets/icons/send.svg';
  static const String sparkles = 'assets/icons/sparkles.svg';
  static const String more = 'assets/icons/more.svg';
  static const String spinner = 'assets/icons/spinner.svg';
  static const String refresh = 'assets/icons/refresh.svg';
  static const String external = 'assets/icons/external.svg';
}

/// 画一个图标。[color] 为空时保持 SVG 自带颜色（彩色应用图标用这种方式）。
class Glyph extends StatelessWidget {
  const Glyph(this.asset, {super.key, this.size = 22, this.color});

  final String asset;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return SvgPicture.asset(
      asset,
      width: size,
      height: size,
      colorFilter: color == null
          ? null
          : ColorFilter.mode(color!, BlendMode.srcIn),
    );
  }
}

/// 图标按钮：命中区方形，图标居中，hover 时铺 6% 黑底。
///
/// 与 [Glyph] 分开是因为按钮要考虑命中区、tooltip 与 hover，
/// 而图标只负责画。
class GlyphButton extends StatefulWidget {
  const GlyphButton({
    super.key,
    this.hitSize = -1,
    required this.glyph,
    required this.onTap,
    this.size = 28,
    this.glyphSize = 16,
    this.color,
    this.tooltip,
    this.radius = 8,
  });

  final String glyph;
  final VoidCallback? onTap;
  final double size;
  final double glyphSize;
  final Color? color;
  final String? tooltip;
  final double radius;

  /// 命中区边长；-1（默认）等于 [size]。触屏上的小图标键要给 44——
  /// 视觉不变，只是把透明的命中层垫大。
  final double hitSize;

  @override
  State<GlyphButton> createState() => _GlyphButtonState();
}

class _GlyphButtonState extends State<GlyphButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? const Color(0xFF636878);
    // onTap 为 null = 真禁用：没有点击光标、没有 hover 高亮、不响应按压。
    // 之前调用方传 () {} 造出过「点了没反应」的假按钮（备份忙时的删除键）。
    final enabled = widget.onTap != null;
    final button = MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: enabled ? (_) => setState(() => _hover = true) : null,
      onExit: enabled ? (_) => setState(() => _hover = false) : null,
      child: OndraPressable(
        onTap: widget.onTap,
        radius: widget.radius,
        scale: widget.size >= 32,
        child: Container(
          width: widget.hitSize > 0 ? widget.hitSize : widget.size,
          height: widget.hitSize > 0 ? widget.hitSize : widget.size,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: _hover ? const Color(0x0A000000) : Colors.transparent,
            borderRadius: BorderRadius.circular(widget.radius),
          ),
          child: SizedBox(
            width: widget.size,
            height: widget.size,
            child: Center(
              child: Glyph(widget.glyph, size: widget.glyphSize, color: color),
            ),
          ),
        ),
      ),
    );
    if (widget.tooltip == null) return button;
    return Tooltip(message: widget.tooltip!, child: button);
  }
}
