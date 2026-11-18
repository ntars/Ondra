import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import '../../../../../app/platform_actions.dart';
import '../../../../../app/prefs.dart';
import './settings_spec.dart';
import './settings_targets.dart';

/// 设置视图：`ondra-settings` 插件里那份值的投影。
///
/// 界面只通过这里读写设置——**不各自维护开关状态**，也不写死默认值
/// （默认值在 [ondraSettingSpecs] 里）。
///
/// ## 为什么落在 `prefs.json` 而不是内核的 `ctx.settings`
///
/// 内核侧的 `ondra-config-schema` 是**声明式**的：它描述每个插件有哪些配置项、
/// 类型与边界，但它不负责替界面保存「用户点了哪个开关」。那份状态在当前装配里
/// 没有落盘实现（内核只把装配表写进 YAML，业务开关不进去）。
///
/// 所以这一层自己做持久化，位置与主题偏好一致：`~/.ondra/prefs.json`。
/// 一个文件放全部「下次启动要记得」的小值，卸载时随 `~/.ondra/` 一起清掉。
///
/// 等到内核侧提供 `settings.mutate` 时，只要把 [load] / [_persist] 两个方法
/// 换成 RPC 调用，界面一行不用改。
class SettingsClient extends ChangeNotifier {
  final Map<String, Object?> _values = {
    for (final s in ondraSettingSpecs) s.key: s.defaultValue,
  };

  /// 存储前缀。prefs.json 是一个扁平字符串表，加前缀避免与主题偏好撞键。
  static const String _prefix = 'settings.';

  bool _loaded = false;

  /// 是否已经从磁盘读过一遍。启动时 [load] 之前，界面拿到的是默认值。
  bool get loaded => _loaded;

  Map<String, Object?> get values => Map.unmodifiable(_values);

  /// 从磁盘读回全部已存值。类型按 spec 的默认值还原——
  /// prefs 里一律是字符串，布尔与整数要在这一层转回来。
  ///
  /// 读完顺手**推一遍内核**：界面记着的值与 `settings.json` 里的值可能已经
  /// 分叉（用户手动改过文件、或上一次写入失败）。启动时以界面这份为准对齐一次，
  /// 之后每次 [set] 只写变化的那一项。
  void load() {
    if (_loaded) return;
    _loaded = true;
    for (final spec in ondraSettingSpecs) {
      final raw = readPref('$_prefix${spec.key}');
      if (raw.isEmpty) continue;
      final parsed = _decode(spec, raw);
      if (parsed != null) _values[spec.key] = parsed;
    }
    _pushAll();
    _restorePlatformActions();
    notifyListeners();
  }

  /// 启动时把「系统侧的状态」与界面上的值对齐。
  ///
  /// 两个开关的行为不一样：
  /// - 阻止睡眠是**进程内**的断言，应用退出即失效，所以每次启动都要按
  ///   设置重新起一次 `caffeinate`；
  /// - 开机自启动是**系统里**的一份文件，它比界面记得更久（用户可能在
  ///   macOS 设置里手动删掉）。所以以系统为准回写界面，而不是反过来
  ///   用界面覆盖系统——覆盖会让「我明明在系统设置里关掉了」变成关不掉。
  void _restorePlatformActions() {
    if (_values['general.preventSleep'] == true) {
      PlatformActions.beginPreventSleep();
    }
    // 异步读，读完再回写；不阻塞启动。
    PlatformActions.autoLaunchEnabled().then((enabled) {
      if (enabled == null) return; // 这个环境查不到，保持界面原值
      if (_values['general.launchAtLogin'] == enabled) return;
      _values['general.launchAtLogin'] = enabled;
      _persist('general.launchAtLogin', enabled);
      // 这是个全局单例，理论上不会先被 dispose 再走到这里；
      // 但测试里会反复建客户端，多一道判断比在日志里看到
      // 「A SettingsClient was used after being disposed」要好。
      if (!_disposed) notifyListeners();
    });
  }

  bool _disposed = false;

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }

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

  /// 任意类型的取值。给「字符串输入」这类没有专用 getter 的项用。
  String text(String key) {
    final v = _values[key];
    if (v == null) return '';
    return '$v';
  }

  void set(String key, Object? value) {
    final changed = _values[key] != value;
    _values[key] = value;
    if (!changed) return;
    _persist(key, value);
    // 两个「系统替我们记住」的开关要真的去改系统状态：
    // 只写 prefs.json 的话，界面显示「已开启」而系统根本没这项，
    // 用户下次开机不会看到空谷，只能自己猜为什么。
    _applyPlatformAction(key, value);
    // 真写进内核：这一句是「拨了开关真的生效」与「只是界面记住了」的分界。
    // 没有落点的项（字号这类纯界面项）在这里是空操作，不算失败。
    ondraPushSetting(key, value);
    notifyListeners();
  }

  /// 把设置应用到操作系统。
  ///
  /// 失败**不回滚界面**：界面上的值代表「用户的意图」，系统没接受是另一件事。
  /// 回滚会让用户点了开关后看到它自己弹回去，却不知道是被谁拦下的；
  /// 保留意图 + 在设置页如实标注能力是否可用，比静默弹回更说得清。
  void _applyPlatformAction(String key, Object? value) {
    switch (key) {
      case 'general.launchAtLogin':
        PlatformActions.setAutoLaunch(value == true);
      case 'general.preventSleep':
        if (value == true) {
          PlatformActions.beginPreventSleep();
        } else {
          PlatformActions.endPreventSleep();
        }
      // 其余项不是平台行为。
    }
  }

  /// 把当前全部取值推给内核。启动时调用一次，见 [load]。
  void _pushAll() {
    ondraPushAllSettings((key) => _values[key]);
  }

  /// 这一项在内核里有没有落点。界面据此标注「只影响界面」，
  /// 而不是让用户以为每个开关都在管内核。
  bool isWired(String key) => ondraSettingIsWired(key);

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

  /// 回到全部默认值。用于「清空全部数据」这类会把偏好一起重置的场景。
  void resetAll() {
    for (final spec in ondraSettingSpecs) {
      _values[spec.key] = spec.defaultValue;
      writePref('$_prefix${spec.key}', '');
    }
    notifyListeners();
  }

  void _persist(String key, Object? value) {
    // 空值不写：`writePref` 写空串等价于「删掉这条」，读回时按默认值处理。
    writePref('$_prefix$key', value == null ? '' : '$value');
  }

  /// 把 prefs 里的字符串还原成 spec 声明的类型。
  ///
  /// 只认三种：布尔、整数、字符串。类型对不上就当没存过——宁可回默认值，
  /// 也不要让一个坏值把界面渲染成非法状态。
  Object? _decode(OndraSettingSpec spec, String raw) {
    final d = spec.defaultValue;
    if (d is bool) {
      if (raw == 'true') return true;
      if (raw == 'false') return false;
      return null;
    }
    if (d is int) return int.tryParse(raw);
    if (d is String) return raw;
    return raw;
  }
}

/// 全局客户端，与人设 / 插件客户端同层。
final SettingsClient settingsClient = SettingsClient();
