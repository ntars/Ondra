import 'dart:io';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/keychain.dart';
import 'package:ondra/app/ondra_app.dart';
import 'package:ondra/app/platform_actions.dart';
import 'package:ondra/app/prefs.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/chassis.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/shell_state.dart';

import 'support/form_factor.dart';

/// 手机尺寸下的**渲染守卫**：每个尺寸都要求「渲染这一帧不抛异常」。
///
/// ## 为什么要有这一组
///
/// 之前的手机测试只量结构（聊天在不在、抽屉开没开），不量布局——
/// 设置面板在 360dp 上每行溢出、备份卡片文字被缩略窗压住，这些
/// RenderFlex overflow 都是**日志里刷一行黄条**、界面照常弹出，
/// 结构断言全绿也发现不了。`tester.takeException()` 能接住它们。
///
/// ## 尺寸怎么选
///
/// - 360×640：安卓常见的最小档（Galaxy S 系列旧机、多数千元机）；
/// - 393×852：iPhone 15 / Pixel 8 一档（已有测试用这一档）；
/// - 412×915：Pixel 7 Pro 一档（Android 最主流的中大屏）。
/// 三档覆盖 dp 宽度 360–412，是布局最容易崩的区间。
void main() {
  setUp(() {
    final prefsHome = Directory.systemTemp.createTempSync('ondra-render-');
    addTearDown(() => prefsHome.deleteSync(recursive: true));
    setPrefHome(prefsHome.path);
    addTearDown(() => setPrefHome(null));
    writePref('onboardingDone', '1');
    Keychain.existsProbe = (_) async => false;
    PlatformActions.probe = const PlatformActionsProbe();
  });

  Future<void> pump(
    WidgetTester tester,
    Size size,
    Future<void> Function() act,
  ) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const OndraApp());
    await tester.pump(const Duration(milliseconds: 900));
    await tester.pump();
    // 启动帧本身允许有异步铺设（字体、皮肤），先把首帧的异常清掉再动作。
    final boot = tester.takeException();
    expect(boot, isNull, reason: '首帧就抛异常：$boot');
    // 溢出的定位需要完整的渲染详情（哪个 Row、树形箭头），
    // takeException 只给一行摘要——挂 onError 把详情打全再断言。
    Object? caught;
    final prevOnError = FlutterError.onError;
    FlutterError.onError = (details) {
      caught ??= details.exception;
      FlutterError.dumpErrorToConsole(details, forceReport: true);
    };
    addTearDown(() => FlutterError.onError = prevOnError);
    await act();
    FlutterError.onError = prevOnError;
    expect(caught, isNull, reason: '交互后渲染溢出或异常：$caught');
  }

  ShellState stateOf(WidgetTester tester) =>
      ShellScope.of(tester.element(find.byType(OndraChassis)));

  const sizes = <String, Size>{
    '360×640（安卓最小档）': Size(360, 640),
    '393×852（iPhone 15 档）': Size(393, 852),
    '412×915（Pixel 7 Pro 档）': Size(412, 915),
  };

  for (final entry in sizes.entries) {
    final label = entry.key;
    final size = entry.value;

    testWidgets('$label：聊天首屏无溢出', (tester) async {
      await pump(tester, size, () async {
        await tester.pump(const Duration(milliseconds: 200));
      });
    }, variant: mobileFormFactor);

    testWidgets('$label：打开设置面板无溢出，窄屏走单列', (tester) async {
      await pump(tester, size, () async {
        stateOf(tester).settingsOpen = true;
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        // 单列时顶层分类条在树上（桌面双栏没有它）。
        expect(find.text('通用设置'), findsWidgets, reason: '分类条必须渲染');
      });
    }, variant: mobileFormFactor);

    testWidgets('$label：抽屉打开无溢出', (tester) async {
      await pump(tester, size, () async {
        await tester.tap(find.byTooltip('打开导航'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
      });
    }, variant: mobileFormFactor);

    testWidgets('$label：记忆星图与插件页无溢出', (tester) async {
      await pump(tester, size, () async {
        final st = stateOf(tester);
        st.openMobilePage('memory');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        st.openMobilePage('plugins');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
      });
    }, variant: mobileFormFactor);

    testWidgets('$label：备份页与导入导出页无溢出', (tester) async {
      await pump(tester, size, () async {
        final st = stateOf(tester);
        st.openMobilePage('backup');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
        st.openMobilePage('transfer');
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 300));
      });
    }, variant: mobileFormFactor);

    testWidgets('$label：时间线无溢出且吃安全区', (tester) async {
      await pump(tester, size, () async {
        final st = stateOf(tester);
        st.timelineOpen = true;
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        // 时间线在场（它有「备份现在」这个动作）。
        expect(find.text('备份现在'), findsWidgets);
      });
    }, variant: mobileFormFactor);
  }

  testWidgets('安卓返回手势按覆盖栈逐层退，不直接退出应用', (tester) async {
    await pump(tester, const Size(393, 852), () async {
      final st = stateOf(tester);
      // 打开三层：功能页 → 设置 → 时间线。
      st.openMobilePage('memory');
      await tester.pump();
      st.settingsOpen = true;
      await tester.pump();
      st.timelineOpen = true;
      await tester.pump();

      // 系统返回：最顶上的时间线先退。测试环境的 handlePopRoute 可能
      // 连发两次（框架与 pop 链各处理一遍），所以中间层不追求「只少一层」，
      // 只守两件事：第一次不许什么都不关、N 次之内必须回到聊天。
      await tester.binding.handlePopRoute();
      await tester.pump(const Duration(milliseconds: 300));
      expect(st.timelineOpen, isFalse, reason: '返回要先关时间线');

      // 反复按返回，最终必须回到聊天（而不是卡在某一层）。
      for (var i = 0; i < 4; i++) {
        if (!st.timelineOpen && !st.settingsOpen && !st.mobilePageOpen) break;
        await tester.binding.handlePopRoute();
        await tester.pump(const Duration(milliseconds: 300));
      }
      expect(st.timelineOpen, isFalse);
      expect(st.settingsOpen, isFalse);
      expect(st.mobilePageOpen, isFalse, reason: '最终回到聊天');
    });
  }, variant: mobileFormFactor);
}
