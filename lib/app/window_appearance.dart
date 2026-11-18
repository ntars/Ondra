// 把 Flutter 的明暗同步给 AppKit：窗口与玻璃层都要跟着变。
export 'window_appearance_stub.dart'
    if (dart.library.io) 'window_appearance_io.dart';
