/// 浏览器里没有用户主目录：给稳定的内存占位值。
///
/// 这里不能返回一个路径。`home_dir_io.dart` 直接依赖 `dart:io.Platform`，
/// 而 Web 上 `Platform` 的任何 getter 都会抛 `Unsupported operation`；
/// 首帧前的 `ondraUserHome` 读取曾因此让整个 Web 应用白屏。
///
/// 占位值不假装能落盘：真正读写文件的代码都走条件导出的 `*_stub.dart`，
/// 它们不会碰这个字符串。保留在 UI 文案里出现时是一句人话，不是假路径。
String get ondraUserHome => '浏览器预览';

/// `/` 收尾，与桌面版 `~/.ondra` 的形状一致。
String get ondraUserDataRoot => '$ondraUserHome/.ondra';

/// Web 没有 path_provider，也没有应用私有目录。
Future<void> initMobileHome() async {}
