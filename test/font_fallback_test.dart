import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/design/font_face.dart';
import 'package:ondra/design/tokens.dart';

/// 字体降级链的验收。
///
/// 这两件事最容易在改动中被悄悄破坏：
///   1. 缺字体时应用必须照常起——`OndraFont.load()` 不能抛异常；
///   2. 回退链必须始终非空——仓库不带字体文件时，整段文字全靠它。
///
/// 字体文件本身不进仓库（MiSans 许可限制），所以这里测的是「有没有字体都能活」，
/// 而不是「字体长什么样」。本机跑过 `tool/subset_font.sh` 时走装上那条路，
/// 没跑过就走降级那条路，两条都必须不抛异常。
///
/// **用 `test` 而不是 `testWidgets`**：注册字体会触发引擎的「系统字体已变化」
/// 通知，它排一帧回调做重排。`testWidgets` 在拆树时会检查这一帧没跑完并报错，
/// 而这跟被测量的行为无关——真实启动路径里 `load()` 在 `runApp` 之前，没树可重排。
void main() {
  // `rootBundle` 需要绑定已初始化。
  TestWidgetsFlutterBinding.ensureInitialized();

  test('load() 不抛异常，缺字体时静默降级', () async {
    await OndraFont.load();
    // 不关心装上没装上，只关心没抛。usingBundledFont 仅用于诊断，两种取值都合法。
    expect(OndraFont.usingBundledFont, isA<bool>());
  });

  test('load() 可重复调用，不会重复注册', () async {
    await OndraFont.load();
    final first = OndraFont.usingBundledFont;
    await OndraFont.load();
    expect(OndraFont.usingBundledFont, first, reason: '第二次调用应直接返回');
  });

  test('回退链非空，且不包含 MiSans 自己', () {
    expect(ondraFontFallback, isNotEmpty);
    expect(
      ondraFontFallback,
      isNot(contains(ondraFontFamily)),
      reason: '回退链里再放 MiSans 会导致找不到字体时原地打转',
    );
  });

  test('回退链覆盖三大桌面平台的中文字体', () {
    // 缺字体时这是唯一的兜底，少一个平台就有一端显示成方框。
    expect(ondraFontFallback, contains('PingFang SC')); // macOS / iOS
    expect(ondraFontFallback, contains('Microsoft YaHei')); // Windows
    expect(ondraFontFallback, contains('Noto Sans CJK SC')); // Linux
  });

  test('ondraText 始终带上回退链', () {
    final style = ondraText(14);
    expect(style.fontFamily, ondraFontFamily);
    expect(style.fontFamilyFallback, ondraFontFallback);
  });

  test('字体族选择会切到真实系统族，未知值保持原选择', () {
    addTearDown(() => setOndraFontChoice('misans'));
    expect(setOndraFontChoice('serif'), isTrue);
    expect(ondraText(14).fontFamily, 'Songti SC');
    expect(ondraText(14).fontFamilyFallback, contains('SimSun'));
    expect(setOndraFontChoice('sans'), isTrue);
    expect(ondraText(14).fontFamily, 'Microsoft YaHei');
    expect(setOndraFontChoice('invented'), isFalse);
    expect(ondraText(14).fontFamily, 'Microsoft YaHei');
  });
}
