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
