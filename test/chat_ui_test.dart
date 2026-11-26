import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/services.dart' show LogicalKeyboardKey;
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
    chatClient.takeFailedDraft();
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

  testWidgets('首轮 5 秒没出字时改成可解释的准备模型文案', (tester) async {
    await pumpRail(tester);
    await tester.enterText(find.byType(TextField), '第一句');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();

    await tester.pump(const Duration(seconds: 4));
    expect(find.text(ChatClient.preparingModelText), findsNothing);
    await tester.pump(const Duration(seconds: 1));
    expect(find.text(ChatClient.preparingModelText), findsOneWidget);

    transport.response!.add('热态回答');
    await transport.response!.close();
    await tester.pump();
    expect(find.text(ChatClient.preparingModelText), findsNothing);
    expect(find.text('热态回答'), findsOneWidget);
    expect(chatClient.hasCompletedTurn, isTrue);
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

  testWidgets('运行时空草稿同一位置是 Stop，有内容时换成 Send', (tester) async {
    await pumpRail(tester);
    await tester.enterText(find.byType(TextField), '第一句');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();
    expect(chatClient.busy, isTrue);
    expect(find.byTooltip('停止生成'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '第二句');
    await tester.pump();
    expect(find.byTooltip('发送'), findsOneWidget);
    expect(find.byTooltip('停止生成'), findsNothing);
    expect(chatClient.queued, isEmpty);

    await tester.tap(find.byTooltip('发送'));
    await tester.pump();
    expect(chatClient.queued, ['第二句']);
    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      isEmpty,
    );

    await tester.tap(find.byTooltip('停止生成'));
    await tester.pump();
    expect(chatClient.queued, ['第二句']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Cmd/Ctrl Enter 使用与回车互补的投递模式', (tester) async {
    settingsClient.set('dialog.enterSend', true);
    settingsClient.set('dialog.busySend', 'queue');
    await pumpRail(tester);

    await tester.enterText(find.byType(TextField), '第一句');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();
    await tester.enterText(find.byType(TextField), '插话');
    await _sendMacShortcut(tester, LogicalKeyboardKey.enter, control: true);
    await tester.pump();

    expect(chatClient.queued, isEmpty);
    expect(chatClient.busy, isTrue);
    expect(
      chatClient.messages
          .where((m) => m.role == ChatRole.user && m.text == '插话')
          .length,
      1,
    );
    transport.response!.add('插话回答');
    await transport.response!.close();
    await tester.pump();
    expect(chatClient.busy, isFalse);
    expect(find.text('插话回答'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('发送失败恢复原文，不覆盖期间的新输入', (tester) async {
    final failing = _DelayedFailingTransport();
    chatClient.useTransport(failing);
    await pumpRail(tester);

    await tester.enterText(find.byType(TextField), '失败的句子');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pump();
    await tester.enterText(find.byType(TextField), '后来补的内容');
    failing.error.complete();
    await tester.pump();
    await tester.pump();

    expect(
      tester.widget<TextField>(find.byType(TextField)).controller!.text,
      '后来补的内容',
    );
    expect(tester.takeException(), isNull);
  });
}

/// `CallbackShortcuts` 走 RawKeyEvent；WidgetTester 只暴露了文本输入侧的
/// 模拟键，测试里直接投递一条 macOS 原始按键来覆盖快捷键绑定。
Future<void> _sendMacShortcut(
  WidgetTester tester,
  LogicalKeyboardKey key, {
  bool meta = false,
  bool control = false,
  bool shift = false,
}) async {
  if (meta) await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
  if (control) await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
  if (shift) await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
  await tester.sendKeyEvent(key);
  if (shift) await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
  if (control) await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
  if (meta) await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
}

class _DelayedFailingTransport implements DshTransport {
  final Completer<void> error = Completer<void>();

  @override
  bool get isConnected => true;
  @override
  String? get modelConfigError => null;
  @override
  void dispose() {}
  @override
  Future<void> connect() async {}

  @override
  Stream<String> send(
    String text, {
    List<ChatAttachment> attachments = const [],
  }) async* {
    yield '半截';
    await error.future;
    throw StateError('连接断了');
  }

  @override
  void resetSession() {}
  @override
  void stop() {}
  @override
  Future<void> close() async {}
  @override
  Stream<StepUsage> get usage => const Stream.empty();
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
