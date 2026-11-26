@Timeout(Duration(minutes: 4))
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/bundled_runtime.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport_io.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart';

/// **真机集成测试**：用随包的那份运行时（node + 裁剪过的 dsh 闭包）真的起一次内核。
///
/// 为什么 `assemble_runtime.sh` 里的 `--dump-config` 自检还不够：那只证明
/// 「插件树能装配」。装配通过之后，会话链路仍可能因为某个被裁掉的包而炸——
/// 比如工具层在第一次 prompt 时才 `import()` 某个可选依赖。这个测试把
/// `initialize` 真的走完，是「裁剪没有裁坏东西」的最后一道闸。
///
/// 没跑过装配脚本的机器整组跳过（`runtime/` 不存在），CI 上不该红。
void main() {
  final runtime = ondraBundledRuntime;

  test('随包运行时能起来：initialize 握手成功', () async {
    if (runtime == null) {
      markTestSkipped('没有 runtime/ 产物（先跑 tool/assemble_runtime.sh）');
    }

    // 不给 binary：让它自己走解析链，也就是真的用到随包那一份。
    // profile 由 connect() 里的 seed 兜底——本机已装则原样用，没装则从包里铺。
    final transport = StdioDshTransport();

    try {
      await transport.connect();
      expect(
        transport.lastError,
        isNull,
        reason: '用随包运行时启动内核时，initialize 应当成功',
      );
    } finally {
      transport.stop();
    }
  }, timeout: const Timeout(Duration(minutes: 4)));

  test('随包运行时下 ChatClient 处于在线态', () async {
    if (runtime == null) {
      markTestSkipped('没有 runtime/ 产物');
    }

    final client = ChatClient(transport: StdioDshTransport());
    try {
      await client.connect();
      expect(client.offlineReason, isNull, reason: '内核连上了就不该报离线；理由非空说明启动失败');
    } finally {
      client.stop();
    }
  }, timeout: const Timeout(Duration(minutes: 4)));

  test('真实聊天：发送“你好”必须收到正文', () async {
    if (runtime == null) {
      markTestSkipped('没有 runtime/ 产物（先跑 tool/assemble_runtime.sh）');
      return;
    }
    final home = await Directory.systemTemp.createTemp('ondra-chat-hello-');
    addTearDown(() => home.delete(recursive: true));
    final dshHome = '${home.path}/.ondra/dsh';
    Directory('$dshHome/profiles/ondra').createSync(recursive: true);
    final models = ModelClient(storePath: '${home.path}/.ondra/models.json');
    addTearDown(models.dispose);
    final transport = StdioDshTransport(
      modelConfig: models.currentRuntimeConfig,
      secretResolver: (ref) async => 'magpie-local',
      inheritLoginShellEnvironment: false,
      environment: {
        ...Platform.environment,
        'HOME': home.path,
        'USERPROFILE': home.path,
        'ONDRA_DSH_HOME': dshHome,
      },
      turnTimeout: const Duration(minutes: 2),
    );
    final client = ChatClient(transport: transport);
    addTearDown(client.dispose);
    await client.connect();
    expect(client.offlineReason, isNull, reason: '基础聊天要求先连上可用模型，而不是只完成进程握手');
    await client.send('你好');
    final reply = client.messages.last;
    expect(reply.role, ChatRole.assistant, reason: '回复变成了系统消息：${reply.text}');
    expect(reply.text.trim(), isNotEmpty, reason: '“你好”必须拿到模型正文');
  }, timeout: const Timeout(Duration(minutes: 4)));
}
