import 'package:ondra/app/platform_actions.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/keychain.dart';
import 'package:ondra/app/ondra_app.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_actions.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_model.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/timeline/timeline_stage.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-logs/ui/log_page.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-logs/ui/log_types.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-memory/ui/memory_page.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-memory/ui/memory_types.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-status/ui/status_page.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-status/ui/status_types.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-transfer/ui/transfer_actions.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-transfer/ui/transfer_model.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/registry.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/shell_state.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/chassis.dart';

/// 逐页渲染：每个模块在宽（三栏）与窄（抽屉）两种形态下都必须能画出来，
/// 且不能抛异常、不能溢出。
///
/// 这比对着截图逐页看更严格：溢出的 RenderFlex、除以零的约束、
/// 空数据下的越界，都会在这里直接失败，而截图里只是一处「看起来怪」。
void main() {
  // 记忆与日志两页在 initState 里读本机文件（走 sqlite3 子进程）。
  // widget 测试的时钟是 fake_async，真实子进程的定时器永远走不完，
  // 树销毁后会被判「Timer is still pending」。换成空实现即可——
  // 这两页在测试里只验版式，不验数据。
  setUp(() {
    memorySnapshotLoader = () async =>
        const MemorySnapshot(facts: [], links: [], note: '测试环境');
    logEntriesLoader = (LogKind kind) async => const <LogEntry>[];
    // 平台行为层会真的写 launchd 登录项、起 caffeinate 子进程。
    // 测试跑一遍就在用户机器上留下一个开机启动项，比测试失败糟糕得多。
    PlatformActions.probe = const PlatformActionsProbe();
    // 备份页要扫真实目录、算指纹；测试里换成空总览，理由同上。
    backupOverviewLoader = () async =>
        BackupOverview.empty.copyWithNote('测试环境');
    // 状态面板与导入导出页也会读库（同样走子进程），一并换成空读数。
    statusSnapshotLoader = () async => StatusSnapshot.empty;
    transferLoader = () async => TransferSnapshot.empty;
    // 设置面板打开时会查钥匙串里有没有 QQ 密钥。真查要起 `security` 子进程，
    // 在 fake_async 里同样走不完——换成「没有」，这一页只验版式。
    Keychain.existsProbe = (_) async => false;
  });

  Future<void> pumpShell(WidgetTester tester, Size size) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const OndraApp());
    // 跳过启动屏（700ms 后切主壳）。
    await tester.pump(const Duration(milliseconds: 900));
  }

  ShellState stateOf(WidgetTester tester) {
    final element = tester.element(find.byType(OndraChassis));
    return ShellScope.of(element);
  }

  for (final module in OndraRegistry.all) {
    testWidgets('${module.label} 在 960×660 下可渲染', (tester) async {
      await pumpShell(tester, const Size(960, 660));
      stateOf(tester).activeId = module.id;
      await tester.pump(const Duration(milliseconds: 250));
      expect(tester.takeException(), isNull);
      expect(find.text(module.label), findsWidgets);
    });

    testWidgets('${module.label} 在 880×700 下可渲染（抽屉形态）', (tester) async {
      await pumpShell(tester, const Size(880, 700));
      stateOf(tester).activeId = module.id;
      await tester.pump(const Duration(milliseconds: 250));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('设置面板可打开且无异常', (tester) async {
    await pumpShell(tester, const Size(960, 660));
    stateOf(tester).settingsOpen = true;
    await tester.pump(const Duration(milliseconds: 250));
    expect(tester.takeException(), isNull);
    expect(find.text('通用设置'), findsWidgets);
  });

  testWidgets('时间线覆盖层能盖住三栏且无异常', (tester) async {
    await pumpShell(tester, const Size(960, 660));
    final st = stateOf(tester);
    st.activeId = 'backup';
    await tester.pump();
    st.timelineOpen = true;
    await tester.pump(const Duration(milliseconds: 400));

    expect(tester.takeException(), isNull);
    expect(find.text('时间线'), findsWidgets);
    // 覆盖层是整窗的：它盖住左栏与右栏，而不是挤在中栏里当一页。
    // 左栏的组件仍在树里（只是被盖住了），所以这里测尺寸而不是测有无。
    expect(tester.getSize(find.byType(TimelineStage)), const Size(960, 660));
  });
}
