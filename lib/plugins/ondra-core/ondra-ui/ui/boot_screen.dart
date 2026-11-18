import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:material_ui/material_ui.dart';

import '../../../../app/version.dart';
import '../../../../design/brand.dart';
import '../../../../design/skin.dart';
import '../../../../design/tokens.dart';

/// 启动屏：一枚标记、一个名字、一句 slogan，别的一概没有。
///
/// 早先这里画过三团漫射光，理由是「原实现有」；但那是别人的品牌语言，
/// 挪到空谷身上只会让人以为背景没加载完。**干净的白底**最难出错：
/// 启动屏只出现 700ms，任何渐变都来不及被看清，只来得及留下「花」的印象。
///
/// 副标题只放 slogan，不放版本号——版本号属于「关于」，不属于开机第一眼。
class BootScreen extends StatelessWidget {
  const BootScreen({super.key, this.failed = false, this.message});

  /// 置 true 展示启动失败态（红圈 + 说明），用于骨架期验证错误分支。
  final bool failed;
  final String? message;

  @override
  Widget build(BuildContext context) {
    // 桌面端用 85% 白压在原生玻璃上（参考 splash 的 rgba(246,246,246,.85)），
    // 开机第一眼就能透出桌面，和主界面是同一层玻璃；Web 没有底层玻璃，用实色。
    return ColoredBox(
      color: kIsWeb ? OndraColor.splash : OndraColor.splashGlass,
      child: Center(
        child: failed
            ? _BootFailure(message: message ?? '启动时遇到未知错误')
            : const _BootMark(),
      ),
    );
  }
}

class _BootMark extends StatelessWidget {
  const _BootMark();

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const OndraMark(size: 56),
        const SizedBox(height: 18),
        Text(
          ondraProductName,
          style: ondraText(
            20,
            weight: 600,
            color: s.ink,
            height: 28 / 20,
            spacing: 1.2,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          ondraSlogan,
          style: ondraText(13, color: s.ink45, height: 20 / 13),
        ),
      ],
    );
  }
}

class _BootFailure extends StatelessWidget {
  const _BootFailure({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return SizedBox(
      width: 420,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: const BoxDecoration(
              color: Color(0x1FFA382E),
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.error_outline,
              color: OndraColor.danger,
              size: 30,
            ),
          ),
          const SizedBox(height: 20),
          Text('启动未完成', style: ondraText(17, weight: 500, color: s.ink)),
          const SizedBox(height: 8),
          Text(
            message,
            textAlign: TextAlign.center,
            style: ondraText(13, color: s.ink60, height: 20 / 13),
          ),
          const SizedBox(height: 6),
          Text(
            '$ondraAppName $ondraVersion',
            style: ondraText(11, color: s.ink25),
          ),
        ],
      ),
    );
  }
}
