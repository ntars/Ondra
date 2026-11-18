import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/services.dart' show MethodChannel;

/// 头像文件：`~/.ondra/avatar.png`。
///
/// 写入由原生侧完成（居中裁方 + 缩到 512 + 编码 PNG），这里只负责读与删。
/// 读用同步：文件最多几十 KB，且启动首帧就要显示头像，异步会闪一下默认图。
const MethodChannel _channel = MethodChannel('ondra/avatar');

File get _file {
  final home = Platform.environment['HOME'] ?? '.';
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

/// 弹 NSOpenPanel。原生侧负责裁切、缩放、落盘，返回是否真的换了图。
Future<bool> pickAvatar() async {
  try {
    final changed = await _channel.invokeMethod<bool>('pick');
    return changed ?? false;
  } catch (_) {
    // 原生侧没接（Web 构建、通道未建好）时静默失败：按钮点下去没反应，
    // 但不会抛到界面上。真正的平台差异由 avatar_stub 兜。
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
