import 'package:flutter/foundation.dart' show TargetPlatform, debugDefaultTargetPlatformOverride;
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/app/keychain.dart';
import 'package:ondra/app/ondra_app.dart';
import 'package:ondra/app/platform_actions.dart';
import 'package:ondra/design/native_glass.dart';
import 'package:ondra/design/skin.dart';
import 'package:ondra/design/tokens.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/boot_screen.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/side_rail.dart';

/// 守的是这条规则：**没有原生玻璃的平台必须画实色。**
///
/// 这不是审美取舍，是「底下到底有没有那一层」的事实。macOS 的
/// `MainFlutterWindow.swift` 会往 contentView 最底层插 `NSGlassEffectView`，
/// 所以侧栏可以画透明；Windows / Linux 的 runner 是 Flutter 默认模板，
/// 一层玻璃都没有，画透明露出来的是窗口自己的底色——深色主题下侧栏本该是
/// `#20242D`，实际是一片亮底。
///
/// 这条测试的价值在于：以后有人为了「让 macOS 更通透」把判断改回
/// `kIsWeb ? 实色 : 透明`，它会立刻失败，而不用等到发 Windows 安装包才
/// 有人发现深色模式难看。

/// 在指定平台下跑一段代码，跑完恢复。
T _onPlatform<T>(TargetPlatform platform, T Function() body) {
  debugDefaultTargetPlatformOverride = platform;
  try {
    return body();
  } finally {
    debugDefaultTargetPlatformOverride = null;
  }
}

void main() {
  setUp(() {
    // 整树挂载会走到设置面板的旁路查询：真实查钥匙串要起 `security` 子进程，
    // 在 widget 测试的 fake_async 时钟里走不完，树销毁后会被判
    // 「Timer is still pending」。这一组测的是底色，不测钥匙串。
    Keychain.existsProbe = (_) async => false;
    // 平台行为层会真的写登录项、起 caffeinate 子进程。
    PlatformActions.probe = const PlatformActionsProbe();
  });
  test('只有 macOS 有原生玻璃', () {
    expect(_onPlatform(TargetPlatform.macOS, () => ondraHasNativeGlass), isTrue);
    for (final p in [
      TargetPlatform.windows,
      TargetPlatform.linux,
      TargetPlatform.android,
      TargetPlatform.iOS,
      TargetPlatform.fuchsia,
    ]) {
      expect(
        _onPlatform(p, () => ondraHasNativeGlass),
        isFalse,
        reason: '$p 的 runner 没有玻璃层，画透明会露窗口底色',
      );
    }
  });

  test('Windows 上侧栏是不透明的实色，不是透明', () {
    for (final dark in [false, true]) {
      final painted = dark ? OndraSkin.darkSkin.shell : OndraSkin.light.shell;
      // 实色必须完全不透明：alpha 255。深色深、浅色浅，但都不能透。
      expect(
        painted.a,
        1.0,
        reason: '${dark ? "深色" : "浅色"}侧栏兜底色必须不透明',
      );
      expect(painted, dark ? OndraColor.darkSideGlass : OndraColor.sidebar);
    }
  });

  test('两种主题的兜底纯色不同，且各自与内容底色不撞', () {
    // 「分别适配」的硬要求：两套主题不能共用一个兜底色。
    expect(OndraSkin.light.shell, isNot(OndraSkin.darkSkin.shell));
    // 侧栏与内容区必须拉得开，否则兜底色把层次抹平。
    expect(OndraSkin.light.shell, isNot(OndraSkin.light.content));
    expect(OndraSkin.darkSkin.shell, isNot(OndraSkin.darkSkin.content));
  });

  testWidgets('启动屏在无玻璃平台用实色，深色下不闪白', (tester) async {
    for (final dark in [false, true]) {
      await tester.pumpWidget(
        _onPlatform(TargetPlatform.windows, () {
          return MaterialApp(
            theme: dark
                ? ThemeData(brightness: Brightness.dark)
                : ThemeData(brightness: Brightness.light),
            home: const BootScreen(),
          );
        }),
      );
      final box = tester.widget<ColoredBox>(
        find.descendant(
          of: find.byType(BootScreen),
          matching: find.byType(ColoredBox),
        ).first,
      );
      // 关键断言：alpha 必须是 255。85% 半透明（splashGlass）在 Windows 上
      // 会露出窗口底色，深色下就是一片白——而启动屏正是第一帧。
      expect(
        box.color.a,
        1.0,
        reason: '${dark ? "深色" : "浅色"}启动屏底色必须不透明',
      );
    }
  });

  testWidgets('侧栏在 Windows 上画实色、在 macOS 上画透明', (tester) async {
    // 侧栏要读 `ShellScope`（选中项 / 开合状态），所以不能裸挂——
    // 用整树 `OndraApp`，它是应用真实的挂载方式。
    // 设备像素比取 2：发丝边只在视网膜屏上才走真实分支。
    tester.view.physicalSize = const Size(2400, 1560);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    Future<Color?> paintOn(TargetPlatform platform) async {
      // 先卸掉上一棵树。`OndraApp` 是同一个 runtimeType，直接再 pump 一次
      // 会复用 element，而平台覆盖变量不是 InheritedWidget —— 不会触发重建，
      // 结果读到的是上一次那个平台的颜色（这里踩过一次：Windows 过了、
      // macOS 拿到同一个不透明色）。
      await tester.pumpWidget(const SizedBox.shrink());
      debugDefaultTargetPlatformOverride = platform;
      try {
        await tester.pumpWidget(const OndraApp());
        await tester.pump(const Duration(milliseconds: 900));
        await tester.pump();
        final containers = tester.widgetList<Container>(
          find.descendant(
            of: find.byType(OndraSideRail),
            matching: find.byType(Container),
          ),
        );
        for (final c in containers) {
          final d = c.decoration;
          if (d is BoxDecoration && d.color != null) {
            // 侧栏底板：定宽 200，且颜色非空。
            if (c.constraints?.maxWidth == OndraSideRail.width) return d.color;
          }
        }
        return null;
      } finally {
        debugDefaultTargetPlatformOverride = null;
      }
    }

    final windows = await paintOn(TargetPlatform.windows);
    expect(windows, isNotNull, reason: '没找到侧栏的底板');
    expect(windows!.a, 1.0, reason: 'Windows 必须不透明');

    final mac = await paintOn(TargetPlatform.macOS);
    expect(mac, isNotNull);
    expect(mac!.a, 0.0, reason: 'macOS 必须透明，让底下的玻璃透上来');
  });
}
