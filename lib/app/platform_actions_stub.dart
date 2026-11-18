/// 浏览器里的平台行为：没有登录项，也不能阻止系统睡眠，一律如实失败。
///
/// 与 `platform_actions_io.dart` 接口**完全同形**：`flutter analyze` 会把
/// 条件导出两边都分析一遍，缺一个成员调用点就会在另一边报错。
library;

class PlatformActions {
  const PlatformActions._();

  /// 与 `platform_actions_io.dart` 同名的测试桩注入点。
  ///
  /// stub 里本来不需要（所有动作已经是不碰系统的空实现），但两个实现
  /// 必须**接口完全同形**：`flutter analyze` 会分析条件导出的两边，
  /// 一边多一个成员，调用点就会在另一边报错。
  static PlatformActionsProbe? probe;

  /// 这个环境能不能改「开机自启动」。
  static bool get canAutoLaunch => false;

  /// 这个环境能不能阻止系统空闲睡眠。
  static bool get canPreventSleep => false;

  /// 读系统当前的开机自启动状态。读不到返回 null（表示「不知道」），
  /// 而不是 false——把「没查到」画成「已关闭」是在编数据。
  static Future<bool?> autoLaunchEnabled() async => null;

  /// 设置开机自启动。返回 true 表示系统真的接受了这次修改。
  static Future<bool> setAutoLaunch(bool enabled) async => false;

  /// 开始阻止空闲睡眠。返回 false 表示系统不接受。
  static Future<bool> beginPreventSleep() async => false;

  /// 解除阻止。
  static Future<void> endPreventSleep() async {}
}

/// 测试用的替身，签名与 io 版一致。浏览器里不会有人注入它，
/// 但两个实现同形这件事本身要靠它保证。
class PlatformActionsProbe {
  const PlatformActionsProbe({
    this.canAutoLaunch = true,
    this.canPreventSleep = true,
    this.autoLaunchEnabled = _defaultEnabled,
    this.setAutoLaunch = _defaultSet,
    this.beginPreventSleep = _defaultBegin,
    this.endPreventSleep = _defaultEnd,
  });

  final bool canAutoLaunch;
  final bool canPreventSleep;

  final Future<bool?> Function() autoLaunchEnabled;
  final Future<bool> Function(bool enabled) setAutoLaunch;
  final Future<bool> Function() beginPreventSleep;
  final Future<void> Function() endPreventSleep;

  static Future<bool?> _defaultEnabled() async => false;
  static Future<bool> _defaultSet(bool enabled) async => true;
  static Future<bool> _defaultBegin() async => true;
  static Future<void> _defaultEnd() async {}
}
