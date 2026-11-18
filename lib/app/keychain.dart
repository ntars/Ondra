/// 密钥存放：桌面端写系统钥匙串，其余环境如实说明做不到。
///
/// 与 `prefs.dart` 同一个模式：一个条件导出，两个同形实现。
/// 页面只 import 这一行，不判断平台。
library;

export 'keychain_stub.dart' if (dart.library.io) 'keychain_io.dart';
