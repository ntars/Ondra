/// Web 端的偏好存储：只活在当前页面生命周期里。
///
/// 不为它引 `package:web` / `localStorage`：Web 版目前只用于逐页核对排版，
/// 刷新后回到默认值反而是想要的行为（每次都从同一状态开始看）。
final Map<String, String> _memory = <String, String>{};

String readPref(String key, {String fallback = ''}) => _memory[key] ?? fallback;

void writePref(String key, String value) => _memory[key] = value;
