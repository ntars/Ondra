import 'dart:io';

import '../../../../../app/home_dir.dart';

/// 内核配置的**真实落点**：profile 装配层 `cordis.patch.yml` 的条目 `config` 块。
///
/// ## 为什么不是 `settings.json`
///
/// 2026-11-19 对着内核源码核过：发行版里没有任何模块读
/// `$DSH_HOME/settings.json`（grep 全树只命中无关的 pi-ai 工具）。
/// 内核的配置真源是 **profile patch**：装配时按条目的 `config` 传给
/// `apply(ctx, config)`，插件再用 `schema.resolve(section, {user: config})`
/// 做四层合并。所以「设置页拨了一个开关」要真的生效，就得改这里。
///
/// ## 生效时机
///
/// 内核在**进程启动**时读装配层（没有文件 watcher）。写完的改动在
/// 下一次内核重启后生效——「换默认模型」本来就会重启子进程，其余项要等
/// 下一次启动。
///
/// ## 为什么是行级编辑而不是 YAML 库
///
/// 装配层是内核唯一入口，且里面全是人写的注释（「为什么这个插件必须排在
/// 前面」这类）。过一遍 YAML 库再序列化会把注释全部丢掉。行级编辑只动
/// 目标那几行，别的一个字节都不碰。
///
/// ## 安全网
///
/// - 改之前留一份 `.bak`（与插件开关同一个约定），改坏了有回头路；
/// - 先写临时文件再 rename（原子写），中途被杀不会留下半个文件；
/// - 找不到条目就返回 false，**不新建条目**——猜错 id 插一个条目会让装配
///   层多出一个指向不存在插件的行，那是启动级的故障。
String? readProfileConfigField(String section, String key) {
  final file = _patchFile();
  if (!file.existsSync()) return null;
  final List<String> lines;
  try {
    lines = file.readAsLinesSync();
  } catch (_) {
    return null;
  }
  final block = _entryBlock(lines, section);
  if (block == null) return null;
  final config = _configBlock(lines, block);
  if (config == null) return null;
  final found = _findField(lines, config, key);
  if (found == null) return null;
  return _scalarOf(lines[found.valueLine]);
}

/// 写一个字段。返回是否真的落盘。
///
/// [value] 为 null 表示删除该字段（整段空了就把 `config:` 行也去掉）。
bool writeProfileConfigField(String section, String key, Object? value) {
  final file = _patchFile();
  if (!file.existsSync()) return false;
  final List<String> lines;
  try {
    lines = file.readAsLinesSync();
  } catch (_) {
    return false;
  }
  final block = _entryBlock(lines, section);
  if (block == null) return false;

  final next = List<String>.from(lines);
  final config = _configBlock(next, block);
  final fieldIndent = config == null ? '${block.itemIndent}  ' : config.fieldIndent;

  if (config == null) {
    if (value == null) return true; // 没有 config 块，删一个不存在的字段＝已经是对的。
    // 在条目块末尾（下一个同级/更浅缩进之前）插入 config 块。
    final insertAt = block.end;
    next.insertAll(insertAt, [
      '${block.itemIndent}config:',
      '$fieldIndent$key: ${_encode(value)}',
    ]);
  } else {
    final found = _findField(next, config, key);
    if (value == null) {
      if (found == null) return true;
      next.removeAt(found.valueLine);
      // 删完如果是空的（config 下没有别的字段），连 config: 行一起删。
      final stillHasField = _findAnyField(next, config);
      if (!stillHasField) next.removeAt(config.headerLine);
    } else if (found == null) {
      next.insert(config.end, '$fieldIndent$key: ${_encode(value)}');
    } else {
      next[found.valueLine] = '$fieldIndent$key: ${_encode(value)}';
    }
  }

  return _commit(file, next);
}

// ── 定位 ────────────────────────────────────────────────────────────────────

/// 一个条目块：[start, end) 是行号范围，[itemIndent] 是 `- id:` 前的缩进。
class _Block {
  const _Block({required this.start, required this.end, required this.itemIndent});
  final int start;
  final int end;
  final String itemIndent;
}

class _ConfigBlock {
  const _ConfigBlock({
    required this.headerLine,
    required this.end,
    required this.fieldIndent,
  });

  /// `config:` 那一行。
  final int headerLine;

  /// 块结束（不含）。
  final int end;

  /// 字段行的缩进（`config:` 缩进 + 2 空格，按文件里实际的写法）。
  final String fieldIndent;
}

class _Field {
  const _Field({required this.valueLine});
  final int valueLine;
}

/// 找 `- id: ondra-<section>` 条目。section 是内核段 id（如 `privacy`），
/// 条目 id 是 `ondra-<section>`——两条侧的命名约定见 LAYOUT.md。
_Block? _entryBlock(List<String> lines, String section) {
  final wanted = 'ondra-$section';
  final idPattern = RegExp(r'^(\s*)-\s+id:\s*(\S+)\s*$');
  for (var i = 0; i < lines.length; i++) {
    final m = idPattern.firstMatch(lines[i]);
    if (m == null) continue;
    if (m.group(2) != wanted) continue;
    final indent = m.group(1) ?? '';
    // 块到下一个缩进 <= 条目缩进的非空行为止。
    var end = i + 1;
    while (end < lines.length) {
      final line = lines[end];
      if (line.trim().isEmpty) {
        end++;
        continue;
      }
      final leading = line.length - line.trimLeft().length;
      if (leading <= indent.length) break;
      end++;
    }
    return _Block(start: i, end: end, itemIndent: '$indent  ');
  }
  return null;
}

/// 条目块里的 `config:` 行。
_ConfigBlock? _configBlock(List<String> lines, _Block block) {
  final pattern = RegExp(r'^(\s*)config:\s*$');
  for (var i = block.start + 1; i < block.end; i++) {
    final m = pattern.firstMatch(lines[i]);
    if (m == null) continue;
    final headerIndent = m.group(1) ?? '';
    var end = i + 1;
    while (end < block.end) {
      final line = lines[end];
      if (line.trim().isEmpty) break;
      final leading = line.length - line.trimLeft().length;
      if (leading <= headerIndent.length) break;
      end++;
    }
    return _ConfigBlock(
      headerLine: i,
      end: end,
      fieldIndent: '$headerIndent  ',
    );
  }
  return null;
}

/// 在一个块里找 `key:` 行（只认顶层字段，不认嵌套）。
_Field? _findField(List<String> lines, _ConfigBlock config, String key) {
  final pattern = RegExp('^(\\s*)${RegExp.escape(key)}:');
  for (var i = config.headerLine + 1; i < config.end; i++) {
    final line = lines[i];
    final m = pattern.firstMatch(line);
    if (m == null) continue;
    // 只认字段缩进这一层：更深的缩进属于上一字段的嵌套值。
    if (m.group(1) != config.fieldIndent) continue;
    return _Field(valueLine: i);
  }
  return null;
}

bool _findAnyField(List<String> lines, _ConfigBlock config) {
  for (var i = config.headerLine + 1; i < config.end; i++) {
    final line = lines[i];
    if (line.trim().isEmpty) continue;
    final leading = line.length - line.trimLeft().length;
    if (leading < config.fieldIndent.length) continue;
    if (line.trimLeft().startsWith('- ')) continue;
    return true;
  }
  return false;
}

/// 从 `    key: value` 里取 value（去引号）。
///
/// 顺序很重要：**先认引号整体**，再去行尾注释。反过来的话，值本身含
/// ` #`（`'a: b # c'`）会被截成 `'a: b`——引号缺一半，值就废了。
String? _scalarOf(String line) {
  final idx = line.indexOf(':');
  if (idx < 0) return null;
  final v = line.substring(idx + 1).trim();
  if (v.isEmpty) return null;
  if (v.length >= 2) {
    if (v.startsWith("'") && v.endsWith("'")) {
      return v.substring(1, v.length - 1).replaceAll("''", "'");
    }
    if (v.startsWith('"') && v.endsWith('"')) {
      return v.substring(1, v.length - 1);
    }
  }
  // 行尾注释（` 0.25  # 说明`）不算值。
  final hash = v.indexOf(' #');
  return hash > 0 ? v.substring(0, hash).trim() : v;
}

// ── 序列化与落盘 ────────────────────────────────────────────────────────────

/// 把 Dart 值写成 YAML 标量。字符串只在必要时加单引号。
String _encode(Object value) {
  if (value is bool || value is num) return '$value';
  final text = '$value';
  if (text.isEmpty) return "''";
  final needsQuote = RegExp(r'''[:#\[\]{}&*!|>'"%@`,]''').hasMatch(text) ||
      text.trim() != text ||
      RegExp(r'^(true|false|null|~|\d)').hasMatch(text);
  if (!needsQuote) return text;
  return "'${text.replaceAll("'", "''")}'";
}

bool _commit(File file, List<String> next) {
  try {
    // 第一次改之前留一份原样：装配层是内核唯一入口，改坏了要有回头路。
    final backup = File('${file.path}.bak');
    if (!backup.existsSync()) file.copySync(backup.path);
    final tmp = File('${file.path}.tmp');
    tmp.writeAsStringSync('${next.join('\n')}\n');
    tmp.renameSync(file.path);
    return true;
  } catch (_) {
    return false;
  }
}

/// **仅测试用**：把装配层指到临时文件，免得测试改到真机上的 profile。
/// 生产代码永不赋值。
String? debugProfileConfigFileOverride;

File _patchFile() {
  final override = debugProfileConfigFileOverride;
  if (override != null) return File(override);
  final home = ondraUserHome;
  return File('$home/.ondra/dsh/profiles/ondra/cordis.patch.yml');
}
