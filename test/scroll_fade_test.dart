import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/design/primitives.dart';

/// 滚动渐隐的合法性守卫。
///
/// 它拼的是一条多点 `LinearGradient`：色标数量要和颜色数量相等、必须升序、
/// 必须落在 0..1。这些断言只在**运行时**触发，编译期看不出来——所以这里
/// 真滚一次，让「开始滚（上端淡出）/ 滚到底（下端归零）」两条分支都跑到。
void main() {
  Widget harness() => MaterialApp(
    home: Scaffold(
      body: SizedBox(
        height: 200,
        child: OndraScrollFade(
          child: ListView(
            children: [
              for (var i = 0; i < 20; i++)
                SizedBox(height: 48, child: Text('第 $i 行')),
            ],
          ),
        ),
      ),
    ),
  );

  testWidgets('短列表：两端都不淡出，不抛异常', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 400,
            child: OndraScrollFade(
              child: ListView(
                children: const [SizedBox(height: 40, child: Text('只有一行'))],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('长列表：滚动中段两端都淡出', (tester) async {
    await tester.pumpWidget(harness());
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    // 先滚到中段：上端与下端都该有羽化。
    await tester.drag(find.byType(ListView), const Offset(0, -120));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);

    // 再滚到底：底端归零。
    await tester.drag(find.byType(ListView), const Offset(0, -4000));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
