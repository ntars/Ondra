import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/ondra_app.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-chat/ui/ambient_rail.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/chassis.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/shell_state.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/side_rail.dart';

/// 右栏四条开合路径的**中间态**守卫。
///
/// 这组断言存在的理由：动画断档在静态分析里完全看不出来，截图又只能拍到
/// 首尾两帧。真正的毛病——「收起到一半点展开会先弹回 0」「沉浸是瞬切没有
/// 过渡」「中栏被挤成一条」——只在连续帧之间暴露，所以必须逐帧量宽度。
///
/// 量的对象是 `OndraAmbientRail` 的 RenderObject 尺寸：它被宽度轨道直接约束，
/// 是这条动画唯一的事实来源。
void main() {
  Future<void> pumpShell(WidgetTester tester, Size size) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(const OndraApp());
    // 跳过启动屏（700ms 后切主壳）。
    await tester.pump(const Duration(milliseconds: 900));
  }

  ShellState stateOf(WidgetTester tester) =>
      ShellScope.of(tester.element(find.byType(OndraChassis)));

  /// 真实的栏宽。
  ///
  /// 不能量 `OndraAmbientRail` 自己：它按**排版宽度**布局后再被裁切，收纳途中
  /// 内容仍然按 280 排版、槽宽却只有 120，量出来的会一直是 280。槽位才是
  /// 开合进度的唯一事实来源。
  double railWidth(WidgetTester tester) =>
      tester.getSize(find.byKey(OndraChassis.railSlotKey)).width;

  /// 按 60fps 一帧一帧推进 [ms] 毫秒，并返回每帧的宽度序列。
  ///
  /// 不能用单次 `pump(150ms)` 量中间态：ticker 的第一次回调 elapsed 恒为 0，
  /// 一次长 pump 只落一帧、量到的还是起点。逐帧推进既绕开这个坑，也正好
  /// 复刻真机上的采样方式——每 16ms 量一次。
  Future<List<double>> advance(WidgetTester tester, int ms) async {
    const step = 16;
    final samples = <double>[];
    var left = ms;
    while (left > 0) {
      final d = left >= step ? step : left;
      await tester.pump(Duration(milliseconds: d));
      samples.add(railWidth(tester));
      left -= d;
    }
    return samples;
  }

  /// 纸的宽度：960 窗口 − 左栏 − 纸两侧各 4 的缝。常量直接取自两个组件，
  /// 不在这里抄数字——抄下来的数一旦和组件漂移，测试就会「通过但测错了」。
  const paperWidth = 960 - OndraSideRail.width - 8;

  testWidgets('收纳：宽度逐帧收到 0，中途每帧都介于两端之间', (tester) async {
    await pumpShell(tester, const Size(960, 660));
    expect(railWidth(tester), OndraAmbientRail.width);

    stateOf(tester).railOpen = false;
    await tester.pump();
    final frames = await advance(tester, 340);

    // 每一帧都在行程内：出现 280 说明没动（瞬切的前半），
    // 出现负值说明插值写错了。
    for (final w in frames) {
      expect(w, greaterThanOrEqualTo(0));
      expect(w, lessThanOrEqualTo(OndraAmbientRail.width));
    }
    // 至少要有一帧停在中间，才叫「滑过去」。
    expect(
      frames.where((w) => w > 0 && w < OndraAmbientRail.width),
      isNotEmpty,
    );
    // 单调收窄：宽度不许中途反弹（反弹＝动画被打断重来）。
    for (var i = 1; i < frames.length; i++) {
      expect(frames[i], lessThanOrEqualTo(frames[i - 1] + 0.01));
    }
    expect(frames.last, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('展开：从 0 连续长回 280', (tester) async {
    await pumpShell(tester, const Size(960, 660));
    final st = stateOf(tester);
    st.railOpen = false;
    await tester.pump();
    await advance(tester, 340);
    expect(railWidth(tester), 0);

    st.railOpen = true;
    await tester.pump();
    final frames = await advance(tester, 340);
    expect(
      frames.where((w) => w > 0 && w < OndraAmbientRail.width),
      isNotEmpty,
    );
    for (var i = 1; i < frames.length; i++) {
      expect(frames[i], greaterThanOrEqualTo(frames[i - 1] - 0.01));
    }
    expect(frames.last, OndraAmbientRail.width);
    expect(tester.takeException(), isNull);
  });

  testWidgets('沉浸：右栏铺满整张纸，中途有过渡帧', (tester) async {
    await pumpShell(tester, const Size(960, 660));
    stateOf(tester).chatFocus = true;
    await tester.pump();

    final frames = await advance(tester, 340);
    expect(
      frames.where((w) => w > OndraAmbientRail.width && w < paperWidth),
      isNotEmpty,
    );
    expect(frames.last, paperWidth);
    expect(tester.takeException(), isNull);
  });

  testWidgets('退沉浸：从满宽连续收回 280', (tester) async {
    await pumpShell(tester, const Size(960, 660));
    final st = stateOf(tester);
    st.chatFocus = true;
    await tester.pump();
    await advance(tester, 340);
    expect(railWidth(tester), paperWidth);

    st.chatFocus = false;
    await tester.pump();
    final frames = await advance(tester, 340);
    expect(
      frames.where((w) => w > OndraAmbientRail.width && w < paperWidth),
      isNotEmpty,
    );
    expect(frames.last, OndraAmbientRail.width);
    expect(tester.takeException(), isNull);
  });

  testWidgets('动画途中改主意：从半路折返，不先弹回起点', (tester) async {
    await pumpShell(tester, const Size(960, 660));
    final st = stateOf(tester);

    st.railOpen = false;
    await tester.pump();
    final outbound = await advance(tester, 144);
    final atTurn = outbound.last;
    expect(atTurn, greaterThan(0));
    expect(atTurn, lessThan(OndraAmbientRail.width));

    // 收到一半改为展开：宽度必须在**当前值**上继续增长。
    // 若实现先把宽度补回 0 再走上来，之后若干帧都会比 atTurn 小。
    st.railOpen = true;
    await tester.pump();
    final inbound = await advance(tester, 64);
    for (final w in inbound) {
      expect(w, greaterThanOrEqualTo(atTurn - 0.01));
    }

    await advance(tester, 300);
    expect(railWidth(tester), OndraAmbientRail.width);
    expect(tester.takeException(), isNull);
  });

  testWidgets('窗口变宽不触发右栏补间（目标立即跟随纸宽）', (tester) async {
    await pumpShell(tester, const Size(960, 660));
    final st = stateOf(tester);
    st.chatFocus = true;
    await tester.pump();
    await advance(tester, 340);
    expect(railWidth(tester), paperWidth);

    // 拖窗口：沉浸态下右栏应立刻等于新的纸宽，而不是播一段追赶动画。
    tester.view.physicalSize = const Size(1100, 660);
    await tester.pump();
    expect(railWidth(tester), 1100 - OndraSideRail.width - 8);
    expect(tester.takeException(), isNull);
  });
}
