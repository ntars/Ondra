import 'dart:io';

/// 桌面调试：`ONDRA_PAGE=browser open ...` 直接落到某一页。
///
/// 与 Web 的 `?page=` 同一用途：核对某页排版时不用手点一路。
/// 只有显式设置环境变量才生效，正常启动完全不受影响。
String debugLaunchPage() => Platform.environment['ONDRA_PAGE'] ?? '';

/// 桌面调试：强制深色，用来核对深色皮肤。返回 `dark` / `light` / 空串（跟系统）。
///
/// 两个入口都留：环境变量要求从二进制直接起（`open` 传不了环境变量），
/// `--dart-define` 则是编译期常量，配合 `open` 启动才能让进程常驻，
/// 截图核对时用后者更稳。
const String _themeDefine = String.fromEnvironment('ONDRA_THEME');

String debugLaunchTheme() {
  final env = Platform.environment['ONDRA_THEME'];
  if (env != null && env.isNotEmpty) return env;
  return _themeDefine;
}
