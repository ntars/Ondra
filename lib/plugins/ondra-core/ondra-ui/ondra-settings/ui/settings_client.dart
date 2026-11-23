import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import '../../../../../app/i18n.dart';
import '../../../../../app/notifier.dart';
import '../../../../../app/platform_actions.dart';
import '../../../../../app/prefs.dart';
import '../../../../../design/tokens.dart';
import 'profile_config.dart';
import './settings_spec.dart';
import './settings_targets.dart';

enum SettingApplyState { unverified, applying, applied, restartRequired, error }

/// values 是已保存的意图，不是运行中的内核状态。界面须同时展示 stateOf / errorFor。
/// 内核没有热更新契约：这里永不重启或中断聊天，启动协调器负责安全的启动时机。
class SettingsClient extends ChangeNotifier {
  final Map<String, Object?> _values = {
    for (final s in ondraSettingSpecs) s.key: s.defaultValue,
  };
  static const String _prefix = 'settings.';
  bool _loaded = false;
  bool _disposed = false;
  final _errors = <String, String>{};
  final _states = <String, SettingApplyState>{};
  final _pending = <String>{};
  final _restart = <String>{};
  final _revisions = <String, int>{};
  final _queues = <String, Future<bool>>{};
  final _requested = <String, Object?>{};
  final _written = <String, Object?>{};
  final _applied = <String, Object?>{};

  bool get loaded => _loaded;
  Map<String, Object?> get values => Map.unmodifiable(_values);
  Map<String, Object?> get appliedValues => Map.unmodifiable(_applied);
  Map<String, String> get applicationErrors => Map.unmodifiable(_errors);
  Set<String> get pendingKeys => Set.unmodifiable(_pending);
  Map<String, Object?> get pendingValues => Map.unmodifiable({
    for (final key in _pending)
      if (_requested.containsKey(key)) key: _requested[key],
  });
  Set<String> get restartRequiredKeys => Set.unmodifiable(_restart);
  bool get restartRequired => _restart.isNotEmpty;

  /// 「启动期内核 profile 是否还没就位」——刻意恒为 false，不是漏写。
  ///
  /// 这里曾经有个同名常量配合下面两处 `_profileNotReady ||` 判断，注释说
  /// 「profile 未就位就跳过，写了也落空」。但跳过意味着**静默**：用户明明
  /// 存过偏好，装配层却缺文件，界面一声不响，等于告诉他设置生效了。
  ///
  /// 真实语义应该是：profile 缺失时写入**必然失败**，那就让它失败，并让
  /// `applicationErrors` 如实显示「profile 尚未初始化或不存在」——用户看得见、
  /// 能修（重装/重连会 seed）。seed 完成后 `markConnected()` →
  /// `_runStartupSync()` 会自动补推，错误随之消解。
  ///
  /// 所以判定条件保留为「永不跳过」；两个 `_profileNotReady ||` 分支留在原处
  /// 是为了将来真有「必须等就位」的场景，改这里一处即可。
  static const bool _profileNotReady = false;

  /// 内核是否已连接。离线时跳过启动同步——写了内核也读不到，状态会对不上。
  bool _connected = false;

  bool _needsRestart(String key) => _restart.contains(key);

  /// 连接成功后由 ChatClient 调用：此后启动同步不再跳过。
  /// （首启场景：load() 时 profile 刚 seed、内核还没连上，直接推会落空。）
  void markConnected() {
    if (_connected) return;
    _connected = true;
    // 补推启动阶段跳过的项。
    _runStartupSync();
  }

  void _runStartupSync() {
    for (final spec in ondraSettingSpecs) {
      if (spec.key == 'general.launchAtLogin' ||
          _errors.containsKey(spec.key)) {
        continue;
      }
      // 同第 15 项：只推用户真实改过的项。
      if (readPref('$_prefix${spec.key}').isEmpty) continue;
      if (_profileNotReady || (!_connected && _needsRestart(spec.key))) {
        continue;
      }
      _apply(spec.key, _values[spec.key]);
    }
    _notify();
  }

  bool get applying => _states.containsValue(SettingApplyState.applying);
  String? errorFor(String key) => _errors[key];
  SettingApplyState stateOf(String key) =>
      _states[key] ?? SettingApplyState.unverified;

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// 兼容同步启动调用。profile 未 seed 时错误会公开保留；seed 后调用 applyPending。
  void load() {
    if (_loaded || _disposed) return;
    _loaded = true;
    // 文件里没存、或存了非法值时都回默认，不能把上一进程/上一次重载的
    // 字体状态留在全局排版里。
    setOndraFontChoice('misans');
    for (final spec in ondraSettingSpecs) {
      final raw = readPref('$_prefix${spec.key}');
      if (raw.isEmpty) continue;
      final parsed = _decode(spec, raw);
      if (_valid(spec, parsed)) {
        _values[spec.key] = parsed;
        if (spec.key == 'general.fontFamily') {
          setOndraFontChoice(parsed as String);
        }
      } else {
        _fail(spec.key, '已存设置取值无效，未应用');
      }
    }
    _alignLegacyKernelDefaults();
    for (final spec in ondraSettingSpecs) {
      if (spec.key == 'general.launchAtLogin' ||
          _errors.containsKey(spec.key)) {
        continue;
      }
      // alpha.10 审查第 15 项：启动同步只推「用户真实改过的项」——
      // 没存过偏好的项不推（首启时推默认值 = 覆盖内核自带配置；升级时
      // 推默认值 = 覆盖用户直接改过的内核配置）。
      if (readPref('$_prefix${spec.key}').isEmpty) continue;
      // 启动同步的三个跳过条件（alpha.2 审查第 18 项）：
      // 1. profile 尚未 seed（首启场景）——写了也落空，等 seed 后重连；
      // 2. 内核离线且此项需要重启——写了状态也对不上，等连上后由
      //    applyPending 补；
      // 3. 上一次的应用还挂着 pendingRestart——覆盖它会丢掉用户改动
      //    没生效的事实。
      if (_profileNotReady || (!_connected && _needsRestart(spec.key))) {
        continue;
      }
      _apply(spec.key, _values[spec.key]);
    }
    _restoreAutoLaunch();
    _notify();
  }

  /// 旧版随包 profile 的 TTS 出厂默认是开，而界面这一版默认关闭。
  /// 只对齐「用户从未保存过该偏好、profile 也仍是 true」的组合：用户
  /// 自己写过的配置优先，不在这里覆盖。
  ///
  /// 当前 profile 出厂值已经改成 false；这段迁移仍要留着——覆盖升级时，
  /// 用户目录里的旧 `cordis.patch.yml` 不会被新包替换，那里仍写着 true。
  /// 写入后下一次内核启动按界面默认关闭。
  void _alignLegacyKernelDefaults() {
    const key = 'voice.tts';
    if (readPref('$_prefix$key').isNotEmpty) return;
    if (readProfileConfigField('tts', 'enable') != 'true') return;
    final result = writeProfileConfigFieldResult('tts', 'enable', false);
    if (!result.ok) return;
    _values[key] = false;
    _states[key] = result.changed
        ? SettingApplyState.restartRequired
        : SettingApplyState.applied;
    if (result.changed) _restart.add(key);
  }

  Future<void> reloadFromDisk() async {
    await Future.wait(_queues.values.toList());
    if (_disposed) return;
    for (final key in _revisions.keys.toList()) {
      _revisions[key] = _revisions[key]! + 1;
    }
    _values
      ..clear()
      ..addAll({
        for (final spec in ondraSettingSpecs) spec.key: spec.defaultValue,
      });
    _errors.clear();
    _states.clear();
    _pending.clear();
    _restart.clear();
    _requested.clear();
    _written.clear();
    _applied.clear();
    _loaded = false;
    load();
    await applyPending();
  }

  Future<bool> _restoreAutoLaunch() async {
    const key = 'general.launchAtLogin';
    final revision = _revisions[key] ?? 0;
    _states[key] = SettingApplyState.applying;
    try {
      if (!PlatformActions.canAutoLaunch) {
        if (_current(key, revision)) _fail(key, '当前平台不支持开机自启动');
        return false;
      }
      final enabled = await PlatformActions.autoLaunchEnabled();
      // 启动查询绝不能覆盖查询期间用户的新选择。
      if (!_current(key, revision)) return false;
      if (enabled == null) {
        _fail(key, '无法确认系统登录项状态');
      } else if (!_persist(key, enabled)) {
        _fail(key, '系统登录项已读取，但偏好保存失败');
      } else {
        _values[key] = enabled;
        _success(key, enabled);
        return true;
      }
    } catch (e) {
      if (_current(key, revision)) _fail(key, '读取系统登录项失败：$e');
    } finally {
      _notify();
    }
    return false;
  }

  bool _current(String key, int revision) =>
      !_disposed && (_revisions[key] ?? 0) == revision;

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

  /// 可继续当 void 调用；需要反馈时 await，false 时检查 errorFor。
  /// 保存失败保留旧值，不通知消费者采用一个从未落盘的新值。
  Future<bool> set(String key, Object? value) {
    if (_disposed) return Future.value(false);
    final spec = ondraSettingSpec(key);
    if (!_valid(spec, value)) {
      _fail(key, '取值不在此设置允许的类型或范围内');
      _notify();
      return Future.value(false);
    }
    _requested[key] = value;
    _revisions[key] = (_revisions[key] ?? 0) + 1;
    if (!_persist(key, value)) {
      _fail(key, '偏好保存失败，未应用新值');
      _notify();
      return Future.value(false);
    }
    _values[key] = value;
    final result = _apply(key, value);
    _notify();
    return result;
  }

  void _fail(String key, String message) {
    _errors[key] = message;
    _states[key] = SettingApplyState.error;
    _pending.add(key);
  }

  void _success(String key, Object? value) {
    _errors.remove(key);
    _pending.remove(key);
    _applied[key] = value;
    _states[key] = SettingApplyState.applied;
  }

  Future<bool> _apply(String key, Object? value) {
    if (_disposed) return Future.value(false);
    _requested[key] = value;
    if (_isAsync(key)) return _enqueue(key, value);
    if ((key == 'general.notify' || key == 'general.notifySound') &&
        !Notifier.supported) {
      _fail(key, '当前平台不支持系统通知');
      return Future.value(false);
    }
    final result = ondraPushSettingResult(key, value);
    if (result.changed) _restart.add(key);
    if (!result.ok) {
      _fail(key, result.error ?? '配置保存失败');
      return Future.value(false);
    }
    _errors.remove(key);
    _pending.remove(key);
    if (ondraSettingTargetsOf(key).isNotEmpty) {
      _written[key] = value;
      // 即使文件没变，也不能凭文件内容宣称当前进程已加载它。
      if (!_applied.containsKey(key) || _applied[key] != value) {
        _restart.add(key);
      }
      _states[key] = _restart.contains(key)
          ? SettingApplyState.restartRequired
          : SettingApplyState.applied;
    } else {
      _success(key, value);
    }
    if (key == 'general.fontFamily') {
      setOndraFontChoice('$value');
    }
    return Future.value(true);
  }

  bool _isAsync(String key) => const {
    'general.launchAtLogin',
    'general.preventSleep',
    'general.language',
  }.contains(key);

  /// 每个动作串行执行；过时的结果不能覆盖新意图，过时且尚未开始的动作直接丢弃。
  Future<bool> _enqueue(String key, Object? value) {
    final revision = _revisions[key] ?? 0;
    _states[key] = SettingApplyState.applying;
    final previous = _queues[key] ?? Future.value(true);
    final future = previous.then((_) async {
      if (!_current(key, revision)) return false;
      try {
        final error = await _platformAction(key, value);
        if (!_current(key, revision)) return false;
        if (error == null) {
          _success(key, value);
        } else {
          _fail(key, error);
        }
        return error == null;
      } catch (e) {
        if (_current(key, revision)) _fail(key, '系统应用失败：$e');
        return false;
      } finally {
        _notify();
      }
    });
    _queues[key] = future;
    return future;
  }

  Future<String?> _platformAction(String key, Object? value) async {
    switch (key) {
      case 'general.launchAtLogin':
        if (!PlatformActions.canAutoLaunch) return '当前平台不支持开机自启动';
        return await PlatformActions.setAutoLaunch(value == true)
            ? null
            : '系统未接受登录项修改';
      case 'general.preventSleep':
        if (!PlatformActions.canPreventSleep) return '当前平台不支持阻止睡眠';
        if (value == true) {
          return await PlatformActions.beginPreventSleep()
              ? null
              : '系统未接受阻止睡眠请求';
        }
        await PlatformActions.endPreventSleep();
        return null;
      case 'general.language':
        final code = '$value';
        writePref('language', code);
        if (readPref('language') != code) return '界面语言偏好保存失败';
        await OndraI18n.instance.load(code);
        return OndraI18n.instance.code == code ? null : '语言包加载失败';
    }
    return null;
  }

  /// seed 完成后重试落盘/平台失败；不重启内核，不中断当前聊天。
  /// 返回 false 时仍可能有部分设置成功，逐项查看 applicationErrors。
  Future<bool> applyPending() async {
    if (_disposed) return false;
    final tasks = <Future<bool>>[];
    for (final key in _pending.toList()) {
      // 坏的存储值没有合法重试值，只能由用户明确选一个合法值修复。
      if (!_requested.containsKey(key)) {
        if (key == 'general.launchAtLogin') tasks.add(_restoreAutoLaunch());
        continue;
      }
      tasks.add(set(key, _requested[key]));
    }
    _notify();
    await Future.wait(tasks);
    await Future.wait(_queues.values.toList());
    _notify();
    return _errors.isEmpty;
  }

  /// 在启动内核之前取快照，成功 ready 后原样传给 markKernelApplied。
  /// 不使用「清空全部待重启」：启动期间用户可能又改了设置。
  Map<String, Object?> captureKernelConfiguration() =>
      Map.unmodifiable(_written);

  void markKernelApplied(Map<String, Object?> snapshot) {
    if (_disposed) return;
    for (final entry in snapshot.entries) {
      if (!_written.containsKey(entry.key)) continue;
      _applied[entry.key] = entry.value;
      if (_written[entry.key] == entry.value &&
          _values[entry.key] == entry.value) {
        _restart.remove(entry.key);
        if (!_errors.containsKey(entry.key)) {
          _states[entry.key] = SettingApplyState.applied;
        }
      }
    }
    _notify();
  }

  bool isWired(String key) => ondraSettingIsWired(key);
  void toggle(String key) => set(key, !boolean(key));

  void stepNumber(String key, int delta) {
    final spec = ondraSettingSpec(key);
    final next = number(key) + delta;
    if (next < (spec.min ?? next) || next > (spec.max ?? next)) return;
    set(key, next);
  }

  /// 逐项真实保存默认值并推送配置，平台动作也等待结果；部分失败如实保留错误。
  Future<bool> resetAll() async {
    final results = await Future.wait([
      for (final spec in ondraSettingSpecs) set(spec.key, spec.defaultValue),
    ]);
    return results.every((ok) => ok);
  }

  // writePref 当前契约为 void，io 会吞写入异常；回读确认，不能把调用完成当成功。
  bool _persist(String key, Object? value) {
    final encoded = value == null ? '' : '$value';
    try {
      writePref('$_prefix$key', encoded);
      return readPref('$_prefix$key') == encoded;
    } catch (_) {
      return false;
    }
  }

  bool _valid(OndraSettingSpec spec, Object? value) => switch (spec.kind) {
    OndraSettingKind.toggle => value is bool,
    OndraSettingKind.choice =>
      value is String && spec.options.any((o) => o.value == value),
    OndraSettingKind.stepper =>
      value is int &&
          (spec.min == null || value >= spec.min!) &&
          (spec.max == null || value <= spec.max!),
  };

  Object? _decode(OndraSettingSpec spec, String raw) {
    if (spec.defaultValue is bool) {
      return raw == 'true'
          ? true
          : raw == 'false'
          ? false
          : null;
    }
    if (spec.defaultValue is int) return int.tryParse(raw);
    return raw;
  }
}

final SettingsClient settingsClient = SettingsClient();
