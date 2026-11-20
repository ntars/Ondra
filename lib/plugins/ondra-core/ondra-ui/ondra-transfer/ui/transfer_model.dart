/// 导入导出的数据形状。
///
/// 这里只放**结构**，不放实现：桌面端由 `transfer_engine_io.dart` 真读写真写，
/// 浏览器预览里由 `transfer_engine_stub.dart` 如实说明做不到。改的落点始终是
/// 同一个：`~/.ondra/user/ondra.db`（记忆）与 `~/.ondra/` 下的文本文件（人设、偏好）。
library;

import '../../ondra-backup/ui/backup_model.dart' show backupBytes;

export '../../ondra-backup/ui/backup_model.dart' show backupBytes;

/// 一次导出的格式。名字只用来决定扩展名与写法，不是另一套数据模型。
enum TransferFormat {
  /// 给人读的 Markdown：一条记忆一段，带时间与类别。
  markdown,

  /// 给程序读的 JSON：保留 id、显著度、证据链，可以再导回来。
  json,

  /// 人设包与偏好，一个人一个目录。
  bundle,

  /// 整包：复用备份引擎的自包含导出，含对话存档与配置。
  archive;

  String get extension => switch (this) {
    TransferFormat.markdown => 'md',
    TransferFormat.json => 'json',
    TransferFormat.bundle => '',
    TransferFormat.archive => '',
  };

  String get label => switch (this) {
    TransferFormat.markdown => 'Markdown',
    TransferFormat.json => 'JSON',
    TransferFormat.bundle => '.ondra',
    TransferFormat.archive => '目录',
  };
}

/// 本机现在**有什么**。页面顶部那排数字就是它，全部来自真实读取。
///
/// 每一项都可能是 0，而且 0 是有意义的信息：读者据此知道「导出来会是一份空文件」，
/// 而不是点下去才发现在导空气。
class TransferSnapshot {
  const TransferSnapshot({
    required this.facts,
    required this.raws,
    required this.links,
    required this.sessions,
    required this.personaPacks,
    required this.archivedFacts,
    required this.dbBytes,
    required this.logBytes,
    required this.snapshotCount,
    required this.snapshotBytes,
    this.lastFactAt,
    this.note = '',
  });

  /// 已沉成事实的记忆条数——这是「导出的记忆」实际会有的条数。
  final int facts;

  /// 原文条数。事实是从原文里提炼出来的，原文更多说明沉淀率还有空间。
  final int raws;

  /// 记忆之间的关联条数。为 0 时星图只有点没有线。
  final int links;

  /// 会话文件数。
  final int sessions;

  /// 可携带的人设包数量（`~/.ondra/personas/` 下的目录）。
  final int personaPacks;

  /// 已归档的事实条数。归档的也导出——它们仍是用户的东西，只是不在星图上画。
  final int archivedFacts;

  final int dbBytes;
  final int logBytes;
  final int snapshotCount;
  final int snapshotBytes;
  final DateTime? lastFactAt;

  /// 非空表示「这次为什么读不到」，界面据此区分空态原因。
  final String note;

  int get dataBytes => dbBytes + logBytes;

  static const empty = TransferSnapshot(
    facts: 0,
    raws: 0,
    links: 0,
    sessions: 0,
    personaPacks: 0,
    archivedFacts: 0,
    dbBytes: 0,
    logBytes: 0,
    snapshotCount: 0,
    snapshotBytes: 0,
  );

  String get factsText => '$facts 条';
  String get rawsText => '$raws 条原文';
  String get linksText => '$links 条关联';
  String get dbText => backupBytes(dbBytes);
  String get dataText => backupBytes(dataBytes);
}

/// 一次动作的结果。
///
/// [path] 是产出位置或读取来源，界面把它显示出来——用户点完「导出」最想知道的是
/// 「东西在哪」，而不是一句「成功了」。
class TransferResult {
  const TransferResult({
    required this.ok,
    required this.message,
    this.path,
    this.count = 0,
    this.skipped = 0,
  });

  final bool ok;
  final String message;
  final String? path;

  /// 实际写入 / 读入的条数。
  final int count;

  /// 因为重复而跳过的条数。导入时这个数字必须显示：
  /// 用户重复导入同一份文件，看到「10 条全部跳过」才知道去重真的在工作。
  final int skipped;

  const TransferResult.fail(this.message, {this.path})
    : ok = false,
      count = 0,
      skipped = 0;
}

/// 一条要导出的记忆。字段取的是 `memory_fact` 里真实存在的列，不是重新设计的模型。
class TransferFact {
  const TransferFact({
    required this.id,
    required this.category,
    required this.text,
    required this.salience,
    required this.createdAt,
    this.evidence = '',
    this.subject = '',
    this.archived = false,
    this.sealed = false,
  });

  final String id;
  final String category;
  final String text;
  final double salience;
  final DateTime createdAt;
  final String evidence;
  final String subject;
  final bool archived;

  /// 封存：用户手动下架，与「归档」（沉底）是两回事。导出导入必须保真。
  final bool sealed;
}

/// 一条要导出的关联。
class TransferLink {
  const TransferLink({
    required this.from,
    required this.to,
    required this.weight,
    this.id = '',
    this.relation = 'related',
    this.hits = 0,
    this.lastFiredAt = 0,
    this.decayedAt = 0,
    this.createdAt = 0,
    this.approved = 1,
    this.surreal = 0,
  });

  final String from;
  final String to;
  final double weight;
  final String id;
  final String relation;
  final int hits;
  final int lastFiredAt;
  final int decayedAt;
  final int createdAt;
  final int approved;
  final int surreal;

  Map<String, Object> toJson() => {
    'id': id,
    'from': from,
    'to': to,
    'weight': weight,
    'relation': relation,
    'hits': hits,
    'lastFiredAt': lastFiredAt,
    'decayedAt': decayedAt,
    'createdAt': createdAt,
    'approved': approved,
    'surreal': surreal,
  };
}
