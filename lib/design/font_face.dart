import 'dart:typed_data' show ByteData;

import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart' show FontLoader, rootBundle;

/// 字体的「装得上就装，装不上就降级」这一层。
///
/// ## 为什么字体不在 `pubspec.yaml` 里声明
///
/// MiSans 许可协议第 2 条第 2、3 款禁止「改编或二次开发」与「单独再分发
/// 字体软件或其任何副本」，子集化与随公开仓库分发同时触碰这两条。所以仓库
/// 不带字体文件，使用者在本地用 `tool/subset_font.sh` 自行生成。
///
/// 这带来一个新问题：`pubspec.yaml` 的 `fonts:` 段一旦声明了某个 asset，
/// 该文件缺失会让 `flutter build` **直接失败**，连降级的机会都没有。
/// 因此字体改成运行时加载——找不到文件就静默降级到系统字体。
///
/// ## 降级后的表现
///
/// [ondraFontFamily] 仍然是 `MiSans`，只是这个家族没有注册任何字形。Flutter
/// 的字体回退链会接管：先试 `fontFamilyFallback`（见 `theme.dart`），再落到
/// 平台默认字体。字重轴值（`FontVariation`）对静态字体无效，但
/// `tokens.dart` 的 `ondraWeight()` 已经把同一档映射成了 `FontWeight`，
/// 所以粗细仍然正确，只是失去 330 / 380 这种非整数档的细腻差别。
///
/// 这个降级是**静默**的：界面上不会弹提示，因为缺字体不影响任何功能，
/// 弹窗只是打扰。要知道当前有没有装上，看 [usingBundledFont]。
class OndraFont {
  const OndraFont._();

  /// 仓库里**不存在**的资产路径。字体由使用者在本地生成后才会出现。
  static const String _asset = 'assets/fonts/MiSans-Ondra.ttf';

  static bool _loaded = false;

  /// 是否成功装上了内嵌字体。false 表示当前跑在系统字体上。
  static bool get usingBundledFont => _loaded;

  /// 尝试加载内嵌字体。失败不抛异常——这是设计，不是疏忽。
  ///
  /// 必须在 `runApp` 之前调用，且要在 `WidgetsFlutterBinding.ensureInitialized()`
  /// 之后，因为 `rootBundle` 依赖绑定已初始化。
  static Future<void> load() async {
    if (_loaded) return;
    try {
      // 先探测再加载：`rootBundle.load` 在资产缺失时会抛
      // `FlutterError`，直接 try/catch 也能接住，但显式探测能让
      // 「文件不存在」与「文件损坏」在日志里分得开。
      final ByteData bytes = await rootBundle.load(_asset);

      // 字体数据为空同样视为失败：空文件注册上去会让整条回退链失效。
      if (bytes.lengthInBytes == 0) {
        debugPrint('[font] $_asset 是空文件，降级到系统字体');
        return;
      }

      final FontLoader loader = FontLoader('MiSans')
        ..addFont(Future<ByteData>.value(bytes));
      await loader.load();
      _loaded = true;
    } catch (e) {
      // 资产不存在是**预期情况**，不是错误：仓库本来就不带这个文件。
      // 只在 debug 下留一行，release 下不打扰。
      debugPrint('[font] 未找到内嵌 MiSans，使用系统字体（$e）');
    }
  }
}
