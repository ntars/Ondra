import 'dart:convert';

import '../chat_client.dart' show TokenUsage;

/// DSH SDK 的线格式：**按换行分帧的 JSON-RPC 2.0**。
///
/// 上游 `dsh-sdk-protocol` 的口径：带 `id` + `method` 是请求，只有 `id` 是响应，
/// 只有 `method` 是通知；格式错误的行直接忽略。这里只做编解码，不碰 IO——
/// 编解码可以单测，进程与流不行。
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

  static String encodeRequest(int id, String method, [Map<String, dynamic>? params]) {
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
/// 上游的事件词汇很多（turn/start、tool/call、assistant/*…），这里**只认带文本的**，
/// 其余一律跳过——宁可少显示一句，也不要把内部结构打到界面上。
String? textOfSessionEvent(Map<String, dynamic> payload) {
  final event = payload['event'];
  if (event is! Map) return null;
  final type = event['type'];
  if (type is! String) return null;
  if (!type.contains('assistant') && !type.contains('text')) return null;

  final direct = event['text'];
  if (direct is String && direct.isNotEmpty) return direct;

  final delta = event['delta'];
  if (delta is String && delta.isNotEmpty) return delta;

  final content = event['content'];
  if (content is List) {
    final joined = _textOfBlocks(content);
    if (joined != null) return joined;
  }

  // 真机形态（dsh 0.2.2-rc.3）：正文在 `event.data.message.content` 里。
  // 内核**没有文本增量事件**——一步结束时给一条 `assistant/message`，
  // 整段正文就在里面。所以界面看到的是「一步一段」，不是逐字流；
  // 这是协议就这么给，不是这里偷懒少解析了一层。
  final data = event['data'];
  if (data is Map) {
    final message = data['message'];
    if (message is Map) {
      final blocks = message['content'];
      if (blocks is List) {
        final joined = _textOfBlocks(blocks);
        if (joined != null) return joined;
      }
    }
    final dataDelta = data['delta'];
    if (dataDelta is String && dataDelta.isNotEmpty) return dataDelta;
  }
  return null;
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
    return DateTime.fromMillisecondsSinceEpoch(raw > 100000000000 ? raw : raw * 1000);
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
  // 三种嵌套都可能：事件本身、包一层 data、以及挂在 message 上。
  if (event['usage'] is Map) {
    usage = event['usage'] as Map;
  } else if (event['data'] is Map && (event['data'] as Map)['usage'] is Map) {
    usage = (event['data'] as Map)['usage'] as Map;
  } else if (event['message'] is Map && (event['message'] as Map)['usage'] is Map) {
    usage = (event['message'] as Map)['usage'] as Map;
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
