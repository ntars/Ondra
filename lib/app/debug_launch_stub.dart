/// Web 用 `?page=`，这里返回空串。
String debugLaunchPage() => '';

/// Web 用查询参数直接打开网页；这里不受桌面环境变量影响。
String debugBrowserUrl() => '';

/// Web 不使用桌面白名单写入开关。
bool debugBrowserAddSite() => false;

/// Web 用 `?settings=1`，这里不受桌面环境变量影响。
bool debugLaunchSettings() => false;

/// Web 调试：`?theme=dark` 强制深色，用来核对深色皮肤。
String debugLaunchTheme() {
  final v = Uri.base.queryParameters['theme'];
  return (v == 'dark' || v == 'light') ? v! : '';
}
