/// 浏览器里的崩溃记录：没有文件系统，写到控制台。
///
/// 不静默吞掉：网页端出问题时，至少在开发者工具的 Console 里能看到。
library;

class CrashLog {
  const CrashLog._();

  static void write(String scope, Object error, StackTrace? stack) {
    // ignore: avoid_print
    print('[crash][$scope] $error\n$stack');
  }
}
