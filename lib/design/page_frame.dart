import 'package:material_ui/material_ui.dart';

import '../app/i18n.dart';
import 'primitives.dart';
import 'skin.dart';
import 'tokens.dart';

/// 页面的底色。两种：
/// - [plain] 白底，列表型页面用（日志、插件、备份、知识资料）；
/// - [canvas] 浅灰底 `#fbfbfb`，仪表盘型页面用，白色卡片浮在上面。
enum OndraPageTone { plain, canvas }

/// 内容槽里的统一页框：拖拽条 + 标题行 + 可滚动正文。
///
/// 为什么要有这一层：内容区在 960 宽窗口下只有 480，每页各自写标题会写出
/// 十套不同的字号与内距。这里把「标题 20/600、副标 13、左右 20、顶距 0」
/// 固定成一条基线，页面只关心正文。
///
/// 48 高的拖拽条不是装饰：外壳没有横跨整窗的标题栏，页面顶部这一段就是
/// 唯一能按住拖窗的地方。
class OndraPage extends StatelessWidget {
  const OndraPage({
    super.key,
    required this.title,
    this.subtitle,
    this.actions = const [],
    required this.child,
    this.tone = OndraPageTone.plain,
    this.padding = const EdgeInsets.fromLTRB(20, 0, 20, 20),
    this.scroll = true,
  });

  final String title;
  final String? subtitle;
  final List<Widget> actions;
  final Widget child;
  final OndraPageTone tone;
  final EdgeInsets padding;
  final bool scroll;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final canvas = tone == OndraPageTone.canvas;

    // 不再自己画左边界线：三栏的边界由侧栏的右缘与右栏的左缘各画一条，
    // 页面再画一条就会在同一个 x 上叠成 2px，左边那条看起来比右边粗一倍。
    return Container(
      color: canvas ? s.interconnect : s.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // 48 与左栏表头 `h-12` 同高：两侧表头在同一条水平线上，下面才开始正文。
          // 参考应用 mac 端不自绘标题栏（红绿灯浮在侧栏上），所以这条只负责拖窗与留白。
          const DragStrip(
            height: 48,
            padding: EdgeInsets.fromLTRB(16, 9, 16, 0),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        // 页面标题也翻：注册表里的 `label` 是中文原文，
                        // 侧栏翻了、标题没翻的话，同一页会出现两个名字。
                        OndraI18nScope.translate(context, title),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        // 20/600/28 是参考应用的页面标题档（`text-[20px] font-semibold leading-7`）。
                        style: ondraText(
                          20,
                          weight: 600,
                          color: s.ink,
                          height: 28 / 20,
                        ),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          OndraI18nScope.translate(context, subtitle!),
                          style: ondraText(13, color: s.ink60, height: 18 / 13),
                        ),
                      ],
                    ],
                  ),
                ),
                if (actions.isNotEmpty) ...[
                  const SizedBox(width: 12),
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        for (var i = 0; i < actions.length; i++) ...[
                          if (i > 0) const SizedBox(width: 8),
                          actions[i],
                        ],
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          Expanded(
            child: scroll
                ? OndraScroll(padding: padding, child: child)
                : Padding(padding: padding, child: child),
          ),
        ],
      ),
    );
  }
}

/// 白色圆角面板：仪表盘页里承载一组内容的底板。
///
/// 表头只有两种东西——**标题 14/500** 与**右侧一句说明 12/400**。
/// 说明尽量走 [meta] 而不是塞一个自定义 widget：它是文字就得和别人一样大，
/// 否则同一屏里会出现三种「右上角小字」。
class OndraPanel extends StatelessWidget {
  const OndraPanel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.title,
    this.meta,
    this.trailing,
  });

  final Widget child;
  final EdgeInsets padding;
  final String? title;
  final String? meta;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: s.surface,
        borderRadius: BorderRadius.circular(OndraRadius.xl),
        border: Border.all(color: s.lineCard),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (title != null) ...[
            Row(
              children: [
                Expanded(
                  child: Text(
                    title!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ondraText(
                      14,
                      weight: 500,
                      color: s.ink,
                      height: 20 / 14,
                    ),
                  ),
                ),
                if (meta != null)
                  Text(
                    meta!,
                    style: ondraText(12, color: s.ink40, height: 16 / 12),
                  ),
                ?trailing,
              ],
            ),
            const SizedBox(height: 12),
          ],
          child,
        ],
      ),
    );
  }
}

/// 小圆点状态灯：用于「已接入 / 未接入 / 运行中」。
class OndraStatusDot extends StatelessWidget {
  const OndraStatusDot({super.key, required this.color, this.size = 6});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(color: color, shape: BoxShape.circle),
    );
  }
}
