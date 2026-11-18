/// 崩溃记录：本地只写堆栈与版本号，不碰对话内容。
///
/// 界面与 `main` 只 import 这一行，不判断平台。
library;

export 'crash_log_stub.dart' if (dart.library.io) 'crash_log_io.dart';
