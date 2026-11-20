import 'dart:io';

import 'package:flutter/services.dart'
    show MethodChannel, PlatformException;

/// 桌面端的平台行为。
///
/// ## 开机自启动：写 LaunchAgent，不写登录项
///
/// macOS 的两种做法：
/// 1. `System Events` 的登录项（`osascript` 告诉 Finder「登录时打开这个」）——
///    需要辅助功能授权，第一次会弹一个吓人的系统对话框；
/// 2. `~/Library/LaunchAgents/*.plist` —— 只是一个文件，`launchctl` 读它。
///
/// 这里选 2：不需要任何授权弹窗，用户想撤掉时直接删文件，而且这个文件
/// 本身就可以被「恢复默认」清干净。代价是它对 `.app` 包外的裸可执行文件
/// 更友好——我们正好是这种（Flutter 生成的 bundle 也是目录，
/// 用 `open -a` 更稳）。
///
/// ## 阻止睡眠：`caffeinate` 子进程
///
/// macOS 自带的 `caffeinate -i` 就是「别因为空闲而睡」的标准做法。
/// 起一个子进程，进程活着断言就有效，退出即解除——不需要配对清理，
/// 也不需要在别处记一个「现在阻止着」的全局状态：进程本身就是那个状态。
const MethodChannel _platformChannel = MethodChannel('ondra/platform');

class PlatformActions {
  const PlatformActions._();

  /// LaunchAgent 的标签，同时用作 plist 文件名。
  static const String _label = 'com.ntars.ondra';

  /// 测试桩：整层替换掉。
  ///
  /// 与 `Keychain.existsProbe` / `memorySnapshotLoader` 同一套约定。
  /// 这里必须提供整体替换点而不是逐个方法：`setAutoLaunch` 会往
  /// `~/Library/LaunchAgents` 写真文件、`beginPreventSleep` 会起一个
  /// `caffeinate` 子进程——测试跑一遍就在用户机器上留下一个登录项，
  /// 那比测试失败糟糕得多。
  static PlatformActionsProbe? probe;

  /// 仅测试：临时文件 + 假进程结果，不能用真实 launchd 验证测试。
  static String? debugLaunchAgentPathOverride;
  static Future<ProcessResult> Function(String, List<String>)?
  debugProcessRunner;

  static Future<ProcessResult> _processRun(String exe, List<String> args) =>
      debugProcessRunner?.call(exe, args) ?? Process.run(exe, args);

  static String get _plistPath {
    if (debugLaunchAgentPathOverride != null) {
      return debugLaunchAgentPathOverride!;
    }
    final home = Platform.environment['HOME'] ?? '';
    return '$home/Library/LaunchAgents/$_label.plist';
  }

  /// 仅测试能力分支，不调用真实系统命令。
  static String? debugOperatingSystemOverride;
  static bool get _isMacOS =>
      (debugOperatingSystemOverride ?? Platform.operatingSystem) == 'macos';

  // Linux 没有实现 XDG autostart / inhibitor，不能谎报支持并执行 macOS 命令。
  static bool get canAutoLaunch =>
      probe?.canAutoLaunch ??
      (_isMacOS &&
          (Platform.environment['HOME'] ?? '').startsWith('/') &&
          (debugProcessRunner != null || File('/bin/launchctl').existsSync()));

  static bool get canPreventSleep =>
      probe?.canPreventSleep ??
      (Platform.isAndroid || (_isMacOS && File('/usr/bin/caffeinate').existsSync()));

  /// 当前应用的绝对路径。写进 plist 的 `ProgramArguments` 要能在登录时
  /// 被 `launchd` 直接执行，相对路径在登录阶段没有意义（工作目录不确定）。
  static String get _executable => Platform.resolvedExecutable;

  static Future<bool?> autoLaunchEnabled() async {
    if (!canAutoLaunch) return null;
    if (probe != null) return probe!.autoLaunchEnabled();
    try {
      return File(_plistPath).existsSync();
    } catch (_) {
      return null;
    }
  }

  static Future<bool> _launchQueue = Future.value(true);

  static Future<bool> setAutoLaunch(bool enabled) {
    final result = _launchQueue.then((_) => _setAutoLaunch(enabled));
    _launchQueue = result.then((ok) => ok, onError: (Object _) => false);
    return result;
  }

  static Future<bool> _setAutoLaunch(bool enabled) async {
    if (!canAutoLaunch) return false;
    if (probe != null) return probe!.setAutoLaunch(enabled);
    try {
      final file = File(_plistPath);
      if (!enabled) {
        // list 成功表示仍注册着；unload 的非零退出不能当作成功吞掉。
        final listed = await _processRun('/bin/launchctl', ['list', _label]);
        if (listed.exitCode == 0) {
          if (!file.existsSync() ||
              !await _run('/bin/launchctl', ['unload', file.path])) {
            return false;
          }
        } else if (file.existsSync()) {
          // 查不到但文件仍在时，尝试卸载；失败保持文件，让调用方知道未完成。
          if (!await _run('/bin/launchctl', ['unload', file.path])) {
            return false;
          }
        }
        if (file.existsSync()) file.deleteSync();
        return true;
      }
      final original = file.existsSync() ? file.readAsStringSync() : null;
      file.parent.createSync(recursive: true);
      if (original == _plist() &&
          await _run('/bin/launchctl', ['list', _label])) {
        return true;
      }
      file.writeAsStringSync(_plist(), flush: true);
      if (await _run('/bin/launchctl', ['load', file.path])) return true;
      // 恢复原文件；不能以「也许下次登录会好」冒充本次执行成功。
      if (original == null) {
        file.deleteSync();
      } else {
        file.writeAsStringSync(original, flush: true);
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  /// LaunchAgent 的内容。
  ///
  /// `RunAtLoad` 是「登录时启动」，`KeepAlive=false` 是「别崩溃后无限重拉」——
  /// 后者若为 true，用户在应用里主动退出也会被立刻拉起来，那不是自启动，
  /// 是耍流氓。
  static String _plist() =>
      '''
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>${_xml(_executable)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
''';

  /// 正在跑的 `caffeinate`。null 表示当前没有阻止睡眠。
  static Process? _caffeinate;

  static Future<void> _sleepQueue = Future.value();

  static Future<T> _sleepAction<T>(Future<T> Function() action) {
    final next = _sleepQueue.then((_) => action());
    _sleepQueue = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  static Future<bool> beginPreventSleep() => _sleepAction(() async {
    if (!canPreventSleep) return false;
    if (probe != null) return probe!.beginPreventSleep();
    // 安卓：FLAG_KEEP_SCREEN_ON 由原生侧开关窗口 flag（见 MainActivity.kt
    // 的 ondra/platform handler），不驻留子进程。
    if (Platform.isAndroid) {
      try {
        return await _platformChannel.invokeMethod<bool>('beginPreventSleep') ?? false;
      } on PlatformException {
        return false;
      }
    }
    if (_caffeinate != null) return true;
    try {
      final process = await Process.start('/usr/bin/caffeinate', ['-i']);
      _caffeinate = process;
      process.exitCode.then((_) {
        // 旧进程的退出通知不能清掉新进程的句柄。
        if (identical(_caffeinate, process)) _caffeinate = null;
      });
      return true;
    } catch (_) {
      return false;
    }
  });

  /// void 契约不变，但失败会抛给调用方，不能假装断言已经解除。
  static Future<void> endPreventSleep() => _sleepAction(() async {
    if (!canPreventSleep) throw UnsupportedError('当前平台不支持阻止睡眠');
    if (probe != null) return probe!.endPreventSleep();
    if (Platform.isAndroid) {
      try {
        await _platformChannel.invokeMethod<void>('endPreventSleep');
      } on PlatformException {
        // 已不在前台时 clear flag 无害失败，如实忽略。
      }
      return;
    }
    final process = _caffeinate;
    if (process == null) return;
    process.kill();
    await process.exitCode.timeout(const Duration(seconds: 3));
    if (identical(_caffeinate, process)) _caffeinate = null;
  });

  static String _xml(String value) => value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');

  static Future<bool> _run(String exe, List<String> args) async {
    try {
      return (await _processRun(exe, args)).exitCode == 0;
    } catch (_) {
      return false;
    }
  }
}

/// 测试用的替身：把整层换成不碰系统的一版。
///
/// 只在这两种场合注入——单元测试，以及需要在无授权环境里跑版式验收时。
/// 生产路径上它是 null，所有动作都走真实实现。
class PlatformActionsProbe {
  const PlatformActionsProbe({
    this.canAutoLaunch = true,
    this.canPreventSleep = true,
    this.autoLaunchEnabled = _defaultEnabled,
    this.setAutoLaunch = _defaultSet,
    this.beginPreventSleep = _defaultBegin,
    this.endPreventSleep = _defaultEnd,
  });

  final bool canAutoLaunch;
  final bool canPreventSleep;

  final Future<bool?> Function() autoLaunchEnabled;
  final Future<bool> Function(bool enabled) setAutoLaunch;
  final Future<bool> Function() beginPreventSleep;
  final Future<void> Function() endPreventSleep;

  static Future<bool?> _defaultEnabled() async => false;
  static Future<bool> _defaultSet(bool enabled) async => true;
  static Future<bool> _defaultBegin() async => true;
  static Future<void> _defaultEnd() async {}
}
