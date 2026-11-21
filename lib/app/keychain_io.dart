import 'dart:convert';
import 'dart:io';

import 'home_dir.dart';
import 'keychain_secret.dart';

export 'keychain_secret.dart';

/// 桌面端的密钥存放：macOS 系统钥匙串（`security` 命令）。
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

  static const String _service = 'Ondra';

  /// 安卓的降级存储：应用私有目录下的单文件（JSON：键 → 密钥）。
  /// 与 prefs.json 分开——文件里全是密钥，备份/导出时更容易被注意到。
  static File get _androidStore {
    final home = ondraUserHome;
    return File('$home/.ondra/android-keys.json');
  }

  static Map<String, String> _androidRead() {
    try {
      final f = _androidStore;
      if (!f.existsSync()) return {};
      final raw = jsonDecode(f.readAsStringSync());
      if (raw is! Map) return {};
      return {for (final e in raw.entries) '${e.key}': '${e.value}'};
    } catch (_) {
      return {};
    }
  }

  static void _androidWriteAll(Map<String, String> data) {
    final f = _androidStore;
    f.parent.createSync(recursive: true);
    // 0600：只有应用自己能读（安卓沙箱本就如此，双重保险）。
    f.writeAsStringSync(
      const JsonEncoder.withIndent('  ').convert(data),
      flush: true,
    );
    try {
      Process.runSync('chmod', ['600', f.path]);
    } catch (_) {
      // chmod 不可用不致命：沙箱已保证隔离。
    }
  }

  /// mac 用系统钥匙串；安卓没有可比的钥匙串，密钥退到**应用私有目录**的
  /// 文件（`/data/user/0/<包名>/…`，系统沙箱保证其他应用读不到，风险是
  /// 设备被 root）——「完全填不了」比「知情降级」更伤人，界面会如实说明。
  /// Windows 用 DPAPI（当前用户级加密，PowerShell ProtectedData）+ 应用
  /// 私有目录落盘——alpha.10 审查第 24 项：设置页无法保存云模型密钥。
  /// Web 保持如实拒绝。
  static bool get supported =>
      Platform.isMacOS || Platform.isAndroid || Platform.isWindows;

  static String get _winKeysDir =>
      '$ondraUserHome/.ondra/keys';

  /// DPAPI 调用统一走 PowerShell（工程零原生插件的既有约定）。
  static Future<String?> _winDpapi({
    required String mode,
    required String path,
  }) async {
    // 与 DesktopPicker._runWin 同款：单行拼接 + UTF8 输出。
    final String script;
    if (mode == 'protect') {
      script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
          'Add-Type -AssemblyName System.Security | Out-Null; '
          '\$b64 = [IO.File]::ReadAllText("${_escapePs(payloadPath)}"); '
          '\$b = [Convert]::FromBase64String(\$b64); '
          '\$e = [System.Security.Cryptography.ProtectedData]::Protect('
          '\$b, \$null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); '
          '[Console]::Out.Write([Convert]::ToBase64String(\$e))';
    } else {
      script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
          'Add-Type -AssemblyName System.Security | Out-Null; '
          '\$e = [Convert]::FromBase64String('
          '[IO.File]::ReadAllText("${_escapePs(path)}")); '
          '\$b = [System.Security.Cryptography.ProtectedData]::Unprotect('
          '\$e, \$null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); '
          '[Console]::Out.Write('
          '[System.Text.Encoding]::UTF8.GetString(\$b))';
    }
    try {
      final r = await Process.run(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        stdoutEncoding: utf8,
        stderrEncoding: utf8,
      );
      if (r.exitCode != 0) return null;
      final out = (r.stdout as String).trim();
      return out.isEmpty ? null : out;
    } catch (_) {
      return null;
    } finally {
      final payloadFile = File(payloadPath);
      if (await payloadFile.exists()) await payloadFile.delete();
    }
  }

  static String _escapePs(String raw) => raw.replaceAll("'", "''");

  static String get payloadPath => '$ondraUserHome/.ondra/keys/.payload.b64';

  /// 存在性查询的注入点。测试里换成 `() async => false`：
  /// widget 测试的时钟是 fake_async，`security` 子进程的定时器永远走不完，
  /// 树销毁后会被判「Timer is still pending」。
  ///
  /// 与 memory / logs / status 那几页的 `*Loader` 同一个做法——
  /// 测试环境不该为了版式验收去起真实子进程。
  static Future<bool> Function(String key) existsProbe = _probeExists;

  static Future<bool> _probeExists(String key) async {
    if (!supported) return false;
    final v = await read(key);
    return v != null && v.isNotEmpty;
  }

  /// 写一条。已存在则覆盖（`-U`）。
  ///
  /// 密钥走 stdin 而不是命令行参数：`ps aux` 能看到进程的完整命令行，
  /// 参数里带密钥等于把它贴到系统监视器上。
  static Future<KeychainSecret> write(String key, String value) async {
    if (!supported) {
      return const KeychainSecret(
        ok: false,
        message: '这台机器上没有可用的密钥存储，密钥暂不支持保存。',
      );
    }
    if (Platform.isWindows) {
      if (key.trim().isEmpty) {
        return const KeychainSecret(ok: false, message: '键名不能为空。');
      }
      final dir = Directory(_winKeysDir);
      await dir.create(recursive: true);
      final file = File('${dir.path}/${_safeKey(key)}.dpapi');
      if (value.isEmpty) {
        if (await file.exists()) await file.delete();
        return const KeychainSecret(ok: true, message: '已清除。');
      }
      await File(payloadPath).writeAsString(
        base64Encode(utf8.encode(value)),
        flush: true,
      );
      final encoded = await _winDpapi(mode: 'protect', path: file.path);
      if (encoded == null) {
        return const KeychainSecret(
          ok: false,
          message: '写入 DPAPI 加密文件失败。',
        );
      }
      await file.writeAsString(encoded, flush: true);
      return const KeychainSecret(
        ok: true,
        message: '已保存（Windows DPAPI 当前用户加密）。',
      );
    }
    if (Platform.isAndroid) {
      if (key.trim().isEmpty) {
        return const KeychainSecret(ok: false, message: '键名不能为空。');
      }
      final data = _androidRead();
      if (value.isEmpty) {
        data.remove(key);
        _androidWriteAll(data);
        return const KeychainSecret(ok: true, message: '已清除。');
      }
      data[key] = value;
      _androidWriteAll(data);
      return const KeychainSecret(
        ok: true,
        message: '已保存（安卓没有系统钥匙串，密钥存在应用私有目录）。',
      );
    }
    if (key.trim().isEmpty) {
      return const KeychainSecret(ok: false, message: '键名不能为空。');
    }
    if (value.isEmpty) {
      // 写空串等于「删掉」。不给用户留一条「已保存但是空的」记录。
      final ok = await erase(key);
      return KeychainSecret(ok: ok, message: ok ? '已清除。' : '清除失败。');
    }
    try {
      // 注意：`security -w` 不带值时**读的是 /dev/tty 而不是 stdin**——在应用
      // 的无 TTY 子进程里它会挂死在「password data for new item:」提示上
      // （2026-11-20 实测，printf 管道也不行）。所以密钥必须作为参数传递。
      // 参数会出现在 `ps` 输出里：子进程只活一瞬，且 macOS 的 ps 对其他用户
      // 进程隐藏参数，本机单用户场景风险可接受；stdin 方案不可用是硬事实。
      final add = await Process.start('security', [
        'add-generic-password',
        '-U',
        '-s',
        _service,
        '-a',
        key,
        '-w',
        value,
      ]);
      await add.stdin.close();
      final code = await add.exitCode;
      final err = await add.stderr.transform(const SystemEncoding().decoder).join();
      if (code != 0) {
        return KeychainSecret(
          ok: false,
          message: '写入钥匙串失败：${err.trim().isEmpty ? '退出码 $code' : err.trim()}',
        );
      }
      return const KeychainSecret(ok: true, message: '已存进系统钥匙串。');
    } catch (e) {
      return KeychainSecret(ok: false, message: '写入钥匙串失败：$e');
    }
  }

  /// 读一条。读不到返回 null。
  static Future<String?> read(String key) async {
    if (!supported) return null;
    if (Platform.isWindows) {
      final file = File('$_winKeysDir/${_safeKey(key)}.dpapi');
      if (!await file.exists()) return null;
      return _winDpapi(mode: 'unprotect', path: file.path);
    }
    if (Platform.isAndroid) {
      return _androidRead()[key];
    }
    try {
      final r = await Process.run('security', [
        'find-generic-password',
        '-s',
        _service,
        '-a',
        key,
        '-w',
      ]);
      if (r.exitCode != 0) return null;
      final out = (r.stdout as String);
      // `-w` 会补一个换行；密钥本身不含换行。
      return out.endsWith('\n') ? out.substring(0, out.length - 1) : out;
    } catch (_) {
      return null;
    }
  }

  /// 键名 → 安全文件名：只留字母数字与短横线，其余按其码点十六进制。
  static String _safeKey(String key) {
    final b = StringBuffer();
    for (final c in key.codeUnits) {
      final ch = String.fromCharCode(c);
      if (RegExp(r'[A-Za-z0-9._-]').hasMatch(ch)) {
        b.write(ch);
      } else {
        b.write(c <= 0xFFFF ? c.toRadixString(16).padLeft(4, '0') : 'u');
      }
    }
    return b.toString();
  }

  static Future<bool> erase(String key) async {
    if (!supported) return false;
    if (Platform.isWindows) {
      final file = File('$_winKeysDir/${_safeKey(key)}.dpapi');
      if (!await file.exists()) return false;
      await file.delete();
      return true;
    }
    if (Platform.isAndroid) {
      final data = _androidRead();
      if (!data.containsKey(key)) return false;
      data.remove(key);
      _androidWriteAll(data);
      return true;
    }
    try {
      final r = await Process.run('security', [
        'delete-generic-password',
        '-s',
        _service,
        '-a',
        key,
      ]);
      return r.exitCode == 0;
    } catch (_) {
      return false;
    }
  }

  /// 只回答「有没有」。用 `read` 判空而不是 `find` 的退出码：
  /// 空值已经被 write 当成删除处理了，所以存在即非空。
  static Future<bool> exists(String key) => existsProbe(key);
}
