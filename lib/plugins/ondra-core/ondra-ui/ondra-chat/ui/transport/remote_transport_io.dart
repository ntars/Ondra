import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../chat_client.dart';
import 'rpc_frames.dart';

/// R3：通过 `dsh web` 的 HTTP unary RPC + `/api/remote.mux` WebSocket 连内核。
///
/// 这里只做协议与连接生命周期，不复制 UI 的业务语义。会话、模型选择、附件
/// 和取消都走官方 endpoint；远程端可以用 `dsh web` 的浏览器 cookie 认证。
class RemoteDshTransport implements DshTransport, ResumableDshTransport {
  RemoteDshTransport({
    required this.baseUrl,
    this.launchToken = '',
    this.provider = '',
    this.model = '',
    this.workingDirectory = '/',
    this.resumeSessionId,
    this.requestTimeout = const Duration(seconds: 30),
    this.turnTimeout = const Duration(minutes: 10),
    this.closeTimeout = const Duration(seconds: 5),
    HttpClient? httpClient,
  }) : _http = httpClient ?? HttpClient();

  final String baseUrl;
  final String launchToken;
  final String provider;
  final String model;
  final String workingDirectory;
  final String? resumeSessionId;
  final Duration requestTimeout;
  final Duration turnTimeout;
  final Duration closeTimeout;
  final HttpClient _http;

  final _events = StreamController<Map<String, dynamic>>.broadcast();
  final _random = Random.secure();
  WebSocket? _socket;
  StreamSubscription<dynamic>? _socketEvents;
  String? _cookie;
  String? _sessionId;
  String? _socketStreamId;
  Completer<void>? _snapshotReady;
  _RemoteTurn? _active;
  bool _connecting = false;
  bool _closed = false;
  bool _closing = false;
  bool _reconnecting = false;
  String? _lastError;
  Future<void>? _connectFuture;

  static const _muxPath = '/api/remote.mux';

  @override
  String? get modelConfigError => null;

  @override
  String? get sessionId => _sessionId ?? resumeSessionId;

  @override
  bool get isConnected =>
      !_closed && _socket?.readyState == WebSocket.open && _sessionId != null;

  String? get lastError => _lastError;

  @override
  Future<void> connect() {
    if (_closed) return Future.error(StateError('远程内核传输已释放'));
    final running = _connectFuture;
    if (running != null) return running;
    final future = _connect();
    _connectFuture = future;
    return future.whenComplete(() {
      if (identical(_connectFuture, future)) _connectFuture = null;
    });
  }

  Future<void> _connect() async {
    if (_connecting) return;
    _connecting = true;
    try {
      await _ensureAuth();
      if (_sessionId == null) {
        final value = await _rpc('session/create', {
          'cwd': workingDirectory,
          if (resumeSessionId != null) 'sessionId': resumeSessionId,
        });
        final id = value['sessionId'];
        if (id is! String || id.isEmpty) {
          throw StateError('远程内核没有返回 sessionId');
        }
        _sessionId = id;
      }
      if (provider.isNotEmpty && model.isNotEmpty) {
        await _rpc('session/selectModel', {
          'sessionId': _sessionId,
          'provider': provider,
          'model': model,
        });
      }
      await _openFollow();
      _lastError = null;
    } catch (error) {
      _lastError = '$error';
      rethrow;
    } finally {
      _connecting = false;
    }
  }

  Future<void> _ensureAuth() async {
    if (_cookie != null && _cookie!.isNotEmpty) return;
    final raw = launchToken.trim();
    if (raw.isEmpty) {
      throw StateError('远程内核缺少 launch token；请填写 dsh web 启动时打印的 URL 或 token');
    }
    final uri = Uri.tryParse(raw.contains('://') ? raw : baseUrl);
    if (uri == null || !['http', 'https'].contains(uri.scheme)) {
      throw StateError('远程内核地址必须是 HTTP(S) URL');
    }
    final token = raw.contains('://')
        ? (uri.queryParameters['token'] ?? '')
        : raw;
    if (token.isEmpty) {
      throw StateError('远程内核 launch token 不能为空');
    }
    final root = _baseUri().replace(queryParameters: {'token': token});
    final request = await _http.getUrl(root);
    request.followRedirects = false;
    final response = await request.close().timeout(requestTimeout);
    await response.drain<void>();
    final cookies = response.cookies
        .where((cookie) => cookie.name.startsWith('dsh-auth-'))
        .toList();
    if (cookies.isEmpty) {
      final status = response.statusCode;
      throw StateError(
        status == 401
            ? '远程内核认证失败；token 可能已过期，请重新打开 dsh web'
            : '远程内核没有返回认证 cookie（HTTP $status）',
      );
    }
    _cookie = cookies
        .map((cookie) => '${cookie.name}=${cookie.value}')
        .join('; ');
  }

  Future<Map<String, dynamic>> _rpc(
    String method, [
    Map<String, dynamic> request = const {},
  ]) async {
    if (_closed) throw StateError('远程内核传输已释放');
    final cookie = _cookie;
    if (cookie == null || cookie.isEmpty) {
      throw StateError('远程内核尚未认证');
    }
    final root = _baseUri().toString().replaceAll(RegExp(r'/$'), '');
    final uri = Uri.parse('$root/api/$method');
    final rpcId = _uuid();
    final message = jsonEncode({
      'type': 'client-request',
      'rpcId': rpcId,
      'method': method,
      'payload': {
        'args': {'request': request},
      },
    });
    final req = await _http.postUrl(uri).timeout(requestTimeout);
    req.headers
      ..set(HttpHeaders.contentTypeHeader, 'application/json')
      ..set(HttpHeaders.cookieHeader, cookie);
    req.add(utf8.encode(message));
    final response = await req.close().timeout(requestTimeout);
    final body = await utf8.decoder
        .bind(response)
        .join()
        .timeout(requestTimeout);
    if (response.statusCode != 200) {
      throw StateError('远程内核 $method -> HTTP ${response.statusCode}');
    }
    final decoded = jsonDecode(body);
    if (decoded is! Map<String, dynamic>) {
      throw StateError('远程内核 $method 返回了无效响应');
    }
    if (decoded['rpcId'] != rpcId) {
      throw StateError('远程内核 $method 的 rpcId 不匹配');
    }
    final result = decoded['result'];
    if (result is! Map) throw StateError('远程内核 $method 没有 result');
    if (result['ok'] != true) {
      final error = result['error'];
      final message = error is Map ? error['message'] : null;
      final code = error is Map ? error['code'] : null;
      throw StateError(
        '${message is String && message.isNotEmpty ? message : '$method 失败'}'
        '${code is String && code.isNotEmpty ? '（$code）' : ''}',
      );
    }
    final value = result['value'];
    return value is Map<String, dynamic> ? value : <String, dynamic>{};
  }

  Uri _baseUri() {
    final uri = Uri.tryParse(baseUrl.trim());
    if (uri == null ||
        !['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty) {
      throw StateError('远程内核地址必须是完整的 HTTP(S) URL');
    }
    return Uri(
      scheme: uri.scheme,
      userInfo: uri.userInfo,
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
      path: uri.path.replaceAll(RegExp(r'/+$'), ''),
    );
  }

  Future<void> _openFollow() async {
    final session = _sessionId;
    if (session == null) throw StateError('远程内核尚未创建会话');
    final uri = _baseUri();
    final socketUri = Uri(
      scheme: uri.scheme == 'https' ? 'wss' : 'ws',
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
      path: _muxPath,
    );
    final old = _socket;
    if (old != null) {
      await _socketEvents?.cancel();
      _socketEvents = null;
      try {
        await old.close();
      } catch (_) {}
    }
    final ready = Completer<void>();
    _snapshotReady = ready;
    final socket = await WebSocket.connect(
      socketUri.toString(),
      headers: {HttpHeaders.cookieHeader: _cookie!},
    ).timeout(requestTimeout);
    if (_closed) {
      await socket.close();
      throw StateError('远程内核传输已释放');
    }
    _socket = socket;
    _socketStreamId = _uuid();
    _socketEvents = socket.listen(
      _onSocketData,
      onError: (Object error, StackTrace stack) {
        _socketFailed(error);
      },
      onDone: () {
        _socketClosed(socket);
      },
      cancelOnError: false,
    );
    socket.add(
      jsonEncode({
        'type': 'open',
        'streamId': _socketStreamId,
        'endpoint': 'session/follow',
        'payload': {
          'args': {
            'request': {
              'address': {'kind': 'session', 'sessionId': session},
              'assistantStream': true,
            },
          },
        },
      }),
    );
    await ready.future.timeout(requestTimeout);
  }

  void _onSocketData(dynamic data) {
    if (_closed || _closing) return;
    if (data is! String) return;
    Object? decoded;
    try {
      decoded = jsonDecode(data);
    } catch (_) {
      return;
    }
    if (decoded is! Map<String, dynamic>) return;
    if (decoded['streamId'] != _socketStreamId) return;
    final type = decoded['type'];
    if (type == 'item') {
      final value = decoded['value'];
      if (value is! Map<String, dynamic>) return;
      final frameType = value['type'];
      if (frameType == 'snapshot') {
        final ready = _snapshotReady;
        if (ready != null && !ready.isCompleted) ready.complete();
        return;
      }
      if (frameType == 'event') {
        final event = value['event'];
        if (event is Map<String, dynamic> && !_events.isClosed) {
          _events.add({'event': event});
        }
      }
      return;
    }
    if (type == 'error') {
      final error = decoded['error'];
      final message = error is Map ? error['message'] : null;
      final code = error is Map ? error['code'] : null;
      _socketFailed(
        StateError(
          '${message is String && message.isNotEmpty ? message : '远程事件流失败'}'
          '${code is String && code.isNotEmpty ? '（$code）' : ''}',
        ),
      );
      return;
    }
    if (type == 'end') {
      _socketFailed(StateError('远程事件流已结束'));
    }
  }

  void _socketFailed(Object error) {
    if (_closed || _closing) return;
    _lastError = '$error';
    _active?.finish(error is StateError ? error : StateError('$error'));
    _active = null;
    final ready = _snapshotReady;
    if (ready != null && !ready.isCompleted) ready.completeError(error);
    _scheduleReconnect();
  }

  void _socketClosed(WebSocket socket) {
    if (!identical(_socket, socket)) return;
    _socket = null;
    _socketEvents = null;
    if (_closed || _closing) return;
    _lastError = '远程事件流已断开';
    _active?.finish(StateError('远程事件流已断开'));
    _active = null;
    final ready = _snapshotReady;
    if (ready != null && !ready.isCompleted) {
      ready.completeError(StateError('远程事件流已断开'));
    }
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed || _closing || _reconnecting || _sessionId == null) return;
    _reconnecting = true;
    unawaited(_reconnect());
  }

  Future<void> _reconnect() async {
    var delay = const Duration(milliseconds: 400);
    for (var attempt = 0; attempt < 3 && !_closed && !_closing; attempt++) {
      await Future<void>.delayed(delay);
      if (_closed || _closing) return;
      try {
        await _openFollow();
        _lastError = null;
        _reconnecting = false;
        return;
      } catch (error) {
        _lastError = '$error';
        delay *= 2;
      }
    }
    _reconnecting = false;
  }

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) {
    final controller = StreamController<String>();
    final turn = _RemoteTurn(controller);
    if (_active != null) {
      controller
        ..addError(StateError('已有一轮对话正在生成'))
        ..close();
      return controller.stream;
    }
    _active = turn;
    unawaited(_runTurn(turn, text, attachments));
    return controller.stream;
  }

  Future<void> _runTurn(
    _RemoteTurn turn,
    String text,
    List<ChatAttachment> attachments,
  ) async {
    StreamSubscription<Map<String, dynamic>>? events;
    Timer? timer;
    try {
      final content = <Map<String, dynamic>>[
        {'type': 'text', 'text': text},
      ];
      for (final attachment in attachments) {
        final mime = attachment.mimeType;
        if (mime == null) {
          throw StateError('附件发送失败：${attachment.name}（不支持的附件类型）');
        }
        final bytes = await File(attachment.path).readAsBytes();
        if (bytes.isEmpty) {
          throw StateError('附件发送失败：${attachment.name}（空文件）');
        }
        content.add({
          'type': 'image',
          'data': base64Encode(bytes),
          'mimeType': mime,
        });
      }
      await connect();
      if (turn.done) return;
      events = _events.stream.listen((payload) {
        if (turn.done || !identical(_active, turn)) {
          return;
        }
        final text = textOfSessionEvent(payload);
        if (text != null && text.isNotEmpty) turn.add(text);
        final error = errorOfSessionEvent(payload);
        if (error != null) {
          turn.finish(StateError(error));
          return;
        }
        if (isTurnEnd(payload)) turn.finish();
      });
      final session = _sessionId!;
      // WebSocket 事件可能先于 prompt 的 HTTP 响应到达；从提交这一句起就
      // 接收正文。旧轮已在 _active 检查中被隔离，不会串到新气泡。
      turn.promptSettled = true;
      await _rpc('session/prompt', {
        'requestId': _uuid(),
        'sessionId': session,
        'mode': 'queue',
        'content': content,
        'clientTimeZone': 'Asia/Shanghai',
      });
      if (turn.done) return;
      timer = Timer(turnTimeout, () {
        if (!turn.done) {
          turn.finish(TimeoutException('远程生成超时（turn/end）', turnTimeout));
        }
      });
      await turn.doneFuture;
    } catch (error, stack) {
      turn.finish(error, stack);
    } finally {
      timer?.cancel();
      await events?.cancel();
      if (identical(_active, turn)) _active = null;
    }
  }

  @override
  void stop() {
    final turn = _active;
    if (turn != null) {
      turn.finish(StateError('生成已停止'));
      _active = null;
    }
    final session = _sessionId;
    if (session != null) {
      unawaited(_cancelTurn(session));
    }
  }

  Future<void> _cancelTurn(String session) async {
    try {
      await _rpc('session/cancel', {'sessionId': session});
    } catch (_) {
      // 取消是尽力而为；正文流已经先向用户结束。
    }
  }

  @override
  void resetSession() {
    stop();
    _sessionId = null;
    _socketStreamId = null;
    final socket = _socket;
    _socket = null;
    unawaited(_socketEvents?.cancel());
    _socketEvents = null;
    if (socket != null) unawaited(socket.close());
  }

  @override
  void dispose() {
    _closed = true;
    _closing = true;
    _active?.finish(StateError('传输层已释放'));
    _active = null;
    final socket = _socket;
    _socket = null;
    unawaited(_socketEvents?.cancel());
    _socketEvents = null;
    if (socket != null) unawaited(socket.close());
    unawaited(_events.close());
    _http.close(force: true);
  }

  @override
  Future<void> close() async {
    if (_closing && _closed) return;
    _closing = true;
    _closed = true;
    _active?.finish(StateError('传输层已关闭'));
    _active = null;
    final socket = _socket;
    _socket = null;
    await _socketEvents?.cancel();
    _socketEvents = null;
    if (socket != null) {
      await socket.close().timeout(closeTimeout, onTimeout: () {});
    }
    await _events.close();
    _http.close(force: true);
  }

  @override
  Stream<StepUsage> get usage => const Stream.empty();

  String _uuid() {
    final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
    return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
        '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
  }
}

class _RemoteTurn {
  _RemoteTurn(this.controller);

  final StreamController<String> controller;
  final _done = Completer<void>();
  bool promptSettled = false;
  bool done = false;

  Future<void> get doneFuture => _done.future;

  void add(String text) {
    if (!done) controller.add(text);
  }

  void finish([Object? error, StackTrace? stack]) {
    if (done) return;
    done = true;
    if (error != null) {
      controller.addError(error, stack);
    }
    unawaited(controller.close());
    _done.complete();
  }
}
