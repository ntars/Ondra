// 本地模型能力的条件导出：桌面用 dart:io 真跑进程，浏览器里如实报做不到。
export 'llama_client_stub.dart' if (dart.library.io) 'llama_client_io.dart';
