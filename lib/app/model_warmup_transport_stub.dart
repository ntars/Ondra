import 'model_warmup_controller.dart';

/// 浏览器预览没有本地 sidecar，也没有可信的本机 127.0.0.1 模型端点。
Future<ModelWarmupResult> warmupOpenAiCompatibleModel(
  ModelWarmupRequest request,
) {
  throw UnsupportedError('浏览器预览无法预热本机模型');
}
