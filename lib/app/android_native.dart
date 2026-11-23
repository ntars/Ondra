/// 安卓原生通道：拿应用的 nativeLibraryDir。
///
/// 为什么需要它：安卓 10+ 禁止 exec 应用数据目录里的文件（W^X），但 APK 的
/// jniLibs 提取目录（nativeLibraryDir）允许执行——node 内核二进制伪装成
/// `libnode.so` 放在那里，是安卓上跑内核的唯一正路（nodejs-mobile 同款做法）。
/// `nativeLibraryDir` 只有原生侧（ApplicationInfo）知道，所以要一条通道。
library;

export 'android_native_stub.dart' if (dart.library.io) 'android_native_io.dart';
