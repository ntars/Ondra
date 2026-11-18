/// Web 用 `?page=`，这里返回空串。
String debugLaunchPage() => '';

/// Web 调试：`?theme=dark` 强制深色，用来核对深色皮肤。
String debugLaunchTheme() {
  final v = Uri.base.queryParameters['theme'];
  return (v == 'dark' || v == 'light') ? v! : '';
}
