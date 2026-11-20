import 'dart:convert';
import 'dart:io';

import '../../../../../app/sqlite_cli.dart';
import 'memory_types.dart';
import '../../../../../app/home_dir.dart';

/// 本机的 `sqlite3` 命令行。解析交给 `app/sqlite_cli.dart`：
/// 从前这里写死 `/usr/bin/sqlite3`，在 Windows 上那是个不存在的路径，
/// 结果整页星图永远空着而且不报错。
String get _sqlite {
  final path = ondraSqliteCli;
  if (path == null) {
    // 抛成 ProcessException 而不是别的类型：下面 `_query` 的调用点已经
    // 按这个类型降级成一条 `note`，不需要再发明一套错误通道。
    throw ProcessException('sqlite3', [], ondraSqliteMissingHint);
  }
  return path;
}

/// 读一次记忆库。
///
/// **为什么用 `sqlite3` 命令行而不是加一个 Dart 的 SQLite 包**：
/// 桌面端已经有一个完整的内核在写这个库，界面只需要读；
/// 引入 `sqlite3` 原生插件要为三个平台各编一份二进制，而这里一次查询
/// 走一个进程几十毫秒就够。等界面需要写库时再换。
Future<MemorySnapshot> loadMemorySnapshot() async {
  final home = ondraUserHome;
  final db = File('$home/.ondra/user/ondra.db');
  if (!db.existsSync()) {
    // 安卓的内核起不来（系统不允许启动 node 子进程），「等内核建库」
    // 会变成永远等不到的承诺——文案必须如实。
    const desktopNote = '还没有记忆库（内核第一次收到对话后才会建）';
    const androidNote = '安卓版还没有内核运行时：记忆库要等远程网关接入后才有。';
    return MemorySnapshot(
      facts: const [],
      links: const [],
      note: Platform.isAndroid ? androidNote : desktopNote,
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
  final result = await Process.run(
      _sqlite,
      ['-readonly', '-json', dbPath, sql],
      // sqlite3 的 JSON 输出是 UTF-8；Windows 上不指定就是系统编码
      //（代码页 936），中文记忆直接乱码（alpha.2 审查第 20 项）。
      stdoutEncoding: utf8,
      stderrEncoding: utf8,
    );
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
