import 'history_sessions_stub.dart'
    if (dart.library.io) 'history_sessions_io.dart' as impl;

/// 一条会话摘要：会话文件里能**如实读出**的那几样。
///
/// 不读全文、不读模型回复的正文——列表只需要认出「哪一轮、什么时候、
/// 说了几句」。正文留在会话文件里，等用户点进去再读。
class SessionSummary {
  const SessionSummary({
    required this.id,
    required this.title,
    required this.messages,
    required this.updatedAt,
    required this.cwd,
  });

  final String id;

  /// 第一句用户消息的开头；一条用户消息都没有时给「空白会话」。
  final String title;

  /// 用户消息条数——不是「对话轮数」，也不含工具与系统事件。
  final int messages;

  final DateTime updatedAt;

  /// 会话绑定的工作目录。同名会话多起来时靠它分辨。
  final String cwd;
}

/// 读 `$HOME/.ondra/dsh/sessions/**/session.v4.jsonl`，按最后活动时间倒序。
///
/// 没有会话目录就返回空列表——那说明内核还没在这个 profile 下聊过。
Future<List<SessionSummary>> readSessions() => impl.readSessions();

/// 一条历史消息：只保留能显示的正文，工具与系统事件不进这里。
class HistoryEntry {
  const HistoryEntry({required this.role, required this.text});

  /// `user` 或 `assistant`；别的角色在读的时候就跳过了。
  final String role;
  final String text;
}

/// 读一份会话的完整对话。找不到或读不动返回空列表——
/// 列表页说「N 句」，点进去却是空的，那比报错更骗人。
Future<List<HistoryEntry>> readSessionMessages(String sessionId) =>
    impl.readSessionMessages(sessionId);
