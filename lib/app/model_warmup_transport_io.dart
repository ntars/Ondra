import 'model_warmup_controller.dart';

/// 预热必须走真实会话传输层，不能直接请求 OpenAI 兼容端点。
///
/// 这里刻意不保留旧的 `max_tokens: 1` 降级：它预热的是另一种请求形状，
/// 内核真正带系统提示词和工具集时仍会冷编译。传输层实现由装配处注入。
Future<ModelWarmupResult> warmupOpenAiCompatibleModel(
  ModelWarmupRequest request,
) {
  throw UnsupportedError('模型预热必须通过真实内核会话执行，不能直接请求 ${request.baseUrl}');
}
