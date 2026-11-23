import 'dart:io';

import 'version.dart';
import 'home_dir.dart';
import 'prefs.dart';

/// 把一次崩溃写进 `~/.ondra/logs/crash.log`。
///
/// ## 为什么只写本地
///
/// 「崩溃上报」这个开关的文案写着「只发堆栈与版本号，不发对话内容」。
/// 但**发给谁**是个需要先回答的问题：发到自己的服务器要有个服务器，
/// 发到第三方要一套账号与合规。在没答案之前，联网上报只能是一个假动作。
///
/// 所以这里做的是**下限**：本地留一份堆栈。用户来问「为什么闪退」时，
/// 有这一行可以直接看；没有就只能让他复现。要不要真的往外发，
/// 等有了接收端再在 `onError` 里加一个分支——那时这一层的形状不用变。
///
/// ## 不覆盖、不滚动
///
/// 追加写，单文件超过 256KB 就轮到下一个编号。做成滚动而不是清空：
/// 闪退往往是连着好几次，第一次的现场最有价值，不能被后来的洗掉。
class CrashLog {
  const CrashLog._();

  /// 单个文件的上限。堆栈一般 2–8KB，256KB 能放几十次。
  static const int _maxBytes = 256 * 1024;

  /// 设置页里 `privacy.redactLogs` 的持久化键。
  ///
  /// 不 import `SettingsClient`：`main.dart` 在 `runApp` 前就会调用
  /// `CrashLog`，而设置客户端又依赖配置和平台动作，两条初始化链相交会形成
  /// 循环，也会把崩溃记录器绑到一整棵 UI 依赖上。这里只读同一份 prefs
  /// 键；读取失败、文件损坏或值不是明确的 `false` 时都按开启处理。
  static const String _redactPrefsKey = 'settings.privacy.redactLogs';

  static String get _dir {
    final home = debugHomeOverride ?? ondraUserHome;
    return '$home/.ondra/logs';
  }

  /// 用户是否要求对崩溃日志做敏感信息脱敏。
  ///
  /// 默认必须是安全的：没有保存过偏好（首启）、prefs 损坏、读不到文件，
  /// 或写成 `0`/`no` 之类无法识别的值时，只能把它当作「开启」。唯一
  /// 关闭脱敏的证据是设置页明确保存的字符串 `false`。
  static bool get _redactEnabled {
    try {
      return readPref(_redactPrefsKey, fallback: 'true').trim().toLowerCase() !=
          'false';
    } catch (_) {
      return true;
    }
  }

  /// 聚焦测试的重定向点；生产代码始终为 null，日志落在真实用户目录。
  static String? debugHomeOverride;

  /// 记一次崩溃。任何时候都不抛——记录崩溃的代码自己崩掉毫无意义。
  static void write(String scope, Object error, StackTrace? stack) {
    try {
      final dir = Directory(_dir);
      if (!dir.existsSync()) dir.createSync(recursive: true);
      final file = _rotateIfNeeded(dir);
      final home = debugHomeOverride ?? ondraUserHome;
      final extendedRedaction = _redactEnabled;
      String redact(Object raw) {
        var text = '$raw';
        // 隐私基线不随开关关闭：堆栈里的绝对路径会带出用户名和本机目录，
        // 崩溃日志只需要定位代码，不需要暴露「谁在哪台机器上运行」。
        if (home.isNotEmpty) text = text.replaceAll(home, '~');
        // 开关关闭时保留其余原文，便于本地排障；路径基线仍然执行。
        if (!extendedRedaction) return text;
        // 邮箱整段抹掉。它与下面的密钥规则一样属于设置页承诺的扩展脱敏；
        // 关闭开关意味着用户明确接受本地日志保留这些内容。
        text = text.replaceAllMapped(
          RegExp('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'),
          (_) => '<email>',
        );
        // 常见密钥形态：API key 的通用形状是 sk- 前缀、Bearer 后接 token、
        // 32+ 位十六进制串。alpha.15 审查：开关必须真正控制这段处理，不能
        // 一边显示「日志脱敏」一边无论开关如何都执行同一套固定规则。
        text = text.replaceAllMapped(
          RegExp(r'sk-[A-Za-z0-9_-]{16,}'),
          (_) => '<key>',
        );
        text = text.replaceAllMapped(
          RegExp(r'Bearer\s+[A-Za-z0-9._-]{16,}'),
          (_) => 'Bearer <key>',
        );
        text = text.replaceAllMapped(
          RegExp(r'\b[0-9a-fA-F]{32,}\b'),
          (_) => '<hex>',
        );
        return text;
      }

      // 官方 crash-report 结构：完整 error + 原因链 + 进程事实。
      // 恢复对话框只显示末几行，文件存全量——排障时「第一次的现场」
      // 连同当时的环境一起留档。
      final causeChain = <String>[];
      Object cause = error;
      while (true) {
        Object? inner;
        try {
          inner = (cause as dynamic).cause as Object?;
        } catch (_) {
          inner = null;
        }
        if (inner == null) break;
        causeChain.add(redact('$inner'));
        cause = inner;
        if (causeChain.length > 8) break;
      }
      file.writeAsStringSync(
        '${_stamp()} [$scope] v$ondraVersion\n'
        'error: ${redact('$error')}\n'
        '${causeChain.isEmpty ? '' : 'cause chain:\n${causeChain.map((c) => '  - $c').join('\n')}\n'}'
        'process: pid=$pid dart=${Platform.version} '
        'os=${Platform.operatingSystem}-${Platform.operatingSystemVersion}\n'
        '${redact(stack ?? '')}\n'
        '${'-' * 60}\n',
        mode: FileMode.append,
        flush: true,
      );
    } catch (_) {
      // 磁盘满、目录只读——都没有补救动作，也不能让这里再抛一次。
    }
  }

  /// 当前该写哪个文件。超过上限就换下一个编号，最多留 5 份。
  static File _rotateIfNeeded(Directory dir) {
    for (var i = 0; i < 5; i++) {
      final name = i == 0 ? 'crash.log' : 'crash.$i.log';
      final f = File('${dir.path}/$name');
      if (!f.existsSync() || f.lengthSync() < _maxBytes) return f;
    }
    // 五份都满了：从最老的那份重新开始，而不是不写了。
    // 崩溃日志的价值随时间衰减，留着最老的第 0 份而丢掉今天的现场是反的。
    final oldest = File('${dir.path}/crash.4.log');
    try {
      oldest.deleteSync();
    } catch (_) {}
    return File('${dir.path}/crash.4.log');
  }

  static String _stamp() {
    final t = DateTime.now();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)} '
        '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
  }
}
