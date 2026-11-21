import 'dart:io';

import 'version.dart';
import 'home_dir.dart';

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

  static String get _dir {
    final home = ondraUserHome;
    return '$home/.ondra/logs';
  }

  /// 记一次崩溃。任何时候都不抛——记录崩溃的代码自己崩掉毫无意义。
  static void write(String scope, Object error, StackTrace? stack) {
    try {
      final dir = Directory(_dir);
      if (!dir.existsSync()) dir.createSync(recursive: true);
      final file = _rotateIfNeeded(dir);
      final home = ondraUserHome;
      String redact(Object raw) {
        var text = '$raw';
        // 邮箱整段抹掉（alpha.2 审查第 14 项：脱敏开关之外，崩溃日志
        // 本身也不该留可识别信息——它是排障材料，不是档案）。
        text = text.replaceAllMapped(
          RegExp('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'),
          (_) => '<email>',
        );
        // 用户主目录抹掉：堆栈里的绝对路径会带出用户名。
        if (home.isNotEmpty) text = text.replaceAll(home, '~');
        // 常见密钥形态抹掉（alpha.10 审查第 16 项：设置承诺「路径、邮箱、
        // 密钥」，崩溃日志此前只有前两类）。API key 的通用形状：
        // sk- 前缀、Bearer 后接 token、32+ 位十六进制串。
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
