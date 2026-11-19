import 'profile_plugins_stub.dart'
    if (dart.library.io) 'profile_plugins_io.dart'
    as impl;

/// 装配层声明，不是运行时加载状态。版本与简介来自本机 package.json。
class ProfilePluginEntry {
  const ProfilePluginEntry({
    required this.id,
    required this.package,
    required this.version,
    required this.desc,
    required this.enabled,
    this.blockedReason,
  });

  final String id;
  final String package;
  final String version;
  final String desc;
  final bool enabled;

  /// 必要基础依赖、插件组或不能安全编辑的条目不给开关。
  final String? blockedReason;
}

/// 既按 id 也按包名保护，避免更换装配 id 后绕过保护。
String? profilePluginProtection(String id, String package) {
  const foundations = {
    'cordis',
    'dsh-base',
    'ondra-identity',
    'ondra-path-layout',
    'ondra-store',
    'ondra-storage',
    'ondra-store-sqlite',
    'ondra-store-json',
    'ondra-memory-core',
    'ondra-persona',
    'ondra-runtime',
    'ondra-process-host',
    'ondra-boot-settle',
    'ondra-config-schema',
    'ondra-privacy',
    'ondra-llm-gateway',
    'ondra-dialogue',
    'ondra-dialogue-protocol',
  };
  final packageId = package.startsWith('@ondra/cordis-plugin-')
      ? package.substring('@ondra/cordis-plugin-'.length)
      : package;
  bool necessary(String value) =>
      foundations.contains(value) ||
      value.startsWith('ondra-persona-') ||
      value.startsWith('ondra-runtime-') ||
      value.startsWith('dsh-runtime') ||
      value == '@deepseek-ai/dsh' ||
      value.startsWith('@deepseek-ai/dsh-') ||
      value.startsWith('@cordisjs/');
  if (necessary(id) || necessary(packageId)) return '必要基础依赖，不允许在此启停';
  // 真正的 profile 默认关闭此后端：启用会抢占 sqlite，导致记忆只留在内存。
  if (id == 'ondra-store-memory' || packageId == 'ondra-store-memory') {
    return '内存后端会与持久化存储冲突，不允许在此启用';
  }
  return null;
}

class ProfilePluginWriteResult {
  const ProfilePluginWriteResult.success() : error = null;
  const ProfilePluginWriteResult.failure(this.error);

  final String? error;
  bool get ok => error == null;
}

/// 未安装 profile 返回空；读取失败或不支持的结构抛错，由 UI 如实呈现。
Future<List<ProfilePluginEntry>> readProfilePlugins() =>
    impl.readProfilePlugins();

/// 完整条目块的可逆启停；保存前重新校验基础项与显式 inject 依赖。
/// 不重启内核：调用者须说明下次重启生效，不得中断进行中的对话。
Future<ProfilePluginWriteResult> updateProfilePluginEnabled(
  String id,
  bool enabled,
) => impl.updateProfilePluginEnabled(id, enabled);

/// 保留已有布尔接口；界面使用上面的详细结果显示拒绝/写盘失败原因。
Future<bool> setProfilePluginEnabled(String id, bool enabled) async =>
    (await updateProfilePluginEnabled(id, enabled)).ok;
