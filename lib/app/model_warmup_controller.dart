import 'dart:async';

import 'package:material_ui/material_ui.dart' show ChangeNotifier;

/// 一次本地模型预热请求。
///
/// 只描述 OpenAI 兼容端点，不携带可编辑的 provider 引用：启动和重连
/// 期间用户可能继续改设置，后台请求必须使用发起那一刻的快照。
class ModelWarmupRequest {
  const ModelWarmupRequest({
    required this.baseUrl,
    required this.model,
    this.apiKey,
    this.run,
  });

  final String baseUrl;
  final String model;
  final String? apiKey;

  /// 当前真实传输层的预热入口。由装配层在重连时注入，避免把静态全局
  /// 传输误用到已经关闭的上一条内核连接。
  final ModelWarmupRunner? run;

  String get key => '$baseUrl\u0000$model';
}

class ModelWarmupResult {
  const ModelWarmupResult(this.duration);

  final Duration duration;
}

typedef ModelWarmupRunner = Future<ModelWarmupResult> Function(
  ModelWarmupRequest request,
);

enum ModelWarmupPhase { idle, warming, ready, failed }

/// 预热状态机。首帧之后调用 [start]，它只启动后台任务并立即返回。
///
/// 同一端点与模型不重复预热；用户切换本地模型或改了 baseURL 后，
/// 下一次重连会用新的 request key 再跑一次。预热失败**不**把内核判成
/// 离线：它只是一次提前加载，真正的模型错误仍由会话主链如实报告。
class ModelWarmupController extends ChangeNotifier {
  // ignore: prefer_initializing_formals -- 对外参数名保持 run，私有字段不能当命名参数
  ModelWarmupController({required ModelWarmupRunner run}) : _run = run;

  final ModelWarmupRunner _run;

  ModelWarmupPhase _phase = ModelWarmupPhase.idle;
  String? _error;
  Duration? _duration;
  String? _lastKey;
  int _generation = 0;

  ModelWarmupPhase get phase => _phase;
  String? get error => _error;
  Duration? get duration => _duration;
  bool get warming => _phase == ModelWarmupPhase.warming;

  /// 启动预热，刻意不返回后台任务的完成 Future。
  ///
  /// 调用方（首帧后的启动步骤/模型重连）不能等待 30 秒级冷启动，否则
  /// 窗口虽然已经画出来，后续启动步骤和设置页仍会像卡死一样停住。
  Future<void> start(ModelWarmupRequest request) {
    if (_lastKey == request.key &&
        (_phase == ModelWarmupPhase.warming ||
            _phase == ModelWarmupPhase.ready)) {
      return Future<void>.value();
    }
    _lastKey = request.key;
    final generation = ++_generation;
    _phase = ModelWarmupPhase.warming;
    _error = null;
    _duration = null;
    notifyListeners();
    final run = request.run ?? _run;
    unawaited(
      run(request).then(
        (result) {
          if (generation != _generation) return;
          _duration = result.duration;
          _phase = ModelWarmupPhase.ready;
          notifyListeners();
        },
        onError: (Object error, StackTrace stack) {
          if (generation != _generation) return;
          _error = '$error';
          _phase = ModelWarmupPhase.failed;
          notifyListeners();
        },
      ),
    );
    return Future<void>.value();
  }
}
