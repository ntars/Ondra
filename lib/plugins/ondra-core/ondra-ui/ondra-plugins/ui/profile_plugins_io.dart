import 'dart:convert';
import 'dart:io';

import 'profile_plugins.dart';
import '../../../../../app/home_dir.dart';

const String _profile = 'ondra';

File _patchFile() => File(
  debugProfileFileOverride ??
      '${Platform.environment['ONDRA_DSH_HOME'] ?? '$ondraUserHome/.ondra/dsh'}/profiles/$_profile/cordis.patch.yml',
);

/// 仅测试用，所有写测试必须指到隔离目录。
String? debugProfileFileOverride;

// 每行连原有缩进/注释一起封装，恢复时只去这一层。不能把人的注释当作开关。
const _off = '# ondra-plugin-off: ';

class _Line {
  _Line(this.text, this.eol);
  final String text;
  final String eol;
  String get logical =>
      text.startsWith(_off) ? text.substring(_off.length) : text;
  bool get managed => text.startsWith(_off);
}

int _indent(String line) => line.length - line.trimLeft().length;
bool _comment(String line) => line.trimLeft().startsWith('#');
bool _empty(String line) => line.trim().isEmpty || _comment(line);

Never _unsupported(String reason) => throw FormatException('装配层无法安全编辑：$reason');

/// 只解析结构字段的单行标量。config 本身保持不透明，不尝试重写 YAML。
String _scalar(String text) {
  final value = text.trim();
  final quoted = RegExp(r'''^('(?:[^']|'')*'|"(?:[^"\\]|\\.)*")\s*(?:#.*)?$''')
      .firstMatch(value);
  if (quoted != null) {
    final token = quoted[1]!;
    if (token.startsWith("'")) {
      return token.substring(1, token.length - 1).replaceAll("''", "'");
    }
    try {
      return jsonDecode(token) as String;
    } catch (_) {
      _unsupported('结构字段使用了不支持的转义');
    }
  }
  final plain = value.split(RegExp(r'\s+#')).first.trim();
  if (plain.isEmpty || RegExp(r'''[\s\[\]{}&*!|>,'"]''').hasMatch(plain)) {
    _unsupported('结构字段不是受支持的单行标量');
  }
  return plain;
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
    this.package,
    this.start,
    this.end,
    this.enabled,
    this.dependencies,
    this.parents,
    this.blockedReason,
  );
  final String id;
  final String package;
  final int start;
  final int end;
  final bool enabled;
  final Set<String> dependencies;
  final List<_Entry> parents;
  final String? blockedReason;

  Set<String> get serviceNames => {
    id,
    package,
    if (package.startsWith('@ondra/cordis-plugin-'))
      package.substring('@ondra/cordis-plugin-'.length),
  };
}

/// 有意限定为 Cordis 的块式 patch：顶层 patch.insert -> 条目；只有
/// group: true 的 config 才递归为条目树。普通 config/models/items 永不遍历。
/// 不支持的结构拒绝写入，不能猜着改。保留每行原始换行与所有非目标字节。
class _Document {
  _Document(String source) {
    for (final m in RegExp(r'([^\r\n]*)(\r\n|\n|\r|$)').allMatches(source)) {
      if (m.group(0)!.isEmpty) continue;
      lines.add(_Line(m[1]!, m[2]!));
    }
    logical = lines.map((line) => line.logical).toList();
    _normalizeLegacy();
    for (final line in logical) {
      if (line.substring(0, _indent(line)).contains('\t')) {
        _unsupported('缩进包含制表符');
      }
    }
    _sequence(0, lines.length, 0, (start, end) {
      final fields = _fields(start, end, 0);
      final insert = fields['insert'];
      final managedFlow = logical
          .sublist(start, end)
          .any(
            (line) =>
                line.trim().startsWith('- {') &&
                jsonDecode(line.trim().substring(2)) is Map,
          );
      if (insert == null) {
        // 覆盖补丁可能改变最终 disabled/inject，不能仅改某个 insert 就声称成功。
        // 受管模型段会追加第二个 `- insert:`，里面是 JSON flow 条目；
        // 它不是插件开关，但要允许解析通过，否则整份 profile 不可管理。
        if (!managedFlow) {
          _unsupported('存在非 insert 覆盖补丁');
        }
      }
      if (insert == null) return;
      final value = insert.value.split('#').first.trim();
      if (value == '[]') return;
      if (value.isNotEmpty) _unsupported('insert 必须是块式列表');
      final child = _firstContent(insert.line + 1, insert.end);
      if (child == null) return;
      final indent = _indent(logical[child]);
      if (indent < 2) _unsupported('insert 列表缩进无效');
      _entries(insert.line + 1, insert.end, indent, const []);
    });
    final ids = <String>{};
    for (final entry in entries) {
      if (!ids.add(entry.id)) _unsupported('重复插件 id：${entry.id}');
    }
  }

  final lines = <_Line>[];
  late final List<String> logical;
  final legacy = <int>{};
  final entries = <_Entry>[];

  // 兼容仓库里的 `# - id` / `#   name`，以及旧 UI 的逐行 `# name`。
  // 这里只生成逻辑行；是否是插件仍由 insert/group 树判定。
  void _normalizeLegacy() {
    final header = RegExp(r'^( *)# - id:');
    for (var i = 0; i < logical.length; i++) {
      if (lines[i].managed) continue;
      final match = header.firstMatch(logical[i]);
      if (match == null) continue;
      final base = match[1]!;
      logical[i] = '$base${logical[i].substring(base.length + 2)}';
      legacy.add(i);
      for (var j = i + 1; j < logical.length; j++) {
        final line = logical[j];
        if (line.startsWith('$base#   ')) {
          logical[j] = '$base${line.substring(base.length + 2)}';
          legacy.add(j);
        } else if (_indent(line) > base.length &&
            line.trimLeft().startsWith('# name:')) {
          logical[j] = line.replaceFirst('# ', '');
          legacy.add(j);
        } else if (!_empty(line) && _indent(line) <= base.length) {
          break;
        } else if (header.hasMatch(line)) {
          break;
        }
      }
    }
  }

  int? _firstContent(int start, int end) {
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
    var i = _firstContent(start, end);
    while (i != null) {
      if (_indent(logical[i]) != indent ||
          !logical[i].substring(indent).startsWith('- ')) {
        _unsupported('第 ${i + 1} 行不是预期层级的条目');
      }
      var next = i + 1;
      while (next < end &&
          (_empty(logical[next]) || _indent(logical[next]) > indent)) {
        next++;
      }
      // 不把下一条前面的分节注释收入上一条；块内注释仍完整封装。
      var ownedEnd = next;
      while (ownedEnd > i + 1 && _empty(logical[ownedEnd - 1])) {
        ownedEnd--;
      }
      visit(i, ownedEnd);
      i = _firstContent(next, end);
    }
  }

  Map<String, _Field> _fields(int start, int end, int indent) {
    final result = <String, _Field>{};
    _Field? previous;
    for (var i = start; i < end; i++) {
      var text = logical[i];
      if (_empty(text)) continue;
      if (i == start) {
        text = text.substring(indent + 2);
      } else {
        final depth = _indent(text);
        if (depth > indent + 2) continue;
        if (depth != indent + 2) _unsupported('第 ${i + 1} 行字段缩进无效');
        text = text.substring(depth);
      }
      final m = RegExp(r'^([a-zA-Z][\w-]*):(?:\s+(.*))?$').firstMatch(text);
      if (m == null) {
        // 受管模型段会写整条 `- {"id":...,"name":...}` JSON flow map。
        // 它是合法 YAML 条目，但不是可开关的插件；跳过即可，保留原字节。
        if (text.startsWith('{') && jsonDecode(text) is Map) continue;
        _unsupported('第 ${i + 1} 行结构字段无法识别');
      }
      final key = m[1]!;
      if (result.containsKey(key)) _unsupported('重复字段：$key');
      previous?.end = i;
      result[key] = previous = _Field(i, end, m[2] ?? '');
    }
    return result;
  }

  Set<String> _dependencies(_Field? field) {
    if (field == null) return {};
    final value = field.value.split(RegExp(r'\s+#')).first.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      final body = value.substring(1, value.length - 1).trim();
      return body.isEmpty ? {} : body.split(',').map(_scalar).toSet();
    }
    if (value.isNotEmpty && !value.startsWith('#')) {
      _unsupported('inject 必须是块式列表/映射或单行列表');
    }
    final first = _firstContent(field.line + 1, field.end);
    if (first == null) return {};
    final indent = _indent(logical[first]);
    final result = <String>{};
    for (var i = first; i < field.end; i++) {
      final text = logical[i];
      if (_empty(text)) continue;
      if (_indent(text) < indent) _unsupported('inject 缩进无效');
      if (_indent(text) > indent) continue;
      final bare = text.trim();
      if (bare.startsWith('- ')) {
        result.add(_scalar(bare.substring(2)));
      } else {
        final m = RegExp(r'^([^:]+):(?:\s.*)?$').firstMatch(bare);
        if (m == null) _unsupported('inject 映射无法识别');
        // optional 依赖同样保守保护，避免禁用后静默降级。
        result.add(_scalar(m[1]!));
      }
    }
    return result;
  }

  void _entries(int start, int end, int indent, List<_Entry> parents) {
    _sequence(start, end, indent, (start, end) {
      final fields = _fields(start, end, indent);
      if (!fields.containsKey('id')) _unsupported('条目缺少 id');
      final id = _scalar(fields['id']!.value);
      final group =
          fields['group'] != null && _scalar(fields['group']!.value) == 'true';
      final package = fields['name'] == null
          ? ''
          : _scalar(fields['name']!.value);
      if (package.isEmpty && !group) _unsupported('$id 缺少包名');
      final commented = lines[start].managed || legacy.contains(start);
      if (commented) {
        for (var i = start; i < end; i++) {
          if (!_empty(logical[i]) && !lines[i].managed && !legacy.contains(i)) {
            _unsupported('$id 只注释了部分条目，请先修复遗留的子块');
          }
        }
      }
      final disabled =
          fields['disabled'] != null &&
          _scalar(fields['disabled']!.value) != 'false';
      // 注释一个锚点会使其他条目的 YAML 别名失效；未引入通用 YAML 解析器时
      // 宁可只读，也不能猜引用边界（字符串中的同形文本也保守锁定）。
      final hasReferences = logical
          .sublist(start, end)
          .any(
            (line) =>
                !_empty(line) &&
                RegExp(r'(^|[\s\[{:,&])[&*][\w-]+').hasMatch(line),
          );
      final reason =
          profilePluginProtection(id, package) ??
          (hasReferences ? '含 YAML 锚点或别名，请在装配层管理' : null) ??
          (group ? '插件组不在此整体启停' : null) ??
          (fields.containsKey('disabled') ? '含 disabled 字段，请在装配层管理' : null) ??
          (parents.any((p) => !p.enabled) ? '父插件组未启用' : null);
      final entry = _Entry(
        id,
        package,
        start,
        end,
        !commented && !disabled && parents.every((p) => p.enabled),
        _dependencies(fields['inject']),
        parents,
        reason,
      );
      entries.add(entry);
      if (group && fields['config'] != null) {
        final config = fields['config']!;
        final value = config.value.split('#').first.trim();
        if (value == '[]') return;
        if (value.isNotEmpty) _unsupported('插件组 config 必须是块式列表');
        final child = _firstContent(config.line + 1, config.end);
        if (child != null) {
          _entries(config.line + 1, config.end, _indent(logical[child]), [
            ...parents,
            entry,
          ]);
        }
      }
    });
  }

  String toggle(_Entry entry, bool enabled) => [
    for (var i = 0; i < lines.length; i++)
      if (i >= entry.start && i < entry.end)
        '${enabled ? logical[i] : '$_off${lines[i].text}'}${lines[i].eol}'
      else
        '${lines[i].text}${lines[i].eol}',
  ].join();
}

Future<List<ProfilePluginEntry>> readProfilePlugins() async {
  final file = _patchFile();
  if (!file.existsSync()) return const [];
  final document = _Document(await file.readAsString());
  final out = <ProfilePluginEntry>[];
  for (final entry in document.entries) {
    final meta = await _packageMeta(file.parent.path, entry.package);
    out.add(
      ProfilePluginEntry(
        id: entry.id,
        package: entry.package,
        version: meta.$1,
        desc: meta.$2,
        enabled: entry.enabled,
        blockedReason: entry.blockedReason,
      ),
    );
  }
  return out;
}

Future<(String, String)> _packageMeta(String root, String package) async {
  // 不允许装配内容通过包名跳出 node_modules。
  if (!RegExp(r'^(?:@[\w.-]+/)?[\w.-]+$').hasMatch(package) ||
      package == '.' ||
      package == '..') {
    return ('-', '');
  }
  final file = File('$root/node_modules/$package/package.json');
  try {
    final json = jsonDecode(await file.readAsString());
    if (json is! Map) return ('-', '');
    final version = (json['version'] as String?)?.trim();
    final desc = (json['description'] as String?)?.trim();
    return ((version?.isEmpty ?? true) ? '-' : version!, desc ?? '');
  } catch (_) {
    return ('-', '');
  }
}

// 串行化本模块的写入，避免两个开关同时覆盖。设置页/外部编辑另做内容比对。
Future<void> _pendingWrite = Future.value();
Future<ProfilePluginWriteResult> updateProfilePluginEnabled(
  String id,
  bool enabled,
) {
  final file = _patchFile();
  final result = _pendingWrite.then((_) => _update(file, id, enabled));
  _pendingWrite = result.then((_) {});
  return result;
}

Future<ProfilePluginWriteResult> _update(
  File file,
  String id,
  bool enabled,
) async {
  Directory? scratch;
  try {
    final source = await file.readAsString();
    final doc = _Document(source);
    final matches = doc.entries.where((e) => e.id == id);
    if (matches.isEmpty) return ProfilePluginWriteResult.failure('未找到插件：$id');
    final entry = matches.single;
    if (entry.blockedReason != null) {
      return ProfilePluginWriteResult.failure('$id：${entry.blockedReason}');
    }
    if (entry.enabled == enabled) {
      return const ProfilePluginWriteResult.success();
    }
    if (!enabled) {
      final dependents = doc.entries
          .where(
            (other) =>
                other.enabled &&
                other.id != id &&
                other.dependencies.any(entry.serviceNames.contains),
          )
          .map((e) => e.id)
          .toList();
      if (dependents.isNotEmpty) {
        return ProfilePluginWriteResult.failure(
          '拒绝关闭 $id：已启用的 ${dependents.join('、')} 依赖它，请先关闭下游插件',
        );
      }
    } else {
      final dependencies = {
        ...entry.dependencies,
        for (final parent in entry.parents) ...parent.dependencies,
      };
      final missing = doc.entries
          .where(
            (other) =>
                !other.enabled && other.serviceNames.any(dependencies.contains),
          )
          .map((e) => e.id)
          .toList();
      if (missing.isNotEmpty) {
        return ProfilePluginWriteResult.failure(
          '拒绝启用 $id：请先启用依赖 ${missing.join('、')}',
        );
      }
    }
    final next = doc.toggle(entry, enabled);
    _Document(next); // 写前验证逻辑树仍可读取，不留下孤儿字段。
    final backup = File('${file.path}.bak');
    if (!backup.existsSync()) await backup.writeAsString(source, flush: true);
    scratch = await file.parent.createTemp('.ondra-plugin-write-');
    final tmp = File('${scratch.path}/patch');
    await tmp.writeAsString(next, flush: true);
    // 最后一段同步执行，避免本进程设置页在检查与 rename 之间插入写操作。
    if (file.readAsStringSync() != source) {
      return const ProfilePluginWriteResult.failure('装配层已被其他操作修改，请刷新后重试');
    }
    tmp.renameSync(file.path);
    return const ProfilePluginWriteResult.success();
  } catch (e) {
    return ProfilePluginWriteResult.failure('装配层保存失败：$e');
  } finally {
    try {
      scratch?.deleteSync(recursive: true);
    } catch (_) {
      // 目标已经原子提交；临时目录清理失败不能把成功报告成失败。
    }
  }
}
