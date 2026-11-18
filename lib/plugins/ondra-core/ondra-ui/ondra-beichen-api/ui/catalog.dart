import '../../ondra-settings/ondra-models/ui/model_types.dart';

/// 合作 API 的预设目录。
///
/// **换合作方只改这一个文件**（或对应插件的配置）：地址、密钥变量名、模型目录
/// 都在这里。界面按 `ProviderCategory.partner` 把它们归到「合作 API」一组，
/// 不关心具体是哪一家。
///
/// 地址刻意留空：合作方给的地址各不相同，写一个假的反而会让人以为能用。
/// 添加后会自动进编辑器，请先填地址。
const List<OndraProviderPreset> beichenPresets = [
  OndraProviderPreset(
    id: 'partner',
    name: '合作 API',
    category: ProviderCategory.partner,
    baseUrl: '',
    apiKeyEnv: 'PARTNER_API_KEY',
    models: [
      OndraModelPreset('partner-chat', contextWindow: '128K', maxTokens: '8K'),
      OndraModelPreset('partner-reasoner', contextWindow: '128K', maxTokens: '32K'),
    ],
    note: '地址与模型名按合作方给的目录填；换一家改这个文件即可',
  ),
];
