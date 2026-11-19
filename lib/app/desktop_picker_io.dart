import 'dart:io';

/// 桌面端的系统文件面板。
///
/// ## 为什么用 `osascript` 而不是引一个原生插件
///
/// 这个项目没有原生侧代码（Flutter 3.50 起原生壳由工具链生成，不手写）。
/// macOS 自带 `osascript` 可以叫起 NSOpenPanel / NSSavePanel，代价是每次
/// 起一个几十毫秒的子进程——而选文件本来就是人手动作，这点延迟看不见。
///
/// 换一个 zip 包处理器、或引 `file_selector`，都要在工程里加一份平台通道；
/// 面板这种事一次交互一次进程，不值得。
///
/// ## 失败一律返回 null / 空表
///
/// 用户点「取消」时 osascript 的退出码是 1 且 stderr 有一句
/// 「User canceled」。这与「真出错」在调用点没有区别——两者都该什么都不做，
/// 所以这里不区分，统一当成「没选」。
class DesktopPicker {
  const DesktopPicker._();

  /// 实现走 `osascript`，只有 macOS 有。Windows / Linux 上这个值是 false，
  /// 调用点据此把「取文件」入口如实禁用——否则用户点下去什么都不会发生。
  static bool get supported => Platform.isMacOS;

  /// 选一个文件。`prompt` 是面板顶部的说明文字。
  static Future<String?> pickFile({required String prompt}) async {
    final out = await _run([
      '-e',
      'POSIX path of (choose file with prompt ${_lit(prompt)})',
    ]);
    return out.isEmpty ? null : out.first;
  }

  /// 选多个文件，最多 [limit] 个。
  static Future<List<String>> pickFiles({
    required String prompt,
    int limit = 3,
  }) async {
    // 多选不能用 `POSIX path of (choose file …)`：对列表取 POSIX path 在
    // 老版本 osascript 上只回第一条。显式收集再逐条转。
    final out = await _run([
      '-e',
      'set chosen to (choose file with prompt ${_lit(prompt)} '
          'with multiple selections allowed)',
      '-e',
      'set acc to ""',
      '-e',
      'repeat with f in chosen',
      '-e',
      'set acc to acc & (POSIX path of f) & linefeed',
      '-e',
      'end repeat',
      '-e',
      'return acc',
    ]);
    return out.take(limit).toList(growable: false);
  }

  /// 选一个目录。
  static Future<String?> pickDirectory(String prompt) async {
    final out = await _run([
      '-e',
      'POSIX path of (choose folder with prompt ${_lit(prompt)})',
    ]);
    return out.isEmpty ? null : out.first;
  }

  /// 「另存为」：选位置并给一个默认文件名，返回完整目标路径。
  static Future<String?> saveFile({
    required String prompt,
    required String defaultName,
  }) async {
    final out = await _run([
      '-e',
      'POSIX path of (choose file name with prompt ${_lit(prompt)} '
          'default name ${_lit(defaultName)})',
    ]);
    return out.isEmpty ? null : out.first;
  }

  /// AppleScript 字符串字面量。提示语里可能出现引号或反斜杠——
  /// 不转义的话整段脚本会语法错误，表现为「点了没反应」。
  static String _lit(String raw) {
    final escaped = raw
        .replaceAll('\\', '\\\\')
        .replaceAll('"', '\\"')
        // AppleScript 的字符串是单行的，换行要写成显式转义。
        .replaceAll('\n', '\\n');
    return '"$escaped"';
  }

  static Future<List<String>> _run(List<String> args) async {
    try {
      final r = await Process.run('osascript', args);
      if (r.exitCode != 0) return const [];
      return (r.stdout as String)
          .split('\n')
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty)
          .toList(growable: false);
    } catch (_) {
      return const [];
    }
  }
}
