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
  const PluginsPage({super.key});

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

    return AnimatedBuilder(
      animation: pluginsClient,
      builder: (context, _) {
        final entries = pluginsClient.entries;

        return OndraPage(
          title: '插件扩展',
          subtitle: entries.isEmpty
              ? '清单未加载'
              : '${entries.length} 项 · ${_readyCount(entries)} 项已加载',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (pluginsClient.error != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
                  child: Text(
                    '清单读取失败：${pluginsClient.error}',
                    style: ondraText(11, color: s.ink40, height: 16 / 11),
                  ),
                )
              else if (pluginsClient.notice != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 0, 8, 10),
                  child: Text(
                    pluginsClient.notice!,
                    style: ondraText(11, color: s.ink40, height: 16 / 11),
                  ),
                ),
              for (var g = 0; g < _groups.length; g++) ...[
                if (g > 0) const SizedBox(height: 22),
                _GroupHeader(
                  group: _groups[g],
                  count: entries.where((e) => e.group == _groups[g].key).length,
                ),
                ..._rowsOf(s, entries, _groups[g].key),
              ],
              const SizedBox(height: 22),
              Text(
                '插件跑在 Cordis 运行时里，权限逐项授予；框架与内核不接受关闭，'
                '关掉它们等于关掉应用本身。\n'
                '「扩展插件」一栏来自本机的装配层（~/.ondra/dsh/profiles/ondra），'
                '关掉一个会把它从装配层里注释出去，下次连接内核时生效——'
                '正在跑的进程不会重读配置，这一点没法假装。',
                style: ondraText(11, color: s.ink30, height: 16 / 11),
              ),
            ],
          ),
        );
      },
    );
  }

  List<Widget> _rowsOf(OndraSkin s, List<OndraPluginInfo> entries, String key) {
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
          onChanged: (v) => pluginsClient.toggle(items[i].id, v),
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

/// 已加载 = 清单里标了 enabled 的项。
int _readyCount(List<OndraPluginInfo> entries) =>
    entries.where((e) => e.enabled).length;

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
  final ValueChanged<bool> onChanged;

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
              Text(
                e.enabled ? '随包加载' : '未加载',
                style: ondraText(11, color: s.ink30, height: 18 / 11),
              ),
          ],
        ),
      ),
    );
  }
}
