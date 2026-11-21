import 'dart:io';

import 'package:flutter/foundation.dart' show kIsWeb;

import 'home_dir.dart';
import 'keychain_secret.dart';

export 'keychain_secret.dart';

/// 密钥存放：`$DSH_HOME/.credentials.yaml`（version:1/refs，0600）——
/// **与 DeepSeek Harness 官方内核同款**（dsh-credentials-local）。
/// 挂上内核的 ondra-credentials 插件后，内核的 credentials.resolve
/// 直接读本文件；桌面壳只做同一文件的读写，不再各自造存储
/// （macOS 钥匙串 / Windows DPAPI / 安卓私有目录三套自研退役，
/// 单一真源：内核与壳看同一个文件）。
///
/// 迁移：旧存储（macOS 钥匙串）的值在首次读取时搬进文件；旧记录
/// 保留在原处不动，用户可随时手动清除。
///
/// ## Linux / Windows
///
/// 文件 0600 = 当前用户私有，与官方桌面壳一致。
///
/// ## 为什么是钥匙串而不是 `prefs.json`
///
/// `prefs.json` 是明文的，任何人 `cat` 一下就能看到。QQ 机器人密钥、模型 API Key
/// 这类东西写进那里，等于把「只存在本机」这句话说成了「只以明文存在本机」。
///
/// macOS 自带 `security` 命令可以读写钥匙串项，不需要引第三方包，
/// 也不需要在工程里加原生通道。钥匙串项归属是 `Ondra` 这个 service，
/// 用户在「钥匙串访问」里能看见、能删。
///
/// ## Linux / Windows
///
/// 这两个平台上没有 `security`。此实现会如实返回失败，而不是退化成
/// 明文写文件——**降级到明文比报错更危险**，因为用户以为它被加密了。
/// 那两端要接各自的凭据库（Windows Credential Manager / libsecret），
/// 属于下一轮的事，当前如实说「这台机器上还存不了」。
class Keychain {
  const Keychain._();






  /// mac 用系统钥匙串；安卓没有可比的钥匙串，密钥退到**应用私有目录**的
  /// 文件（`/data/user/0/<包名>/…`，系统沙箱保证其他应用读不到，风险是
  /// 设备被 root）——「完全填不了」比「知情降级」更伤人，界面会如实说明。
  /// Windows 用 DPAPI（当前用户级加密，PowerShell ProtectedData）+ 应用
  /// 私有目录落盘——alpha.10 审查第 24 项：设置页无法保存云模型密钥。
  /// Web 保持如实拒绝。
  static bool get supported => !kIsWeb && (Platform.isMacOS || Platform.isAndroid || Platform.isWindows || Platform.isLinux);



  /// 读一条。读不到返回 null。
  static Future<String?> read(String key) async {
    if (!supported) return null;
    // 全平台统一读 .credentials.yaml；mac 旧钥匙串的值首次读取时迁移。
    final refs = _readRefs();
    final hit = refs[key];
    if (hit != null && hit.isNotEmpty) return hit;
    final legacy = _migrateLegacy(key);
    if (legacy != null && legacy.isNotEmpty) {
      refs[key] = legacy;
      _writeRefs(refs);
      return legacy;
    }
    return null;
  }

  // ── .credentials.yaml（官方 dsh-credentials-local 同款）──────────────

  /// 内核 DSH_HOME 与桌面壳共用一个目录（transport 的 _dshHome 同源）。
  static String get _dshHome =>
      Platform.environment['ONDRA_DSH_HOME'] ??
      '$ondraUserHome/.ondra/dsh';

  static File get _credentialsFile =>
      File('$_dshHome/.credentials.yaml');

  /// 读全部 refs。空文件/不存在 → 空表。
  static Map<String, String> _readRefs() {
    final f = _credentialsFile;
    if (!f.existsSync()) return {};
    final refs = <String, String>{};
    var inRefs = false;
    for (final line in f.readAsLinesSync()) {
      if (line.trim().isEmpty) continue;
      if (line.trim() == 'refs:') {
        inRefs = true;
        continue;
      }
      if (!inRefs) continue;
      // refs 下的二级缩进条目：  KEY: value
      final m = RegExp(r'^  ([^:]+): ?(.*)$').firstMatch(line);
      if (m == null) {
        // 退出 refs 段（回到一级键）
        if (!line.startsWith('  ')) inRefs = false;
        continue;
      }
      refs[m.group(1)!.trim()] = m.group(2)!.trim();
    }
    return refs;
  }

  /// 写全部 refs（0600；YAML 值含特殊字符时加引号）。
  static void _writeRefs(Map<String, String> refs) {
    final f = _credentialsFile;
    f.parent.createSync(recursive: true);
    String quote(String v) =>
        RegExp(r'^[A-Za-z0-9._/@+-]+$').hasMatch(v) ? v : "'${v.replaceAll("'", "''")}'";
    final b = StringBuffer('version: 1\nrefs:\n');
    if (refs.isEmpty) {
      b.write('  {}\n');
    } else {
      for (final e in refs.entries) {
        b.write('  ${e.key}: ${quote(e.value)}\n');
      }
    }
    f.writeAsStringSync(b.toString(), flush: true);
    try {
      Process.runSync('chmod', ['600', f.path]);
    } catch (_) {
      // Windows 无 chmod：NTFS ACL 默认用户私有，可接受。
    }
  }

  /// 旧存储（macOS 钥匙串）的一次性迁移：有值就搬进文件。旧记录保留。
  static String? _migrateLegacy(String key) {
    if (!Platform.isMacOS) return null;
    try {
      final r = Process.runSync('security', [
        'find-generic-password', '-s', 'Ondra', '-a', key, '-w',
      ]);
      if (r.exitCode != 0) return null;
      final out = (r.stdout as String);
      return out.endsWith('\n') ? out.substring(0, out.length - 1) : out;
    } catch (_) {
      return null;
    }
  }


  static Future<bool> erase(String key) async {
    if (!supported) return false;
    final refs = _readRefs();
    if (!refs.containsKey(key)) return false;
    refs.remove(key);
    _writeRefs(refs);
    return true;
  }

  /// 写一条（模型密钥保存的正式入口）。空值等于删除。
  static Future<KeychainSecret> write(String key, String value) async {
    if (!supported) {
      return const KeychainSecret(
        ok: false,
        message: '这台机器上没有可用的密钥存储，密钥暂不支持保存。',
      );
    }
    if (key.trim().isEmpty) {
      return const KeychainSecret(ok: false, message: '键名不能为空。');
    }
    final refs = _readRefs();
    if (value.isEmpty) {
      refs.remove(key);
      _writeRefs(refs);
      return const KeychainSecret(ok: true, message: '已清除。');
    }
    refs[key] = value;
    _writeRefs(refs);
    return const KeychainSecret(
      ok: true,
      message: '已保存（DSH_HOME/.credentials.yaml，当前用户私有）。',
    );
  }

  /// 存在性查询的注入点（测试用）。
  static Future<bool> Function(String key) existsProbe = _probeExists;

  static Future<bool> _probeExists(String key) async {
    final v = await read(key);
    return v != null && v.isNotEmpty;
  }

  /// 只回答「有没有」。用 `read` 判空而不是 `find` 的退出码：
  /// 空值已经被 write 当成删除处理了，所以存在即非空。
  static Future<bool> exists(String key) => existsProbe(key);
}
