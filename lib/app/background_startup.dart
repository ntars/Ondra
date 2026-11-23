import 'dart:async';

import 'package:flutter/widgets.dart';

/// 首帧之后才执行的启动步骤。
///
/// 窗口管理器（尤其是 Windows 与 Android）要等 Flutter 画出第一帧才把窗口
/// 或启动层交出来。若 `main()` 在 `runApp()` 前等待内核连接、插件扫描或
/// 首次解压，用户看到的就是一块长时间不动的开屏——界面代码根本没有机会
/// 绘制错误提示，更不可能让用户重试。
///
/// 这个类只做两件事：把任务推迟到首帧之后、逐步隔离异常。它不加入业务
/// 依赖；步骤顺序由调用方保证。
class BackgroundStartup {
  BackgroundStartup({required this.steps, required this.onError});

  final List<StartupStep> steps;
  final void Function(String name, Object error, StackTrace stack) onError;

  Future<void>? _future;

  /// 是否已经排到首帧之后（用于测试与诊断）。
  bool get scheduled => _future != null;

  /// 首帧完成后执行全部步骤。重复调用返回同一个 Future。
  ///
  /// 调用方**不要 await** 它；失败会交给 [onError]，不应阻止界面继续运行。
  Future<void> startAfterFirstFrame() {
    return _future ??= _schedule();
  }

  Future<void> _schedule() {
    final completer = Completer<void>();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      unawaited(
        _run().then(completer.complete, onError: completer.completeError),
      );
    });
    return completer.future;
  }

  Future<void> _run() async {
    for (final step in steps) {
      try {
        await step.run();
      } catch (error, stack) {
        onError(step.name, error, stack);
      }
    }
  }
}

class StartupStep {
  const StartupStep(this.name, this.run);

  final String name;
  final Future<void> Function() run;
}
