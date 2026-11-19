import 'package:flutter/foundation.dart' show TargetPlatform;
import 'package:flutter_test/flutter_test.dart';

/// 桌面三栏测试的形态声明。
///
/// ## 为什么非写不可
///
/// `flutter test` 里 `defaultTargetPlatform` 的默认值是 **android**——不是
/// 跑测试那台机器的真实平台。这件事在没有形态分支时无害，但一旦代码里
/// 出现 `ondraIsMobile`（见 `lib/design/form_factor.dart`）这种按平台
/// 分流的判断，整个测试套件就会集体走进手机布局：三栏没了、右栏宽度槽
/// 不存在、按 key 找不到控件，报一堆「Bad state: No element」。
///
/// 这些测试量的是**桌面三栏**的行为（右栏开合的中间帧、页面排版、设置面板
/// 位置），所以必须把平台钉成桌面。刻意不去改 `ondraIsMobile` 让它「测试里
/// 也返回 false」——那等于为了测试通过而让生产判断失真，而它恰恰是手机上
/// 唯一正确的判据。
///
/// ## 为什么用 `TargetPlatformVariant.only` 而不是 `setUp` 里赋值
///
/// 在 `setUp` 里写 `debugDefaultTargetPlatformOverride = ...` 会让测试**失败**：
/// 框架在 `postTest` 里有一条不变量检查，要求所有 `debug*` 变量在测试体
/// 结束时已经复位，而 `tearDown` 比那条检查跑得晚。报错是
/// 「The value of a foundation debug variable was changed by the test」。
///
/// `TargetPlatformVariant` 是框架为这件事准备的机制：它在测试体的前/后
/// 各做一次设置与还原（见 `flutter_test/src/widget_tester.dart` 的
/// `TargetPlatformVariant.setUp/tearDown`），顺序正确，而且会把平台名写进
/// 测试描述里，失败时一眼看得出跑的是哪个平台。
final TestVariant desktopFormFactor =
    TargetPlatformVariant.only(TargetPlatform.macOS);

/// 手机形态的声明，给手机布局的测试用。
final TestVariant mobileFormFactor =
    TargetPlatformVariant.only(TargetPlatform.iOS);
