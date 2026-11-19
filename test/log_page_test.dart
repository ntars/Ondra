import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-logs/ui/log_page.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-logs/ui/log_types.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ui/settings_client.dart';

// 不落盘、不推内核；仍使用 ChangeNotifier 的真实监听行为。
class _Settings extends SettingsClient {
  String density = 'detailed';

  @override
  String choice(String key) =>
      key == 'logs.usageDetail' ? density : super.choice(key);

  @override
  Future<bool> set(String key, Object? value) async {
    if (key == 'logs.usageDetail') density = value as String;
    notifyListeners();
    return true;
  }
}

void main() {
  late _Settings settings;
  late List<({LogKind kind, int lines, Completer<List<LogEntry>> result})>
  requests;

  setUp(() {
    settings = _Settings();
    requests = [];
  });
  tearDown(() => settings.dispose());

  Future<List<LogEntry>> load(LogKind kind, {int maxLines = 200}) {
    final result = Completer<List<LogEntry>>();
    requests.add((kind: kind, lines: maxLines, result: result));
    return result.future;
  }

  Future<void> show(
    WidgetTester tester, {
    LogKind kind = LogKind.system,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Material(
          child: LogPage(kind: kind, settings: settings, loader: load),
        ),
      ),
    );
  }

  testWidgets('密度控件即时重载 60/200 行，无关设置不触发读取', (tester) async {
    await show(tester);
    expect(requests.single.lines, 200);
    requests.last.result.complete([]);
    await tester.pumpAndSettle();
    await tester.tap(find.text('简洁'));
    await tester.pump();
    expect(requests.last.lines, 60);
    requests.last.result.complete([]);
    await tester.pumpAndSettle();
    settings.set('unrelated', true);
    expect(requests, hasLength(2));
    await tester.tap(find.text('详细'));
    await tester.pump();
    expect(requests.last.lines, 200);
    requests.last.result.complete([]);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('刷新可重试错误，保留已加载内容及级别过滤', (tester) async {
    await show(tester);
    requests.last.result.completeError(StateError('fixture read failed'));
    await tester.pumpAndSettle();
    expect(find.textContaining('fixture read failed'), findsOneWidget);
    expect(find.text('没有匹配的日志'), findsNothing);
    await tester.tap(find.text('刷新'));
    await tester.pump();
    requests.last.result.complete(const [
      LogEntry(time: '12:00:00', title: '普通记录'),
      LogEntry(time: '12:00:01', title: '故障记录', level: LogLevel.error),
    ]);
    await tester.pumpAndSettle();
    expect(find.textContaining('fixture read failed'), findsNothing);
    await tester.tap(find.text('错误'));
    await tester.pumpAndSettle();
    expect(find.text('普通记录'), findsNothing);
    expect(find.text('故障记录'), findsOneWidget);
    await tester.tap(find.text('刷新'));
    await tester.pump();
    expect(find.text('正在刷新…'), findsOneWidget);
    requests.last.result.completeError(StateError('retry failed'));
    await tester.pumpAndSettle();
    expect(find.text('故障记录'), findsOneWidget);
    expect(find.textContaining('retry failed'), findsOneWidget);
  });

  testWidgets('过期成功与失败都不能覆盖最新请求，销毁后不更新状态', (tester) async {
    await show(tester);
    settings.set('logs.usageDetail', 'compact');
    await tester.pump();
    requests[1].result.complete(const [LogEntry(time: '', title: '新密度内容')]);
    await tester.pumpAndSettle();
    requests[0].result.complete(const [LogEntry(time: '', title: '旧密度内容')]);
    await tester.pumpAndSettle();
    expect(find.text('新密度内容'), findsOneWidget);
    expect(find.text('旧密度内容'), findsNothing);
    await tester.tap(find.text('刷新'));
    await tester.pump();
    await tester.tap(find.text('刷新'));
    await tester.pump();
    requests[3].result.complete(const [LogEntry(time: '', title: '最新内容')]);
    await tester.pumpAndSettle();
    requests[2].result.completeError(StateError('过期异常'));
    await tester.pumpAndSettle();
    expect(find.text('最新内容'), findsOneWidget);
    expect(find.textContaining('过期异常'), findsNothing);
    await tester.tap(find.text('刷新'));
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    requests.last.result.completeError(StateError('销毁后异常'));
    settings.set('logs.usageDetail', 'detailed');
    await tester.pumpAndSettle();
    expect(requests, hasLength(5));
    expect(tester.takeException(), isNull);
  });

  testWidgets('切换日志种类重载且忽略上一页回包', (tester) async {
    await show(tester);
    await show(tester, kind: LogKind.plugin);
    expect(requests.last.kind, LogKind.plugin);
    requests.last.result.complete(const [LogEntry(time: '', title: '插件内容')]);
    await tester.pumpAndSettle();
    requests.first.result.completeError(StateError('旧系统页异常'));
    await tester.pumpAndSettle();
    expect(find.text('插件内容'), findsOneWidget);
    expect(find.textContaining('旧系统页异常'), findsNothing);
  });

  testWidgets('截断标题和详情可打开滚动可选择的全文', (tester) async {
    await show(tester);
    final detail = List.generate(80, (i) => '完整详情第 $i 行').join('\n');
    requests.single.result.complete([
      LogEntry(
        time: '12:34:56',
        title: '很长的标题' * 20,
        detail: detail,
        tag: 'fixture',
      ),
    ]);
    await tester.pumpAndSettle();
    expect(tester.widget<Text>(find.text(detail)).maxLines, 2);
    await tester.tap(find.text('查看全文'));
    await tester.pumpAndSettle();
    expect(find.text('日志全文'), findsOneWidget);
    final full = tester.widget<SelectableText>(find.byType(SelectableText));
    expect(full.data, contains(detail));
    expect(full.data, contains('很长的标题' * 20));
    expect(full.maxLines, isNull);
    await tester.tap(find.text('关闭'));
    await tester.pumpAndSettle();
    expect(find.byType(SelectableText), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
