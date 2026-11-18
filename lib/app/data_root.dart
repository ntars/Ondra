/// 数据根目录：界面要显示「东西存在哪」，但不能 import `dart:io`。
///
/// 与 `prefs.dart` / `keychain.dart` 同一模式：一个条件导出，两个同形实现。
///
/// 只读：真源是内核（`~/.ondra`），这里只是把它显示出来。
/// 不提供 setter —— 改它要停进程、搬库、改配置，那是一次独立操作，
/// 不是一个能被顺手调用的函数。
library;

export 'data_root_stub.dart' if (dart.library.io) 'data_root_io.dart';
