/// 一条事实的原始投影。
///
/// 字段名与 `memory_fact` 表一一对应，只取画图和详情条要用的那些——
/// 界面不替库改数据结构（`strength` 那种派生值在布局层算）。
class MemoryRecord {
  const MemoryRecord({
    required this.id,
    required this.category,
    required this.text,
    required this.salience,
    required this.createdAt,
    this.lastHitAt,
  });

  final String id;

  /// `person` / `preference` / `event` / `self` / `misc`。
  final String category;

  /// 事实原文，以句号结尾，例如「小林喜欢克制的设计。」。
  final String text;

  /// 0–100，内核算出来的显著度。
  final double salience;

  final DateTime? createdAt;
  final DateTime? lastHitAt;
}

/// 一条关联：从哪条事实到哪条，权重 0–1。
class MemoryLinkRecord {
  const MemoryLinkRecord({
    required this.from,
    required this.to,
    required this.weight,
  });

  final String from;
  final String to;
  final double weight;
}

/// 一次读取的结果。
///
/// [note] 非空表示「这次为什么没有数据」——库不存在、sqlite3 不在、
/// 查询报错都写这里。界面用它区分「还没有记忆」与「读不到记忆」，
/// 这两种空态给用户的信息完全不同。
class MemorySnapshot {
  const MemorySnapshot({required this.facts, required this.links, this.note});

  final List<MemoryRecord> facts;
  final List<MemoryLinkRecord> links;
  final String? note;

  bool get isEmpty => facts.isEmpty;
}
