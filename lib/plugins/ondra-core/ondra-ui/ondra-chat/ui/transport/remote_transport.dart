// R3 远程内核的条件导出：移动端/桌面用 dart:io 的 HTTP + WebSocket，
// 浏览器里没有可用的宿主传输时如实报错。
export 'remote_transport_stub.dart'
    if (dart.library.io) 'remote_transport_io.dart';
