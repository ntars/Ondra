import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart' show ChangeNotifier;
import '../../../../../app/home_dir.dart';
import 'package:flutter/services.dart' show rootBundle; // ignore: unused_import

/// 一个已下载的本地模型（GGUF）。
class LlamaModel {
  const LlamaModel({required this.name, required this.path, required this.sizeBytes});

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

/// 本地模型服务：**真的**在本机起 `llama-server`。
///
/// 职责边界：
/// - 找二进制、管模型目录、下载 GGUF、起停进程、读 `/v1/models` 判断就绪；
/// - 不管界面，也不改模型基座的配置——地址由界面填回去。
///
/// 为什么不走 Cordis 运行时：拉起子进程是平台能力（`dart:io`），
/// 运行时是 Node，两边都能做时选离用户近的那一侧，少一层转发。
class LlamaClient extends ChangeNotifier {
  static const int defaultPort = 8080;

  Process? _process;
  String? _binary;
  String? _error;
  String? _lastLine;
  String? _runningModel;
  int _port = defaultPort;
  bool _starting = false;
  double? _progress;
  List<LlamaModel> _models = const [];

  String? get binary => _binary;
  String? get error => _error;
  String? get lastLine => _lastLine;
  String? get runningModel => _runningModel;
  int get port => _port;

  /// 进程号只用于显示；进程没了就不显示。
  String get pidLabel => _process?.pid.toString() ?? '—';
  bool get running => _process != null;
  bool get starting => _starting;
  double? get progress => _progress;
  List<LlamaModel> get models => _models;

  String get modelsDir =>
      '$ondraUserHome/.ondra/models';

  /// 找 `llama-server`：显式路径 → 登录 shell → 常见安装位置。
  ///
  /// 从 Finder 启动的应用只有极简 PATH，所以必须问一次登录 shell；
  /// 这一步和 dsh 的解析同源（`ondra-chat/ui/transport/stdio_transport_io.dart`）。
  Future<String?> _resolveBinary() async {
    if (_binary != null && File(_binary!).existsSync()) return _binary;

    for (final shell in ['/bin/zsh', '/bin/bash']) {
      try {
        final result = await Process.run(shell, ['-lc', 'command -v llama-server'])
            .timeout(const Duration(seconds: 4));
        final path = (result.stdout as String).trim();
        if (result.exitCode == 0 && path.isNotEmpty && File(path).existsSync()) {
          _binary = path;
          return path;
        }
      } catch (_) {
        // 没有这个 shell 就换下一个
      }
    }
    for (final candidate in [
      '/opt/homebrew/bin/llama-server',
      '/usr/local/bin/llama-server',
      '/usr/bin/llama-server',
    ]) {
      if (File(candidate).existsSync()) {
        _binary = candidate;
        return candidate;
      }
    }
    return null;
  }

  /// 扫模型目录与二进制。目录不存在就建一个：第一次打开就能往里下载。
  Future<void> refresh() async {
    _error = null;
    final dir = Directory(modelsDir);
    if (!dir.existsSync()) {
      try {
        dir.createSync(recursive: true);
      } catch (e) {
        _error = '建不了模型目录：$e';
      }
    }
    final list = <LlamaModel>[];
    if (dir.existsSync()) {
      for (final entity in dir.listSync()) {
        if (entity is! File) continue;
        final name = entity.path.split('/').last;
        if (!name.toLowerCase().endsWith('.gguf')) continue;
        list.add(
          LlamaModel(
            name: name,
            path: entity.path,
            sizeBytes: entity.lengthSync(),
          ),
        );
      }
    }
    list.sort((a, b) => a.name.compareTo(b.name));
    _models = list;
    await _resolveBinary();
    notifyListeners();
  }

  /// 下载一个 GGUF。返回错误文案，或 null 表示成功。
  ///
  /// 先写 `.part` 再改名：中断的下载不会留下一个「看起来能用」的半截模型。
  Future<String?> download(
    String url, {
    void Function(double progress)? onProgress,
  }) async {
    final uri = Uri.tryParse(url.trim());
    if (uri == null || !uri.hasScheme) return '地址不合法，需要 http(s):// 开头';
    var name = uri.pathSegments.isEmpty ? '' : uri.pathSegments.last;
    if (name.isEmpty || !name.toLowerCase().endsWith('.gguf')) {
      return '地址要指向一个 .gguf 文件';
    }
    _error = null;
    _progress = 0;
    notifyListeners();

    final dir = Directory(modelsDir)..createSync(recursive: true);
    final target = File('${dir.path}/$name');
    final part = File('${target.path}.part');

    final client = HttpClient()..connectionTimeout = const Duration(seconds: 15);
    try {
      final request = await client.getUrl(uri);
      final response = await request.close();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return '下载失败：HTTP ${response.statusCode}';
      }
      final total = response.contentLength;
      final sink = part.openWrite();
      var received = 0;
      await for (final chunk in response) {
        sink.add(chunk);
        received += chunk.length;
        if (total > 0) {
          _progress = received / total;
          onProgress?.call(_progress!);
          notifyListeners();
        }
      }
      await sink.flush();
      await sink.close();
      await part.rename(target.path);
      _progress = null;
      await refresh();
      return null;
    } catch (e) {
      _progress = null;
      try {
        if (part.existsSync()) part.deleteSync();
      } catch (_) {}
      return '下载中断：$e';
    } finally {
      client.close(force: true);
      notifyListeners();
    }
  }

  /// 起 `llama-server`。返回错误文案，或 null 表示已就绪。
  Future<String?> start(LlamaModel model, {int port = defaultPort}) async {
    if (_process != null) return '已经有一个模型在跑，先停掉它';
    final exe = await _resolveBinary();
    if (exe == null) {
      return '没找到 llama-server：brew install llama.cpp，或在设置里指定路径';
    }
    _starting = true;
    _error = null;
    _lastLine = null;
    _port = port;
    notifyListeners();

    final Process process;
    try {
      process = await Process.start(exe, [
        '-m', model.path,
        '--host', '127.0.0.1',
        '--port', '$port',
        '-c', '8192',
        '-ngl', '999',
      ]);
    } on ProcessException catch (e) {
      _starting = false;
      return '启动失败：${e.message}';
    }
    _process = process;
    _runningModel = model.name;

    // 日志只留最后一行：界面给的是「现在怎么样」，不是一份日志文件。
    process.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (line.trim().isEmpty) return;
      _lastLine = line.trim();
      notifyListeners();
    });
    process.stderr.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
      if (line.trim().isEmpty) return;
      _lastLine = line.trim();
      notifyListeners();
    });
    unawaited(process.exitCode.then((code) {
      _process = null;
      _runningModel = null;
      _starting = false;
      _lastLine = 'llama-server 退出（code $code）';
      notifyListeners();
    }));

    // 轮询 /v1/models：进程起来不等于模型加载完，能列出模型才算就绪。
    for (var i = 0; i < 60; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 800));
      if (_process == null) {
        _starting = false;
        notifyListeners();
        return _lastLine ?? 'llama-server 已退出';
      }
      final ok = await _probe(port);
      if (ok) {
        _starting = false;
        notifyListeners();
        return null;
      }
    }
    _starting = false;
    notifyListeners();
    return '模型 48 秒内没有就绪，看看日志最后一行';
  }

  Future<bool> _probe(int port) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 1);
    try {
      final request = await client.getUrl(Uri.parse('http://127.0.0.1:$port/v1/models'));
      final response = await request.close().timeout(const Duration(seconds: 2));
      await response.drain<void>();
      return response.statusCode >= 200 && response.statusCode < 300;
    } catch (_) {
      return false;
    } finally {
      client.close(force: true);
    }
  }

  Future<void> stop() async {
    final process = _process;
    if (process == null) return;
    process.kill();
    _process = null;
    _runningModel = null;
    _starting = false;
    _lastLine = null;
    notifyListeners();
  }

  @override
  void dispose() {
    _process?.kill();
    super.dispose();
  }
}

final LlamaClient llamaClient = LlamaClient();
