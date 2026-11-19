import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'update_check_result.dart';
import 'version_compare.dart';

export 'update_check_result.dart';

/// 只查询发行版，下载与安装由用户在可信发行页自行操作。
class UpdateChecker {
  const UpdateChecker._();

  static const String releasesUrl =
      'https://github.com/ntars/Ondra/releases/latest';
  static const String _apiLatest =
      'https://api.github.com/repos/ntars/Ondra/releases/latest';
  static const String _apiList =
      'https://api.github.com/repos/ntars/Ondra/releases';

  /// timeout 覆盖连接、响应头、完整响应体以及 nightly 的全部分页。
  /// fetch / clientFactory 仅用于离线测试，不改变生产 API 地址。
  static Future<UpdateCheckResult> check({
    required String currentVersion,
    String channel = 'stable',
    Duration timeout = const Duration(seconds: 12),
    UpdateFetch? fetch,
    HttpClient Function()? clientFactory,
  }) async {
    if (channel != 'stable' && channel != 'nightly') {
      return const UpdateCheckResult(
        status: UpdateStatus.failed,
        message: '未知的更新通道。',
      );
    }
    HttpClient? client;
    var finished = false;
    try {
      if (fetch == null) {
        client = (clientFactory ?? HttpClient.new)();
        client.connectionTimeout = timeout;
      }
      Future<UpdateFetchResponse> load(Uri uri) {
        // timeout 不会取消任意注入的 Future；禁止超时后的后台工作继续分页。
        if (finished) throw TimeoutException('检查更新已结束');
        return fetch != null ? fetch(uri) : _fetch(client!, uri);
      }

      return await _checkReleases(
        currentVersion: currentVersion,
        channel: channel,
        fetch: load,
      ).timeout(timeout);
    } on TimeoutException {
      return const UpdateCheckResult(
        status: UpdateStatus.failed,
        message: '检查更新超时，请稍后重试。',
      );
    } catch (e) {
      return UpdateCheckResult(
        status: UpdateStatus.failed,
        message: '检查更新失败：$e',
      );
    } finally {
      finished = true;
      client?.close(force: true);
    }
  }

  static Future<UpdateFetchResponse> _fetch(HttpClient client, Uri uri) async {
    final req = await client.getUrl(uri);
    // 不跟随 API 重定向，不读取凭据、不向其他站点发请求。
    req.followRedirects = false;
    req.headers.set('Accept', 'application/vnd.github+json');
    req.headers.set('User-Agent', 'Ondra-Desktop');
    final res = await req.close();
    return UpdateFetchResponse(
      statusCode: res.statusCode,
      body: await res.transform(utf8.decoder).join(),
    );
  }

  static Future<UpdateCheckResult> _checkReleases({
    required String currentVersion,
    required String channel,
    required UpdateFetch fetch,
  }) async {
    Map? selected;
    for (var page = 1; ; page++) {
      final uri = Uri.parse(
        channel == 'nightly' ? '$_apiList?per_page=100&page=$page' : _apiLatest,
      );
      final response = await fetch(uri);
      if (response.statusCode == 404) {
        return const UpdateCheckResult(
          status: UpdateStatus.current,
          message: '仓库里还没有可用的发行版。',
        );
      }
      if (response.statusCode == 403 || response.statusCode == 429) {
        return const UpdateCheckResult(
          status: UpdateStatus.failed,
          message: 'GitHub 限速或拒绝访问，请稍后重试。',
        );
      }
      if (response.statusCode != 200) {
        return UpdateCheckResult(
          status: UpdateStatus.failed,
          message: '查询失败：HTTP ${response.statusCode}',
        );
      }
      final payload = jsonDecode(response.body);
      if ((channel == 'nightly' && payload is! List) ||
          (channel == 'stable' && payload is! Map)) {
        throw const FormatException('发行版响应格式无效');
      }
      final candidates = channel == 'nightly' ? payload as List : [payload];
      for (final entry in candidates) {
        if (entry is! Map ||
            entry['draft'] == true ||
            (channel == 'stable' && entry['prerelease'] == true)) {
          continue;
        }
        final tag = entry['tag_name'];
        if (tag is! String ||
            !RegExp(
              r'^[vV]?\d+(?:\.\d+){0,2}(?:-[0-9a-zA-Z][0-9a-zA-Z.-]*)?(?:\+[0-9a-zA-Z.-]+)?$',
            ).hasMatch(tag)) {
          continue;
        }
        // GitHub 按创建时间排序，不是版本排序；旧分支补发不能覆盖新版本。
        if (selected == null ||
            compareVersions(
                  _stripV(tag),
                  _stripV(selected['tag_name'] as String),
                ) >
                0) {
          selected = entry;
        }
      }
      if (channel != 'nightly' || candidates.length < 100) break;
    }
    if (selected == null) {
      return const UpdateCheckResult(
        status: UpdateStatus.current,
        message: '还没有可用的发行版。',
      );
    }
    final url = selected['html_url'];
    if (url is! String || !isTrustedReleaseUrl(url)) {
      return const UpdateCheckResult(
        status: UpdateStatus.failed,
        message: '发行版链接缺失或不是受信的 GitHub 发行页。',
      );
    }
    final latest = _stripV(selected['tag_name'] as String);
    if (compareVersions(latest, currentVersion) <= 0) {
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
      url: url,
    );
  }

  /// 仅应在用户明确点击发行页按钮时调用；不运行 shell、不下载或安装。
  static Future<OpenReleaseResult> openRelease(
    String url, {
    ReleaseLauncher? launch,
    String? platform,
  }) async {
    if (!isTrustedReleaseUrl(url)) {
      return const OpenReleaseResult(ok: false, message: '拒绝打开非受信的发行页链接。');
    }
    final executable = switch (platform ?? Platform.operatingSystem) {
      'macos' => 'open',
      'linux' => 'xdg-open',
      'windows' => 'explorer.exe',
      _ => null,
    };
    if (executable == null) {
      return const OpenReleaseResult(
        ok: false,
        message: '当前平台不能打开系统浏览器，请手动访问发行页。',
      );
    }
    try {
      final opened = await (launch ?? _systemLaunch)(executable, [
        url,
      ]).timeout(const Duration(seconds: 10));
      return OpenReleaseResult(
        ok: opened,
        message: opened ? '已请求系统浏览器打开发行页。' : '系统未能打开发行页，请手动访问链接。',
      );
    } catch (e) {
      return OpenReleaseResult(ok: false, message: '打开发行页失败：$e');
    }
  }

  static Future<bool> _systemLaunch(
    String executable,
    List<String> arguments,
  ) async =>
      (await Process.run(executable, arguments, runInShell: false)).exitCode ==
      0;

  static String _stripV(String tag) =>
      tag.startsWith('v') || tag.startsWith('V') ? tag.substring(1) : tag;

  static int compareVersions(String a, String b) => versionCompare(a, b);
}
