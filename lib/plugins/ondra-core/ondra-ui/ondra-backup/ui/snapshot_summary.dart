import 'backup_model.dart';

/// 一份快照按「顶层目录」归并后的一行。
///
/// 为什么归并：一份快照有几十个文件，逐条列出来是一张密密麻麻的表格，
/// 而用户在这一屏要判断的是「这份里有没有我要的东西」，按类看够了。
class SnapshotGroup {
  const SnapshotGroup({
    required this.key,
    required this.label,
    required this.files,
    required this.bytes,
  });

  /// 顶层目录名，或单文件自身的文件名。
  final String key;

  final String label;
  final int files;
  final int bytes;
}

/// 目录 → 人话。认不出来的原样显示目录名——编一个假名字比露出生路径更糟。
const Map<String, String> _labels = {
  'user': '人设与资料',
  'sessions': '对话存档',
  'storages': '工作区缓存',
  'profiles': '插件配置',
  'dsh': '内核配置',
  'prefs.json': '偏好设置',
};

/// 按顶层目录汇总，占空间大的在前。
List<SnapshotGroup> summarizeSnapshot(BackupSnapshot snapshot) {
  final files = <String, int>{};
  final bytes = <String, int>{};
  for (final f in snapshot.files) {
    final slash = f.path.indexOf('/');
    final key = slash < 0 ? f.path : f.path.substring(0, slash);
    files[key] = (files[key] ?? 0) + 1;
    bytes[key] = (bytes[key] ?? 0) + f.size;
  }
  final groups = [
    for (final entry in files.entries)
      SnapshotGroup(
        key: entry.key,
        label: _labels[entry.key] ?? entry.key,
        files: entry.value,
        bytes: bytes[entry.key] ?? 0,
      ),
  ];
  groups.sort((a, b) => b.bytes.compareTo(a.bytes));
  return groups;
}
