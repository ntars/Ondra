/// 本机聊天验收探针：没有 Web 调试入口，桌面从显式环境变量读一次性输入。
///
/// 生产默认关闭；只有设置了 `ONDRA_SEND_TEXT` 才自动填入并提交，
/// 只有同时设置 `ONDRA_CHAT_RESULT` 才把这一轮的正文写到本机文件。
library;

export 'debug_chat_probe_stub.dart'
    if (dart.library.io) 'debug_chat_probe_io.dart';
