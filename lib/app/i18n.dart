import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:material_ui/material_ui.dart'
    show InheritedNotifier, BuildContext;
import 'package:flutter/services.dart' show rootBundle;

/// 界面语言包。
///
/// ## 为什么键是简体中文原文
///
/// 常规做法是给每条文案起一个 key（`nav.status`），再维护两份表。这里不这么做，
/// 有两个具体理由：
///
/// 1. **键会腐烂。** 一个 key 只能靠人记住它对应哪句话；改了中文忘了改 key，
///    英文就永远停在旧文案上，而且没人会发现——两处都不报错。
///    拿原文当键，改了中文等于换了一个键，英文立刻退回原文（看得见），
///    而不是继续显示一句错的话（看不见）。
/// 2. **覆盖率可以长。** 这个应用有近千条中文字面量，一次性全提取出来
///    只会得到一张大半空着的表。原文当键之后，翻译是**纯增量**的：
///    多写一条就多生效一条，没写的照常显示中文，不需要改任何调用点。
///
/// 代价是英文表里存的是一条条完整句子（比 `nav.status` 长），文件大一些。
/// 一份语言包几十 KB，比「翻译悄悄失效」便宜得多。
///
/// ## 词条缺失时返回原文，不返回空串
///
/// 返回空串会让界面出现一片空白，用户以为功能坏了。返回中文至少是
/// 「这句还没翻译」——能读、能查、能报。这条与 `font_face.dart` 的降级
/// 是同一个原则：**缺资源是可预期状态，不是错误。**
///
/// ## 插值
///
/// 中文里有大量「共 {n} 个」这类句子。用 `{name}` 占位而不是
/// `String.format` 的位置参数：位置参数在改语序的语言里会错位，
/// 而命名占位符不会。
///
/// ## 为什么必须配一层 `InheritedNotifier`
///
/// 翻译要在**几百处**读同一个单例，其中大量位置拿不到 `BuildContext`
/// （模块表里的 `const` 字段、纯数据的 `spec.label`、`static` 方法）。
/// 所以 `t()` 直接读全局单例，不走 `of(context)`。
///
/// 这带来一个大坑，实测踩过：**`const` 会让重建传不下去。**
/// Flutter 的 `Element.updateChild` 在 `child.widget == newWidget` 时
/// 直接复用旧 element、不调用 `update()`；一个 `const OndraSideRail()`
/// 每次 build 都是同一个实例，于是「应用根重建了」这件事到那一层就断了，
/// 整棵子树一个 `build` 都不跑。表现是**切了语言界面毫无变化，且不报错**。
///
/// 逐处删 `const` 是错的方向：全树几十处，删完还会因为漏了一处而再次
/// 静默失效，而且每次加新 `const` 都会重新引入。
///
/// 正确的做法是 [OndraI18nScope]：`InheritedNotifier` 把「依赖」登记在
/// 订阅者的 element 上，语言一变，框架**直接**把变化投递给每个读过
/// [OndraI18nScope.translate] 的 element——不管中间隔着多少层 `const`。
/// 这不是绕过框架，而是框架为这件事准备的机制。
class OndraI18n extends ChangeNotifier {
  OndraI18n._();

  /// 全应用唯一实例。
  static final OndraI18n instance = OndraI18n._();

  /// 支持的语言。`zh` 是原文语言，不需要词条。
  static const List<String> supported = ['zh', 'en'];

  String _code = 'zh';
  Map<String, String> _table = const {};

  /// 当前语言代码。
  String get code => _code;

  /// 当前是不是原文语言（中文）。是的话 [tr] 直接返回原文，不查表。
  bool get isSource => _code == 'zh';

  /// 载入一份语言包。失败保持原样——语言包读不到不该让应用起不来。
  Future<void> load(String code) async {
    final next = supported.contains(code) ? code : 'zh';
    if (next == _code && (next == 'zh' || _table.isNotEmpty)) return;
    _code = next;

    if (next == 'zh') {
      _table = const {};
      notifyListeners();
      return;
    }

    try {
      final raw = await rootBundle.loadString('assets/locales/$next.json');
      final parsed = jsonDecode(raw);
      _table = parsed is Map
          ? {
              for (final e in parsed.entries)
                if (e.value is String) '${e.key}': e.value as String,
            }
          : const {};
    } catch (e) {
      // 缺文件 / 坏 JSON 都回落中文，并留一行日志：语言包是资源，
      // 不是代码，缺了要能查出来，但不该拦住启动。
      debugPrint('[i18n] 语言包 $next 载入失败，回落中文（$e）');
      _table = const {};
      _code = 'zh';
    }
    notifyListeners();
  }

  /// 词条数。测试用它确认语言包真的被读进来了。
  int get entryCount => _table.length;

  /// 取一条译文。没有词条就返回原文。
  ///
  /// [vars] 用来填 `{name}` 占位符；为 null 时原样返回。
  String tr(String zh, [Map<String, Object?>? vars]) {
    final hit = isSource ? null : _table[zh];
    final text = hit ?? zh;
    if (vars == null || vars.isEmpty) return text;
    var out = text;
    for (final e in vars.entries) {
      out = out.replaceAll('{${e.key}}', '${e.value}');
    }
    return out;
  }
}

/// 把语言变化**直接投递**给读过翻译的 element。
///
/// 这层存在的唯一原因是 `const` 会截断重建（见 [OndraI18n] 的说明）。
/// 用法是在应用根套一层，翻译调用点改用 [translate]：
///
/// ```dart
/// OndraI18nScope(
///   child: MaterialApp(...),
/// )
/// ```
///
/// `InheritedNotifier` 的机制：`build` 里读过 `translate(context, ...)` 的
/// element 会被登记为依赖者；`notifier` 一通知，框架给每个依赖者
/// `markNeedsBuild()`——它走的不是「父传子」那条会被 `const` 短路的路径，
/// 而是 element 自己的重建。所以中间有多少层 `const` 都不影响。
class OndraI18nScope extends InheritedNotifier<OndraI18n> {
  OndraI18nScope({super.key, required super.child})
    : super(notifier: OndraI18n.instance);

  /// 在 `build` 里读一条译文，并登记依赖。
  ///
  /// 拿不到 scope（比如被单独 pump 的组件测试）时退化成全局单例的读取：
  /// 少一次依赖登记，不会崩，也不会空白。
  static String translate(
    BuildContext context,
    String zh, [
    Map<String, Object?>? vars,
  ]) {
    final scope = context.dependOnInheritedWidgetOfExactType<OndraI18nScope>();
    final i18n = scope?.notifier ?? OndraI18n.instance;
    return i18n.tr(zh, vars);
  }
}

/// 便捷入口：不依赖 `BuildContext` 时用这个。
///
/// **注意**：用它读到的值同样正确，但**不会**让当前 element 在语言变化时
/// 重建——`const` 子树里必须用 [OndraI18nScope.translate]。
/// 两条路读的是同一份数据，差别只在「谁负责重建」。
String t(String zh, [Map<String, Object?>? vars]) =>
    OndraI18n.instance.tr(zh, vars);
