/// 浏览器预览里的检查更新：没有跨域权限，如实说做不到。
library;

import 'update_check_result.dart';
import 'version_compare.dart';

export 'update_check_result.dart';
export 'version_compare.dart';

class UpdateChecker {
  const UpdateChecker._();

  static const String releasesUrl =
      'https://github.com/ntars/Ondra/releases/latest';

  /// 版本比较与平台无关，两端的判定必须完全一致——所以这里直接转发到
  /// 同一份实现，而不是各写一遍。桌面端 `update_check_io.dart` 也用它。
  static int compareVersions(String a, String b) => versionCompare(a, b);

  static Future<UpdateCheckResult> check({
    required String currentVersion,
    String channel = 'stable',
  }) async => const UpdateCheckResult(
    status: UpdateStatus.failed,
    message: '浏览器预览里不能跨域查询发行版，检查更新请在桌面端使用。',
  );
}
