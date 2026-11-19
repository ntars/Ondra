/// 状态面板的数据形状。
///
/// 每一项都是本机某个文件或某张表的直接读数：没有一项是估的，也没有一项是
/// 「演示数据」。读不到就写清楚为什么读不到——状态面板最不该做的事，
/// 是拿一条好看的曲线掩盖「其实什么都没接上」。
library;

/// 一条监测源：它叫什么、从哪读、现在读到了多少、最后一次更新是什么时候。
class StatusSource {
  const StatusSource({
    required this.label,
    required this.detail,
    required this.count,
    this.unit = '条',
    this.lastAt,
    this.online = false,
  });

  final String label;
  final String detail;

  /// 读到的条数。0 是真读数，不是「没拿到」。
  final int count;

  /// «条» 或 «B»。日志源的 count 是字节数，写成「条」就是谎报。
  final String unit;
  final DateTime? lastAt;

  /// 这份数据源现在是不是活的（近期还有写入）。
  final bool online;
}

/// 一条「生命体征」：名字、说明、数值、轨道占比（0–1）。
///
/// [value] 为空表示这条通道还没有读数；轨道照画，但只有底槽。
class MetricReading {
  const MetricReading({
    required this.label,
    required this.hint,
    this.value,
    this.ratio = 0,
  });

  final String label;
  final String hint;
  final String? value;
  final double ratio;
}

/// 当前情绪。为 null 表示情绪还没有第一次落定。
///
/// 这不是「没接上数据源」——情绪是靠对话真的被触动才会产生的，
/// 没有对话就没有情绪，这两件事在界面上必须分开说。
class EmotionReading {
  const EmotionReading({
    required this.label,
    required this.valence,
    required this.arousal,
    required this.at,
  });

  /// 内核给的中文标签，可能为空。
  final String label;

  /// 愉悦度，-1 到 1。
  final double valence;

  /// 唤醒度，0 到 1。
  final double arousal;
  final DateTime at;
}

/// 一次启动里被降级的一项。
///
/// 内核有三十多个插件，每个都可以「取不到依赖就转不可用」——这是刻意的设计
/// （宁可降级也不 PENDING），代价是失败**只写日志**，界面上一点痕迹都没有。
/// 把最近一次启动的降级项摆到状态面板上，这些「静默失灵」才会被看见。
class BootIssue {
  const BootIssue({
    required this.level,
    required this.scope,
    required this.message,
  });

  /// `ERROR` 或 `WARN`。
  final String level;

  /// 插件名，例如 `ondra.memory-pool`。
  final String scope;
  final String message;

  bool get isError => level == 'ERROR';
}

/// 一次状态总览。
class StatusSnapshot {
  const StatusSnapshot({
    required this.facts,
    required this.raws,
    required this.links,
    required this.archived,
    required this.rawsLastDay,
    required this.sessions,
    required this.plugins,
    required this.dbBytes,
    required this.backupCount,
    required this.backupBytes,
    required this.sources,
    required this.metrics,
    this.emotion,
    this.kernelOnline = false,
    this.kernelDetail = '',
    this.bootIssues = const [],
    this.bootWarnings = 0,
    this.bootErrors = 0,
    this.note = '',
  });

  final int facts;
  final int raws;
  final int links;
  final int archived;

  /// 近 24 小时的原文条数。这是「今天有没有真的在用它」唯一的硬指标。
  final int rawsLastDay;

  final int sessions;
  final int plugins;
  final int dbBytes;
  final int backupCount;
  final int backupBytes;

  final List<StatusSource> sources;
  final List<MetricReading> metrics;
  final EmotionReading? emotion;

  /// 对话客户端最近一次连接或请求的结果。
  final bool kernelOnline;
  final String kernelDetail;

  /// 最近一次启动里「被降级」的项，错误在前。
  final List<BootIssue> bootIssues;
  final int bootWarnings;
  final int bootErrors;

  final String note;

  /// 本次启动有没有降级。0 / 0 时装配是干净的。
  bool get bootClean => bootIssues.isEmpty;

  static const empty = StatusSnapshot(
    facts: 0,
    raws: 0,
    links: 0,
    archived: 0,
    rawsLastDay: 0,
    sessions: 0,
    plugins: 0,
    dbBytes: 0,
    backupCount: 0,
    backupBytes: 0,
    sources: [],
    metrics: [],
  );

  /// 沉淀率：原文有多少沉成了事实。分母为 0 时不显示比率。
  String get sinkRate {
    if (raws == 0) return '—';
    final ratio = (facts / raws * 100).clamp(0, 100);
    return '${ratio.round()}%';
  }

  int get totalBytes => dbBytes + backupBytes;
}
