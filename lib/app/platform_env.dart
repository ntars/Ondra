/// 进程环境变量的平台安全读取。
///
/// Web 上 `dart:io.Platform` 的任何 getter 都会抛 Unsupported operation，
/// 而 ModelClient 在首帧构造时就读取网关地址与密钥；这里按平台分流，
/// 浏览器只返回 null，不碰 Platform。
library;

export 'platform_env_stub.dart' if (dart.library.io) 'platform_env_io.dart';
