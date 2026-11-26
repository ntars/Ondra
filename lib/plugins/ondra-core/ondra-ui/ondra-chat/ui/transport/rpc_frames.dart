import 'dart:convert';

import '../chat_client.dart' show TokenUsage;

/// DSH SDK 按换行分帧的 JSON-RPC 2.0 编解码。
class RpcFrame {
  const RpcFrame({this.id, this.method, this.params, this.result, this.error});

  final int? id;
  final String? method;
  final Map<String, dynamic>? params;
  final Map<String, dynamic>? result;
  final Map<String, dynamic>? error;

  bool get isResponse => id != null && method == null;
  bool get isNotification => id == null && method != null;
  bool get isRequest => id != null && method != null;

  static RpcFrame? decode(String line) {
    final trimmed = line.trim();
    if (trimmed.isEmpty) return null;
    final Object? json;
    try {
      json = jsonDecode(trimmed);
    } catch (_) {
      return null; // 坏行忽略：一行坏不该拖垮整条流
    }
    if (json is! Map<String, dynamic>) return null;
    if (json.containsKey('method') && json['method'] is! String) return null;
    Map<String, dynamic>? asMap(Object? v) =>
        v is Map<String, dynamic> ? v : null;
    return RpcFrame(
      id: json['id'] is int ? json['id'] as int : null,
      method: json['method'] as String?,
      params: asMap(json['params']),
      result: asMap(json['result']),
      error: asMap(json['error']),
    );
  }

  static String encodeRequest(
    int id,
    String method, [
    Map<String, dynamic>? params,
  ]) {
    return jsonEncode({
      'jsonrpc': '2.0',
      'id': id,
      'method': method,
      'params': ?params,
    });
  }
}

/// 从 `session.event` 的 payload 里取可显示的文本。
///
/// 真实协议没有 token 增量：只有 `assistant/message` 是完整正文。
/// 正文位置固定为 `event.data.message.content[]`，且只取 `type == 'text'`。
/// 其余事件与字段一律跳过——宁可少显示一句，也不要把内部结构打到界面上。
String? textOfSessionEvent(Map<String, dynamic> payload) {
  final event = payload['event'];
  if (event is! Map) return null;
  if (event['type'] != 'assistant/message') return null;
  final data = event['data'];
  if (data is! Map) return null;
  final message = data['message'];
  if (message is! Map) return null;
  final blocks = message['content'];
  if (blocks is! List) return null;
  return _textOfBlocks(blocks);
}

/// 把 `[{type:'text', text:'…'}, {type:'reasoning', …}]` 里的正文拼起来。
///
/// **只取 text 块**：reasoning 是模型的思考过程，不属于回答正文；
/// 混进来会让右栏出现用户没要的那一段。
String? _textOfBlocks(List blocks) {
  final buffer = StringBuffer();
  for (final block in blocks) {
    if (block is Map && block['type'] == 'text' && block['text'] is String) {
      buffer.write(block['text']);
    }
  }
  return buffer.isEmpty ? null : buffer.toString();
}

/// 这一轮结束了吗（`turn/end`）。
bool isTurnEnd(Map<String, dynamic> payload) {
  final event = payload['event'];
  return event is Map && event['type'] == 'turn/end';
}

/// 只从 turn/end 的 error reason 提取失败，不把错误或推理当作正文。
String? errorOfSessionEvent(Map<String, dynamic> payload) {
  if (!isTurnEnd(payload)) return null;
  final event = payload['event'] as Map;
  final data = event['data'];
  if (data is! Map) return null;
  final reason = data['reason'];
  if (reason is! Map || reason['kind'] != 'error') return null;
  final error = reason['error'];
  final message = error is Map ? error['message'] : null;
  final code = error is Map ? error['code'] : null;
  // pi-ai 的上下文超限是正常的输入错误，不是「未知错误」。把它翻译成
  // 用户能采取动作的文案；其它错误仍原样透出，避免吞掉排障信息。
  final description = code == 'CONTEXT_WINDOW_EXCEEDED'
      ? '上下文超限，请缩短输入或开启新会话'
      : message is String && message.trim().isNotEmpty
      ? message
      : '内核生成失败';
  return '$description${code is String || code is num ? '（$code）' : ''}';
}

/// `session.event` 里的事件类型，取不到返回 null。
String? sessionEventType(Map<String, dynamic> payload) {
  final event = payload['event'];
  if (event is! Map) return null;
  final type = event['type'];
  return type is String ? type : null;
}

/// 事件的时刻。上游写 ISO 8601 字符串；也给毫秒整数留一条路。
DateTime? sessionEventTime(Map<String, dynamic> payload) {
  final event = payload['event'];
  if (event is! Map) return null;
  return _asTime(event['time']);
}

DateTime? _asTime(Object? raw) {
  if (raw is String) return DateTime.tryParse(raw);
  if (raw is int) {
    // 10 位是秒、13 位是毫秒，两种都见过，按量级判断而不是猜。
    return DateTime.fromMillisecondsSinceEpoch(
      raw > 100000000000 ? raw : raw * 1000,
    );
  }
  return null;
}

/// 从 `assistant/message` 里取 token 记账。
///
/// 上游把 usage 挂在 assistant 消息事件上（不是独立的 usage 记录），
/// 且 `inputTokens` 只含**未命中**的输入。取不到就返回 null——宁可这一行
/// 不显示，也不要把 0 当成真实用量画到界面上。
TokenUsage? usageOfSessionEvent(Map<String, dynamic> payload) {
  final event = payload['event'];
  if (event is! Map) return null;
  Map? usage;
  // 兼容事件、data、message 与真实 SDK 的 data.message 四种层级。
  if (event['usage'] is Map) {
    usage = event['usage'] as Map;
  } else if (event['data'] is Map && (event['data'] as Map)['usage'] is Map) {
    usage = (event['data'] as Map)['usage'] as Map;
  } else if (event['message'] is Map &&
      (event['message'] as Map)['usage'] is Map) {
    usage = (event['message'] as Map)['usage'] as Map;
  } else {
    final data = event['data'];
    final message = data is Map ? data['message'] : null;
    if (message is Map && message['usage'] is Map) {
      usage = message['usage'] as Map;
    }
  }
  if (usage == null) return null;

  int? asInt(Object? v) => v is num ? v.toInt() : null;
  final output = asInt(usage['outputTokens']);
  final input = asInt(usage['inputTokens']);
  if (output == null || input == null) return null;

  return TokenUsage(
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: asInt(usage['cacheReadTokens']) ?? 0,
    cacheWriteTokens: asInt(usage['cacheWriteTokens']) ?? 0,
    reasoningTokens: asInt(usage['reasoningTokens']) ?? 0,
    totalTokens: asInt(usage['totalTokens']),
  );
}
