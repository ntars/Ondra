import 'dart:convert';
import 'dart:io';

/// 桌面端的内核配置桥：直接读写 `settings.json`。
///
/// ## 路径为什么是 `~/.ondra/dsh/settings.json`
///
/// `DSH_HOME` 指向 `~/.ondra/dsh`（设了环境变量就用它）。宿主把「用户层」
/// 落在 `$DSH_HOME/settings.json`，形状是 `{user: {段: {字段: 值}}}`。
/// 这是 2026-11-19 在一份真实数据上核对过的结构，不是照文档猜的：
/// 那份文件里有 `{"user":{"privacy":{"approval-mode":"supervised"}}}`。
///
/// ## 为什么同步 IO
///
/// 一份设置文件几十 KB，读一次不到 1ms。改成异步会让每个设置项都要
/// `await` 一次，而界面在开关拨动的当下就得显示新值——异步只会多一层
/// 「等落盘」的状态，还得处理「落盘期间又拨了一次」。
///
/// ## 写失败必须返回 false
///
/// 磁盘满、权限不足、文件被占用都会失败。返回 false 之后界面要如实说
/// 「没保存成功」——静默失败会让用户以为设置生效了，下次启动才发现回到默认值。
class DshSettings {
  const DshSettings._();

  static bool get supported => true;

  /// `DSH_HOME` 优先；没设就用约定的 `~/.ondra/dsh`。
  static String get home {
    final override = _overrideHome;
    if (override != null) return override;
    final env = Platform.environment['DSH_HOME'];
    if (env != null && env.trim().isNotEmpty) return env.trim();
    return '${Platform.environment['HOME'] ?? '.'}/.ondra/dsh';
  }

  /// 测试用的重定向：非 null 时 `path` 落到这里。
  ///
  /// `DSH_HOME` 是进程级环境变量，测试进程启动之后改不了；没有这个口子，
  /// 「写进去的形状对不对」这件事就只能靠手工跑一次验证，而它会悄悄失效。
  static String? _overrideHome;

  /// 把配置目录重定向到 [home]（测试用）。传 null 恢复默认。
  static void setHome(String? home) => _overrideHome = home;

  static String get path => '$home/settings.json';

  /// 读整份文件。文件不存在或解析失败都返回空 map——
  /// 一个坏文件不该让设置页整屏空掉，用户还能改回来。
  static Map<String, Object?> readAll() {
    try {
      final f = File(path);
      if (!f.existsSync()) return const {};
      final raw = f.readAsStringSync();
      if (raw.trim().isEmpty) return const {};
      final parsed = jsonDecode(raw);
      if (parsed is! Map) return const {};
      return _asMap(parsed);
    } catch (_) {
      return const {};
    }
  }

  /// 读 `user.<id>` 这一段。
  static Map<String, Object?> section(String id) {
    final all = readAll();
    final user = all['user'];
    if (user is! Map) return const {};
    final sec = user[id];
    if (sec is! Map) return const {};
    return _asMap(sec);
  }

  /// 写一个字段。返回是否真的落盘成功了。
  static bool writeField(String section, String key, Object? value) {
    return _mutate((user) {
      final sec = user[section];
      final map = sec is Map ? _asMap(sec) : <String, Object?>{};
      if (value == null) {
        map.remove(key);
      } else {
        map[key] = value;
      }
      user[section] = map;
    });
  }

  static bool removeField(String section, String key) =>
      writeField(section, key, null);

  /// 读改写整份文件。**先写临时文件再 rename**：
  /// 直接覆写时若进程在写到一半被杀，settings.json 会变成半个 JSON，
  /// 内核下次启动会整份配置回退默认值——用户所有设置一次全丢。
  static bool _mutate(void Function(Map<String, Object?> user) change) {
    try {
      final f = File(path);
      final all = readAll();
      final userRaw = all['user'];
      final user = userRaw is Map ? _asMap(userRaw) : <String, Object?>{};
      change(user);
      final out = <String, Object?>{...all, 'user': user};

      f.parent.createSync(recursive: true);
      final tmp = File('${f.path}.tmp');
      tmp.writeAsStringSync(
        const JsonEncoder.withIndent('  ').convert(out),
        flush: true,
      );
      tmp.renameSync(f.path);
      return true;
    } catch (_) {
      return false;
    }
  }

  /// `jsonDecode` 给的是 `Map<String, dynamic>`，统一成 `Map<String, Object?>`，
  /// 免得每个调用点都要 `cast` 一次。
  static Map<String, Object?> _asMap(Map raw) {
    final out = <String, Object?>{};
    raw.forEach((k, v) => out['$k'] = v);
    return out;
  }
}
