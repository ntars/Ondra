import 'package:material_ui/material_ui.dart';

/// 三类日志的**类型定义**（不含任何条目）。
///
/// 条目由各自的写入者产生：对话日志来自 chat 内核的事件流，插件日志来自
/// 调用记录，系统日志来自宿主。页面只画日志插件投影出来的条目，
/// 所以这里只有形状，没有内容。
///
/// 三类分开是因为它们的写入者、结构与保留策略都不一样：
/// 对话日志记的是模型思考链路，插件日志记的是外部调用的进出，系统日志记的是
/// 宿主自身的运行状态。
enum LogKind { dialog, plugin, system }

extension LogKindSpec on LogKind {
  String get title => switch (this) {
    LogKind.dialog => '对话日志',
    LogKind.plugin => '插件日志',
    LogKind.system => '系统日志',
  };

  String get subtitle => switch (this) {
    LogKind.dialog => '模型思考过程与工具调用链路',
    LogKind.plugin => '插件请求、返回与超时',
    LogKind.system => '宿主运行状态与本地存储',
  };

  String get emptyHint => switch (this) {
    LogKind.dialog => '还没有对话，日志会随对话写入',
    LogKind.plugin => '没有插件调用记录',
    LogKind.system => '系统运行正常，没有新事件',
  };
}

enum LogLevel { info, warn, error }

extension LogLevelSpec on LogLevel {
  String get label => switch (this) {
    LogLevel.info => '信息',
    LogLevel.warn => '警告',
    LogLevel.error => '错误',
  };

  Color get color => switch (this) {
    // 级别只分深浅，不分色相：信息淡、警告中、错误实心。
    LogLevel.info => const Color(0xFFA6ABB1),
    LogLevel.warn => const Color(0xFF6E7379),
    LogLevel.error => const Color(0xFF1C1F28),
  };
}

class LogEntry {
  const LogEntry({
    required this.time,
    required this.title,
    this.detail = '',
    this.level = LogLevel.info,
    this.tag,
  });

  final String time;
  final String title;
  final String detail;
  final LogLevel level;

  /// 可选的作用域标签：对话日志里是「思考 / 工具 / 回复」，插件日志里是插件名。
  final String? tag;
}
