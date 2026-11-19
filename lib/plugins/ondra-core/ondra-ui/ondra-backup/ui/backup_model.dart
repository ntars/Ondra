/// 备份的数据形状：一次快照、一份总览、一条结果。
///
/// 这里只放**结构**，不放实现：桌面端由 `backup_engine_io.dart` 读写
/// `~/.ondra/backups`，浏览器预览里由 `backup_engine_stub.dart` 返回空。
/// 界面只认这些类型，两边同名同形。
library;

/// 快照是**怎么来的**。
///
/// 四种来源分开记，不是装饰：恢复前自动存的那一份必须能和用户手动建的
/// 区分开——出问题时先找「恢复前」，而不是在几十份手动备份里翻。
enum BackupTrigger {
  /// 用户在页面上按了「立即备份」。
  manual,

  /// 自动备份到点了。
  auto,

  /// 恢复之前自动存的一份底。
  preRestore,

  /// 从另一个目录导入的备份。
  imported;

  String get label => switch (this) {
    BackupTrigger.manual => '手动',
    BackupTrigger.auto => '自动',
    BackupTrigger.preRestore => '恢复前',
    BackupTrigger.imported => '导入',
  };

  /// 清单里存的是这个名字，不存枚举序号——序号会随枚举顺序变化而错位。
  String get code => name;

  static BackupTrigger fromCode(String? code) {
    for (final t in BackupTrigger.values) {
      if (t.name == code) return t;
    }
    // 认不出来的一律当手动：宁可少一个「自动」标签，也不要让整份清单读失败。
    return BackupTrigger.manual;
  }
}

/// 快照里的一条文件记录。
///
/// [path] 是**相对 `~/.ondra` 的路径**，不是绝对路径：备份要能搬到另一台
/// 机器上还原，绝对路径写死了就搬不过去。
class BackupFileEntry {
  const BackupFileEntry({
    required this.path,
    required this.size,
    required this.hash,
    required this.modified,
  });

  final String path;
  final int size;

  /// 内容指纹（16 位十六进制）。**不是加密哈希**：只用来判断「两份文件是不是
  /// 同一份内容」，进而决定要不要再存一遍。碰撞概率对几千个文件可以忽略，
  /// 但它不承担任何防篡改职责。
  final String hash;

  /// 修改时间（毫秒时间戳），仅用于展示「这份文件最后一次改是什么时候」。
  final int modified;

  Map<String, Object?> toJson() => {
    'p': path,
    's': size,
    'h': hash,
    'm': modified,
  };

  static BackupFileEntry? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final p = raw['p'];
    final size = raw['s'];
    final hash = raw['h'];
    final modified = raw['m'];
    if (p is! String ||
        !BackupPaths.isAsset(p) ||
        size is! int ||
        size < 0 ||
        hash is! String ||
        !RegExp(r'^[0-9a-f]{16}$').hasMatch(hash) ||
        modified is! int ||
        modified < 0) {
      return null;
    }
    return BackupFileEntry(path: p, size: size, hash: hash, modified: modified);
  }
}

/// 采集与清单解析共用同一份资产白名单，导入不能扩大恢复的写入权限。
abstract final class BackupPaths {
  static const trees = [
    'user',
    'sessions',
    'dsh/sessions',
    'personas',
    'storages',
  ];
  static const singleFiles = [
    'prefs.json',
    'models.json',
    'browser-sites.json',
    'avatar.png',
  ];
  static const excludedDirectories = {
    'node_modules',
    '.git',
    '.venv',
    '__pycache__',
    '.cache',
    'plugins',
    'runtime',
    'profiles',
    'backups',
    'scripts',
    'credentials',
    'secrets',
    '.ssh',
  };
  static const _extensions = {
    'json',
    'jsonl',
    'md',
    'txt',
    'yaml',
    'yml',
    'png',
    'jpg',
    'jpeg',
    'webp',
    'gif',
    'svg',
    'db',
    'sqlite',
    'sqlite3',
    'csv',
  };

  /// 使用可跨平台搬运的规范相对路径；同时挡住 Windows ADS/盘符/设备名。
  static bool isRelative(String path) {
    if (path.isEmpty || RegExp(r'[\\\x00-\x1f\x7f:*?"<>|]').hasMatch(path)) {
      return false;
    }
    return path
        .split('/')
        .every(
          (part) =>
              part.isNotEmpty &&
              part != '.' &&
              part != '..' &&
              !part.endsWith('.') &&
              !part.endsWith(' ') &&
              !RegExp(
                r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)',
                caseSensitive: false,
              ).hasMatch(part),
        );
  }

  static bool isAsset(String path) {
    if (!isRelative(path)) return false;
    if (singleFiles.contains(path)) return true;
    if (!trees.any((tree) => path.startsWith('$tree/'))) return false;
    final parts = path.toLowerCase().split('/');
    if (parts.any(excludedDirectories.contains)) return false;
    final leaf = parts.last;
    if (leaf.startsWith('.') ||
        RegExp(r'(^|[._-])(credentials?|secrets?|tokens?|api[-_]?key)([._-]|$)')
            .hasMatch(leaf) ||
        {
          'package.json',
          'package-lock.json',
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
          'cordis.yml',
          'cordis.patch.yml',
        }.contains(leaf)) {
      return false;
    }
    // PersonaStore 发布的内核人设包只位于这一层，不能泛化成任意 ZIP 白名单。
    // slug 与人设存储约定一致：保留历史大小写/点，但不允许隐藏名、连续点或尾点。
    if (parts.length == 3 &&
        path.startsWith('user/personas/') &&
        path.endsWith('.skill.zip')) {
      final name = path.split('/').last;
      final slug = name.substring(0, name.length - '.skill.zip'.length);
      return RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$').hasMatch(slug) &&
          !slug.contains('..') &&
          !slug.endsWith('.');
    }
    return _extensions.contains(leaf.split('.').last);
  }

  /// 不能静默过滤坏条目，否则一份有问题的备份会被显示成「部分成功」。
  static List<BackupFileEntry> parseFiles(Object? raw) {
    if (raw is! List || raw.isEmpty) throw const FormatException('清单文件列表为空或无效');
    final files = <BackupFileEntry>[];
    final paths = <String>{};
    for (final item in raw) {
      final entry = BackupFileEntry.fromJson(item);
      if (entry == null) throw const FormatException('清单含不安全路径或无效 hash/size');
      // 即使在区分大小写的系统导入，也不能生成搬到 macOS/Windows 会冲突的备份。
      if (!paths.add(entry.path.toLowerCase())) {
        throw FormatException('清单路径重复：${entry.path}');
      }
      files.add(entry);
    }
    for (final path in paths) {
      final parts = path.split('/');
      for (var i = 1; i < parts.length; i++) {
        if (paths.contains(parts.take(i).join('/'))) {
          throw FormatException('清单文件/目录路径冲突：$path');
        }
      }
    }
    return files;
  }
}

/// 一次快照。
class BackupSnapshot {
  const BackupSnapshot({
    required this.id,
    required this.createdAt,
    required this.trigger,
    required this.files,
    required this.sourceBytes,
    required this.newBytes,
    required this.newFiles,
  });

  /// 目录名，形如 `20261117-210305`。同一秒内建两次时末尾补 `-2`。
  final String id;

  final DateTime createdAt;
  final BackupTrigger trigger;

  /// 这份快照包含的文件清单。容量不大（几百条），一次全读进内存比
  /// 边读边算省事。
  final List<BackupFileEntry> files;

  /// 清单里所有文件的原始大小之和。
  final int sourceBytes;

  /// 这份快照**新写进对象库**的字节数。等于 [sourceBytes] 时说明全是新内容；
  /// 远小于它说明大部分文件没变过，去重生效了。
  final int newBytes;

  /// 新写入的文件条数。
  final int newFiles;

  int get fileCount => files.length;

  /// 这份快照替对象库省下的字节数。
  int get savedBytes => sourceBytes - newBytes;

  BackupSnapshot withFiles(List<BackupFileEntry> next) => BackupSnapshot(
    id: id,
    createdAt: createdAt,
    trigger: trigger,
    files: next,
    sourceBytes: sourceBytes,
    newBytes: newBytes,
    newFiles: newFiles,
  );
}

/// 自动备份与保留策略。存在 `backups/settings.json`。
class BackupSettings {
  const BackupSettings({
    this.auto = true,
    this.intervalMinutes = 60,
    this.keep = 24,
    this.lastAt,
  });

  final bool auto;

  /// 自动备份间隔（分钟）。默认 60，与「每小时一份」这句话对得上。
  final int intervalMinutes;

  /// 保留份数上限。超出后从最旧的开始删。
  final int keep;

  /// 上一次**自动**备份的时间；手动备份不刷新它，否则会把手动的当成自动的，
  /// 一小时一次就永远轮不到。
  final DateTime? lastAt;

  BackupSettings copyWith({
    bool? auto,
    int? intervalMinutes,
    int? keep,
    DateTime? lastAt,
  }) => BackupSettings(
    auto: auto ?? this.auto,
    intervalMinutes: intervalMinutes ?? this.intervalMinutes,
    keep: keep ?? this.keep,
    lastAt: lastAt ?? this.lastAt,
  );

  Map<String, Object?> toJson() => {
    'auto': auto,
    'intervalMinutes': intervalMinutes,
    'keep': keep,
    'lastAt': lastAt?.toIso8601String(),
  };

  static BackupSettings fromJson(Object? raw) {
    if (raw is! Map) return const BackupSettings();
    return BackupSettings(
      auto: raw['auto'] as bool? ?? true,
      intervalMinutes: (raw['intervalMinutes'] as num?)?.toInt() ?? 60,
      keep: (raw['keep'] as num?)?.toInt() ?? 24,
      lastAt: DateTime.tryParse(raw['lastAt'] as String? ?? ''),
    );
  }
}

/// 页面一次加载拿到的全部东西。
class BackupOverview {
  const BackupOverview({
    required this.snapshots,
    required this.storedBytes,
    required this.sourceBytes,
    required this.liveFiles,
    required this.liveBytes,
    required this.rootPath,
    required this.settings,
    this.note = '',
  });

  /// 新到旧。
  final List<BackupSnapshot> snapshots;

  /// 对象库实际占用（去重之后的真实体积）。
  final int storedBytes;

  /// 所有快照的原始大小之和。与 [storedBytes] 的差就是去重省下的。
  final int sourceBytes;

  /// 当前本机数据的文件数与字节数（未入库，只用于「现在」这一档）。
  final int liveFiles;
  final int liveBytes;

  final String rootPath;
  final BackupSettings settings;

  /// 非空表示「这次为什么没有快照」，界面据此区分空目录与读不到。
  final String note;

  bool get isEmpty => snapshots.isEmpty;

  int get savedBytes => sourceBytes - storedBytes;

  DateTime? get lastAt => snapshots.isEmpty ? null : snapshots.first.createdAt;

  static const empty = BackupOverview(
    snapshots: [],
    storedBytes: 0,
    sourceBytes: 0,
    liveFiles: 0,
    liveBytes: 0,
    rootPath: '',
    settings: BackupSettings(),
  );

  /// 换一句说明，其余照旧。给「同一份空总览、不同的空态理由」用。
  BackupOverview copyWithNote(String note) => BackupOverview(
    snapshots: snapshots,
    storedBytes: storedBytes,
    sourceBytes: sourceBytes,
    liveFiles: liveFiles,
    liveBytes: liveBytes,
    rootPath: rootPath,
    settings: settings,
    note: note,
  );

  /// 换一份设置（开关自动备份之后要就地更新，不必再扫一遍目录）。
  BackupOverview copyWithSettings(BackupSettings next) => BackupOverview(
    snapshots: snapshots,
    storedBytes: storedBytes,
    sourceBytes: sourceBytes,
    liveFiles: liveFiles,
    liveBytes: liveBytes,
    rootPath: rootPath,
    settings: next,
    note: note,
  );
}

/// 一次操作的结果。界面拿 [message] 直接显示，不自己拼文案——
/// 只有引擎知道「恢复了几个文件、有几个没在该快照里」。
class BackupOpResult {
  const BackupOpResult({
    required this.ok,
    required this.message,
    this.snapshotId,
  });

  final bool ok;
  final String message;
  final String? snapshotId;

  const BackupOpResult.failure(String message)
    : this(ok: false, message: message);
}

/// 字节的人类读法。
///
/// 用 1024 进制但写 KB 而不是 KiB：这个数字是给人看「占了多少」的，
/// 不是给工具算的，和系统「存储空间」里看到的口径一致更重要。
String backupBytes(int bytes) {
  if (bytes < 0) return '0 B';
  if (bytes < 1024) return '$bytes B';
  final kb = bytes / 1024;
  if (kb < 1024) return '${_trim(kb)} KB';
  final mb = kb / 1024;
  if (mb < 1024) return '${_trim(mb)} MB';
  return '${_trim(mb / 1024)} GB';
}

/// 一位小数，但整数不带 `.0`。
String _trim(double v) {
  final fixed = v.toStringAsFixed(1);
  return fixed.endsWith('.0') ? fixed.substring(0, fixed.length - 2) : fixed;
}

/// 时间点的说法：今天 / 昨天 / 月日 / 年月日。
///
/// 备份列表里最常看的是「刚才那份」和「昨天那份」，所以近两天用相对说法，
/// 再往前才退回日期——比满屏 `2026-11-17 21:03` 好扫。
String backupWhen(DateTime at, {DateTime? now}) {
  final ref = now ?? DateTime.now();
  final day = DateTime(at.year, at.month, at.day);
  final today = DateTime(ref.year, ref.month, ref.day);
  final diff = today.difference(day).inDays;
  final hm = '${_two(at.hour)}:${_two(at.minute)}';

  if (diff == 0) return '今天 $hm';
  if (diff == 1) return '昨天 $hm';
  if (at.year == ref.year) return '${at.month}月${at.day}日 $hm';
  return '${at.year}年${at.month}月${at.day}日 $hm';
}

/// 只要日期，不带时分。时间轴分组的组头用它。
String backupDay(DateTime at, {DateTime? now}) {
  final ref = now ?? DateTime.now();
  final day = DateTime(at.year, at.month, at.day);
  final today = DateTime(ref.year, ref.month, ref.day);
  final diff = today.difference(day).inDays;
  if (diff == 0) return '今天';
  if (diff == 1) return '昨天';
  if (at.year == ref.year) return '${at.month}月${at.day}日';
  return '${at.year}年${at.month}月${at.day}日';
}

String _two(int v) => v < 10 ? '0$v' : '$v';
