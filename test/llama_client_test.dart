import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-llama/ui/llama_client_io.dart';

// 一个小型、结构完整的 GGUF v3：单个 F32 张量，不下载或加载真实模型。
Uint8List _gguf() {
  final bytes = Uint8List(100);
  bytes.setRange(0, 4, ascii.encode('GGUF'));
  final data = ByteData.sublistView(bytes);
  data.setUint32(4, 3, Endian.little);
  data.setUint64(8, 1, Endian.little);
  data.setUint64(16, 1, Endian.little);
  data.setUint64(24, 3, Endian.little);
  bytes.setRange(32, 35, ascii.encode('key'));
  data.setUint32(35, 4, Endian.little); // uint32 metadata
  data.setUint32(39, 1, Endian.little);
  data.setUint64(43, 1, Endian.little); // tensor name
  bytes[51] = 120;
  data.setUint32(52, 1, Endian.little); // dimensions
  data.setUint64(56, 1, Endian.little);
  data.setUint32(64, 0, Endian.little); // F32
  data.setUint64(68, 0, Endian.little); // offset relative to aligned data
  data.setFloat32(96, 1, Endian.little);
  return bytes;
}

Future<int> _unusedPort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}

void main() {
  late Directory home;
  late File executable;
  late File events;
  late LlamaModel model;
  late List<LlamaClient> clients;

  setUp(() async {
    home = await Directory.systemTemp.createTemp('ondra-llama-test-');
    executable = await File(
      '${Directory.current.path}/test/support/llama_server_fixture.mjs',
    ).copy('${home.path}/llama-server');
    final chmod = await Process.run('/bin/chmod', ['+x', executable.path]);
    expect(chmod.exitCode, 0);
    events = File('${home.path}/events.jsonl');
    final modelFile = await File('${home.path}/fixture.gguf')
        .writeAsBytes(_gguf());
    model = LlamaModel(
      name: 'fixture.gguf',
      path: modelFile.path,
      sizeBytes: 100,
    );
    clients = [];
  });

  tearDown(() async {
    for (final client in clients) {
      await client.stop();
      client.dispose();
    }
    await home.delete(recursive: true);
  });

  LlamaClient client({
    String mode = 'ready',
    String? directory,
    String? binary,
    Map<String, String> environment = const {},
    Duration readyTimeout = const Duration(seconds: 2),
    Duration stopTimeout = const Duration(milliseconds: 500),
  }) {
    final c = LlamaClient(
      binaryPath: binary ?? executable.path,
      modelsDirectory: directory ?? '${home.path}/models',
      environment: {
        'LLAMA_FIXTURE_MODE': mode,
        'LLAMA_FIXTURE_EVENTS': events.path,
        ...environment,
      },
      readyTimeout: readyTimeout,
      probeInterval: const Duration(milliseconds: 20),
      requestTimeout: const Duration(milliseconds: 150),
      stopTimeout: stopTimeout,
      downloadIdleTimeout: const Duration(milliseconds: 500),
    );
    clients.add(c);
    return c;
  }

  Future<HttpServer> serve(void Function(HttpRequest) handler) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen(handler);
    addTearDown(() => server.close(force: true));
    return server;
  }

  String url(HttpServer server, [String name = 'download.gguf']) =>
      'http://127.0.0.1:${server.port}/$name';

  Future<void> expectNoPart(LlamaClient c) async {
    final dir = Directory(c.modelsDir);
    if (!await dir.exists()) return;
    final paths = await dir.list(recursive: true).map((e) => e.path).toList();
    expect(
      paths.where((p) => p.contains('.download-') || p.endsWith('.part')),
      isEmpty,
    );
    expect(c.progress, isNull);
  }

  test('匹配当前进程 alias、health 与模型列表后才就绪，stop 等到退出', () async {
    final c = client();
    expect(await c.start(model, port: await _unusedPort()), isNull);
    expect(c.running, isTrue);
    expect(c.starting, isFalse);
    expect(c.runningModel, model.name);
    expect(c.binary, executable.path);
    await c.stop();
    expect(c.running, isFalse);
    expect(c.runningModel, isNull);
    final log = await events.readAsLines();
    expect(jsonDecode(log.last)['event'], 'exited');
  });

  test('停止等待期间重新启动不会被旧退出或日志回调清空', () async {
    final c = client(environment: {'LLAMA_FIXTURE_STOP_DELAY': '160'});
    final port = await _unusedPort();
    expect(await c.start(model, port: port), isNull);
    final oldPid = c.pidLabel;
    final stopped = c.stop();
    expect(c.running, isTrue, reason: '尚未退出前不能报告已停止');
    final next = c.start(
      LlamaModel(name: 'second.gguf', path: model.path, sizeBytes: 100),
      port: port,
    );
    await stopped;
    expect(await next, isNull);
    expect(c.pidLabel, isNot(oldPid));
    expect(c.running, isTrue);
    expect(c.runningModel, 'second.gguf');
    expect(c.lastLine, isNot(contains('退出')));
    final log = (await events.readAsLines())
        .map((s) => jsonDecode(s) as Map)
        .toList();
    final oldExit = log.indexWhere((e) => e['event'] == 'exited');
    final newStart = log.lastIndexWhere((e) => e['event'] == 'started');
    expect(newStart, greaterThan(oldExit));
  });

  test('拒绝并发 start，尚未创建进程时 stop 也能取消启动', () async {
    final c = client();
    final first = c.start(model, port: await _unusedPort());
    expect(await c.start(model, port: await _unusedPort()), isNotNull);
    await c.stop();
    expect(await first, isNotNull);
    expect(c.running, isFalse);
    expect(c.starting, isFalse);
    expect(await c.start(model, port: await _unusedPort()), isNull);
  });

  test('在二进制解析前立即 stop 不遗留进程', () async {
    final c = client();
    final first = c.start(model, port: await _unusedPort());
    final stopping = c.stop();
    await stopping;
    expect(await first, contains('取消'));
    expect(c.running, isFalse);
    expect(c.starting, isFalse);
    expect(await events.exists(), isFalse);
  });

  for (final mode in [
    'html',
    'empty',
    'wrong-model',
    'loading',
    'hang',
    'exit',
    'exit-probe',
  ]) {
    test('不将 $mode 的 HTTP/进程状态误报就绪，超时回收进程', () async {
      final c = client(
        mode: mode,
        readyTimeout: const Duration(milliseconds: 450),
      );
      final result = await c.start(model, port: await _unusedPort());
      expect(result, isNotNull);
      expect(c.error, isNotNull);
      expect(c.running, isFalse);
      expect(c.starting, isFalse);
      expect(c.runningModel, isNull);
    });
  }

  test('端口上的其他 OpenAI 服务不会被误认为本次启动的模型', () async {
    final server = await serve((request) {
      request.response.write(
        jsonEncode(
          request.uri.path == '/health'
              ? {'status': 'ok'}
              : {
                  'object': 'list',
                  'data': [
                    {'object': 'model', 'id': 'other-service'},
                  ],
                },
        ),
      );
      unawaited(request.response.close());
    });
    final c = client(
      mode: 'idle',
      readyTimeout: const Duration(milliseconds: 350),
    );
    expect(await c.start(model, port: server.port), isNotNull);
    expect(c.running, isFalse);
    // stop 只终止注入子进程，不影响被占用端口上的 fixture 服务。
    final http = HttpClient();
    final response = await (await http.getUrl(Uri.parse(url(server)))).close();
    expect(response.statusCode, 200);
    await response.drain<void>();
    http.close(force: true);
  });

  test('探测中的旧成功响应不能越过 stop 的 generation', () async {
    final probe = Completer<HttpRequest>();
    final server = await serve((request) {
      if (!probe.isCompleted) probe.complete(request);
    });
    final c = client(mode: 'idle');
    final starting = c.start(model, port: server.port);
    final request = await probe.future;
    final stopped = c.stop();
    request.response.write(jsonEncode({'status': 'ok'}));
    await request.response.close();
    expect(await starting, contains('取消'));
    await stopped;
    expect(c.starting, isFalse);
    expect(c.running, isFalse);
    expect(c.runningModel, isNull);
  });

  test('忽略 SIGTERM 的子进程升级为 SIGKILL，并等待真正退出', () async {
    final c = client(
      environment: {'LLAMA_FIXTURE_IGNORE_TERM': '1'},
      stopTimeout: const Duration(milliseconds: 100),
    );
    expect(await c.start(model, port: await _unusedPort()), isNull);
    await c.stop();
    expect(c.running, isFalse);
    expect(await c.start(model, port: c.port), isNull);
  });

  test('启动失败和无效 GGUF 清除 busy，显式 binary 不回退用户安装', () async {
    final c = client(binary: '${home.path}/missing-server');
    expect(await c.start(model), contains('没找到 llama-server'));
    expect(c.starting, isFalse);
    expect(c.error, isNotNull);
    final invalid = await File(model.path)
        .writeAsString('<html>not a model</html>');
    final c2 = client();
    expect(
      await c2.start(
        LlamaModel(name: 'bad.gguf', path: invalid.path, sizeBytes: 22),
      ),
      contains('GGUF'),
    );
    expect(await events.exists(), isFalse);
    expect(c2.starting, isFalse);
  });

  test('不可执行 binary 失败有错误通知且可再次操作', () async {
    final bad = await File('${home.path}/bad-binary')
        .writeAsString('not executable');
    final c = client(binary: bad.path);
    var notifications = 0;
    c.addListener(() => notifications++);
    expect(await c.start(model), contains('启动失败'));
    expect(c.error, isNotNull);
    expect(c.starting, isFalse);
    expect(notifications, greaterThanOrEqualTo(2));
  });

  test('dispose 期间的启动及退出回调不再通知 listener', () async {
    final c = client(mode: 'loading');
    var notifications = 0;
    c.addListener(() => notifications++);
    final started = c.start(model, port: await _unusedPort());
    c.dispose();
    final count = notifications;
    expect(await started, isNotNull);
    await c.stop();
    expect(notifications, count);
    expect(c.running, isFalse);
  });

  test('有效下载先写临时文件，成功后刷新模型列表和进度', () async {
    final bytes = _gguf();
    final server = await serve((request) {
      request.response.contentLength = bytes.length;
      request.response.add(bytes);
      unawaited(request.response.close());
    });
    final c = client();
    final progress = <double>[];
    expect(await c.download(url(server), onProgress: progress.add), isNull);
    expect(await File('${c.modelsDir}/download.gguf').readAsBytes(), bytes);
    expect(c.models.single.name, 'download.gguf');
    expect(progress.last, 1);
    await expectNoPart(c);
  });

  test('非 2xx 和不完整响应均清理状态，保留已有模型并允许重试', () async {
    var status = 404;
    final server = await serve((request) {
      request.response.statusCode = status;
      request.response.add(_gguf());
      unawaited(request.response.close());
    });
    final c = client();
    await Directory(c.modelsDir).create(recursive: true);
    final target = await File('${c.modelsDir}/download.gguf')
        .writeAsBytes(_gguf());
    for (final code in [404, 500, 206]) {
      status = code;
      expect(await c.download(url(server)), contains('HTTP $code'));
      expect(c.error, isNotNull);
      expect(await target.readAsBytes(), _gguf());
      await expectNoPart(c);
    }
    status = 200;
    expect(await c.download(url(server)), isNull);
    expect(c.error, isNull);
    await expectNoPart(c);
  });

  test('拒绝 HTML、空文件、坏版本与截断 GGUF，不发布伪模型', () async {
    final wrongVersion = _gguf()..[4] = 99;
    var bytes = <int>[];
    final server = await serve((request) {
      request.response.add(bytes);
      unawaited(request.response.close());
    });
    final c = client();
    for (final content in [
      <int>[],
      utf8.encode('<html>error</html>'),
      wrongVersion,
      _gguf().sublist(0, 8),
      _gguf().sublist(0, 24),
    ]) {
      bytes = content;
      expect(await c.download(url(server)), contains('GGUF'));
      expect(await File('${c.modelsDir}/download.gguf').exists(), isFalse);
      await expectNoPart(c);
    }
  });

  test('目录创建失败及刷新错误不抛出，进度不会卡住', () async {
    final file = await File('${home.path}/not-directory')
        .writeAsString('fixture');
    final c = client(directory: '${file.path}/models');
    expect(await c.download('http://127.0.0.1:1/file.gguf'), contains('下载中断'));
    expect(c.progress, isNull);
    expect(c.error, isNotNull);
    await c.refresh();
    expect(c.error, contains('读取模型目录失败'));
    expect(c.models, isEmpty);
  });

  test('流中断和超时清理临时下载；回调异常也恢复状态', () async {
    final server = await serve((request) async {
      final socket = await request.response.detachSocket(writeHeaders: false);
      socket.add(
        ascii.encode('HTTP/1.1 200 OK\r\nContent-Length: 200\r\n\r\n'),
      );
      socket.add(_gguf().sublist(0, 24));
      await socket.flush();
      socket.destroy();
    });
    final c = client();
    expect(await c.download(url(server)), isNotNull);
    await expectNoPart(c);
    final good = await serve((request) {
      request.response.contentLength = 100;
      request.response.add(_gguf());
      unawaited(request.response.close());
    });
    expect(
      await c.download(
        url(good),
        onProgress: (_) => throw StateError('callback failed'),
      ),
      contains('callback failed'),
    );
    await expectNoPart(c);
    final stalled = await serve((_) {});
    expect(await c.download(url(stalled)), contains('TimeoutException'));
    await expectNoPart(c);
  });

  test('下载并发被拒绝，dispose 取消网络且清除临时文件', () async {
    final requested = Completer<void>();
    final server = await serve((_) => requested.complete());
    final c = client();
    final download = c.download(url(server));
    await requested.future;
    expect(await c.download(url(server)), contains('已有下载'));
    c.dispose();
    expect(await download, isNotNull);
    await expectNoPart(c);
  });

  test('下载 URL 只接受 http(s) 且文件名不能逃逸模型目录', () async {
    final c = client();
    for (final url in [
      'file:///tmp/a.gguf',
      'ftp://127.0.0.1/a.gguf',
      'http://127.0.0.1/model',
      'http://127.0.0.1/a%2fb.gguf',
      'http://127.0.0.1/a%5cb.gguf',
      'http://127.0.0.1/%FF.gguf',
    ]) {
      expect(await c.download(url), isNotNull);
      expect(c.progress, isNull);
    }
    expect(await Directory(c.modelsDir).exists(), isFalse);
  });
}
