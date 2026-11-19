import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/keychain.dart';
import 'package:ondra/app/ondra_app.dart';
import 'package:ondra/app/platform_actions.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/ambient_rail.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/chassis.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/shell_state.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/side_rail.dart';

import 'support/form_factor.dart';

/// 手机形态：**聊天是主界面，其余功能收进抽屉。**
///
/// 这组守的是三条规则，每一条都对应一个会被改坏的地方：
///
/// 1. **判据是平台，不是宽度**。拿宽度当判据会让「把桌面窗口拖窄」意外
///    触发手机布局——侧栏突然变全屏抽屉、聊天盖住页面。
/// 2. **聊天必须常驻，功能页是盖上去的**。若改成「换掉聊天」，返回时聊天页
///    会被重建，滚动位置和输入框草稿全丢。
/// 3. **选中一项要一次性做完三件事**（切页 + 盖住 + 收抽屉）。分三次赋值会
///    在中间帧画出「页面切了但聊天还盖着」，抽屉消失的瞬间底下闪一下。
///
/// 尺寸取 iPhone 15 的逻辑像素 393×852，是当前最常见的一档。
void main() {
  setUp(() {
    // 设置面板打开时会查钥匙串；真实实现要起 `security` 子进程，
    // 在 widget 测试的 fake_async 时钟里走不完。
    Keychain.existsProbe = (_) async => false;
    // 平台行为层会真的写登录项、起 caffeinate 子进程，测试不该动用户的机器。
    PlatformActions.probe = const PlatformActionsProbe();
  });

  Future<void> pumpMobile(WidgetTester tester, {Size size = const Size(393, 852)}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const OndraApp());
    // 跳过 700ms 启动屏。
    await tester.pump(const Duration(milliseconds: 900));
    await tester.pump();
  }

  ShellState stateOf(WidgetTester tester) =>
      ShellScope.of(tester.element(find.byType(OndraChassis)));

  testWidgets('手机上一进来就停在聊天，不显示任何功能页', (tester) async {
    await pumpMobile(tester);
    final st = stateOf(tester);

    // 聊天栏在场：它是主界面，必须从头就在。
    expect(find.byType(OndraAmbientRail), findsOneWidget);
    // 没有「盖着的功能页」。
    expect(st.mobilePageOpen, isFalse);
    // 抽屉默认关着：一进来就弹抽屉会挡住聊天。
    expect(st.sidebarOpen, isFalse);
    // 桌面的三栏底板不该出现——手机上根本没有三栏。
    expect(find.byKey(OndraChassis.railSlotKey), findsNothing);
  }, variant: mobileFormFactor);

  testWidgets('手机上导航入口可点开抽屉，菜单项在抽屉里', (tester) async {
    await pumpMobile(tester);

    // 抽屉未打开时侧栏不在树上（它由 `if (st.sidebarOpen)` 控制）。
    expect(find.byType(OndraSideRail), findsNothing);

    await tester.tap(find.byTooltip('打开导航'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    expect(find.byType(OndraSideRail), findsOneWidget);
    // 抽屉里能看见分组标题，说明菜单真的渲染了。
    expect(find.text('空谷生命'), findsWidgets);
  }, variant: mobileFormFactor);

  testWidgets('选一项后盖住聊天并收起抽屉，返回键能回到聊天', (tester) async {
    await pumpMobile(tester);
    final st = stateOf(tester);

    await tester.tap(find.byTooltip('打开导航'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    // 点「记忆星图」这一项。
    await tester.tap(find.text('记忆星图').last);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 三件事必须同时成立。
    expect(st.activeId, 'memory');
    expect(st.mobilePageOpen, isTrue, reason: '选中一项应当离开聊天');
    expect(st.sidebarOpen, isFalse, reason: '选中后抽屉应当收起');

    // 聊天仍在树上（被盖住而不是被销毁）——这是草稿与滚动位置能保住的前提。
    expect(find.byType(OndraAmbientRail), findsOneWidget);
    // 顶上出现返回键与页面标题。
    expect(find.byTooltip('返回对话'), findsOneWidget);

    await tester.tap(find.byTooltip('返回对话'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    expect(st.mobilePageOpen, isFalse);
    // 回到了聊天：确认它还在，且没有再盖着页面。
    expect(find.byType(OndraAmbientRail), findsOneWidget);
    expect(find.byTooltip('返回对话'), findsNothing);
    // 返回后导航入口重新出现，用户能再次打开抽屉。
    expect(find.byTooltip('打开导航'), findsOneWidget);
  }, variant: mobileFormFactor);

  testWidgets('桌面窗口拖窄也不进入手机布局', (tester) async {
    // 这条是「判据用平台而不是宽度」的反向守卫：880 宽在桌面上是紧凑形态
    // （抽屉式），但绝不该变成「聊天是主界面」。
    tester.view.physicalSize = const Size(880, 700);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const OndraApp());
    await tester.pump(const Duration(milliseconds: 900));
    await tester.pump();

    final st = stateOf(tester);
    // 桌面没有「盖着的功能页」这个概念，它恒为 false。
    expect(st.mobilePageOpen, isFalse);
    // 页面标题仍在（桌面紧凑形态把页面铺满，不是把聊天铺满）。
    expect(find.text('状态面板'), findsWidgets);
  }, variant: desktopFormFactor);

  testWidgets('手机功能页的返回条避开顶部安全区', (tester) async {
    // 模拟刘海：顶部 59 的安全区（iPhone 15 的实际值）。
    tester.view.physicalSize = const Size(393, 852);
    tester.view.devicePixelRatio = 1;
    tester.view.padding = const FakeViewPadding(top: 59, bottom: 34);
    addTearDown(tester.view.reset);

    await tester.pumpWidget(const OndraApp());
    await tester.pump(const Duration(milliseconds: 900));
    await tester.pump();

    final st = stateOf(tester);
    st.openMobilePage('memory');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 返回键的中心必须在安全区之下：压在刘海下面等于点不到。
    final back = find.byTooltip('返回对话');
    expect(back, findsOneWidget);
    final center = tester.getCenter(back);
    expect(
      center.dy,
      greaterThan(59),
      reason: '返回键被状态栏压住了（dy=${center.dy}）',
    );
  }, variant: mobileFormFactor);
}
