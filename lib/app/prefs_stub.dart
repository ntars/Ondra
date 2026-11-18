/// Web 端的偏好存储：只活在当前页面生命周期里。
///
/// 不为它引 `package:web` / `localStorage`：Web 版目前只用于逐页核对排版，
/// 刷新后回到默认值反而是想要的行为（每次都从同一状态开始看）。
final Map<String, String> _memory = <String, String>{};

String readPref(String key, {String fallback = ''}) => _memory[key] ?? fallback;

void writePref(String key, String value) => _memory[key] = value;

/// 与 `prefs_io.dart` 同名的重定向入口（接口同形的需要）。
///
/// Web 端本来就只活在内存里，没有真实文件可污染；这个函数什么都不做，
/// 只是为了 `flutter analyze` 分析条件导出两边时，调用点不会在另一边报错。
/// 测试里若调它，行为与 io 版一致：清掉已记住的值。
void setPrefHome(String? home) {
  _memory.clear();
}
