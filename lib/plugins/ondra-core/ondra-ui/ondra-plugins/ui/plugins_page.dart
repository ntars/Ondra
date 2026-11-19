import 'package:material_ui/material_ui.dart';

import './plugins_client.dart';
import '../../../../../design/glyph.dart';
import '../../../../../design/page_frame.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';

/// 插件扩展：**按 `lib/plugins` 的四个分类归档**，不是一条平铺的长表。
///
/// 分类与目录一一对应，装进来的东西落在哪，页面上就归到哪：
///
/// | 分类 | 目录 | 规则 |
/// |---|---|---|
/// | 应用核心 | `cordis/` | 框架本体，所有插件都挂在它上面 |
/// | 核心插件 | `ondra-core/` | 随包默认加载，不可关闭 |
/// | 对话内核 | `dsh-base/` | agent 循环与会话，随包加载 |
/// | 扩展插件 | `ondra-extensions/` | 随包附带，可以关 |
/// | 自定义插件 | `ondra-custom/` | 用户自己装的（如 `dsh-xxx`），可以关 |
///
/// 空的分类也照样列出来：它回答「装进来的插件会落在哪」，藏起来反而让人以为
/// 只有这些。开关只对可关闭的分类出现——关掉框架或内核等于关掉应用本身。
class PluginsPage extends StatelessWidget {
  const PluginsPage({super.key, this.client});

  final PluginsClient? client;

  static const List<_Group> _groups = [
    _Group('framework', '应用核心', 'cordis/'),
    _Group('core', '核心插件', 'ondra-core/'),
    _Group('kernel', '对话内核', 'dsh-base/'),
    _Group('extensions', '扩展插件', 'ondra-extensions/'),
    _Group('custom', '自定义插件', 'ondra-custom/'),
  ];

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);

    final plugins = client ?? pluginsClient;
    return AnimatedBuilder(
      animation: plugins,
      builder: (context, _) {
        final entries = plugins.entries;

        return OndraPage(
          title: '插件扩展',
          subtitle: entries.isEmpty
              ? '清单未加载'
              : '${entries.length} 项 · ${plugins.enabledCount} 项配置启用',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (plugins.error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
                  child: Text(
                    plugins.error!,
                    style: ondraText(11, color: s.ink40, height: 16 / 11),
                  ),
                ),
              if (plugins.notice != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
                  child: Text(
                    plugins.notice!,
                    style: ondraText(11, color: s.ink40, height: 16 / 11),
                  ),
                ),
              for (var g = 0; g < _groups.length; g++) ...[
                if (g > 0) const SizedBox(height: 22),
                _GroupHeader(
                  group: _groups[g],
                  count: entries.where((e) => e.group == _groups[g].key).length,
                ),
                ..._rowsOf(s, entries, _groups[g].key, plugins),
              ],
              const SizedBox(height: 22),
              Text(
                '这里显示随包清单与本机装配配置，不代表运行时已加载。'
                '身份、路径、持久化存储、人设与运行时等基础项受保护；'
                '仍被已启用插件依赖的条目会拒绝关闭。\n'
                '开关只修改本机 profile 的完整条目，下次重启内核后生效。'
                '不会自动重启或中断对话；请等待当前回复完成后再重启应用。',
                style: ondraText(11, color: s.ink30, height: 16 / 11),
              ),
            ],
          ),
        );
      },
    );
  }

  List<Widget> _rowsOf(
    OndraSkin s,
    List<OndraPluginInfo> entries,
    String key,
    PluginsClient plugins,
  ) {
    final items = entries.where((e) => e.group == key).toList();
    if (items.isEmpty) {
      return [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 2, 8, 0),
          child: Text(
            '暂无插件',
            style: ondraText(12, color: s.ink25, height: 18 / 12),
          ),
        ),
      ];
    }
    return [
      for (var i = 0; i < items.length; i++) ...[
        if (i > 0) _InsetHairline(color: s.lineFaint),
        _PluginRow(
          entry: items[i],
          onChanged: plugins.saving
              ? null
              : (v) => plugins.toggle(items[i].id, v),
        ),
      ],
    ];
  }
}

/// 一个分类：标签 + 目录名 + 条数。目录名用等宽感的灰字，和标签的层级分开。
class _Group {
  const _Group(this.key, this.label, this.path);

  final String key;
  final String label;
  final String path;
}

class _GroupHeader extends StatelessWidget {
  const _GroupHeader({required this.group, required this.count});

  final _Group group;
  final int count;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
      child: Row(
        children: [
          Text(
            group.label,
            style: ondraText(
              11,
              weight: 600,
              color: s.ink60,
              height: 14 / 11,
              spacing: 0.3,
            ),
          ),
          const SizedBox(width: 6),
          Text(
            group.path,
            style: ondraText(10, color: s.ink25, height: 14 / 10),
          ),
          const Spacer(),
          Text(
            '$count 项',
            style: ondraText(10, color: s.ink25, height: 14 / 10),
          ),
        ],
      ),
    );
  }
}

/// 让出图标宽度的发丝线：8 内距 + 30 图标 + 12 间距。
class _InsetHairline extends StatelessWidget {
  const _InsetHairline({required this.color});

  final Color color;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 50),
      child: OndraHairline(color: color),
    );
  }
}

/// 插件图标：**统一用空谷自己的应用图标**（白底圆角 + 标记），
/// 只有 dsh 内核例外——它是上游的内核，用官方图标，一眼能和空谷的区分开。
class _PluginIcon extends StatelessWidget {
  const _PluginIcon({required this.kind});

  final String kind;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      width: 30,
      height: 30,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(7),
        // 白底图标在白底卡片上会「浮不起来」，靠一圈发丝线定边界。
        border: Border.all(color: s.lineFaint),
      ),
      child: kind == 'kernel'
          ? Image.asset(
              'assets/icons/dsh.png',
              width: 30,
              height: 30,
              fit: BoxFit.cover,
              filterQuality: FilterQuality.high,
            )
          : const Glyph(Glyphs.plugin, size: 30),
    );
  }
}

class _PluginRow extends StatefulWidget {
  const _PluginRow({required this.entry, required this.onChanged});

  final OndraPluginInfo entry;
  final ValueChanged<bool>? onChanged;

  @override
  State<_PluginRow> createState() => _PluginRowState();
}

class _PluginRowState extends State<_PluginRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final e = widget.entry;

    return MouseRegion(
      cursor: SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 120),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
        decoration: BoxDecoration(
          color: _hover ? s.fillHover : Colors.transparent,
          borderRadius: BorderRadius.circular(OndraRadius.md),
        ),
        child: Row(
          children: [
            _PluginIcon(kind: e.kind),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          e.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: ondraText(
                            13,
                            weight: 500,
                            color: e.enabled ? s.ink : s.ink60,
                            height: 18 / 13,
                          ),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        'v${e.version}',
                        style: ondraText(10, color: s.ink25, height: 18 / 10),
                      ),
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    e.desc,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(12, color: s.ink60, height: 17 / 12),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 10),
            // 框架 / 内核 / 核心插件：显示状态而不是开关；扩展与自定义才给开关。
            if (e.switchable)
              OndraSwitch(value: e.enabled, onChanged: widget.onChanged)
            else
              Tooltip(
                message: e.blockedReason ?? '随包清单项，没有独立的装配开关',
                child: Text(
                  e.profileBacked
                      ? (e.enabled ? '已启用 · 受保护' : '已禁用 · 受保护')
                      : '随包声明',
                  style: ondraText(11, color: s.ink30, height: 18 / 11),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
