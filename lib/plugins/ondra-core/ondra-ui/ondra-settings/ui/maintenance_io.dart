import 'dart:convert';
import 'dart:io';

import '../../../../../app/desktop_picker.dart';

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
  OndraMaintenance({String? home}) : home = home ?? _defaultHome();

  final String home;

  static String _defaultHome() =>
      '${Platform.environment['HOME'] ?? '.'}/.ondra';

  /// 导出范围：**用户数据**，不含缓存与日志。
  ///
  /// `cache/`、`tmp/`、`logs/` 不导出：前两个是可重建的临时物，日志是排障材料
  /// 而不是用户资产，一起打包只会让「我的数据」这件事变模糊。
  static const List<String> _exportTrees = ['user', 'sessions', 'storages'];

  static const List<String> _exportFiles = ['prefs.json', 'avatar.png'];

  /// 清空范围。比导出范围大：用户说「清空全部数据」就是要它真的空，
  /// 留着 sessions 或 storages 会让「清空」这个词变成假的。
  ///
  /// **不删 `profiles/`**：那是插件装配层，删了应用起不来，它也不是用户数据。
  /// **不删 `personas/`**：用户装的人设包算用户资产，但它属于「设置」不属于
  /// 「记忆与会话」；设置页的清空动作在文案里写的是「删掉记忆与会话」。
  static const List<String> _wipeTrees = ['user', 'sessions', 'storages'];

  static const List<String> _wipeFiles = ['prefs.json'];

  /// 缓存范围。只碰这两个目录，别的都不动。
  static const List<String> _cacheTrees = ['cache', 'tmp'];

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
  Future<MaintenanceResult> exportAll(String targetDir) async {
    try {
      final out = Directory('$targetDir/ondra-export');
      if (await out.exists()) {
        return const MaintenanceResult(
          ok: false,
          message: '这个目录里已经有 ondra-export 了，换一个位置或先挪走它。',
        );
      }
      await out.create(recursive: true);

      var files = 0;
      var bytes = 0;
      for (final name in _exportTrees) {
        final src = Directory('$home/$name');
        if (!await src.exists()) continue;
        final dest = Directory('${out.path}/$name');
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
          'included': {
            'trees': _exportTrees,
            'files': _exportFiles,
          },
          'excluded': {
            'logs': '排障材料，不是用户数据',
            'cache': '可随时重建',
            'profiles': '插件装配层，属于安装而非数据',
          },
          'note': '这是明文导出，可以直接读、直接改；它不含模型密钥'
              '（密钥在 profiles/.credentials.yaml 里，未随本包导出）。',
        }),
      );

      return MaintenanceResult(
        ok: true,
        path: out.path,
        message: '已导出 $files 个文件（${_mb(bytes)}）到 ${out.path}。',
      );
    } catch (e) {
      return MaintenanceResult(ok: false, message: '导出失败：$e');
    }
  }

  /// 清空全部用户数据。**这一步不可逆**，调用方必须先让用户确认。
  ///
  /// 会先写一个「墓碑」文件 `~/.ondra/.wiped`，记下清空时刻与条数快照。
  /// 这不是为了恢复（清空就是清空），而是为了让界面在重启后能说清
  /// 「上一次清空是什么时候」，而不是让用户对着空页面猜自己是不是点错了。
  Future<MaintenanceResult> wipeAll() async {
    try {
      var removedFiles = 0;
      var removedBytes = 0;
      for (final name in _wipeTrees) {
        final dir = Directory('$home/$name');
        if (!await dir.exists()) continue;
        for (final f in dir.listSync(recursive: true)) {
          if (f is File) {
            removedFiles += 1;
            try {
              removedBytes += f.lengthSync();
            } catch (_) {}
          }
        }
        await dir.delete(recursive: true);
      }
      for (final name in _wipeFiles) {
        final f = File('$home/$name');
        if (await f.exists()) {
          removedFiles += 1;
          await f.delete();
        }
      }
      await File('$home/.wiped').writeAsString(
        '${DateTime.now().toIso8601String()}  '
        'files=$removedFiles  bytes=$removedBytes\n',
      );
      return MaintenanceResult(
        ok: true,
        message: '已删除 $removedFiles 个文件（${_mb(removedBytes)}）。'
            '重启应用后记忆与会话从空白开始。',
      );
    } catch (e) {
      return MaintenanceResult(ok: false, message: '清空失败：$e');
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
    try {
      var files = 0;
      var bytes = 0;
      for (final name in _cacheTrees) {
        final dir = Directory('$home/$name');
        if (!await dir.exists()) continue;
        for (final e in dir.listSync()) {
          if (e is File) {
            bytes += e.lengthSync();
            await e.delete();
            files += 1;
          } else if (e is Directory) {
            for (final f in e.listSync(recursive: true)) {
              if (f is File) bytes += f.lengthSync();
            }
            await e.delete(recursive: true);
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
        granted: await _canSpawn(),
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
      const PermissionStatus(
        name: '通知',
        granted: null,
        detail: '由 macOS 通知中心管理，可在系统设置里单独关闭',
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
    try {
      final r = await Process.run('/bin/echo', ['ok']);
      return r.exitCode == 0;
    } catch (_) {
      return false;
    }
  }

  static String _mb(int bytes) => bytes < 1024 * 1024
      ? '${(bytes / 1024).toStringAsFixed(0)} KB'
      : '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';
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
