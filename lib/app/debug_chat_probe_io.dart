import 'dart:io';

import '../plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'platform_env.dart';

/// 显式指定的自动发送文本；未设置时普通启动完全不受影响。
String debugChatInputText() => ondraPlatformEnv('ONDRA_SEND_TEXT') ?? '';

/// 一次监听当前轮次，在 assistant 正文到位后写一份本机验收文件。
void debugChatCaptureReply({
  required ChatClient client,
  required String userText,
}) {
  final resultPath = ondraPlatformEnv('ONDRA_CHAT_RESULT') ?? '';
  if (resultPath.isEmpty || client.busy || client.queued.isNotEmpty) return;
  String? writtenText;
  var detached = false;
  void listener() {
    if (detached) return;
    if (client.busy) return;
    final messages = client.messages;
    final userIndex = messages.lastIndexWhere(
      (message) => message.role == ChatRole.user && message.text == userText,
    );
    if (userIndex < 0) {
      // 失败时用户气泡会被撤掉；此时监听已经不可能再等到正文，及时退出。
      detached = true;
      client.removeListener(listener);
      return;
    }
    if (userIndex + 1 >= messages.length) return;
    final reply = messages[userIndex + 1];
    if (reply.role != ChatRole.assistant || reply.streaming) return;
    if (reply.text == writtenText) return;
    writtenText = reply.text;
    try {
      File(resultPath).writeAsStringSync(
        'user: ${messages[userIndex].text}\n'
        'assistant: ${reply.text}\n',
        flush: true,
      );
    } catch (_) {
      return;
    }
    detached = true;
    client.removeListener(listener);
  }

  client.addListener(listener);
}
