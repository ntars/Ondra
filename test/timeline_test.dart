import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/design/theme.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_actions.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/backup_model.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/timeline/timeline_card.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-backup/ui/timeline/timeline_stage.dart';

/// 时间线：这一屏的价值全在**操作**上，不在渲染。
///
/// 所以这几项测的都是「按一下会发生什么」：方向键与滚轮能不能在时刻之间穿梭、
/// esc 能不能退出去、选中「现在」时恢复键是不是灰的、恢复之后界面有没有把
/// 引擎的原话显示出来。星场画得对不对测不出来，也不该在这里测。
void main() {
  final now = DateTime.now();

  BackupOverview overviewWith(List<BackupSnapshot> snapshots) => BackupOverview(
    snapshots: snapshots,
    storedBytes: 486000,
    sourceBytes: 2140000,
    liveFiles: 41,
    liveBytes: 462000,
    rootPath: '/tmp/ondra-test/backups',
    settings: const BackupSettings(),
  );

  BackupSnapshot snap(int minutesAgo, BackupTrigger trigger) {
    final at = now.subtract(Duration(minutes: minutesAgo));
    final files = [
      BackupFileEntry(
        path: 'user/beichen/profile.json',
        size: 4200,
        hash: 'h1',
        modified: at.millisecondsSinceEpoch,
      ),
      BackupFileEntry(
        path: 'prefs.json',
        size: 84,
        hash: 'h2',
        modified: at.millisecondsSinceEpoch,
      ),
    ];
    return BackupSnapshot(
      id: 'snap-$minutesAgo',
      createdAt: at,
      trigger: trigger,
      files: files,
      sourceBytes: 4284,
      newBytes: 0,
      newFiles: 0,
    );
  }

  Future<void> pumpStage(
    WidgetTester tester, {
    VoidCallback? onClose,
  }) async {
    tester.view.physicalSize = const Size(960, 600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ondraTheme(Brightness.light),
        home: Material(
          child: TimelineStage(onClose: onClose ?? () {}),
        ),
      ),
    );
    // 第一帧建树，第二帧数据到达，第三帧走完入场过渡。
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 360));
  }

  setUp(() {
    backupOverviewLoader = () async => overviewWith([
      snap(30, BackupTrigger.manual),
      snap(90, BackupTrigger.auto),
      snap(150, BackupTrigger.auto),
    ]);
    backupRestore = (id) async =>
        BackupOpResult(ok: true, message: '已恢复 $id 的文件', snapshotId: id);
    backupCreate = ({BackupTrigger trigger = BackupTrigger.manual}) async =>
        const BackupOpResult(ok: true, message: '已备份 2 个文件。');
  });

  testWidgets('开局落在「现在」，恢复键是灰的', (tester) async {
    await pumpStage(tester);

    expect(find.text('时间线'), findsOneWidget);
    // 时间轴第一格与卡片标题都写着「现在」。
    expect(find.text('现在'), findsWidgets);
    expect(find.byType(TimelineCard), findsOneWidget);
    expect(find.text('选一份过去的备份'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('方向键往回走一步，卡片换成那份快照，恢复键亮起', (tester) async {
    await pumpStage(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('恢复此备份'), findsOneWidget);
    // 选中的是「30 分钟前」那一份，页脚会带出它的触发来源。
    expect(find.textContaining('手动备份'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('再往回走两步：身后叠出更多层，但最多六层', (tester) async {
    backupOverviewLoader = () async => overviewWith([
      for (var i = 0; i < 12; i++) snap(30 * (i + 1), BackupTrigger.auto),
    ]);
    await pumpStage(tester);
    for (var i = 0; i < 9; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump(const Duration(milliseconds: 60));
    }
    await tester.pump(const Duration(milliseconds: 400));

    // 6 层上限：前台 1 + 身后 5。
    expect(find.byType(TimelineCard), findsNWidgets(6));
    expect(tester.takeException(), isNull);
  });

  testWidgets('走到头不会越过最旧的一份', (tester) async {
    await pumpStage(tester);
    for (var i = 0; i < 8; i++) {
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump(const Duration(milliseconds: 40));
    }
    await tester.pump(const Duration(milliseconds: 400));
    // 3 份快照 → 最多 4 个时刻（含现在），全部在场且不抛异常。
    expect(find.byType(TimelineCard), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('esc 退出，回调被调用', (tester) async {
    var closed = false;
    await pumpStage(tester, onClose: () => closed = true);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(closed, isTrue);
  });

  testWidgets('恢复：把引擎的原话显示出来，并回到「现在」', (tester) async {
    await pumpStage(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump(const Duration(milliseconds: 400));

    await tester.tap(find.text('恢复此备份'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(find.textContaining('已恢复 snap-30'), findsOneWidget);
    expect(find.text('选一份过去的备份'), findsOneWidget, reason: '恢复后回到「现在」');
    expect(tester.takeException(), isNull);
  });

  testWidgets('没有快照时给的是「先存一份」，不是一片空白', (tester) async {
    backupOverviewLoader = () async => BackupOverview.empty.copyWithNote('测试环境');
    await pumpStage(tester);

    expect(find.textContaining('还没有快照'), findsWidgets);
    expect(find.text('现在'), findsWidgets);
    expect(find.byType(TimelineCard), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
