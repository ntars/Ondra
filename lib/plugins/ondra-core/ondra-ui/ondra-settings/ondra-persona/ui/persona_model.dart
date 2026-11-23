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
    String? slug,
  }) : slug = slug ?? id;

  /// 内核 meta.js resolveId 的结果，可能不同于磁盘目录名。
  final String id;

  /// 原目录名；导出/删除必须使用它而不是内核 id。
  final String slug;

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
/// 元数据、稳定标识与非空 SKILL.md 都是入口约束；资产包与用户包同样校验。
OndraPersona parsePersona({
  required Map<String, dynamic> meta,
  required String skillMarkdown,
  required String assetDir,
  required bool builtIn,
  String? storageSlug,
}) {
  if (meta.isEmpty || skillMarkdown.trim().isEmpty) {
    throw const FormatException('meta.json 与 SKILL.md 必须非空。');
  }
  for (final key in ['slug', 'name', 'display_name', 'version']) {
    if (meta[key] != null && meta[key] is! String) {
      throw FormatException('meta.$key 应为字符串。');
    }
  }
  final declaredSlug = (meta['slug'] as String?)?.trim();
  if (declaredSlug != null &&
      declaredSlug.isNotEmpty &&
      !isSafePersonaSlug(declaredSlug)) {
    throw const FormatException('meta.slug 不是安全目录名。');
  }
  final slug =
      storageSlug ??
      ((declaredSlug?.isNotEmpty ?? false)
          ? declaredSlug!
          : personaBasename(assetDir));
  if (!isSafePersonaSlug(slug)) {
    throw const FormatException('人设目录名不合法。');
  }
  final id = resolvePersonaId(meta, slug);
  if (id == null) throw const FormatException('算不出合法的内核人设 ID。');
  final profile = meta['profile'];
  final personality = <String>[];
  if (profile is Map && profile['personality'] is List) {
    for (final t in profile['personality'] as List) {
      if (t is String && t.trim().isNotEmpty) personality.add(t.trim());
    }
  }
  final triggers = <String>[];
  for (final t
      in meta['trigger_words'] is List
          ? meta['trigger_words'] as List
          : const []) {
    if (t is String && t.trim().isNotEmpty) triggers.add(t.trim());
  }
  final name = (meta['name'] as String?)?.trim();
  final display = (meta['display_name'] as String?)?.trim();

  return OndraPersona(
    id: id,
    slug: slug,
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

/// 保留历史目录名（含大写、点），但拒绝隐藏目录、穿越与过长名字。
bool isSafePersonaSlug(String slug) =>
    RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$').hasMatch(slug) &&
    !slug.contains('..') &&
    !slug.endsWith('.');

/// 与内核 loader/lib/meta.js resolveId / toIdCandidate 保持一致。
String? resolvePersonaId(Map<String, dynamic> meta, String archiveStem) {
  var fallback = archiveStem
      .toLowerCase()
      .replaceAll(RegExp(r'[^a-z0-9_-]+'), '-')
      .replaceAll(RegExp(r'-{2,}'), '-')
      .replaceAll(RegExp(r'^[-_]+|[-_]+$'), '');
  if (fallback.length > 64) fallback = fallback.substring(0, 64);
  for (final candidate in [meta['slug'], meta['name'], fallback]) {
    if (candidate is! String) continue;
    final id = candidate.trim().toLowerCase();
    if (RegExp(r'^[a-z][a-z0-9_-]{1,63}$').hasMatch(id)) return id;
  }
  return null;
}

/// 路径最后一级。Windows 的 `Directory.listSync()` 返回反斜杠路径，
/// 只按 `/` 切会把整条绝对路径当成目录名（alpha.15 审查：自定义人设
/// 装好后枚举为空、重新选择时报「没有这个人设包」）。这里两种分隔符都认。
String personaBasename(String path) {
  final normalized = path.replaceAll(r'\', '/');
  final i = normalized.lastIndexOf('/');
  return i < 0 ? normalized : normalized.substring(i + 1);
}
