import 'dart:convert';
import 'dart:io';

import 'history_sessions.dart';
import '../../../../../app/home_dir.dart';

/// 会话库根目录。与 `stdio_transport_io.dart` 里的 `DSH_HOME` 同一个约定：
/// 内核把会话写这儿，应用只读不写。
Directory? _sessionsRoot() {
  final home = ondraUserHome;
  final dir = Directory('$home/.ondra/dsh/sessions');
  return dir.existsSync() ? dir : null;
}

Future<List<SessionSummary>> readSessions() async {
  final root = _sessionsRoot();
  if (root == null) return const [];

  final out = <SessionSummary>[];
  for (final project in root.listSync()) {
    if (project is! Directory) continue;
    for (final session in project.listSync()) {
      if (session is! Directory) continue;
      final file = File('${session.path}/session.v4.jsonl');
      if (!file.existsSync()) continue;
      final summary = await _readOne(file);
      if (summary != null) out.add(summary);
    }
  }
  out.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  return out;
}

/// 读一份会话文件：标题取第一句用户消息，条数数用户消息，
/// 时间取文件最后写入时刻（会话是追加写，mtime 就是最后活动时间）。
Future<SessionSummary?> _readOne(File file) async {
  var id = file.parent.uri.pathSegments.lastWhere((s) => s.isNotEmpty, orElse: () => '');
  var cwd = '';
  var title = '';
  var messages = 0;
  DateTime? lastEvent;

  try {
    await for (final line in file
        .openRead()
        .transform(utf8.decoder)
        .transform(const LineSplitter())) {
      if (line.isEmpty) continue;
      final Object? json;
      try {
        json = jsonDecode(line);
      } catch (_) {
        continue; // 半截行（进程被杀时会有）直接跳过
      }
      if (json is! Map) continue;

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

      final text = _userTextOf(json);
      if (text == null) continue;
      messages++;
      if (title.isEmpty) title = _tidy(text);
    }
  } catch (_) {
    return null;
  }

  if (id.isEmpty) return null;
  final mtime = file.statSync().modified;
  return SessionSummary(
    id: id,
    title: title.isEmpty ? '空白会话' : title,
    messages: messages,
    updatedAt: (lastEvent != null && lastEvent.isAfter(mtime)) ? lastEvent : mtime,
    cwd: cwd,
  );
}

/// `agent/inbox/spliced` 里的用户消息：`data.inserted[].role == 'user'`。
/// 兼容两种摆法——有的版本把文本放在 `content[].text`，有的直接给字符串。
String? _userTextOf(Map json) {
  final data = json['data'];
  if (data is! Map) return null;
  final inserted = data['inserted'];
  if (inserted is! List) return null;
  for (final item in inserted) {
    if (item is! Map) continue;
    if (item['role'] != 'user') continue;
    final content = item['content'];
    if (content is String) return content;
    if (content is List) {
      final buf = StringBuffer();
      for (final part in content) {
        if (part is Map && part['type'] == 'text' && part['text'] is String) {
          buf.write(part['text']);
        }
      }
      if (buf.isNotEmpty) return buf.toString();
    }
  }
  return null;
}

/// 毫秒整数（新版）或 ISO 串（旧版）都认。
DateTime? _timeOf(Object? raw) {
  if (raw is int) {
    return DateTime.fromMillisecondsSinceEpoch(
      raw < 100000000000 ? raw * 1000 : raw,
    );
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

/// 读一份会话的完整对话（user / assistant 的正文，按时间顺序）。
///
/// 会话是追加写的 jsonl：每一行是一条事件，用户与助手的正文都在
/// `data.inserted[]` 里。工具调用、系统事件没有正文，直接跳过——
/// 历史页要的是「当时说了什么」，不是内核的事件流水。
Future<List<HistoryEntry>> readSessionMessages(String sessionId) async {
  final file = await _findSessionFile(sessionId);
  if (file == null) return const [];

  final out = <HistoryEntry>[];
  try {
    await for (final line in file
        .openRead()
        .transform(utf8.decoder)
        .transform(const LineSplitter())) {
      if (line.isEmpty) continue;
      final Object? json;
      try {
        json = jsonDecode(line);
      } catch (_) {
        continue;
      }
      if (json is! Map) continue;
      final data = json['data'];
      if (data is! Map) continue;
      final inserted = data['inserted'];
      if (inserted is! List) continue;
      for (final item in inserted) {
        if (item is! Map) continue;
        final role = item['role'];
        if (role != 'user' && role != 'assistant') continue;
        final text = _contentTextOf(item['content']);
        if (text.isEmpty) continue;
        out.add(HistoryEntry(role: role as String, text: text));
      }
    }
  } catch (_) {
    return out; // 半截文件就给已读到的部分，不整页报错。
  }
  return out;
}

/// content 是字符串直接用；是块列表就拼出 text 段（图片块没有正文可拼）。
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

/// 按 id 找会话文件。逐层扫目录与 [readSessions] 同一个口径；
/// 找不到返回 null，调用方显示空态。
Future<File?> _findSessionFile(String sessionId) async {
  final root = _sessionsRoot();
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
      // 扫第一行确认。
      try {
        final first = await file
            .openRead()
            .transform(utf8.decoder)
            .transform(const LineSplitter())
            .first;
        final Object? json;
        try {
          json = jsonDecode(first);
        } catch (_) {
          continue;
        }
        if (json is Map && json['type'] == 'session' && json['id'] == sessionId) {
          return file;
        }
      } catch (_) {
        continue;
      }
    }
  }
  return null;
}
