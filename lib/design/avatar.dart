import 'dart:typed_data';

import 'package:material_ui/material_ui.dart';

import '../app/platform_capabilities.dart';
import 'avatar_stub.dart' if (dart.library.io) 'avatar_io.dart' as platform;

/// 人设头像的唯一来源。
///
/// 规则只有两条：
/// 1. **默认是一张 PNG**（白底黑线条，`assets/brand/avatar-default.png`），
///    和品牌标记同一枚笔迹，但它是图，不是绘制出来的组件——用户能替换的东西
///    必须先是一个「文件」，否则「默认」和「自定义」是两套渲染路径，切换时
///    尺寸、裁剪、边距都会跳一下。
/// 2. **用户可以换**：选一张本地图片，原生侧居中裁成正方形、缩到 512 并写成
///    `~/.ondra/avatar.png`。之后每次启动读这个文件；没有文件就是默认图。
///
/// 为什么裁切与缩放在原生侧做：Flutter 没有图像编码器，硬做要引一个图像库；
/// 而 AppKit 本来就要弹 NSOpenPanel，顺手用 CoreGraphics 画一张 512 的 PNG，
/// 既不多一个依赖，也保证落盘的就是最终尺寸（不会每次启动读一张 8MB 的原图）。
class AvatarStore extends ChangeNotifier {
  /// 默认头像：白底 + 黑笔迹，1024 正方形。
  static const String defaultAsset = 'assets/brand/avatar-default.png';

  /// 自定义头像的字节。`null` 表示用默认图。
  Uint8List? _bytes;

  Uint8List? get bytes => _bytes;

  bool get isCustom => _bytes != null;

  /// 启动时读一次。失败就保持默认图——头像读不出来不该拦住启动。
  void reload() {
    final next = platform.readAvatarBytes();
    if (next == null && _bytes == null) return;
    _bytes = next;
    notifyListeners();
  }

  /// 弹原生选择框。用户取消时什么都不变，成功了立刻换图。
  ///
  /// 返回 `false` 表示「没换」（取消 / 平台不支持），调用方不需要分辨原因。
  bool get pickerSupported => ondraCapabilities.avatarPicker;

  Future<bool> pick() async {
    final changed = await platform.pickAvatar();
    if (!changed) return false;
    _bytes = platform.readAvatarBytes();
    notifyListeners();
    return true;
  }

  /// 恢复默认图。文件删掉，不是「把默认图复制成自定义图」——后者的语义是
  /// 「用户选了一张和默认一模一样的图」，之后换默认图它就跟不上了。
  void reset() {
    platform.clearAvatar();
    _bytes = null;
    notifyListeners();
  }
}

/// 全局单例：头像只有一个人，不需要作用域。
final AvatarStore avatarStore = AvatarStore();
