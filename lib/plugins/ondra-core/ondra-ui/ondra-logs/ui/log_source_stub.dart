import 'log_types.dart';

/// 浏览器里没有文件系统，读不到 `~/.ondra/logs`。
///
/// 返回空表即可：日志页的空态本来就写着「没有匹配的日志」，
/// 在预览环境里看到空列表是正确结果，不是故障。
Future<List<LogEntry>> loadLogEntries(
  LogKind kind, {
  int maxLines = 200,
}) async => const [];
