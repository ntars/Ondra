import 'dart:convert';
import 'dart:io';

import 'home_dir.dart';

/// 偏好文件：`~/.ondra/prefs.json`。
///
/// 用同步读写而不是异步：文件只有几百字节，且在启动首帧之前就要拿到主题，
/// 异步徒增一次「闪一下浅色再变深」的机会。
File get _file {
  final home = ondraUserHome;
  return File('$home/.ondra/prefs.json');
}

/// 测试用的重定向：非 null 时读写都落到这个文件。
///
/// 没有它的话，任何一次 `settingsClient.set(...)` 的测试都会写进
/// 用户真实的 `~/.ondra/prefs.json`——跑一遍测试，用户的开机自启动、
/// 通知开关、字号全被改成测试里的值，而且没人告诉他。
/// 测试改成 `setPrefHome(tempDir)` 即可完全隔离。
String? _overrideHome;

/// 把偏好文件重定向到 [home] 下的 `.ondra/prefs.json`（测试用）。
/// 传 null 恢复默认；读写不持有跨文件缓存。
void setPrefHome(String? home) {
  _overrideHome = home;
}

File get _resolved {
  final home = _overrideHome;
  if (home == null) return _file;
  return File('$home/.ondra/prefs.json');
}

Map<String, String> get _data {
  // 备份恢复、导入与清空都可能在此模块之外替换文件。每次重读这份小文件，
  // 尤其不能在文件已被删除后把缓存里的非设置字段重新写回去。
  try {
    final f = _resolved;
    if (f.existsSync()) {
      final raw = jsonDecode(f.readAsStringSync());
      if (raw is Map) {
        return {for (final e in raw.entries) '${e.key}': '${e.value}'};
      }
    }
  } catch (_) {
    // 文件损坏就当没有：偏好丢了只影响默认值，不该拦住启动。
  }
  return <String, String>{};
}

String readPref(String key, {String fallback = ''}) => _data[key] ?? fallback;

void writePref(String key, String value) {
  final data = _data;
  if (value.isEmpty) {
    data.remove(key);
  } else {
    data[key] = value;
  }
  try {
    final f = _resolved;
    f.parent.createSync(recursive: true);
    f.writeAsStringSync(jsonEncode(data), flush: true);
  } catch (_) {
    // 写不进去（只读卷、权限）也只是这次不记住，不影响本次运行。
  }
}
