// 传输层的条件导出：有 dart:io 用子进程版，没有（Web）用如实报错版。
// 用注释而不是 doc comment，避免 library 指令的噪音。
export 'stdio_transport_stub.dart'
    if (dart.library.io) 'stdio_transport_io.dart';
