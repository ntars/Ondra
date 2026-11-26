import 'dart:convert';

import 'model_types.dart';

/// 一次连接使用的不可变、无密钥快照；不把可编辑的 provider 引用交给异步启动。
class RuntimeModelConfig {
  RuntimeModelConfig._(
    this.providerId,
    this.modelId,
    this.apiKeyEnv,
    this.isLoopback,
    this.providerCategory,
    this._profileJson,
  );

  factory RuntimeModelConfig.from(
    OndraProvider provider,
    OndraModelEntry model,
  ) {
    if (!RegExp(r'^[a-z][a-z0-9-]*$').hasMatch(provider.id)) {
      throw const FormatException('提供商 ID 无效');
    }
    final url = Uri.tryParse(provider.baseUrl.trim());
    if (url == null ||
        !['http', 'https'].contains(url.scheme) ||
        url.host.isEmpty ||
        url.userInfo.isNotEmpty ||
        url.hasQuery ||
        url.hasFragment) {
      throw const FormatException('请先填写有效的 HTTP(S) API 地址');
    }
    if (!protocols.contains(provider.protocol)) {
      throw const FormatException('不支持的模型 API 协议');
    }
    validateModel(model);
    final env = provider.apiKeyEnv.isEmpty
        ? 'ONDRA_UI_${provider.id.replaceAll('-', '_').toUpperCase()}_API_KEY'
        : provider.apiKeyEnv;
    if (!RegExp(r'^[A-Za-z_][A-Za-z0-9_]*$').hasMatch(env)) {
      throw const FormatException('密钥环境变量名无效');
    }
    final efforts = <String, String?>{
      for (final r in model.reasoning)
        r.level: r.apiValue.isEmpty ? null : r.apiValue,
    };
    final thinking = efforts.keys.where((key) => key != 'off').toList();
    // 只有“关”一档时不写 reasoningEfforts。LM Studio 的 qwen3-coder-next
    // 没有声明 reasoning 能力，pi-ai 会拒绝空的 apiValue；不带这两个字段
    // 才是关闭思考模式（手册 §8.0 硬结论 4）。
    final hasReasoning = thinking.isNotEmpty;
    final profile = <String, Object?>{
      'displayName': provider.name.isEmpty ? provider.id : provider.name,
      'api': provider.protocol,
      'baseURL': url.toString(),
      'apiKeyEnv': env,
      // 与 SDK 的缺省容量一致；显式字段永远覆盖默认值。
      'defaultContextWindow': 1000000,
      'defaultMaxTokens': 128000,
      'models': [
        {
          'id': model.id,
          'name': model.label,
          if (model.contextWindow.isNotEmpty)
            'contextWindow': capacity(model.contextWindow),
          if (model.maxTokens.isNotEmpty)
            'maxTokens': capacity(model.maxTokens),
          'input': List<String>.of(model.inputs),
          if (hasReasoning) 'reasoningEfforts': efforts,
        },
      ],
      if (hasReasoning)
        'reasoning': efforts.containsKey('medium') ? 'medium' : thinking.first,
    };
    return RuntimeModelConfig._(
      provider.id,
      model.id,
      env,
      isLoopbackHost(url.host),
      provider.category,
      jsonEncode(profile),
    );
  }

  static const protocols = [
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
  ];
  static const thinkingLevels = [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ];

  static bool isLoopbackHost(String host) {
    if (host == 'localhost' || host == '::1' || host == '[::1]') return true;
    final parts = host.split('.');
    return parts.length == 4 &&
        parts.first == '127' &&
        parts.every((part) {
          final n = int.tryParse(part);
          return n != null && n >= 0 && n <= 255;
        });
  }

  static int capacity(String text) {
    if (!RegExp(r'^\d+(\.\d+)?[KkMm]?$').hasMatch(text)) {
      throw const FormatException('容量必须是正整数，可带 K / M 后缀');
    }
    final suffix = text.substring(text.length - 1).toLowerCase();
    final multiplier = suffix == 'k' ? 1024 : (suffix == 'm' ? 1048576 : 1);
    final number =
        double.parse(text.replaceAll(RegExp(r'[KkMm]$'), '')) * multiplier;
    if (!number.isFinite ||
        number < 1 ||
        number > 9007199254740991 ||
        number != number.truncateToDouble()) {
      throw const FormatException('容量换算后必须是有效的正整数');
    }
    return number.toInt();
  }

  static void validateModel(OndraModelEntry model) {
    if (model.id.trim().isEmpty) throw const FormatException('模型 ID 不能为空');
    if (model.contextWindow.isNotEmpty) capacity(model.contextWindow);
    if (model.maxTokens.isNotEmpty) capacity(model.maxTokens);
    if (model.inputs.isEmpty ||
        model.inputs.any((v) => !['text', 'image'].contains(v))) {
      throw const FormatException('输入类型只能是 text / image，且不能为空');
    }
    final seen = <String>{};
    for (final effort in model.reasoning) {
      if (!thinkingLevels.contains(effort.level) ||
          !seen.add(effort.level) ||
          (effort.level != 'off' && effort.apiValue.trim().isEmpty)) {
        throw const FormatException('推理档位无效或重复');
      }
    }
  }

  final String providerId;
  final String modelId;
  final String apiKeyEnv;
  final bool isLoopback;
  final ProviderCategory providerCategory;
  final String _profileJson;
  String get route => 'ondra-ui-$providerId';
  String get fingerprint => '$route/$_profileJson';
  Map<String, dynamic> get profile =>
      jsonDecode(_profileJson) as Map<String, dynamic>;

  /// resolver 只读钥匙串；环境兜底使用本次启动的环境，而非全局 HOME。
  Future<Map<String, String>> resolveEnvironment(
    Map<String, String> environment,
    Future<String?> Function(String providerId) resolver,
  ) async {
    var secret = await resolver(providerId);
    if (secret == null || secret.trim().isEmpty) {
      secret = environment[apiKeyEnv];
    }
    if (secret == null || secret.trim().isEmpty) {
      // 网关类 provider 由部署方控制可达性，允许无密钥占位；真正的远端
      // 模型仍要求显式凭据，避免把“忘了配密钥”伪装成可连接。
      if (!isLoopback && providerCategory != ProviderCategory.gateway) {
        throw StateError('当前远端模型缺少密钥：请填写钥匙串密钥或 $apiKeyEnv');
      }
      secret = 'ondra-local-loopback';
    }
    return {...environment, apiKeyEnv: secret};
  }
}
