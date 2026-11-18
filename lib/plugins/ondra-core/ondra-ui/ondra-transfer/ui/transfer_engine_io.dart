import 'dart:convert';
import 'dart:io';

import '../../ondra-backup/ui/backup_actions.dart'
    show backupCreate, backupExport, backupImport, backupOverviewLoader;
import 'transfer_model.dart';

/// macOS 自带的命令行前端。用绝对路径：应用从 Finder 启动时 PATH 很短。
const String _sqlite = '/usr/bin/sqlite3';

/// 导出文件名的前缀。带时间戳是为了「同一天导两次」不会互相覆盖，
/// 用户不必先想「放哪、叫什么」。
const String _prefix = '空谷';

/// 导入导出的执行体。
///
/// 三件事全部落到真文件上：
/// - **导出记忆**：读 `~/.ondra/user/ondra.db` 的 `memory_fact` / `memory_link`，
///   写成 Markdown（给人读）或 JSON（给程序读，可再导回）；
/// - **导出人设与偏好**：`prefs.json` + `user/personas/` + 内核 profile 里的人设配置段；
/// - **整包**：不另起一套打包逻辑，直接复用备份引擎的自包含导出——
///   备份能带走的东西，正好就是「换台机器还是同一个空谷」需要的东西。
///
/// 导入是**会写库**的，因此有一条硬规矩：写之前先存一份备份。记忆是用户的东西，
/// 一次写坏就是永久损失，而这个动作的成本只有几百毫秒。
class TransferEngine {
  TransferEngine({String? home, DateTime Function()? now})
    : _home = home ?? Platform.environment['HOME'] ?? '',
      _now = now ?? DateTime.now;

  final String _home;
  final DateTime Function() _now;

  String get home => _home;
  String get dataRoot => '$_home/.ondra';
  String get dbPath => '$dataRoot/user/ondra.db';

  // ── 读取 ────────────────────────────────────────────────────────────────

  /// 读一次「本机有什么」。页面上每个数字都来自这里，没有一项是估的。
  Future<TransferSnapshot> load() async {
    final backups = await _backupStats();
    final db = File(dbPath);
    if (!db.existsSync()) {
      return TransferSnapshot(
        facts: 0,
        raws: 0,
        links: 0,
        sessions: _sessionCount(),
        personaPacks: _personaPacks().length,
        archivedFacts: 0,
        dbBytes: 0,
        logBytes: _logBytes(),
        snapshotCount: backups.$1,
        snapshotBytes: backups.$2,
        note: '还没有记忆库（内核第一次收到对话后才会建）；人设与偏好仍可导出。',
      );
    }

    try {
      final facts = await _count('select count(*) from memory_fact');
      final archived = await _count(
        'select count(*) from memory_fact where archived = 1',
      );
      final raws = await _count('select count(*) from memory_raw');
      final links = await _count('select count(*) from memory_link');
      final lastRows = await _query(
        'select max(created_at) as at from memory_fact',
      );
      final lastAt = lastRows.isEmpty
          ? null
          : _time(lastRows.first['at']);

      return TransferSnapshot(
        facts: facts,
        raws: raws,
        links: links,
        sessions: _sessionCount(),
        personaPacks: _personaPacks().length,
        archivedFacts: archived,
        dbBytes: _fileSize(dbPath) + _fileSize('$dbPath-wal'),
        logBytes: _logBytes(),
        snapshotCount: backups.$1,
        snapshotBytes: backups.$2,
        lastFactAt: lastAt,
      );
    } on ProcessException catch (e) {
      return TransferSnapshot(
        facts: 0,
        raws: 0,
        links: 0,
        sessions: _sessionCount(),
        personaPacks: _personaPacks().length,
        archivedFacts: 0,
        dbBytes: _fileSize(dbPath),
        logBytes: _logBytes(),
        snapshotCount: backups.$1,
        snapshotBytes: backups.$2,
        note: '读不到记忆库：${_clean(e)}',
      );
    }
  }

  // ── 导出 ────────────────────────────────────────────────────────────────

  /// 导出记忆。返回的文件名带时间戳，写完后回读一次确认不是空文件。
  Future<TransferResult> exportMemory(String dir, TransferFormat format) async {
    final out = Directory(dir);
    if (!out.existsSync()) {
      return const TransferResult.fail('目标目录不存在。');
    }
    try {
      final facts = await _readFacts();
      final links = await _readLinks();
      if (facts.isEmpty) {
        return const TransferResult.fail(
          '记忆库里还没有事实，导出会是一份空文件。先去聊几句再回来。',
        );
      }

      final stamp = _stamp();
      final name = '$_prefix记忆-$stamp.${format.extension}';
      final file = File('${out.path}/$name');
      final text = format == TransferFormat.markdown
          ? _markdownOf(facts, links)
          : _jsonOf(facts, links);

      await file.writeAsString(text, flush: true);

      // 回读一次。写成功但内容为空，是磁盘满或权限问题的典型表现，
      // 只看 writeAsString 有没有抛异常是发现不了的。
      final written = await file.length();
      if (written == 0) {
        return TransferResult.fail('写出来是个空文件，可能是磁盘空间不足。', path: file.path);
      }
      return TransferResult(
        ok: true,
        message:
            '导出 ${facts.length} 条记忆'
            '${links.isEmpty ? '' : '、${links.length} 条关联'}，'
            '${_humanSize(written)}。',
        path: file.path,
        count: facts.length,
      );
    } catch (e) {
      return TransferResult.fail('导出失败：${_clean(e)}');
    }
  }

  /// 导出人设与偏好。做成一个目录：`人设.json` + `偏好.json` + `personas/`。
  ///
  /// 为什么不是一个 `.ondra` 单文件：人设里有 Markdown 正文，打包成二进制之后
  /// 用户在 Finder 里看不见内容，也就没法判断「导出的到底是不是我要的那份」。
  Future<TransferResult> exportBundle(String dir) async {
    final out = Directory(dir);
    if (!out.existsSync()) {
      return const TransferResult.fail('目标目录不存在。');
    }
    try {
      final root = Directory('${out.path}/$_prefix人设-${_stamp()}');
      await root.create(recursive: true);

      var files = 0;

      final prefs = File('$dataRoot/prefs.json');
      if (prefs.existsSync()) {
        await prefs.copy('${root.path}/偏好.json');
        files++;
      }

      final personas = _personaPacks();
      for (final pack in personas) {
        final name = pack.uri.pathSegments.where((s) => s.isNotEmpty).last;
        await _copyTree(pack, Directory('${root.path}/personas/$name'));
        files++;
      }

      final personaConfig = _personaConfig();
      if (personaConfig.isNotEmpty) {
        await File(
          '${root.path}/人设配置.yml',
        ).writeAsString(personaConfig, flush: true);
        files++;
      }

      final avatar = File('$dataRoot/avatar.png');
      if (avatar.existsSync()) {
        await avatar.copy('${root.path}/头像.png');
        files++;
      }

      if (files == 0) {
        await root.delete(recursive: true);
        return const TransferResult.fail(
          '没有可携带的人设或偏好：人设还是内置的那份，偏好也没改过。',
        );
      }

      return TransferResult(
        ok: true,
        message: '导出人设与偏好，共 $files 项。',
        path: root.path,
        count: files,
      );
    } catch (e) {
      return TransferResult.fail('导出失败：${_clean(e)}');
    }
  }

  /// 整包导出：交给备份引擎，不另写一套打包逻辑。
  ///
  /// 一份备份都没有时先现场存一份——「导出全部数据」不能因为「你还没备份过」
  /// 就失败，这个动作的用户预期是「我现在就要一份」。
  Future<TransferResult> exportArchive(String dir) async {
    try {
      final overview = await backupOverviewLoader();
      var id = overview.snapshots.isEmpty ? null : overview.snapshots.first.id;
      if (id == null) {
        final created = await backupCreate();
        if (!created.ok) {
          return TransferResult.fail('先存一份快照失败：${created.message}');
        }
        final again = await backupOverviewLoader();
        if (again.snapshots.isEmpty) {
          return const TransferResult.fail('快照建好了但读不回来，请重试。');
        }
        id = again.snapshots.first.id;
      }
      final r = await backupExport(id, dir);
      return TransferResult(
        ok: r.ok,
        message: r.ok ? '整包已导出：${r.message}' : r.message,
        path: dir,
        count: r.ok ? 1 : 0,
      );
    } catch (e) {
      return TransferResult.fail('整包导出失败：${_clean(e)}');
    }
  }

  // ── 导入 ────────────────────────────────────────────────────────────────

  /// 按路径自动判断这份东西是什么，然后走对应的导入。
  ///
  /// 不要求用户先在下拉框里选「这是记忆还是人设」：文件名和内容本身说得清，
  /// 让用户选只是在把一个可以自动判断的事推回给他。
  Future<TransferResult> importPath(String path) async {
    final entity = FileSystemEntity.typeSync(path);
    if (entity == FileSystemEntityType.notFound) {
      return const TransferResult.fail('找不到这个路径。');
    }
    if (entity == FileSystemEntityType.directory) return _importDir(path);
    return _importFile(File(path));
  }

  Future<TransferResult> _importDir(String path) async {
    // 备份目录与「人设包目录」长得不一样：一个有 manifest，一个有偏好/人设文件。
    if (File('$path/ondra-snapshot.json').existsSync()) {
      final r = await backupImport(path);
      return TransferResult(
        ok: r.ok,
        message: r.ok ? '备份已导入：${r.message}' : r.message,
        path: path,
        count: r.ok ? 1 : 0,
      );
    }
    var restored = 0;
    final prefsSrc = File('$path/偏好.json');
    if (prefsSrc.existsSync()) {
      await prefsSrc.copy('$dataRoot/prefs.json');
      restored++;
    }
    final personasSrc = Directory('$path/personas');
    if (personasSrc.existsSync()) {
      for (final pack in personasSrc.listSync().whereType<Directory>()) {
        final name = pack.uri.pathSegments.where((s) => s.isNotEmpty).last;
        await _copyTree(pack, Directory('$dataRoot/user/personas/$name'));
        restored++;
      }
    }
    if (restored == 0) {
      return const TransferResult.fail(
        '这个目录里既没有备份清单，也没有偏好或人设，认不出来。',
      );
    }
    return TransferResult(
      ok: true,
      message: '导入了 $restored 项人设与偏好，重启后生效。',
      path: path,
      count: restored,
    );
  }

  Future<TransferResult> _importFile(File file) async {
    final lower = file.path.toLowerCase();
    final String text;
    try {
      text = await file.readAsString();
    } catch (e) {
      return TransferResult.fail('读不了这个文件：${_clean(e)}');
    }

    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      return _importFacts(_parseMarkdown(text), source: file.path);
    }
    if (lower.endsWith('.json')) {
      final Object? decoded;
      try {
        decoded = jsonDecode(text);
      } catch (e) {
        return TransferResult.fail('这不是合法的 JSON：${_clean(e)}');
      }
      final facts = _factsFromJson(decoded);
      if (facts.isNotEmpty) return _importFacts(facts, source: file.path);
      // 不是记忆就试偏好：顶层是对象且没有 facts 数组。
      if (decoded is Map && decoded.containsKey('themeMode')) {
        await file.copy('$dataRoot/prefs.json');
        return TransferResult(
          ok: true,
          message: '偏好已导入，重启后生效。',
          path: file.path,
          count: 1,
        );
      }
      return const TransferResult.fail(
        '这份 JSON 里没有记忆（找不到 facts 数组），也不像偏好文件。',
      );
    }
    return TransferResult.fail('不认识的格式：${file.path.split('/').last}');
  }

  /// 真正写库的地方。
  ///
  /// 两道去重：id 相同的由 `insert or ignore` 拦掉，文本相同的在这里先比一遍——
  /// 不同来源导出的同一句话 id 会不一样，只靠主键会让同一件事在记忆里长出两条。
  Future<TransferResult> _importFacts(
    List<TransferFact> facts, {
    required String source,
  }) async {
    if (facts.isEmpty) {
      return const TransferResult.fail('这份文件里没有可导入的记忆。');
    }
    final db = File(dbPath);
    if (!db.existsSync()) {
      return const TransferResult.fail(
        '还没有记忆库。先让空谷收到一次对话，它会自己建库，再来导入。',
      );
    }

    // 写库前先存底。失败不阻断——挡住导入比冒一次险更糟，但要在结果里说出来。
    final guard = await backupCreate();
    final guardNote = guard.ok ? '' : '（写前备份失败：${guard.message}）';

    try {
      final existing = await _query('select text from memory_fact');
      final seen = <String>{
        for (final row in existing) _text(row['text']).trim(),
      };

      final toWrite = <TransferFact>[];
      var skipped = 0;
      for (final f in facts) {
        if (seen.contains(f.text.trim())) {
          skipped++;
          continue;
        }
        seen.add(f.text.trim());
        toWrite.add(f);
      }

      if (toWrite.isEmpty) {
        return TransferResult(
          ok: true,
          message: '这 ${facts.length} 条记忆本机都有了，没有新增。$guardNote',
          path: source,
          skipped: skipped,
        );
      }

      await _exec(_insertSql(toWrite));
      final now = await _count('select count(*) from memory_fact');
      return TransferResult(
        ok: true,
        message:
            '导入 ${toWrite.length} 条记忆'
            '${skipped == 0 ? '' : '，$skipped 条重复跳过'}；'
            '记忆库现有 $now 条。$guardNote',
        path: source,
        count: toWrite.length,
        skipped: skipped,
      );
    } catch (e) {
      return TransferResult.fail('写库失败：${_clean(e)}');
    }
  }

  // ── 系统面板 ────────────────────────────────────────────────────────────

  /// 让用户挑一个目录。走系统的选目录面板，不自己造文件浏览器。
  Future<String?> pickDirectory(String prompt) async {
    final r = await _osascript('POSIX path of (choose folder with prompt "$prompt")');
    return r;
  }

  /// 让用户挑一个文件。扩展名列表给空表示不限。
  Future<String?> pickFile(String prompt, List<String> extensions) async {
    final spec = extensions.isEmpty
        ? ''
        : ' of type {${extensions.map((e) => '"$e"').join(', ')}}';
    return _osascript('POSIX path of (choose file with prompt "$prompt"$spec)');
  }

  /// 在访达里选中导出的东西。用户刚写完一个文件，下一步一定是去找它。
  Future<TransferResult> reveal(String path) async {
    try {
      await Process.run('open', ['-R', path]);
      return TransferResult(ok: true, message: '已在访达中打开。', path: path);
    } catch (e) {
      return TransferResult.fail('打不开访达：${_clean(e)}');
    }
  }

  // ── 内部：读库 ──────────────────────────────────────────────────────────

  Future<List<TransferFact>> _readFacts() async {
    final rows = await _query(
      'select id, category, text, salience, created_at, subject, evidence, archived '
      'from memory_fact where text is not null and text <> \'\' '
      'order by created_at asc',
    );
    return [
      for (final row in rows)
        if (_text(row['id']).isNotEmpty)
          TransferFact(
            id: _text(row['id']),
            category: _text(row['category']),
            text: _text(row['text']).trim(),
            salience: _number(row['salience'], 50),
            createdAt: _time(row['created_at']) ?? _now(),
            subject: _text(row['subject']),
            evidence: _text(row['evidence']),
            archived: _int(row['archived']) == 1,
          ),
    ];
  }

  Future<List<TransferLink>> _readLinks() async {
    final rows = await _query(
      'select from_id, to_id, weight from memory_link where coalesce(approved, 1) = 1',
    );
    return [
      for (final row in rows)
        TransferLink(
          from: _text(row['from_id']),
          to: _text(row['to_id']),
          weight: _number(row['weight'], 0.5),
        ),
    ];
  }

  Future<int> _count(String sql) async {
    final rows = await _query(sql);
    if (rows.isEmpty) return 0;
    return _int(rows.first.values.first);
  }

  /// 跑一条查询，把 `-json` 输出解析成行列表。零行时 sqlite3 输出空串，不是 `[]`。
  Future<List<Map<String, dynamic>>> _query(String sql) async {
    var r = await Process.run(_sqlite, ['-readonly', '-json', dbPath, sql]);
    if (r.exitCode != 0) {
      // WAL 模式下 `-readonly` 需要能打开 `-wal` / `-shm`；这两个文件缺失
      // （刚被杀进程、或库是拷贝来的）时会报 CANTOPEN。这时退回 URI 只读，
      // 读主库里的内容——宁可少一条刚落盘的，也不该显示成「没有记忆」。
      r = await Process.run(_sqlite, [
        '-json',
        'file:$dbPath?mode=ro',
        sql,
      ]);
    }
    if (r.exitCode != 0) {
      throw ProcessException(
        _sqlite,
        const [],
        '${r.stderr}'.trim().isEmpty ? 'exit ${r.exitCode}' : '${r.stderr}'.trim(),
        r.exitCode,
      );
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

  /// 跑一段写库脚本。走 stdin 而不是命令行参数：SQL 里带换行与引号，
  /// 拼进 argv 迟早会在某条记忆上炸掉。
  Future<void> _exec(String sql) async {
    final p = await Process.start(_sqlite, [dbPath]);
    p.stdin.write(sql);
    await p.stdin.close();
    final code = await p.exitCode;
    final err = await p.stderr.transform(utf8.decoder).join();
    if (code != 0) {
      throw ProcessException(_sqlite, const [], err.trim(), code);
    }
  }

  /// 一条 `insert or ignore` 的批。整段包在一个事务里，中途失败不会留下半批。
  String _insertSql(List<TransferFact> facts) {
    final b = StringBuffer('begin;\n');
    for (final f in facts) {
      b
        ..write('insert or ignore into memory_fact (')
        ..write(
          'id, kind, category, channel, text, summary, subject, salience, '
          'arousal, stability_hours, stability_mult, times_said, hits, '
          'revisions, created_at, last_seen_at, archived, sealed, evidence',
        )
        ..write(') values (')
        ..write(
          [
            _q(f.id),
            "'fact'",
            _q(f.category.isEmpty ? 'general' : f.category),
            "'import'",
            _q(f.text),
            _q(f.text),
            f.subject.isEmpty ? 'null' : _q(f.subject),
            _real(f.salience),
            _real(0.5),
            _real(24),
            _real(1),
            '0',
            '0',
            '0',
            '${f.createdAt.millisecondsSinceEpoch}',
            '${f.createdAt.millisecondsSinceEpoch}',
            f.archived ? '1' : '0',
            '0',
            f.evidence.isEmpty ? 'null' : _q(f.evidence),
          ].join(', '),
        )
        ..write(');\n');
    }
    b.write('commit;\n');
    return b.toString();
  }

  // ── 内部：两种读法 ──────────────────────────────────────────────────────

  String _markdownOf(List<TransferFact> facts, List<TransferLink> links) {
    final at = _stampHuman(_now());
    final b = StringBuffer()
      ..writeln('# 空谷记忆')
      ..writeln()
      ..writeln(
        '$at 导出于本机。共 ${facts.length} 条记忆'
        '${links.isEmpty ? '' : '、${links.length} 条关联'}。',
      )
      ..writeln()
      ..writeln(
        '一条一段。段首那行注释是给程序看的——有它，导回来就能和原记忆对上；'
        '删掉也不影响阅读，导回来时会当成新记忆。',
      )
      ..writeln()
      ..writeln('---')
      ..writeln();

    // 归档的排在最后：它们仍然属于用户，只是不在星图上画。
    final live = facts.where((f) => !f.archived);
    final archived = facts.where((f) => f.archived);
    for (final f in [...live, ...archived]) {
      b
        ..writeln('## ${f.text}')
        ..writeln()
        ..writeln(
          '<!-- ondra:memory id=${f.id} category=${f.category} '
          'salience=${_real(f.salience)} '
          'created_at=${f.createdAt.millisecondsSinceEpoch}'
          '${f.archived ? ' archived=1' : ''} -->',
        )
        ..writeln()
        ..writeln('- 类别：${f.category}')
        ..writeln('- 显著度：${f.salience.round()}')
        ..writeln('- 记录于：${_stampHuman(f.createdAt)}');
      if (f.archived) b.writeln('- 状态：已归档');
      final quote = _firstQuote(f.evidence);
      if (quote != null) b.writeln('- 原话：「$quote」');
      b
        ..writeln()
        ..writeln('---')
        ..writeln();
    }

    if (links.isNotEmpty) {
      b
        ..writeln('## 关联')
        ..writeln()
        ..writeln('| 从 | 到 | 权重 |')
        ..writeln('| --- | --- | --- |');
      for (final l in links) {
        b.writeln('| `${l.from}` | `${l.to}` | ${l.weight.toStringAsFixed(2)} |');
      }
      b.writeln();
    }
    return b.toString();
  }

  String _jsonOf(List<TransferFact> facts, List<TransferLink> links) {
    final body = <String, Object?>{
      'format': 'ondra.memory',
      'version': 1,
      'exportedAt': _now().toUtc().toIso8601String(),
      'facts': [
        for (final f in facts)
          {
            'id': f.id,
            'category': f.category,
            'text': f.text,
            'salience': f.salience,
            'createdAt': f.createdAt.millisecondsSinceEpoch,
            if (f.subject.isNotEmpty) 'subject': f.subject,
            if (f.evidence.isNotEmpty) 'evidence': f.evidence,
            if (f.archived) 'archived': true,
          },
      ],
      'links': [
        for (final l in links)
          {'from': l.from, 'to': l.to, 'weight': l.weight},
      ],
    };
    return const JsonEncoder.withIndent('  ').convert(body);
  }

  /// 解析 Markdown。规则只有三条，够用且不会误读：
  /// 1. `## ` 开一段，段标题就是记忆正文；
  /// 2. 段内 `<!-- ondra:memory ... -->` 给出 id / 类别 / 显著度 / 时间；
  /// 3. 没有注释的段落也收——用户手写的清单同样是一份记忆。
  List<TransferFact> _parseMarkdown(String text) {
    final out = <TransferFact>[];
    final lines = const LineSplitter().convert(text);
    String? title;
    final body = StringBuffer();

    void flush() {
      final t = (title ?? '').trim();
      if (t.isEmpty) {
        body.clear();
        return;
      }
      // 「关联」那一节是表格，不是记忆。
      if (t == '关联' || t == '空谷记忆') {
        title = null;
        body.clear();
        return;
      }
      final meta = _metaOf(body.toString());
      out.add(
        TransferFact(
          id: meta['id'] ?? _factId(t),
          category: meta['category'] ?? 'general',
          text: t,
          salience: double.tryParse(meta['salience'] ?? '') ?? 50,
          createdAt: meta['created_at'] == null
              ? _now()
              : DateTime.fromMillisecondsSinceEpoch(
                  int.tryParse(meta['created_at']!) ??
                      _now().millisecondsSinceEpoch,
                ),
          archived: meta['archived'] == '1',
        ),
      );
      title = null;
      body.clear();
    }

    for (final line in lines) {
      if (line.startsWith('## ')) {
        flush();
        title = line.substring(3);
        continue;
      }
      if (title != null) body.writeln(line);
    }
    flush();
    return out;
  }

  /// 从 JSON 里认记忆。接受两种形状：我们导出的对象，或一个裸的数组。
  List<TransferFact> _factsFromJson(Object? decoded) {
    final List<Object?> raw;
    if (decoded is List) {
      raw = decoded;
    } else if (decoded is Map && decoded['facts'] is List) {
      raw = (decoded['facts'] as List).cast<Object?>();
    } else {
      return const [];
    }
    final out = <TransferFact>[];
    for (final item in raw) {
      if (item is! Map) continue;
      final text = _text(item['text']).trim();
      if (text.isEmpty) continue;
      final created = _int(item['createdAt']);
      out.add(
        TransferFact(
          id: _text(item['id']).isEmpty ? _factId(text) : _text(item['id']),
          category: _text(item['category']).isEmpty
              ? 'general'
              : _text(item['category']),
          text: text,
          salience: _number(item['salience'], 50),
          createdAt: created > 0
              ? DateTime.fromMillisecondsSinceEpoch(created)
              : _now(),
          subject: _text(item['subject']),
          evidence: _text(item['evidence']),
          archived: item['archived'] == true || _int(item['archived']) == 1,
        ),
      );
    }
    return out;
  }

  Map<String, String> _metaOf(String block) {
    final m = RegExp(r'<!--\s*ondra:memory\s+([^>]*)-->').firstMatch(block);
    if (m == null) return const {};
    final out = <String, String>{};
    for (final pair in (m.group(1) ?? '').split(RegExp(r'\s+'))) {
      final i = pair.indexOf('=');
      if (i <= 0) continue;
      out[pair.substring(0, i)] = pair.substring(i + 1);
    }
    return out;
  }

  String? _firstQuote(String evidence) {
    if (evidence.isEmpty) return null;
    try {
      final decoded = jsonDecode(evidence);
      if (decoded is List && decoded.isNotEmpty) {
        final first = decoded.first;
        if (first is Map) {
          final q = _text(first['quote']).trim();
          if (q.isNotEmpty) return q;
        }
      }
    } catch (_) {
      // 证据链不是合法 JSON 就不显示原话，不该因此让整份导出失败。
    }
    return null;
  }

  // ── 内部：目录与时间 ────────────────────────────────────────────────────

  /// 备份引擎的份数与占用。读失败按 0 算：这一页的主语是「记忆能不能带走」，
  /// 不该因为备份目录读不了就整页报错。
  Future<(int, int)> _backupStats() async {
    try {
      final overview = await backupOverviewLoader();
      return (overview.snapshots.length, overview.storedBytes);
    } catch (_) {
      return (0, 0);
    }
  }

  int _sessionCount() {
    final root = Directory('$dataRoot/dsh/sessions');
    if (!root.existsSync()) return 0;
    var n = 0;
    for (final project in root.listSync().whereType<Directory>()) {
      for (final s in project.listSync().whereType<Directory>()) {
        if (File('${s.path}/session.v4.jsonl').existsSync()) n++;
      }
    }
    return n;
  }

  List<Directory> _personaPacks() {
    final root = Directory('$dataRoot/user/personas');
    if (!root.existsSync()) return const [];
    return root.listSync().whereType<Directory>().toList(growable: false);
  }

  int _logBytes() {
    final root = Directory('$dataRoot/logs');
    if (!root.existsSync()) return 0;
    var n = 0;
    for (final f in root.listSync().whereType<File>()) {
      if (f.path.endsWith('.log')) n += f.lengthSync();
    }
    return n;
  }

  /// 内核 profile 里与人设有关的那几段配置。
  ///
  /// 只抓 `- id: ondra-persona*` 起的整块（含其下的 `name` / `config` / `inject`），
  /// 抓到下一个同缩进的 `- id:` 为止。这是「人设是怎么组装的」唯一的事实来源。
  String _personaConfig() {
    final file = File('$dataRoot/dsh/profiles/ondra/cordis.patch.yml');
    if (!file.existsSync()) return '';
    final out = <String>[];
    String? indent;
    var taking = false;
    for (final line in file.readAsLinesSync()) {
      final isId = RegExp(r'^(\s*)-\s+id:').firstMatch(line);
      if (isId != null) {
        final lead = isId.group(1) ?? '';
        final id = line.substring(line.indexOf('id:') + 3).trim();
        if (id.startsWith('ondra-persona')) {
          taking = true;
          indent = lead;
          out.add(line);
          continue;
        }
        if (taking && lead.length <= (indent?.length ?? 0)) {
          taking = false;
        }
      }
      if (taking) out.add(line);
    }
    return out.join('\n').trim();
  }

  Future<String?> _osascript(String script) async {
    try {
      final r = await Process.run('osascript', ['-e', script]);
      if (r.exitCode != 0) return null;
      final path = '${r.stdout}'.trim();
      return path.isEmpty ? null : path;
    } catch (_) {
      return null;
    }
  }

  Future<void> _copyTree(Directory from, Directory to) async {
    await to.create(recursive: true);
    for (final e in from.listSync(recursive: true, followLinks: false)) {
      final rel = e.path.substring(from.path.length + 1);
      if (e is Directory) {
        await Directory('${to.path}/$rel').create(recursive: true);
      } else if (e is File) {
        final target = File('${to.path}/$rel');
        await target.parent.create(recursive: true);
        await e.copy(target.path);
      }
    }
  }

  int _fileSize(String path) {
    final f = File(path);
    return f.existsSync() ? f.lengthSync() : 0;
  }

  String _stamp() {
    final t = _now();
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}${two(t.month)}${two(t.day)}-'
        '${two(t.hour)}${two(t.minute)}${two(t.second)}';
  }

  String _stampHuman(DateTime t) {
    String two(int v) => v.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)} '
        '${two(t.hour)}:${two(t.minute)}';
  }
}

/// 页面与测试共用的那一个实例：默认读真实 `~/.ondra`。
final TransferEngine transferEngine = TransferEngine();

/// 两条 32 位 FNV 变体并成 12 位十六进制。
///
/// 这里要回答的只是「这两句话是不是同一句」，不是「有没有被篡改」——
/// 与备份引擎里的指纹同一个算法，同一个理由：不引密码学哈希。
String _factId(String text) {
  var h1 = 0x811c9dc5;
  var h2 = 0x01000193;
  for (final byte in utf8.encode(text)) {
    h1 = (h1 ^ byte) * 0x01000193 & 0xFFFFFFFF;
    h2 = (h2 + byte) * 0x85ebca6b & 0xFFFFFFFF;
  }
  return 'm-${_hex8(h1)}${_hex8(h2).substring(0, 4)}';
}

String _hex8(int v) => v.toRadixString(16).padLeft(8, '0');

String _humanSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  final kb = bytes / 1024;
  if (kb < 1024) return '${kb.toStringAsFixed(1)} KB';
  final mb = kb / 1024;
  return '${mb.toStringAsFixed(1)} MB';
}

String _q(String v) => "'${v.replaceAll("'", "''")}'";

/// STRICT 表要求类型精确：REAL 列写 `50` 会被拒，必须写成 `50.0`。
String _real(double v) {
  final s = v.toStringAsFixed(3);
  return s;
}

String _text(Object? v) => v is String ? v : (v?.toString() ?? '');

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

String _clean(Object e) => '$e'.replaceFirst('ProcessException: ', '').trim();
