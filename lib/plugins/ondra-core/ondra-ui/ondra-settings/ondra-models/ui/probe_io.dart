import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'probe_stub.dart' show LocalProbeResult;

/// 探测一个 OpenAI 兼容端点有没有起来：GET `{base}/models`。
///
/// llama-server / Ollama / LM Studio / LiteLLM 都实现了这个路由，所以一个探测
/// 覆盖整个「本地部署 + 本地网关」两类。**只读，不改状态**：连不上就是连不上，
/// 不重试、不猜端口。
Future<LocalProbeResult> probeOpenAiEndpoint(
  String baseUrl, {
  String? apiKey,
  String protocol = 'openai-completions',
}) async {
  final base = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
  if (base.isEmpty) {
    return const LocalProbeResult(error: '先填地址');
  }
  final uri = Uri.tryParse('$base/models');
  if (uri == null ||
      !['http', 'https'].contains(uri.scheme) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment) {
    return const LocalProbeResult(error: '地址不合法，需要 http:// 或 https:// 开头');
  }

  final client = HttpClient()..connectionTimeout = const Duration(seconds: 2);
  try {
    final request = await client
        .getUrl(uri)
        .timeout(const Duration(seconds: 3));
    request.followRedirects = false;
    if (protocol == 'anthropic-messages') {
      request.headers.set('anthropic-version', '2023-06-01');
      if (apiKey != null && apiKey.isNotEmpty) {
        request.headers.set('x-api-key', apiKey);
      }
    } else if (apiKey != null && apiKey.isNotEmpty) {
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $apiKey');
    }
    final response = await request.close().timeout(const Duration(seconds: 5));
    final body = await response
        .transform(utf8.decoder)
        .join()
        .timeout(const Duration(seconds: 5));
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return LocalProbeResult(error: 'HTTP ${response.statusCode}');
    }
    final json = jsonDecode(body);
    if (json is! Map) return const LocalProbeResult(error: '返回格式不是 JSON 对象');
    final list = json['data'];
    if (list is! List) return const LocalProbeResult(error: '没有 data 字段');
    final ids = <String>[
      for (final item in list)
        if (item is Map && item['id'] is String) item['id'] as String,
    ];
    return LocalProbeResult(ok: true, models: ids);
  } on TimeoutException {
    return const LocalProbeResult(error: '连接超时：端点没有响应');
  } on SocketException catch (e) {
    return LocalProbeResult(error: '连不上：${e.osError?.message ?? e.message}');
  } catch (e) {
    return LocalProbeResult(error: '$e');
  } finally {
    client.close(force: true);
  }
}
