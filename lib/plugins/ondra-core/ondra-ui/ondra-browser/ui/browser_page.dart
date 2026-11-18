import 'package:material_ui/material_ui.dart';

import '../../../../../design/glyph.dart';
import '../../../../../design/page_frame.dart';
import '../../../../../design/primitives.dart';
import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';
import 'browser_client.dart';
import 'web_view.dart';

/// 网页浏览：**只打开白名单里的站点**。
///
/// 这一页不给地址栏随便跳转：先加白名单，再从列表里进。理由很实际——
/// 内嵌浏览器一旦能自由跳转，「读网页」类能力就绕过了一道门；
/// 而白名单就是那道门，只在一个地方写。
class BrowserPage extends StatefulWidget {
  const BrowserPage({super.key, this.onClose});

  /// 被动出现时的关闭动作：关掉面板，回到原来那一页。
  final VoidCallback? onClose;

  @override
  State<BrowserPage> createState() => _BrowserPageState();
}

class _BrowserPageState extends State<BrowserPage> {
  final _input = TextEditingController();
  String? _error;
  int _reloadTick = 0;

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  void _add() {
    final err = browserClient.add(_input.text);
    if (!mounted) return;
    setState(() {
      _error = err;
      if (err == null) _input.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return AnimatedBuilder(
      animation: browserClient,
      builder: (context, _) {
        final active = browserClient.active;
        if (active != null) {
          return OndraPage(
            title: '网页浏览',
            subtitle: Uri.tryParse(active)?.host ?? active,
            scroll: false,
            actions: [
              OndraSmallButton(
                label: '刷新',
                onTap: () => setState(() => _reloadTick++),
              ),
              if (widget.onClose != null) ...[
                const SizedBox(width: 8),
                OndraSmallButton(label: '关闭', filled: false, onTap: widget.onClose!),
              ],
            ],
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    children: [
                      _Link(
                        label: '‹ 返回白名单',
                        onTap: browserClient.backToList,
                      ),
                      const Spacer(),
                      Text(
                        active,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ondraText(11, color: s.ink30, height: 16 / 11),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(OndraRadius.lg),
                    child: OndraWebView(
                      key: ValueKey('$active#$_reloadTick'),
                      url: active,
                    ),
                  ),
                ),
              ],
            ),
          );
        }

        return OndraPage(
          title: '网页浏览',
          subtitle: '只打开白名单里的站点',
          actions: [
            if (widget.onClose != null)
              OndraSmallButton(label: '关闭', filled: false, onTap: widget.onClose!),
          ],
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // 加白名单：一个输入框 + 一个按钮，不弹窗。
              Container(
                padding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
                decoration: BoxDecoration(
                  color: s.fill,
                  borderRadius: BorderRadius.circular(OndraRadius.lg),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _input,
                        onSubmitted: (_) => _add(),
                        cursorColor: OndraColor.accent,
                        style: ondraText(13, color: s.ink, height: 18 / 13),
                        decoration: InputDecoration(
                          isDense: true,
                          border: InputBorder.none,
                          enabledBorder: InputBorder.none,
                          focusedBorder: InputBorder.none,
                          contentPadding: const EdgeInsets.symmetric(vertical: 8),
                          hintText: 'https://example.com',
                          hintStyle: ondraText(12, color: s.ink25, height: 18 / 12),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    _Link(label: '加入白名单', onTap: _add),
                  ],
                ),
              ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 6, left: 4),
                  child: Text(
                    _error!,
                    style: ondraText(11, color: OndraColor.danger, height: 16 / 11),
                  ),
                ),
              const SizedBox(height: 16),
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                child: Text(
                  '白名单',
                  style: ondraText(
                    11,
                    weight: 600,
                    color: s.ink40,
                    height: 14 / 11,
                    spacing: 0.3,
                  ),
                ),
              ),
              if (browserClient.sites.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 40),
                  child: Column(
                    children: [
                      Glyph(Glyphs.navBrowser, size: 22, color: s.ink25),
                      const SizedBox(height: 8),
                      Text('白名单还是空的', style: ondraText(13, color: s.ink40)),
                      const SizedBox(height: 4),
                      Text(
                        '加一个站点后，它会出现在这里，点一下就在应用内打开。',
                        style: ondraText(11, color: s.ink25, height: 16 / 11),
                      ),
                    ],
                  ),
                )
              else
                for (var i = 0; i < browserClient.sites.length; i++) ...[
                  if (i > 0) OndraHairline(color: s.lineFaint),
                  _SiteRow(site: browserClient.sites[i]),
                ],
              const SizedBox(height: 20),
              Text(
                '页面在应用内用系统 WebKit 渲染；不注入脚本、不读取页面内容。'
                '后续「读网页」的能力也走这份白名单。',
                style: ondraText(11, color: s.ink30, height: 16 / 11),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _SiteRow extends StatefulWidget {
  const _SiteRow({required this.site});

  final OndraSite site;

  @override
  State<_SiteRow> createState() => _SiteRowState();
}

class _SiteRowState extends State<_SiteRow> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: () => browserClient.openSite(widget.site),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 120),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
          decoration: BoxDecoration(
            color: _hover ? s.fillHover : Colors.transparent,
            borderRadius: BorderRadius.circular(OndraRadius.md),
          ),
          child: Row(
            children: [
              Container(
                width: 26,
                height: 26,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: s.fill,
                  borderRadius: BorderRadius.circular(7),
                ),
                child: Glyph(Glyphs.navBrowser, size: 14, color: s.ink60),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.site.host,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ondraText(13, weight: 500, color: s.ink, height: 18 / 13),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      widget.site.url,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: ondraText(11, color: s.ink40, height: 15 / 11),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              _Link(label: '移除', onTap: () => browserClient.remove(widget.site)),
            ],
          ),
        ),
      ),
    );
  }
}

class _Link extends StatelessWidget {
  const _Link({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Text(
          label,
          style: ondraText(12, weight: 500, color: s.ink60, height: 18 / 12),
        ),
      ),
    );
  }
}
