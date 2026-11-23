import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:io';

/// 登录 shell 环境继承（照抄官方 login-shell-environment 协议）。
///
/// ## 为什么需要它
///
/// 从 Dock/Finder 启动的进程只继承会话管理器的环境——用户在 `.zshrc`
/// 里 export 的 PATH、代理、模型变量全都看不到。内核子进程拿不到这些
/// 变量，「下载了模型但探测不到」「代理没生效」都源于此。
///
/// ## 官方协议（DeepSeek Harness main.js 9259-9443）
///
/// 1. 候选 shell：`$SHELL`（官方用账户记录的登录 shell，Dart 只有 $SHELL
///    可读），然后固定列表；去重保序。
/// 2. DUMP 命令：`printf '\0<分隔符>\0' '<分隔符>'; command env -0; …`，
///    用 NUL 分隔符把 rc 文件的输出与真正的环境隔开。
/// 3. 探测环境：DISABLE_AUTO_UPDATE / ZSH_TMUX_AUTOSTARTED——防止
///    oh-my-zsh 的更新提示与 tmux 自动启动把非终端读取挂住。
/// 4. 合并规则：shell 值赢，但探测会话变量（PWD/OLDPWD/SHLVL/_）与
///    启动器自有前缀（DSH_/ELECTRON_）不覆盖。
/// 5. 超时（官方默认 10s）后杀整个进程组。
class LoginShellEnvironment {
  const LoginShellEnvironment._();

  static const delimiter = '_DSH_SHELL_ENV_DELIMITER_';
  static const _fallbackShells = ['/bin/zsh', '/bin/bash', '/bin/sh'];
  static const _probeEnvironment = {
    'DISABLE_AUTO_UPDATE': 'true',
    'ZSH_TMUX_AUTOSTARTED': 'true',
    'ZSH_TMUX_AUTOSTART': 'false',
  };
  static const _sessionKeys = {'PWD', 'OLDPWD', 'SHLVL', '_'};
  static const _dump =
      "printf '\\0%s\\0' '$delimiter'; command env -0 || exit; "
      "printf '\\0%s\\0' '$delimiter'; exit";

  /// 候选 shell 列表（去重保序）。
  static List<String> candidates() {
    final account = Platform.environment['SHELL'] ?? '';
    return [
      ...{if (account.isNotEmpty) account, ..._fallbackShells},
    ];
  }

  /// 解析两个分隔符之间的变量。rc 文件的杂音输出不会污染结果。
  static Map<String, String>? parseOutput(String stdout) {
    final parts = stdout.split('\x00');
    final first = parts.indexOf(delimiter);
    final last = parts.lastIndexOf(delimiter);
    if (first == -1 || first == last) return null;
    final variables = <String, String>{};
    for (final entry in parts.sublist(first + 1, last)) {
      final separator = entry.indexOf('=');
      if (separator > 0) {
        variables[entry.substring(0, separator)] = entry.substring(
          separator + 1,
        );
      }
    }
    return variables;
  }

  /// shell 变量叠加在继承环境上；shell 值赢，探测会话变量与 DSH_ 前缀除外。
  static Map<String, String> merge(
    Map<String, String> base,
    Map<String, String> shell,
  ) {
    final merged = Map<String, String>.of(base);
    for (final entry in shell.entries) {
      if (_sessionKeys.contains(entry.key) ||
          entry.key.startsWith('DSH_') ||
          entry.key.startsWith('ELECTRON_')) {
        continue;
      }
      merged[entry.key] = entry.value;
    }
    return merged;
  }

  /// 逐个候选尝试读取登录 shell 环境，全部失败返回 null（每个 10s）。
  /// 测试环境（ONDRA_TEST_HEADLESS=1）直接跳过：fixture 不需要继承
  /// 登录环境，10s 探测会把每个用例拖到超时。
  static Future<Map<String, String>?> read({
    Duration timeout = const Duration(seconds: 10),
  }) async {
    if (Platform.environment['ONDRA_TEST_HEADLESS'] == '1') return null;
    for (final shell in candidates()) {
      final result = await _readShell(shell, timeout);
      if (result != null) return result;
    }
    return null;
  }

  static Future<Map<String, String>?> _readShell(
    String shell,
    Duration timeout,
  ) async {
    Process process;
    try {
      process = await Process.start(
        shell,
        ['-ilc', _dump],
        environment: {...Platform.environment, ..._probeEnvironment},
      );
    } catch (_) {
      return null;
    }
    final completer = Completer<Map<String, String>?>();
    final builder = BytesBuilder();
    late final StreamSubscription<List<int>> subscription;
    var settled = false;

    void finish(Map<String, String>? value) {
      if (settled) return;
      settled = true;
      try {
        // 杀整个进程组：rc 文件里可能起了别的长驻程序。
        Process.killPid(process.pid, ProcessSignal.sigkill);
      } catch (_) {}
      if (!completer.isCompleted) completer.complete(value);
    }

    subscription = process.stdout.listen(
      builder.add,
      onDone: () {
        final text = utf8.decode(builder.takeBytes(), allowMalformed: true);
        finish(parseOutput(text));
      },
      onError: (_) => finish(null),
      cancelOnError: true,
    );
    // 总超时兜底：输出挂住（交互提示等）时不拖死启动。
    Timer(
      timeout,
      () => finish(
        parseOutput(utf8.decode(builder.takeBytes(), allowMalformed: true)),
      ),
    );
    final answer = await completer.future;
    await subscription.cancel();
    return answer;
  }
}
