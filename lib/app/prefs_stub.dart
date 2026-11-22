import 'package:web/web.dart' as web;

/// Web 端的偏好存储：落在浏览器 `localStorage`，刷新后仍然记得设置。
///
/// 之前的实现只在内存里放一张表，刷新就回到默认——这是审计中的真实用户
/// 场景缺口：选完主题/语言/引导状态后刷新，界面假装从未设置过。这里与
/// `prefs_io.dart` 保持同一语义：空串代表删除键。
const String _prefix = 'ondra:pref:';

web.Storage get _storage => web.window.localStorage;

String readPref(String key, {String fallback = ''}) {
  try {
    final value = _storage.getItem('$_prefix$key');
    return value ?? fallback;
  } catch (_) {
    // 隐私模式 / 禁用存储时退回默认值，不能让设置页或启动崩溃。
    return fallback;
  }
}

void writePref(String key, String value) {
  final storageKey = '$_prefix$key';
  try {
    if (value.isEmpty) {
      _storage.removeItem(storageKey);
    } else {
      _storage.setItem(storageKey, value);
    }
  } catch (_) {
    // 写不进去只是这次不记住，不影响本次运行（与桌面版同语义）。
  }
}

/// 与 `prefs_io.dart` 同名的重定向入口（接口同形的需要）。
///
/// 清掉本应用写下的偏好键，供测试隔离使用；不会碰同源下其他站点数据。
void setPrefHome(String? home) {
  if (home == null) return;
  const prefix = _prefix;
  final keys = <String>[];
  for (var i = 0; i < _storage.length; i++) {
    final key = _storage.key(i);
    if (key != null && key.startsWith(prefix)) keys.add(key);
  }
  for (final key in keys) {
    _storage.removeItem(key);
  }
}
