/// 检查更新的结论。两个实现（桌面 / 浏览器）共用这一份，
/// 否则页面要从不同的文件里拿不同的同名类，条件导出就没有意义了。
library;

enum UpdateStatus {
  /// 有更新。
  available,

  /// 已是最新。
  current,

  /// 查不动（离线、限速、浏览器预览）。
  failed,
}

class UpdateCheckResult {
  const UpdateCheckResult({
    required this.status,
    required this.message,
    this.latest,
    this.url,
  });

  final UpdateStatus status;
  final String message;
  final String? latest;
  final String? url;
}
