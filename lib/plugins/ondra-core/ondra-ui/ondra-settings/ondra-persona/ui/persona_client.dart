import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart' show AssetBundle, rootBundle;
import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import '../../ui/profile_config.dart';
import 'persona_model.dart';
import 'persona_store.dart';

typedef PersonaConfigWriter = FutureOr<bool> Function(
  String section,
  String key,
  Object? value,
);
typedef PersonaConfigReader = String? Function(String section, String key);

/// 包投影与持久化选择，不声称 RPC 热切换成功。
/// [active] 是下次启动的选择；[pendingRestart] 表示尚未确认内核重启。
class PersonaClient extends ChangeNotifier {
  PersonaClient({
    this.indexPath = 'assets/personas/index.json',
    String? home,
    PersonaStore? store,
    AssetBundle? bundle,
    PersonaConfigWriter? configWriter,
    PersonaConfigReader? configReader,
  }) : _bundle = bundle ?? rootBundle,
       _readConfig =
           configReader ??
           (home != null || store != null ? _noRead : readProfileConfigField),
       _writeConfig =
           configWriter ??
           (home != null || store != null ? _noWrite : writeProfileConfigField),
       _store =
           store ??
           PersonaStore(
             home: home,
             userSubdir: _configuredUserSubdir(
               configReader ??
                   (home != null ? _noRead : readProfileConfigField),
             ),
           );

  // 注入包 home/store 时，默认禁止读写真实 profile/prefs；测试可再注入 writer。
  static String _configuredUserSubdir(PersonaConfigReader reader) {
    // profile 同时接受旧 camelCase 与段字段 kebab-case，空值遵循 loader 默认。
    final value =
        (reader('persona-loader', 'user-subdir') ??
                reader('persona-loader', 'userSubdir'))
            ?.trim();
    return value == null || value.isEmpty ? 'personas' : value;
  }

  static String? _noRead(String section, String key) => null;
  static bool _noWrite(String section, String key, Object? value) => false;

  final String indexPath;
  final PersonaStore _store;
  final AssetBundle _bundle;
  final PersonaConfigWriter _writeConfig;
  final PersonaConfigReader _readConfig;
  List<OndraPersona> _packs = const [];
  String? _activeId;
  bool _loading = false;
  Future<void>? _loadFuture;
  bool _selecting = false;
  bool _pendingRestart = false;
  String? _error;
  PersonaSelectionResult? _selectionStatus;

  List<OndraPersona> get packs => _packs;
  bool get loading => _loading;
  bool get selecting => _selecting;
  String? get error => _error ?? selectionError;
  bool get pendingRestart => _pendingRestart;
  PersonaSelectionResult? get selectionStatus => _selectionStatus;
  String? get selectionError => _selectionStatus?.error;

  OndraPersona get active {
    for (final p in _packs) {
      if (p.id == _activeId) return p;
    }
    return _packs.isEmpty ? OndraPersona.unknown : _packs.first;
  }

  String get displayName => active.name;

  Future<void> load() =>
      _loadFuture ??= Future<void>.microtask(_load)
          .whenComplete(() => _loadFuture = null);

  Future<void> _load() async {
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final packs = await _readAll();
      final remembered =
          _readConfig('persona-loader', 'active-persona') ??
          _readConfig('persona-loader', 'activePersona');
      final wanted = _activeId ?? remembered;
      _packs = List.unmodifiable(packs);
      _activeId =
          _idFor(packs, wanted) ??
          await _defaultId(packs) ??
          (packs.isEmpty ? null : packs.first.id);
    } catch (e) {
      _error = '$e';
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  /// 只重读本地投影，不代表运行中的内核已经重载包。
  Future<void> reload() => load();

  /// 写真实 persona-loader.active-persona。成功也仅表示待重启，非热切换。
  /// 保存失败时保留原选择，不写一份成功的 prefs 来掩盖内核失败。
  Future<PersonaSelectionResult> switchTo(String id) async {
    if (_selecting) return _selectionFailure('另一个人设选择正在保存。');
    final matches = _packs.where((p) => p.id == id);
    if (matches.isEmpty) return _selectionFailure('没有这个人设包。');
    final target = matches.first;
    _selecting = true;
    notifyListeners();
    try {
      if (!target.builtIn) {
        final synced = await _store.ensureKernelPack(target.slug);
        if (!synced.ok) return _selectionFailure(synced.message);
        if (synced.id != id) return _selectionFailure('包的内核 ID 已改变，请重新加载后选择。');
      }
      if (!await _writeConfig('persona-loader', 'active-persona', id)) {
        return _selectionFailure('人设选择未保存：无法写入内核 profile 配置。');
      }
      _activeId = id;
      _pendingRestart = true;
      _selectionStatus = const PersonaSelectionResult(
        ok: true,
        pendingRestart: true,
        message: '人设选择已保存，重启内核后生效。',
      );
      return _selectionStatus!;
    } catch (e) {
      return _selectionFailure('人设选择未保存：$e');
    } finally {
      _selecting = false;
      notifyListeners();
    }
  }

  PersonaSelectionResult _selectionFailure(String message) {
    final result = PersonaSelectionResult(ok: false, message: message);
    _selectionStatus = result;
    notifyListeners();
    return result;
  }

  Future<PersonaSelectionResult> resetToDefault() async {
    final id = await _defaultId(_packs);
    return switchTo(id ?? (_packs.isEmpty ? '' : _packs.first.id));
  }

  Future<PersonaIoResult> importPack({required String archivePath}) async {
    // 必须先知道资产 ID，不能因尚未 load 就让用户 ZIP 覆盖内置包。
    await load();
    if (_error != null) return PersonaIoResult(ok: false, message: _error!);
    final protected = {
      for (final p in _packs.where((p) => p.builtIn)) ...[p.slug, p.id],
    };
    final result = await _store.install(
      archivePath: archivePath,
      builtInSlugs: protected,
    );
    if (!result.ok) return PersonaIoResult(ok: false, message: result.message);
    await load();
    if (_error != null) {
      return PersonaIoResult(ok: false, message: '包已安装，但清单加载失败：$_error');
    }
    final selected = await switchTo(result.id ?? '');
    return PersonaIoResult(
      ok: selected.ok,
      pendingRestart: selected.pendingRestart,
      message: '${result.message}\n${selected.message}',
    );
  }

  Future<PersonaIoResult> exportActive({required String targetZip}) =>
      exportPack(active.id, targetZip: targetZip);

  Future<PersonaIoResult> exportPack(
    String id, {
    required String targetZip,
  }) async {
    final matches = _packs.where((p) => p.id == id);
    if (matches.isEmpty) {
      return const PersonaIoResult(ok: false, message: '没有这个人设包。');
    }
    final p = matches.first;
    if (p.builtIn) {
      return const PersonaIoResult(ok: false, message: '内置包随应用分发；导出只针对你自己装的包。');
    }
    final r = await _store.export(p.slug, targetZip: targetZip);
    return PersonaIoResult(ok: r.ok, message: r.message);
  }

  Future<PersonaIoResult> remove(String id) async {
    final matches = _packs.where((p) => p.id == id);
    if (matches.isEmpty) {
      return const PersonaIoResult(ok: false, message: '没有这个人设包。');
    }
    final target = matches.first;
    if (target.builtIn) {
      return const PersonaIoResult(ok: false, message: '内置包不能删除。');
    }
    if (_activeId == id) {
      final others = _packs.where((p) => p.id != id).toList();
      if (others.isEmpty) {
        return const PersonaIoResult(ok: false, message: '没有可替代的人设，不能删除当前包。');
      }
      final fallback = await _defaultId(others) ?? others.first.id;
      final saved = await switchTo(fallback);
      if (!saved.ok) {
        return PersonaIoResult(ok: false, message: '未删除：${saved.message}');
      }
    }
    final r = await _store.remove(target.slug, builtIn: false);
    if (!r.ok) return PersonaIoResult(ok: false, message: r.message);
    _pendingRestart = true;
    await load();
    return PersonaIoResult(ok: true, pendingRestart: true, message: r.message);
  }

  Future<List<OndraPersona>> _readAll() async {
    final index =
        jsonDecode(await _bundle.loadString(indexPath)) as Map<String, dynamic>;
    final slugs = (index['packs'] as List).cast<String>();
    final builtIn = ((index['builtIn'] as List?) ?? const [])
        .cast<String>()
        .toSet();
    final out = <OndraPersona>[];
    final known = <String>{};
    for (final slug in slugs) {
      if (!isSafePersonaSlug(slug)) {
        throw const FormatException('资产清单 slug 不合法。');
      }
      final dir = 'assets/personas/$slug';
      final meta = jsonDecode(
        await _bundle.loadString('$dir/meta.json'),
      ) as Map<String, dynamic>;
      final skill = await _bundle.loadString('$dir/SKILL.md');
      final p = parsePersona(
        meta: meta,
        skillMarkdown: skill,
        assetDir: dir,
        builtIn: builtIn.contains(slug),
        storageSlug: slug,
      );
      if (!known.add(p.id)) throw FormatException('内置人设 ID 重复：${p.id}');
      out.add(p);
    }
    for (final slug in _store.installedSlugs()) {
      final p = _store.readInstalled(slug);
      if (p != null && known.add(p.id)) out.add(p);
    }
    return out;
  }

  static String? _idFor(List<OndraPersona> packs, String? wanted) {
    for (final p in packs) {
      if (p.id == wanted || p.slug == wanted) return p.id;
    }
    return null;
  }

  Future<String?> _defaultId(List<OndraPersona> packs) async {
    try {
      final index = jsonDecode(
        await _bundle.loadString(indexPath),
      ) as Map<String, dynamic>;
      return _idFor(packs, index['default'] as String?);
    } catch (_) {
      return null;
    }
  }
}

class PersonaSelectionResult {
  const PersonaSelectionResult({
    required this.ok,
    required this.message,
    this.pendingRestart = false,
  });
  final bool ok;
  final bool pendingRestart;
  final String message;
  String? get error => ok ? null : message;
}

class PersonaIoResult {
  const PersonaIoResult({
    required this.ok,
    required this.message,
    this.pendingRestart = false,
  });
  final bool ok;
  final String message;
  final bool pendingRestart;
}

final PersonaClient personaClient = PersonaClient();
String get ondraPersonaName => personaClient.displayName;
