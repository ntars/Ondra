/// 探测结果：成功时带模型 id 列表，失败时带原因。
class LocalProbeResult {
  const LocalProbeResult({this.ok = false, this.models = const [], this.error});

  final bool ok;
  final List<String> models;
  final String? error;
}

/// 浏览器不能直接连本机端口（跨域 + 没有原生 socket），如实说清楚，不假装。
Future<LocalProbeResult> probeOpenAiEndpoint(
  String baseUrl, {
  String? apiKey,
  String protocol = 'openai-completions',
}) async {
  return const LocalProbeResult(error: '浏览器预览无法探测本机端口；请在桌面构建里检测');
}
