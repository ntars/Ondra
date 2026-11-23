import 'package:material_ui/material_ui.dart';

import 'skin.dart';
import 'tokens.dart';

/// 全局主题。只承担「基础色 + 无涟漪 + 字体族」，
/// 具体排版一律由页面用 [ondraText] 显式给出，避免主题层藏隐形样式。
ThemeData ondraTheme(Brightness brightness) {
  final s = brightness == Brightness.dark
      ? OndraSkin.darkSkin
      : OndraSkin.light;
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    scaffoldBackgroundColor: s.content,
    canvasColor: s.content,
    // 内嵌 MiSans 只收了界面用字；仓库不带字体文件时，整段文字都落到这条回退链。
    fontFamily: ondraFontFamily,
    fontFamilyFallback: ondraFontFallback,
    splashFactory: NoSplash.splashFactory,
    highlightColor: Colors.transparent,
    hoverColor: Colors.transparent,
    dividerColor: s.line,
    colorScheme: ColorScheme.fromSeed(
      seedColor: OndraColor.accent,
      brightness: brightness,
      surface: s.surface,
    ),
    textSelectionTheme: const TextSelectionThemeData(
      cursorColor: OndraColor.accent,
      selectionColor: OndraColor.accentWashStrong,
      selectionHandleColor: OndraColor.accent,
    ),
    iconTheme: IconThemeData(color: s.ink60, size: 18),
    tooltipTheme: TooltipThemeData(
      waitDuration: const Duration(milliseconds: 400),
      decoration: BoxDecoration(
        color: const Color(0xE6101318),
        borderRadius: BorderRadius.circular(OndraRadius.sm),
      ),
      textStyle: ondraText(12, color: Colors.white),
    ),
  );
}
