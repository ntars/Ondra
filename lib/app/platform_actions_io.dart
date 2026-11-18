import 'dart:io';

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

  static String get _plistPath {
    final home = Platform.environment['HOME'] ?? '';
    return '$home/Library/LaunchAgents/$_label.plist';
  }

  static bool get canAutoLaunch => probe?.canAutoLaunch ?? (Platform.isMacOS || Platform.isLinux);

  static bool get canPreventSleep => probe?.canPreventSleep ?? (Platform.isMacOS || Platform.isLinux);

  /// 当前应用的绝对路径。写进 plist 的 `ProgramArguments` 要能在登录时
  /// 被 `launchd` 直接执行，相对路径在登录阶段没有意义（工作目录不确定）。
  static String get _executable => Platform.resolvedExecutable;

  static Future<bool?> autoLaunchEnabled() async {
    if (probe != null) return probe!.autoLaunchEnabled();
    if (!canAutoLaunch) return null;
    try {
      return File(_plistPath).existsSync();
    } catch (_) {
      return null;
    }
  }

  static Future<bool> setAutoLaunch(bool enabled) async {
    if (probe != null) return probe!.setAutoLaunch(enabled);
    if (!canAutoLaunch) return false;
    try {
      final file = File(_plistPath);
      if (!enabled) {
        // 先 unload 再删：顺序反了的话 launchd 会继续记着这一条，
        // 直到下次登录才忘掉，用户会以为「关掉了但还在自启」。
        await _run('/bin/launchctl', ['unload', _plistPath]);
        if (file.existsSync()) file.deleteSync();
        return true;
      }
      final dir = Directory(file.parent.path);
      if (!dir.existsSync()) dir.createSync(recursive: true);
      file.writeAsStringSync(_plist(), flush: true);
      // load 失败不回滚：文件已经写好了，下次登录依然会生效。
      // 这一句只是让「现在就生效」，失败也不影响最终结果。
      await _run('/bin/launchctl', ['load', _plistPath]);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// LaunchAgent 的内容。
  ///
  /// `RunAtLoad` 是「登录时启动」，`KeepAlive=false` 是「别崩溃后无限重拉」——
  /// 后者若为 true，用户在应用里主动退出也会被立刻拉起来，那不是自启动，
  /// 是耍流氓。
  static String _plist() => '''
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$_executable</string>
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

  static Future<bool> beginPreventSleep() async {
    if (probe != null) return probe!.beginPreventSleep();
    if (!canPreventSleep) return false;
    // 已经在阻止就不重复起：两个 caffeinate 会各自持有一份断言，
    // 之后只 end 一次就解除不干净。
    if (_caffeinate != null) return true;
    try {
      _caffeinate = await Process.start('/usr/bin/caffeinate', ['-i']);
      // 子进程退出（被系统杀、被用户 kill）时把句柄清掉，
      // 否则下次 begin 会以为「还阻止着」而直接返回 true。
      _caffeinate!.exitCode.then((_) => _caffeinate = null);
      return true;
    } catch (_) {
      _caffeinate = null;
      return false;
    }
  }

  static Future<void> endPreventSleep() async {
    if (probe != null) return probe!.endPreventSleep();
    final p = _caffeinate;
    _caffeinate = null;
    if (p == null) return;
    try {
      p.kill();
    } catch (_) {
      // 进程可能已经自己退出了，这里没有别的补救动作。
    }
  }

  /// 起一个子进程并等它结束，失败不抛。
  static Future<void> _run(String exe, List<String> args) async {
    try {
      await Process.run(exe, args);
    } catch (_) {
      // launchctl 在某些沙箱里不可用；调用方已经按「文件写到了就算成功」处理。
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
