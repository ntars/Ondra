/// 人设包的视图模型（Cordis 运行时里 `ondra-persona` 插件的输出投影）。
///
/// 字段**全部来自包里的文件**，不是 Dart 常量：`meta.json` 给名字、版本、
/// 人格关键词与触发词，`SKILL.md` 的一句话内核当 tagline。这样换包不需要改代码，
/// 也不会出现「代码里写一份、包里写一份，两边不同步」。
class OndraPersona {
  const OndraPersona({
    required this.id,
    required this.name,
    required this.displayName,
    required this.version,
    required this.tagline,
    required this.traits,
    required this.triggers,
    required this.assetDir,
    required this.builtIn,
  });

  /// 稳定 id，等于包的 slug（目录名）。
  final String id;

  /// 界面显示名，取 `meta.json` 的 `name`（哦鲸鲸）。
  final String name;

  /// 完整显示名（含别名）。
  final String displayName;

  final String version;

  /// 一句话内核，取 `SKILL.md` 的「> 一句话内核：」那一行。
  final String tagline;

  /// 人格关键词，取 `meta.json` 的 `profile.personality`。
  final List<String> traits;

  /// 触发词，取 `meta.json` 的 `trigger_words`。
  final List<String> triggers;

  /// 资产目录，`assets/personas/<slug>`。
  final String assetDir;

  /// 随应用分发（不能删，只能被别的包替换「当前」身份）。
  final bool builtIn;

  static const OndraPersona unknown = OndraPersona(
    id: 'unknown',
    name: '空谷',
    displayName: '空谷',
    version: '-',
    tagline: '',
    traits: [],
    triggers: [],
    assetDir: '',
    builtIn: true,
  );
}

/// 从 `meta.json` + `SKILL.md` 解析人设包。
///
/// 容错优先：缺字段用兜底值，缺 SKILL.md 就让 tagline 为空——一个字段不对
/// 不该让整个包加载失败，否则用户只会看到「导入失败」而不知道错在哪。
/// 真正硬性的是 `slug`：没有它，包在磁盘上就没有地址。
OndraPersona parsePersona({
  required Map<String, dynamic> meta,
  required String skillMarkdown,
  required String assetDir,
  required bool builtIn,
}) {
  final slug = (meta['slug'] as String?)?.trim();
  final id = (slug == null || slug.isEmpty) ? _basename(assetDir) : slug;
  final profile = meta['profile'];
  final personality = <String>[];
  if (profile is Map && profile['personality'] is List) {
    for (final t in profile['personality'] as List) {
      if (t is String && t.trim().isNotEmpty) personality.add(t.trim());
    }
  }
  final triggers = <String>[];
  for (final t in (meta['trigger_words'] as List?) ?? const []) {
    if (t is String && t.trim().isNotEmpty) triggers.add(t.trim());
  }
  final name = (meta['name'] as String?)?.trim();
  final display = (meta['display_name'] as String?)?.trim();

  return OndraPersona(
    id: id,
    name: (name == null || name.isEmpty) ? id : name,
    displayName: (display == null || display.isEmpty) ? (name ?? id) : display,
    version: (meta['version'] as String?)?.trim() ?? '-',
    tagline: _taglineOf(skillMarkdown),
    traits: personality,
    triggers: triggers,
    assetDir: assetDir,
    builtIn: builtIn,
  );
}

/// 从 SKILL.md 抽出「> 一句话内核：xxxx」。
///
/// 不做完整 Markdown 解析：只需要这一行，正则足够，也不会因为正文改版而失效。
String _taglineOf(String md) {
  final m = RegExp(r'一句话内核[：:]\s*(.+)').firstMatch(md);
  if (m == null) return '';
  var line = m.group(1)!.trim();
  // 去掉 **加粗** 与行尾的引用符号，tagline 要当纯文本显示。
  line = line.replaceAll('**', '').replaceAll(RegExp(r'\s*>$'), '').trim();
  return line;
}

String _basename(String path) {
  final i = path.lastIndexOf('/');
  return i < 0 ? path : path.substring(i + 1);
}
