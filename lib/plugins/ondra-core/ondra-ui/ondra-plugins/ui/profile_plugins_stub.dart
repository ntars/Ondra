import 'profile_plugins.dart';

/// Web 没有本机 profile，不造清单或模拟写入成功。
Future<List<ProfilePluginEntry>> readProfilePlugins() async => const [];

Future<ProfilePluginWriteResult> updateProfilePluginEnabled(
  String id,
  bool enabled,
) async => const ProfilePluginWriteResult.failure('当前平台无法写入本机装配层');
