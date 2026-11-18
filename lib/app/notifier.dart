/// 系统通知：任务完成、出错时提醒。
///
/// 界面只 import 这一行，不判断平台——与 `prefs.dart` 同一模式。
///
/// **为什么单独一层**：发通知是平台能力（macOS 走通知中心），
/// 不是内核配置。写进 `settings.json` 不会让系统弹出任何东西。
library;

export 'notifier_stub.dart' if (dart.library.io) 'notifier_io.dart';
