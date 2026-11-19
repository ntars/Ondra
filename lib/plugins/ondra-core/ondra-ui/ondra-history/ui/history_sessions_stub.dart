import 'history_sessions.dart';

/// Web / 测试环境没有 `dart:io`，读不到本机会话库。
///
/// 返回空列表而不是示例数据：历史对话只有一份真货，在磁盘上。
Future<List<SessionSummary>> readSessions({String? dshHome}) async => const [];

Future<List<HistoryEntry>> readSessionMessages(
  String sessionId, {
  String? dshHome,
}) async => const [];
