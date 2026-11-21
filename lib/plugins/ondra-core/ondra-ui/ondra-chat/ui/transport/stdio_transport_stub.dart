import '../chat_client.dart';
import '../../../ondra-settings/ondra-models/ui/runtime_model_config.dart';

/// 浏览器里没有子进程，如实说明即可——不假装能连。
class StdioDshTransport implements DshTransport {
  @override
  String? get modelConfigError => null;

  @override
  void dispose() {}

  /// 与桌面版同名同参：条件导出让两边共用一个构造签名，
  /// 调用方不用知道自己跑在哪种平台上。这两个参数在 Web 上无处可用，
  /// 留着是为了让「选哪条路由」这件事在两端是同一个形状。
  const StdioDshTransport({
    this.modelId = 'group/ntars',
    this.provider = 'magpie',
    RuntimeModelConfig Function()? modelConfig,
    Future<String?> Function(String)? secretResolver,
    String? binary,
    Map<String, String>? environment,
    List<String> binaryArgs = const [],
    String? workingDirectory,
    Future<void>? previousClosed,
    String? resumeSessionId,
    Duration requestTimeout = const Duration(seconds: 30),
    Duration turnTimeout = const Duration(minutes: 10),
  });

  Future<void> close() async {}
  String? get sessionId => null;

  final String modelId;
  final String provider;

  static const reason = '浏览器预览无法启动本机进程：请在桌面构建里连 dsh 运行时';

  @override
  Future<void> connect() async => throw StateError(reason);

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) async* {
    throw StateError(reason);
  }

  @override
  void resetSession() {}

  @override
  void stop() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}
