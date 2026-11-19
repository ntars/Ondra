import 'dart:io';

import 'bundled_runtime.dart';

/// 找本机的 `sqlite3` 命令行。
///
/// **为什么需要这个文件**：状态面板、记忆星图、导入导出三处都要直接读
/// `~/.ondra/user/ondra.db`，而它们各自写死了 `/usr/bin/sqlite3`。那个路径
/// 只在 macOS 与多数 Linux 上成立；Windows 没有 `sqlite3.exe`，于是这三处
/// 在 Windows 上全部读不到数据——不是报错，是安静地显示「没有」。
///
/// 解析顺序：环境变量 → 随包运行时 → 各平台常见位置 → PATH。
/// 随包那份排在系统之前：发行包的承诺是「打开就能用」，不该因为用户
/// 机器上恰好有个版本不对的 sqlite3 而改变行为。
///
/// 找不到时返回 **null**，不抛异常也不编路径：调用方据此降级并如实说明，
/// 而不是让一整页因为缺一个命令行工具变成空白。
String? get ondraSqliteCli {
  if (_probed) return _cache;
  _probed = true;
  _cache = _resolve();
  return _cache;
}

/// 给人看的一句话，用在「读不到数据」的地方。
const String ondraSqliteMissingHint =
    '本机没有找到 sqlite3 命令行工具，记忆库的读数暂时读不到。'
    '发行版会随包带一份；从源码运行时可以安装 sqlite3，'
    '或用环境变量 ONDRA_SQLITE3 指向它。';

String? _cache;
bool _probed = false;

/// 测试用：强制解析结果。[path] 传 null 表示「当作本机没有」。
///
/// 生产代码不该调用它——`Platform.environment` 在进程内不可改，不开口子就
/// 没法验证「找不到 sqlite3 时界面会说人话」这条分支。
void debugOverrideSqliteCli(String? path) {
  _probed = true;
  _cache = path;
}

/// 测试用：清缓存便于重复探测。
void debugResetSqliteCli() {
  _probed = false;
  _cache = null;
}

String? _resolve() {
  final fromEnv = Platform.environment['ONDRA_SQLITE3'];
  if (fromEnv != null && fromEnv.isNotEmpty && File(fromEnv).existsSync()) {
    return fromEnv;
  }

  // 随包运行时。Windows 上这是唯一一条能成立的路径——系统里没有 sqlite3。
  final bundled = ondraBundledRuntime;
  if (bundled != null) {
    final candidate =
        '${bundled.rootDir}${Platform.pathSeparator}${_exeName()}';
    if (File(candidate).existsSync()) return candidate;
  }

  for (final candidate in _platformCandidates()) {
    if (File(candidate).existsSync()) return candidate;
  }

  // 最后交给 PATH。真跑一次 `-version` 而不是相信名字存在：
  // 「有个同名的东西但跑不起来」比「没有」更难查。
  try {
    final probe = Process.runSync(
      _exeName(),
      ['-version'],
      stdoutEncoding: null,
      stderrEncoding: null,
    );
    if (probe.exitCode == 0) return _exeName();
  } on ProcessException {
    // 就是这里「没装」的正常表现
  } on Object {
    // 权限之类的意外：当作不可用，让上层降级
  }
  return null;
}

String _exeName() => Platform.isWindows ? 'sqlite3.exe' : 'sqlite3';

/// 各平台的常见安装位置。
///
/// 应用从 Finder / 开始菜单启动时 PATH 很短，靠 `sqlite3` 这个名字碰运气不稳，
/// 所以主流包管理器装的位置都列一遍。**不含**用户自定义前缀：那种情况
/// 用 `ONDRA_SQLITE3` 更准确。
List<String> _platformCandidates() {
  if (Platform.isWindows) {
    final localAppData = Platform.environment['LOCALAPPDATA'] ?? '';
    return [
      r'C:\ProgramData\chocolatey\bin\sqlite3.exe',
      r'C:\Program Files\sqlite\sqlite3.exe',
      if (localAppData.isNotEmpty)
        '$localAppData${Platform.pathSeparator}Microsoft'
            '${Platform.pathSeparator}WindowsApps'
            '${Platform.pathSeparator}sqlite3.exe',
    ];
  }
  return [
    '/usr/bin/sqlite3',
    '/usr/local/bin/sqlite3',
    '/opt/homebrew/bin/sqlite3',
    '/opt/local/bin/sqlite3',
    '/snap/bin/sqlite3',
  ];
}
