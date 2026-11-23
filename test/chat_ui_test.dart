import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/app/data_maintenance.dart';
import 'package:ondra/app/notifier.dart';
import 'package:ondra/app/prefs.dart';
import 'package:ondra/design/theme.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/ambient_rail.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/shell_state.dart';

void main() {
  late Directory home;
  late ShellState shell;
  late _ControlledTransport transport;

  setUp(() async {
    home = Directory.systemTemp.createTempSync('ondra-chat-ui-');
    setPrefHome(home.path);
    Notifier.probe = NotifierProbe();
    shell = ShellState(initialId: 'status');
    transport = _ControlledTransport();
    chatClient.useTransport(transport);
    await chatClient.newConversation();
    settingsClient.set('dialog.enterSend', true);
    settingsClient.set('dialog.busySend', 'queue');
  });

  tearDown(() async {
    chatClient.stop();
    chatClient.useTransport(const UnavailableTransport());
    await chatClient.newConversation();
    shell.dispose();
    Notifier.probe = null;
    setPrefHome(null);
    home.deleteSync(recursive: true);
  });

  Future<void> pumpRail(WidgetTester tester) async {
    tester.view.physicalSize = const Size(320, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      ShellScope(
        state: shell,
        child: MaterialApp(
          theme: ondraTheme(Brightness.light),
          home: const Material(child: OndraAmbientRail()),
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('回车发送开关立即更新现有输入框', (tester) async {
    await pumpRail(tester);
    TextField field() => tester.widget<TextField>(find.byType(TextField));
    expect(field().textInputAction, TextInputAction.send);
    settingsClient.set('dialog.enterSend', false);
    await tester.pump();
    expect(field().textInputAction, TextInputAction.newline);
    expect(field().onSubmitted, isNull);
    settingsClient.set('dialog.enterSend', true);
    await tester.pump();
    expect(field().textInputAction, TextInputAction.send);
    expect(field().onSubmitted, isNotNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('生成显示停止按钮，点击后能再次发送', (tester) async {
    await pumpRail(tester);
    await tester.enterText(find.byType(TextField), '第一句');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();
    expect(chatClient.busy, isTrue);
    expect(find.byTooltip('停止生成'), findsOneWidget);
    await tester.tap(find.byTooltip('停止生成'));
    await tester.pump();
    expect(chatClient.busy, isFalse);
    expect(find.byTooltip('停止生成'), findsNothing);
    expect(chatClient.messages.any((message) => message.streaming), isFalse);
    await tester.enterText(find.byType(TextField), '第二句');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();
    transport.response!.add('真实测试响应');
    await transport.response!.close();
    await tester.pump();
    expect(find.text('真实测试响应'), findsOneWidget);
    expect(chatClient.busy, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('维护期间点击发送不清空输入或附件', (tester) async {
    await pumpRail(tester);
    await tester.enterText(find.byType(TextField), '稍后发送的内容');
    chatClient.attach(
      const ChatAttachment(path: '/tmp/test.png', name: 'test.png'),
    );
    dataMaintenance.pause = () async {};
    dataMaintenance.resume = () async {};
    addTearDown(() {
      dataMaintenance.pause = null;
      dataMaintenance.resume = null;
    });
    await dataMaintenance.run(() async {
      await tester.pump();
      await tester.tap(find.byTooltip('发送'));
      await tester.pump();
      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        '稍后发送的内容',
      );
      expect(chatClient.attachments, hasLength(1));
      expect(transport.response, isNull);
    });
    expect(tester.takeException(), isNull);
  });

  testWidgets('纯图片提交不会被空文字过滤', (tester) async {
    await pumpRail(tester);
    chatClient.attach(
      const ChatAttachment(path: '/tmp/test.png', name: 'test.png'),
    );
    await tester.pump();
    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(chatClient.attachments, isEmpty);
    expect(transport.attachments.single.name, 'test.png');
    transport.response!.add('收到图片');
    await transport.response!.close();
    await tester.pump();
    expect(find.text('收到图片'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}

class _ControlledTransport implements DshTransport {
  @override
  bool get isConnected => true;
  @override
  String? get modelConfigError => null;
  @override
  void dispose() {}
  StreamController<String>? response;
  List<ChatAttachment> attachments = [];

  @override
  Future<void> connect() async {}

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) {
    this.attachments = attachments;
    response = StreamController<String>();
    return response!.stream;
  }

  @override
  void stop() {
    response?.close();
    response = null;
  }

  @override
  Future<void> close() async {}

  @override
  void resetSession() {}

  @override
  Stream<StepUsage> get usage => const Stream.empty();
}
