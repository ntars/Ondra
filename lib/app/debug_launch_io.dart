import 'dart:io';

/// 桌面调试：`ONDRA_PAGE=browser open ...` 直接落到某一页。
///
/// 与 Web 的 `?page=` 同一用途：核对某页排版时不用手点一路。
/// 只有显式设置环境变量才生效，正常启动完全不受影响。
String debugLaunchPage() => Platform.environment['ONDRA_PAGE'] ?? '';

/// 桌面调试：`ONDRA_BROWSER_URL=http://host:port/` 或
/// `--browser-url=http://host:port/` 在启动时打开一个白名单站点。
///
/// 只允许 http(s)，且地址必须已经存在或同时通过 `ONDRA_BROWSER_ADD` 加入；
/// 实际准入仍由 BrowserClient 判断，调试开关不能放宽正式规则。
String debugBrowserUrl() {
  final env = Platform.environment['ONDRA_BROWSER_URL'];
  if (env != null && env.isNotEmpty) return env;
  for (final arg in Platform.executableArguments) {
    const prefix = '--browser-url=';
    if (arg.startsWith(prefix)) return arg.substring(prefix.length);
  }
  return '';
}

/// 桌面调试：显式把 [debugBrowserUrl] 加入白名单。
///
/// 仅认精确值 `1`，避免误设空串或 `0` 改动用户白名单。
bool debugBrowserAddSite() => Platform.environment['ONDRA_BROWSER_ADD'] == '1';

/// 桌面调试：启动时直接打开设置面板，省掉从侧栏一路点击。
///
/// 只认精确值 `1`；这样误设空串或 `0` 不会改变普通用户的启动界面。
bool debugLaunchSettings() => Platform.environment['ONDRA_SETTINGS'] == '1';

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
