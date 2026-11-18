/// 模型基座的预设目录：**按来源分类归档**。
///
/// 一个预设 = 一条 provider 的出厂值（地址 / 密钥变量名 / 模型目录 / 启动提示）。
/// 加进来之后用户还能改，所以这里只写「默认长什么样」，不写任何运行时状态。
///
/// 分六类的理由：用户面对的其实是六个不同的问题——
/// 用官方的（买密钥）、用合作方的（别人给的地址）、用免费的（额度有限）、
/// 用自己的（协议要对）、跑在本机（llama.cpp 那一套）、走网关（一个端口转发多家）。
/// 混成一个列表，等于每次都让人从头比对。
///
/// 地址只写**确定存在**的：合作方与免费服务的地址由其部署决定，留空让用户填；
/// 本地与网关给常见默认端口，明确标注「按实际配置改」。
library;

import '../../../ondra-beichen-api/ui/catalog.dart';
import 'model_types.dart';

/// 官方 API：各家自己的接口，协议统一是 OpenAI Chat Completions
/// （Anthropic 走 messages，这里按上游口径标注在地址上）。
const List<OndraProviderPreset> officialPresets = [
  OndraProviderPreset(
    id: 'deepseek',
    name: 'DeepSeek',
    category: ProviderCategory.official,
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      OndraModelPreset('deepseek-chat', contextWindow: '128K', maxTokens: '8K'),
      OndraModelPreset('deepseek-reasoner', contextWindow: '128K', maxTokens: '64K'),
    ],
    note: '官方直连，按 token 计费',
  ),
  OndraProviderPreset(
    id: 'openai',
    name: 'OpenAI',
    category: ProviderCategory.official,
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: [
      OndraModelPreset('gpt-4o', contextWindow: '128K', maxTokens: '16K', image: true),
      OndraModelPreset('gpt-4o-mini', contextWindow: '128K', maxTokens: '16K', image: true),
    ],
    note: '官方直连',
  ),
  OndraProviderPreset(
    id: 'anthropic',
    name: 'Anthropic',
    category: ProviderCategory.official,
    baseUrl: 'https://api.anthropic.com',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: [
      OndraModelPreset('claude-sonnet-4', contextWindow: '200K', maxTokens: '32K', image: true),
    ],
    note: '走 Anthropic Messages 协议',
  ),
  OndraProviderPreset(
    id: 'kimi',
    name: 'Kimi（Moonshot）',
    category: ProviderCategory.official,
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    models: [
      OndraModelPreset('kimi-k2', contextWindow: '256K', maxTokens: '8K'),
    ],
    note: '官方直连',
  ),
  OndraProviderPreset(
    id: 'zhipu',
    name: '智谱 GLM',
    category: ProviderCategory.official,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPU_API_KEY',
    models: [
      OndraModelPreset('glm-4-plus', contextWindow: '128K', maxTokens: '4K'),
    ],
    note: '官方直连',
  ),
  OndraProviderPreset(
    id: 'qwen',
    name: '通义千问',
    category: ProviderCategory.official,
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    models: [
      OndraModelPreset('qwen-plus', contextWindow: '128K', maxTokens: '8K'),
      OndraModelPreset('qwen-vl-max', contextWindow: '32K', maxTokens: '4K', image: true),
    ],
    note: '走 DashScope 的兼容模式',
  ),
];

/// 免费 API：`our-free-model`。
///
/// 它基于官方目录**重写精简**——模型 id 与官方一致（这样换回来不用改提示词与
/// 配置），但只保留低门槛的那几个，地址由部署方给。不是「官方的免费版」，
/// 是一个独立的中转：额度、限速、可用模型都以它为准。
const List<OndraProviderPreset> freePresets = [
  OndraProviderPreset(
    id: 'our-free-model',
    name: 'our-free-model',
    category: ProviderCategory.free,
    baseUrl: '',
    apiKeyEnv: 'OUR_FREE_MODEL_KEY',
    models: [
      OndraModelPreset('deepseek-chat', contextWindow: '128K', maxTokens: '8K'),
      OndraModelPreset('qwen-plus', contextWindow: '128K', maxTokens: '8K'),
    ],
    note: '免费额度有限；模型 id 与官方一致，地址由部署方给',
  ),
];

/// 本地部署：模型跑在自己机器上，不联网、不计费。
///
/// 三家都是 OpenAI 兼容协议，区别只在默认端口与启动方式。模型目录留空是
/// 有意的——本地有哪些模型取决于你装了什么，点「检测连接」从端点读回来，
/// 比在这里写死一份「应该有什么」准确。
const List<OndraProviderPreset> localPresets = [
  OndraProviderPreset(
    id: 'llama-cpp',
    name: 'llama.cpp',
    category: ProviderCategory.local,
    baseUrl: 'http://127.0.0.1:8080/v1',
    needsKey: false,
    note: 'llama-server 默认 8080；模型目录点「检测连接」读取',
    launchHint: 'llama-server -m <模型>.gguf --port 8080',
  ),
  OndraProviderPreset(
    id: 'ollama',
    name: 'Ollama',
    category: ProviderCategory.local,
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    note: 'ollama serve 默认 11434；检测连接会列出已 pull 的模型',
    launchHint: 'ollama serve',
  ),
  OndraProviderPreset(
    id: 'lmstudio',
    name: 'LM Studio',
    category: ProviderCategory.local,
    baseUrl: 'http://127.0.0.1:1234/v1',
    needsKey: false,
    note: '在 LM Studio 的 Developer 面板里 Start Server',
    launchHint: 'LM Studio → Developer → Start Server',
  ),
];

/// 本地网关：一个端口转发多家模型，适合已经有一套网关的人。
const List<OndraProviderPreset> gatewayPresets = [
  OndraProviderPreset(
    id: 'magpie',
    name: 'Magpie',
    category: ProviderCategory.gateway,
    baseUrl: 'http://127.0.0.1:3425/v1',
    apiKeyEnv: 'MAGPIE_API_KEY',
    needsKey: false,
    note: 'macOS 上由 magpie.app 托管，默认监听 3425；不需要密钥',
  ),
  OndraProviderPreset(
    id: 'litellm',
    name: 'LiteLLM',
    category: ProviderCategory.gateway,
    baseUrl: 'http://127.0.0.1:4000/v1',
    apiKeyEnv: 'LITELLM_API_KEY',
    note: 'litellm --port 4000；建议在网关侧统一模型名',
  ),
  OndraProviderPreset(
    id: 'one-api',
    name: 'One API / New API',
    category: ProviderCategory.gateway,
    baseUrl: 'http://127.0.0.1:3000/v1',
    apiKeyEnv: 'ONE_API_KEY',
    note: '默认 3000；模型名以网关里配置的为准',
  ),
];

/// 某一类下的预设。自定义 API 没有预设——它的「预设」就是那张空表单。
List<OndraProviderPreset> presetsOf(ProviderCategory category) => switch (category) {
  ProviderCategory.official => officialPresets,
  ProviderCategory.partner => beichenPresets,
  ProviderCategory.free => freePresets,
  ProviderCategory.local => localPresets,
  ProviderCategory.gateway => gatewayPresets,
  ProviderCategory.custom => const [],
};
