import 'dart:convert';

import 'package:flutter/services.dart' show rootBundle;
import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import 'profile_plugins.dart';

/// 随包清单与本机装配声明的投影，不代表运行时已加载。
class OndraPluginInfo {
  const OndraPluginInfo({
    required this.id,
    required this.name,
    required this.version,
    required this.kind,
    required this.group,
    required this.layer,
    required this.builtIn,
    required this.enabled,
    required this.glyph,
    required this.desc,
    this.profileBacked = false,
    this.blockedReason,
  });

  final String id;
  final String name;
  final String version;
  final String kind;
  final String group;
  final String layer;
  final bool builtIn;
  final bool enabled;
  final String glyph;
  final String desc;
  final bool profileBacked;
  final String? blockedReason;

  bool get switchable =>
      profileBacked && kind == 'plugin' && blockedReason == null;
}

class PluginsClient extends ChangeNotifier {
  PluginsClient({this.manifestPath = 'assets/plugins/manifest.json'});

  final String manifestPath;
  List<OndraPluginInfo> _entries = const [];
  String? _error;
  String? _notice;
  bool _loaded = false;
  bool _saving = false;

  List<OndraPluginInfo> get entries => _entries;
  String? get error => _error;
  String? get notice => _notice;
  bool get loaded => _loaded;
  bool get saving => _saving;
  int get profileCount => _entries.where((e) => e.profileBacked).length;
  int get enabledCount => _entries.where((e) => e.enabled).length;

  Future<void> load() async {
    final out = <OndraPluginInfo>[];
    _error = null;
    try {
      final raw = await rootBundle.loadString(manifestPath);
      final json = jsonDecode(raw) as Map<String, dynamic>;
      for (final e in (json['entries'] as List?) ?? const []) {
        if (e is! Map) continue;
        final id = (e['id'] as String?)?.trim();
        if (id == null || id.isEmpty) continue;
        out.add(
          OndraPluginInfo(
            id: id,
            name: (e['name'] as String?)?.trim() ?? id,
            version: (e['version'] as String?)?.trim() ?? '-',
            kind: (e['kind'] as String?)?.trim() ?? 'plugin',
            group: (e['group'] as String?)?.trim() ?? 'core',
            layer: (e['layer'] as String?)?.trim() ?? '插件',
            builtIn: e['builtIn'] == true,
            enabled: e['enabled'] == true,
            glyph: (e['glyph'] as String?)?.trim() ?? '',
            // 清单描述了尚未暴露的管理能力；此页不假称有安装/卸载接口。
            desc: id == 'ondra-plugins'
                ? '查看插件清单与装配配置，安全启停可选插件。'
                : (e['desc'] as String?)?.trim() ?? '',
          ),
        );
      }
    } catch (e) {
      _error = '随包清单读取失败：$e';
    }

    try {
      for (final p in await readProfilePlugins()) {
        final index = out.indexWhere((e) => e.id == p.id);
        final bundled = index < 0 ? null : out[index];
        final reason =
            p.blockedReason ??
            (bundled != null && (bundled.builtIn || bundled.kind != 'plugin')
                ? '随包基础项，不允许在此启停'
                : null);
        final protected = reason != null;
        final entry = OndraPluginInfo(
          id: p.id,
          name: bundled?.name ?? p.id,
          version: p.version,
          kind: bundled?.kind ?? (protected ? 'core' : 'plugin'),
          group: bundled?.group ?? (protected ? 'core' : 'extensions'),
          layer: bundled?.layer ?? (protected ? '基础插件' : '扩展插件'),
          builtIn: bundled?.builtIn ?? false,
          // 同名时保留清单的展示名，但状态必须取自真实装配层。
          enabled: p.enabled,
          glyph: bundled?.glyph ?? '',
          desc: bundled?.desc ?? _brief(p.desc),
          profileBacked: true,
          blockedReason: reason,
        );
        if (index < 0) {
          out.add(entry);
        } else {
          out[index] = entry;
        }
      }
    } catch (e) {
      _error = '${_error == null ? '' : '${_error!}\n'}装配层读取失败：$e';
    }
    _entries = out;
    _loaded = true;
    notifyListeners();
  }

  static String _brief(String desc) {
    final text = desc.trim();
    final dot = text.indexOf('。');
    final head = dot > 0 ? text.substring(0, dot + 1) : text;
    return head.length <= 80 ? head : '${head.substring(0, 79)}…';
  }

  Future<void> toggle(String id, bool value) async {
    if (_saving) return;
    final matches = _entries.where((e) => e.id == id);
    if (matches.isEmpty || !matches.single.switchable) {
      _error = matches.isEmpty
          ? '未找到插件：$id'
          : '$id：${matches.single.blockedReason ?? '没有可写入的扩展装配条目'}';
      notifyListeners();
      return;
    }
    if (matches.single.enabled == value) return;
    _saving = true;
    _error = null;
    notifyListeners();
    try {
      final result = await updateProfilePluginEnabled(id, value);
      if (!result.ok) {
        _error = result.error;
        return;
      }
      _notice =
          '装配配置已保存，下次重启内核后生效；当前运行状态未改变。'
          '未自动重启，也未中断对话。请等待当前回复完成后再重启应用。';
      await load();
    } catch (e) {
      _error = '装配层保存失败：$e';
    } finally {
      _saving = false;
      notifyListeners();
    }
  }
}

final PluginsClient pluginsClient = PluginsClient();
