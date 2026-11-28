import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/design/primitives.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-transfer/ui/transfer_actions.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-transfer/ui/transfer_model.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-transfer/ui/transfer_page.dart';
import 'support/form_factor.dart';

void main() {
  final loader = transferLoader;
  final picker = transferPickFile;
  final importer = transferImport;
  final reveal = transferReveal;

  setUp(() {
    transferLoader = () async => TransferSnapshot.empty;
    transferPickFile = (_, _) async => '/isolated/input.json';
    transferImport = (_) async => const TransferResult(
      ok: true,
      message: '导入完成',
      path: '/isolated/output',
    );
    transferReveal = (_) async => const TransferResult.fail('访达失败');
  });
  tearDown(() {
    transferLoader = loader;
    transferPickFile = picker;
    transferImport = importer;
    transferReveal = reveal;
  });

  Future<void> pump(WidgetTester tester) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      const MaterialApp(home: Scaffold(body: TransferPage())),
    );
    await tester.pump();
  }

  bool busy(WidgetTester tester) => tester
      .widgetList<OndraSettingRow>(find.byType(OndraSettingRow))
      .any((row) => row.disabled);

  // 这些用例 mock 了文件选择/导入函数，量的是桌面档位行为。flutter test
  // 的默认 targetPlatform 是 android、不带 filePicker，不声明形态就会走
  // 「没有文件面板」分支。用 TargetPlatformVariant 而非 setUp 里赋值，
  // 框架才会在正确的时机设置与还原，符合 foundation 的不变量检查。
  testWidgets('初次读取异常可见且不阻塞操作', (tester) async {
    transferLoader = () async => throw StateError('load failed');
    await pump(tester);
    expect(find.textContaining('读取失败'), findsOneWidget);
    expect(busy(tester), isFalse);
    expect(tester.takeException(), isNull);
  }, variant: desktopFormFactor);

  testWidgets('选择面板异常和取消都在 finally 复位', (tester) async {
    transferPickFile = (_, _) async => throw StateError('picker failed');
    await pump(tester);
    await tester.tap(find.text('偏好设置'));
    await tester.pump();
    expect(find.textContaining('picker failed'), findsOneWidget);
    expect(busy(tester), isFalse);
    transferPickFile = (_, _) async => null;
    await tester.tap(find.text('偏好设置'));
    await tester.pump();
    expect(busy(tester), isFalse);
    expect(tester.takeException(), isNull);
  }, variant: desktopFormFactor);

  testWidgets('异步操作异常后能再次操作', (tester) async {
    final pending = Completer<TransferResult>();
    transferImport = (_) => pending.future;
    await pump(tester);
    await tester.tap(find.text('偏好设置'));
    await tester.pump();
    expect(busy(tester), isTrue);
    pending.completeError(StateError('import failed'));
    await tester.pump();
    expect(find.textContaining('import failed'), findsOneWidget);
    expect(busy(tester), isFalse);
    expect(tester.takeException(), isNull);
  }, variant: desktopFormFactor);

  testWidgets('刷新失败保留成功结果和路径，显示访达失败', (tester) async {
    await pump(tester);
    transferLoader = () async => throw StateError('refresh failed');
    await tester.tap(find.text('偏好设置'));
    await tester.pump();
    expect(find.textContaining('导入完成'), findsOneWidget);
    expect(find.textContaining('统计刷新失败'), findsOneWidget);
    expect(find.text('/isolated/output'), findsOneWidget);
    expect(busy(tester), isFalse);
    await tester.tap(find.text('在访达中显示'));
    await tester.pump();
    expect(find.textContaining('访达失败'), findsOneWidget);
    expect(busy(tester), isFalse);
    expect(tester.takeException(), isNull);
  }, variant: desktopFormFactor);

  testWidgets('操作完成前页面销毁不会 setState', (tester) async {
    final pending = Completer<TransferResult>();
    transferImport = (_) => pending.future;
    await pump(tester);
    await tester.tap(find.text('偏好设置'));
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    pending.complete(const TransferResult(ok: true, message: 'done'));
    await tester.pump();
    expect(tester.takeException(), isNull);
  }, variant: desktopFormFactor);
}
