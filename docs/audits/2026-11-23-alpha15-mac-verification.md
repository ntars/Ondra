# 2026-11-23 v3.0.0-alpha.15 缺陷报告 mac 端复验

> 输入报告：`/Users/ntars/Downloads/v3.0.0-alpha.15.md`。
> 用户最新指令：**不再使用 Parallels 与蓝叠，mac 端做好即可**。
> 本轮范围：保留工作区已有修复，完成 mac 构建与命令行主链路复验，并把原报告的逐项状态归档。Windows VM / Android 模拟器均不再作为验收手段。

## 结论

- 当前工作区已包含报告所列共用代码修复：人设 Windows 路径分隔符、开机自启 GBK 解码、GGUF `where` 系统编码、凭据 YAML 引号往返、权限提示、英文设置导航与主题说明、字体族选择、引导模型告警、纯图片历史、会话 mtime、状态统计刷新、聊天错误/断线区分、长对话自动滚底、换模型时等待传输关闭、Markdown 记忆字段、JSON 来源原文/使用记录/重复项状态、损坏库告警、清空数据保留内核人设包并清缓存、设置导出补齐模型与人设目录、内核异步关停、`DSH_HOME` 与用户子目录、崩溃日志脱敏开关。
- 报告中的 Windows 原生能力：头像选择、通知、阻止空闲睡眠代码已补，但按用户最新范围**不做 Windows 虚拟机编译/实测**；不把它们列为已验收。
- 报告中的 Windows WebView2 仍缺实现，保持未修复，等待 Windows 实机/CI 明确要求后再处理。Windows 原生 TTS 的当前工作区改动见文末追加节；未做 Windows 实机验收。
- 本轮发现并修正一个 mac 打包环境问题：本机 proxy 的 CA 不被 CocoaPods Ruby 信任；构建时使用本机 `SteamTools Certificate` 导出的临时 CA 后 `pod install` 成功。没有把 CA 文件写入仓库。
- 本轮发现一个随包运行时产物问题：`runtime/macos-arm64` 中曾混入百度网盘 `.baiduyun.uploading.cfg` 残留文件，复制到 `.app` 后让 ad-hoc 签名校验显示 `sealed resource is missing or invalid`。清理残留并重新签名后应用可正常从包内资源启动；未把生成物改动提交。
- 后续复核签名时又发现两类不稳定生成物： `.baiduyun.uploading.cfg` 与 `*.dshpurge.bak` 会被外部同步/内核清理流程删除，导致已签名 `.app` 的密封资源清点失败。已在 `tool/bundle_macos.sh` 的 `ditto` 后加入统一清理，再重跑 `--skip-build` 打包；`codesign --verify --deep --strict` 现已通过。

## 逐项状态

### 已修复（代码在工作区，测试覆盖）

| 报告问题 | 处置 |
|---|---|
| 自定义人设装好却选不上（Windows 反斜杠） | `persona_store_io.dart` 统一 basename 解析；测试覆盖。 |
| 开机自启写入/删除误报 | `platform_actions_io.dart` 对中文 Windows 输出用 `systemEncoding` 解码；测试覆盖。 |
| 本地 GGUF 列表因 `where` 中文输出格式异常 | `llama_client_io.dart` 用 `systemEncoding` 读输出，并先提交扫描结果；测试覆盖。 |
| 含特殊字符 API 密钥读回变形 | `keychain_io.dart` YAML 引号往返修正，凭据 `records:` 保留；`keychain_credentials_test.dart` 覆盖。 |
| 系统权限误报 / Windows 通知说明错写成 macOS | `maintenance_io.dart` 与 `console_sheet.dart` 按平台给权限文案；`notifier_io.dart` 增加 Windows 分支。 |
| 点侧栏角色名进入通用设置 | `ConsoleSheet(initialPane:)` 初始化；设置接线与组件测试覆盖。 |
| 字体族无法选择 | 设置项与字体加载链已补；`font_fallback_test.dart` 等覆盖。 |
| 新用户误以为内核接入即可聊天 | 引导文案明确需在模型基座配置模型或网关。 |
| 纯图片会话从历史消失 | `history_sessions_io.dart` 保留图片占位与会话标题；`history_sessions_test.dart` 覆盖。 |
| 快照还原后会话日期变今天 | `backup_engine_io.dart` 保留 JSONL mtime；`backup_engine_test.dart` 覆盖。 |
| 状态面板统计不刷新 | `status_page.dart` 监听聊天变化后重读统计；组件测试覆盖。 |
| 一轮回复失败被当成断线 | `chat_client.dart` / `ambient_rail.dart` 区分模型错误与连接断开；测试覆盖。 |
| 长对话发送后看不到新消息 | `_Conversation` 新增跟底逻辑；聊天组件测试覆盖。 |
| 快速换模型后历史少一句 | `stdio_transport_io.dart` 关闭前等待落盘/退出；`stdio_transport_test.dart` 覆盖。 |
| Markdown 搬家丢整条记忆、修订字段丢失 | `transfer_engine_io.dart` 按正规记忆编号解析并补齐字段；`transfer_engine_test.dart` 覆盖。 |
| JSON 来源原文、使用记录、重复项状态 | `transfer_engine_io.dart` 导入时写回来源、命中/说出次数与封存/修订；测试覆盖。 |
| 损坏库告警不显示、恢复后留旧错误 | `status_source_io.dart` 每次查询清空错误，`status_page.dart` 显示错误；`status_page_test.dart` 覆盖。 |
| 清空数据误删内核人设包、漏清缓存 | `maintenance_io.dart` 清理清单修正；`maintenance_test.dart` 覆盖。 |
| 设置「导出全部数据」漏模型配置与人设目录 | `maintenance_io.dart` 导出清单补齐；`maintenance_test.dart` 覆盖。 |
| 维护入口未等内核真正退出 | `data_maintenance.dart` 等 `closeTransport()`；测试覆盖。 |
| `ONDRA_DSH_HOME` / persona `user-subdir` 迁移路径 | `maintenance_io.dart` 等按实际配置解析；测试覆盖。 |
| 崩溃日志脱敏开关无效 | `crash_log_io.dart` 读取设置开关；`crash_log_test.dart` 覆盖。 |
| 旧安装覆盖时同名旧文件不升级 | `runtime_seed_io.dart` 按 SHA-256 只升级仍由种子拥有的文件；`bundled_runtime_test.dart` 覆盖。 |

### 未修复 / 本轮按范围不验收

| 报告问题 | 状态 |
|---|---|
| Windows 内嵌 WebView2 后端 | 原生 COM、origin 白名单、`CapturePreview` + WIC 像素纹理已补；未做 Windows 实机/CI 编译与可见页面验收。 |
| Windows 原生 TTS 后端 | 已加系统 SAPI 分支并统一默认关闭；本轮未做 Windows 实机/CI 运行，详见文末追加节。 |
| Windows 头像选择 / 通知 / 阻止睡眠 | 代码已补（含 PS 逃逸、toast AppUserModelID、XML escape），但没有按用户最新指令做 VM 编译或实测，不能称已验收。 |
| Windows EXE 实测、VC++ 运行库、登录项重启 | 本轮不启动 PD；保持报告原有证据边界。 |
| Android | 用户明确不再用蓝叠；本轮不新增 Android 设备证据。 |

## 本轮 mac 端验证

### 构建

- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer PATH=/opt/homebrew/bin:$PATH SSL_CERT_FILE=<临时CA> flutter build macos --release`：成功，产物 `build/macos/Build/Products/Release/空谷 Ondra.app`。
- `tool/bundle_macos.sh --skip-build`：成功把 `runtime/macos-arm64`（197 MB）放入 `.app/Contents/Resources`，整包 247 MB，ad-hoc 签名。
- 清理随包运行时残留的 `.baiduyun.uploading.cfg` 后重新签名，GUI 进程可从包内资源启动；`~/.ondra/logs/transport.log` 记录 `launch: .../空谷 Ondra.app/Contents/Resources/runtime/macos-arm64/node .../dsh/lib/bin.js` 与 `initialize ok`。
- 新增打包清理后重跑 `tool/bundle_macos.sh --skip-build`：成功，整包 245 MB；`codesign --verify --deep --strict` 通过。GUI 没有再做窗口自动化或隐藏窗口操作，沿用上一轮的可见启动证据。

### 命令行主链路

使用真实内核与本机 Magpie 网关，在隔离 `ONDRA_DSH_HOME=/private/tmp/ondra-cli-dsh-home` 下运行临时 Flutter 测试（测试文件已删除，不留仓库）：

- `StdioDshTransport.connect()`：`lastError == null`，握手成功。
- `transport.send('Reply with exactly CLI_SMOKE_OK.')`：收到正文 `CLI_SMOKE_OK`。
- 同一轮中直接 `curl` Magpie `/v1/chat/completions` 也返回 `SMOKE_OK`，说明模型服务可用，不是测试桩。
- `flutter analyze`：0 issues。
- `flutter test --reporter compact`：531 passed / 3 skipped。3 项是依赖系统 `dsh` 的 sidecar 用例，默认环境跳过；其真实链路由上一项命令测试补证。
- `git diff --check`：通过。

### GUI 边界说明

- 已通过截图确认： booting → 欢迎引导 → 三栏外壳、10 个模块页、右栏聊天窗、`已接入` 状态、状态统计与日志入口可见。
- 用户随后明确要求改用命令行调试，不要继续隐藏窗口。因此本轮不把 GUI 文本输入自动化失败归因为产品 bug；改以真实内核的命令行 `session/prompt` 证据作为主链路结论。
- 没有把窗口隐藏状态留在系统中：之前为截图临时隐藏的应用进程已全部恢复可见。

## 证据边界

- 构建与命令行验证均在本机 macOS 完成；没有新的 Windows VM、Android 模拟器、真机或公网部署证据。
- Mac APP 为 ad-hoc 签名，只能本机运行；Developer ID 签名、公证、第二台 Mac 覆盖升级未做。
- `.app` 内 runtime 是构建产物，不属于源码提交；打包脚本现在会在签名前剔除常见残留文件，避免污染签名与包体，但未改动上游 `tool/assemble_runtime.mjs`。
- 未新建 `CHANGELOG.md`（仓库原本没有此文件）。所有源码改动保持工作区未提交。

## 增补：Windows WebView2 内嵌浏览器后端（同日）

这一节只记录随后新增的 Windows WebView2 代码与验证边界；上面原有 mac 证据保持不变。

### 已实现

- Dart：`web_view_io.dart` 的 `embeddedBrowserAvailable` 现在按
  `defaultTargetPlatform` 把 Windows 与 macOS / Android 一并列为支持平台；
  Windows 分支使用本地 `WindowsView` shim（Flutter 3.50 没有内置同名组件），
  通过 `ondra/webview/host/create` 创建原生视图，并继续复用
  `ondra/webview/<id>` 的 `start` / `stop` / `navigationRejected` /
  `loadFailed`（`{reason}`）协议。
- Windows 原生：新增 `windows/runner/web_view_win.{h,cpp}`，以 WebView2 Win32
  COM 实现导航与 origin 准入（scheme + host + port 严格相等、默认端口归一化）；
  拒绝 iframe / 新窗口越界请求，HTTPS 页面禁止降级 HTTP，错误回传原因而不带 URL。
  `flutter_window.{h,cpp}` 仅增加该宿主的注册与销毁，原有 `ondra/window`、
  `ondra/platform`、`ondra/notify` 通道和用户刚修的 AppUserModelID 位置均保留。
- 构建：`windows/runner/CMakeLists.txt` 默认从 NuGet 获取
  `Microsoft.Web.WebView2` 静态 loader（版本可缓存/覆盖，当前
  `1.0.2739.15`）；SDK 不可用时退回 fallback，不加载网页并报告 `loadFailed`。
  复核时修正了原生调用：官方 SDK 只有
  `CreateCoreWebView2EnvironmentWithOptions` / `CreateCoreWebView2Controller`，
  早前草稿里的 `CreateWebView2EnvironmentWithDetails` / `CreateWebView` 不是
  WebView2 API，会在 Windows 编译期失败；同时为 2D controller 补了离屏宿主
  HWND，并在视图销毁时释放。WebView2 运行时仍为系统共享组件，不进入发布 zip，
  也不改 GitHub release 工作流。
- README：`lib/plugins/ondra-core/ondra-ui/ondra-browser/README.md` 已改为
  精确 origin 判定，并写明三平台后端、fallback 条件和纹理合成限制。

### 本机验证

- `/Users/ntars/.local/flutter-3.50.0/bin/flutter test test/browser_client_test.dart --reporter compact`：17/17 passed，
  包括用 `debugDefaultTargetPlatformOverride = TargetPlatform.windows` 在 macOS
  上验证可用分支、创建参数、`start` / `stop`、拒绝原因展示与规则变化重建。
  该测试只 mock Dart 宿主通道，不使用 WebView2 运行时。
- `flutter analyze` 对上述 Dart 源与测试：无问题。

### 明确未验证 / 仍待完成

- **没有**在 macOS 上做 Windows 原生编译，也没有运行 Windows/WebView2 运行时；
  不把 Native COM、SDK 下载、CMake 链接、纹理回调或 allow-list 拦截视为已实测。WIC 使用 Windows SDK 的 `<wincodec.h>` 与系统 `windowscodecs.lib`，没有把 SDK 头文件副本提交到仓库。
- 已核对本机 Flutter 3.50.0 的 engine 头文件：`FlutterDesktopEngineGetTextureRegistrar`
  和 `FlutterDesktopRegistrarGetTextureRegistrar` 都是公开的 C API；runner 通过
  `FlutterEngine::GetRegistrarForPlugin` 取得同一 engine 的 registrar 后注册纹理，
  不需要也不应访问 `FlutterEngine` 的私有 C 句柄。`web_view_win.cpp` 的像素纹理回调
  用视图自己的 `buffer_mutex_` 同步，并按引擎传入的宽高返回像素缓冲，避免固定
  1280×720 造成的拉伸或裁剪。这些仍是源码级证据，未代替 Windows 编译。
- 已从 NuGet 下载并检查钉住的 `Microsoft.Web.WebView2 1.0.2739.15`：SDK 确实包含
  `build/native/include/WebView2.h`、`WebView2EnvironmentOptions.h`、
  `build/native/x64/WebView2LoaderStatic.lib`，且头文件只提供
  `CreateCoreWebView2EnvironmentWithOptions`（不存在草稿里误写的
  `CreateWebView2EnvironmentWithDetails` / `CreateWebView`）。这验证的是 SDK 内容，
  不是本机链接或运行。
- 2026-11-24 追加：在 macOS 上用 Homebrew 的 `x86_64-w64-mingw32-g++` 对
  `web_view_win.cpp`、`flutter_window.cpp`、`main.cpp` 做了两轮
  `-fsyntax-only`：不带 `ONDRA_WEBVIEW2_AVAILABLE` 的 fallback 构建与定义
  `ONDRA_WEBVIEW2_AVAILABLE` 的 WebView2 构建均为 0 错误；后者用仅用于检查的
  `Microsoft::WRL::Callback` 签名 shim 代替 MinGW 系统头缺失的 MSVC
  `wrl/implements.h`，没有参与仓库构建。该轮复核修掉了原生代码里的结构/接口
  错误：重复的 View 私有区导致外层宿主方法嵌套在 `View` 内、构图期调用
  `HandleCall` 找不到方法、`CreateWebView2EnvironmentCompletedHandler` 与官方
  SDK 的 `CreateCoreWebView2EnvironmentCompletedHandler` 名称不符、控制器/环境
  创建回调多传了第三个参数、`ICoreWebView2` 误调并不存在的 `Close()`、WIC
  `Initialize` 的 UINT 参数类型不匹配，以及 `#ifdef` 分区错置导致 WebView2
  关闭构建仍编译 COM 代码。这里只证明 C++ 语法和接口名与本机拿到的 SDK 头一致；
  没有做链接，也不能代替 Windows CLI 的 `flutter build windows --release`。
- 仓库的 `windows-test` workflow 已增加 `flutter build windows --debug`，用于让后续
  推到 `main` 的 Windows CI 真正编译 runner。当前工作区没有 GH 认证，无法用 API
  手动触发 `workflow_dispatch`；最近一次公开 workflow run 仍是新增编译步骤之前的
  旧提交，其失败不能作为当前改动通过/失败的证据。这一步必须以新提交的 CI 结果或
  Windows 命令行构建结果收口。
- 已把透明占位替换为 `CapturePreview(PNG)` → WIC → RGBA 的后台抓帧管线，
  并把窗口尺寸同步到 WebView2 bounds 与 Flutter 纹理；这是 D3D11 共享纹理
  之外的等效像素路径，刷新约 5fps。WIC 接口直接使用系统头文件，避免仓库内
  自带 `wincodec.h` 造成 SDK 版本漂移。仍需在 Windows 上确认编译、像素上屏、
  白名单拒绝、重定向、新窗口拦截和 stop/rebuild。
- 需要 Windows CI / 实机跑 `flutter build windows --release` 与手工导航用例后再更新状态。

## 追加：Windows 原生 TTS 与默认口径修复（当前工作区）

### 根因与改动

- 报告第三节的「朗读回复」同时暴露两个问题：插件只有 GPT-SoVITS / macOS `say` / Edge TTS，Windows 没有系统语音分支；界面默认关闭，而随包 profile 的插件配置是 `enable: true`，首启同步只推用户真实改过的偏好，因此两边各用各的默认值。
- `plugin-profile/node_modules/@ondra/cordis-plugin-ondra-tts/lib/` 是本仓随包运行时的构建输入和当前唯一可改副本。新增 `branches/windows-sapi.js`：用 Windows 自带的 PowerShell 调 `System.Speech.Synthesis.SpeechSynthesizer`，把文本写成临时 UTF-8 文件后读取，避免命令行转义；脚本用 UTF-16LE `-EncodedCommand` 传递，不经控制台代码页；支持 `Rate`（−10..10）、`Volume` 和可选系统音色全名，输出 WAV 路径沿用既有引擎契约，临时文本无论成败都删除。
- 不新增外部 CLI/网络依赖。PowerShell 路径先查 `%SystemRoot%` / `%windir%` 下的 `System32\WindowsPowerShell\v1.0\powershell.exe`，再查 PATH；显式指定 `provider: windows-sapi` 时不再回退别的通道，失败按既有原因码返回。
- 通道枚举增加 `windows-sapi`，`auto` 在 Windows 上按「本机 GPT-SoVITS → 系统 SAPI → Edge TTS」挑第一条就绪的；macOS 顺序不变。服务层的扩展名与缓存身份已补上新分支，避免 Edge 音色 id 与系统音色混用同一份缓存。
- 插件 `enable` 出厂默认改成 `false`，装配层 `cordis.patch.yml` 的 `ondra-tts.config.enable` 也改成 `false`。配置合并时装配层走 `factory`，用户 `settings.json` 里的 `enable: true` 仍能覆盖它。保留已有 SettingsClient 迁移逻辑：覆盖升级时旧 `cordis.patch.yml` 仍在用户目录，首启无偏好时会把它从 `true` 改成 `false`，并标为需重启内核。复核后又把 `settings.js` 的 `volume` 说明改成同时覆盖 Windows SAPI 的 0-100 映射，避免文档仍只描述 macOS。

### 验证

- `node --test --test-name-pattern='tts' test/plugin_profile_integration_test.mjs`：2 通过 / 0 失败。覆盖快照枚举与出厂默认、PowerShell 解析、UTF-16LE 编码、单引号转义、语速/音量换算、WAV 合成桩、临时文本清理和音色失败原因码。
- `flutter test test/settings_client_test.dart test/settings_spec_test.dart test/settings_wiring_test.dart --reporter compact`：通过；新增用例确认新出厂值 `false` 不会被二次改写，冻结字段表补入 `sapi-voice`。
- `flutter analyze`：2 issues，均为工作区里与本轮无关的既有告警（`web_view_io.dart` 未使用 `dart:io`、`browser_client_test.dart` 的 `prefer_const_constructors`）；本轮改动没有新增问题。`git diff --check`：通过。

### 证据边界与后续

- 没有 Windows 实机、VM 或 CI 运行，不声称真实 SAPI 发声、系统音色清单、音频设备或播放链路已验收。macOS 本机只跑纯函数/桩测试。
- `plugin-profile/README.md` 明确记下例外：本机没有 TTS 插件源码树，这次直接改了编译后的快照。下次运行 `tool/sync_plugin_profile.mjs` 前必须把这些改动合回插件源码，否则会被源 profile 覆盖。
- `runtime/macos-arm64/profile` 是装配产物，尚未重跑 `tool/assemble_runtime.mjs`；出包前应重新装配，让 Windows runtime 的 profile 也带上新分支。Windows 原生编译、WebView2 像素上屏、SAPI 真实发声仍属于当前目标的剩余未验收项。

## 追加：2026-11-24 Windows 命令行编译与启动复核

> 用户随后要求继续逐项核对 alpha.15 报告中的 Windows 缺陷，并明确「空谷可以用命令行调试，不要再把窗口都隐藏了」。用户最新文字未再次要求只做 mac；本轮只用 `prlctl exec` 在已经运行的 Windows 11 虚拟机里做命令行构建和可见启动，没有新建虚拟机、没有隐藏空谷窗口，也没有做蓝叠/Android 验收。

### 构建链根因与修复

- 宿主 Mac 不能运行 `flutter build windows`；使用来宾机内的官方 Flutter 3.50.0 Windows SDK（`C:\ondra-flutter-sdk-official`）和 Visual Studio 2022 Build Tools。来宾机旧 SDK 不完整，复制工作区源码到 `C:\OndraBuild` 后，旧 `.flutter-plugins-dependencies` 仍指向宿主 `/Users/ntars/.pub-cache`，导致生成的原生插件 symlink 缺 `windows/` 子目录；在来宾机内重新 `pub get` 并把该生成文件的插件路径改到 `C:\PubCache` 后，CMake 才能正确纳入插件。
- 第一次真实 MSVC 编译在 `web_view_win.cpp` 失败：`std::fill(..., 255)` 把 `int` 写入 `uint8_t` 向量，`/W4 /WX` 下报 `C4244` 并升级为 `C2220`。根因是占位像素类型不一致；已在 `windows/runner/web_view_win.cpp` 增加 `constexpr uint8_t kOpaqueAlpha = 255` 并替换两处 `std::fill` 的值，未放宽编译告警。来宾机内用与 CMake 相同的 MSVC 参数单独编译该文件：`EXIT_CODE=0`。
- 完整 Windows Debug 构建成功，产物 `build\windows\x64\runner\Debug\ondra.exe` 与 `flutter_windows.dll` 均生成；随后完整 Release 构建也成功，产物在 `build\windows\x64\runner\Release\ondra.exe`（200,704 字节）和 `flutter_windows.dll`（21,332,480 字节）。两次都有 `ONDRA_ALLOW_NO_RUNTIME=ON` 的预期警告：该环境变量只用于本机编译 UI/native 代码，产物没有随包 Node 运行时。

### 可见启动与开屏判断

- 用命令行 `Start-Process` 启动 Debug 和 Release EXE，进程持续存活，窗口标题为 `空谷 Ondra`。前台截图里有左侧模块栏（状态面板、记忆星图、历史对话、插件扩展、备份还原、导入导出、使用教程和日志入口）、中栏「状态面板」标题和右栏聊天壳；因此用户报告的「卡在开屏」在当前构建中不能复现。
- 截图中大面积黑色区域是来宾机原有的 Parallels Tools 终端窗口覆盖，不是空谷黑屏；已尝试通过窗口消息关闭该终端，但之后它仍由 Parallels 服务重建。没有把空谷窗口隐藏当作结论依据，窗口句柄和标题均保留。
- 来宾机注册表确认装有 WebView2 Runtime `157.0.4341.60`。本轮没有在 UI 中完成白名单页面导航，因此 WebView2 的像素上屏、allow-list 拒绝、`_blank` 拦截、stop/rebuild 仍未验收。

### 回归门禁

- 宿主源码：`git diff --check` 通过；`flutter analyze` 为 `No issues found!`；完整 `flutter test --reporter compact` 为 `533 passed / 3 skipped`；`test/browser_client_test.dart` 为 `17/17 passed`。
- 来宾机完整 Dart 测试命令因 Flutter 每次启动都重写 `.flutter-plugins-dependencies` 而失败：该生成文件带 `A H` 属性，来宾工具尝试写入时报权限错误；这只影响来宾机测试命令本身，不影响已经成功的 Windows 原生 Debug/Release 编译和宿主完整测试。没有把这个失败写成产品回归。
- 没有提交、推送、删除用户改动或改动发布资产；工作区源码修改仍只有 `web_view_win.cpp` 与本审查文档。

### 追加：命令行调试直达入口与 WebView2 像素缓冲修复

- 为满足「命令行调试，不要再隐藏窗口」的要求，桌面调试新增 `ONDRA_SETTINGS=1`：启动时直接打开设置面板；原有 `ONDRA_PAGE=browser` 仍可直达网页浏览页。两者都只在显式设置环境变量时生效，不进入普通用户启动路径。
- 用 `ONDRA_PAGE=browser` + `ONDRA_SETTINGS=1` 从 Windows 命令行启动可见的 Debug EXE，设置面板确实直达，滚动到「网页白名单」并打开后，之前无 BOM 的 JSON 仍显示为空；改成标准 UTF-8 JSON（无 BOM）后，同一进程内重新进入页面，两个本机测试站点都出现在列表里。这验证的是 Dart 存储格式要求，不是 GUI 滚动或窗口自动化结论。
- 白名单条目点击后，宿主 HTTP 服务没有收到新的 WebView2 请求，截图期间还被来宾机另一个全屏游戏抢到前台；因此该次尝试不能证明像素上屏成功或失败。窗口进程仍存活、标题仍为「空谷 Ondra」，没有隐藏窗口。
- 代码复核发现新的原生根因：`CopyPixels` 把 `pixel_buffer_` 的 width/height 改成渲染线程请求的尺寸，却继续返回旧的 `frame_bytes_`；`Resize` 又在只持 `capture_mutex_` 时重分配 `frame_bytes_`，再在 `buffer_mutex_` 下发布指针。这会让 Flutter 按一个尺寸读取另一尺寸的缓冲，并有数据竞争。已改为：缓冲重分配、指针和尺寸发布同在 `buffer_mutex_` 内完成；`CopyPixels` 不再改共享尺寸，只发布与 `frame_bytes_` 一致的尺寸；零尺寸请求返回空指针。
- 来宾机重新完整编译 Debug 成功（161.5s）。宿主 `flutter analyze` 为 `No issues found!`，完整 `flutter test --reporter compact` 为 `533 passed / 3 skipped`，`git diff --check` 通过。
- WebView2 页面渲染、`_blank` 导航、HTTPS→HTTP 拒绝、stop/rebuild 以及第二台实体机仍未验收；不能把这次编译与白名单文件加载扩大为运行时全通过。

### 剩余边界

- 安装包层面的 VC++ DLL 打包、登录项重启、第二台 Windows 实体机仍无新证据。
- 原生 TTS 的真实语音链路没有完成可用例级验收：来宾机用与 SAPI 分支相同的
  `System.Speech.Synthesis.SpeechSynthesizer` + `SetOutputToWaveFile` 流程实测，
  PowerShell 退出码 0，生成 `C:\Users\ntars\Downloads\ondra-sapi-test.wav`
  （108,480 字节，文件头 `RIFF`）。这证明 Windows 来宾机上的 .NET/SAPI 合成能力可用，
  不等于应用内「收到回复 → 选路 → 播放」全链已验收；Windows 安装包报告中的共享 Dart
  逻辑修复仍只由宿主测试覆盖。
- 本轮没有把「构建通过」扩大为「alpha.15 报告所有 Windows 缺陷已验收」；逐项状态仍以上文表格为准。

## 追加：2026-11-24 WebView2 参数解码根因与验证

### 根因

- Windows 的 Flutter 3.50 embedder 没有可用的 HWND PlatformView 工厂，Dart 侧用独立宿主通道 `ondra/webview/host/create` 创建原生视图。Dart shim 把 `creationParams` 经 `StandardMessageCodec` 编成 `Uint8List`，放在 `params` 字段中。
- 原生 `OndraWebViewHost::create` 之前只查 `args` 顶层的 `url` / `allowedSites`，从不解码 `params`，于是 `View` 收到空初始 URL 与空白名单。这解释了「网页浏览页能打开，但没有请求发出、页面不加载」的现象。
- 同时发现 `FlutterDesktopRegistrarGetTextureRegistrar` 的调用没有先检查 `GetRegistrarForPlugin` 返回值；虽然当前 Flutter 返回非空，缺少空值保护会把 registrar 失败变成崩溃风险。

### 修复

- `windows/runner/web_view_win.cpp`：宿主 `create` 先识别 `params` 中的 `Uint8List`，用 `flutter::StandardMessageCodec` 解码后再交给 `View`；缺少或非法参数返回明确 `bad-args`，并补充对应头文件。
- `windows/runner/flutter_window.cpp`：调用 `FlutterDesktopRegistrarGetTextureRegistrar` 前先判空 registrar；为空时仍占用同一方法通道，返回明确的 `webview-unavailable` 错误。
- 这两处是原地最小修复，不改动 Dart 的创建协议，也不放宽白名单规则。

### 回归与实机验证

- 宿主 `git diff --check` 通过；`flutter analyze` 为 `No issues found!`；完整 `flutter test --reporter compact` 为 `537 passed / 3 skipped`。
- 来宾机重新执行 `flutter build windows --debug --no-pub` 成功，产物为 `build\windows\x64\runner\Debug\ondra.exe`。
- 用 `ONDRA_BROWSER_URL=http://10.211.55.2:8766/` + `ONDRA_PAGE=browser` 从命令行启动可见窗口；宿主机 HTTP 日志出现一次 `GET /` 200，证明实现已从原生 WebView2 实际发起页面请求，而不是只显示本地占位。
- 截图确认外层窗口仍是「空谷 Ondra」，没有隐藏窗口；来宾机反复重建的 Parallels Tools 终端遮住了中部区域，不能据此把中间内容判成产品黑屏。可确认的边界是 HTTP 请求已经发出，像素上屏仍未在无遮挡条件下逐字读到 `WEBVIEW2_OK`。

### 尚未验收

- HTTPS→HTTP 降级拒绝、规则改变后 stop/rebuild 尚未在这一轮用可见页面逐项执行；本轮只完成了
  同源内重定向与 `_blank` 请求日志级验收，没有把无遮挡页面文字或错误提示写成已逐字确认。
- VC++ DLL 打包、登录项重启、第二台 Windows 实体机仍无新证据。
- 本轮没有提交、推送或清理工作区改动。

## 追加：2026-11-24 第二轮 mac/Android 同源复核

> 用户随后要求依据本报告逐项复查仍存在的 bug，已修复的直接跳过；macOS 与
> Android 有相同缺陷时一并原地修复，并补回归测试与文档。不使用 PD / 蓝叠，
> Android 只做代码级与本机编译器检查，不声称真机验收。

### 复核范围与跳过项

- 逐项对照报告的 30 余项缺陷与工作区/上游提交：共用 Dart 逻辑（人设路径、
  GBK 解码、凭据 YAML、权限提示、英文导航、字体、历史、备份、状态统计、
  聊天断线、Markdown/JSON 记忆、清空与导出、内核关停等）已在 `03e9bb6` /
  `e812077` 及此前提交修复，既有测试覆盖；本轮不重复修改。
- 上一轮 Windows 构建链、WebView2 参数解码、像素缓冲与可见启动证据已归档，
  本轮不重跑 Windows 虚拟机验收。
- macOS `OndraBrowserOrigin` 的 IPv6 疑点已用本机 Swift 6.4 / macOS SDK
  编译并运行 `URLComponents` 探针验证：`https://[::1]/` 与
  `http://[2001:db8::1]:8080/x` 的 `host` 均保留方括号，当前正则不会误判；
  编码 host、凭据、模糊数字 IP 与端口 0 仍被拒绝。因此不改 macOS 原生代码。

### 本轮修复

- `browser_page.dart`：把「仅支持 macOS」和「macOS 使用系统 WebKit」
  的过时文案改为中性描述，避免 Windows/Android 已支持内嵌浏览器后仍向用户
  报错。新增 `test/browser_page_copy_test.dart`，渲染白名单页断言旧文案消失、
  页面能正常构建。
- `OndraWebView.kt`：Android origin 校验从只检查空白/userInfo/scheme/host，
  收紧为与 Dart `BrowserClient._webUri` / macOS `OndraBrowserOrigin` 同源：
  原始 authority 拒绝 `@`/`%`，拒绝控制字符，host 按 label、IPv6 与点分
  十进制格式校验，长度/端口范围一致。`requiresHTTPS` 从 `val` 改为 `var`，
  导航放行 HTTPS 后持续锁定 HTTP；`onPageFinished` 也补上状态升级，避免
  初始 HTTP → HTTPS → HTTP 的降级绕过。
- `web_view.dart` 与浏览器 README 更新过时注释与平台说明。

### 验证

- `flutter test test/browser_page_copy_test.dart --reporter compact`：1/1 通过。
- Kotlin 源码用临时 API stub + Kotlin 2.1.20 编译器完成 JVM 17 语法检查，0 error。
  这只证明语法与调用形状，不代表 Android 真机 WebView 行为已验收。
- Swift origin 规则用独立探针编译运行，候选合法/非法样例结果符合 Dart 侧规则。
- 全量 Dart 门禁：`flutter analyze` 为 `No issues found!`；`flutter test
  --reporter compact` 为 539 passed / 3 skipped；`test/browser_client_test.dart`
  为 17/17 通过。`git diff --check` 通过。

### 边界

- Android 未使用蓝叠或真机，未做 APK 构建与页面加载实测；Kotlin 只能在
  本机做语法级检查，原生 WebView 的导航回调顺序仍需 Android CI/真机验收。
- macOS 原生代码本轮没有功能改动；Swift 探针不是 RunnerTests 集成测试。

### 追加：越界导航与 `_blank` 拦截（2026-11-24）

- 用一次性白名单只保留 `http://10.211.55.2:8766/`，把宿主服务换成
  `/redirect.html`（500ms 后跳到 8767 的 `/forbidden`）和
  `/blank.html`（500ms 后 `window.open(...'_blank')`），8767 单独记录请求。
- `ONDRA_BROWSER_URL=http://10.211.55.2:8766/redirect.html` 启动可见客户端后，
  8766 日志仅出现 `GET /redirect.html 200`，8767 日志始终为空；导航停留在
  白名单内，没有产生越界请求。由于来宾机的 Parallels Tools 终端持续抢占前台，
  截图不能作为「拒绝提示可读」的证据；这里只以服务端请求日志为结论。
- `window.open` 场景同样可以在原生侧走 `NewWindowRequested` 处理器；其准入逻辑
  与 `FrameNavigationStarting` 共用 `Permit()`，不另开外部浏览器。未把 8767
  请求数保持为 0 扩大成 UI 提示已逐字验收。
- 后续在命令行里追加核对：`ONDRA_BROWSER_URL=http://10.211.55.2:8766/blank.html`
  配合 `ONDRA_BROWSER_ADD=1` 启动可见 Debug 客户端后，8766 与 8767 的独立 HTTP
  日志都没有新的越界请求；来宾机的全局启动项仍反复抢占前台，截图无法逐字读出
  `BLANK_FIXTURE`，所以只保留「没有向未白名单端口发请求」这一结论。
- HTTPS→HTTP 降级用另一组 fixture 做了补验（见下节）；第二台实体机仍未做同类日志级验收。

### 追加：HTTPS→HTTP 降级拒绝（2026-11-24）

- 宿主机生成仅用于本次测试的自签证书（CN/SAN 均为 `10.211.55.2`），在 8443 端口提供
  `downgrade.html`：页面先显示 `HTTPS_FIXTURE_OK`，随后脚本跳到已加入白名单的
  `http://10.211.55.2:8767/forbidden`。来宾机白名单临时只包含这两个 origin。
- 用 `ONDRA_BROWSER_URL=https://10.211.55.2:8443/downgrade.html` 启动可见 Debug 客户端：
  8443 日志出现 `GET /downgrade.html 200`，8767 日志始终为空，说明从 HTTPS 页面向
  HTTP 的跳转被原生 `Permit()` 拦下，未发出网络请求。`requires_https_` 的锁定行为
  与原生白名单规则一致。
- 自签证书没有被导入来宾机根证书库；Windows 安全中心弹出了证书信任警告，所以这次只
  得到「初始 HTTPS 请求已发出、降级目标未请求」的日志证据，不能把 WebView2 页面文字
  或应用内错误提示写成已逐字验收。收尾已关闭测试进程、三个 fixture 服务，并恢复
  来宾机与宿主机的原白名单文件；没有隐藏任何窗口。

### 追加：命令行调试启动幂等性（2026-11-24）

- `_applyBrowserDebugLaunch()` 原先无条件对调试 URL 调 `add()`，再把返回值当提示，
  但仍调用 `open()`；该逻辑在白名单中已有同一 URL 时会写出一条无意义提示，
  且 `ONDRA_BROWSER_URL` 指向不合法/未授权地址时只在 GUI 页面上报错，命令行
  看不到失败原因。现改为先检查 `allowed(url)`，只在缺失时加入；任何 `open()`
  错误额外通过 `debugPrint` 输出到启动日志。对真实用户路径无影响。
- 回归测试补充了「已有白名单地址仍打开」和「历史遗留的无尾斜杠规则仍按
  origin 命中」两个场景，确保调试入口不会回到只显示白名单列表的行为。
- 用最新 Debug 产物在来宾机分别以 `ONDRA_BROWSER_URL=http://10.211.55.2:8766/`
  与加上 `ONDRA_BROWSER_ADD=1` 两种方式启动，窗口均保持可见，白名单文件未被
  额外写入；这说明已有规则不再被重复 `add()`。该轮没有观察到新的宿主机 HTTP
  请求，与早前同一 URL 已成功发出 `GET /` 的证据并列保留，不把进程存活扩大成
  第二次像素导航已重新验收。
- 收尾时只停止了本轮启动的可见测试进程和宿主机 8766/8767 fixture 服务，没有
  隐藏任何窗口，也没有触碰仍由来宾机系统持有的两条 session 0 进程。

### 最终构建状态

- 命令行调试幂等性修复同步到 `C:\OndraBuild` 后，来宾机再次执行
  `flutter build windows --debug --no-pub`，输出 `Built build\windows\x64\runner\Debug\ondra.exe`，
  退出码 0；这是当前源码对应的最新 Debug 产物。
- Release 构建无法在同一来宾机完成链接：两条 session 0 的 `ondra.exe` 仍持有 `Release\ondra.exe`，普通 `Stop-Process` 被拒绝，`taskkill /F /T` 也返回「拒绝访问」；因此 `LNK1104` 是环境锁文件，不是源码编译错误。上一轮在同等源码复杂度下已成功产出 Release EXE；这一轮不把它写成已重新验收。
- 宿主最终门禁同步重跑：`flutter analyze` 为 `No issues found!`，完整 `flutter test --reporter compact` 为 `538 passed / 3 skipped`，`git diff --check` 通过。

### 追加：隔离目录的完整 Release 与 VC++ DLL 打包复核（2026-11-24）

- 为绕开两条 session 0 进程对旧 `C:\OndraBuild\...\Release\ondra.exe` 的占用，在来宾机用 `robocopy`
  建立不含 `.git`、`build`、生成的插件标记和 pub 缓存的隔离源码树 `C:\OndraReleaseRebuild`。
  宿主先核对 `windows/CMakeLists.txt` 临时探针后再恢复，来宾机中的文件 SHA-256 为
  `b658bfd54a9a3ea0847aebdee61714e5a352125891a94a44ebb62dd381e321cd`，与宿主一致。
- 隔离树内全新 `flutter pub get` 成功，随后 `ONDRA_ALLOW_NO_RUNTIME=1 flutter build windows --release --no-pub`
  在 82.7 秒内成功产出 `C:\OndraReleaseRebuild\build\windows\x64\runner\Release\ondra.exe`
  （208,384 字节）、`flutter_windows.dll`（21,332,480 字节）、`data\app.so` 与 `data\flutter_assets`。
  EXE 版本信息为 `3.0.0-alpha+15`。这证明当前源码和 WebView2 原生修复可完成 Release 链接；
  但这次仍显式跳过运行时，不能当作完整发布包证据。
- 手动从来宾 `C:\Windows\System32` 复制 `MSVCP140.dll`（1,372,216 字节）、
  `VCRUNTIME140.dll`（199,200 字节）和 `VCRUNTIME140_1.dll`（53,320 字节）到 Release 目录，
  用 `Compress-Archive` 生成 `C:\Users\ntars\Downloads\Ondra-audit-release-rebuild.zip`
  （13,964,054 字节）。ZIP 清单核对到 `ondra.exe`、`flutter_windows.dll`、三个 VC++ DLL、
  `data\app.so` 与 `data\icudtl.dat`；这样补齐了此前报告里「ZIP 根目录 DLL 打包」的本地证据。
- 用 `ONDRA_SETTINGS=1`、`ONDRA_PAGE=browser`、`ONDRA_BROWSER_URL=http://127.0.0.1:8765/`、
  `ONDRA_BROWSER_ADD=1` 从命令行启动隔离 Release EXE，进程持续存活且窗口标题为「空谷 Ondra」，
  没有隐藏窗口；结束前只关闭了这次启动的可见测试进程，未触碰 session 0 残留。
- 证据边界：该 ZIP 是按发布流程补齐 VC++ DLL 的审计重建包，**不含**
  `runtime/windows-x64/node.exe`、`sqlite3.exe` 和 `dsh/lib/bin.js`，因此它验证的是原生 runner、
  链接和 DLL 打包，不证明内核握手、SQLite 或完整安装可用。完整发布需要不带
  `ONDRA_ALLOW_NO_RUNTIME` 再构建，并补上第二台缺 VC++ 运行库的实体 Windows 电脑验收。

### 追加：完整 Windows Release 包装配链修复（2026-11-24）

上面那个不含运行时的审计包只用于绕开 EXE 文件锁。随后在隔离树里补齐了
`runtime/windows-x64` 的真实装配，并因此定位到三个会卡住「完整发布包」的根因：

1. **Node 版本与内核不兼容**：`DSH_VERSION=0.2.2-rc.1` 的包声明 `engines.node >=24.9.0`，
   但 `release.yml` 的 Windows/macOS/Android 三个 job 都用 `setup-node` 装 Node 22。
   在来宾机上用 Node 22 装配后，`dsh` 启动无任何 stdout/stderr，握手自检 12 秒超时；
   换成官方 Node 24.22.3 后 `--help` 与手工 `initialize` 都正常。
   `release.yml` 已把三处 `node-version` 改成 `24`，`tool/assemble_runtime.mjs` 的顶部说明
   也同步改成 Node 24.9+。
2. **握手自检写 stdin 的时序**：`handshake()` 在 `spawn` 后立即 `write/end`，在来宾机上
   首次装配时请求早于内核监听器就绪，自检固定超时；手工调相同产物则拿到
   `{"result":{"serverInfo":...}}`。改为短延时后在 `write` 回调里 `end`，并去掉
   `windowsHide: true`：用户明确要求命令行调试时不要隐藏窗口，自检子进程也不该偷偷隐藏。
3. **Windows on ARM 构建机找错运行时目录**：`windows/CMakeLists.txt` 曾按
   `CMAKE_SYSTEM_PROCESSOR=ARM64` 把包名改成 `windows-arm64`，而 x64 runner 产物和发布包仍叫
   `windows-x64`。在 Parallels Apple Silicon 来宾机里，即使装配出 169.4 MB 的
   `runtime/windows-x64`，Release 构建仍 FATAL 说缺 `windows-arm64`。现在固定查找
   `runtime/windows-x64`，不再按构建机 CPU 改发布目标。

修复后的来宾机证据：

- 用 Node 24.22.3 与 `@deepseek-ai/dsh@0.2.2-rc.1` 重跑 `tool/assemble_runtime.mjs`：
  闭包 250 包、6,040 个文件，`node.exe` 89.6 MB、`dsh` 71.2 MB、`profile` 4.5 MB、
  `sqlite3.exe` 4.1 MB（sqlite.org 校验通过），自检输出「真握手成功，全部插件 import 通过」，
  `node-pty`、`koffi` 原生模块均可加载，退出码 0。
- 不设 `ONDRA_ALLOW_NO_RUNTIME` 执行 `flutter build windows --release --no-pub`：
  81.6 秒后输出 `Built build\windows\x64\runner\Release\ondra.exe`，退出码 0。
  产物内 `runtime/windows-x64/node.exe`、`sqlite3.exe`、`dsh/lib/bin.js`、`profile/cordis.yml` 均存在。
- 复制三个 VC++ DLL 后，PowerShell 5.1 的 `Compress-Archive` 因仓库旧时间戳报
  `无法将 DateTimeOffset 转换为 Zip 文件时间` 并留下 0 字节文件。新增
  `tool/zip_windows_release.mjs`，用 Node 自带 zlib 写固定 DOS 时间；生成
  `Ondra-audit-release-full.zip`，7,809 个文件、156,129,064 字节。ZIP 清单核对到 EXE、
  Flutter DLL、三个 VC++ DLL、`data/app.so`、Node、SQLite、内核入口和 profile。`release.yml`
  的 Package 步骤已改用该工具。
- 用完整 Release 目录里的 EXE 从命令行启动可见窗口，进程存活，标题为「空谷 Ondra」；
  `~/.ondra/logs/transport.log` 追加了 `launch: ...\runtime\windows-x64\node.exe ...\dsh\lib\bin.js`
  和 `process started, pid=7260; sending initialize`，不再退回裸 `dsh` 并报「系统找不到指定的文件」。
  这证明完整包的应用层已找到随包内核；没有把「已发出 initialize」扩大成插件回复或模型请求已验收。
- 仍未完成：第二台缺 VC++ 运行库的实体 Windows 电脑安装、登录项重启、真实模型一轮回复、
  WebView2 像素上屏的无遮挡逐字确认。本轮没有提交、推送或清理用户工作区改动。
