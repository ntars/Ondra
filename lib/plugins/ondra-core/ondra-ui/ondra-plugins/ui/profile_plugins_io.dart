import 'dart:convert';
import 'dart:io';

import 'profile_plugins.dart';
import '../../../../../app/home_dir.dart';

/// 应用自己的 profile。与 `stdio_transport_io.dart` 里 `--profile ondra`
/// 必须一致——两处写死同一个名字是有意的：它是产品的一部分，不是配置项。
const String _profile = 'ondra';

File _patchFile() {
  final override = debugProfileFileOverride;
  if (override != null) return File(override);
  final home = ondraUserHome;
  return File('$home/.ondra/dsh/profiles/$_profile/cordis.patch.yml');
}

/// **仅测试用**：把装配层指到临时文件，免得测试改到真机上的 profile。
/// 生产代码永不赋值。
String? debugProfileFileOverride;

/// `- id: ondra-absence`
const String _idPrefix = '- id: ';

/// `# - id: ondra-absence`——被关掉的条目长这样，注释是**我们**加的。
const String _idPrefixOff = '# - id: ';

Future<List<ProfilePluginEntry>> readProfilePlugins() async {
  final file = _patchFile();
  if (!file.existsSync()) return const [];

  final List<String> lines;
  try {
    lines = await file.readAsLines();
  } catch (_) {
    return const [];
  }

  final out = <ProfilePluginEntry>[];
  for (var i = 0; i < lines.length; i++) {
    final t = lines[i].trim();
    final bool enabled;
    final String? id;
    if (t.startsWith(_idPrefix)) {
      id = t.substring(_idPrefix.length).trim();
      enabled = true;
    } else if (t.startsWith(_idPrefixOff)) {
      id = t.substring(_idPrefixOff.length).trim();
      enabled = false;
    } else {
      continue;
    }
    if (id.isEmpty) continue;

    final package = _packageAfter(lines, i + 1);
    if (package == null) continue;

    final meta = await _packageMeta(file.parent.path, package);
    out.add(
      ProfilePluginEntry(
        id: id,
        package: package,
        version: meta.$1,
        desc: meta.$2,
        enabled: enabled,
      ),
    );
  }
  return out;
}

/// 往下看一行取包名（`name: '...'` 或 `# name: '...'`）。
String? _packageAfter(List<String> lines, int from) {
  for (var j = from; j < lines.length && j <= from + 1; j++) {
    var t = lines[j].trim();
    if (t.startsWith('# ')) t = t.substring(2).trim();
    if (!t.startsWith('name:')) continue;
    var v = t.substring(5).trim();
    if (v.length >= 2 &&
        ((v.startsWith("'") && v.endsWith("'")) ||
            (v.startsWith('"') && v.endsWith('"')))) {
      v = v.substring(1, v.length - 1);
    }
    return v.isEmpty ? null : v;
  }
  return null;
}

/// 读 `node_modules/<包名>/package.json` 的版本与简介。
/// 读不到给 `('-', '')`：版本一栏是 `-`，简介留空——都表示「不知道」。
Future<(String, String)> _packageMeta(String root, String package) async {
  final file = File('$root/node_modules/$package/package.json');
  if (!file.existsSync()) return ('-', '');
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

Future<bool> setProfilePluginEnabled(String id, bool enabled) async {
  final file = _patchFile();
  if (!file.existsSync()) return false;

  final List<String> lines;
  try {
    lines = await file.readAsLines();
  } catch (_) {
    return false;
  }

  // 找这一条：想打开就找注释着的那行，想关掉就找生效着的那行。
  final prefix = enabled ? _idPrefixOff : _idPrefix;
  var hit = -1;
  for (var i = 0; i < lines.length; i++) {
    final t = lines[i].trim();
    if (t.startsWith(prefix) && t.substring(prefix.length).trim() == id) {
      hit = i;
      break;
    }
  }
  if (hit < 0) return false;

  final next = List<String>.from(lines);
  next[hit] = _flipComment(next[hit], enabled);
  // 紧随其后的 `name:` 行必须一起翻，否则装配层会留下孤儿行。
  for (var j = hit + 1; j < next.length && j <= hit + 1; j++) {
    final t = next[j].trim();
    final bare = t.startsWith('# ') ? t.substring(2).trim() : t;
    if (bare.startsWith('name:')) next[j] = _flipComment(next[j], enabled);
  }

  try {
    // 第一次改之前留一份原样：装配层是内核唯一入口，改坏了要有回头路。
    final backup = File('${file.path}.bak');
    if (!backup.existsSync()) await file.copy(backup.path);
    // 先写临时文件再改名：写到一半断电不会留下半截 YAML。
    final tmp = File('${file.path}.tmp');
    await tmp.writeAsString('${next.join('\n')}\n');
    await tmp.rename(file.path);
    return true;
  } catch (_) {
    return false;
  }
}

/// 把一行开头的 `# ` 加上或去掉，缩进原样保留。
String _flipComment(String line, bool enable) {
  var i = 0;
  while (i < line.length && (line[i] == ' ' || line[i] == '\t')) {
    i++;
  }
  final head = line.substring(0, i);
  final body = line.substring(i);
  if (enable) {
    return body.startsWith('# ') ? '$head${body.substring(2)}' : line;
  }
  return body.startsWith('# ') ? line : '$head# $body';
}
