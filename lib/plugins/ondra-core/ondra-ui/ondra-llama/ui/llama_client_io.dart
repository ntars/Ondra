import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show ChangeNotifier;

import '../../../../../app/home_dir.dart';

/// 一个已下载的本地模型（GGUF）。
class LlamaModel {
  const LlamaModel({
    required this.name,
    required this.path,
    required this.sizeBytes,
  });

  final String name;
  final String path;
  final int sizeBytes;

  String get sizeLabel {
    if (sizeBytes <= 0) return '—';
    final gb = sizeBytes / (1024 * 1024 * 1024);
    if (gb >= 1) return '${gb.toStringAsFixed(1)} GB';
    return '${(sizeBytes / (1024 * 1024)).toStringAsFixed(0)} MB';
  }
}

/// 只管理自己启动的 llama-server；二进制、环境、目录可注入以隔离测试。
class LlamaClient extends ChangeNotifier {
  LlamaClient({
    String? binaryPath,
    this.modelsDirectory,
    Map<String, String>? environment,
    this.readyTimeout = const Duration(seconds: 48),
    this.probeInterval = const Duration(milliseconds: 800),
    this.requestTimeout = const Duration(seconds: 2),
    this.stopTimeout = const Duration(seconds: 3),
    this.downloadIdleTimeout = const Duration(seconds: 30),
  }) : _explicitBinary = binaryPath,
       _environment = environment == null
           ? null
           : Map.unmodifiable(environment);

  static const int defaultPort = 8080;
  final String? _explicitBinary;
  final String? modelsDirectory;
  final Map<String, String>? _environment;
  final Duration readyTimeout;
  final Duration probeInterval;
  final Duration requestTimeout;
  final Duration stopTimeout;
  final Duration downloadIdleTimeout;

  Process? _process;
  String? _binary;
  String? _error;
  String? _lastLine;
  String? _runningModel;
  int _port = defaultPort;
  bool _starting = false;
  bool _disposed = false;
  int _generation = 0;
  int _refreshGeneration = 0;
  Future<String?>? _startTask;
  Future<void>? _stopTask;
  Completer<void>? _cancelStart;
  HttpClient? _downloadClient;
  double? _progress;
  List<LlamaModel> _models = const [];

  String? get binary => _binary;
  String? get error => _error;
  String? get lastLine => _lastLine;
  String? get runningModel => _runningModel;
  int get port => _port;
  String get pidLabel => _process?.pid.toString() ?? '—';
  bool get running => _process != null;
  bool get starting => _starting;
  double? get progress => _progress;
  List<LlamaModel> get models => _models;
  String get modelsDir => modelsDirectory ?? '$ondraUserHome/.ondra/models';

  void _emit() {
    if (!_disposed) notifyListeners();
  }

  bool _current(int generation) => !_disposed && generation == _generation;

  Future<String?> _resolveBinary() async {
    // 显式路径无效时不能悄悄改用用户机器上的服务。
    if (_explicitBinary != null) {
      _binary = await File(_explicitBinary).exists() ? _explicitBinary : null;
      return _binary;
    }
    if (_binary != null && await File(_binary!).exists()) return _binary;
    _binary = null;
    // Windows：显式 PATH 探测（alpha.10 审查第 27 项：默认只试 Unix shell
    // 与 Unix 固定路径，失败提示还是 brew install）。where.exe 是 cmd 的
    // 标准工具，PATH 里装了 llama-server.exe 一定能找到。
    if (Platform.isWindows) {
      // where.exe 在中文 Windows 上用系统 OEM 代码页输出「找不到…」；按
      // UTF-8 解码会抛 FormatException，把已经扫到的 GGUF 列表一起毁掉。
      // 这里只关心退出码和路径，交给系统编码并兜住解码/启动异常。
      try {
        final where = await Process.run('where', ['llama-server.exe'],
            stdoutEncoding: systemEncoding, stderrEncoding: systemEncoding);
        if (where.exitCode == 0) {
          final first = (where.stdout as String)
              .split('\n')
              .map((s) => s.trim())
              .where((s) => s.isNotEmpty)
              .firstOrNull;
          if (first != null && await File(first).exists()) {
            return _binary = first;
          }
        }
      } catch (_) {
        // 没有 where / 输出解码失败都只意味着「没有本机服务端」，
        // 不能让模型目录列表跟着失败。
      }
    }
    for (final shell in ['/bin/zsh', '/bin/bash']) {
      try {
        final result = await Process.run(shell, [
          '-lc',
          'command -v llama-server',
        ],
        // Windows 检测走 git-bash 时，路径可能含中文目录；显式 UTF-8。
        stdoutEncoding: utf8,
        stderrEncoding: utf8,
        environment: _environment).timeout(const Duration(seconds: 4));
        final path = (result.stdout as String).trim();
        if (result.exitCode == 0 &&
            path.isNotEmpty &&
            await File(path).exists()) {
          return _binary = path;
        }
      } catch (_) {
        // 没有这个 shell 就换下一个。
      }
    }
    for (final candidate in [
      '/opt/homebrew/bin/llama-server',
      '/usr/local/bin/llama-server',
      '/usr/bin/llama-server',
    ]) {
      if (await File(candidate).exists()) return _binary = candidate;
    }
    return null;
  }

  Future<List<LlamaModel>> _scanModels() async {
    final dir = await Directory(modelsDir).create(recursive: true);
    final list = <LlamaModel>[];
    await for (final entity in dir.list()) {
      if (entity is! File) continue;
      final name = entity.uri.pathSegments.last;
      if (!name.toLowerCase().endsWith('.gguf')) continue;
      list.add(
        LlamaModel(
          name: name,
          path: entity.path,
          sizeBytes: await entity.length(),
        ),
      );
    }
    list.sort((a, b) => a.name.compareTo(b.name));
    return List.unmodifiable(list);
  }

  Future<void> refresh() async {
    if (_disposed) return;
    final generation = ++_refreshGeneration;
    try {
      final list = await _scanModels();
      await _resolveBinary();
      if (_disposed || generation != _refreshGeneration) return;
      _models = list;
      _error = null;
    } catch (e) {
      if (_disposed || generation != _refreshGeneration) return;
      _error = '读取模型目录失败：$e';
    }
    _emit();
  }

  /// 有界的 GGUF 头校验；张量内容是否能加载仍由 llama-server 验证。
  Future<void> _validateGguf(File file) async {
    final handle = await file.open();
    try {
      final size = await handle.length();
      final bytes = await handle.read(24);
      if (bytes.length != 24 ||
          ascii.decode(bytes.take(4).toList(), allowInvalid: true) != 'GGUF') {
        throw const FormatException('不是有效的 GGUF 文件（文件头缺失或被截断）');
      }
      final header = ByteData.sublistView(bytes);
      final version = header.getUint32(4, Endian.little);
      final tensors = header.getUint64(8, Endian.little);
      final metadata = header.getUint64(16, Endian.little);
      if (version != 2 && version != 3) {
        throw FormatException('不支持的 GGUF 版本：$version');
      }
      // 每个张量描述至少 32 字节、元数据项至少 12 字节；先排除明显残缺的下载。
      if (tensors <= 0 ||
          metadata < 0 ||
          tensors > (size - 24) ~/ 32 ||
          metadata > (size - 24 - tensors * 32) ~/ 12) {
        throw const FormatException('GGUF 张量或元数据不完整');
      }
    } finally {
      await handle.close();
    }
  }

  /// 每次下载用独立临时目录，完整写入并校验后才原子替换目标。
  Future<String?> download(
    String url, {
    void Function(double progress)? onProgress,
  }) async {
    if (_disposed) return '客户端已关闭';
    if (_progress != null) return '已有下载正在进行';
    final uri = Uri.tryParse(url.trim());
    if (uri == null ||
        !['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty) {
      return '地址不合法，需要 http(s):// 开头';
    }
    final String name;
    try {
      name = uri.pathSegments.isEmpty ? '' : uri.pathSegments.last;
    } on FormatException {
      return '地址里的文件名编码不合法';
    }
    if (!name.toLowerCase().endsWith('.gguf') ||
        name.contains('/') ||
        name.contains('\\')) {
      return '地址要指向一个 .gguf 文件';
    }
    _error = null;
    _progress = 0;
    Directory? temporary;
    RandomAccessFile? output;
    final client = HttpClient()..connectionTimeout = downloadIdleTimeout;
    _downloadClient = client;
    _emit();
    try {
      final dir = await Directory(modelsDir).create(recursive: true);
      temporary = await dir.createTemp('.download-');
      final part = File('${temporary.path}/model.part');
      final request = await client.getUrl(uri).timeout(downloadIdleTimeout);
      final response = await request.close().timeout(downloadIdleTimeout);
      // 未请求 Range；206 不能当成完整模型接受。
      if (response.statusCode != HttpStatus.ok) {
        throw HttpException('下载失败：HTTP ${response.statusCode}', uri: uri);
      }
      output = await part.open(mode: FileMode.write);
      final total = response.contentLength;
      var received = 0;
      await for (final chunk in response.timeout(downloadIdleTimeout)) {
        await output.writeFrom(chunk);
        received += chunk.length;
        if (_disposed) throw const HttpException('下载已取消');
        if (total > 0) {
          _progress = (received / total).clamp(0, 1);
          onProgress?.call(_progress!);
          _emit();
        }
      }
      await output.close();
      output = null;
      if (total >= 0 && received != total) throw const HttpException('下载文件不完整');
      await _validateGguf(part);
      if (_disposed) throw const HttpException('下载已取消');
      await part.rename('${dir.path}/$name');
      _models = await _scanModels();
      return null;
    } catch (e) {
      return _error = '下载中断：$e';
    } finally {
      client.close(force: true);
      _downloadClient = null;
      try {
        await output?.close();
      } catch (_) {}
      try {
        await temporary?.delete(recursive: true);
      } catch (_) {}
      _progress = null;
      _emit();
    }
  }

  Future<String?> start(LlamaModel model, {int port = defaultPort}) async {
    if (_stopTask != null) await _stopTask;
    if (_disposed) return '客户端已关闭';
    if (_startTask != null || _process != null) return '已经有一个模型在启动或运行，先停掉它';
    if (port < 1 || port > 65535) return '端口必须在 1–65535 之间';
    final generation = ++_generation;
    _cancelStart = Completer<void>();
    _starting = true;
    _error = null;
    _lastLine = null;
    _port = port;
    final task = _start(model, port, generation, _cancelStart!.future);
    _startTask = task;
    _emit();
    try {
      return await task;
    } finally {
      if (identical(_startTask, task)) _startTask = null;
      if (_current(generation)) {
        _starting = false;
        _emit();
      }
    }
  }

  Future<String?> _start(
    LlamaModel model,
    int port,
    int generation,
    Future<void> cancelled,
  ) async {
    Process? process;
    try {
      await _validateGguf(File(model.path));
      if (!_current(generation)) return '启动已取消';
      final exe = await _resolveBinary();
      if (!_current(generation)) return '启动已取消';
      if (exe == null) {
        throw StateError('没找到 llama-server：brew install llama.cpp，或指定二进制路径');
      }
      // 唯一 alias 将探测结果绑定到本次进程，而不是碰巧占着同一端口的服务。
      final alias =
          'ondra-$pid-$generation-${DateTime.now().microsecondsSinceEpoch}';
      process = await Process.start(exe, [
        '-m',
        model.path,
        '--alias',
        alias,
        '--host',
        '127.0.0.1',
        '--port',
        '$port',
        '-c',
        '8192',
        '-ngl',
        '999',
      ], environment: _environment);
      if (!_current(generation)) {
        await _terminate(process);
        return '启动已取消';
      }
      _process = process;
      _runningModel = model.name;
      void line(String line) {
        if (!_current(generation) ||
            !identical(_process, process) ||
            line.trim().isEmpty) {
          return;
        }
        _lastLine = line.trim();
        _emit();
      }

      for (final stream in [process.stdout, process.stderr]) {
        stream
            .transform(const Utf8Decoder(allowMalformed: true))
            .transform(const LineSplitter())
            .listen(
              line,
              onError: (Object error) {
                line('读取 llama-server 输出失败：$error');
              },
            );
      }
      unawaited(
        process.exitCode.then((code) {
          if (!_current(generation) || !identical(_process, process)) return;
          _process = null;
          _runningModel = null;
          _starting = false;
          _error = _lastLine = 'llama-server 退出（code $code）';
          _emit();
        }),
      );
      _emit();
      final clock = Stopwatch()..start();
      while (clock.elapsed < readyTimeout) {
        if (!_current(generation)) return '启动已取消';
        if (!identical(_process, process)) {
          throw StateError(_lastLine ?? 'llama-server 已退出');
        }
        final ready = await _probe(port, alias);
        if (!_current(generation)) return '启动已取消';
        if (!identical(_process, process)) {
          throw StateError(_lastLine ?? 'llama-server 已退出');
        }
        if (ready) return null;
        await Future.any([Future<void>.delayed(probeInterval), cancelled]);
      }
      throw TimeoutException(
        '模型未在 ${readyTimeout.inSeconds} 秒内就绪；${_lastLine ?? '没有服务日志'}',
      );
    } catch (e) {
      if (process != null) {
        try {
          await _terminate(process);
          if (identical(_process, process)) {
            _process = null;
            _runningModel = null;
          }
        } catch (stopError) {
          if (_current(generation)) return _error = '启动失败：$e；停止失败：$stopError';
        }
      }
      if (!_current(generation)) return '启动已取消';
      return _error = '启动失败：$e';
    }
  }

  Future<Object?> _json(HttpClient client, int port, String path) async {
    final request = await client.getUrl(
      Uri.parse('http://127.0.0.1:$port$path'),
    );
    final response = await request.close();
    if (response.statusCode != HttpStatus.ok) return null;
    final bytes = <int>[];
    await for (final chunk in response) {
      bytes.addAll(chunk);
      if (bytes.length > 1024 * 1024) return null;
    }
    return jsonDecode(utf8.decode(bytes));
  }

  Future<bool> _probe(int port, String alias) async {
    final client = HttpClient()
      ..connectionTimeout = requestTimeout
      ..findProxy = (_) => 'DIRECT';
    try {
      return await (() async {
        final health = await _json(client, port, '/health');
        if (health is! Map || health['status'] != 'ok') return false;
        final models = await _json(client, port, '/v1/models');
        if (models is! Map ||
            models['object'] != 'list' ||
            models['data'] is! List) {
          return false;
        }
        return (models['data'] as List).any(
          (model) =>
              model is Map &&
              model['object'] == 'model' &&
              model['id'] == alias,
        );
      })().timeout(requestTimeout);
    } catch (_) {
      return false;
    } finally {
      client.close(force: true);
    }
  }

  Future<void> _terminate(Process process) async {
    process.kill();
    try {
      await process.exitCode.timeout(stopTimeout);
    } on TimeoutException {
      process.kill(ProcessSignal.sigkill);
      await process.exitCode.timeout(stopTimeout);
    }
  }

  Future<void> stop() {
    if (_stopTask != null) return _stopTask!;
    ++_generation;
    if (_cancelStart != null && !_cancelStart!.isCompleted) {
      _cancelStart!.complete();
    }
    final task = _stop();
    _stopTask = task.whenComplete(() => _stopTask = null);
    return _stopTask!;
  }

  Future<void> _stop() async {
    final process = _process;
    final pending = _startTask;
    try {
      if (process != null) await _terminate(process);
      // Process.start 也可能尚未返回；它完成后会看到 generation 失效并回收子进程。
      await pending;
      _process = null;
      _runningModel = null;
      _lastLine = null;
    } catch (e) {
      _error = '停止失败：$e';
    } finally {
      _starting = false;
      _emit();
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _downloadClient?.close(force: true);
    unawaited(stop());
    super.dispose();
  }
}

final LlamaClient llamaClient = LlamaClient();
