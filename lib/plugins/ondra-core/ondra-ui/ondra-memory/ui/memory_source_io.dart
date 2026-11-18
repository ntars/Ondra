import 'dart:convert';
import 'dart:io';

import 'memory_types.dart';

/// macOS 自带的命令行前端。用绝对路径：应用从 Finder 启动时 PATH 很短，
/// 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，靠 `sqlite3` 这个名字碰运气不稳。
const String _sqlite = '/usr/bin/sqlite3';

/// 读一次记忆库。
///
/// **为什么用 `sqlite3` 命令行而不是加一个 Dart 的 SQLite 包**：
/// 桌面端已经有一个完整的内核在写这个库，界面只需要读；
/// 引入 `sqlite3` 原生插件要为三个平台各编一份二进制，而这里一次查询
/// 走一个进程几十毫秒就够。等界面需要写库时再换。
Future<MemorySnapshot> loadMemorySnapshot() async {
  final home = Platform.environment['HOME'] ?? '';
  final db = File('$home/.ondra/user/ondra.db');
  if (!db.existsSync()) {
    return const MemorySnapshot(
      facts: [],
      links: [],
      note: '还没有记忆库（内核第一次收到对话后才会建）',
    );
  }

  try {
    // 封存与归档不画：星图是「此刻还在用的记忆」，墓碑不该出现在这里。
    final factRows = await _query(
      db.path,
      'select id, category, text, salience, created_at, last_hit_at '
      'from memory_fact '
      'where archived = 0 and sealed = 0 and text is not null and text <> \'\' '
      'order by salience desc, created_at desc limit 64',
    );
    final linkRows = await _query(
      db.path,
      'select from_id, to_id, weight from memory_link '
      'where coalesce(approved, 1) = 1 limit 256',
    );

    final ids = <String>{};
    final facts = <MemoryRecord>[];
    for (final row in factRows) {
      final id = _text(row['id']);
      if (id.isEmpty || !ids.add(id)) continue;
      facts.add(
        MemoryRecord(
          id: id,
          category: _text(row['category']),
          text: _text(row['text']).trim(),
          // 显著度缺失时按 50 算：把它当天外来客会让节点全缩成一个点。
          salience: _number(row['salience'], 50).clamp(0, 100).toDouble(),
          createdAt: _time(row['created_at']),
          lastHitAt: _time(row['last_hit_at']),
        ),
      );
    }

    final links = <MemoryLinkRecord>[];
    for (final row in linkRows) {
      final from = _text(row['from_id']);
      final to = _text(row['to_id']);
      // 端点不在本次取到的事实里就丢掉：画一条指向空处的线是假的。
      if (!ids.contains(from) || !ids.contains(to) || from == to) continue;
      links.add(
        MemoryLinkRecord(from: from, to: to, weight: _number(row['weight'], 0.5)),
      );
    }

    return MemorySnapshot(facts: facts, links: links);
  } on ProcessException catch (e) {
    return MemorySnapshot(
      facts: const [],
      links: const [],
      note: '读不到记忆库：$e'.replaceFirst('ProcessException: ', ''),
    );
  }
}

/// 跑一条查询，把 `-json` 输出解析成行列表。
Future<List<Map<String, dynamic>>> _query(String dbPath, String sql) async {
  final result = await Process.run(_sqlite, ['-readonly', '-json', dbPath, sql]);
  if (result.exitCode != 0) {
    throw ProcessException(
      _sqlite,
      const [],
      '${result.stderr}'.trim().isEmpty ? 'exit ${result.exitCode}' : '${result.stderr}'.trim(),
      result.exitCode,
    );
  }
  final text = '${result.stdout}'.trim();
  // 零行时 sqlite3 输出空串，不是 `[]`。
  if (text.isEmpty) return const [];
  final decoded = jsonDecode(text);
  if (decoded is! List) return const [];
  return [for (final row in decoded) if (row is Map) row.cast<String, dynamic>()];
}

String _text(Object? value) => value is String ? value : (value?.toString() ?? '');

double _number(Object? value, double fallback) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value) ?? fallback;
  return fallback;
}

/// `created_at` 存的是毫秒时间戳（内核算完再写），也见过 ISO 串。
DateTime? _time(Object? value) {
  if (value is num) {
    final ms = value.toInt();
    return DateTime.fromMillisecondsSinceEpoch(ms);
  }
  if (value is String) {
    final parsedInt = int.tryParse(value);
    if (parsedInt != null) {
      return DateTime.fromMillisecondsSinceEpoch(parsedInt);
    }
    return DateTime.tryParse(value);
  }
  return null;
}
