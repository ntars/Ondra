// 本地端点的连通性探测：有 dart:io 用真实请求，浏览器里如实说明做不到。
export 'probe_stub.dart' if (dart.library.io) 'probe_io.dart';
