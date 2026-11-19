/// profile 装配层的配置段编辑（`cordis.patch.yml` 条目级 `config` 块）。
///
/// Web / 测试环境没有文件系统，如实拒绝。
library;

export 'profile_config_stub.dart' if (dart.library.io) 'profile_config_io.dart';
