import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform;

import '../../../../../app/desktop_picker.dart';
import '../../../../../app/home_dir.dart';
import '../../../../../app/platform_capabilities.dart';
import 'profile_config.dart';

/// 应用级维护动作：导出全部数据、清空全部数据、清缓存、查系统权限。
///
/// ## 为什么这些不放在备份插件里
///
/// 备份插件的职责是「按内容存快照、能回滚」。这里要的是两件不同的事：
/// - **导出**：连同一个还原入口都不给的裸目录（给人拿走，不是给应用读回）；
/// - **清空**：删掉数据本身，不是删掉某一份快照。
///
/// 两件事的后果都比「做一份备份」重，所以单独一层，调用点也各自确认。
class OndraMaintenance {
  OndraMaintenance({
    String? home,
    this.dataIsOffline,
    String? personaSubdir,
    String? Function(String section, String key)? profileConfigReader,
  }) : home = home ?? _defaultHome(),
       _personaSubdirOverride = personaSubdir,
       // 注入 home 的离线工具与测试不应顺手读真实用户目录的 profile；
       // 生产环境不传 home，按内核实际配置解析自定义 user-subdir。
       _readConfig =
           profileConfigReader ??
           (home == null ? readProfileConfigField : _noConfig);

  final String home;
  final bool Function()? dataIsOffline;
  final String? _personaSubdirOverride;
  final String? Function(String section, String key) _readConfig;

  static String? _noConfig(String section, String key) => null;

  bool get _offline => dataIsOffline?.call() ?? maintenanceDataIsOffline(home);

  static String _defaultHome() => '$ondraUserHome/.ondra';

  /// 导出范围：**用户数据**，不含缓存与日志。
  ///
  /// `cache/`、`tmp/`、`logs/` 不导出：前两个是可重建的临时物，日志是排障材料
  /// 而不是用户资产，一起打包只会让「我的数据」这件事变模糊。
  static const List<String> _exportTrees = [
    'user',
    'sessions',
    'dsh/sessions',
    'personas',
    'storages',
  ];

  static const List<String> _exportFiles = [
    'prefs.json',
    'models.json',
    'avatar.png',
  ];

  /// 清空范围。比导出范围大：用户说「清空全部数据」就是要它真的空，
  /// 留着 sessions 或 storages 会让「清空」这个词变成假的。
  ///
  /// **不删 `profiles/`**：那是插件装配层，删了应用起不来，它也不是用户数据。
  /// **不删 `personas/`**：用户装的人设包算用户资产，但它属于「设置」不属于
  /// 「记忆与会话」；设置页的清空动作在文案里写的是「删掉记忆与会话」。
  static const List<String> _wipeTrees = [
    'sessions',
    'dsh/sessions',
    'storages',
    // 清空承诺会删掉设备缓存；cache/ 与 tmp/ 是可重建的临时物，
    // 不能留到下一位使用者仍然看到旧缓存。
    'cache',
    'tmp',
  ];

  static const List<String> _wipeFiles = ['prefs.json'];

  /// 缓存范围。只碰这两个目录，别的都不动。
  static const List<String> _cacheTrees = ['cache', 'tmp'];

  /// 内核人设 ZIP 实际所在的用户子目录。默认 `personas`，但
  /// `persona-loader.user-subdir` 可以改成别的名字；清空时只保留这一个
  /// 子目录，不能把整个 `user/` 移走（alpha.15 审查：清空会拆散人设包）。
  String get _personaSubdir {
    final raw =
        _personaSubdirOverride ??
        _readConfig('persona-loader', 'user-subdir') ??
        _readConfig('persona-loader', 'userSubdir');
    final value = raw?.trim();
    // 与内核 loader 同一口径：空值、穿越和路径分隔符都回默认值。
    if (value == null ||
        value.isEmpty ||
        value == '.' ||
        value == '..' ||
        value.contains('/') ||
        value.contains(r'\') ||
        value.contains('\x00')) {
      return 'personas';
    }
    return value;
  }

  /// 清空目标。`user/` 不整体移走：只移其中除人设子目录以外的顶层条目。
  List<String> _wipeTargets(String personaSubdir) {
    final targets = <String>[..._wipeTrees, ..._wipeFiles];
    final users = Directory('$home/user');
    if (FileSystemEntity.typeSync(users.path, followLinks: false) ==
        FileSystemEntityType.directory) {
      for (final entry in users.listSync(followLinks: false)) {
        final name = _leafName(entry.path);
        if (name == personaSubdir) continue;
        targets.add('user/$name');
      }
    }
    return targets;
  }

  static String _leafName(String path) {
    final normalized = path.replaceAll(r'\', '/');
    return normalized.substring(normalized.lastIndexOf('/') + 1);
  }

  /// 让用户挑一个导出目录。取消返回 null。
  ///
  /// 面板本身走 `DesktopPicker`，与「导入人设包」「添加反馈附件」共一份实现——
  /// 三处各写一遍 osascript，提示语的转义迟早会各不相同。
  Future<String?> pickDirectory(String prompt) =>
      DesktopPicker.pickDirectory(prompt);

  /// 导出全部用户数据到用户挑的目录，附一份 `ondra-export.json` 说明。
  ///
  /// 用 `ditto` 而不是自己递归拷贝：它会保留时间戳与权限，
  /// 而且对中文文件名与资源叉的处理是对的。`--norsrc` 避免生成 `._*`。
  ///
  /// 说明文件带 `manifest` 字段，迁移页据此认出这是可还原的整包而不是
  /// 只有人设的目录；用户不必自己选导入格式。
  Future<MaintenanceResult> exportAll(String targetDir) async {
    if (!_offline) {
      return const MaintenanceResult(
        ok: false,
        message: maintenanceOfflineHint,
      );
    }
    Directory? partial;
    try {
      final out = Directory('$targetDir/ondra-export');
      if (await out.exists()) {
        return const MaintenanceResult(
          ok: false,
          message: '这个目录里已经有 ondra-export 了，换一个位置或先挪走它。',
        );
      }
      final destination = Directory(targetDir);
      if (!destination.existsSync()) {
        return const MaintenanceResult(ok: false, message: '目标目录不存在。');
      }
      final data = Directory(home);
      final root = data.existsSync()
          ? data.resolveSymbolicLinksSync()
          : data.absolute.path;
      if ('${destination.resolveSymbolicLinksSync()}/'.startsWith('$root/')) {
        return const MaintenanceResult(ok: false, message: '不能导出到数据目录内部。');
      }
      for (final name in [..._exportTrees, ..._exportFiles]) {
        var source = home;
        for (final part in name.split('/')) {
          source = '$source/$part';
          if (FileSystemEntity.isLinkSync(source)) {
            throw FileSystemException('不导出符号链接', source);
          }
        }
        if (Directory(source).existsSync() &&
            Directory(source)
                .listSync(recursive: true, followLinks: false)
                .any((e) => e is Link)) {
          throw FileSystemException('目录含符号链接，未导出', source);
        }
      }
      await out.create(recursive: true);
      partial = out;

      var files = 0;
      var bytes = 0;
      for (final name in _exportTrees) {
        final src = Directory('$home/$name');
        if (!await src.exists()) continue;
        final dest = Directory('${out.path}/$name');
        // macOS 用 ditto（保留时间戳与权限、--norsrc 不生成 ._*)；
        // Windows 没有 ditto，走 Dart 递归拷贝（上方已拒绝符号链接，
        // 纯文件拷贝在这里是等价的）。
        if (Platform.isMacOS) {
          final r = await Process.run('ditto', [
            '--norsrc',
            '--noextattr',
            src.path,
            dest.path,
          ]);
          if (r.exitCode != 0) {
            return MaintenanceResult(
              ok: false,
              message: '复制 $name 失败：${(r.stderr as String).trim()}',
            );
          }
        } else {
          await _copyTree(src, dest);
        }
        for (final f in dest.listSync(recursive: true)) {
          if (f is File) {
            files += 1;
            bytes += f.lengthSync();
          }
        }
      }
      for (final name in _exportFiles) {
        final src = File('$home/$name');
        if (!await src.exists()) continue;
        final dest = File('${out.path}/$name');
        await dest.parent.create(recursive: true);
        await src.copy(dest.path);
        files += 1;
        bytes += await dest.length();
      }

      await File('${out.path}/ondra-export.json').writeAsString(
        const JsonEncoder.withIndent('  ').convert({
          'version': 1,
          'exportedAt': DateTime.now().toIso8601String(),
          'included': {'trees': _exportTrees, 'files': _exportFiles},
          'excluded': {
            'logs': '排障材料，不是用户数据',
            'cache': '可随时重建',
            'profiles': '插件装配层，属于安装而非数据',
          },
          // 导入页认的是 ondra-snapshot.json（备份引擎的整包格式）。
          // 这份目录虽然按用户数据原样导出，也要有一份能被导入页识别的
          // 清单，否则「导出全部数据」在新电脑上只恢复人设、丢掉记忆与
          // 会话（alpha.17 追加审查）。快照本体就是这份目录本身，
          // 清单只声明形状，导入端据此逐项还原。
          'manifest': 'ondra-snapshot.json',
          'note':
              '这是明文导出，可以直接读、直接改；它不含模型密钥'
              '（密钥在 profiles/.credentials.yaml 里，未随本包导出）。'
              '把整个 ondra-export 目录交给迁移页即可恢复。',
        }),
      );

      partial = null;
      return MaintenanceResult(
        ok: true,
        path: out.path,
        message: '已导出 $files 个文件（${_mb(bytes)}）到 ${out.path}。',
      );
    } catch (e) {
      return MaintenanceResult(ok: false, message: '导出失败：$e');
    } finally {
      if (partial != null && partial.existsSync()) {
        try {
          partial.deleteSync(recursive: true);
        } catch (_) {}
      }
    }
  }

  /// 递归拷贝目录（Windows 侧导出用）。符号链接已在导出入口统一拒绝，
  /// 这里只处理文件与目录两种实体；中途失败抛异常，由调用方清理 partial。
  Future<void> _copyTree(Directory src, Directory dest) async {
    await dest.create(recursive: true);
    await for (final entity in src.list(followLinks: false)) {
      final target =
          '${dest.path}/${entity.uri.pathSegments.where((s) => s.isNotEmpty).last}';
      if (entity is Directory) {
        await _copyTree(entity, Directory(target));
      } else if (entity is File) {
        await entity.copy(target);
      }
    }
  }

  /// 清空全部用户数据。**这一步不可逆**，调用方必须先让用户确认。
  ///
  /// 会先写一个「墓碑」文件 `~/.ondra/.wiped`，记下清空时刻与条数快照。
  /// 这不是为了恢复（清空就是清空），而是为了让界面在重启后能说清
  /// 「上一次清空是什么时候」，而不是让用户对着空页面猜自己是不是点错了。
  Future<MaintenanceResult> wipeAll() async {
    if (!_offline) {
      return const MaintenanceResult(
        ok: false,
        message: maintenanceOfflineHint,
      );
    }
    Directory? staged;
    final moved = <String>[];
    var committed = false;
    try {
      var removedFiles = 0;
      var removedBytes = 0;
      final personaSubdir = _personaSubdir;
      if (FileSystemEntity.isLinkSync(home) ||
          FileSystemEntity.isLinkSync('$home/.wiped') ||
          FileSystemEntity.isLinkSync('$home/user') ||
          FileSystemEntity.isLinkSync('$home/user/$personaSubdir')) {
        throw const FileSystemException('数据根或清空记录是符号链接，拒绝清空');
      }
      final targets = _wipeTargets(personaSubdir);
      // 列举和检查必须先于任何删除。拒绝符号链接，避免把保留目录或外部目录删掉。
      for (final name in targets) {
        var path = home;
        for (final component in name.split('/')) {
          path = '$path/$component';
          if (FileSystemEntity.isLinkSync(path)) {
            throw FileSystemException('拒绝清理符号链接', path);
          }
        }
        final type = FileSystemEntity.typeSync(path, followLinks: false);
        if (type == FileSystemEntityType.directory) {
          for (final file in Directory(
            path,
          ).listSync(recursive: true, followLinks: false).whereType<File>()) {
            removedFiles++;
            removedBytes += file.lengthSync();
          }
        } else if (type == FileSystemEntityType.file) {
          removedFiles++;
          removedBytes += File(path).lengthSync();
        }
      }
      Directory(home).createSync(recursive: true);
      staged = Directory(home).createTempSync('.wipe-');
      if (!_offline) {
        staged.deleteSync(recursive: true);
        return const MaintenanceResult(
          ok: false,
          message: maintenanceOfflineHint,
        );
      }
      // 先在同盘移走，移到一半失败可全部移回；墓碑写成功才提交删除。
      for (final name in targets) {
        final source = '$home/$name';
        final type = FileSystemEntity.typeSync(source, followLinks: false);
        if (type == FileSystemEntityType.notFound) continue;
        final target = '${staged.path}/$name';
        File(target).parent.createSync(recursive: true);
        if (type == FileSystemEntityType.directory) {
          Directory(source).renameSync(target);
        } else {
          File(source).renameSync(target);
        }
        moved.add(name);
      }
      File('$home/.wiped').writeAsStringSync(
        '${DateTime.now().toIso8601String()}  files=$removedFiles  bytes=$removedBytes\n',
        flush: true,
      );
      committed = true;
      staged.deleteSync(recursive: true);
      return MaintenanceResult(
        ok: true,
        message: '已删除 $removedFiles 个文件（${_mb(removedBytes)}）。重启应用后记忆与会话从空白开始。',
      );
    } catch (e) {
      if (committed) {
        return MaintenanceResult(
          ok: false,
          message: '活动数据已清空，但隔离副本删除失败：${staged?.path}；$e',
        );
      }
      try {
        for (final name in moved.reversed) {
          final source = '${staged!.path}/$name';
          if (FileSystemEntity.isDirectorySync(source)) {
            Directory(source).renameSync('$home/$name');
          } else {
            File(source).renameSync('$home/$name');
          }
        }
        staged?.deleteSync(recursive: true);
      } catch (rollback) {
        return MaintenanceResult(
          ok: false,
          message: '清空失败且回滚未完成；旧数据保留于 ${staged?.path}：$e；$rollback',
        );
      }
      return MaintenanceResult(ok: false, message: '清空失败，未删除数据：$e');
    }
  }

  /// 上一次清空的时刻。没清过返回 null。
  DateTime? lastWipe() {
    try {
      final f = File('$home/.wiped');
      if (!f.existsSync()) return null;
      final line = f.readAsLinesSync().firstOrNull;
      if (line == null || line.length < 19) return null;
      return DateTime.tryParse(line.substring(0, 19));
    } catch (_) {
      return null;
    }
  }

  /// 清缓存：只删 `cache/` 与 `tmp/` 的内容，目录本身留着
  /// （有些路径在运行时被 mmap 住，删目录会让正在跑的进程拿不到 fd）。
  Future<MaintenanceResult> clearCache() async {
    if (!_offline) {
      return const MaintenanceResult(
        ok: false,
        message: maintenanceOfflineHint,
      );
    }
    try {
      var files = 0;
      var bytes = 0;
      for (final name in _cacheTrees) {
        if (FileSystemEntity.isLinkSync(home) ||
            FileSystemEntity.isLinkSync('$home/$name')) {
          throw FileSystemException('拒绝清理符号链接缓存目录', '$home/$name');
        }
      }
      for (final name in _cacheTrees) {
        final dir = Directory('$home/$name');
        if (!await dir.exists()) continue;
        for (final e in dir.listSync(followLinks: false)) {
          if (e is File) {
            bytes += e.lengthSync();
            await e.delete();
            files += 1;
          } else if (e is Directory) {
            for (final f in e.listSync(recursive: true, followLinks: false)) {
              if (f is File) bytes += f.lengthSync();
            }
            await e.delete(recursive: true);
            files += 1;
          } else if (e is Link) {
            await e.delete();
            files += 1;
          }
        }
      }
      if (files == 0) {
        return const MaintenanceResult(ok: true, message: '缓存已经是空的。');
      }
      return MaintenanceResult(
        ok: true,
        message: '已清掉 $files 项（${_mb(bytes)}）；对话与记忆未受影响。',
      );
    } catch (e) {
      return MaintenanceResult(ok: false, message: '清理失败：$e');
    }
  }

  /// 系统权限现状。桌面端能查的是「这个应用实际拿到了什么」，
  /// 查不到的一律标成「未知」而不是猜一个「已授权」。
  Future<List<PermissionStatus>> permissions() async {
    final out = <PermissionStatus>[];
    // 完全磁盘访问 / 屏幕录制这类 TCC 权限没有公开的查询 API：
    // 只能「尝试做一次」再说。这里查得到的两项是真查，查不到的如实标注。
    out.add(
      PermissionStatus(
        name: '文件读写（用户数据目录）',
        granted: _writable(Directory(home)),
        detail: home,
      ),
    );
    out.add(
      PermissionStatus(
        name: '启动本机内核（子进程）',
        // 能力来自宿主抽象；实际能否启动仍用一次真实子进程探针确认。
        granted: ondraCapabilities.localSubprocess ? await _canSpawn() : null,
        detail: '需要执行 dsh 与 node',
      ),
    );
    out.add(
      const PermissionStatus(
        name: '屏幕录制',
        granted: null,
        detail: '系统不提供查询接口；首次用到时会弹窗询问',
      ),
    );
    out.add(
      PermissionStatus(
        name: '通知',
        granted: null,
        detail: defaultTargetPlatform == TargetPlatform.macOS
            ? '由 macOS 通知中心管理，可在系统设置里单独关闭'
            : '由系统通知设置管理，可在系统设置里单独关闭',
      ),
    );
    return out;
  }

  bool _writable(Directory dir) {
    try {
      if (!dir.existsSync()) dir.createSync(recursive: true);
      final probe = File('${dir.path}/.write-probe');
      probe.writeAsStringSync('ok');
      probe.deleteSync();
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<bool> _canSpawn() async {
    final probes = <(String, List<String>)>[
      if (File('/bin/echo').existsSync()) ('/bin/echo', <String>['ok']),
      if (File('/system/bin/sh').existsSync())
        ('/system/bin/sh', <String>['-c', 'exit 0']),
      if (File(r'C:\Windows\System32\cmd.exe').existsSync())
        (r'C:\Windows\System32\cmd.exe', <String>['/c', 'exit 0']),
    ];
    for (final (exe, args) in probes) {
      try {
        final result = await Process.run(exe, args);
        if (result.exitCode == 0) return true;
      } catch (_) {
        // Try the next host-specific probe.
      }
    }
    return false;
  }

  static String _mb(int bytes) => bytes < 1024 * 1024
      ? '${(bytes / 1024).toStringAsFixed(0)} KB'
      : '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
}

const maintenanceOfflineHint =
    '无法确认内核已完全停止，未操作活动数据。请退出内核后使用离线数据目录；当前 stop 接口不等待进程退出。';

/// 当前应用的数据根可能正在启动、重连或关闭，connected=false 并不是离线证明。
/// 在尚无等待式停机/独占租约的接口前，拒绝操作当前根；离线工具可注入已验证的状态。
/// 显式传入的其他目录用于离线迁移与隔离测试，不会调用 chatClient.stop()。
bool maintenanceDataIsOffline(String root) {
  // 不读取默认 HOME：测试和离线工具不得因为安全检查反而触碰真实数据。
  String canonical(String path) =>
      Directory(path).absolute.uri.normalizePath().path;
  return canonical(root) != canonical('$ondraUserHome/.ondra') &&
      !FileSystemEntity.isLinkSync(root);
}

class MaintenanceResult {
  const MaintenanceResult({required this.ok, required this.message, this.path});

  final bool ok;
  final String message;
  final String? path;
}

class PermissionStatus {
  const PermissionStatus({
    required this.name,
    required this.granted,
    required this.detail,
  });

  final String name;

  /// true / false / null（null = 系统不提供查询，如实标注）。
  final bool? granted;
  final String detail;
}
