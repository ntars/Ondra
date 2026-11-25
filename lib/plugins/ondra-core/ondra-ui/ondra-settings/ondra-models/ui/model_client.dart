import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import '../../../../../../app/home_dir.dart';
import '../../../../../../app/keychain.dart';
import '../../../../../../app/platform_env.dart';
import 'model_types.dart';
import 'runtime_model_config.dart';

/// 模型基座的投影。规则与 DSH 的模型设置保持一致：
///
/// - 提供商 id 唯一、小写开头；
/// - 模型 id 非空、同一提供商内不重复；
/// - 容量写数字，可带 K / M 后缀；
/// - 内置提供商不可删；删除自建提供商时连密钥一起清掉；
/// - 默认模型若被删掉，回退到第一个可用模型。
class ModelClient extends ChangeNotifier {
  ModelClient({
    String? storePath,
    Future<String?> Function(String)? secretResolver,
    Future<KeychainSecret> Function(String, String)? secretWriter,
    // ignore: prefer_initializing_formals, 对外参数名保持 storePath，私有字段不能当命名参数
  }) : _storePath = storePath,
       _secretResolver = secretResolver ?? ((ref) => Keychain.read(ref)),
       _secretWriter =
           secretWriter ?? ((ref, key) => Keychain.write(ref, key)) {
    _providers = [
      // 网关地址：本机 Magpie 默认监听 127.0.0.1:3425；虚拟机的共享网络地址
      // 由启动侧通过 ONDRA_MAGPIE_BASE_URL 指向宿主机可达的端口转发。
      // 一个端口转发多家模型（实测目录里 14 个，含 deepseek / glm / minimax / hy4）。
      // 它不校验密钥，但内核那边的 pi-ai 路由要求凭据非空，所以
      // apiKeyEnv 只是个占位引用——值由启动侧注入，配置文件里不出现密钥。
      OndraProvider(
        id: 'magpie',
        name: 'Magpie 本地网关',
        category: ProviderCategory.gateway,
        // 127.0.0.1 只在运行 Magpie 的宿主机上成立。若应用运行在虚拟机或
        // 容器里，应通过 ONDRA_MAGPIE_BASE_URL 指向宿主机可达的网关地址。
        // 已有 models.json 时仍保留用户配置，不被环境变量覆盖。
        baseUrl:
            ondraPlatformEnv('ONDRA_MAGPIE_BASE_URL') ??
            'http://127.0.0.1:3425/v1',
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
            reasoning: [OndraReasoningLevel.medium, OndraReasoningLevel.high],
          ),
        ],
      ),
    ];
    // 默认走本机网关：不填密钥、不联外网就能说话，先把链路跑通。
    _defaultProviderId = 'magpie';
    _defaultModelId = 'group/ntars';
    // 每一次改动都落盘：模型基座不是「本次会话」的东西，重启后必须还在。
    // persist 幂等，多挂几次 notify 也不会写乱。
    addListener(_persist);
  }

  // ── 持久化 ────────────────────────────────────────────────────────────────
  //
  // 存 `~/.ondra/models.json`，不进 prefs.json：它是一段结构化配置而不是
  // 少量开关，独立成文件才能直接拿编辑器改、也才能在备份里单独带走。
  //
  // **密钥不在文件里**——`keyConfigured` 只是从钥匙串回读出来的状态。
  // 文件里写密钥等于把「只存在本机」写成「以明文存在本机」。

  final String? _storePath;
  final Future<String?> Function(String) _secretResolver;
  final Future<KeychainSecret> Function(String, String) _secretWriter;
  final Map<String, int> _keyRevisions = {};
  String? persistenceError;

  /// UI 可监听这些状态，并用 applyPendingRuntime() 显式重连。
  /// 忙碌时只标记待应用，不中断生成；主装配层在空闲后自动应用。
  bool runtimePending = false;
  bool runtimeApplying = false;
  String? runtimeApplyError;
  Future<void> Function()? runtimeReconnect;

  Future<void> applyPendingRuntime() async => await runtimeReconnect?.call();

  void reportRuntimeState({
    required bool pending,
    required bool applying,
    String? error,
  }) {
    if (runtimePending == pending &&
        runtimeApplying == applying &&
        runtimeApplyError == error) {
      return;
    }
    runtimePending = pending;
    runtimeApplying = applying;
    runtimeApplyError = error;
    notifyListeners();
  }

  /// 当前默认模型的运行时配置。选了什么就用什么——**不做任何自动回退**
  /// （与 DeepSeek Harness 官方一致：密钥状态只是 UI 状态，缺密钥不换
  /// 模型、不拦内核，发消息那一刻由内核如实报错）。配置解析失败时
  /// transport 会跳过模型段照常启动内核，错误显示在聊天栏。
  RuntimeModelConfig currentRuntimeConfig() {
    final p = byId(defaultProviderId);
    final m = p?.models.where((m) => m.id == defaultModelId).firstOrNull;
    if (p == null || m == null) throw StateError('请先选择有效的默认模型');
    return RuntimeModelConfig.from(p, m);
  }

  /// 不含 secret；替换已配置密钥也增加 revision，不能只看 keyConfigured。
  String get runtimeFingerprint {
    final p = byId(defaultProviderId);
    return jsonEncode({
      'provider': p == null ? null : _providerToJson(p),
      'model': defaultModelId,
      'keyRevision': _keyRevisions[defaultProviderId] ?? 0,
    });
  }

  File get _storeFile =>
      File(_storePath ?? '$ondraUserHome/.ondra/models.json');

  /// 启动时读回上一次的模型基座。文件坏了就当没存过，回到内置默认。
  ///
  /// 密钥状态另查：钥匙串是异步的，回读完成后单独通知一次。
  void load() {
    try {
      final f = _storeFile;
      if (!f.existsSync()) return;
      final raw = jsonDecode(f.readAsStringSync());
      if (raw is! Map) return;
      final list = raw['providers'];
      if (list is! List) return;
      final loaded = <OndraProvider>[];
      for (final item in list) {
        if (item is! Map) continue;
        final p = _providerFromJson(item);
        if (p != null) loaded.add(p);
      }
      if (loaded.isEmpty) return;
      _providers = loaded;
      final dp = '${raw['defaultProviderId'] ?? ''}';
      final dm = '${raw['defaultModelId'] ?? ''}';
      if (dp.isNotEmpty && dm.isNotEmpty) {
        _defaultProviderId = dp;
        _defaultModelId = dm;
      }
      _ensureDefault();
      // 旧版本允许把没有密钥的远端模型设为默认，结果内核照常启动、
      // 聊天栏却发不出一句。这里做一次性迁移：用户没配密钥时回到随包
      // 本机网关；用户已配密钥则保留原选择。迁移结果立即写回，界面与
      // 下次启动都会看到同一个事实。
      final selected = byId(_defaultProviderId);
      if (selected != null &&
          selected.category != ProviderCategory.gateway &&
          selected.category != ProviderCategory.local &&
          selected.apiKeyEnv.isNotEmpty &&
          (selected.keyConfigured ||
              (ondraPlatformEnv(selected.apiKeyEnv) ?? '').trim().isNotEmpty) ==
              false) {
        final gateway = byId('magpie');
        final model = gateway?.models.firstOrNull;
        if (gateway != null && model != null) {
          _defaultProviderId = gateway.id;
          _defaultModelId = model.id;
          _persist();
        }
      }
      notifyListeners();
      _refreshKeyStates();
    } catch (_) {
      // 文件坏了不拦启动：内置默认还能说话。
    }
  }

  /// 钥匙串是异步的：启动后逐个回读「密钥在不在」，回来再刷一次界面。
  /// 支持不了钥匙串的机器永远得到 false——那是实情，不编一个 true。
  void _refreshKeyStates() {
    for (final p in _providers) {
      if (p.category == ProviderCategory.local ||
          p.category == ProviderCategory.gateway) {
        continue; // 本地与网关不校验密钥，状态恒为「不需要」。
      }
      unawaited(
        Keychain.exists(credentialRefOf(p)).then((ok) {
          if (p.keyConfigured == ok) return;
          p.keyConfigured = ok;
          notifyListeners();
        }),
      );
    }
  }

  void _persist() {
    try {
      _storeFile.parent.createSync(recursive: true);
      _storeFile.writeAsStringSync(
        const JsonEncoder.withIndent('  ').convert({
          'version': 1,
          'defaultProviderId': _defaultProviderId,
          'defaultModelId': _defaultModelId,
          'providers': [for (final p in _providers) _providerToJson(p)],
        }),
      );
      persistenceError = null;
    } catch (error) {
      persistenceError = '模型配置未保存：$error';
    }
  }

  /// 密钥在 `.credentials.yaml` 里的**引用名**，与内核同源。
  ///
  /// 内核侧 `llm-pi-ai` 是按 `provider.apiKeyEnv` 去 `ctx.credentials.resolve(ref)`
  /// 找密钥的，而官方 `dsh-credentials-local` 只接受 POSIX 标识符
  /// （`REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`）。这里以前用
  /// `provider.<id>.key`（含点号）当引用名，两个后果同时成立：
  ///
  /// 1. 官方解析器读到含点号的键会直接抛 TypeError，整份凭据文件被拒；
  /// 2. 即便写得进去，内核按 `apiKeyEnv` 找的是另一个名字，永远读不到。
  ///
  /// 所以引用名必须就是 `apiKeyEnv`——一处命名，两边都认。空 `apiKeyEnv`
  /// 时按 `RuntimeModelConfig` 的同一条规则兜底，保证写与读用同一个名字。
  static String credentialRefOf(OndraProvider p) => p.apiKeyEnv.isEmpty
      ? 'ONDRA_UI_${p.id.replaceAll('-', '_').toUpperCase()}_API_KEY'
      : p.apiKeyEnv;

  /// 按提供商 id 取引用名；提供商已不存在时返回 null（不凭空造名字）。
  String? _refOf(String providerId) {
    final p = byId(providerId);
    return p == null ? null : credentialRefOf(p);
  }

  /// 旧的键名（`provider.<id>.key`）。只用于一次性迁移：
  /// 老版本把密钥存在这个名下，改成 apiKeyEnv 之后要能读回旧值。
  static String legacyKeyName(String providerId) => 'provider.$providerId.key';

  Map<String, dynamic> _providerToJson(OndraProvider p) => {
    'id': p.id,
    'name': p.name,
    'category': p.category.name,
    'baseUrl': p.baseUrl,
    'apiKeyEnv': p.apiKeyEnv,
    'protocol': p.protocol,
    'builtIn': p.builtIn,
    'launchHint': p.launchHint,
    'models': [
      for (final m in p.models)
        {
          'id': m.id,
          'name': m.name,
          'contextWindow': m.contextWindow,
          'maxTokens': m.maxTokens,
          'inputs': m.inputs,
          'reasoning': [
            for (final r in m.reasoning)
              {'label': r.label, 'apiValue': r.apiValue, 'level': r.level},
          ],
        },
    ],
  };

  OndraProvider? _providerFromJson(Map item) {
    final categoryName = '${item['category']}';
    final category = ProviderCategory.values
        .where((c) => c.name == categoryName)
        .firstOrNull;
    if (category == null) return null;
    final p = OndraProvider(
      id: '${item['id'] ?? ''}',
      name: '${item['name'] ?? ''}',
      category: category,
      baseUrl: '${item['baseUrl'] ?? ''}',
      apiKeyEnv: '${item['apiKeyEnv'] ?? ''}',
      protocol: item['protocol'] as String?,
      builtIn: item['builtIn'] == true,
      launchHint: '${item['launchHint'] ?? ''}',
    );
    final models = item['models'];
    if (models is List) {
      for (final m in models) {
        if (m is! Map) continue;
        final entry = OndraModelEntry(
          id: '${m['id'] ?? ''}',
          name: '${m['name'] ?? ''}',
          contextWindow: '${m['contextWindow'] ?? ''}',
          maxTokens: '${m['maxTokens'] ?? ''}',
          inputs: (m['inputs'] as List?)?.cast<String>().toList() ?? ['text'],
        );
        final reasoning = m['reasoning'];
        if (reasoning is List) {
          for (final r in reasoning) {
            if (r is! Map) continue;
            final apiValue = '${r['apiValue'] ?? ''}';
            entry.reasoning.add(
              OndraReasoningLevel(
                label: '${r['label'] ?? apiValue}',
                apiValue: apiValue,
                level: r['level'] as String?,
              ),
            );
          }
        }
        p.models.add(entry);
      }
    }
    return p.id.isEmpty ? null : p;
  }

  /// 把某个提供商的密钥写进钥匙串。返回错误文案，null 表示成功。
  ///
  /// UI 的「填写 / 更换」与自定义表单都走这一个入口；`keyConfigured` 由
  /// 写入结果驱动，不靠界面自己置位。
  ///
  /// 引用名取自 `apiKeyEnv`（见 [credentialRefOf]）：内核按同一个名字解析，
  /// 存进去才算真的存进去。
  Future<String?> writeProviderKey(String providerId, String key) async {
    final ref = _refOf(providerId);
    if (ref == null) return '提供商不存在';
    final r = await _secretWriter(ref, key);
    if (!r.ok) return r.message;
    final p = byId(providerId);
    if (p != null) {
      p.keyConfigured = key.isNotEmpty;
      _keyRevisions[providerId] = (_keyRevisions[providerId] ?? 0) + 1;
      // 新名字写成功了，就把老名字下的旧值清掉：留着等于同一把密钥
      // 在文件里存两份，改一处另一处还是旧的（而且旧名官方读不了）。
      if (key.isNotEmpty) {
        final legacy = legacyKeyName(providerId);
        if (legacy != ref) unawaited(Keychain.erase(legacy));
      }
      notifyListeners();
    }
    return null;
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

  /// 所有兼容类别都使用应用独立路由；只有地址和模型有效才允许注册。
  String? kernelRouteOf(OndraProvider p) {
    for (final m in p.models) {
      try {
        return RuntimeModelConfig.from(p, m).route;
      } on FormatException {
        continue;
      }
    }
    return null;
  }

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

  static bool isValidCapacity(String text) {
    if (text.isEmpty) return true;
    try {
      RuntimeModelConfig.capacity(text);
      return true;
    } on FormatException {
      return false;
    }
  }

  static bool isValidBaseUrl(String value) {
    final uri = Uri.tryParse(value.trim());
    return uri != null &&
        (uri.scheme == 'http' || uri.scheme == 'https') &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty &&
        !uri.hasQuery &&
        !uri.hasFragment;
  }

  /// 返回 null 表示通过；否则返回该显示的错误。
  String? validateModel(
    OndraProvider p,
    OndraModelEntry m, {
    OndraModelEntry? self,
  }) {
    if (m.id.trim().isEmpty) return '模型 ID 不能为空';
    final dup = p.models
        .where((e) => e.id == m.id && !identical(e, self ?? m))
        .isNotEmpty;
    if (dup) return '模型 ID 不能重复';
    if (!isValidCapacity(m.contextWindow)) {
      return '上下文窗口必须是正数，例如 131072、256K 或 1M';
    }
    if (!isValidCapacity(m.maxTokens)) {
      return '最大输出 token 数必须是正数，例如 8192、64K 或 1M';
    }
    try {
      RuntimeModelConfig.validateModel(m);
    } on FormatException catch (error) {
      return error.message;
    }
    return null;
  }

  // ── 提供商 ────────────────────────────────────────────────────────────────

  String? validateProvider(OndraProvider provider) {
    if (!isValidProviderId(provider.id)) return '需以小写字母开头，之后可用小写字母、数字和短横线';
    if (byId(provider.id) != null) return '已有提供商使用了这个 ID';
    if (provider.baseUrl.isNotEmpty && !isValidBaseUrl(provider.baseUrl)) {
      return 'API 地址必须是有效的 HTTP(S) 地址，不能包含凭据、查询或片段';
    }
    for (final model in provider.models) {
      final error = validateModel(provider, model);
      if (error != null) return error;
    }
    return null;
  }

  String? addProvider(OndraProvider provider) {
    final error = validateProvider(provider);
    if (error != null) return error;
    // 只有「自定义 API」必须当场有地址：其余五类都有预设，地址可以稍后在编辑器里补
    // （合作方与免费服务的地址本来就要用户填）。
    if (provider.category == ProviderCategory.custom &&
        provider.baseUrl.trim().isEmpty) {
      return '自定义模型 API 需要填写 API 地址';
    }
    _providers = [..._providers, provider];
    _ensureDefault();
    notifyListeners();
    return null;
  }

  /// 从预设添加。返回错误文案，或 null 表示成功。
  String? addPreset(OndraProviderPreset preset) =>
      addProvider(preset.toProvider());

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

  Future<String?> removeProvider(String id) async {
    final p = byId(id);
    if (p == null || p.builtIn) return '内置提供商不能删除';
    final ref = credentialRefOf(p);
    final legacy = legacyKeyName(id);
    if (p.keyConfigured || await Keychain.exists(ref)) {
      if (!await Keychain.erase(ref)) return '密钥删除失败，已保留提供商';
    }
    // 老名字下的残留一并清掉，否则删了提供商、密钥还留在文件里。
    if (legacy != ref && await Keychain.exists(legacy)) {
      await Keychain.erase(legacy);
    }
    _providers = _providers.where((e) => e.id != id).toList();
    p.keyConfigured = false;
    _ensureDefault();
    notifyListeners();
    return persistenceError;
  }

  Future<String?> readProviderKey(String id) async {
    final p = byId(id);
    return await readProviderSecret(id) ??
        (p == null || p.apiKeyEnv.isEmpty
            ? null
            : ondraPlatformEnv(p.apiKeyEnv));
  }

  /// 读密钥。先按 `apiKeyEnv` 读；读不到再试老键名（`provider.<id>.key`），
  /// 命中就顺手搬过来并删掉旧条目——老版本存下的密钥不该因为改了命名就失效。
  ///
  /// 注入的 `_secretResolver` 收到的是**引用名**（`apiKeyEnv`），与默认实现
  /// `Keychain.read` 的语义一致；这里按 id 解析出引用名再问它。
  Future<String?> readProviderSecret(String id) async {
    final p = byId(id);
    if (p == null) return null;
    final ref = credentialRefOf(p);
    final hit = await _secretResolver(ref);
    if (hit != null && hit.isNotEmpty) return hit;
    final legacy = legacyKeyName(id);
    if (legacy == ref) return null;
    final old = await Keychain.readLegacy(legacy);
    if (old == null || old.isEmpty) return null;
    final migrated = await _secretWriter(ref, old);
    if (migrated.ok) await Keychain.erase(legacy);
    return old;
  }

  String? updateProviderProtocol(String id, String protocol) {
    if (!RuntimeModelConfig.protocols.contains(protocol)) return '不支持的 API 协议';
    final p = byId(id);
    if (p == null) return '提供商不存在';
    p.protocol = protocol;
    notifyListeners();
    return persistenceError;
  }

  String? updateProviderAddress(String id, String value) {
    if (!isValidBaseUrl(value)) return '请输入有效的 HTTP(S) API 地址';
    final p = byId(id);
    if (p == null) return '提供商不存在';
    p.baseUrl = value.trim();
    notifyListeners();
    return persistenceError;
  }

  // ── 模型 ──────────────────────────────────────────────────────────────────

  String? addModel(String providerId, {required String id}) {
    final p = byId(providerId);
    if (p == null) return '提供商不存在';
    final m = OndraModelEntry(id: id.trim());
    final error = validateModel(p, m);
    if (error != null) return error;
    p.models.add(m);
    _ensureDefault();
    notifyListeners();
    return persistenceError;
  }

  String? updateModel(
    String providerId,
    OndraModelEntry model, {
    String? id,
    String? name,
    String? contextWindow,
    String? maxTokens,
    List<String>? inputs,
    List<OndraReasoningLevel>? reasoning,
  }) {
    final p = byId(providerId);
    if (p == null || !p.models.contains(model)) return '模型不存在';
    final next = OndraModelEntry(
      id: id?.trim() ?? model.id,
      name: name ?? model.name,
      contextWindow: contextWindow ?? model.contextWindow,
      maxTokens: maxTokens ?? model.maxTokens,
      inputs: inputs ?? model.inputs,
      reasoning: reasoning ?? model.reasoning,
    );
    final error = validateModel(p, next, self: model);
    if (error != null) return error;
    if (isDefault(p, model)) _defaultModelId = next.id;
    model
      ..id = next.id
      ..name = next.name
      ..contextWindow = next.contextWindow
      ..maxTokens = next.maxTokens
      ..inputs = List.of(next.inputs)
      ..reasoning = List.of(next.reasoning);
    notifyListeners();
    return persistenceError;
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

  /// 「设为默认」被拒绝的原因；null 表示成功。
  ///
  /// 无内核路由的提供商不能设为默认——否则换完模型内核直接连不上，
  /// 界面看着像「新会话」，实际一句都发不出去。
  String? setDefaultModel(OndraProvider provider, OndraModelEntry model) {
    if (!identical(byId(provider.id), provider) ||
        !provider.models.contains(model)) {
      return '提供商或模型不存在';
    }
    try {
      RuntimeModelConfig.from(provider, model);
    } on FormatException catch (error) {
      return error.message;
    }
    if (_defaultProviderId == provider.id && _defaultModelId == model.id) {
      return null;
    }
    _defaultProviderId = provider.id;
    _defaultModelId = model.id;
    notifyListeners();
    return null;
  }

  void touch() => notifyListeners();

  void _ensureDefault() {
    final stillThere = _providers.any(
      (p) =>
          p.id == _defaultProviderId &&
          p.models.any((m) => m.id == _defaultModelId),
    );
    if (stillThere) return;
    final first = allModelEntries.isEmpty ? null : allModelEntries.first;
    _defaultProviderId = first?.$1.id ?? '';
    _defaultModelId = first?.$2.id ?? '';
  }
}

final ModelClient modelClient = ModelClient();
