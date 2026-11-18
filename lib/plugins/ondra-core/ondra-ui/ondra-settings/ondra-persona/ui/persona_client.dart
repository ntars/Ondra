import 'dart:convert';

import 'package:flutter/services.dart' show rootBundle;
import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import '../../../../../../app/prefs.dart';
import 'persona_model.dart';
import 'persona_store.dart';

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

  /// 用户目录（`~/.ondra/personas`）的读取与装载入口。
  final PersonaStore _store = PersonaStore();

  List<OndraPersona> _packs = const [];
  String? _activeId;
  bool _loading = false;
  String? _error;

  /// 「当前是谁」要跨启动记住：用户在设置里选了鲸鲸，下次开应用不该回到默认。
  /// 存在 prefs.json 里，键与人设插件同名前缀。
  static const String _activePrefKey = 'persona.activeId';

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
      final wanted = _activeId ?? _rememberedActive() ?? await _defaultId();
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

  /// 导入一个包。桌面端真解压落到 `~/.ondra/personas/<slug>/`，成功后自动切过去。
  ///
  /// 校验与落盘全部在 [PersonaStore] 里：后缀、PK 头、meta.json、slug 合法性，
  /// 逐关都在那一层判。这里只负责「装完重读清单并切过去」——
  /// 界面层不认识文件系统，也就不需要 import `dart:io`（浏览器版本要能编过）。
  Future<PersonaIoResult> importPack({required String archivePath}) async {
    final builtIn = {
      for (final p in _packs)
        if (p.builtIn) p.id,
    };
    final result = await _store.install(
      archivePath: archivePath,
      builtInSlugs: builtIn,
    );
    if (!result.ok) return PersonaIoResult(ok: false, message: result.message);

    // 装好了就重读清单并切过去：用户导一个包，意图一定是「用这一个」。
    await load();
    final slug = result.slug;
    if (slug != null) await switchTo(slug);
    return PersonaIoResult(ok: true, message: result.message);
  }

  /// 导出当前人设成 zip。桌面端真打包，浏览器预览如实拒绝。
  Future<PersonaIoResult> exportActive({required String targetZip}) async {
    final p = active;
    if (p.builtIn) {
      // 内置包在资产里，没有可打包的目录；用 store 的路径会落空。
      return const PersonaIoResult(
        ok: false,
        message: '内置包随应用分发，不需要导出；导出只针对你自己装的包。',
      );
    }
    final r = await _store.export(p.id, targetZip: targetZip);
    return PersonaIoResult(ok: r.ok, message: r.message);
  }

  /// 删一个用户装的包。删的如果是当前人设，自动回到默认。
  Future<PersonaIoResult> remove(String id) async {
    OndraPersona? target;
    for (final p in _packs) {
      if (p.id == id) target = p;
    }
    if (target == null) {
      return const PersonaIoResult(ok: false, message: '没有这个人设包。');
    }
    if (target.builtIn) {
      return const PersonaIoResult(ok: false, message: '内置包不能删除。');
    }
    final r = await _store.remove(id, builtIn: false);
    if (!r.ok) return PersonaIoResult(ok: false, message: r.message);
    if (_activeId == id) await _rememberActive(null);
    await load();
    return PersonaIoResult(ok: true, message: r.message);
  }

  /// 读全部包：先随包资产，再用户目录。
  ///
  /// 顺序就是优先级——同 slug 时**资产里那份先出现**，用户装的那份同名包
  /// 在装配阶段已经被 `PersonaStore.install` 拦住了（内置包不许覆盖），
  /// 所以这里不需要去重逻辑。
  Future<List<OndraPersona>> _readAll() async {
    final indexRaw = await rootBundle.loadString(indexPath);
    final index = jsonDecode(indexRaw) as Map<String, dynamic>;
    final slugs = <String>[];
    for (final s in (index['packs'] as List?) ?? const []) {
      if (s is String && s.trim().isNotEmpty) slugs.add(s.trim());
    }
    final builtIn = <String>{
      for (final s in (index['builtIn'] as List?) ?? const [])
        if (s is String) s,
    };
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
          builtIn: builtIn.contains(slug),
        ),
      );
    }
    // 用户装的包接在后面。读不动的那一份跳过，不因为一个坏包让整屏空掉。
    final known = {for (final p in out) p.id};
    for (final slug in _store.installedSlugs()) {
      if (known.contains(slug)) continue;
      final p = _store.readInstalled(slug);
      if (p != null) out.add(p);
    }
    return out;
  }

  /// 读回「上次选的是谁」。读不到返回 null，交给默认值兜底。
  String? _rememberedActive() {
    final raw = readPref(_activePrefKey);
    return raw.isEmpty ? null : raw;
  }

  Future<void> _rememberActive(String? id) async {
    writePref(_activePrefKey, id ?? '');
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
