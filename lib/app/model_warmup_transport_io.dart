import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'model_warmup_controller.dart';

/// 发一个最小生成请求，触发 LM Studio / MLX 的首次图编译。
///
/// 先查 `/models` 是为了把“服务没开/模型没加载”与“生成失败”分开；
/// 随后用 `max_tokens: 1` 只编译图，不依赖回答内容。超时留足 90 秒，
/// 避免 20 秒形状重编译被短连接超时误杀。
Future<ModelWarmupResult> warmupOpenAiCompatibleModel(
  ModelWarmupRequest request,
) async {
  final base = request.baseUrl.trim().replaceFirst(RegExp(r'/+$'), '');
  final baseUri = Uri.tryParse(base);
  if (baseUri == null ||
      !['http', 'https'].contains(baseUri.scheme) ||
      baseUri.host.isEmpty) {
    throw const FormatException('模型地址无效，无法预热');
  }

  final client = HttpClient()..connectionTimeout = const Duration(seconds: 3);
  try {
    final models = await _getJson(client, Uri.parse('$base/models'), request);
    final data = models['data'];
    final ids = data is List
        ? data
              .whereType<Map>()
              .map((item) => '${item['id'] ?? ''}')
              .where((id) => id.isNotEmpty)
              .toSet()
        : <String>{};
    if (!ids.contains(request.model)) {
      throw StateError('模型未加载：${request.model}');
    }

    final started = Stopwatch()..start();
    await _postJson(
      client,
      Uri.parse('$base/chat/completions'),
      {
        'model': request.model,
        'messages': [
          {'role': 'user', 'content': 'ok'},
        ],
        'max_tokens': 1,
        'stream': false,
      },
      request,
    );
    // 响应体已经读完；生成本身成功即可，答案内容不是验收对象。
    return ModelWarmupResult(started.elapsed);
  } finally {
    client.close(force: true);
  }
}

Future<Map<String, dynamic>> _getJson(
  HttpClient client,
  Uri uri,
  ModelWarmupRequest request,
) async {
  final response = await client
      .getUrl(uri)
      .then((value) => _withHeaders(value, request))
      .then((value) => value.close())
      .timeout(const Duration(seconds: 10));
  return _decode(response, uri);
}

Future<Map<String, dynamic>> _postJson(
  HttpClient client,
  Uri uri,
  Map<String, Object?> body,
  ModelWarmupRequest request,
) async {
  final outgoing = await client.openUrl('POST', uri);
  outgoing.headers.contentType = ContentType.json;
  _applyHeaders(outgoing, request);
  outgoing.write(jsonEncode(body));
  final response = await outgoing.close().timeout(const Duration(seconds: 90));
  return _decode(response, uri);
}

Future<HttpClientRequest> _withHeaders(
  HttpClientRequest request,
  ModelWarmupRequest warmup,
) async {
  _applyHeaders(request, warmup);
  return request;
}

void _applyHeaders(HttpClientRequest request, ModelWarmupRequest warmup) {
  final key = warmup.apiKey?.trim();
  if (key != null && key.isNotEmpty) {
    request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $key');
  }
}

Future<Map<String, dynamic>> _decode(
  HttpClientResponse response,
  Uri uri,
) async {
  final body = await utf8.decoder.bind(response).join();
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw HttpException('${uri.path} -> HTTP ${response.statusCode}', uri: uri);
  }
  final decoded = jsonDecode(body);
  if (decoded is! Map) throw FormatException('${uri.path} 返回的不是 JSON 对象');
  return Map<String, dynamic>.from(decoded);
}
