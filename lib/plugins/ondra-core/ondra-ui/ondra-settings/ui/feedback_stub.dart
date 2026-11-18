/// Web 端的反馈：能落 localStorage 就落，不能就如实拒绝。
///
/// 这里**不做内存假存**：刷新就丢的东西不是「已提交」。
class FeedbackStore {
  FeedbackStore({String? home});

  final String home = '';

  static const List<String> kinds = ['功能建议', '界面问题', '功能异常', '性能问题', '其他'];

  Future<FeedbackResult> write({
    required String kind,
    required String body,
    required String version,
    required List<String> attachmentPaths,
    bool attachLog = true,
  }) async {
    if (body.trim().length < 10) {
      return const FeedbackResult(
        ok: false,
        message: '描述太短了，至少写 10 个字才说得清问题。',
      );
    }
    return const FeedbackResult(
      ok: false,
      message: '浏览器预览里没有本地目录，反馈请在桌面端提交。',
    );
  }

  Future<FeedbackResult> compose({
    required String kind,
    required String body,
    required String version,
  }) async => const FeedbackResult(
    ok: false,
    message: '浏览器预览里打不开邮件客户端。',
  );

  Future<List<String>> pickAttachments() async => const [];
}

class FeedbackResult {
  const FeedbackResult({required this.ok, required this.message, this.path});

  final bool ok;
  final String message;
  final String? path;
}
