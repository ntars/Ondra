import 'profile_plugins_stub.dart'
    if (dart.library.io) 'profile_plugins_io.dart' as impl;

/// profile 装配层里的一条真实插件记录。
///
/// 来源是 `$HOME/.ondra/dsh/profiles/ondra/cordis.patch.yml` 的 `insert` 列表：
/// 一行 `- id: <id>` 配一行 `name: '<包名>'`。包名再回 `node_modules` 里
/// 读 `package.json` 补版本与简介——**这三样都是内核实际加载的东西**，
/// 不是随包清单里写的愿望。
class ProfilePluginEntry {
  const ProfilePluginEntry({
    required this.id,
    required this.package,
    required this.version,
    required this.desc,
    required this.enabled,
  });

  /// 装配层里的插件 id（包名去掉 `@ondra/cordis-plugin-` 前缀）。
  final String id;

  /// npm 包名，如 `@ondra/cordis-plugin-ondra-absence`。
  final String package;

  /// 取自该包的 `package.json`；读不到时为 `-`，不猜。
  final String version;

  /// 该包的 `description`，可能是一整段；界面负责截。
  final String desc;

  /// 装配层里是否未被注释。关掉的插件会留一条 `# - id:` 注释行，
  /// 所以随时能再打开，而不是从文件里消失。
  final bool enabled;
}

/// 读装配层：返回 profile 里装了哪些插件、哪些被关着。
///
/// 读不到（没装 profile、文件被删）返回空列表，不报错——那说明这台机器上
/// 内核还没装配过，界面显示空态才是真话。
Future<List<ProfilePluginEntry>> readProfilePlugins() => impl.readProfilePlugins();

/// 打开或关掉一条插件：改的是装配层里那两行的注释状态。
///
/// 返回 `false` 表示没找到这一条、或写盘失败。**不假装成功**：
/// 界面拿到 false 会把开关拨回去。
///
/// 为什么要等到「下次连接内核」：装配层在主进程启动时读一次，
/// 正在跑的进程不会重新读 YAML。
Future<bool> setProfilePluginEnabled(String id, bool enabled) =>
    impl.setProfilePluginEnabled(id, enabled);
