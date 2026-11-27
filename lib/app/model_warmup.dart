import 'model_warmup_controller.dart';

export 'model_warmup_controller.dart';

/// 应用级预热状态。启动装配层只在本地模型会被使用时触发它。
///
/// 运行入口由 `ModelRuntimeBinding` 在换好真实传输层后接入；不能用静态
/// 全局传输，否则重连时预热会打到上一条已经关闭的连接。
final ModelWarmupController modelWarmup = ModelWarmupController(
  run: (_) async => throw StateError('模型预热尚未接入真实内核会话'),
);
