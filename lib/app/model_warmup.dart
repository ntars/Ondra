import 'model_warmup_controller.dart';
import 'model_warmup_transport_stub.dart'
    if (dart.library.io) 'model_warmup_transport_io.dart'
    as transport;

export 'model_warmup_controller.dart';

/// 应用级预热状态。启动装配层只在本地模型会被使用时触发它。
final ModelWarmupController modelWarmup = ModelWarmupController(
  run: transport.warmupOpenAiCompatibleModel,
);
