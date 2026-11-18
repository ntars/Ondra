import 'dart:convert';
import 'dart:io';

/// 偏好文件：`~/.ondra/prefs.json`。
///
/// 用同步读写而不是异步：文件只有几百字节，且在启动首帧之前就要拿到主题，
/// 异步徒增一次「闪一下浅色再变深」的机会。
File get _file {
  final home = Platform.environment['HOME'] ?? '.';
  return File('$home/.ondra/prefs.json');
}

Map<String, String>? _cache;

Map<String, String> get _data {
  final cached = _cache;
  if (cached != null) return cached;
  try {
    final f = _file;
    if (f.existsSync()) {
      final raw = jsonDecode(f.readAsStringSync());
      if (raw is Map) {
        return _cache = {
          for (final e in raw.entries) '${e.key}': '${e.value}',
        };
      }
    }
  } catch (_) {
    // 文件损坏就当没有：偏好丢了只影响默认值，不该拦住启动。
  }
  return _cache = <String, String>{};
}

String readPref(String key, {String fallback = ''}) => _data[key] ?? fallback;

void writePref(String key, String value) {
  _data[key] = value;
  try {
    final f = _file;
    f.parent.createSync(recursive: true);
    f.writeAsStringSync(jsonEncode(_data));
  } catch (_) {
    // 写不进去（只读卷、权限）也只是这次不记住，不影响本次运行。
  }
}
