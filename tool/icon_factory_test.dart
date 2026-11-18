// 应用图标工厂：一次生成全平台图标，几何与界面里的 [OndraAppTile] 同源。
//
// 运行：tool/icons.sh
// 产物：
//   macOS   10 档（16–1024）带 10% 透明边距 + 超椭圆圆角——Dock 直接显示原图，
//           所以圆角与边距必须烘进像素里。
//   iOS     满幅白底、不烘圆角：系统自己会裁，烘了就会出现「方角套圆角」。
//   Android 满幅白底（mipmap 各密度）。
//   Web     192 / 512 + 两个 maskable + favicon，按 macOS 的方式烘圆角。
//   Windows 多尺寸 .ico（PNG 载荷）。
//
// 尺寸规则与 Apple 一致：1024 画布里 824 的主形，四周各留 100（9.77%）；
// 圆角 185.4，即主形的 22.5%。所有规格都按比例算，不按像素查表。
//
// 这个文件放在 tool/ 下、名字带 _test 后缀，是为了能借 `flutter test` 的
// 引擎画图（纯 dart 进程没有 dart:ui）。它只在 --dart-define=ondra_icons
// 存在时写盘，正常跑测试不受影响。
//
// 不走组件树：直接开 PictureRecorder 画。测试里的假时钟推不动 flutter_svg
// 的异步解码，把整段塞进 runAsync 再 pump 组件会互相卡死；用 vg.loadPicture
// 拿到 Picture 后纯 canvas 合成，既没有时钟依赖，也不受视口裁剪影响。

import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';
import 'package:ondra/design/brand.dart';

/// 主形占画布的比例：824 / 1024。
const double _bodyRatio = 824 / 1024;

/// 标记占主形高度的比例。62% 是量出来的：再大会顶到圆角，再小在 Dock 里发虚。
const double _markRatio = 0.62;

/// 标记源文件的 viewBox 边长，以及笔迹包围盒在其中的位置（见 brand.dart）。
const double _markViewBox = 2000;
const double _inkHeightRatio = 0.601;
const double _inkCenterX = 0.4665;

/// 光学补偿：笔迹的重心在左下（那道长斜线），几何居中后人眼看它是偏左的。
/// 往右推 0.8% 主形宽，视觉上才回到正中。这是刻意的不居中。
const double _opticalDx = 0.008;
const double _inkCenterY = 0.4825;

void main() {
  const enabled = bool.fromEnvironment('ondra_icons');

  testWidgets('生成全平台应用图标', (tester) async {
    if (!enabled) {
      // 平时跑 flutter test 时直接跳过，不碰任何图片。
      return;
    }

    final root = Directory.current.path;
    final markSvg = File('$root/assets/brand/ondra-mark.svg').readAsStringSync();

    /// 画一张图并返回 PNG 字节。
    ///
    /// [bodyRatio] 为主形占画布的比例（1 表示满幅）；[rounded] 决定是否把
    /// 超椭圆圆角烘进像素；画布之外的区域保持透明。
    Future<Uint8List> paint({
      required double canvas,
      required bool rounded,
      required double bodyRatio,
    }) async {
      late Uint8List bytes;
      await tester.runAsync(() async {
        final mark = await vg.loadPicture(SvgStringLoader(markSvg), null);

        final recorder = ui.PictureRecorder();
        final c = Canvas(recorder);
        final body = canvas * bodyRatio;
        final rect = Rect.fromLTWH(
          (canvas - body) / 2,
          (canvas - body) / 2,
          body,
          body,
        );

        final paint = Paint()..isAntiAlias = true;
        if (rounded) {
          // 主体：白底超椭圆。圆角按主形算，所以 16px 和 1024px 的曲线一致。
          final shape = RoundedSuperellipseBorder(
            borderRadius: BorderRadius.circular(body * ondraSquircleRatio),
          );
          c.drawPath(shape.getOuterPath(rect), paint..color = Colors.white);
        } else {
          c.drawRect(rect, paint..color = Colors.white);
        }

        // 标记：先按「笔迹高度 = markHeight」求缩放，再把笔迹中心挪到主形中心。
        final markHeight = body * _markRatio;
        final scale = (markHeight / _inkHeightRatio) / _markViewBox;
        c.save();
        c.translate(rect.center.dx + body * _opticalDx, rect.center.dy);
        c.scale(scale);
        c.translate(
          -_markViewBox * _inkCenterX,
          -_markViewBox * _inkCenterY,
        );
        // 标记保持源文件的墨色（#231f20，品牌黑），不改写它的 fill：
        // 图标是资产，笔迹的颜色和形状都属于设计侧，代码只负责摆位置。
        c.drawPicture(mark.picture);
        c.restore();

        final image = await recorder.endRecording().toImage(
          canvas.round(),
          canvas.round(),
        );
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        image.dispose();
        mark.picture.dispose();
        bytes = data!.buffer.asUint8List();
      });
      return bytes;
    }

    // 同步写盘：测试的假时钟推不动真实 IO 的 Future，异步写会一直等下去。
    void save(String path, Uint8List bytes) {
      final file = File(path);
      file.parent.createSync(recursive: true);
      file.writeAsBytesSync(bytes);
    }

    /// macOS / Windows / Web：带边距 + 烘圆角。
    Future<Uint8List> dock(double size) =>
        paint(canvas: size, rounded: true, bodyRatio: _bodyRatio);

    /// iOS / Android：满幅、系统裁圆角。
    Future<Uint8List> full(double size) =>
        paint(canvas: size, rounded: false, bodyRatio: 1);

    // ---- macOS ----
    const macDir = 'macos/Runner/Assets.xcassets/AppIcon.appiconset';
    for (final size in [16, 32, 64, 128, 256, 512, 1024]) {
      save('$root/$macDir/app_icon_$size.png', await dock(size.toDouble()));
    }

    // ---- iOS ----
    const iosDir = 'ios/Runner/Assets.xcassets/AppIcon.appiconset';
    const iosSizes = <String, int>{
      'Icon-App-20x20@1x.png': 20,
      'Icon-App-20x20@2x.png': 40,
      'Icon-App-20x20@3x.png': 60,
      'Icon-App-29x29@1x.png': 29,
      'Icon-App-29x29@2x.png': 58,
      'Icon-App-29x29@3x.png': 87,
      'Icon-App-40x40@1x.png': 40,
      'Icon-App-40x40@2x.png': 80,
      'Icon-App-40x40@3x.png': 120,
      'Icon-App-60x60@2x.png': 120,
      'Icon-App-60x60@3x.png': 180,
      'Icon-App-76x76@1x.png': 76,
      'Icon-App-76x76@2x.png': 152,
      'Icon-App-83.5x83.5@2x.png': 167,
      'Icon-App-1024x1024@1x.png': 1024,
    };
    for (final entry in iosSizes.entries) {
      save('$root/$iosDir/${entry.key}', await full(entry.value.toDouble()));
    }

    // ---- Android ----
    const androidDensities = <String, int>{
      'mipmap-mdpi': 48,
      'mipmap-hdpi': 72,
      'mipmap-xhdpi': 96,
      'mipmap-xxhdpi': 144,
      'mipmap-xxxhdpi': 192,
    };
    for (final entry in androidDensities.entries) {
      save(
        '$root/android/app/src/main/res/${entry.key}/ic_launcher.png',
        await full(entry.value.toDouble()),
      );
    }

    // ---- Web ----
    save('$root/web/favicon.png', await dock(32));
    save('$root/web/icons/Icon-192.png', await dock(192));
    save('$root/web/icons/Icon-512.png', await dock(512));
    save('$root/web/icons/Icon-maskable-192.png', await full(192));
    save('$root/web/icons/Icon-maskable-512.png', await full(512));

    // ---- Windows ----
    final icoSizes = [16, 24, 32, 48, 64, 128, 256];
    final icoImages = <Uint8List>[
      for (final s in icoSizes) await dock(s.toDouble()),
    ];
    save(
      '$root/windows/runner/resources/app_icon.ico',
      _buildIco(icoSizes, icoImages),
    );
  });
}

/// 组一个多尺寸 ICO。Vista 起支持 PNG 载荷，所以直接塞 PNG，不做 BMP 编码。
Uint8List _buildIco(List<int> sizes, List<Uint8List> images) {
  final out = BytesBuilder();
  final head = ByteData(6 + 16 * sizes.length);
  head.setUint16(0, 0, Endian.little); // reserved
  head.setUint16(2, 1, Endian.little); // type: icon
  head.setUint16(4, sizes.length, Endian.little);

  var offset = 6 + 16 * sizes.length;
  for (var i = 0; i < sizes.length; i++) {
    final base = 6 + 16 * i;
    final s = sizes[i];
    head.setUint8(base, s >= 256 ? 0 : s); // 256 在 ICO 里写 0
    head.setUint8(base + 1, s >= 256 ? 0 : s);
    head.setUint8(base + 2, 0); // 调色板数
    head.setUint8(base + 3, 0); // 保留
    head.setUint16(base + 4, 1, Endian.little); // 色平面
    head.setUint16(base + 6, 32, Endian.little); // 位深
    head.setUint32(base + 8, images[i].length, Endian.little);
    head.setUint32(base + 12, offset, Endian.little);
    offset += images[i].length;
  }
  out.add(head.buffer.asUint8List());
  for (final img in images) {
    out.add(img);
  }
  return out.toBytes();
}
