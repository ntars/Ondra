import '../../../../design/glyph.dart';
import '../ondra-backup/ui/backup_page.dart';
import '../ondra-history/ui/history_page.dart';
import '../ondra-guide/ui/guide_page.dart';
import '../ondra-logs/ondra-log-dialog/ui/dialog_log_page.dart';
import '../ondra-logs/ondra-log-plugin/ui/plugin_log_page.dart';
import '../ondra-logs/ondra-log-system/ui/system_log_page.dart';
import '../ondra-memory/ui/memory_page.dart';
import '../ondra-plugins/ui/plugins_page.dart';
import '../ondra-status/ui/status_page.dart';
import '../ondra-transfer/ui/transfer_page.dart';
import 'module.dart';

/// 装配表：全应用唯一枚举模块的地方。
///
/// 这里是「清单」，不是「依赖」——装哪些由 `--dart-define=ondra_absent=a,b`
/// 决定，缺席的模块只是不出现在侧栏，不需要改代码、不需要改路由。
///
/// 顺序即侧栏顺序：状态面板 / 记忆星图 → 空谷生命五项 → 日志三项。
/// 第一个模块就是启动后的默认页，所以「状态面板」进门即见。
///
/// 空谷生命五项的顺序是「回看 → 扩展 → 保底 → 搬家 → 学会」：
/// 历史对话排第一，因为聊天发生在右栏，左栏第一件要能回答的事就是「我聊过什么」；
/// 导入导出与使用教程垫在最后——它们是一次性动作，不是每天要点的东西。
///
/// 「新建对话」不在这里：聊天窗就是右栏，再给一个「新建对话」的页面，
/// 等于让同一件事有两个入口，而其中一个还不能说话。
class OndraRegistry {
  const OndraRegistry._();

  static final List<OndraModule> all = [
    OndraModule(
      id: 'status',
      label: '状态面板',
      glyph: Glyphs.navStatus,
      group: OndraGroup.primary,
      core: true,
      build: (_) => const StatusPage(),
    ),
    OndraModule(
      id: 'memory',
      label: '记忆星图',
      glyph: Glyphs.navMemory,
      group: OndraGroup.primary,
      build: (_) => const MemoryPage(),
    ),
    OndraModule(
      id: 'history',
      label: '历史对话',
      glyph: Glyphs.navHistory,
      group: OndraGroup.life,
      build: (_) => const HistoryPage(),
    ),
    OndraModule(
      id: 'plugins',
      label: '插件扩展',
      glyph: Glyphs.navPlugin,
      group: OndraGroup.life,
      build: (_) => const PluginsPage(),
    ),
    OndraModule(
      id: 'backup',
      label: '备份还原',
      glyph: Glyphs.navBackup,
      group: OndraGroup.life,
      build: (_) => const BackupPage(),
    ),
    OndraModule(
      id: 'transfer',
      label: '导入导出',
      glyph: Glyphs.navTransfer,
      group: OndraGroup.life,
      build: (_) => const TransferPage(),
    ),
    OndraModule(
      id: 'guide',
      label: '使用教程',
      glyph: Glyphs.navGuide,
      group: OndraGroup.life,
      build: (_) => const GuidePage(),
    ),
    OndraModule(
      id: 'log-dialog',
      label: '对话日志',
      glyph: Glyphs.navLogDialog,
      group: OndraGroup.logs,
      build: (_) => const DialogLogPage(),
    ),
    OndraModule(
      id: 'log-plugin',
      label: '插件日志',
      glyph: Glyphs.navLogPlugin,
      group: OndraGroup.logs,
      build: (_) => const PluginLogPage(),
    ),
    OndraModule(
      id: 'log-system',
      label: '系统日志',
      glyph: Glyphs.navLogSystem,
      group: OndraGroup.logs,
      build: (_) => const SystemLogPage(),
    ),
  ];

  static const String _absentEnv = String.fromEnvironment('ondra_absent');
  static const String _startEnv = String.fromEnvironment('ondra_start');

  /// 被声明为缺席的模块 id。`core: true` 的模块即使写进来也不会缺席。
  static Set<String> get absentIds {
    if (_absentEnv.trim().isEmpty) return const <String>{};
    return _absentEnv
        .split(',')
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .toSet();
  }

  static List<OndraModule> get available {
    final absent = absentIds;
    return all
        .where((m) => m.core || !absent.contains(m.id))
        .toList(growable: false);
  }

  static List<OndraModule> byGroup(OndraGroup group) =>
      available.where((m) => m.group == group).toList(growable: false);

  static OndraModule? byId(String id) {
    for (final m in available) {
      if (m.id == id) return m;
    }
    return null;
  }

  /// 首屏落在哪个模块：`--dart-define=ondra_start=memory`。
  /// 未指定、或指定的模块不在场时，落回第一个可用模块（状态面板）。
  static String get initialId {
    if (_startEnv.isNotEmpty && byId(_startEnv) != null) return _startEnv;
    return available.isEmpty ? '' : available.first.id;
  }
}
