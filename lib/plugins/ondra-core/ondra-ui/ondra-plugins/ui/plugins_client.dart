import 'dart:convert';

import 'package:flutter/services.dart' show rootBundle;
import 'package:material_ui/material_ui.dart' show ChangeNotifier;

import 'profile_plugins.dart';

/// 一条插件记录：随包分发的、Cordis 运行时里的，都长这样。
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
  });

  final String id;
  final String name;
  final String version;

  /// `framework` 框架本体 / `kernel` 对话内核 / `core` 核心插件 / `plugin` 扩展插件。
  final String kind;

  /// 所属分类目录：`framework`（cordis）/ `core`（ondra-core）/ `kernel`（dsh-base）/
  /// `extensions` / `custom`。分组只按这个字段走——界面不猜。
  final String group;

  /// 给人看的一层标注：应用核心 / 对话内核 / 核心插件。
  final String layer;

  final bool builtIn;
  final bool enabled;
  final String glyph;
  final String desc;

  /// 只有**扩展**插件能关。框架、内核、核心插件都是随包默认加载的一员：
  /// 关掉框架没有应用，关掉人设没有身份，给开关等于给一个假的选择。
  bool get switchable => kind == 'plugin';
}

/// 插件视图：Cordis 运行时里「装了什么」的一份投影。
///
/// 两路来源，拼成一张表：
///
/// 1. **随包清单** `assets/plugins/manifest.json`——应用自己带的那 18 项
///    （框架、内核、核心插件），它们的代码在 `lib/plugins` 里，随包发。
/// 2. **profile 装配层** `~/.ondra/dsh/profiles/ondra/cordis.patch.yml`——
///    内核真正会加载的插件，每一条都回 `node_modules` 读 `package.json`。
///    这一份是活的：装了、关了就变，不需要重新构建应用。
///
/// 两路同名时以清单为准（随包的东西有作者写好的中文名与简介）。
/// **不造假数据**——两路都读不到就显示空，不编条目。
class PluginsClient extends ChangeNotifier {
  PluginsClient({this.manifestPath = 'assets/plugins/manifest.json'});

  final String manifestPath;

  List<OndraPluginInfo> _entries = const [];
  String? _error;

  /// 关掉插件后给用户的一句实话：装配层改了，正在跑的进程不会重读。
  String? _notice;

  /// 哪些条目来自 profile（能真关）。清单里的核心插件不在此列。
  final Set<String> _fromProfile = {};

  bool _loaded = false;

  List<OndraPluginInfo> get entries => _entries;
  String? get error => _error;
  String? get notice => _notice;
  bool get loaded => _loaded;

  /// 来自内核装配层的条数——界面用它区分「随包」与「装进来的」。
  int get profileCount => _fromProfile.length;

  int get enabledCount => _entries.where((e) => e.enabled).length;

  Future<void> load() async {
    _fromProfile.clear();
    final out = <OndraPluginInfo>[];
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
            desc: (e['desc'] as String?)?.trim() ?? '',
          ),
        );
      }
      _error = null;
    } catch (e) {
      _error = '$e';
    }

    // 第二路：装配层。读不到就只是没有——不是错误，这台机器上内核还没装过。
    final bundled = out.map((e) => e.id).toSet();
    try {
      final loaded = await readProfilePlugins();
      for (final p in loaded) {
        if (bundled.contains(p.id)) continue;
        _fromProfile.add(p.id);
        out.add(
          OndraPluginInfo(
            id: p.id,
            name: p.id,
            version: p.version,
            kind: 'plugin',
            group: 'extensions',
            layer: '扩展插件',
            builtIn: false,
            enabled: p.enabled,
            glyph: '',
            desc: _brief(p.desc),
          ),
        );
      }
    } catch (e) {
      _error ??= '$e';
    }

    _entries = out;
    _loaded = true;
    notifyListeners();
  }

  /// `package.json` 的 description 常常是一整段设计说明：这里只留到第一个
  /// 句号（最多 80 字），后面的正文属于包自己的文档，不该挤在列表里。
  static String _brief(String desc) {
    final t = desc.trim();
    if (t.isEmpty) return '';
    final dot = t.indexOf('。');
    final head = dot > 0 ? t.substring(0, dot + 1) : t;
    return head.length <= 80 ? head : '${head.substring(0, 79)}…';
  }

  /// 开关：清单里的核心插件改本地视图（本来也不该关），
  /// profile 里的扩展插件**真改装配层**——关掉的那两行被注释，
  /// 下次内核启动就不再加载它。
  Future<void> toggle(String id, bool value) async {
    final profileBacked = _fromProfile.contains(id);
    if (profileBacked) {
      final ok = await setProfilePluginEnabled(id, value);
      if (!ok) {
        _error = '装配层写入失败（$id），开关已拨回';
        notifyListeners();
        return;
      }
      _notice = value
          ? '已加入装配层：下次连接内核时加载'
          : '已从装配层注释掉：下次连接内核时不再加载';
    }

    _entries = [
      for (final e in _entries)
        if (e.id == id)
          OndraPluginInfo(
            id: e.id,
            name: e.name,
            version: e.version,
            kind: e.kind,
            group: e.group,
            layer: e.layer,
            builtIn: e.builtIn,
            enabled: value,
            glyph: e.glyph,
            desc: e.desc,
          )
        else
          e,
    ];
    notifyListeners();
  }
}

/// 全局客户端，与 [personaClient] 同层。
final PluginsClient pluginsClient = PluginsClient();
