package com.example.ondra

import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // 内核运行时通道：node 二进制伪装成 libnode.so 放在 jniLibs 里，
        // 安装后被系统提取到 nativeLibraryDir——那是安卓 10+ 上唯一允许
        // exec 的应用位置（数据目录被 W^X 禁了）。Dart 侧从这里拿启动路径。
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "ondra/native",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "nativeLibraryDir" -> result.success(applicationInfo.nativeLibraryDir)
                else -> result.notImplemented()
            }
        }
    }
}
