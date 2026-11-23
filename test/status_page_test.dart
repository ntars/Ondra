import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/design/theme.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-status/ui/status_page.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-status/ui/status_types.dart';

void main() {
  final originalLoader = statusSnapshotLoader;

  tearDown(() {
    statusSnapshotLoader = originalLoader;
  });

  testWidgets('数据库读数为零但存在查询错误时，告警仍显示', (tester) async {
    statusSnapshotLoader = () async => const StatusSnapshot(
      facts: 0,
      raws: 0,
      links: 0,
      archived: 0,
      rawsLastDay: 0,
      sessions: 0,
      plugins: 0,
      dbBytes: 0,
      backupCount: 0,
      backupBytes: 0,
      sources: [],
      metrics: [
        MetricReading(label: '记忆', hint: '测试', value: '0 条'),
        MetricReading(label: '活跃', hint: '测试', value: '0 条'),
        MetricReading(label: '沉淀', hint: '测试', value: '—'),
      ],
      note: '数据库读取异常（以下读数可能不是真实数据）：database disk image is malformed',
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: ondraTheme(Brightness.light),
        home: const StatusPage(),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.textContaining('database disk image is malformed'),
      findsOneWidget,
    );
  });
}
