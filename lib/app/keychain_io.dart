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
  static bool get supported =>
      !kIsWeb &&
      (Platform.isMacOS ||
          Platform.isAndroid ||
          Platform.isWindows ||
          Platform.isLinux);

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
      debugDshHomeOverride ??
      Platform.environment['ONDRA_DSH_HOME'] ??
      '$ondraUserHome/.ondra/dsh';

  /// 测试用的目录重定向。
  ///
  /// `Platform.environment` 是进程级且只读的，测试里改不了；没有这个口子，
  /// 「写 refs 会不会抹掉 records」这件事就只能靠手工跑一次验证——而它
  /// 会在用户真实的凭据文件上悄悄发生。
  static String? debugDshHomeOverride;

  /// 迁移路径的测试注入点，与 `keychain_stub.dart` 同形。
  ///
  /// 生产永远走真实旧钥匙串；测试里替换它才能验证「读一次旧密钥、写新
  /// 引用、删旧键」这一整条升级路径，而不会碰用户钥匙串。
  static Future<String?> Function(String key)? readLegacyProbe;

  /// 删除路径的测试注入点，与 `keychain_stub.dart` 同形。
  static Future<bool> Function(String key)? eraseProbe;

  static File get _credentialsFile => File('$_dshHome/.credentials.yaml');

  /// 读全部 refs。空文件/不存在 → 空表。
  static Map<String, String> _readRefs() => _parse(_credentialsText()).refs;

  /// 读文件原文；不存在返回空串。
  ///
  /// 必须整份读进来再写回：同一个文件里还有内核写的 `records:` 段
  /// （`client-connection/browser-session` 这类授权记录）。以前只按行扫出
  /// `refs:` 再整份重写，等于把 `records:` 连同内核的会话授权一起抹掉——
  /// 用户保存一次模型密钥，浏览器端的登录态就没了，而且两边都不报错。
  static String _credentialsText() {
    final f = _credentialsFile;
    if (!f.existsSync()) return '';
    try {
      return f.readAsStringSync();
    } catch (_) {
      return '';
    }
  }

  /// 从整份文档里只摘出 `refs:` 段。
  ///
  /// 缩进固定两格：与官方 `dsh-credentials-local` 写出的布局一致（它用
  /// YAML 序列化，顶层键零缩进、二级键两格）。
  static ({Map<String, String> refs}) _parse(String text) {
    final refs = <String, String>{};
    var inRefs = false;
    for (final line in text.split('\n')) {
      if (line.trim().isEmpty) continue;
      if (line == 'refs:') {
        inRefs = true;
        continue;
      }
      if (!inRefs) continue;
      final m = RegExp(r'^  (\S+): ?(.*)$').firstMatch(line);
      if (m == null) {
        // 退出 refs 段（回到零缩进的顶层键，或遇到 `records:`）。
        if (!line.startsWith('  ')) inRefs = false;
        continue;
      }
      final value = _unquote(m.group(2)!.trim());
      if (value.isNotEmpty) refs[m.group(1)!.trim()] = value;
    }
    return (refs: refs);
  }

  /// 去掉写入时加的引号，让读回来的值与写进去的值逐字节相等。
  static String _unquote(String raw) {
    if (raw.length < 2) return raw;
    if (raw.startsWith("'") && raw.endsWith("'")) {
      return raw.substring(1, raw.length - 1).replaceAll("''", "'");
    }
    if (raw.startsWith('"') && raw.endsWith('"')) {
      // 写侧只在含特殊字符时用单引号，双引号只会来自内核/手工编辑。
      return raw.substring(1, raw.length - 1);
    }
    return raw;
  }

  /// 写 refs 段，**保留文档里其它段与注释**。
  ///
  /// 只替换 `refs:` 那一块（到下一个顶层键为止），`records:` 与文件里
  /// 任何别的内容原样留在原位。这是与官方 provider 共用一个文件的前提：
  /// 它随时可能写 `records:`，我们不能每次保存密钥都把它清空。
  static void _writeRefs(Map<String, String> refs) {
    final f = _credentialsFile;
    f.parent.createSync(recursive: true);
    String quote(String v) => RegExp(r'^[A-Za-z0-9._/@+-]+$').hasMatch(v)
        ? v
        : "'${v.replaceAll("'", "''")}'";

    final block = StringBuffer('refs:\n');
    if (refs.isEmpty) {
      block.write('  {}\n');
    } else {
      for (final e in refs.entries) {
        block.write('  ${e.key}: ${quote(e.value)}\n');
      }
    }

    final before = _credentialsText();
    // 空文件/只有空白：写成一份最小合法文档。
    if (before.trim().isEmpty) {
      f.writeAsStringSync('version: 1\n$block', flush: true);
    } else {
      final lines = before.split('\n');
      var start = -1;
      var end = lines.length;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i] == 'refs:') {
          start = i;
          break;
        }
      }
      if (start < 0) {
        // 没有 refs 段：插到 version 之后（官方布局里 version 在最前）。
        var at = 0;
        for (var i = 0; i < lines.length; i++) {
          if (lines[i].trim() == 'version: 1') {
            at = i + 1;
            break;
          }
        }
        lines.insertAll(at, block.toString().trimRight().split('\n'));
        f.writeAsStringSync(lines.join('\n'), flush: true);
      } else {
        // 找 refs 段的结束：下一个零缩进的非空行。
        for (var i = start + 1; i < lines.length; i++) {
          if (lines[i].trim().isEmpty) continue;
          if (!lines[i].startsWith('  ')) {
            end = i;
            break;
          }
        }
        final next = [
          ...lines.sublist(0, start),
          ...block.toString().trimRight().split('\n'),
          ...lines.sublist(end),
        ];
        f.writeAsStringSync(next.join('\n'), flush: true);
      }
    }
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
        'find-generic-password',
        '-s',
        'Ondra',
        '-a',
        key,
        '-w',
      ]);
      if (r.exitCode != 0) return null;
      final out = (r.stdout as String);
      return out.endsWith('\n') ? out.substring(0, out.length - 1) : out;
    } catch (_) {
      return null;
    }
  }

  /// 读旧存储（macOS 钥匙串）里某一条，供 ModelClient 做一次性迁移。
  ///
  /// 这里刻意返回「文件里没有、但旧钥匙串里有」的值：普通 [read] 会把迁移
  /// 结果写回文件，而迁移流程要自己决定何时写、何时删旧记录。其它平台没有
  /// 旧存储，返回 null。
  static Future<String?> readLegacy(String key) async {
    final probe = readLegacyProbe;
    if (probe != null) return probe(key);
    if (!supported || !Platform.isMacOS) return null;
    final hit = _migrateLegacy(key);
    return hit == null || hit.isEmpty ? null : hit;
  }

  static Future<bool> erase(String key) async {
    final probe = eraseProbe;
    if (probe != null) return probe(key);
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
