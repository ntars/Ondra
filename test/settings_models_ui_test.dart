import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/app/home_dir.dart';
import 'package:ondra/app/keychain.dart';
import 'package:ondra/app/prefs.dart';
import 'package:ondra/design/theme.dart';
import 'package:ondra/main.dart' show ModelRuntimeBinding;
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/stdio_transport.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_types.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/console_sheet.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/shell_state.dart';

/// P5 第⑤条：设置页改 baseURL 后，模型基座保存新值，装配层用新值重连。
///
/// 真实内核读取 `/changed/v1` 的证据由 `runtime_model_kernel_test.dart`
/// 单独覆盖；这里守住“设置页确实写到同一个投影，并且确实触发重连”。
void main() {
  testWidgets('设置页修改本地 baseURL 后保存并触发内核重连', (tester) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final home = Directory.systemTemp.createTempSync('ondra-models-ui-');
    final prefHome = Directory('${home.path}/prefs')..createSync();
    setPrefHome(prefHome.path);
    Keychain.existsProbe = (_) async => false;

    final store = File('$ondraUserDataRoot/models.json');
    final backup = store.existsSync() ? store.readAsBytesSync() : null;
    final local = OndraProvider(
      id: 'ui-local-qwen',
      name: '界面本地 Qwen',
      category: ProviderCategory.local,
      baseUrl: 'http://127.0.0.1:1234/v1',
      models: [OndraModelEntry(id: 'qwen3-coder-next')],
    );
    expect(modelClient.addProvider(local), isNull);
    expect(modelClient.setDefaultModel(local, local.models.single), isNull);

    final transports = <_RecordingTransport>[];
    final seenBaseUrls = <String>[];
    final chat = ChatClient();
    final binding = ModelRuntimeBinding(
      models: modelClient,
      chat: chat,
      createTransport: (previous) {
        seenBaseUrls.add(
          '${modelClient.currentRuntimeConfig().profile['baseURL']}',
        );
        final next = _RecordingTransport(previous);
        transports.add(next);
        return next;
      },
    );
    final shell = ShellState(initialId: 'status');
    try {
      await binding.start();
      await tester.pumpWidget(
        ShellScope(
          state: shell,
          child: MaterialApp(
            theme: ondraTheme(Brightness.light),
            home: Material(
              child: ConsoleSheet(initialPane: ShellPane.model, onClose: () {}),
            ),
          ),
        ),
      );
      await tester.pump();

      final localRow = find
          .ancestor(of: find.text('界面本地 Qwen'), matching: find.byType(Row))
          .first;
      final edit = find.descendant(of: localRow, matching: find.text('编辑'));
      await tester.ensureVisible(edit);
      await tester.tap(edit);
      await tester.pump();

      final address = find.byType(TextField);
      expect(address, findsOneWidget);
      expect(
        tester.widget<TextField>(address).controller!.text,
        'http://127.0.0.1:1234/v1',
      );
      await tester.enterText(address, 'http://127.0.0.1:5678/v1');
      await tester.pump();

      expect(local.baseUrl, 'http://127.0.0.1:5678/v1');
      for (var i = 0; i < 8; i++) {
        await tester.pump();
        for (final transport in transports) {
          if (transport.closeStarted && !transport.closeGate.isCompleted) {
            transport.closeGate.complete();
          }
        }
      }
      expect(seenBaseUrls.first, 'http://127.0.0.1:1234/v1');
      expect(seenBaseUrls.last, 'http://127.0.0.1:5678/v1');
      expect(transports.last.opened, isTrue);
      expect(tester.takeException(), isNull);
    } finally {
      for (final transport in transports) {
        if (!transport.closeGate.isCompleted) transport.closeGate.complete();
      }
      await binding.dispose();
      chat.dispose();
      await modelClient.removeProvider(local.id);
      if (backup == null) {
        if (store.existsSync()) store.deleteSync();
      } else {
        store.createSync(recursive: true);
        store.writeAsBytesSync(backup);
      }
      shell.dispose();
      setPrefHome(null);
      if (home.existsSync()) home.deleteSync(recursive: true);
    }
  });
}

class _RecordingTransport extends StdioDshTransport {
  _RecordingTransport(this.previous);

  final Future<void>? previous;
  final closeGate = Completer<void>();
  bool closeStarted = false;
  bool opened = false;

  @override
  Future<void> connect() async {
    await previous;
    opened = true;
  }

  @override
  Stream<StepUsage> get usage => const Stream.empty();

  @override
  Future<void> close() async {
    closeStarted = true;
    await closeGate.future;
  }
}
