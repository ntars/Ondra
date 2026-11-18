import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import 'model_types.dart';

/// 模型基座的投影。规则与 DSH 的模型设置保持一致：
///
/// - 提供商 id 唯一、小写开头；
/// - 模型 id 非空、同一提供商内不重复；
/// - 容量写数字，可带 K / M 后缀；
/// - 内置提供商不可删；删除自建提供商时连密钥一起清掉；
/// - 默认模型若被删掉，回退到第一个可用模型。
class ModelClient extends ChangeNotifier {
  ModelClient() {
    _providers = [
      // 本机网关：Magpie（/Applications/magpie.app）监听 127.0.0.1:3425，
      // 一个端口转发多家模型（实测目录里 14 个，含 deepseek / glm / minimax / hy4）。
      // 它不校验密钥，但内核那边的 pi-ai 路由要求凭据非空，所以
      // apiKeyEnv 只是个占位引用——值由启动侧注入，配置文件里不出现密钥。
      OndraProvider(
        id: 'magpie',
        name: 'Magpie 本地网关',
        category: ProviderCategory.gateway,
        baseUrl: 'http://127.0.0.1:3425/v1',
        apiKeyEnv: 'MAGPIE_API_KEY',
        builtIn: true,
        models: [
          OndraModelEntry(
            id: 'group/ntars',
            contextWindow: '1M',
            maxTokens: '8K',
            reasoning: [OndraReasoningLevel.medium],
          ),
        ],
      ),
      OndraProvider(
        id: 'deepseek',
        name: 'DeepSeek',
        category: ProviderCategory.official,
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        builtIn: true,
        models: [
          OndraModelEntry(
            id: 'deepseek-chat',
            contextWindow: '128K',
            maxTokens: '8K',
            reasoning: [OndraReasoningLevel.medium],
          ),
          OndraModelEntry(
            id: 'deepseek-reasoner',
            contextWindow: '128K',
            maxTokens: '64K',
            reasoning: [
              OndraReasoningLevel.medium,
              OndraReasoningLevel.high,
            ],
          ),
        ],
      ),
    ];
    // 默认走本机网关：不填密钥、不联外网就能说话，先把链路跑通。
    _defaultProviderId = 'magpie';
    _defaultModelId = 'group/ntars';
  }

  late List<OndraProvider> _providers;
  late String _defaultModelId;

  /// 默认模型要连提供商一起记：同一份模型 id 可能同时出现在官方与免费两类里
  /// （免费版就是按官方目录精简的），只记 id 会让「当前」标错人。
  late String _defaultProviderId;

  List<OndraProvider> get providers => List.unmodifiable(_providers);
  String get defaultModelId => _defaultModelId;

  /// 默认模型所属的提供商 id。内核要同时知道这两样才能选路：
  /// `provider` 是路由名，`model` 是那家目录里的模型名。
  String get defaultProviderId => _defaultProviderId;

  /// 某一类下已经添加的提供商。列表按类分组，空类不显示。
  List<OndraProvider> byCategory(ProviderCategory category) =>
      _providers.where((p) => p.category == category).toList(growable: false);

  bool hasPreset(String presetId) => byId(presetId) != null;

  List<OndraModelEntry> get allModels => [
    for (final p in _providers)
      for (final m in p.models) m,
  ];

  /// 带提供商的模型清单，默认模型那一组用它。
  List<(OndraProvider, OndraModelEntry)> get allModelEntries => [
    for (final p in _providers)
      for (final m in p.models) (p, m),
  ];

  bool isDefault(OndraProvider p, OndraModelEntry m) =>
      p.id == _defaultProviderId && m.id == _defaultModelId;

  OndraProvider? byId(String id) {
    for (final p in _providers) {
      if (p.id == id) return p;
    }
    return null;
  }

  // ── 校验（错误文案照官方口径） ────────────────────────────────────────────

  static final _idPattern = RegExp(r'^[a-z][a-z0-9-]*$');

  static bool isValidProviderId(String id) => _idPattern.hasMatch(id);

  static bool isValidCapacity(String text) =>
      text.isEmpty || RegExp(r'^\d+(\.\d+)?[KkMm]?$').hasMatch(text);

  /// 返回 null 表示通过；否则返回该显示的错误。
  String? validateModel(OndraProvider p, OndraModelEntry m, {OndraModelEntry? self}) {
    if (m.id.trim().isEmpty) return '模型 ID 不能为空';
    final dup = p.models.where((e) => e.id == m.id && !identical(e, self ?? m)).isNotEmpty;
    if (dup) return '模型 ID 不能重复';
    if (!isValidCapacity(m.contextWindow)) return '上下文窗口必须是正数，例如 131072、256K 或 1M';
    if (!isValidCapacity(m.maxTokens)) return '最大输出 token 数必须是正数，例如 8192、64K 或 1M';
    return null;
  }

  // ── 提供商 ────────────────────────────────────────────────────────────────

  String? addProvider(OndraProvider provider) {
    if (!isValidProviderId(provider.id)) return '需以小写字母开头，之后可用小写字母、数字和短横线';
    if (byId(provider.id) != null) return '已有提供商使用了这个 ID';
    // 只有「自定义 API」必须当场有地址：其余五类都有预设，地址可以稍后在编辑器里补
    // （合作方与免费服务的地址本来就要用户填）。
    if (provider.category == ProviderCategory.custom && provider.baseUrl.trim().isEmpty) {
      return '自定义模型 API 需要填写 API 地址';
    }
    _providers = [..._providers, provider];
    _ensureDefault();
    notifyListeners();
    return null;
  }

  /// 从预设添加。返回错误文案，或 null 表示成功。
  String? addPreset(OndraProviderPreset preset) => addProvider(preset.toProvider());

  /// 探测到的模型合进来：只补缺的，不动用户已经改过的条目。
  ///
  /// 本地部署的模型目录不该由我们猜——端点说有哪几个，就是哪几个。
  int mergeDiscoveredModels(String providerId, List<String> ids) {
    final p = byId(providerId);
    if (p == null) return 0;
    var added = 0;
    for (final id in ids) {
      if (id.trim().isEmpty) continue;
      if (p.models.any((m) => m.id == id)) continue;
      p.models.add(OndraModelEntry(id: id));
      added++;
    }
    if (added > 0) {
      _ensureDefault();
      notifyListeners();
    }
    return added;
  }

  bool removeProvider(String id) {
    final p = byId(id);
    if (p == null || p.builtIn) return false;
    _providers = _providers.where((e) => e.id != id).toList();
    // 删除提供商＝连密钥一起清（官方文案：会移除其配置和存储的 API 密钥）。
    p.keyConfigured = false;
    _ensureDefault();
    notifyListeners();
    return true;
  }

  // ── 模型 ──────────────────────────────────────────────────────────────────

  OndraModelEntry addModel(String providerId, {String id = ''}) {
    final p = byId(providerId)!;
    final m = OndraModelEntry(id: id);
    p.models.add(m);
    notifyListeners();
    return m;
  }

  void removeModel(String providerId, OndraModelEntry model) {
    final p = byId(providerId);
    if (p == null) return;
    p.models.remove(model);
    _ensureDefault();
    notifyListeners();
  }

  /// 恢复默认模型目录（官方：恢复适配器自带的模型列表）。
  void restoreCatalog(String providerId, List<OndraModelEntry> catalog) {
    final p = byId(providerId);
    if (p == null) return;
    p.models
      ..clear()
      ..addAll(catalog);
    _ensureDefault();
    notifyListeners();
  }

  void setDefaultModel(OndraProvider provider, OndraModelEntry model) {
    if (_defaultProviderId == provider.id && _defaultModelId == model.id) return;
    _defaultProviderId = provider.id;
    _defaultModelId = model.id;
    notifyListeners();
  }

  void touch() => notifyListeners();

  void _ensureDefault() {
    final stillThere = _providers.any(
      (p) => p.id == _defaultProviderId && p.models.any((m) => m.id == _defaultModelId),
    );
    if (stillThere) return;
    final first = allModelEntries.isEmpty ? null : allModelEntries.first;
    _defaultProviderId = first?.$1.id ?? '';
    _defaultModelId = first?.$2.id ?? '';
  }
}

final ModelClient modelClient = ModelClient();
