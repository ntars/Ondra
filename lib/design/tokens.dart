import 'package:material_ui/material_ui.dart';

import 'motion.dart';

/// 颜色令牌。
///
/// 分三层：**原始色**（这里）→ **角色名**（[OndraSkin] 里的 canvas / ink / line）
/// → **组件内联**。组件只允许引用角色名，不得直接写死色值。
///
/// 取值不是估的：`black/white` 八级黑度、面层四个灰（`#f6f6f6` 外壳 /
/// `#ffffff` 内容 / `#fbfbfb` 右栏）都来自原设计令牌表，逐条对齐。
///
/// **强调色是黑的，不是蓝的。** 空谷只有一种强调：由黑到灰的明度对比。
/// 名字沿用了 `accent`，是为了让调用点读起来仍然是「强调」这件事，
/// 而不是让每个页面都去直接写 `ink`——将来真要做单色主题切换，只改这里。
class OndraColor {
  const OndraColor._();

  /// 主强调色：选中、CTA、焦点环。取值等于正文色，靠字重与底色区分层级。
  static const accent = Color(0xFF1C1F28);
  static const accentHover = Color(0xFF000000);
  static const accentDeep = Color(0xFF111318);

  /// 强调底三个档：6% 选中、12% 按压、浅灰实底（留给强调块）。
  static const accentWash = Color(0x0F000000);
  static const accentWashStrong = Color(0x1F000000);
  static const accentSoft = Color(0xFFF0F0F0);
  static const accentSoftHover = Color(0xFFF6F6F6);
  static const accentRing = Color(0x33000000);

  static const danger = Color(0xFFFA382E);
  static const warning = Color(0xFFFF9F05);
  static const warningBg = Color(0x1AFF9F05);

  /// 文字梯度：基础正文 [ink]，其余按黑度分级。
  ///
  /// 原设计正文不是纯黑，是 `#1c1f28`（偏蓝的深灰）；二级 80%、三级 60%、
  /// 四级 40%、八级 30%、空态 20%。菜单文字用 80% 而非正文色。
  static const ink = Color(0xFF1C1F28);
  static const inkStrong = Color(0xFF333333);
  static const inkLogin = Color(0xFF191919);
  static const ink85 = Color(0xD9000000); // 85% 侧栏账号名
  static const ink80 = Color(0xCC000000);
  static const ink60 = Color(0x99000000);
  static const ink45 = Color(0x73000000);
  static const ink40 = Color(0x66000000);
  static const ink30 = Color(0x4D000000);
  static const ink25 = Color(0x40000000);
  static const ink24 = Color(0x3D000000);
  static const ink20 = Color(0x33000000);

  /// 线：1px 发丝线。这是本设计语言里替代投影的主要手段。
  ///
  /// **栏与栏之间的分割线用绝对色**（[divider]），不是半透明黑：同样的 5% 黑
  /// 叠在 `#f6f7fa` 与 `#fbfbfb` 上会得到两个值，同屏两条边界线一深一浅，
  /// 看起来就像一粗一细。绝对色与底色无关，两边永远同宽同深。
  ///
  /// 取值对齐参考应用的 `--miclaw-color-border-light: #e9ebf0`（浅色）——
  /// 它是偏冷的灰，比中性灰更贴近玻璃的色相。
  static const divider = Color(0xFFE9EBF0);

  static const line = Color(0x1A000000); // 10% 标题栏下缘 / 分隔线
  static const lineCard = Color(0x14000000); // 8% 卡片描边 / 面板边框
  static const lineSoft = Color(0x0D000000); // 5% 侧栏右缘
  static const lineFaint = Color(0x0A000000); // 4% 列表行分隔

  /// 面：填充块（分组卡、标签底、hover）。
  static const fill = Color(0x0F000000); // 6% 三级面 / 分段选中
  static const fillHover = Color(0x0A000000); // 4% 菜单 hover
  static const fillSelected = Color(0x14000000); // 8% 菜单按压
  static const fillFaint = Color(0x0A000000); // 4% 设备卡底

  /// 面层四灰 + 白。四个灰依次对齐参考应用的
  /// `--miclaw-color-background/surface/surface-muted/surface-inset`。
  static const surface = Color(0xFFFFFFFF);
  static const page = Color(0xFFFFFFFF); // 内容区
  static const sidebar = Color(
    0xFFF6F7FA,
  ); // 侧栏（Web 兜底）/ 参考 --miclaw-color-background
  static const rail = Color(0xFFF4F7FA); // 右栏（对齐参考应用的 copilot 底色 #f4f7fa）

  /// 侧栏毛玻璃的**边缘**（只此一条，没有叠色）。
  ///
  /// 来源：参考应用 `dist/assets/index-HGleJg-V.css`
  /// `--miclaw-glass-edge: rgba(255,255,255,.42)`，用在
  /// `.miclaw-shell-sidebar{border-right:1px solid var(--miclaw-glass-edge)}`。
  ///
  /// 注意这里**没有**「玻璃底色」这一档：参考应用虽然定义了
  /// `--miclaw-glass-background: rgba(255,255,255,.1)`，但全文件没有任何规则
  /// 引用它（唯一的消费者是 win32 的 `--miclaw-sidebar-fallback-tint` 兜底）。
  /// 桌面端的通透感完全由窗口底下那层原生玻璃提供，Dart 侧再叠一层白就会发奶。
  /// Web 没有原生玻璃，才退回不透明的 [sidebar] 实色。
  static const glassEdge = Color(0x6BFFFFFF);
  static const interconnect = Color(0xFFFBFBFB); // 设备互联 / 小米互传内容底
  static const splash = Color(
    0xFFF6F7FA,
  ); // 启动屏兜底实色（参考 --miclaw-glass-background-solid）

  /// 启动屏的玻璃层：参考 `--miclaw-splash-glass-background: rgba(246,246,246,.85)`
  /// 叠 `blur(40px) saturate(1.2)`。Flutter 里没有 backdrop-filter，
  /// 85% 白直接压在窗口那层原生玻璃上，观感等价（能透出一点桌面，又不至于花）。
  static const splashGlass = Color(0xD9F6F6F6);

  /// 右栏对话里的两个专用色，来自参考应用 `.xu-*` 那套 CSS。
  ///
  /// 它们不进 [OndraSkin]：只有对话流用得到，塞进皮肤等于让每个页面都背着
  /// 两个一辈子用不上一次的角色名。
  ///
  /// [userBubble] 是 `#3482ff1a`（蓝 10%）：用户的话用淡蓝打底，和 TA 的白卡
  /// 拉开一档，不必靠描边或箭头去区分谁在说。
  /// [answerInk] 是 `#000000e0`（88% 黑）：比正文浅一点点，长段落看起来不发死。
  static const userBubble = Color(0x1A3482FF);
  static const answerInk = Color(0xE0000000);

  /// 输入框占位符 `#a6afbd`：偏冷的灰，比 `ink25` 更淡更蓝，压在纯白输入盒上不刺。
  static const placeholder = Color(0xFFA6AFBD);

  /// 发送键的蓝。参考应用的投影是 `rgba(47,123,255,.28)`，
  /// 反推主体就是这个色：`#2F7BFF`。
  ///
  /// 它**不**进 [accent]：空谷的强调色是黑的，整个应用只有这一处蓝——
  /// 因为「发送」是一个不可逆动作，值得用唯一的彩色去标记。再多一个蓝，
  /// 这个标记就失效了。
  static const sendBlue = Color(0xFF2F7BFF);

  /// 兼容旧名，值已对齐到新令牌。
  static const canvas = Color(0xFFFFFFFF);
  static const stage = Color(0xFFF6F6F6);
  static const pane = Color(0xFFF6F6F6);
  static const sideGlass = Color(0xFFF6F6F6);
  static const loginBg = Color(0xFFF6F6F6);

  /// 深色：只保留定义，2.0.0-alpha 不启用。
  static const darkCanvas = Color(0xFF10121A);
  static const darkSurface = Color(0xFF191C26);
  static const darkSideGlass = Color(0xFF20242D);
  static const darkRail = Color(0xFF151922);
  static const darkPane = Color(0xFF23272F);
  static const darkInk = Color(0xFFE2E4EA);
  static const darkInk60 = Color(0x99FFFFFF);
  static const darkInk40 = Color(0x66FFFFFF);
  static const darkLine = Color(0x1AFFFFFF);
  static const darkLineFaint = Color(0x14FFFFFF);

  /// 设备插画的固定色（不随主题变，它是「实物」）。
  static const deviceFrameTop = Color(0xFF3A3F47);
  static const deviceFrameBottom = Color(0xFF22262B);
  static const deviceScreenTop = Color(0xFF6FA8FF);
  static const deviceScreenMid = Color(0xFF9B7BFF);
  static const deviceScreenBottom = Color(0xFFFFC1A8);

  /// 应用图标与插画里的灰阶渐变（替换掉原来的蓝紫米三色）。
  static const brandGradient = [
    Color(0xFF3A3F47),
    Color(0xFF1C1F28),
    Color(0xFF0C0E12),
  ];
}

/// 圆角。只保留参考应用实际出现的档位：4 / 6 / 8 / 10 / 12 / 16 / 999。
/// 外壳 8、卡片 12、面板 16 是原设计的原值；曾经有过的 14 / 18 两档
/// 在参考实现的 `border-radius` 分布里不存在（其高频档是 8、16、999、12、10），
/// 留着只会让相邻两张卡差 2px，看起来像没对齐。
class OndraRadius {
  const OndraRadius._();

  static const xs = 4.0;
  static const sm = 6.0;
  static const md = 8.0;
  static const lg = 10.0;
  static const xl = 12.0;
  static const panel = 16.0;
  static const modal = 26.0;
  static const pill = 999.0;

  static BorderRadius all(double v) => BorderRadius.circular(v);
}

/// 间距。基准 4。
class OndraSpace {
  const OndraSpace._();

  static const x1 = 4.0;
  static const x2 = 8.0;
  static const x3 = 12.0;
  static const x4 = 16.0;
  static const x5 = 24.0;
  static const x6 = 32.0;
  static const x7 = 48.0;
  static const x8 = 64.0;
}

/// 字重：可变字体按「原设计的数值」直接给轴值，不做四舍五入到 100 的整数倍。
///
/// 原设计的全局基准是 **330**（参考应用 `dist/assets/index-HGleJg-V.css` 里
/// `body{font-family:MiSans,…;line-height:1.6;font-weight:330;font-synthesis:none;
/// text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased}`），
/// 界面里 380 / 450 / 500 / 600 / 700 都是在它之上的分档。
/// 静态字体会把 330 压平成 300 或 400，可变字体能原样保留——
/// 这一档是「空谷的字看起来细而不虚」与「发挺、发硬」的分界。
FontVariation ondraVariation(int w) => FontVariation('wght', w.toDouble());

/// 静态兜底：桌面端没装上 MiSans 时按整数档取最近字重。
FontWeight ondraWeight(int w) {
  if (w < 350) return FontWeight.w300;
  if (w < 450) return FontWeight.w400;
  if (w < 600) return FontWeight.w500;
  if (w < 700) return FontWeight.w600;
  return FontWeight.w700;
}

/// 字重阶梯，按语义取用，不写裸数字。
///
/// 与参考应用的实际用法一一对应：正文 330、副标/说明 380、页面标题 450、
/// 控件与列表项 500（`font-medium`，它的高频档）、强调 600。
class OndraWeight {
  const OndraWeight._();

  static const body = 330;
  static const subtle = 380;
  static const title = 450;
  static const control = 500;
  static const strong = 600;
}

/// 用户选中的抽象字体族。存的是 `general.fontFamily` 的稳定值，
/// 而不是某个平台的具体字体名：同一个选择在 Windows 与 macOS 上要落到
/// 各自系统自带的中文字体，不能把「微软雅黑」硬编码给 macOS。
String _ondraFontChoice = 'misans';

String get ondraFontChoice => _ondraFontChoice;

bool setOndraFontChoice(String choice) {
  if (!['misans', 'sans', 'serif', 'kai'].contains(choice)) return false;
  _ondraFontChoice = choice;
  return true;
}

/// 主字体族。`misans` 用随包字体；其余选项显式点名系统中文字体，
/// 缺字体时仍沿 [ondraFontFallback] 回退。
String get ondraFontFamily => switch (_ondraFontChoice) {
  'sans' => 'Microsoft YaHei',
  'serif' => 'Songti SC',
  'kai' => 'Kaiti SC',
  _ => 'MiSans',
};

/// 字体回退链：内嵌 MiSans 只收了界面用字，生僻字、符号与
/// 仓库未附带字体文件的情况都靠这条链兜住。
///
/// 顺序按「目标平台默认中文字体」排：macOS 的苹方、iOS 的冬青黑、
/// Windows 的微软雅黑、Linux 的思源黑。**这是唯一真源**，主题层与
/// [ondraText] 都引用它，不要在别处再抄一份。
List<String> get ondraFontFallback {
  final common = <String>[
    'PingFang SC',
    'Hiragino Sans GB',
    'Microsoft YaHei',
    'Noto Sans CJK SC',
    'Source Han Sans SC',
  ];
  final preferred = switch (_ondraFontChoice) {
    'sans' => ['Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC'],
    'serif' => [
      'Songti SC',
      'SimSun',
      'Noto Serif CJK SC',
      'Source Han Serif SC',
    ],
    'kai' => ['Kaiti SC', 'KaiTi', 'STKaiti', 'Noto Serif CJK SC'],
    _ => const <String>[],
  };
  return [
    ...preferred.where((font) => font != ondraFontFamily),
    ...common.where(
      (font) => font != ondraFontFamily && !preferred.contains(font),
    ),
    if (_ondraFontChoice == 'serif') 'Noto Sans CJK SC',
    if (_ondraFontChoice == 'kai') 'Noto Sans CJK SC',
  ];
}

/// 统一的文字构造：字号 / 字重 / 行高 / 字距。
///
/// 字重走 [FontVariation] 而非 [FontWeight]：只声明一个字重的可变字体，
/// 若靠 `fontWeight` 请求 w700，渲染层会补一次**合成加粗**（笔画变糊、
/// 字宽跳动）。显式给轴值既准确又避开合成。
///
/// 同时把 `fontWeight` 对齐到最近整数档：MiSans 子集只收了界面用字，
/// 生僻字会回退到系统字体，那时只有 `fontWeight` 起作用——两者不一致的话，
/// 一句话里会出现两种粗细。
///
/// **深色下会自动减细**（见 [OndraOptics]）：白字压黑底会把笔画往外「渗」一圈，
/// 同一个字重看起来粗 10%～15%。调用点仍然只写语义字重，减细由这一层统一做，
/// 页面里不需要为深色写第二份排版。
TextStyle ondraText(
  double size, {
  int weight = 330,
  Color? color,
  double? height,
  double? spacing,
}) {
  final int w = OndraOptics.weight(weight);
  return TextStyle(
    fontFamily: ondraFontFamily,
    // 显式给回退链：内嵌 MiSans 只收了界面用字，生僻字与符号靠这条链兜；
    // 仓库未附带字体文件时，整段文字也靠它落到系统中文字体。
    fontFamilyFallback: ondraFontFallback,
    fontSize: size,
    fontWeight: ondraWeight(w),
    fontVariations: [ondraVariation(w)],
    color: color,
    height: height,
    letterSpacing: spacing,
    // 中文在桌面上不该被强行撑开字距。
    leadingDistribution: TextLeadingDistribution.even,
  );
}
