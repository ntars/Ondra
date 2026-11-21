import 'dart:convert';
import 'dart:io';

import '../../../../../app/home_dir.dart';

/// 只沿 patch.insert / group.config 遍历插件。普通 config（包括 managed
/// model route 的嵌套 JSON）是不透明的数据，绝不把里面的 id/config 当插件。
String? readProfileConfigField(String section, String key) {
  try {
    final document = _Document(_patchFile().readAsStringSync());
    final entry = document.entry(section);
    final config = entry.fields['config'];
    if (config == null) return null;
    if (_value(config.value).startsWith('{')) {
      final data = jsonDecode(_value(config.value)) as Map;
      final value = data[key];
      return value == null ? null : '$value';
    }
    final fields = document.configFields(entry, config);
    final field = fields[key];
    return field == null ? null : _scalar(field.value);
  } catch (_) {
    return null;
  }
}

/// 兼容旧调用点；需要错误原因与待重启状态时用详细结果。
bool writeProfileConfigField(String section, String key, Object? value) =>
    writeProfileConfigFieldResult(section, key, value).ok;

/// ok 只表示配置已落盘，不表示运行中的内核已采用它。
({bool ok, bool changed, String? error}) writeProfileConfigFieldResult(
  String section,
  String key,
  Object? value,
) {
  File? temporary;
  try {
    if (!RegExp(r'^[a-z][a-z0-9-]*$').hasMatch(key)) {
      throw const FormatException('配置字段名无效');
    }
    final file = _patchFile();
    if (!file.existsSync()) throw const FormatException('profile 尚未初始化或不存在');
    if (FileSystemEntity.isLinkSync(file.path)) {
      throw const FormatException('profile 是符号链接，拒绝替换');
    }
    // rename 能绕过只读文件的 mode；必须在替换前显式尊重它。
    if (file.statSync().mode & 0x92 == 0 ||
        file.parent.statSync().mode & 0x92 == 0) {
      throw const FormatException('profile 或所在目录只读');
    }
    final before = file.readAsStringSync();
    final document = _Document(before);
    final entry = document.entry(section);
    if (entry.disabled) throw FormatException('条目 ondra-$section 已禁用（或所属组已禁用）');
    document.write(entry, key, value);
    final after = document.render();
    if (after == before) return (ok: true, changed: false, error: null);
    // 同步区间内也检查外部编辑；不覆盖另一位编辑者已经写入的版本。
    if (file.readAsStringSync() != before) {
      throw const FormatException('profile 已被其他操作修改，请重试');
    }
    final backup = File('${file.path}.bak');
    if (!backup.existsSync()) file.copySync(backup.path);
    // 从原文件复制，保留原有权限，不把私有配置变成全局可读。
    temporary = File(
      '${file.path}.settings-$pid-${DateTime.now().microsecondsSinceEpoch}.tmp',
    );
    file.copySync(temporary.path);
    temporary.writeAsStringSync(after, flush: true);
    if (file.readAsStringSync() != before) {
      throw const FormatException('profile 已被其他操作修改，请重试');
    }
    temporary.renameSync(file.path);
    return (ok: true, changed: true, error: null);
  } catch (e) {
    return (ok: false, changed: false, error: '配置未保存：$e');
  } finally {
    try {
      if (temporary != null && temporary.existsSync()) temporary.deleteSync();
    } catch (_) {
      // 清理失败不能覆盖原来的可读错误结果。
    }
  }
}

const _off = '# ondra-plugin-off: ';
int _indent(String text) => text.length - text.trimLeft().length;
bool _empty(String text) =>
    text.trim().isEmpty || text.trimLeft().startsWith('#');
String _value(String text) =>
    text.trimLeft().startsWith('#') ? '' : text.trim();
Never _reject(String message) => throw FormatException('装配层无法安全编辑：$message');

String _scalar(String text) {
  final value = text.trim();
  final quoted = RegExp(r'''^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")\s*(?:#.*)?$''')
      .firstMatch(value);
  if (quoted != null) {
    final token = quoted[1]!;
    return token.startsWith("'")
        ? token.substring(1, token.length - 1).replaceAll("''", "'")
        : jsonDecode(token) as String;
  }
  return value.split(RegExp(r'\s+#')).first.trim();
}

class _Line {
  _Line(this.text, this.eol);
  String text;
  final String eol;
  String get logical =>
      text.startsWith(_off) ? text.substring(_off.length) : text;
}

class _Field {
  _Field(this.line, this.end, this.value);
  final int line;
  int end;
  final String value;
}

class _Entry {
  _Entry(
    this.id,
    this.start,
    this.end,
    this.indent,
    this.fields,
    this.disabled,
  );
  final String id;
  final int start;
  final int end;
  final int indent;
  final Map<String, _Field> fields;
  final bool disabled;
}

class _Document {
  _Document(String source) {
    for (final m in RegExp(r'([^\r\n]*)(\r\n|\n|\r|$)').allMatches(source)) {
      if (m[0]!.isNotEmpty) lines.add(_Line(m[1]!, m[2]!));
    }
    logical = lines.map((line) => line.logical).toList();
    // 旧版注释开关只在结构树内被识别，普通 config 的内容永远不递归。
    for (var i = 0; i < logical.length; i++) {
      final m = RegExp(r'^( *)# - id:').firstMatch(logical[i]);
      if (m == null) continue;
      final base = m[1]!;
      logical[i] = '$base${logical[i].substring(base.length + 2)}';
      commented.add(i);
      for (var j = i + 1; j < logical.length; j++) {
        if (logical[j].startsWith('$base#   ')) {
          logical[j] = '$base${logical[j].substring(base.length + 2)}';
        } else if (!_empty(logical[j]) && _indent(logical[j]) <= base.length) {
          break;
        }
      }
    }
    _sequence(0, lines.length, 0, (start, end) {
      final fields = _fields(start, end, 2, firstSequence: true);
      if (fields.keys.any(
        (key) => !{'insert', 'before', 'after'}.contains(key),
      )) {
        _reject('存在覆盖补丁，无法确定最终配置');
      }
      final insert = fields['insert'];
      if (insert == null) _reject('只支持 insert 补丁');
      if (_value(insert.value) == '[]') return;
      if (_value(insert.value).isNotEmpty) _reject('insert 必须是块式列表');
      final child = _first(insert.line + 1, insert.end);
      if (child != null) {
        _entries(child, insert.end, _indent(logical[child]), false);
      }
    });
  }

  final lines = <_Line>[];
  late final List<String> logical;
  final commented = <int>{};
  final entries = <String, _Entry>{};
  String get eol => lines
      .map((l) => l.eol)
      .firstWhere((s) => s.isNotEmpty, orElse: () => '\n');
  String render() => lines.map((l) => '${l.text}${l.eol}').join();

  int? _first(int start, int end) {
    for (var i = start; i < end; i++) {
      if (!_empty(logical[i])) return i;
    }
    return null;
  }

  void _sequence(
    int start,
    int end,
    int indent,
    void Function(int, int) visit,
  ) {
    var i = _first(start, end);
    while (i != null) {
      if (_indent(logical[i]) != indent ||
          !logical[i].substring(indent).startsWith('- ')) {
        _reject('第 ${i + 1} 行不是预期层级的列表');
      }
      var next = i + 1;
      while (next < end &&
          (_empty(logical[next]) || _indent(logical[next]) > indent)) {
        next++;
      }
      var ownedEnd = next;
      while (ownedEnd > i + 1 && _empty(logical[ownedEnd - 1])) {
        ownedEnd--;
      }
      visit(i, ownedEnd);
      i = _first(next, end);
    }
  }

  Map<String, _Field> _fields(
    int start,
    int end,
    int indent, {
    bool firstSequence = false,
  }) {
    final fields = <String, _Field>{};
    _Field? previous;
    for (var i = start; i < end; i++) {
      var text = logical[i];
      if (_empty(text)) continue;
      if (i == start && firstSequence) {
        text = text.substring(indent);
      } else {
        if (_indent(text) > indent) continue;
        if (_indent(text) != indent) _reject('第 ${i + 1} 行缩进无效');
        text = text.substring(indent);
      }
      final m = RegExp(r'^([a-zA-Z][\w-]*):(?:\s+(.*))?$').firstMatch(text);
      if (m == null) _reject('第 ${i + 1} 行字段格式不受支持');
      if (fields.containsKey(m[1])) _reject('重复字段 ${m[1]}');
      previous?.end = i;
      fields[m[1]!] = previous = _Field(i, end, m[2] ?? '');
    }
    return fields;
  }

  void _entries(int start, int end, int indent, bool parentDisabled) {
    if (indent < 2) _reject('条目缩进无效');
    _sequence(start, end, indent, (start, end) {
      final fields = _fields(start, end, indent + 2, firstSequence: true);
      final idField = fields['id'];
      if (idField == null) _reject('条目缺少 id');
      final id = _scalar(idField.value);
      if (entries.containsKey(id)) _reject('重复条目 $id');
      final group = _scalar(fields['group']?.value ?? '') == 'true';
      if (!group && fields['name'] == null) _reject('$id 缺少包名');
      final disabled =
          parentDisabled ||
          lines[start].text.startsWith(_off) ||
          commented.contains(start) ||
          (fields['disabled'] != null &&
              _scalar(fields['disabled']!.value) != 'false');
      entries[id] = _Entry(id, start, end, indent, fields, disabled);
      if (group) {
        final config = fields['config'];
        if (config == null || _value(config.value) == '[]') return;
        if (_value(config.value).isNotEmpty) _reject('group.config 必须是块式列表');
        final child = _first(config.line + 1, config.end);
        if (child != null) {
          _entries(child, config.end, _indent(logical[child]), disabled);
        }
      }
    });
  }

  _Entry entry(String section) =>
      entries['ondra-$section'] ??
      (throw FormatException('缺少条目 ondra-$section（可能被手动注释）'));

  Map<String, _Field> configFields(_Entry entry, _Field config) {
    if (_value(config.value).isNotEmpty) {
      _reject('${entry.id}.config 不是块式映射或 JSON 对象');
    }
    final first = _first(config.line + 1, config.end);
    if (first == null) return {};
    final indent = _indent(logical[first]);
    if (indent <= entry.indent + 2) _reject('config 缩进无效');
    return _fields(first, config.end, indent);
  }

  void _insert(int index, List<String> text) {
    if (index > 0 && lines[index - 1].eol.isEmpty) {
      lines[index - 1] = _Line(lines[index - 1].text, eol);
    }
    lines.insertAll(index, text.map((s) => _Line(s, eol)));
  }

  void write(_Entry entry, String key, Object? value) {
    if (_scalar(entry.fields['group']?.value ?? '') == 'true') {
      _reject('目标是插件组');
    }
    final config = entry.fields['config'];
    final propertyIndent = ' ' * (entry.indent + 2);
    if (config == null) {
      if (value != null) {
        _insert(entry.end, [
          '$propertyIndent'
              'config:',
          '$propertyIndent  $key: ${_encode(value)}',
        ]);
      }
      return;
    }
    if (_value(config.value).startsWith('{')) {
      final old = lines[config.line];
      final start = old.text.indexOf('{', old.text.indexOf(':') + 1);
      final end = old.text.lastIndexOf('}') + 1;
      // JSON 顶层 token 范围替换；未被管理的键/嵌套结构保持逐字节不变。
      final edited = _editJson(_value(config.value), key, value);
      lines[config.line] = _Line(
        old.text.replaceRange(start, end, edited),
        old.eol,
      );
      return;
    }
    final fields = configFields(entry, config);
    final field = fields[key];
    if (field != null) {
      // 不能将人的嵌套结构/锚点覆盖成一个标量。
      final token = _value(field.value);
      if (token.isEmpty ||
          RegExp(r'^[\[\]{&*!|>]').hasMatch(token) ||
          _first(field.line + 1, field.end) != null) {
        _reject('$key 不是可替换的单行标量');
      }
      if (value == null) {
        lines.removeAt(field.line);
        if (fields.length == 1) lines.removeAt(config.line);
      } else if (_scalar(field.value) != '$value') {
        final old = lines[field.line];
        final comment = _inlineComment(field.value);
        final indent = ' ' * _indent(old.text);
        lines[field.line] = _Line(
          '$indent$key: ${_encode(value)}$comment',
          old.eol,
        );
      }
    } else if (value != null) {
      final indent = fields.isEmpty
          ? entry.indent + 4
          : _indent(logical[fields.values.first.line]);
      _insert(config.end, ['${' ' * indent}$key: ${_encode(value)}']);
    }
  }
}

String _inlineComment(String value) {
  var quote = '';
  for (var i = 0; i < value.length; i++) {
    final c = value[i];
    if (quote.isNotEmpty) {
      if (c == '\\' && quote == '"') {
        i++;
        continue;
      }
      if (c == quote) quote = '';
    } else if (c == '"' || c == "'") {
      quote = c;
    } else if (c == '#' && i > 0 && value[i - 1].trim().isEmpty) {
      return '  ${value.substring(i)}';
    }
  }
  return '';
}

String _encode(Object value) {
  if (value is bool || value is num) return '$value';
  final text = '$value';
  if (RegExp(r'^[a-zA-Z][a-zA-Z0-9_-]*$').hasMatch(text) &&
      !{
        'true',
        'false',
        'null',
        'yes',
        'no',
        'on',
        'off',
      }.contains(text.toLowerCase())) {
    return text;
  }
  if (text.contains('\n') || text.contains('\r')) return jsonEncode(text);
  return "'${text.replaceAll("'", "''")}'";
}

String _editJson(String source, String key, Object? value) {
  final decoded = jsonDecode(source);
  if (decoded is! Map<String, dynamic>) _reject('config 不是 JSON 对象');
  // jsonDecode 验证语法，扫描器只负责记录顶层 token 边界（不重序列化其他字段）。
  final fields = <({String key, int start, int valueStart, int end})>[];
  var i = 1;
  void whitespace() {
    while (i < source.length && source[i].trim().isEmpty) {
      i++;
    }
  }

  int stringEnd(int start) {
    var j = start + 1;
    while (j < source.length) {
      if (source[j] == '\\') {
        j += 2;
        continue;
      }
      if (source[j++] == '"') return j;
    }
    _reject('JSON 字符串未闭合');
  }

  whitespace();
  while (source[i] != '}') {
    final start = i;
    final endKey = stringEnd(i);
    final name = jsonDecode(source.substring(i, endKey)) as String;
    if (fields.any((f) => f.key == name)) _reject('重复 JSON 字段 $name');
    i = endKey;
    whitespace();
    i++;
    whitespace();
    final valueStart = i;
    var depth = 0;
    while (i < source.length) {
      final c = source[i];
      if (c == '"') {
        i = stringEnd(i);
        continue;
      }
      if (depth == 0 && (c == ',' || c == '}')) break;
      if (c == '{' || c == '[') depth++;
      if (c == '}' || c == ']') depth--;
      i++;
    }
    var end = i;
    while (source[end - 1].trim().isEmpty) {
      end--;
    }
    fields.add((key: name, start: start, valueStart: valueStart, end: end));
    if (source[i] == ',') {
      i++;
      whitespace();
    } else {
      break;
    }
  }
  final index = fields.indexWhere((f) => f.key == key);
  if (index < 0) {
    if (value == null) return source;
    return source.replaceRange(
      i,
      i,
      '${fields.isEmpty ? '' : ', '}${jsonEncode(key)}: ${jsonEncode(value)}',
    );
  }
  final field = fields[index];
  if (value != null) {
    if (decoded[key] is Map || decoded[key] is List) _reject('$key 是手工嵌套字段');
    if (decoded[key] == value) return source;
    return source.replaceRange(field.valueStart, field.end, jsonEncode(value));
  }
  if (fields.length == 1) {
    return source.replaceRange(field.start, field.end, '');
  }
  if (index + 1 < fields.length) {
    return source.replaceRange(field.start, fields[index + 1].start, '');
  }
  return source.replaceRange(fields[index - 1].end, field.end, '');
}

/// 仅测试用：所有写测试必须指向临时目录。
String? debugProfileConfigFileOverride;
File _patchFile() => File(
  debugProfileConfigFileOverride ??
      '${_dshHome()}/profiles/ondra/cordis.patch.yml',
);

/// 内核实际使用的 DSH_HOME：优先 ONDRA_DSH_HOME（与传输层同一条规则，
/// alpha.10 审查第 13 项：自定义内核目录时设置写到了默认目录）。
String _dshHome() =>
    Platform.environment['ONDRA_DSH_HOME'] ?? '$ondraUserHome/.ondra/dsh';
