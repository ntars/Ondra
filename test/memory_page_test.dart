import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/design/theme.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-memory/ui/memory_page.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-memory/ui/memory_types.dart';

/// 星图停留时的自动重读：新增记忆即使页面一直开着，也会在下一轮点亮。
void main() {
  MemorySnapshot first = const MemorySnapshot(
    facts: [
      MemoryRecord(
        id: 'old',
        category: 'fact',
        text: '旧记忆。',
        salience: 50,
        createdAt: null,
      ),
    ],
    links: [],
  );
  MemorySnapshot second = const MemorySnapshot(
    facts: [
      MemoryRecord(
        id: 'old',
        category: 'fact',
        text: '旧记忆。',
        salience: 50,
        createdAt: null,
      ),
      MemoryRecord(
        id: 'new',
        category: 'event',
        text: '刚新增的记忆。',
        salience: 90,
        createdAt: null,
      ),
    ],
    links: [],
  );
  final originalLoader = memorySnapshotLoader;
  var calls = 0;

  setUp(() {
    calls = 0;
    memorySnapshotLoader = () async {
      calls++;
      return calls == 1 ? first : second;
    };
  });

  tearDown(() => memorySnapshotLoader = originalLoader);

  testWidgets('定时器再次读取，并把新增的点画出来', (tester) async {
    tester.view.physicalSize = const Size(960, 660);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ondraTheme(Brightness.light),
        // 脉冲动画永不结束，不能用 pumpAndSettle。
        home: const Material(
          child: MemoryPage(refreshInterval: Duration(milliseconds: 50)),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(calls, 1);
    expect(find.textContaining('旧记忆'), findsWidgets);
    expect(find.textContaining('刚新增的记忆'), findsNothing);

    await tester.pump(const Duration(milliseconds: 60));
    await tester.pump();

    expect(calls, greaterThanOrEqualTo(2));
    expect(find.textContaining('刚新增的记忆'), findsWidgets);
    expect(tester.takeException(), isNull);
  });
}
