import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "cn.ntars.ai"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "cn.ntars.ai"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // 签名密钥从 key.properties 读（不进仓库）；CI 上由 workflow 解码注入。
    // 密钥固定是升级覆盖安装的前提：换一次 key，用户就必须卸载重装。
    val keystoreProperties = Properties().apply {
        val f = rootProject.file("key.properties")
        if (f.exists()) f.inputStream().use { load(it) }
    }
    signingConfigs {
        create("release") {
            if (keystoreProperties.isNotEmpty()) {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }
    // 安卓内核闭包是 zip，aapt2 默认会压缩它；AssetManager.openFd 需要
    // 未压缩的 asset 才能拿到真实文件描述符。显式排除这个文件的压缩，
    // 让 Dart 侧按 offset/length 直接读 APK asset。
    androidResources {
        // node 的 N-API 插件必须来自真实文件。aapt2 会把 assets 里的 .so
        // 当原生库处理，但插件在 zip 里、扩展名是 .node；aapt2 默认仍会
        // 压缩它，解压到私有目录后才能 dlopen。这里保持 zip 与 .node 都不压缩。
        noCompress += listOf("ondra-dsh.zip", "node")
    }

    // node 二进制伪装成 libnode.so，必须真的落到 nativeLibraryDir 才能
    // exec（Android 10+ 禁止从数据目录执行）。AGP 8 默认直接从 APK 映射
    // 原生库、目录里是空的，内核探测会找不到解释器而退回不存在的 dsh。
    packagingOptions {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    buildTypes {
        release {
            signingConfig = if (keystoreProperties.isNotEmpty()) {
                signingConfigs.getByName("release")
            } else {
                // 没有 key.properties（例如克隆仓库直接跑）时退回 debug key，
                // 本地能跑起来；正式发版必须走上面的 release 配置。
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
