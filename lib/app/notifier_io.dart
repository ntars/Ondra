import 'dart:io';

import 'package:flutter/services.dart'
    show MethodChannel, MissingPluginException, PlatformException;

/// 桌面端的系统通知。
///
/// ## 为什么用 `osascript` 而不是引原生插件
///
/// 与 `desktop_picker` 同一个理由：这个工程没有原生侧代码。macOS 的
/// `osascript` 可以 `display notification`，代价是起一个几十毫秒的子进程，
/// 而通知本来就是「一件事结束时说一句」，频次极低。
///
/// ## 静音与不发是两件事
///
/// - 「启用系统通知」关掉 → 什么都不弹；
/// - 「通知提示音」关掉 → 弹，但 `sound name` 不写。
///
/// 两个开关分开，是因为「安静地告诉我」是真实需求：全屏工作时想要角标、
/// 不想要声音，那就是提示音关、通知开。
///
/// 「专注时静音」由调用方判断（它要知道当前是不是全屏），这一层只执行。
const MethodChannel _notifyChannel = MethodChannel('ondra/notify');

class Notifier {
  const Notifier._();

  /// 仅测试能力分支；Linux 尚无 notify-send 实现，不能执行 osascript。
  static String? debugOperatingSystemOverride;
  static bool get supported =>
      probe != null ||
      (debugOperatingSystemOverride ?? Platform.operatingSystem) == 'android' ||
      (debugOperatingSystemOverride ?? Platform.operatingSystem) == 'windows' ||
      ((debugOperatingSystemOverride ?? Platform.operatingSystem) == 'macos' &&
          (debugProcessRunner != null ||
              File('/usr/bin/osascript').existsSync()));

  /// 保留 show 的 void 契约；需要执行结果的调用者可 await tryShow。
  static String? lastError;
  static Future<ProcessResult> Function(String, List<String>)?
  debugProcessRunner;

  /// 测试桩：整层替换掉，避免测试真的弹系统通知。
  ///
  /// 一条测试弹一次通知，跑二十条就在用户的通知中心留下二十条
  /// 「模版测试」——那比测试失败更烦人。
  static NotifierProbe? probe;

  /// 弹一条通知。
  ///
  /// [title] 是标题，[body] 是正文。两者都会进 AppleScript 字符串，
  /// 所以要转义引号与反斜杠，否则消息里带一个 `"` 就会让整条命令语法错误。
  static Future<void> show({
    required String title,
    required String body,
    bool sound = true,
  }) async {
    await tryShow(title: title, body: body, sound: sound);
  }

  /// true 表示系统命令已接受请求，不保证用户没有用勿扰/通知权限隐藏横幅。
  static Future<bool> tryShow({
    required String title,
    required String body,
    bool sound = true,
  }) async {
    lastError = null;
    if (!supported) {
      lastError = '当前平台不支持系统通知';
      return false;
    }
    try {
      if (probe != null) {
        await probe!.show(title: title, body: body, sound: sound);
        return true;
      }
      // 安卓走原生通道（NotificationManager）；参数形状与
      // MainActivity.kt 的 ondra/notify handler 一致。
      if ((debugOperatingSystemOverride ?? Platform.operatingSystem) ==
          'android') {
        try {
          await _notifyChannel.invokeMethod<bool>('show', {
            'title': title,
            'body': body,
            'sound': sound,
          });
          return true;
        } on PlatformException catch (e) {
          lastError = e.message ?? '通知发送失败';
          return false;
        }
      }
      if ((debugOperatingSystemOverride ?? Platform.operatingSystem) ==
          'windows') {
        try {
          final shown = await _notifyChannel.invokeMethod<bool>('show', {
            'title': title,
            'body': body,
            'sound': sound,
          });
          if (shown != true) {
            lastError = 'Windows 通知没有送达';
            return false;
          }
          return true;
        } on PlatformException catch (e) {
          lastError = e.message ?? '通知发送失败';
          return false;
        } on MissingPluginException {
          lastError = '这个 Windows 构建没有通知后端';
          return false;
        }
      }
      final soundPart = sound ? ' sound name "Glass"' : '';
      final args = [
        '-e',
        'display notification ${_lit(body)} '
            'with title ${_lit(title)}$soundPart',
      ];
      final result =
          await (debugProcessRunner?.call('/usr/bin/osascript', args) ??
              Process.run('/usr/bin/osascript', args));
      if (result.exitCode != 0) {
        lastError = '系统通知请求失败（${result.exitCode}）：${result.stderr}';
        return false;
      }
      return true;
    } catch (e) {
      lastError = '系统通知请求失败：$e';
      return false;
    }
  }

  /// 把一段文本变成 AppleScript 的字符串字面量。
  static String _lit(String s) {
    final escaped = s
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        // 换行在 AppleScript 单行脚本里必须显式写成 \n，
        // 直接塞一个真换行会让 `-e` 参数被截断。
        .replaceAll('\n', '\\n')
        .replaceAll('\r', '');
    return '"$escaped"';
  }
}

/// 测试用的替身：记下被要求发过的通知，不碰系统。
class NotifierProbe {
  NotifierProbe();

  /// 发过的每一条，按顺序。
  final List<({String title, String body, bool sound})> sent = [];

  Future<void> show({
    required String title,
    required String body,
    bool sound = true,
  }) async {
    sent.add((title: title, body: body, sound: sound));
  }
}
