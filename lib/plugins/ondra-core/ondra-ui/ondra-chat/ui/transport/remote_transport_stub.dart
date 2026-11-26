import '../chat_client.dart';

/// 浏览器预览不启动本机进程，也没有配置远程 dsh 的宿主入口。
///
/// 这是如实的能力边界，不是假装“稍后支持”：调用方会拿到明确原因。
class RemoteDshTransport implements DshTransport, ResumableDshTransport {
  const RemoteDshTransport({
    required this.baseUrl,
    this.launchToken = '',
    this.provider = '',
    this.model = '',
    this.workingDirectory = '/',
    this.resumeSessionId,
    this.requestTimeout = const Duration(seconds: 30),
    this.turnTimeout = const Duration(minutes: 10),
    this.closeTimeout = const Duration(seconds: 5),
  });

  final String baseUrl;
  final String launchToken;
  final String provider;
  final String model;
  final String workingDirectory;
  final String? resumeSessionId;
  final Duration requestTimeout;
  final Duration turnTimeout;
  final Duration closeTimeout;

  static const reason = '浏览器预览不能直连带 cookie 的 dsh web 内核；请使用桌面或移动端 R3';

  @override
  String? get modelConfigError => null;

  @override
  String? get sessionId => resumeSessionId;

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
  void dispose() {}

  @override
  Future<void> close() async {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();

  @override
  bool get isConnected => false;
}
