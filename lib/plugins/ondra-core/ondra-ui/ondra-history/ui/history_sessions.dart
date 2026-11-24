import 'history_sessions_stub.dart'
    if (dart.library.io) 'history_sessions_io.dart'
    as impl;

/// 一条会话摘要：会话文件里能**如实读出**的那几样。
///
/// 列表只保留「哪一轮、什么时候、说了几句」，不缓存完整对话正文。
class SessionSummary {
  const SessionSummary({
    required this.id,
    required this.title,
    required this.messages,
    required this.updatedAt,
    required this.cwd,
    this.sourcePath = '',
  });

  final String id;

  /// 第一句用户消息的开头；一条用户消息都没有时给「空白会话」。
  final String title;

  /// 用户消息条数——不是「对话轮数」，也不含工具与系统事件。
  final int messages;

  final DateTime updatedAt;

  /// 会话绑定的工作目录。同名会话多起来时靠它分辨。
  final String cwd;

  /// 会话文件在磁盘上的路径。详情必须按同一份文件读，不能只按 id 全库猜。
  final String sourcePath;
}

/// 读 DSH_HOME 下的 `sessions/**/session.v4.jsonl`，按最后活动时间倒序。
///
/// [dshHome] 用于隔离测试；默认遵循 ONDRA_DSH_HOME，否则用 ~/.ondra/dsh。
/// 没有会话目录就返回空列表——那说明内核还没在这个 profile 下聊过。
Future<List<SessionSummary>> readSessions({String? dshHome}) =>
    impl.readSessions(dshHome: dshHome);

/// 会话详情使用与列表相同的 DSH_HOME 目录。
///
/// 列表页的 [SessionSummary] 只带 id；详情若另走默认目录，在
/// `ONDRA_DSH_HOME` 自定义（命令行调试、迁移验证）时会找不到刚列出的会话，
/// 点开就是空白。两处统一走同一函数，不给调用方留下第二个口径。
String sessionsHome({String? dshHome}) => impl.sessionsHome(dshHome: dshHome);

/// 一条历史消息：只保留能显示的正文，工具与系统事件不进这里。
class HistoryEntry {
  const HistoryEntry({
    required this.role,
    required this.text,
    this.hasImage = false,
  });

  /// `user` 或 `assistant`；别的角色在读的时候就跳过了。
  final String role;
  final String text;

  /// 这条消息带图片块。纯图片消息没有正文，但仍是用户真正发过的一句话，
  /// 历史列表与详情都不能把它当成空消息丢掉。
  final bool hasImage;

  /// 详情里实际显示的文字：纯图片消息给一个可辨认的占位。
  String get displayText => text.trim().isEmpty && hasImage ? '[图片]' : text;
}

/// 读一份会话的完整对话。找不到或读不动返回空列表——
/// 列表页说「N 句」，点进去却是空的，那比报错更骗人。
Future<List<HistoryEntry>> readSessionMessages(
  String sessionId, {
  String? dshHome,
  String? sourcePath,
}) => impl.readSessionMessages(
      sessionId,
      dshHome: dshHome,
      sourcePath: sourcePath,
    );
