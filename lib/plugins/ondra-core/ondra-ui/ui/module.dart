import 'package:flutter/widgets.dart';

/// 侧栏分组。组标签为空时，该组在侧栏里不显示标题。
///
/// 分组是信息的层级，不是视觉的层级：三组共用同一套菜单规格（32 高、
/// 圆角 8、选中 6% 黑底）。旧版里有一个组单独用 40 高 + 实色底，
/// 是因为它当时是「嵌在应用里的另一个应用」；换成空谷自己的信息架构后，
/// 这个例外没有存在理由，留着只会让侧栏出现两种笔重。
///
/// **枚举顺序即侧栏顺序**：概览（状态 / 记忆）→ 空谷生命（每天要用的五件事）
/// → 日志（出问题才翻的三本账）。越靠下越「偶尔才看」，日志垫底。
enum OndraGroup { primary, life, logs }

extension OndraGroupSpec on OndraGroup {
  String? get label => switch (this) {
    OndraGroup.primary => null,
    OndraGroup.life => '空谷生命',
    OndraGroup.logs => '日志',
  };
}

/// 模块契约。
///
/// 一个模块 = 侧栏里的一项 + 它的页面。右栏不在这里声明：右栏是**聊天窗口**，
/// 全应用只有一个，不随页面换名字，也不随页面换建议（见 `frame/ambient_rail.dart`）。
/// 曾经按页换「状态助手 / 记忆助手 / 插件助手」，看起来像十个不同的机器人，
/// 实际上一直是同一个 TA 在说话。
///
/// [core] 为 true 的模块不允许被卸载；其余都可以缺席，缺席时侧栏不渲染该项。
class OndraModule {
  const OndraModule({
    required this.id,
    required this.label,
    required this.glyph,
    required this.group,
    required this.build,
    this.core = false,
  });

  final String id;
  final String label;

  /// 侧栏图标，取自 lucide 0.577，18 见方、2px 描边。
  ///
  /// 18 而不是 22：菜单文字是 14 号，22 的图标比字高出一大截，读起来像
  /// 「图标才是主角」；18 与 14 号字的字面高度接近，两者才像一行。
  final String glyph;

  final OndraGroup group;
  final WidgetBuilder build;

  final bool core;
}
