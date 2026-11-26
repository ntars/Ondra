import '../plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';

/// Web 不参与桌面本机验收。
String debugChatInputText() => '';

/// Web 不写本机验收文件。
void debugChatCaptureReply({
  required ChatClient client,
  required String userText,
}) {}
