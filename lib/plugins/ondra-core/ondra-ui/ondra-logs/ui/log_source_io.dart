import 'dart:convert';
import 'dart:io';

import 'log_types.dart';
import '../../../../../app/home_dir.dart';

/// 每页最多读多少行。日志是排查用的，不是账本——
/// 一屏给最近 200 条，比给全部几千条再让人滚到底有用得多。
const int _maxLines = 200;

/// 单个文件最多读多少字节。`ondra-code.log` 会长期追加，
/// 从尾部读 512KB 已经够 200 条，也避免打开几十兆的文件。
const int _maxBytes = 512 * 1024;

/// 读某一类日志。
///
/// 三类各对应一个真实文件：
///
/// | 页面 | 文件 | 写入者 |
/// |---|---|---|
/// | 对话日志 | `transport.log` | 传输层（握手、帧、用量） |
/// | 插件日志 | `ondra-code.log` | 插件树（`[ondra.xxx]` 前缀） |
/// | 系统日志 | `window.log` | 原生窗口（frame / layout / 外观） |
///
/// [note] 非空表示「这次为什么没有条目」，界面据此区分空态原因。
///
/// [maxLines] 由设置「性能与用量」决定：简洁档少读些、详细档多读些。
/// 之前这个开关只写 prefs 没人消费——切了档页面纹丝不动。
Future<List<LogEntry>> loadLogEntries(LogKind kind, {int maxLines = _maxLines}) async {
  final home = ondraUserHome;
  final dir = Directory('$home/.ondra/logs');
  if (!dir.existsSync()) return const [];

  final files = switch (kind) {
    LogKind.dialog => ['transport.log'],
    // 插件日志只认插件树自己那份：宿主日志混进来会把「哪个插件在报错」
    // 这件事冲淡。
    LogKind.plugin => ['ondra-code.log'],
    // 系统日志只看窗口：传输层已经有一整页了，两边都塞会让人以为
    // 「系统」里出现了新东西，实际是同一行。
    LogKind.system => ['window.log'],
  };

  final out = <_Stamped>[];
  for (final name in files) {
    final file = File('${dir.path}/$name');
    if (!file.existsSync()) continue;
    final lines = await _tailLines(file, maxLines);
    out.addAll(_parse(name, lines));
  }

  // 最新的在上。排序用完整时间戳而不是显示用的「时:分:秒」——
  // 只比时分秒的话，昨天的 23:50 会排到今天的 08:00 前面。
  out.sort((a, b) => (b.stamp ?? DateTime(0)).compareTo(a.stamp ?? DateTime(0)));
  return out.take(_maxLines).map((s) => s.entry).toList(growable: false);
}

/// 一条日志带上完整时间戳。界面只显示时分秒，排序要完整的。
class _Stamped {
  const _Stamped(this.stamp, this.entry);

  final DateTime? stamp;
  final LogEntry entry;
}

/// 从文件尾读 [max] 行。
///
/// 用 `RandomAccessFile` 从末尾往回找换行，而不是 `readAsLines`：
/// 后者会把整个文件读进内存，`ondra-code.log` 累积到几十兆时就是一次卡顿。
Future<List<String>> _tailLines(File file, int max) async {
  final length = await file.length();
  if (length == 0) return const [];
  final start = length > _maxBytes ? length - _maxBytes : 0;
  final raf = await file.open();
  try {
    await raf.setPosition(start);
    final bytes = await raf.read(length - start);
    // 必须按 UTF-8 解码：用 `String.fromCharCodes` 会把每个字节当成一个
    // 码位，中文全变成「éç½®」这种乱码。
    final text = utf8.decode(bytes, allowMalformed: true);
    final lines = text.split('\n');
    // 截断处的那一行可能断在中间，丢掉：半行日志比没有更容易误导。
    if (start > 0 && lines.isNotEmpty) lines.removeAt(0);
    return lines.length > max
        ? lines.sublist(lines.length - max)
        : lines;
  } finally {
    await raf.close();
  }
}

/// ISO / 空格两种时间戳都认。第三段是正文。
final RegExp _iso = RegExp(r'^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s+(.*)$');
final RegExp _bracketTime = RegExp(r'^\[(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})[^\]]*\]\s*(.*)$');
final RegExp _levelWord = RegExp(r'^(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\b\s*(.*)$');
final RegExp _tagPrefix = RegExp(r'^\[([^\]]+)\]\s*(.*)$');

List<_Stamped> _parse(String fileName, List<String> lines) {
  final out = <_Stamped>[];
  var lastTime = '';
  DateTime? lastStamp;
  for (final raw in lines) {
    final line = raw.trimRight();
    if (line.trim().isEmpty) continue;

    var time = lastTime;
    var stamp = lastStamp;
    var rest = line;

    final match = _iso.firstMatch(line) ?? _bracketTime.firstMatch(line);
    if (match != null) {
      time = match.group(2) ?? '';
      // `2026-11-17 12:49:13 +0000` 里的时区不参与显示，只用于排序；
      // 日志是同一台机器写的，统一按本地时间比较不会错位。
      stamp = DateTime.tryParse('${match.group(1)} ${match.group(2)}') ?? lastStamp;
      lastTime = time;
      lastStamp = stamp;
      rest = match.group(3)?.trim() ?? '';
    } else if (line.startsWith('[') && line.contains(']')) {
      // `[after-1.5s]` 这类没有日期的时间标记：沿用上一条的时间，
      // 比显示一个空时间列清楚。
      final close = line.indexOf(']');
      rest = line.substring(close + 1).trim();
    }
    if (rest.isEmpty) continue;

    var level = LogLevel.info;
    final levelMatch = _levelWord.firstMatch(rest);
    if (levelMatch != null) {
      level = switch (levelMatch.group(1)) {
        'ERROR' => LogLevel.error,
        'WARN' || 'WARNING' => LogLevel.warn,
        _ => LogLevel.info,
      };
      rest = levelMatch.group(2)?.trim() ?? '';
    } else if (rest.toUpperCase().contains('ERROR') || rest.contains('失败')) {
      // 传输层的行没有级别字，靠关键词兜：`open failed`、`initialize failed`
      // 这些不标成错误就会淹没在正常行里。
      level = LogLevel.error;
    } else if (rest.contains('warn') || rest.contains('警告')) {
      level = LogLevel.warn;
    }

    String? tag;
    final tagMatch = _tagPrefix.firstMatch(rest);
    if (tagMatch != null) {
      tag = tagMatch.group(1)?.trim();
      rest = tagMatch.group(2)?.trim() ?? '';
    }
    if (rest.isEmpty) continue;

    // 标题取第一句，剩下的作详情：一行 200 字的 JSON 帧直接铺开没人读。
    final split = _splitTitle(rest);
    out.add(
      _Stamped(
        stamp,
        LogEntry(
          time: time,
          title: split.$1,
          detail: split.$2,
          level: level,
          tag: tag ?? _defaultTag(fileName),
        ),
      ),
    );
  }
  return out;
}

/// 文件本身就是一个标签来源——系统页里混着两个文件时，
/// 列表里要能看出哪行来自窗口、哪行来自传输层。
String? _defaultTag(String fileName) => switch (fileName) {
  'transport.log' => '传输',
  'window.log' => '窗口',
  _ => null,
};

(String, String) _splitTitle(String text) {
  const maxTitle = 42;
  if (text.length <= maxTitle) return (text, '');
  // 从上限往回找一个能断的地方：标点优于空格，空格优于硬切。
  // 直接 `substring(0, 42)` 会把 `sending initialize` 切成
  // `sending initia|lize`，读起来像两个字。
  const breakers = '，。；：,.;:、 ';
  var cut = -1;
  for (var i = maxTitle; i > 12; i--) {
    if (breakers.contains(text[i - 1])) {
      cut = i;
      break;
    }
  }
  if (cut > 12) {
    return (text.substring(0, cut).trimRight(), text.substring(cut).trim());
  }
  return (text.substring(0, maxTitle), text.substring(maxTitle).trim());
}
