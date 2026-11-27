import 'dart:convert';
import 'dart:io';

import 'history_sessions.dart';
import '../../../../../app/home_dir.dart';

/// 会话库根目录。与 `stdio_transport_io.dart` 里的 `DSH_HOME` 同一个约定：
/// 内核把会话写这儿，应用只读不写。
Directory? _sessionsRoot(String? dshHome) {
  final dir = Directory('${sessionsHome(dshHome: dshHome)}/sessions');
  return dir.existsSync() ? dir : null;
}

String sessionsHome({String? dshHome}) =>
    dshHome ??
    Platform.environment['ONDRA_DSH_HOME'] ??
    '$ondraUserHome/.ondra/dsh';

Future<List<SessionSummary>> readSessions({String? dshHome}) async {
  final root = _sessionsRoot(dshHome);
  if (root == null) return const [];

  final out = <SessionSummary>[];
  for (final project in root.listSync()) {
    if (project is! Directory) continue;
    for (final session in project.listSync()) {
      if (session is! Directory) continue;
      final file = File('${session.path}/session.v4.jsonl');
      if (!file.existsSync()) continue;
      final summary = await _readOne(file);
      if (summary != null && !_isWarmupSession(summary.id)) out.add(summary);
    }
  }
  out.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  return out;
}

/// 预热会话是内核真实落盘记录，但它不是用户对话。
///
/// 传输层必须用独立 session 才能得到与真实聊天相同的系统提示词/工具集；
/// 历史页在这里统一隐藏，避免欢迎区预热在用户历史里留下一条“你好”。
bool _isWarmupSession(String id) => id.startsWith('ondra-warmup-');

/// 读一份会话文件：标题取第一句用户消息，条数数用户消息，
/// 时间取文件最后写入时刻（会话是追加写，mtime 就是最后活动时间）。
Future<SessionSummary?> _readOne(File file) async {
  var id = file.parent.uri.pathSegments.lastWhere(
    (s) => s.isNotEmpty,
    orElse: () => '',
  );
  var cwd = '';
  var title = '';
  var messages = 0;
  DateTime? lastEvent;
  final reader = _MessageReader();

  try {
    await for (final json in _readEvents(file)) {
      if (json['type'] == 'session') {
        final rawId = json['id'];
        if (rawId is String && rawId.isNotEmpty) id = rawId;
        final rawCwd = json['cwd'];
        if (rawCwd is String) cwd = rawCwd;
        continue;
      }

      final time = _timeOf(json['time']);
      if (time != null && (lastEvent == null || time.isAfter(lastEvent))) {
        lastEvent = time;
      }

      for (final entry in reader.entriesOf(json)) {
        if (entry.role != 'user') continue;
        messages++;
        if (title.isEmpty) {
          title = _tidy(entry.displayText);
        }
      }
    }
  } catch (_) {
    return null;
  }

  if (id.isEmpty) return null;
  // 会话时间取「消息事件时间」与「最近一条消息的时间」二者中的较晚者，
  // 不再用文件 mtime 做下限：复制/恢复刷新 mtime 会把 10 月的会话排到今天。
  final lastMessage = reader.lastMessageAt;
  final latest = [lastEvent, lastMessage].nonNulls.fold<DateTime?>(
    null,
    (acc, t) => acc == null || t.isAfter(acc) ? t : acc,
  );
  return SessionSummary(
    id: id,
    title: title.isEmpty ? '空白会话' : title,
    messages: messages,
    updatedAt: latest ?? file.statSync().modified,
    cwd: cwd,
    sourcePath: file.path,
  );
}

/// 一行坏数据不影响后续事件；摘要与详情使用同一套容错规则。
Stream<Map> _readEvents(File file) async* {
  // utf8.decoder 默认遇到截断的多字节字符会抛 FormatException，
  // 一行坏字符就会让整份会话从列表消失。allowMalformed 让它变成替换字符，
  // 逐行 JSON 解析仍会跳过真正坏掉的那一行，其他消息照常显示。
  await for (final line
      in file
          .openRead()
          .transform(const Utf8Decoder(allowMalformed: true))
          .transform(const LineSplitter())) {
    if (line.trim().isEmpty) continue;
    final Object? json;
    try {
      json = jsonDecode(line);
    } on FormatException {
      continue; // 半截行（进程被杀时会有）直接跳过。
    }
    if (json is Map) yield json;
  }
}

/// DSH v4 的 inbox 与 user/message 会记录同一个用户消息，靠稳定 id 去重。
/// 不按正文去重：用户或助手在不同轮次说了同一句话，仍然是不同消息。
class _MessageReader {
  final _seenIds = <(String, String)>{};
  final _seenEvents = <(String, int)>{};
  DateTime? lastMessageAt;

  Iterable<HistoryEntry> entriesOf(Map event) sync* {
    final type = event['type'];
    if (type != 'agent/inbox/spliced' &&
        type != 'assistant/message' &&
        type != 'user/message') {
      return;
    }
    final data = event['data'];
    if (data is! Map) return;
    final seq = event['seq'];
    if (seq is int && !_seenEvents.add((type as String, seq))) return;

    if (type == 'agent/inbox/spliced') {
      final inserted = data['inserted'];
      if (inserted is! List) return;
      for (final message in inserted) {
        if (message is! Map || message['role'] != 'user') continue;
        final entry = _entryOf(message, 'user');
        if (entry != null) {
          _noteTime(event, message);
          yield entry;
        }
      }
    } else {
      // v4 的 user/message 直接以 data 作为消息；兼容包在 message 里的写法。
      final message = type == 'user/message'
          ? (data['message'] ?? data)
          : data['message'];
      if (message is! Map) return;
      final entry = _entryOf(
        message,
        type == 'user/message' ? 'user' : 'assistant',
      );
      if (entry != null) yield entry;
      if (entry != null) _noteTime(event, message);
    }
  }

  /// 消息事件自带的时间优先；没有时间时用文件里事件的 time 兜底。
  void _noteTime(Map event, Map message) {
    final raw = message['createdAt'] ?? message['timestamp'] ?? event['time'];
    final time = _timeOf(raw);
    if (time != null &&
        (lastMessageAt == null || time.isAfter(lastMessageAt!))) {
      lastMessageAt = time;
    }
  }

  HistoryEntry? _entryOf(Map message, String role) {
    if (message['role'] != null && message['role'] != role) return null;
    final source = message['source'];
    // 内核也会以 user 角色注入运行时上下文、压缩摘要等，不是用户说的话。
    if (role == 'user' && source is Map && source['kind'] != 'user') {
      return null;
    }
    final text = _contentTextOf(message['content']);
    final hasImage = _contentHasImage(message['content']);
    if (text.trim().isEmpty && !hasImage) return null;
    // stop 超时后，内核会把 /cancel-turn 作为 user 消息留在会话里。
    // 它是内部指令，不是用户发过的话：计数与详情都要排除。
    if (role == 'user' && _isInternalCommand(text)) return null;
    final id = message['id'];
    if (id is String && id.isNotEmpty && !_seenIds.add((role, id))) {
      return null;
    }
    return HistoryEntry(role: role, text: text, hasImage: hasImage);
  }
}

bool _isInternalCommand(String text) {
  final trimmed = text.trimLeft();
  return trimmed.startsWith('/cancel-turn') ||
      trimmed.startsWith('/resume-turn');
}

/// 毫秒整数（新版）或 ISO 串（旧版）都认。
DateTime? _timeOf(Object? raw) {
  if (raw is int) {
    try {
      return DateTime.fromMillisecondsSinceEpoch(
        raw < 100000000000 ? raw * 1000 : raw,
      );
    } on ArgumentError {
      return null;
    }
  }
  if (raw is String) return DateTime.tryParse(raw);
  return null;
}

/// 标题压成一行：换行、连续空白、首尾空白都收掉，超长截断。
String _tidy(String text) {
  final oneLine = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (oneLine.length <= 60) return oneLine;
  return '${oneLine.substring(0, 59)}…';
}

/// 读一份会话的完整对话（user / assistant 的正文，保留日志追加顺序）。
///
/// 用户从 inbox / user/message 读取，助手从 assistant/message 读取。
/// 工具、系统、增量和尝试事件不进历史，避免泄露内部内容或重复正文。
Future<List<HistoryEntry>> readSessionMessages(
  String sessionId, {
  String? dshHome,
  String? sourcePath,
}) async {
  if (_isWarmupSession(sessionId)) return const [];
  // 列表已经知道文件在哪：重号会话必须按列表点中的那份文件读，
  // 不能只拿 id 全库找第一个（alpha.17 审查：「点第二份会打开第一份」）。
  final cached = sourcePath == null ? null : File(sourcePath);
  final file = cached != null && cached.existsSync()
      ? cached
      : await _findSessionFile(sessionId, dshHome: dshHome);
  if (file == null) return const [];

  final out = <HistoryEntry>[];
  final reader = _MessageReader();
  try {
    await for (final json in _readEvents(file)) {
      out.addAll(reader.entriesOf(json));
    }
  } catch (_) {
    return out; // 半截文件就给已读到的部分，不整页报错。
  }
  return out;
}

/// content 是字符串直接用；是块列表就拼出 text 段。
String _contentTextOf(Object? content) {
  if (content is String) return content;
  if (content is List) {
    final buf = StringBuffer();
    for (final part in content) {
      if (part is Map && part['type'] == 'text' && part['text'] is String) {
        buf.write(part['text']);
      }
    }
    return buf.toString();
  }
  return '';
}

/// 图片块本身没有可读正文，但它让「纯图片消息」仍然是一条真实消息。
bool _contentHasImage(Object? content) {
  if (content is! List) return false;
  for (final part in content) {
    if (part is Map &&
        (part['type'] == 'image' || part['type'] == 'image_url')) {
      return true;
    }
  }
  return false;
}

/// 按 id 找会话文件。逐层扫目录与 [readSessions] 同一个口径；
/// 找不到返回 null，调用方显示空态。
Future<File?> _findSessionFile(String sessionId, {String? dshHome}) async {
  if (_isWarmupSession(sessionId)) return null;
  final root = _sessionsRoot(dshHome);
  if (root == null) return null;
  for (final project in root.listSync()) {
    if (project is! Directory) continue;
    for (final session in project.listSync()) {
      if (session is! Directory) continue;
      final file = File('${session.path}/session.v4.jsonl');
      if (!file.existsSync()) continue;
      if (session.uri.pathSegments.lastWhere(
            (s) => s.isNotEmpty,
            orElse: () => '',
          ) ==
          sessionId) {
        return file;
      }
      // 目录名不一定等于会话 id（旧版会把 id 写在文件里），
      // 旧文件开头可能有空行，逐行跳过直到找到会话头（列表以同样规则读）。
      try {
        await for (final json in _readEvents(file)) {
          if (json['type'] == 'session' && json['id'] == sessionId) {
            return file;
          }
          break; // 只有会话头能证明 id；第一条有效行不是就换下一份文件。
        }
      } catch (_) {
        continue;
      }
    }
  }
  return null;
}
