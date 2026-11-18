import 'dart:typed_data';

/// Web 兜底：没有可写文件系统，头像固定用默认图。
///
/// 之所以不是「内存里存一份」：Web 预览每次刷新都回到默认图，那种「换了头像
/// 但刷新就没了」的假能力比明说不支持更糟。真正要做，应该走 localStorage +
/// 浏览器文件选择，那是另一件事，这里不假装。
Uint8List? readAvatarBytes() => null;

Future<bool> pickAvatar() async => false;

void clearAvatar() {}
