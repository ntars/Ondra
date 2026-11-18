/// 平台行为：开机自启动与阻止空闲睡眠。
///
/// 界面只 import 这一行，不判断平台——与 `prefs.dart` / `keychain.dart` 同一模式。
///
/// **为什么这两个要单独一层**：它们不是内核配置，而是操作系统替我们记住
/// 的开关（登录项、电源断言）。写进 `settings.json` 不会让系统在开机时
/// 真的拉起空谷，只有真的去改登录项才算数。
library;

export 'platform_actions_stub.dart'
    if (dart.library.io) 'platform_actions_io.dart';
