import 'dart:convert';
import 'dart:io';

import '../../../../../app/sqlite_cli.dart';
import '../../ondra-backup/ui/backup_actions.dart' show backupOverviewLoader;
import '../../ondra-chat/ui/chat_client.dart' show chatClient;
import 'status_types.dart';
import '../../../../../app/home_dir.dart';

/// 本机的 `sqlite3` 命令行。解析交给 `app/sqlite_cli.dart`：
/// 从前这里写死 `/usr/bin/sqlite3`，Windows 上那个路径不存在，
/// 于是整个面板的读数会安静地全变成 0。
String get _sqlite {
  final path = ondraSqliteCli;
  if (path == null) {
    throw const ProcessException('sqlite3', [], ondraSqliteMissingHint);
  }
  return path;
}

/// 读一次状态面板的全部读数。
///
/// 每一条都对应一个具体文件或一张表：`~/.ondra/user/ondra.db` 的几张表、
/// `~/.ondra/dsh/sessions/` 的会话文件、`~/.ondra/logs/` 的三份日志、
/// `~/.ondra/backups/` 的快照，以及对话客户端的接入状态。
///
/// 任何一项读失败都只影响它自己：状态面板的职责是把**知道的部分**如实呈现，
/// 不是「一条读不到就整页报错」。
Future<StatusSnapshot> loadStatus({
  DateTime Function()? now,
  String? home,
}) async {
  final clock = now ?? DateTime.now;
  final resolveHome = home ?? ondraUserHome;
  final root = '$resolveHome/.ondra';
  final db = File('$root/user/ondra.db');

  final backups = await _backupStats();
  final boot = await _bootDigest(root);
  final dshHome = home == null
      ? (Platform.environment['ONDRA_DSH_HOME'] ?? '$root/dsh')
      : '$root/dsh';
  final sessions = _sessionCount('$dshHome/sessions');
  final plugins = _pluginCount('$dshHome/profiles/ondra/cordis.patch.yml');
  final kernelOnline = chatClient.connected;
  final kernelDetail =
      chatClient.offlineReason ?? (kernelOnline ? '对话内核已连接' : '对话内核未连接');

  if (!db.existsSync()) {
    return StatusSnapshot(
      facts: 0,
      raws: 0,
      links: 0,
      archived: 0,
      rawsLastDay: 0,
      sessions: sessions,
      plugins: plugins,
      dbBytes: 0,
      backupCount: backups.$1,
      backupBytes: backups.$2,
      sources: _sources(root, raws: 0, rawAt: null, now: clock()),
      metrics: const [],
      bootIssues: boot.$3,
      bootWarnings: boot.$1,
      bootErrors: boot.$2,
      kernelOnline: kernelOnline,
      kernelDetail: kernelDetail,
      note: '还没有记忆库。跟空谷说过话之后，这里会开始有读数。',
    );
  }

  final facts = await _safeCount(db.path, 'select count(*) from memory_fact');
  final raws = await _safeCount(db.path, 'select count(*) from memory_raw');
  final links = await _safeCount(db.path, 'select count(*) from memory_link');
  final archived = await _safeCount(
    db.path,
    'select count(*) from memory_fact where archived = 1',
  );
  final since = clock()
      .subtract(const Duration(hours: 24))
      .millisecondsSinceEpoch;
  final rawsLastDay = await _safeCount(
    db.path,
    'select count(*) from memory_raw where created_at >= $since',
  );
  final rawAt = await _lastTime(db.path, 'memory_raw');

  final emotion = await _readEmotion(db.path);

  final sinkRatio = raws <= 0 ? 0.0 : (facts / raws).clamp(0.0, 1.0);
  // 缺 sqlite3 时上面每一条都降级成了 0。0 看上去和「真的没有记忆」一样，
  // 所以这里必须换一句话说清楚——否则用户会以为库是空的。
  final sqliteMissing = ondraSqliteCli == null;

  return StatusSnapshot(
    facts: facts,
    raws: raws,
    links: links,
    archived: archived,
    rawsLastDay: rawsLastDay,
    note: sqliteMissing ? ondraSqliteMissingHint : '',
    sessions: sessions,
    plugins: plugins,
    dbBytes: _fileSize(db.path) + _fileSize('${db.path}-wal'),
    backupCount: backups.$1,
    backupBytes: backups.$2,
    sources: _sources(root, raws: raws, rawAt: rawAt, now: clock()),
    metrics: [
      MetricReading(
        label: '记忆',
        hint: links == 0 ? '还没有关联，星图只有点' : '$links 条关联把它们连成网',
        value: '$facts 条',
        // 300 条是这个轨道画满的位置。超过就顶格——轨道是「大概多满」的示意，
        // 不该为了一个精确比例把轨道做成可滚动的。
        ratio: (facts / 300).clamp(0.0, 1.0),
      ),
      MetricReading(
        label: '活跃',
        hint: '近 24 小时的原文',
        value: '$rawsLastDay 条',
        ratio: (rawsLastDay / 40).clamp(0.0, 1.0),
      ),
      MetricReading(
        label: '沉淀',
        hint: '原文有多少变成了事实',
        value: raws == 0 ? '—' : '${(sinkRatio * 100).round()}%',
        ratio: sinkRatio,
      ),
    ],
    emotion: emotion,
    kernelOnline: kernelOnline,
    kernelDetail: kernelDetail,
    bootIssues: boot.$3,
    bootWarnings: boot.$1,
    bootErrors: boot.$2,
  );
}

/// 日志行的形状：`2026-11-17 21:16:25 WARN [ondra.memory-pool] 没有可用存储端口…`
final RegExp _logLine = RegExp(
  r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (WARN|ERROR|INFO)\s+\[([^\]]+)\] (.*)$',
);

/// 读最近一次启动的降级项。
///
/// 「最近一次启动」用一个时间窗口近似：启动时几十条日志挤在同一秒，之后是零星
/// 的运行时日志。所以从尾部往回取 5 分钟窗口，得到的正好是这一次启动的体检结果。
///
/// 不去解析「启动」标志行，是因为日志格式没有稳定的启动标记；而窗口法在
/// 「昨天启动过、今天没启动」时也只会读到空——那时显示「没有降级」是对的。
Future<(int, int, List<BootIssue>)> _bootDigest(String root) async {
  final file = File('$root/logs/ondra-code.log');
  if (!file.existsSync()) return (0, 0, const <BootIssue>[]);

  final lines = await _tailLines(file, 64 * 1024);
  final parsed = <(DateTime, String, String, String)>[];
  for (final line in lines) {
    final m = _logLine.firstMatch(line);
    if (m == null) continue;
    final at = DateTime.tryParse(m.group(1)!);
    if (at == null) continue;
    parsed.add((at, m.group(2)!, m.group(3)!, m.group(4)!.trim()));
  }
  if (parsed.isEmpty) return (0, 0, const <BootIssue>[]);

  // 用窗口里的最大时间而不是最后一行：日志按时间递增是常态，但「最后一次
  // 启动」之后如果还有别的写入方乱序补了一行，以末行为锚就会把整次启动滤掉。
  final last = parsed.fold<DateTime>(
    parsed.first.$1,
    (acc, e) => e.$1.isAfter(acc) ? e.$1 : acc,
  );
  final window = [
    for (final e in parsed)
      if (last.difference(e.$1).inMinutes.abs() <= 5) e,
  ];

  var warns = 0;
  var errors = 0;
  final issues = <BootIssue>[];
  final seen = <String>{};
  for (final e in window) {
    if (e.$2 == 'WARN') warns++;
    if (e.$2 == 'ERROR') errors++;
    if (e.$2 == 'INFO') continue;
    // 同一个插件反复报同一件事只留一条：状态面板要回答「哪里坏了」，
    // 不是「报了多少次」——次数在这里没有决策价值。
    final key = '${e.$3}|${e.$4.substring(0, e.$4.length.clamp(0, 24))}';
    if (!seen.add(key)) continue;
    issues.add(BootIssue(level: e.$2, scope: e.$3, message: e.$4));
  }

  // 错误在前：一次启动里两条 ERROR 比二十条 WARN 更需要先看。
  issues.sort((a, b) => a.isError == b.isError ? 0 : (a.isError ? -1 : 1));
  return (warns, errors, issues.take(6).toList(growable: false));
}

/// 从文件尾读至多 [maxBytes] 字节并按行切。
///
/// 与日志页同一做法：`readAsLines` 会把整个文件读进内存，`ondra-code.log`
/// 攒到几十兆时就是一次卡顿。
Future<List<String>> _tailLines(File file, int maxBytes) async {
  final length = await file.length();
  if (length == 0) return const [];
  final start = length > maxBytes ? length - maxBytes : 0;
  final raf = await file.open();
  try {
    await raf.setPosition(start);
    final bytes = await raf.read(length - start);
    // 必须按 UTF-8 解码，否则中文会变成「éç½®」。
    final text = utf8.decode(bytes, allowMalformed: true);
    final lines = const LineSplitter().convert(text);
    // 从中间切进来时第一行是半截，丢掉。
    return start > 0 && lines.isNotEmpty ? lines.sublist(1) : lines;
  } finally {
    await raf.close();
  }
}

/// 三份日志各算一条监测源。空谷把所有对话、插件、宿主的事件都写在
/// `~/.ondra/logs/` 下，一个来源一个文件——这正是「监测源」三行的真身。
List<StatusSource> _sources(
  String root, {
  required int raws,
  DateTime? rawAt,
  required DateTime now,
}) {
  StatusSource fromLog(String label, String detail, String name) {
    final f = File('$root/logs/$name');
    if (!f.existsSync()) {
      return StatusSource(label: label, detail: detail, count: 0);
    }
    final at = f.lastModifiedSync();
    return StatusSource(
      label: label,
      detail: detail,
      count: f.lengthSync(),
      unit: 'B',
      lastAt: at,
      online: now.difference(at).inHours < 24,
    );
  }

  return [
    StatusSource(
      label: '对话流',
      detail: '你说过的话与她的回答',
      count: raws,
      lastAt: rawAt,
      online: rawAt != null && now.difference(rawAt).inHours < 24,
    ),
    fromLog('插件事件', '插件调用与返回', 'ondra-code.log'),
    fromLog('系统事件', '宿主与运行状态', 'window.log'),
  ];
}

/// 读当前情绪。表存在但零行、或字段对不上时返回 null：
/// 「还没有情绪」与「情绪坏了」在这页上都该显示成空态，而不是编一个值。
Future<EmotionReading?> _readEmotion(String dbPath) async {
  try {
    final rows = await _query(
      dbPath,
      'select axes, labels, updated_at from emotion_state '
      'order by updated_at desc limit 1',
    );
    if (rows.isEmpty) return null;
    final row = rows.first;

    final axes = _decodeMap(row['axes']);
    // 轴名以 valence / arousal 为主；也接受缩写，内核换过一版序列化。
    final valence = _number(
      axes['valence'] ?? axes['v'] ?? axes['pleasure'],
      0,
    );
    final arousal = _number(
      axes['arousal'] ?? axes['a'] ?? axes['energy'],
      0.5,
    );

    var label = '';
    final labels = row['labels'];
    if (labels is String && labels.isNotEmpty) {
      try {
        final decoded = jsonDecode(labels);
        if (decoded is Map) {
          label = decoded.values
              .map((e) => '$e')
              .firstWhere((e) => e.trim().isNotEmpty, orElse: () => '');
        } else if (decoded is List) {
          label = decoded
              .map((e) => '$e')
              .firstWhere((e) => e.trim().isNotEmpty, orElse: () => '');
        }
      } catch (_) {
        label = labels;
      }
    }

    final at = _time(row['updated_at']) ?? DateTime.now();
    return EmotionReading(
      label: label,
      valence: valence.clamp(-1.0, 1.0),
      arousal: arousal.clamp(0.0, 1.0),
      at: at,
    );
  } catch (_) {
    return null;
  }
}

Future<(int, int)> _backupStats() async {
  try {
    final overview = await backupOverviewLoader();
    return (overview.snapshots.length, overview.storedBytes);
  } catch (_) {
    return (0, 0);
  }
}

int _sessionCount(String root) {
  final dir = Directory(root);
  if (!dir.existsSync()) return 0;
  var n = 0;
  for (final project in dir.listSync().whereType<Directory>()) {
    for (final s in project.listSync().whereType<Directory>()) {
      if (File('${s.path}/session.v4.jsonl').existsSync()) n++;
    }
  }
  return n;
}

int _pluginCount(String patchPath) {
  final f = File(patchPath);
  if (!f.existsSync()) return 0;
  return f
      .readAsLinesSync()
      .where(
        (l) =>
            RegExp(r'^\s*-\s+id:').hasMatch(l) && !l.trimLeft().startsWith('#'),
      )
      .length;
}

int _fileSize(String path) {
  final f = File(path);
  return f.existsSync() ? f.lengthSync() : 0;
}

/// 一张表读失败不该拖垮整页。返回 0 而不是抛出去：读不到与真的是 0，
/// 在界面上都显示成「没有」，区别写在 `note` 里。
Future<int> _safeCount(String dbPath, String sql) async {
  try {
    final rows = await _query(dbPath, sql);
    if (rows.isEmpty) return 0;
    return _int(rows.first.values.first);
  } catch (_) {
    return 0;
  }
}

Future<DateTime?> _lastTime(String dbPath, String table) async {
  try {
    final rows = await _query(
      dbPath,
      'select max(created_at) as at from $table',
    );
    if (rows.isEmpty) return null;
    return _time(rows.first['at']);
  } catch (_) {
    return null;
  }
}

Future<List<Map<String, dynamic>>> _query(String dbPath, String sql) async {
  var r = await Process.run(_sqlite, ['-readonly', '-json', dbPath, sql]);
  if (r.exitCode != 0) {
    // WAL 库在 `-wal` / `-shm` 缺失时 `-readonly` 会 CANTOPEN。
    // 退回 URI 只读还能读到主库，总比整页显示成 0 强。
    r = await Process.run(_sqlite, ['-json', 'file:$dbPath?mode=ro', sql]);
  }
  if (r.exitCode != 0) {
    throw ProcessException(_sqlite, const [], 'exit', r.exitCode);
  }
  final text = '${r.stdout}'.trim();
  if (text.isEmpty) return const [];
  final decoded = jsonDecode(text);
  if (decoded is! List) return const [];
  return [
    for (final row in decoded)
      if (row is Map) row.cast<String, dynamic>(),
  ];
}

Map<String, dynamic> _decodeMap(Object? raw) {
  if (raw is Map) return raw.cast<String, dynamic>();
  if (raw is String && raw.trim().isNotEmpty) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) return decoded.cast<String, dynamic>();
    } catch (_) {
      // 序列化格式变了就当空：情绪显示成空态，不编造数值。
    }
  }
  return const {};
}

int _int(Object? v) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? 0;
  return 0;
}

double _number(Object? v, double fallback) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v) ?? fallback;
  return fallback;
}

DateTime? _time(Object? v) {
  if (v is num) {
    if (v <= 0) return null;
    return DateTime.fromMillisecondsSinceEpoch(v.toInt());
  }
  if (v is String && v.isNotEmpty) {
    final n = int.tryParse(v);
    if (n != null && n > 0) return DateTime.fromMillisecondsSinceEpoch(n);
    return DateTime.tryParse(v);
  }
  return null;
}
