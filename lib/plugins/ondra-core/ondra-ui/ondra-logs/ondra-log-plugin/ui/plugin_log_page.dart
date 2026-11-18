import 'package:material_ui/material_ui.dart';

import '../../ui/log_types.dart';
import '../../ui/log_page.dart';

/// 插件日志：三页共用 `ondra-logs/ui/log_page.dart` 的骨架，这一层只固定 [LogKind]。
///
/// 拆成三个插件是为了「一项功能一个插件」：谁的日志出问题，就只换那一个插件，
/// 共用骨架留在容器 `ondra-logs` 里，不复制三份。
class PluginLogPage extends StatelessWidget {
  const PluginLogPage({super.key});

  @override
  Widget build(BuildContext context) => const LogPage(kind: LogKind.plugin);
}
