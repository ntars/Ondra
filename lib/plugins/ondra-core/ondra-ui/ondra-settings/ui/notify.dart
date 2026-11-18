import '../../../../../app/notifier.dart';
import 'settings_client.dart';

/// 发通知的唯一入口：把「通知类设置」翻译成「这一次要不要弹、要不要响」。
///
/// ## 为什么不让调用点自己判断
///
/// 三个开关（启用通知 / 提示音 / 专注时静音）分散在不同设置段里，
/// 每个调用点都写一遍 `if (notify && (sound || !focus))` 的结果是：
/// 第一个调用点记得，第二个漏一个，第三个干脆直接发。
/// 判定只写一次，调用点只表达「要说什么」。
///
/// ## 「专注时静音」怎么算
///
/// 它要的是「当前是不是在全屏应用里」。这个信息在当前工程里拿不到——
/// 没有原生侧代码去读 `NSWorkspace` 的前台应用。所以这一项**如实不猜**：
/// 不发错的通知，也不假装它生效（设置页会标注它是纯界面项）。
/// 等有了前台应用查询能力，改这一处就够了。
class OndraNotify {
  const OndraNotify._();

  /// 报一件事。失败静默——通知发不出去不该让业务流程失败。
  static Future<void> tell(String title, String body) async {
    if (!settingsClient.boolean('general.notify')) return;
    if (!settingsClient.boolean('general.notifySound') &&
        _focusMuteActive) {
      // 两个都关 = 完全不出声也不弹：用户明确表示「现在别打扰我」。
      return;
    }
    await Notifier.show(
      title: title,
      body: body,
      sound: settingsClient.boolean('general.notifySound'),
    );
  }

  /// 专注静音是否生效。见类注释：当前没有前台应用查询能力，恒为 false。
  static bool get _focusMuteActive => false;
}
