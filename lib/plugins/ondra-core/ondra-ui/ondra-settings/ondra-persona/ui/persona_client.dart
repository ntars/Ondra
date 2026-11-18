import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/services.dart' show rootBundle;
import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import 'persona_model.dart';

/// 人设视图：Cordis 运行时里 `ondra-persona` 插件输出的一份投影。
///
/// **插件体系只有一套：Cordis。** 人设的加载、热切换、导入导出是 Cordis 插件
/// 的职责，Flutter 这边**不实现插件、也不定义插件契约**，只做客户端：
///
/// - 运行时接通后：调 RPC（`ondra.persona.list / switch / reload / import / export`），
///   把返回值转成 [OndraPersona]；
/// - 运行时未接通（当前）：从随包资产读**同一份** `meta.json` + `SKILL.md`，
///   保证首屏有名字可显示。这条兜底路径不是插件，只是「还没有后端时的本地读」，
///   接上运行时后整段删掉即可，界面代码不用动。
///
/// 界面只依赖本类的 [active] / [packs] 与 [notifyListeners]。
class PersonaClient extends ChangeNotifier {
  PersonaClient({this.indexPath = 'assets/personas/index.json'});

  /// 包清单的路径。抽出来是为了测试能指向 fixture。
  final String indexPath;

  List<OndraPersona> _packs = const [];
  String? _activeId;
  bool _loading = false;
  String? _error;

  List<OndraPersona> get packs => _packs;
  bool get loading => _loading;

  /// 加载失败的原因（例如资产没打进包），界面据此显示提示而不是空名字。
  String? get error => _error;

  /// 当前人设。未加载完成或加载失败时返回 [OndraPersona.unknown]，
  /// 保证界面永远有东西可显示。
  OndraPersona get active {
    for (final p in _packs) {
      if (p.id == _activeId) return p;
    }
    return _packs.isEmpty ? OndraPersona.unknown : _packs.first;
  }

  String get displayName => active.name;

  /// 首次加载：读清单 → 逐个读包。失败不清空现场，只记 [error]。
  Future<void> load() async {
    if (_loading) return;
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final packs = await _readAll();
      _packs = packs;
      // 保留用户选过的那个；没选过就落到清单里的 default，再不行取第一个。
      final wanted = _activeId ?? await _defaultId();
      _activeId = packs.any((p) => p.id == wanted)
          ? wanted
          : (packs.isEmpty ? null : packs.first.id);
    } catch (e) {
      _error = '$e';
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  /// 热重载：重读磁盘/资产上的同一批包，保持当前选择。
  ///
  /// 与 [load] 分开是为了语义清楚——编辑了包里的 SKILL.md，按重载就能看到，
  /// 不需要重启应用，也不需要重新选人设。
  Future<void> reload() => load();

  /// 热切换：切到另一个包。返回 false 表示这个 id 不在清单里。
  Future<bool> switchTo(String id) async {
    if (!_packs.any((p) => p.id == id)) return false;
    if (_activeId == id) return true;
    _activeId = id;
    notifyListeners();
    return true;
  }

  /// 回到默认人设（清单里的 `default`）。
  ///
  /// 「重置」只动**当前是谁**，不动包本身：内置包不能删，用户导的包也都在。
  Future<bool> resetToDefault() async {
    final id = await _defaultId();
    if (id == null) return switchTo(_packs.isEmpty ? '' : _packs.first.id);
    return switchTo(id);
  }

  /// 导入一个包。骨架期没有文件系统与解压器，只做格式预检并如实返回原因。
  ///
  /// 这里刻意**不假装成功**：返回 unsupported 之后，界面显示「暂不支持」，
  /// 比默默吞掉用户的文件要好。
  Future<PersonaIoResult> importPack({
    required String fileName,
    required Uint8List bytes,
  }) async {
    if (bytes.length < 4 || bytes[0] != 0x50 || bytes[1] != 0x4B) {
      return const PersonaIoResult(
        ok: false,
        message: '不是有效的包（应为 zip，缺少 PK 头）',
      );
    }
    if (!fileName.endsWith('.zip') &&
        !fileName.endsWith('.skill') &&
        !fileName.endsWith('.ondra')) {
      return const PersonaIoResult(ok: false, message: '后缀应为 .zip / .skill / .ondra');
    }
    return const PersonaIoResult(
      ok: false,
      message: '解压与落盘还没接（需要文件系统与 zip 插件）',
    );
  }

  /// 导出当前人设。同样如实返回未实现。
  Future<PersonaIoResult> exportActive() async =>
      const PersonaIoResult(ok: false, message: '打包导出还没接（需要文件系统插件）');

  Future<List<OndraPersona>> _readAll() async {
    final indexRaw = await rootBundle.loadString(indexPath);
    final index = jsonDecode(indexRaw) as Map<String, dynamic>;
    final slugs = <String>[];
    for (final s in (index['packs'] as List?) ?? const []) {
      if (s is String && s.trim().isNotEmpty) slugs.add(s.trim());
    }
    final out = <OndraPersona>[];
    for (final slug in slugs) {
      final dir = 'assets/personas/$slug';
      final meta = jsonDecode(await rootBundle.loadString('$dir/meta.json'))
          as Map<String, dynamic>;
      // SKILL.md 缺失不该让整包失败：tagline 留空即可。
      var skill = '';
      try {
        skill = await rootBundle.loadString('$dir/SKILL.md');
      } catch (_) {}
      out.add(
        parsePersona(
          meta: meta,
          skillMarkdown: skill,
          assetDir: dir,
          builtIn: index['builtIn'] is List && (index['builtIn'] as List).contains(slug),
        ),
      );
    }
    return out;
  }

  Future<String?> _defaultId() async {
    try {
      final raw = await rootBundle.loadString(indexPath);
      final index = jsonDecode(raw) as Map<String, dynamic>;
      return (index['default'] as String?)?.trim();
    } catch (_) {
      return null;
    }
  }
}

/// 导入/导出结果。带原因，界面直接显示，不猜。
class PersonaIoResult {
  const PersonaIoResult({required this.ok, required this.message});

  final bool ok;
  final String message;
}

/// 全局客户端。骨架期只有一个进程、一份人设，单例够用；
/// 接上 Cordis 运行时后它内部换成 RPC 通道，调用点不变。
final PersonaClient personaClient = PersonaClient();

/// 当前人设名，界面最常用的一个值。
String get ondraPersonaName => personaClient.displayName;
