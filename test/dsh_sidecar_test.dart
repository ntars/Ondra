@Timeout(Duration(minutes: 3))
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport_io.dart';

/// **真机集成测试**：拉起本机的 `dsh --profile ondra`，走一遍
/// initialize → session/prompt → session.event，验证传输层的分帧与状态机。
///
/// `ondra` 是应用自己的 profile（`~/.ondra/dsh/profiles/ondra`）：它的插件树
/// 里有人用 `node:sqlite`，启动时会往 stderr 打一条 ExperimentalWarning。
/// 传输层按行过滤告警，所以 `lastError` 仍然应当是 null——这一步同时也在
/// 守住「告警不许冒充错误」这条线。
///
/// 没装 dsh 时整组跳过（CI / 无网络环境不该红）；装了就必须绿，
/// 因为这一步是「右栏真的能说话」的最后一道闸。
///
/// 需要 API Key 才会真的生成内容；没有 Key 时 prompt 会以错误事件收尾，
/// 本测试只验证**协议链路**（能起进程、能握手、能收到 turn/end）。
void main() {
  final binary = Platform.environment['ONDRA_DSH_BIN'] ?? 'dsh';

  Future<bool> dshAvailable() async {
    final which = await Process.run('which', [binary], runInShell: true);
    return which.exitCode == 0;
  }

  test('dsh sidecar：initialize 握手成功，一轮对话能正常收尾', () async {
    if (!await dshAvailable()) {
      // 用标记而非 fail：没装 dsh 的机器跑全量测试不该红。
      markTestSkipped('未找到 $binary（npm i -g @deepseek-ai/dsh）');
    }

    // magpie 路由的 apiKeyEnv 只要求「非空」（patch 注释里的占位约定）；
    // pi-ai 在 prompt 时解析凭据，环境里没有就报 MISSING_CREDENTIAL。
    // 这里给占位值，同时守住「告警/缺凭据不许冒充错误」的判定。
    final transport = StdioDshTransport(
      binary: binary,
      environment: {...Platform.environment, 'MAGPIE_API_KEY': 'magpie-local'},
    );
    await transport.connect();
    expect(transport.lastError, isNull, reason: 'initialize 应当成功');

    // 发一条真实消息。有无 API Key 决定的是「有没有文本」，
    // 而 turn/end 或错误收尾都是合法的协议行为——只要流能闭合。
    final chunks = <String>[];
    await for (final chunk in transport.send('打个招呼')) {
      chunks.add(chunk);
    }
    // 允许三种合法结局：有文本、无文本但正常收尾、错误收尾——
    // 唯一不允许的是流挂死（上层有 30s 兜底，到这里说明收尾了）。
    expect(chunks, isA<List<String>>());

    transport.stop();
  }, timeout: const Timeout(Duration(minutes: 3)));

  test('ChatClient 挂上真实 transport 后不再是离线态', () async {
    if (!await dshAvailable()) {
      markTestSkipped('未找到 $binary');
    }
    final client = ChatClient(
      transport: StdioDshTransport(
        binary: binary,
        environment: {...Platform.environment, 'MAGPIE_API_KEY': 'magpie-local'},
      ),
    );
    await client.connect();
    expect(client.offlineReason, isNull);
    client.stop();
  });

  /// 真正的「能说话」：经本机网关 magpie 拿回正文与用量。
  ///
  /// 前两个测试只验证协议链路（能起、能握手、流能闭合）；这一条验证
  /// **模型这一端也是通的**——没它，「右栏能对话」就只是个结构断言。
  /// magpie 没在听就跳过：那是这台机器没开网关，不是应用坏了。
  test('经 magpie 路由能拿回正文与用量', () async {
    if (!await dshAvailable()) {
      markTestSkipped('未找到 $binary');
    }
    if (!await _magpieListening()) {
      markTestSkipped('magpie 未在 127.0.0.1:3425 监听（/Applications/magpie.app）');
    }

    final transport = StdioDshTransport(
      binary: binary,
      environment: {...Platform.environment, 'MAGPIE_API_KEY': 'magpie-local'},
    );
    final usages = <StepUsage>[];
    final sub = transport.usage.listen(usages.add);
    await transport.connect();
    expect(transport.lastError, isNull, reason: 'initialize 应当成功');

    final chunks = <String>[];
    await for (final chunk in transport.send('用两个字回答：在的')) {
      chunks.add(chunk);
    }

    expect(chunks.join().trim(), isNotEmpty, reason: '应当收到模型正文');
    // 用量是右栏那条 dock 的唯一来源：这一步拿到 0 就意味着 dock 只能画 `—`。
    expect(usages, isNotEmpty, reason: '应当至少收到一条 step 用量');
    expect(usages.last.tokens.totalTokens, greaterThan(0));

    await sub.cancel();
    transport.stop();
  }, timeout: const Timeout(Duration(minutes: 3)));
}

/// magpie 是否在本机环回上听着。1 秒超时——它是本机服务，不该等。
Future<bool> _magpieListening() async {
  try {
    final socket = await Socket.connect('127.0.0.1', 3425,
        timeout: const Duration(seconds: 1));
    socket.destroy();
    return true;
  } catch (_) {
    return false;
  }
}
