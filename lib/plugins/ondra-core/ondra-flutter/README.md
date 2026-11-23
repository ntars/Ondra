# ondra-flutter

预留的 Flutter 侧平台能力插槽。**目前是占位，不是假功能**：仓库里没有任何
代码引用它（`provides: []`），profile 也不装配它。

实际的平台能力散落在真实实现处，不要往这里找：

- 窗口 / 外观同步：`lib/app/window_geometry.dart`、`window_appearance_io.dart`
- 文件选择器：`lib/app/desktop_picker.dart`
- 通知：`lib/app/notifier_io.dart`
- 登录项 / 阻止睡眠：`lib/app/platform_actions_io.dart`
- 密钥串：`lib/app/keychain.dart`
- 内核子进程：`lib/plugins/ondra-core/ondra-ui/ondra-chat/ui/transport/`
- 安卓 nativeLibraryDir：`lib/app/android_native.dart` + `MainActivity.kt`

voice 插件注释里说的「发声交给 ondra-flutter」指的是这个预留位——
在 TTS 执行端落到 Flutter 平台通道之前，内核侧由旧拆分件 ondra-tts 承担
（见 profile 种子里的 cordis-plugin-ondra-tts）：macOS 用系统 `say`，
Windows 用系统 SAPI（PowerShell 调 .NET `System.Speech`，无额外 CLI），
另有可选的本机 GPT-SoVITS 与 Edge TTS。合成总开关默认关闭，与界面一致。

谁要往这里放代码：先删掉这段说明，补 plugin.json 的 `provides`，
然后在 profile（`plugin-profile/cordis.patch.yml`）点名。
