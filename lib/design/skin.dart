import 'package:material_ui/material_ui.dart';

import 'tokens.dart';

/// 主题皮肤：把「原始色」解析成一组角色名。
///
/// 页面与组件只通过 `OndraSkin.of(context)` 取色，不判断 brightness。
///
/// 命名的依据是**用途**而不是色值：`shell` 是侧栏与标题栏那层 6% 灰，
/// `content` 是正文白底，`rail` 是右助手栏，`interconnect` 是互联页底板。
/// 四个面层颜色不同但都很浅，靠 1px 发丝线分层——这是原设计的核心手法。
class OndraSkin {
  const OndraSkin._({
    required this.dark,
    required this.content,
    required this.surface,
    required this.shell,
    required this.rail,
    required this.interconnect,
    required this.field,
    required this.ink,
    required this.inkStrong,
    required this.ink85,
    required this.ink80,
    required this.ink60,
    required this.ink45,
    required this.ink40,
    required this.ink30,
    required this.ink25,
    required this.ink20,
    required this.glassEdge,
    required this.divider,
    required this.line,
    required this.lineCard,
    required this.lineSoft,
    required this.lineFaint,
    required this.fill,
    required this.fillHover,
    required this.fillSelected,
    required this.fillFaint,
    required this.accentWash,
    required this.accentWashStrong,
    required this.accentSoft,
    required this.accentSoftHover,
    required this.inverse,
    required this.bubbleInk,
    required this.answerInk,
    required this.hintInk,
  });

  final bool dark;

  /// 正文区白底。
  final Color content;

  /// 面板白（卡片、列表容器）。
  final Color surface;

  /// 外壳 6% 灰：侧栏 + 标题栏。
  final Color shell;

  /// 右助手栏 `#f4f7fa`。
  final Color rail;

  /// 互联页底板 `#fbfbfb`。
  final Color interconnect;

  /// 输入框/搜索框底色。
  final Color field;

  final Color ink;
  final Color inkStrong;
  final Color ink85;
  final Color ink80;
  final Color ink60;
  final Color ink45;
  final Color ink40;
  final Color ink30;
  final Color ink25;
  final Color ink20;

  /// 栏与栏之间的分割线：三栏共用一条，绝对色、1px。
  /// 侧栏毛玻璃的右缘发丝线。玻璃本体在窗口层（AppKit），Dart 不叠色。
  final Color glassEdge;

  final Color divider;

  /// 10% 分隔线（标题栏下缘、面板边框）。
  final Color line;

  /// 8% 卡片描边。
  final Color lineCard;

  /// 5% 侧栏右缘。
  final Color lineSoft;

  /// 4% 列表行分隔。
  final Color lineFaint;

  /// 6% 三级面。
  final Color fill;

  /// 4% hover。
  final Color fillHover;

  /// 8% 按压。
  final Color fillSelected;

  /// 4% 最浅一档：设备卡底、列表 hover。
  final Color fillFaint;

  final Color accentWash;
  final Color accentWashStrong;
  final Color accentSoft;
  final Color accentSoftHover;

  /// 与 surface 相反的那个色（气泡、反色按钮）。
  final Color inverse;

  /// 用户气泡里的字。浅色下是纯黑（参考应用 `.xu-user-content{color:#000}`），
  /// 深色下必须是亮的——气泡底是 10% 蓝，黑字压上去会完全读不出来。
  final Color bubbleInk;

  /// TA 回答的字。浅色下是 88% 黑，深色下统一到正文色。
  final Color answerInk;

  /// 输入框占位符。
  final Color hintInk;

  static const light = OndraSkin._(
    dark: false,
    content: OndraColor.page,
    surface: OndraColor.surface,
    shell: OndraColor.sidebar,
    rail: OndraColor.rail,
    interconnect: OndraColor.interconnect,
    field: OndraColor.surface,
    ink: OndraColor.ink,
    inkStrong: OndraColor.inkStrong,
    ink85: OndraColor.ink85,
    ink80: OndraColor.ink80,
    ink60: OndraColor.ink60,
    ink45: OndraColor.ink45,
    ink40: OndraColor.ink40,
    ink30: OndraColor.ink30,
    ink25: OndraColor.ink25,
    ink20: OndraColor.ink20,
    glassEdge: OndraColor.glassEdge,
    divider: OndraColor.divider,
    line: OndraColor.line,
    lineCard: OndraColor.lineCard,
    lineSoft: OndraColor.lineSoft,
    lineFaint: OndraColor.lineFaint,
    fill: OndraColor.fill,
    fillHover: OndraColor.fillHover,
    fillSelected: OndraColor.fillSelected,
    fillFaint: OndraColor.fillFaint,
    accentWash: OndraColor.accentWash,
    accentWashStrong: OndraColor.accentWashStrong,
    accentSoft: OndraColor.accentSoft,
    accentSoftHover: OndraColor.accentSoftHover,
    inverse: Color(0xFF101318),
    bubbleInk: Color(0xFF000000),
    answerInk: OndraColor.answerInk,
    hintInk: OndraColor.placeholder,
  );

  /// 深色皮肤：2.0.0-alpha 的主题方案只做浅色，这套定义**暂未启用**。
  ///
  /// 它不参与构建——`MaterialApp` 只挂了浅色主题，[OndraSkin.of] 因此永远拿到
  /// [light]。保留在这里是为了方案定稿后能一次接上，不用回头重写角色名。
  static const darkSkin = OndraSkin._(
    dark: true,
    content: OndraColor.darkCanvas,
    surface: OndraColor.darkSurface,
    shell: OndraColor.darkSideGlass,
    rail: OndraColor.darkRail,
    interconnect: OndraColor.darkCanvas,
    field: OndraColor.darkSurface,
    ink: OndraColor.darkInk,
    inkStrong: OndraColor.darkInk,
    ink85: Color(0xD9FFFFFF),
    ink80: Color(0xCCFFFFFF),
    ink60: OndraColor.darkInk60,
    ink45: Color(0x8AFFFFFF),
    ink40: OndraColor.darkInk40,
    ink30: Color(0x4DFFFFFF),
    ink25: Color(0x40FFFFFF),
    ink20: Color(0x33FFFFFF),
    glassEdge: Color(0x1AFFFFFF),
    divider: Color(0xFF2A2E36),
    line: OndraColor.darkLine,
    lineCard: Color(0x14FFFFFF),
    lineSoft: Color(0x0DFFFFFF),
    lineFaint: Color(0x0AFFFFFF),
    fill: Color(0x14FFFFFF),
    fillHover: Color(0x0FFFFFFF),
    fillSelected: Color(0x1AFFFFFF),
    fillFaint: Color(0x0AFFFFFF),
    accentWash: Color(0x1FFFFFFF),
    accentWashStrong: Color(0x33FFFFFF),
    accentSoft: Color(0x1FFFFFFF),
    accentSoftHover: Color(0x14FFFFFF),
    inverse: Color(0xFFF2F4F8),
    bubbleInk: Color(0xF2FFFFFF),
    answerInk: Color(0xE6FFFFFF),
    hintInk: Color(0x66FFFFFF),
  );

  static OndraSkin of(BuildContext context) {
    return Theme.of(context).brightness == Brightness.dark ? darkSkin : light;
  }

  /// 兼容旧字段名，避免一次性改动所有页面时漏掉引用。
  Color get canvas => content;
  Color get stage => shell;
  Color get pane => shell;
  Color get sidebar => shell;
}
