import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/remote_transport.dart';

/// 真实 dsh web + 本地 qwen 的 R3 验收。默认跳过，只在显式提供 URL 时运行：
///
/// `ONDRA_R3_URL='http://127.0.0.1:38473/?token=…' flutter test \
///   test/remote_transport_real_test.dart`
void main() {
  final launchUrl = Platform.environment['ONDRA_R3_URL'] ?? '';

  test(
    'Dart R3 transport talks to a real dsh web and local qwen',
    () async {
      final overrides = HttpOverrides.current;
      HttpOverrides.global = null;
      addTearDown(() => HttpOverrides.global = overrides);
      final uri = Uri.parse(launchUrl);
      final token = uri.queryParameters['token'] ?? '';
      final base = Uri(
        scheme: uri.scheme,
        host: uri.host,
        port: uri.hasPort ? uri.port : null,
        path: uri.path.replaceAll(RegExp(r'/+$'), ''),
      ).toString();
      final transport = RemoteDshTransport(
        baseUrl: base,
        launchToken: token,
        provider: 'local-qwen',
        model: 'qwen3-coder-next',
        workingDirectory: '/tmp',
        requestTimeout: const Duration(seconds: 30),
        turnTimeout: const Duration(minutes: 2),
      );
      addTearDown(transport.close);

      await transport.connect();
      expect(transport.sessionId, isNotEmpty);
      expect(transport.isConnected, isTrue);
      final reply = await transport.send('只回答一个数字：1+1 等于几').join();
      expect(reply.trim(), isNotEmpty);
      // ignore: avoid_print
      print('R3_REAL_REPLY=$reply');
      // ignore: avoid_print
      print('R3_REAL_SESSION=${transport.sessionId}');
    },
    skip: launchUrl.isEmpty ? '需要 ONDRA_R3_URL' : false,
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
