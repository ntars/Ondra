import 'package:material_ui/material_ui.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:ondra/design/motion.dart';
import 'package:ondra/design/tokens.dart';

/// 深色字重逆补偿的取值锁。
///
/// 这几个数字不是调出来的手感值，是取证的规格：参考实现深色下把
/// medium(500) 压到 `wght 465`、semibold(600) 压到 `wght 560`
/// （open-claude-ui `code-examples/cds-theme.css`）。改了就会被这条测试拦住——
/// 它是「深色文字会不会发胀」的唯一防线。
void main() {
  tearDown(() => OndraOptics.sync(dark: false));

  test('深色：500 → 465，600 → 560', () {
    OndraOptics.sync(dark: true);
    expect(OndraOptics.weight(500), 465);
    expect(OndraOptics.weight(600), 560);
  });

  test('深色：正文与说明不减细（再减就发灰）', () {
    OndraOptics.sync(dark: true);
    expect(OndraOptics.weight(330), 330);
    expect(OndraOptics.weight(380), 380);
  });

  test('浅色：原值透传', () {
    OndraOptics.sync(dark: false);
    for (final w in [330, 380, 450, 500, 600]) {
      expect(OndraOptics.weight(w), w);
    }
  });

  test('ondraText 跟随光学层，两个轴值同步', () {
    OndraOptics.sync(dark: true);
    final t = ondraText(14, weight: 500);
    expect(t.fontVariations!.first.value, 465);
    expect(t.fontWeight, FontWeight.w500);

    OndraOptics.sync(dark: false);
    final l = ondraText(14, weight: 500);
    expect(l.fontVariations!.first.value, 500);
    expect(l.fontWeight, FontWeight.w500);
  });
}
