import 'package:material_ui/material_ui.dart';

import '../../../../../design/skin.dart';
import '../../../../../design/tokens.dart';

bool get embeddedBrowserAvailable => false;

/// 没有内嵌浏览能力的平台：说清楚，不留一块空白。
class OndraWebView extends StatelessWidget {
  const OndraWebView({
    super.key,
    required this.url,
    required this.allowedSites,
  });

  final String url;
  final List<String> allowedSites;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Container(
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: s.surface,
        borderRadius: BorderRadius.circular(OndraRadius.lg),
        border: Border.all(color: s.lineFaint),
      ),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              '这个平台没有内嵌浏览器',
              style: ondraText(13, color: s.ink60, height: 18 / 13),
            ),
            const SizedBox(height: 6),
            Text(
              '仅 macOS / Android / Windows 构建支持内嵌网页；当前平台不支持。\n$url',
              textAlign: TextAlign.center,
              style: ondraText(11, color: s.ink30, height: 17 / 11),
            ),
          ],
        ),
      ),
    );
  }
}
