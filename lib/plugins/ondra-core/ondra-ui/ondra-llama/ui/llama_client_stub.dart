import 'package:material_ui/material_ui.dart' show ChangeNotifier;

/// 一个已下载的本地模型。
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

/// 浏览器里的「本地模型」：什么都不做，但把原因说清楚。
class LlamaClient extends ChangeNotifier {
  String? get binary => null;
  List<LlamaModel> get models => const [];
  bool get running => false;
  bool get starting => false;
  int get port => 8080;
  String get pidLabel => '—';
  String? get runningModel => null;
  String? get lastLine => null;
  double? get progress => null;
  String get modelsDir => '（桌面构建里可用）';
  String? get error => '浏览器预览不能起本机进程；请在桌面构建里部署本地模型';

  Future<void> refresh() async {}
  Future<String?> download(
    String url, {
    void Function(double progress)? onProgress,
  }) async => error;
  Future<String?> start(LlamaModel model, {int port = 8080}) async => error;
  Future<void> stop() async {}
}

final LlamaClient llamaClient = LlamaClient();
