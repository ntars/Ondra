/// 模型基座的数据形状，**字段与 DSH 的模型设置完全一致**。
///
/// 上游的模型设置读写的是 `settings.yaml` 里的 provider 段：
/// `id / name / baseURL / apiKey（secret）/ apiKeyEnv / models[]`，
/// 每个 model 是 `id / name / contextWindow / maxTokens / input[] / reasoningEfforts[]`。
/// 这里用同一套字段名与同一套取值，接运行时就能直接映射，不需要再做一层翻译。
class OndraProvider {
  OndraProvider({
    required this.id,
    required this.name,
    this.category = ProviderCategory.official,
    this.baseUrl = '',
    this.apiKeyEnv = '',
    this.keyConfigured = false,
    this.builtIn = false,
    this.launchHint = '',
    String? protocol,
    List<OndraModelEntry>? models,
    // ignore: prefer_initializing_formals -- const 构造不能用私有 initializing formal
  }) : _protocol = protocol,
       models = models ?? [];

  /// 这个提供商是从哪一类来源加进来的。列表按它分组，编辑器按它决定要不要
  /// 显示「检测连接 / 启动命令」这些块。
  ProviderCategory category;

  /// 本地部署的启动方式（llama.cpp / Ollama 的命令），只用于提示，不执行。
  String launchHint;

  /// 请求里唯一标识该提供商：小写字母开头，之后可含小写字母、数字、短横线。
  final String id;

  String name;

  /// 留空表示用适配器默认地址。
  String baseUrl;

  /// 环境变量名：没有存密钥时，回退到这个变量（上游 `apiKeyEnv`）。
  String apiKeyEnv;

  /// 密钥是否已存（本体在钥匙串，不在这里）。
  bool keyConfigured;

  /// 目录自带的提供商不可删。
  final bool builtIn;

  final List<OndraModelEntry> models;

  String get protocolLabel => switch (protocol) {
    'openai-completions' => 'OpenAI Chat Completions',
    'openai-responses' => 'OpenAI Responses',
    'anthropic-messages' => 'Anthropic Messages',
    _ => protocol,
  };

  String? _protocol;

  /// 旧存档没有协议字段时兼容原预设；新配置可显式指定 Responses / Messages。
  String get protocol =>
      _protocol ??
      (id == 'anthropic' || Uri.tryParse(baseUrl)?.host == 'api.anthropic.com'
          ? 'anthropic-messages'
          : 'openai-completions');
  set protocol(String value) => _protocol = value;
}

/// 模型目录里的一条，字段与上游 `models[]` 一致。
class OndraModelEntry {
  OndraModelEntry({
    required this.id,
    this.name = '',
    this.contextWindow = '',
    this.maxTokens = '',
    List<String>? inputs,
    List<OndraReasoningLevel>? reasoning,
  }) : inputs = inputs ?? ['text'],
       reasoning = reasoning ?? [];

  /// 模型 ID，如 `deepseek-chat`。
  String id;

  /// 显示名；留空时上游用 ID（官方提示「留空时使用模型 ID」）。
  String name;

  /// 上下文窗口，可写 `128K` / `1M`；留空用提供商默认值。
  String contextWindow;

  /// 最大输出 token。
  String maxTokens;

  /// 输入类型：`text` / `image`。
  List<String> inputs;

  /// 推理档位：每档有显示名与写进请求的 API 参数值。
  List<OndraReasoningLevel> reasoning;

  String get label => name.isEmpty ? id : name;
  bool get acceptsImage => inputs.contains('image');
}

/// 一个推理档位。上游允许自定义档位名与 API 参数值（如 OpenAI 的 reasoning_effort）。
class OndraReasoningLevel {
  const OndraReasoningLevel({
    required this.label,
    required this.apiValue,
    String? level,
    // ignore: prefer_initializing_formals -- 同上，const 构造的限制
  }) : _level = level;

  final String label;
  final String apiValue;
  final String? _level;

  /// SDK 的标准档位与线上参数值分开，允许 high 映射到服务端自定义值。
  String get level =>
      _level ??
      switch (label) {
        '关闭思考' => 'off',
        '低' => 'low',
        '中' => 'medium',
        '高' => 'high',
        _ => apiValue.isEmpty ? 'off' : apiValue,
      };

  static const off = OndraReasoningLevel(label: '关闭思考', apiValue: '');
  static const low = OndraReasoningLevel(label: '低', apiValue: 'low');
  static const medium = OndraReasoningLevel(label: '中', apiValue: 'medium');
  static const high = OndraReasoningLevel(label: '高', apiValue: 'high');

  /// 官方预设的四档，用来做候选列表。
  static const presets = [off, low, medium, high];
}

/// 提供商的来源分类。**这是模型基座的顶层结构**：用户先想「模型从哪来」，
/// 再想「用哪一家」，所以添加流程是「分类 → 预设 → 配置」三步。
///
/// 顺序是有意的：从最省事的官方接口开始，到最费事的自己部署，最后是网关——
/// 它不提供模型，只是把前面几种合成一个入口。
enum ProviderCategory {
  official('官方 API', '各家官方接口，填密钥即可'),
  partner('合作 API', '合作方的中转接口，可整包替换', 'ondra-beichen-api'),
  free('免费 API', 'our-free-model：官方目录的精简版', 'our-free-model'),
  custom('自定义 API', '任何兼容 OpenAI / Anthropic 协议的服务'),
  local('本地部署', 'llama.cpp / Ollama / LM Studio，跑在自己机器上'),
  gateway('本地网关', 'Magpie / LiteLLM / One API，一个端口转发多家');

  const ProviderCategory(this.label, this.note, [this.plugin]);

  final String label;
  final String note;

  /// 这一类由哪个插件提供；为空表示由模型基座自己维护。
  final String? plugin;
}

/// 目录里的一个预设：点一下就变成一条 provider。
///
/// 与 [OndraProvider] 分开是因为预设是**常量**（可以 const），而 provider 是可改的
/// 实例——混在一起会让「恢复默认」变成一场深拷贝。
class OndraProviderPreset {
  const OndraProviderPreset({
    required this.id,
    required this.name,
    required this.category,
    required this.baseUrl,
    this.apiKeyEnv = '',
    this.models = const [],
    this.note = '',
    this.needsKey = true,
    this.launchHint = '',
  });

  final String id;
  final String name;
  final ProviderCategory category;

  /// 预设地址；留空表示这一家要用户自己填（合作方与免费服务的地址会变）。
  final String baseUrl;

  final String apiKeyEnv;
  final List<OndraModelPreset> models;
  final String note;

  /// 本地部署不需要密钥。
  final bool needsKey;

  /// 本地部署的启动命令提示。
  final String launchHint;

  /// 是否连一个地址都没给：这种预设添加后直接进编辑器补地址。
  bool get needsAddress => baseUrl.isEmpty;

  OndraProvider toProvider() => OndraProvider(
    id: id,
    name: name,
    category: category,
    baseUrl: baseUrl,
    apiKeyEnv: apiKeyEnv,
    launchHint: launchHint,
    models: [for (final m in models) m.toEntry()],
  );
}

/// 预设里的模型条目：只记必要字段，转成 [OndraModelEntry] 时补齐默认值。
class OndraModelPreset {
  const OndraModelPreset(
    this.id, {
    this.name = '',
    this.contextWindow = '',
    this.maxTokens = '',
    this.image = false,
  });

  final String id;
  final String name;
  final String contextWindow;
  final String maxTokens;

  /// 是否接受图片输入。
  final bool image;

  OndraModelEntry toEntry() => OndraModelEntry(
    id: id,
    name: name,
    contextWindow: contextWindow,
    maxTokens: maxTokens,
    inputs: image ? ['text', 'image'] : ['text'],
  );
}
