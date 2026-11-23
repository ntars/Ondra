# 2026-11-22 三端普通用户场景审计

> 范围：桌面（macOS / Windows 共享 Dart 与内核）、Web、Android；以普通用户路径复核首启、设置、会话、记忆、人设、历史、导入导出与恢复。测试使用临时目录，不读写真实用户数据。用户原始描述中的「用户信息录入 / 体检报告 / 体检数据查询」在本仓库中不存在，按实际核心场景审计；详见末尾范围说明。

## 已验证

- `flutter analyze` 零问题；`flutter test --reporter compact` 全量通过：496 passed、3 skipped（3 项 sidecar 真机测试因默认 PATH 没有 `dsh` 而跳过）。
- 指定真实内核时 `ONDRA_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' ONDRA_DSH_HOME=<临时目录> flutter test test/dsh_sidecar_test.dart` 三项全通过，覆盖 initialize、ChatClient 在线态、经 magpie 的正文与 usage。
- Web release 构建后由 `tool/browser_smoke.mjs` 验证：onboarding、10 个导航页、4 个设置页、刷新后偏好回读、运行时异常 0；脚本使用 `--no-proxy-server` 绕开本机代理对 `127.0.0.1` 的干扰。
- 内核集成测试 `node --test test/plugin_profile_integration_test.mjs`：过滤器/请求链 6 项全通过；`organ gate` 用例因 `NODE_PATH` 中的 dsh-tools 版本错配（`tools.resolve` API 差异）失败，不是产品路径；基线提交在相同环境下同失败。
- `node tool/sync_plugin_profile.mjs --check` 与 `tool/assemble_runtime.mjs` 自检全绿：79 个插件包、真握手、node-pty、koffi 可加载。

## 本轮发现与处置

### BUG-20261122-01：凭据文件写入会破坏内核授权记录（已修复，当前工作区）

- 复现：1) 让内核在 `$DSH_HOME/.credentials.yaml` 写入 `records:` 授权记录；2) 在模型基座页保存任意模型密钥；3) 重新读取该文件。
- 现象：`records:` 整段消失，客户端登录态丢失，两侧都不报错。
- 根因：旧 `Keychain._writeRefs` 只解析 `refs:` 段，然后以 `version: 1\nrefs:\n...` 整份重写文件，把同一文档里的 `records:` 段当成无关内容覆盖。
- 修复：`lib/app/keychain_io.dart` 改为整份读取、只替换 `refs:` 到下一个顶层键之间的字节；`records:` 与注释原样保留；引用名校验拒绝含点号的旧键名。补 `test/keychain_credentials_test.dart` 覆盖保留 records、插入 refs、删最后一个 ref、引号往返、POSIX 键名、反向段落顺序与定向删除。
- 验证：`flutter test test/keychain_credentials_test.dart` 通过；全量 Flutter 测试也覆盖该用例。

### BUG-20261122-02：模型密钥引用名与内核解析名不一致（已修复，当前工作区）

- 复现：1) 在模型基座页为 DeepSeek 保存密钥；2) 查看写入 `.credentials.yaml` 的键名；3) 让内核按 provider 的 `apiKeyEnv` 解析凭据。
- 现象：旧实现写入 `provider.deepseek.key`；官方凭据解析器只接受 POSIX 标识符（含点号会拒收整份文件），内核按 `DEEPSEEK_API_KEY` 也永远读不到。
- 根因：UI 存储键名与内核 `apiKeyEnv` 是两套命名；官方 `dsh-credentials-local` 与 UI 之前各自造约定。
- 修复：`lib/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart` 统一以 `apiKeyEnv` 为引用名；旧键名通过 `Keychain.readLegacy` 从旧存储一次性读出，避免把含点号的旧键写回官方凭据文件；删除提供商时同时清理新旧引用。`test/model_client_test.dart` 增加引用名同源、POSIX 形状与旧密钥迁移断言。
- 验证：`flutter test test/model_client_test.dart` 通过；全量 Flutter 测试也覆盖该用例。

### BUG-20261122-03：设置「待内核重载」标记永不消解（已修复，当前工作区）

- 复现：1) 修改任一需要重启的设置；2) 内核随后成功连接；3) 再修改一次。
- 现象：设置页永久显示「有配置待内核重载」，每改一次多积一条。
- 根因：`settingsClient.markKernelApplied` 在 `lib/` 中没有调用点，只有测试调用；写入配置时标 `restartRequired`，成功重连后无人消解。
- 修复：`lib/main.dart` 在重连前 `captureKernelConfiguration()`，仅在 `chat.connected` 后 `markKernelApplied(...)`；失败重连保留标记。`test/model_client_test.dart` 增加成功/失败两条路径。
- 验证：`flutter test test/model_client_test.dart` 通过；全量 Flutter 测试也覆盖该用例。

### BUG-20261122-04：内核装配层引用了凭据插件，但快照里没有这个包（已修复）

- 复现：用 `plugin-profile/cordis.patch.yml` 的装载器加载 `ondra-credentials`；`ctx.get('credentials')` 为 undefined，模型密钥即使写进 `.credentials.yaml` 也不会被内核解析。
- 现象：插件服务静默缺席；UI 只显示「缺少密钥」，没有装配错误。集成测试中凭据服务用例失败。
- 根因：`cordis.patch.yml` 与 `package.json` 已经声明 `@ondra/cordis-plugin-ondra-credentials`，但 `plugin-profile/node_modules/@ondra/` 中没有该包，且官方依赖 `@deepseek-ai/dsh-credentials-local` 也不在快照里。出口包因此不具备凭据解析能力。
- 修复：从本机清理备份中恢复该插件包，并把 `dsh-credentials-local` 及其运行依赖补入快照；同步更新三个 profile 副本。测试夹具增加「快照已有依赖目录时不再建立冲突 symlink」保护。
- 验证：在临时 HOME 与真实 loader 路径下运行 `node --test test/plugin_profile_integration_test.mjs`，凭据服务用例 `credentials service really reads the store and keeps records` 通过；能读到 file 中的 ref，并保留 `records:`。

### BUG-20261123-05：Web 首屏白屏（已修复）

- 复现：1) `flutter build web --release`；2) `python3 -m http.server 8765 --directory build/web`；3) 浏览器打开 `http://127.0.0.1:8765`。
- 现象：进入页面后整页空白，无导航和设置内容。
- 根因：`lib/app/home_dir.dart` 无条件 `import 'dart:io'`，Web 调用 `ondraUserHome` 时触发 `Unsupported operation: Platform._operatingSystem`，异常冒泡到应用根导致首屏崩溃。
- 修复：拆成 `lib/app/home_dir.dart` 条件导出 + `home_dir_io.dart` + `home_dir_stub.dart`；Web 返回稳定的虚拟 home，桌面保持原有目录规则。
- 验证：Web smoke 通过，onboarding、导航页、设置页均可操作，运行时异常 0。

### BUG-20261123-06：全新 profile 内核启动失败（已修复）

- 复现：1) 全新 HOME 第一次启动；2) 运行时把 `plugin-profile` 铺到 `~/.ondra/dsh/profiles/ondra`；3) `initialize` 握手。
- 现象：`sdk-jsonrpc-server did not activate`，agent loop 未注册，聊天链路不可用。
- 根因：随包 dsh 是 `0.2.1-rc.3`，插件 peer 声明 `0.2.2-rc.1`；没有 profile-local `compatibility.json` 时 dsh 禁用 session/agent 相关行。此前该文件只存在于本机 profile，未随快照出口。
- 修复：`tool/sync_plugin_profile.mjs` 把 `compatibility.json` 纳入快照，并在源缺失时按插件 manifest 推导精确版本豁免；重建 18 条豁免并重新装配运行时。
- 验证：`bundled_kernel_test.dart`、`runtime_model_kernel_test.dart` 与 `tool/assemble_runtime.mjs` 自检全绿；干净临时 DSH_HOME 下 sidecar 三项全通过。

### BUG-20261123-07：sidecar 测试对 `dsh` 的可用性判定与启动不一致（已修复）

- 复现：1) 默认 PATH 中无 `dsh`；2) 运行 `flutter test test/dsh_sidecar_test.dart`。
- 现象：`which` 在 shell 中报告可用，但 `Process.start` 因相对命令查找失败而抛 `ProcessException`；测试标红而不是跳过。
- 根因：`dshAvailable()` 只检查 `which` 的退出码，transport 实际拿到的是未经解析的相对命令名；`markTestSkipped` 后测试体仍继续往下执行。
- 修复：测试先解析可执行文件的绝对路径并交给 transport，`which` 找到的路径必须在当前进程可访问；跳过分支立即 `return`。
- 验证：默认环境 3 项全部 skipped；配置真实内核后 3 项全部 passed。

### 已排除：输出过滤链「假失败」

- 早期 10 项内核集成测试中有多项 filter-chain 用例失败（`filter.stats().runs === 0`）。
- 根因：测试与插件分别从随包 dsh 和 `NODE_PATH` 中的另一份 dsh 实例解析 `@deepseek-ai/dsh-llm`；`markAgentLoopRequest` 使用进程局部 WeakSet，两份模块副本互不认标记，于是过滤器认为请求不是 agent-loop 发出的。
- 处置：统一测试与插件的依赖副本，不再用与本轮生产版本不一致的 `NODE_PATH` 覆盖。修正后 filter-chain、review-limit、agent-loop 等用例均通过；剩余 `organ gate` 失败可在使用随包 0.2.1-rc.3 依赖时消失，仍属于测试夹具版本问题。

### BUG-20261123-08：Android 品牌开屏后内核初始化失败（已修复）

- 复现：1) 安装构建出的 arm64 APK；2) 打开应用并点「开始使用」；3) 进入聊天页观察横幅，或手动从 APK 内解压闭包并启动 `libnode.so lib/bin.js --profile ondra`。
- 现象：品牌开屏与引导不再卡死，但内核退出码 1，页面横幅只显示 `Bad state: 内核进程已退出（exit 1）：Node.js v26.13.1`。
- 根因：这是一条串行的启动链。先有 Flutter 3.50 Impeller 在 BlueStacks 上崩溃、启动期误用 Flutter `rootBundle` 读原生 asset、Android 闭包入口路径写错、Termux 动态库的 `DT_NEEDED/SONAME` 带版本后缀、`libicudata.so` 漏打包；补齐这些后，真正的内核失败是 dsh 官方没有 Android arm64 的 `node-addon-require-builtin` 与 `node-addon-system/flock` 预编译绑定，而打包脚本又裁掉所有 `.node` 文件，于是启动报 `No usable native binding found for node-addon-require-builtin-android-arm64`。
- 修复：
  - 在 `android/app/src/main/AndroidManifest.xml` 去掉 `EnableImpeller=false`，让 Flutter 3.50 用稳定的 OpenGLES Impeller。
  - 在 `lib/app/bundled_runtime_io.dart` + `MainActivity.kt` 增加 `ondra/assets` 原生通道，从 Android AssetManager 读取 `assets/ondra-dsh.zip`；入口改为 `runtime-android/lib/bin.js`；解压后幂等给 `flock.js` 的平台白名单补上 `android`。
  - 在 `tool/pack_android_kernel.mjs` / `patch_android_needed.py` 打包 `libicudata.so`，统一改短 `DT_NEEDED` 与 `DT_SONAME`，让 bionic linker 能在 APK 原生库目录解析依赖。
  - 新增 `tool/build_android_addons.sh`：从上游源码与 Node 26.13.1 头文件用 Android NDK 交叉编译 `node-addon-require-builtin`（`napi-v9`）与 flock `system.node`（`napi-v8`），生成两个 Android arm64 平台包；打包器把它们合入闭包，修剪规则保留这两个目录。CI 在 `pack_android_kernel.mjs` 之前调用该脚本。
  - 续查又发现三处只在「覆盖安装旧版本」或 Android 无 `HOME` 时出现的后续故障：① 解压清单只认 `ondraBuild`，重建 APK 但构建号不变时沿用旧私有目录，报 `profile "ondra" does not exist`；② 种子按 `ondraUserHome` 写入，而传输层在没有 `HOME`/`USERPROFILE` 时退回当前目录，内核去 `/` 找 profile；③ 模型受管补丁要先起随包 node 子进程，未传 `LD_LIBRARY_PATH` 时静默失败，随后 initialize 报 `no adapter registered for provider "ondra-ui-magpie"`。
  - 对应修复：`lib/app/bundled_runtime_io.dart` 改为用 APK 内 `ondra-dsh.zip` 的 SHA-256 作为解压指纹，并校验几个入口文件，缺失或旧清单都整体重铺；`stdio_transport_io.dart` 在 Android 上让 `DSH_HOME` 与 `ondraUserHome` 同源，并给模型补丁子进程传 `LD_LIBRARY_PATH`；stderr 尾窗仍保留，便于展示真实错误而不是 Node 版本横幅。新增 `crypto` 直接依赖。
- 验证：APK 中的 `getBindingInfo()` 返回 `product=require-builtin, abi=napi-v9, platformPackageSuffix=android-arm64`；`requireBuiltin('internal/modules/esm/loader')` 可执行；设备 shell 下用同一份 zip 与 `libnode.so` 启动 dsh 已进入插件装配阶段。最终重建安装后，BlueStacks 上品牌开屏、引导、聊天界面连续通过，聊天页不再出现 `profile does not exist` 或 `no adapter registered` 横幅，说明 initialize 握手已成功越过这两处失败点。`flutter analyze` 零问题；`flutter test --reporter compact` 496 passed、3 skipped；Web smoke 21 项全通过、运行时异常 0；`sync_plugin_profile.mjs --check` 零差异。
- 余项：BlueStacks 应用私有目录无 root 权限，无法直接读取设备内 `transport.log` 中的完整 initialize 指纹；聊天页无错误横幅与在线状态足以确认握手成功，但逐条 JSON-RPC trace 仍需在可 root 设备或应用内日志导出后复验。

### 同步脚本副作用清理

- `tool/sync_plugin_profile.mjs` 曾按空的 `dependencies` 把快照 metadata 清成 0 个包，并删除插件依赖目录；已修正为从既有 `x-ondra-snapshot.order` 恢复包清单，并把 compatibility 推导纳入同步。重新同步后 605 个文件、79 个插件包，`--check` 零差异。

## 未能判定的风险

- Web 偏好已持久化到 `localStorage`（键前缀 `ondra:pref:`）；`tool/browser_smoke.mjs` 现已断言首启写入 `ondra:pref:onboardingDone`（受 Dart `SharedPreferences` 编码影响，值为 `1` 或 `true`），刷新后欢迎页不再出现。浏览器隐私模式/禁用存储时仍会退回默认值，属于能力边界。
- Android 端已在 BlueStacks（`127.0.0.1:5555`）验收品牌开屏、引导与聊天界面，最终构建不再出现 profile 缺失或 provider 适配器缺失横幅。用 `adb reverse tcp:3425 tcp:3425` 把宿主机 Magpie 网关映射到模拟器回环地址后，普通用户输入 `android` 并发送，已收到真实模型回复（最终重打包后再验一次：截图 `/tmp/ondra-audit/android-final-reply.png`，真实模型回复“Could you please provide a bit more detail about what you’re looking for regarding "android"?”，usage 显示 842 token、42 token/s；先前的同路径验证截图为 `/tmp/ondra-audit/android-chat-reverse.png`（725 token、27 token/s））；再从「历史对话」打开同一会话，用户消息与助手回复均可完整回读（重打包后截图：`/tmp/ondra-audit/android-history-open-final.png`；先前截图：`/tmp/ondra-audit/android-history-open.png`）。本轮所有代码改动后再次执行 `flutter build apk --release`、重新安装、真实问答与历史回读，截图分别为 `/tmp/ondra-audit/android-final-chat-after-retest.png` 与 `/tmp/ondra-audit/android-final-history-open-after-retest.png`（677 token、17 token/s）。这确认 Android 的 provider/profile 注册、initialize 握手、prompt 选路、session 事件与历史持久化整条主链路可用。应用私有目录内的完整 initialize JSON-RPC trace 仍需可 root 设备或应用内日志导出后才能直接读取。

### BUG-20261123-09：Android 默认模型指向宿主机回环地址，离机不可达（环境限制，非代码缺陷）

- 复现：1) 在 BlueStacks 内打开原始构建；2) 用默认 Magpie 网关 `http://127.0.0.1:3425/v1` 发消息。
- 现象：`Bad state: Connection error.: connect ECONNREFUSED 127.0.0.1:3425 (TRANSPORT)`。
- 根因：Magpie 是 macOS 本机应用，默认只监听宿主机 `127.0.0.1:3425`；Android 模拟器/真机的 `127.0.0.1` 指设备自身。桌面/Web 上下文下这个默认值正确，移动端默认配置跨设备不成立。
- 处置：这是产品/部署边界，不应把宿主机地址硬编码进移动端默认值，也不应在本轮通过回退配置掩盖。验收时用 `adb reverse tcp:3425 tcp:3425` 建立临时调试隧道，保留原默认配置不变；实际移动端部署应把地址改为设备可达的网关。文档需明确该限制。

### BUG-20261123-10：Android「系统日志」为空，但聊天日志确有数据（待产品口径确认）

- 复现：1) 完成一轮真实聊天；2) 从抽屉进入「系统日志」；3) 点「刷新」。
- 现象：页面显示「没有匹配的日志」，副标仍是「宿主运行状态与本地存储」。
- 根因：`lib/plugins/ondra-core/ondra-ui/ondra-logs/ui/log_source_io.dart` 中系统日志仅读 `window.log`，而 Android 宿主未写窗口事件；传输层错误/用量写在 `transport.log`，已有独立的「对话日志」页承载。两页不重复展示同一条记录是当前刻意设计，不是实现报错。
- 处置：不做重复灌入；若产品期望移动端看到启动/装配状态，应在后续明确系统日志来源契约并补对应写入，而不只是把 `transport.log` 再挂一份到系统页。本轮通过「对话日志」页与实际会话持久化验证日志链路。

### BUG-20261123-11：Windows VM 中网关地址写死为回环，且 gateway 被误判为远端模型（已修复）

- 复现：1) 在 Parallels Windows 11 里把 Magpie 地址改为宿主机可达的 `http://10.211.55.2:3425/v1`；2) 重启 Ondra；3) 观察聊天页与 `transport.log`。
- 现象：即使配置文件已经非回环，仍报 `当前远端模型缺少密钥：请填写钥匙串密钥或 MAGPIE_API_KEY`；内核只能带着不生效的配置启动，聊天不可用。
- 根因：两处代码假设叠加。内置 Magpie 默认地址只有 `http://127.0.0.1:3425/v1`，VM/容器里设备的回环不是宿主机；`RuntimeModelConfig.resolveEnvironment` 只按「是否 loopback」判定是否允许无密钥，把 `category=gateway` 的本地代理误判为远端模型。
- 修复：`lib/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/model_client.dart` 为内置 Magpie 增加 `ONDRA_MAGPIE_BASE_URL` 启动环境覆盖（已有 `models.json` 优先，不被覆盖）；`runtime_model_config.dart` 的快照携带 `providerCategory`，`resolveEnvironment` 允许 gateway 非回环无密钥占位，remote/local/partner 仍要求显式密钥。`test/model_client_test.dart` 增加非回环 gateway 与仍拒绝的远端类别断言。
- 修复后续：Web smoke 捕获到新回归——`model_client.dart` 直接调用 `Platform.environment`，在浏览器首帧构造 `ModelClient` 时抛 `Unsupported operation`，又变成白屏。新增条件导出 `lib/app/platform_env.dart`（`platform_env_io.dart` / `platform_env_stub.dart`），模型页统一改走平台安全的 `ondraPlatformEnv()`；同时让 smoke 脚本在 `flutter clean` 后自行创建 `build/reports`。
- 验证：单元测试覆盖默认地址的环境覆盖优先级、gateway 非回环无密钥、local 远端仍拒绝；VM 中通过宿主 TCP relay（`guest 127.0.0.1:3425 -> host 192.168.10.24:3428 -> Magpie 127.0.0.1:3425`）后，聊天页显示「已接入」且不再出现缺密钥报错。`flutter analyze` 零问题、496 passed / 3 skipped；`flutter build web --release` 后 smoke 21 项全通过、运行时异常 0。Windows 正式在线问答还受下一项原生绑定限制，未计为通过。

### BUG-20261123-12：Windows 手工闭包缺少 Koffi 原生绑定（环境/构建产物限制）

- 复现：1) 使用手工复制到 VM 的 macOS 闭包启动 Windows 版；2) 完成真实发送；3) 查 `~/.ondra/logs/ondra-code.log` 中 `session-persistence: background write`。
- 现象：`Cannot find the native Koffi module; did you bundle it correctly?`；会话后台写入失败。初始化与聊天传输可建立，但该会话持久化路径不可验证。
- 根因：手工闭包中只有 macOS 的 `koffi.node`、`node-pty`、`sharp` 与后补的 Windows `require_builtin.node`，没有 Windows x64 的 Koffi 预编译绑定；这是测试用手工闭包缺件，不是 Dart 代码缺陷。
- 处置：未在工作区伪造平台二进制。验证 VM 时把 npm 官方 `@koromix/koffi-win32-x64@3.1.1` 的 `win32_x64/koffi.node` 与 `koffi.lib` 手工补到 VM 内闭包目录。重启后 `transport.log` 在 2026-11-23T06:07:01 记录 launch、06:07:02 记录 `initialize ok`，无新的 Koffi 加载错误；用 bundled Node 在 dsh 工作目录以 `NODE_PATH` 指向 `dsh/node_modules` 执行 `require('koffi')` 也返回导出对象，证明缺失绑定已补齐。正式交付仍需 `tool/assemble_runtime.mjs` 在 Windows CI 装配所有依赖的 win32-x64 native 包，并由 release 流水线校验；不把 VM 手工补件当作仓库修复。
- 在线闭环补证：不依赖被抢焦点的 GUI，在 VM 内用 bundled Node 直接启动同一份 dsh 与 `ondra` profile，先发 `initialize`、再发 `session/prompt`（`Reply with exactly AUDIT_OK.`）。`initialize` 返回 `serverInfo.name=deepseek-harness-sdk-runtime`；`prompt` 被受理并返回 `messageId`，随后收到 `session.status=running`、`turn/start`、`step/start` 事件（证据 `/tmp/ondra-audit/windb/interactive-out.txt`）。同时本机 Magpie 直接调用同一模型返回 `content: "AUDIT_OK"`（`usage.total_tokens=100`）。这证明 Windows 侧内核、profile、模型配置、会话受理与上游网关可达；助手正文没有回传到该直连审计脚本的 stdout，因此不冒充完整 UI 回复闭环。
- GUI 限制：Parallels 终端反复抢焦点导致 `prlctl capture` 只能稳定捕获桌面（例如 `/tmp/ondra-audit/windows-koffi-chat11.png`），无法用截图证明助手回复；`ondra-code.log` 在 Koffi 补齐后也没有可确认的用户消息/回复文本。因此仍不声称 Windows GUI 在线问答闭环通过。
- GUI 输入补测：用 UI Automation 确认 Ondra 窗口存在且只暴露一个 `FLUTTERVIEW` 子节点，无法通过 UIA 精确定位输入框；按窗口矩形缩放后点击右栏输入位置，粘贴 `UIA_AUDIT_OK` / `UIA_AUDIT_OK2` 并回车，脚本返回已发送，但 `transport.log` 没有新的 `session/prompt` 或发送请求，`ondra-code.log` 也没有 `memory-intake` 新增记录。当前手工闭包未随包 Koffi 的会话落盘链仍未证明可用，GUI 输入是否被 Flutter 接收无法由日志确认；这是 VM 手工闭包/图形会话验证边界，不归因为 Dart 业务代码缺陷。

- Windows：Parallels Windows 11 内使用 Flutter 3.50.1 成功完成 `flutter pub get` 与 `flutter build windows --release`（以 `ONDRA_ALLOW_NO_RUNTIME=1` 仅验证 GUI 构建），并启动 `ondra.exe`。截图 `/tmp/ondra-audit/win-app-parallels.png` 显示欢迎引导、三栏外壳、10 个导航页与右栏聊天窗，窗口尺寸约 960×600 的桌面布局正常；同时页面如实显示「未接入」，因为该构建没有随包内核。构建期在 VM 控制台会话里出现 D3D11/ANGLE 的 `SwapChain11` 报错（`0x887A0022`，Parallels 虚拟显卡限制），但进程存活、UI 正常绘制，属于虚拟机图形后端问题，不在应用代码中。
- Windows 主链路补测：把 Windows 版 Node 22.23.5、仓库 `runtime/closure` 与 macOS 闭包目录复制到 VM，重命名平台目录为 `runtime/windows-x64` 后，应用成功探测随包运行时、把 profile 种子铺到 `~/.ondra/dsh/profiles/ondra` 并启动 dsh 子进程。该手工闭包来自 macOS 构建，不含 Windows 原生插件；`transport.log` 如实显示 `node-addon-require-builtin` 的 win32 `.node` 绑定缺失，内核退出码 1 在页面显示明确错误。这说明构建产物的运行时探测、种子铺开、错误呈现三段可用。手工验证中页面状态仍是「未接入」，是内核握手前就退出的预期表现；另有一条预存的 HoYoPlay UAC 弹窗来自 VM 内第三方程序，不属于 Ondra。CI `release.yml` 已具备装配与产物校验步骤。
- Windows 原生绑定补测：从 npm 官方 `node-addon-require-builtin-win32-x64-msvc@0.1.9` 取出 `prebuilt/win32-x64-msvc-napi-v9.node`（PE32+ DLL，343552 字节），注入 VM 内的全局 native-cache 与手工闭包的 `build/napi/napi-v9-win32-x64-msvc/require_builtin.node`。重新启动应用后，`transport.log` 在 2026-11-23T03:48:41 记录 `initialize ok`，并且 dsh 子进程持续存活；随包内核握手、profile 装配与原生绑定加载在 Windows 平台路径通过验证。完整在线问答仍需 Windows CI 用 `tool/assemble_runtime.mjs` 产出含该平台绑定的正式包；本机因 Parallels 虚拟显卡与终端抢焦点导致 GUI 截图不稳定，不能据此声称完成 Windows 全量 UI 交互验收。
- Windows GUI 补测（本轮新增代码前）：在 VM 的 `C:\Users\ntars\.ondra\prefs.json` 写入 `"onboardingDone":"1"` 绕过首启引导，重启后主界面显示「已接入」，左侧导航与右栏聊天窗均正常，截图 `/tmp/ondra-audit/windows-chat-after-esc.png`、`/tmp/ondra-audit/windows-restart-chat.png`。Parallels 捕获为 2560×1600、guest 桌面约 1280×800，输入框点击坐标约 `(725, 530)`；中文 IME 会劫持 `SendKeys.SendWait('windows')` 并弹出候选框，改用 `Clipboard.SetText` + `keybd_event(CTRL/V/ENTER)` 才可稳定输入。终端窗口反复抢占焦点并导致 `prlctl capture` 偶尔全黑，使用 `SetForegroundWindow` 只能短暂恢复；这属于 VM 图形会话干扰，不是应用渲染故障。
- macOS 构建受本机环境阻塞：Xcode 不完整 / CocoaPods 未安装（`ruby 2.6`，`nap` 需要 Ruby ≥3.3）；`flutter build macos` 未能产出可验收包。工作区中的 Xcode 工程与 Podfile.lock 改动无法在同一环境完成编译验证。
- Android toolchain 已补齐到可构建：本地用 `/tmp/ondra-audit/android-sdk` + JDK 21 + Flutter 3.50 产出 `build/app/outputs/flutter-apk/app-release.apk`；`MainActivity.kt` 的 `nativeLibraryDir` 兼容分支已改为动态判断：仅在系统报告目录没有 `libnode.so`、而备用的 `lib/arm64` 目录有时才纠正，真实 arm64 设备应走报告目录，建议有真机时再确认一次。
- 本轮全部代码改动后的最终再验证：`flutter analyze` 零问题；`flutter test --reporter compact` 496 passed、3 skipped；`flutter build web --release` + Web smoke 21 项全通过、运行时异常 0；`flutter build apk --release` 产出 78.7MB 安装包，覆盖安装到 BlueStacks 后经 `adb reverse tcp:3425 tcp:3425` 发 `android`，收到 1884 token 的真实模型回复（截图 `/tmp/ondra-audit/android-final-after-code-reply.png`），「历史对话」打开同一会话可完整回读用户与两段助手消息（截图 `/tmp/ondra-audit/android-final-after-code-history-open.png`）；`node tool/sync_plugin_profile.mjs --check` 零差异；`git diff --check` 通过。
- Windows VM 临时桥清理：宿主机 relay 进程已退出，`lsof -nP -iTCP:3428 -sTCP:LISTEN` 无监听，`127.0.0.1:3425` 仍是宿主机自己的 Magpie；guest 内命令行含 `tunnel_wsforward` / `tunnel_http` 的 PowerShell 已全部停止，`Get-NetTCPConnection -LocalPort 3425 -State Listen` 无监听，`netsh interface portproxy` 为空。
- 本仓库不存在「用户信息录入 / 体检报告生成 / 体检数据查询」这三个具体功能，因此无法按字面进行普通用户场景测试；审计对象改为实际存在的模型密钥、会话、记忆、人设、历史、导入导出、备份恢复、插件装配与三端启动链路。
