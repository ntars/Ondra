import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/app/i18n.dart';
import 'package:ondra/design/theme.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-browser/ui/browser_page.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-browser/ui/browser_client.dart';

void main() {
  testWidgets('浏览器文案不再把内嵌能力限制在 macOS', (tester) async {
    final client = BrowserClient(
      loadSites: () => <Map<String, String>>[],
      saveSites: (_) {},
    );
    addTearDown(client.dispose);
    await tester.pumpWidget(
      OndraI18nScope(
        child: MaterialApp(
          theme: ondraTheme(Brightness.light),
          home: const Scaffold(body: BrowserPage()),
        ),
      ),
    );
    await tester.pump();
    expect(find.textContaining('仅支持 macOS'), findsNothing);
    expect(find.textContaining('macOS 使用系统 WebKit'), findsNothing);
    expect(find.textContaining('系统浏览器组件渲染'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
