import 'dart:convert';
import 'dart:io';

import 'update_check_result.dart';
import 'version_compare.dart';

export 'update_check_result.dart';

/// 桌面端的检查更新。
///
/// ## 为什么直连 api.github.com 而不引 `package:http`
///
/// 一次 GET、一个 JSON，`HttpClient` 就够了。引一个包只为这一处，
/// 依赖表会多一行长期维护成本。
///
/// ## 预发布怎么算
///
/// 当前版本是 `2.0.0-alpha`（预发布）。对预发布，**「更新」的判据是
/// 有没有更新的预发布或正式版**——`2.0.0-alpha` 不该把 `1.3.0` 当成新版本
/// 提示给用户，那是降级。所以比较函数认 `-alpha` / `-beta` / `-rc` 后缀，
/// 正式版排在预发布之后。
///
/// ## 用户取消了什么
///
/// 这里**只查不装**。点「检查更新」得到的是一句结论和一个链接；
/// 下载与安装交给用户在 Releases 页面自己操作。自动更新要签名校验与
/// 增量替换，做不到严格验证就不做——半个自动更新比没有更危险。
class UpdateChecker {
  const UpdateChecker._();

  static const String releasesUrl =
      'https://github.com/ntars/Ondra/releases/latest';

  static const String _apiLatest =
      'https://api.github.com/repos/ntars/Ondra/releases/latest';

  /// 预发布（含 alpha / beta / rc）走列表接口再挑，`/latest` 只回正式版。
  static const String _apiList =
      'https://api.github.com/repos/ntars/Ondra/releases?per_page=20';

  static Future<UpdateCheckResult> check({
    required String currentVersion,
    String channel = 'stable',
  }) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
    try {
      final url = channel == 'nightly' ? _apiList : _apiLatest;
      final req = await client.getUrl(Uri.parse(url));
      req.headers.set('Accept', 'application/vnd.github+json');
      req.headers.set('User-Agent', 'Ondra-Desktop');
      final res = await req.close();
      final body = await res.transform(utf8.decoder).join();

      if (res.statusCode == 404) {
        return const UpdateCheckResult(
          status: UpdateStatus.current,
          message: '仓库里还没有任何发行版。',
        );
      }
      if (res.statusCode == 403 || res.statusCode == 429) {
        return const UpdateCheckResult(
          status: UpdateStatus.failed,
          message: 'GitHub 限速了（未登录时每小时 60 次），过一会儿再试。',
        );
      }
      if (res.statusCode != 200) {
        return UpdateCheckResult(
          status: UpdateStatus.failed,
          message: '查询失败：HTTP ${res.statusCode}',
        );
      }

      final tag = _pickTag(jsonDecode(body), channel: channel);
      if (tag == null) {
        return const UpdateCheckResult(
          status: UpdateStatus.current,
          message: '还没有可用的发行版。',
        );
      }
      final latest = _stripV(tag);
      final cmp = compareVersions(latest, currentVersion);
      if (cmp <= 0) {
        return UpdateCheckResult(
          status: UpdateStatus.current,
          message: '已是最新（$currentVersion）。',
          latest: latest,
        );
      }
      return UpdateCheckResult(
        status: UpdateStatus.available,
        message: '有新版本 $latest（当前 $currentVersion）。',
        latest: latest,
        url: releasesUrl,
      );
    } catch (e) {
      return UpdateCheckResult(
        status: UpdateStatus.failed,
        message: '连不上 GitHub：$e',
      );
    } finally {
      client.close(force: true);
    }
  }

  /// 从接口返回里挑一个 tag。
  ///
  /// 正式通道只认 `/latest` 那一个对象的 `tag_name`；nightly 通道在列表里
  /// 取**第一个非草稿**的——GitHub 的列表按创建时间倒序，第一个就是最新。
  static String? _pickTag(Object? payload, {required String channel}) {
    if (channel != 'nightly') {
      if (payload is Map && payload['tag_name'] is String) {
        return payload['tag_name'] as String;
      }
      return null;
    }
    if (payload is! List) return null;
    for (final e in payload) {
      if (e is! Map) continue;
      if (e['draft'] == true) continue;
      final tag = e['tag_name'];
      if (tag is String && tag.isNotEmpty) return tag;
    }
    return null;
  }

  static String _stripV(String tag) =>
      tag.startsWith('v') || tag.startsWith('V') ? tag.substring(1) : tag;

  /// 版本比较的公开入口。真正的实现在 `version_compare.dart`：
  /// 它是纯逻辑，桌面端与浏览器端必须用同一份，否则会出现
  /// 「网页说已是最新、桌面说有新版」这种自相矛盾。
  static int compareVersions(String a, String b) => versionCompare(a, b);
}
