import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/ondra_app.dart';
import 'package:ondra/app/version.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/module.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-settings/ondra-persona/ui/persona_client.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ui/registry.dart';

import 'support/form_factor.dart';

void main() {
  test('装配表完整：10 个模块，三组都非空，id 唯一', () {
    expect(OndraRegistry.all.length, 10);
    final ids = OndraRegistry.all.map((m) => m.id).toSet();
    expect(ids.length, OndraRegistry.all.length);
    for (final group in OndraGroup.values) {
      expect(OndraRegistry.byGroup(group), isNotEmpty, reason: '$group 为空');
    }
  });

  test('只有状态面板是核心模块，其余都可以缺席', () {
    final core = OndraRegistry.all.where((m) => m.core).map((m) => m.id);
    expect(core, ['status']);
    expect(OndraRegistry.byId('status'), isNotNull);
    expect(OndraRegistry.byId('不存在'), isNull);
  });

  test('启动默认页是状态面板', () {
    expect(OndraRegistry.initialId, 'status');
  });

  test('模块只剩「一项导航 + 一个页面」，右栏归外壳', () {
    // 右栏是全局唯一的聊天窗，模块契约里不再有助手名 / 建议句。
    // 这条断言守住分组规模：概览 2 项、空谷生命 5 项。
    expect(OndraRegistry.byGroup(OndraGroup.primary).length, 2);
    expect(OndraRegistry.byGroup(OndraGroup.life).length, 5);
  });

  test('侧栏三组的文案与顺序', () {
    expect(OndraRegistry.all.map((m) => m.label).toList(), [
      '状态面板',
      '记忆星图',
      '历史对话',
      '插件扩展',
      '备份还原',
      '导入导出',
      '使用教程',
      '对话日志',
      '插件日志',
      '系统日志',
    ]);
    expect(OndraGroup.primary.label, isNull);
    expect(OndraGroup.logs.label, '日志');
    expect(OndraGroup.life.label, '空谷生命');
    expect(OndraRegistry.byGroup(OndraGroup.logs).length, 3);
    expect(OndraRegistry.byGroup(OndraGroup.life).length, 5);
  });

  testWidgets('主窗能起：启动屏 → 三栏外壳', (tester) async {
    tester.view.physicalSize = const Size(960, 660);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(const OndraApp());
    await tester.pump(const Duration(milliseconds: 900));

    // 侧栏三个分组与首屏页面
    expect(find.text('状态面板'), findsWidgets);
    expect(find.text('记忆星图'), findsWidgets);
    expect(find.text('日志'), findsOneWidget);
    expect(find.text('空谷生命'), findsOneWidget);
    // 身份行显示的是人设包名，不是账号
    expect(find.text(ondraPersonaName), findsWidgets);
    // 右栏是聊天窗口：标题固定是产品名，不随页面变成「状态助手」
    expect(find.text(ondraProductName), findsWidgets);
    // 表头只有一行名字。曾经还有一句「内容由 AI 生成，仅供参考」压在人设名下面，
    // 现在对齐参考应用去掉了：那行免责声明既不是信息，也不该常驻在每次对话顶端。
    expect(find.text('内容由 AI 生成，仅供参考'), findsNothing);
  }, variant: desktopFormFactor);
}
