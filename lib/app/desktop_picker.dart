/// 系统文件面板：选文件、选目录、另存为。
///
/// 桌面端走 AppKit 的 NSOpenPanel / NSSavePanel（经 AppleScript 叫起来），
/// 浏览器预览里如实返回 null——那里没有文件系统，假装选了只会让人白等。
library;

export 'desktop_picker_stub.dart' if (dart.library.io) 'desktop_picker_io.dart';
