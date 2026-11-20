import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart' show MethodChannel;
import '../app/home_dir.dart';

/// 头像文件：`~/.ondra/avatar.png`。
///
/// 写入由原生侧完成（居中裁方 + 缩到 512 + 编码 PNG），这里只负责读与删。
/// 读用同步：文件最多几十 KB，且启动首帧就要显示头像，异步会闪一下默认图。
const MethodChannel _channel = MethodChannel('ondra/avatar');

File get _file {
  final home = ondraUserHome;
  return File('$home/.ondra/avatar.png');
}

Uint8List? readAvatarBytes() {
  try {
    final f = _file;
    if (!f.existsSync()) return null;
    final bytes = f.readAsBytesSync();
    // 0 字节说明上次写到一半被杀掉了：当没有，回默认图。
    return bytes.isEmpty ? null : bytes;
  } catch (_) {
    return null;
  }
}

/// 原生头像通道是否可用：macOS（NSOpenPanel）与安卓（系统选图 + 原生
/// 裁切落盘）都实现了 `ondra/avatar`。
bool get avatarPickerSupported => Platform.isMacOS || Platform.isAndroid;

/// 弹 NSOpenPanel。原生侧负责裁切、缩放、落盘，返回是否真的换了图。
/// [avatarPickerSupported] 为 false 时不会真正调用。
Future<bool> pickAvatar() async {
  if (!avatarPickerSupported) return false;
  try {
    final changed = await _channel.invokeMethod<bool>('pick');
    return changed ?? false;
  } catch (_) {
    // 通道建好但仍失败（面板被系统策略拒绝等）：同上，false 即取消/失败。
    return false;
  }
}

void clearAvatar() {
  try {
    final f = _file;
    if (f.existsSync()) f.deleteSync();
  } catch (_) {
    // 删不掉（权限、占用）时下次启动还会读回来：用户会看到「恢复默认」没生效。
    // 不做重试，也不静默改写到别处——文件系统异常不该由界面来圆。
  }
}
