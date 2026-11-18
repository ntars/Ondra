import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import './settings_spec.dart';

/// 设置视图：`ondra-settings` 插件里那份值的投影。
///
/// 界面只通过这里读写设置——**不各自维护开关状态**，也不写死默认值
/// （默认值在 [ondraSettingSpecs] 里）。运行时接通后，[set] 会转发成
/// `settings.mutate`，[values] 变成订阅推送，界面一行不用改。
class SettingsClient extends ChangeNotifier {
  final Map<String, Object?> _values = {
    for (final s in ondraSettingSpecs) s.key: s.defaultValue,
  };

  Map<String, Object?> get values => Map.unmodifiable(_values);

  bool boolean(String key) {
    final v = _values[key];
    return v is bool ? v : ondraSettingSpec(key).defaultValue == true;
  }

  String choice(String key) {
    final v = _values[key];
    return v is String ? v : '${ondraSettingSpec(key).defaultValue}';
  }

  int number(String key) {
    final v = _values[key];
    if (v is int) return v;
    final d = ondraSettingSpec(key).defaultValue;
    return d is int ? d : 0;
  }

  void set(String key, Object? value) {
    final spec = ondraSettingSpec(key);
    final changed = _values[key] != value;
    _values[key] = value;
    if (changed) notifyListeners();
    // 骨架期没有持久化：接上运行时后，这里追加 settings.mutate(key, value)。
    assert(spec.key == key);
  }

  void toggle(String key) => set(key, !boolean(key));

  /// 字号加减：夹在声明的最小 / 最大之间，越界不动作。
  void stepNumber(String key, int delta) {
    final spec = ondraSettingSpec(key);
    final next = number(key) + delta;
    final min = spec.min ?? next;
    final max = spec.max ?? next;
    if (next < min || next > max) return;
    set(key, next);
  }
}

/// 全局客户端，与人设 / 插件客户端同层。
final SettingsClient settingsClient = SettingsClient();
