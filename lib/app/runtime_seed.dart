/// 首次运行时把包里的 profile 种子铺到用户目录。
///
/// 内核只从 `$DSH_HOME/profiles/<name>` 读装配层（`dsh-app-boot` 里写死
/// `PROFILES_DIR = "profiles"`，没有搜索路径环境变量）。新机器上这个目录不存在，
/// 内核会直接抛 `profile "ondra" does not exist`。所以安装包带了一份种子，
/// 首次启动时复制过去。
///
/// **只在目标不存在时复制。** 已有安装的用户保留自己那份：插件能通过安装器
/// 更新，不必每次升级应用都覆盖回去。这条规则是这个文件的核心，改动它等于
/// 改变「插件归谁管」的产品决定。
library;

export 'runtime_seed_stub.dart' if (dart.library.io) 'runtime_seed_io.dart';
