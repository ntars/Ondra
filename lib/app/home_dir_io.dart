import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// 用户主目录。
///
/// 顺序：`HOME` → `USERPROFILE`（Windows）→ 当前目录。
/// 最后一级只是兜底：宁可写到能写的地方，也不要抛在启动路径上。
///
/// 移动端（Android / iOS）的持久数据目录（`getApplicationDocumentsDirectory`），
/// 在 `main()` 的启动序列里初始化一次。null = 尚未就绪或拿不到，
/// 此时 `ondraUserHome` 回退到 TMPDIR（可写但可能被系统清理）。
String? _mobileOverride;

/// 启动时调用（`main()` 里 `await`）。移动端专属，其他平台是空操作。
Future<void> initMobileHome() async {
  if (!Platform.isAndroid && !Platform.isIOS) return;
  try {
    final dir = await getApplicationDocumentsDirectory();
    if (dir.path.isNotEmpty) _mobileOverride = dir.path;
  } catch (_) {
    // path_provider 不可用（冷启动竞态等）：保持 TMPDIR 回退，
    // 数据功能仍可用，只是可能被系统清理——好过整个应用起不来。
  }
}

String get ondraUserHome {
  final env = Platform.environment;
  if (Platform.isAndroid || Platform.isIOS) {
    final override = _mobileOverride;
    if (override != null && override.isNotEmpty) return override;
    final tmp = env['TMPDIR'];
    if (tmp != null && tmp.isNotEmpty) return tmp;
    return Directory.systemTemp.path;
  }
  final home = env['HOME'];
  if (home != null && home.isNotEmpty) return home;
  final profile = env['USERPROFILE'];
  if (profile != null && profile.isNotEmpty) return profile;
  return Directory.current.path;
}

/// Only visible to tests. Production resolves the directory at startup.
void debugSetMobileHomeForTest(String? path) {
  _mobileOverride = path;
}

/// `~/.ondra` —— 数据根目录的绝对路径。
///
/// 各处的 `'$home/.ondra'` 统一走这里，避免同一件事在十几个文件里各写一遍
/// 路径分隔符与兜底逻辑。正斜杠在 Windows 上也成立，`dart:io` 两种都认。
String get ondraUserDataRoot => '${ondraUserHome.replaceAll(r'\', '/')}/.ondra';
