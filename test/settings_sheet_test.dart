import 'package:ondra/app/platform_actions.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/keychain.dart';
import 'package:ondra/app/ondra_app.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/chassis.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/shell_state.dart';

/// 设置面板里那颗主题三段控件的回归守卫。
///
/// 它的宽度是按文字现量的（三格不等宽），一旦量宽 / 排版错位，最直接的
/// 症状就是某格文字被裁或整行溢出——这两种在 pump 里都会抛异常。
/// 设备像素比取 2：发丝边与 0.5 宽描边只在视网膜屏上才会走到真实分支。
void main() {
  setUp(() {
    // 设置面板一打开就查钥匙串里有没有 QQ 密钥。真查要起 `security` 子进程，
    // 在 widget 测试的 fake_async 时钟里走不完，树销毁后会被判
    // 「Timer is still pending」。这一条测的是排版，不测钥匙串。
    Keychain.existsProbe = (_) async => false;
    // 平台行为层会真的写 launchd 登录项、起 caffeinate 子进程。
    // 测试跑一遍就在用户机器上留下一个开机启动项，比测试失败糟糕得多。
    PlatformActions.probe = const PlatformActionsProbe();
  });

  testWidgets('设置 → 主题三段控件可渲染、不溢出', (tester) async {
    tester.view.physicalSize = const Size(2400, 1560);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(const OndraApp());
    await tester.pump(const Duration(milliseconds: 900));

    final st = ShellScope.of(tester.element(find.byType(OndraChassis)));
    st.settingsOpen = true;
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.takeException(), isNull);
    expect(find.text('浅色'), findsOneWidget);
    expect(find.text('深色'), findsOneWidget);
    expect(find.text('跟随系统'), findsOneWidget);
  });
}
