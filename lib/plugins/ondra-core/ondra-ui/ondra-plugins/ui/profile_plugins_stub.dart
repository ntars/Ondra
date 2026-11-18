import 'profile_plugins.dart';

/// Web / 测试环境没有 `dart:io`，读不到 profile 目录。
///
/// 这里**返回空而不是假数据**：插件清单只有一份真货，在磁盘上；
/// Web 版没有磁盘，那就如实显示「没读到」，而不是凭空列一串装没装过的东西。
Future<List<ProfilePluginEntry>> readProfilePlugins() async => const [];

Future<bool> setProfilePluginEnabled(String id, bool enabled) async => false;
