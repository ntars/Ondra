import 'package:flutter_svg/flutter_svg.dart';
import 'package:material_ui/material_ui.dart';

import 'avatar.dart';
import 'skin.dart';
import 'tokens.dart';

/// 品牌标记：空谷那笔手写的「A」。
///
/// 资产 `assets/brand/ondra-mark.svg` 由设计侧提供，是标记的**唯一真源**。
/// 本组件不改写它的路径、不改 viewBox、不生成派生文件——只做两件事：
/// **着色**（随主题或指定色）与**视觉归位**（把画布留白收掉、笔迹居中）。
///
/// 归位系数是量出来的，不是估的：源文件 viewBox 为 `0 0 2000 2000`，
/// 笔迹包围盒落在横向 20.20%–73.10%、纵向 18.20%–78.30%（宽 52.9% / 高 60.1%），
/// 也就是四周约有 40% 的空白，且笔迹中心比画布中心偏左 3.35%、偏上 1.75%。
/// 若按方框直接铺，标记会显得小一号并略微跑偏，因此放大 1/0.601 ≈ 1.664 倍，
/// 再按笔迹中心与画布中心的差值平移回来。
class OndraMark extends StatelessWidget {
  const OndraMark({super.key, this.size = 32, this.color});

  /// 视觉方框边长：笔迹会被归位到这个尺寸内（笔迹高度 = size）。
  final double size;

  /// 不传则跟随主题——浅色主题近黑、深色主题近白。
  final Color? color;

  static const String asset = 'assets/brand/ondra-mark.svg';

  /// 1 / 0.601：笔迹高度占画布比例的倒数。
  static const double _scale = 1 / 0.601;

  /// 笔迹中心相对画布中心的偏移，已折算到 size 上。
  static const double _dx = 0.0335 * _scale;
  static const double _dy = 0.0175 * _scale;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    final box = size * _scale;
    return SizedBox(
      width: size,
      height: size,
      // 放大后的画布超出方框，裁掉即可；笔迹本身始终在框内。
      child: ClipRect(
        child: OverflowBox(
          maxWidth: box,
          maxHeight: box,
          child: Transform.translate(
            offset: Offset(_dx * size, _dy * size),
            child: SvgPicture.asset(
              asset,
              width: box,
              height: box,
              colorFilter: ColorFilter.mode(color ?? s.ink, BlendMode.srcIn),
            ),
          ),
        ),
      ),
    );
  }
}

/// 圆角系数：与 macOS / iOS 应用图标同一套。Apple 的图稿是 1024 画布里的
/// 824 方形、圆角 185.4，比值 185.4 / 824 ≈ 0.225。所有规格的图标都按这个
/// 比例算圆角，16px 的小图标不会因为像素少而变方，1024 的大图也不会变圆。
const double ondraSquircleRatio = 185.4 / 824;

/// 应用图标形状：白底 + 黑标，超椭圆圆角。
///
/// 与生成到各平台的 PNG 图标同源同比例：标记占白底高度的 62%，
/// 白底占整块画布的 80.5%（1024 里的 824）。界面里需要用「应用图标」
/// 的地方（对话页的抬头、设置里的身份块）都用这个组件，避免各处各画一版。
class OndraAppTile extends StatelessWidget {
  const OndraAppTile({super.key, this.size = 48});

  final double size;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return SizedBox(
      width: size,
      height: size,
      child: DecoratedBox(
        decoration: ShapeDecoration(
          // 与应用图标同源的深色面：深色下用实色 `darkSideGlass`，
          // 而不是半透明/更暗的 surface——它常常压在玻璃或深色背景上。
          color: s.dark ? OndraColor.darkSideGlass : s.surface,
          shape: RoundedSuperellipseBorder(
            borderRadius: BorderRadius.circular(size * ondraSquircleRatio),
            side: BorderSide(color: s.lineCard),
          ),
        ),
        child: Center(
          child: OndraMark(size: size * 0.6, color: s.ink),
        ),
      ),
    );
  }
}

/// 人设头像：圆形，内容是**一张图**，不是画出来的标记。
///
/// 为什么头像单独是圆的：它是「人」，不是「应用」。同一枚标记，
/// 方的读作产品，圆的读作角色。
///
/// 默认图是 `assets/brand/avatar-default.png`（白底黑笔迹的 1024 方图），
/// 用户可以在设置里换成本地图片，落盘 `~/.ondra/avatar.png`（见 [AvatarStore]）。
///
/// 底色**固定白**、不随主题反色：这是刻意的取舍。反色意味着默认图在深色下
/// 要换成另一张（或现场再画一遍），用户自己上传的图又没法反色——「默认」和
/// 「自定义」会变成两套观感。统一白底之后，头像在深色界面里是一枚亮的小圆，
/// 反而更像一张台面上的人像卡。深色下的观感由 1px `lineCard` 描边收边。
class OndraAvatar extends StatelessWidget {
  const OndraAvatar({super.key, this.size = 28});

  final double size;

  @override
  Widget build(BuildContext context) {
    final s = OndraSkin.of(context);
    return AnimatedBuilder(
      animation: avatarStore,
      builder: (context, _) {
        final custom = avatarStore.bytes;
        return Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            // 图未解码完成时露出的底色：与默认图的白底同色，不会闪一下深圆。
            color: const Color(0xFFFFFFFF),
            border: Border.all(color: s.lineCard),
          ),
          child: ClipOval(
            child: custom == null
                ? Image.asset(
                    AvatarStore.defaultAsset,
                    width: size,
                    height: size,
                    fit: BoxFit.cover,
                  )
                : Image.memory(
                    custom,
                    width: size,
                    height: size,
                    fit: BoxFit.cover,
                    // 换图时不淡入淡出：头像是身份标记，中间态越少越好。
                    gaplessPlayback: true,
                  ),
          ),
        );
      },
    );
  }
}
