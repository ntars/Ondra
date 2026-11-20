import 'package:flutter/services.dart' show MethodChannel;

const MethodChannel _channel = MethodChannel('ondra/native');

/// 应用的 nativeLibraryDir（APK jniLibs 提取目录）。
/// 非 Android 或通道不可用（应用壳没接）时返回 null。
Future<String?> androidNativeLibDir() async {
  try {
    return await _channel.invokeMethod<String>('nativeLibraryDir');
  } catch (_) {
    // 通道没接（旧壳 / Web 构建误入）：如实返回 null，调用方按
    // 「没有运行时」处理并提示。
    return null;
  }
}
