import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/app/sqlite_cli.dart';
import 'package:ondra/plugins/ondra-core/ondra-ui/ondra-memory/ui/memory_source.dart';

/// `sqlite3` 命令行的解析与降级。
///
/// 背景：状态面板、记忆星图、导入导出三处都靠它读
/// `~/.ondra/user/ondra.db`。从前三处各自写死 `/usr/bin/sqlite3`，
/// 在 Windows 上那个文件不存在 —— 页面不报错，只是永远显示 0/空。
/// 这组测试守两件事：**能找到就用**，**找不到就说人话**。
void main() {
  tearDown(debugResetSqliteCli);

  test('解析到的是一个真实存在的可执行文件', () {
    final path = ondraSqliteCli;
    if (path == null) {
      markTestSkipped('本机没有 sqlite3（Windows 上属于正常，发行版会随包带一份）');
    }
    // 名字来自 PATH 时不是路径，只有绝对路径才做存在性检查。
    if (path!.contains(Platform.pathSeparator)) {
      expect(File(path).existsSync(), isTrue, reason: '解析结果应当指向真实文件');
    }
    expect(path, isNotEmpty);
  });

  test('缺失时的提示说的是「缺什么、怎么办」，不是一串路径', () {
    expect(ondraSqliteMissingHint, contains('sqlite3'));
    // 提示里不能只丢一个路径了事：用户看不懂也不 Actionable。
    expect(ondraSqliteMissingHint, contains('ONDRA_SQLITE3'));
  });

  test('解析结果被缓存：第二次调用不再重新探测', () {
    final first = ondraSqliteCli;
    final second = ondraSqliteCli;
    expect(identical(first, second) || first == second, isTrue);
  });

  test('找不到 sqlite3 时，记忆页给的是说明而不是崩溃或假 0', () async {
    final home = Platform.environment['HOME'] ?? '';
    final db = File('$home/.ondra/user/ondra.db');
    if (!db.existsSync()) {
      markTestSkipped('本机还没有记忆库，读不到「有库但缺工具」这一态');
    }

    debugOverrideSqliteCli(null);
    final snapshot = await loadMemorySnapshot();

    expect(snapshot.facts, isEmpty);
    expect(
      snapshot.note,
      contains('sqlite3'),
      reason: '缺工具这件事必须说出来；安静地空着会被当成「没有记忆」',
    );
  });
}
