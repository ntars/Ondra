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

  /// 仅 available 时提供，经校验的对应发行版 html_url。
  final String? url;
}

/// 可注入的 HTTP 边界，测试无需联网。
class UpdateFetchResponse {
  const UpdateFetchResponse({required this.statusCode, required this.body});

  final int statusCode;
  final String body;
}

typedef UpdateFetch = Future<UpdateFetchResponse> Function(Uri uri);
typedef ReleaseLauncher = Future<bool> Function(
  String executable,
  List<String> arguments,
);

class OpenReleaseResult {
  const OpenReleaseResult({required this.ok, required this.message});

  /// 仅表示系统接受打开请求，不保证浏览器已加载页面。
  final bool ok;
  final String message;
}

/// 只接受本仓库的 HTTPS 发行页，不接受附件下载、凭据、查询或跳转参数。
bool isTrustedReleaseUrl(String value) {
  try {
    if (!value.startsWith('https://github.com/ntars/Ondra/releases/') ||
        RegExp(r'[\s\\\x00-\x1f\x7f]').hasMatch(value)) {
      return false;
    }
    final uri = Uri.parse(value);
    if (uri.scheme != 'https' ||
        uri.host != 'github.com' ||
        uri.userInfo.isNotEmpty ||
        uri.hasPort ||
        uri.hasQuery ||
        uri.hasFragment) {
      return false;
    }
    final segments = uri.pathSegments;
    if (segments.length < 4 ||
        segments[0] != 'ntars' ||
        segments[1] != 'Ondra' ||
        segments[2] != 'releases') {
      return false;
    }
    // 对原始路径也做检查：Uri 会正规化点段，不能让正规化掩盖输入。
    for (final raw in uri.path.split('/').skip(1)) {
      final part = Uri.decodeComponent(raw);
      if (part.isEmpty ||
          part == '.' ||
          part == '..' ||
          RegExp(r'[/\\%\s\x00-\x1f\x7f]').hasMatch(part)) {
        return false;
      }
    }
    final originalPath = value.substring(value.indexOf('/', 'https://'.length));
    if (originalPath != uri.path) return false;
    return (segments.length == 4 && segments[3] == 'latest') ||
        (segments.length >= 5 && segments[3] == 'tag');
  } catch (_) {
    return false;
  }
}
