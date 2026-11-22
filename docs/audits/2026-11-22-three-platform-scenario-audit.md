# 2026-11-22 三端普通用户场景审计

> 范围：桌面（macOS / Windows 共享 Dart 与内核）、Web、Android；以普通用户路径复核首启、设置、会话、记忆、人设、历史、导入导出与恢复。测试使用临时目录，不读写真实用户数据。用户原始描述中的「用户信息录入 / 体检报告 / 体检数据查询」在本仓库中不存在，按实际核心场景审计；详见末尾范围说明。

## 已验证

- `flutter analyze` 零问题；`flutter test --reporter compact` 全量通过：496 passed、3 skipped（3 项 sidecar 真机测试因默认 PATH 没有 `dsh` 而跳过）。
- 指定真实内核时 `ONDRA_DSH_BIN='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' ONDRA_DSH_HOME=<临时目录> flutter test test/dsh_sidecar_test.dart` 三项全通过，覆盖 initialize、ChatClient 在线态、经 magpie 的正文与 usage。
- Web release 构建后由 `tool/browser_smoke.mjs` 验证：onboarding、10 个导航页、4 个设置页、运行时异常 0；脚本使用 `--no-proxy-server` 绕开本机代理对 `127.0.0.1` 的干扰。
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

### 同步脚本副作用清理

- `tool/sync_plugin_profile.mjs` 曾按空的 `dependencies` 把快照 metadata 清成 0 个包，并删除插件依赖目录；已修正为从既有 `x-ondra-snapshot.order` 恢复包清单，并把 compatibility 推导纳入同步。重新同步后 605 个文件、79 个插件包，`--check` 零差异。

## 未能判定的风险

- Web 端 `prefs` 只活在当前页面生命周期；刷新后引导与设置回到默认，这是现有设计边界，需产品确认是否接受。
- Android 端依赖随包 Node/Dsh 闭包解压成功，且需要真机握手；本轮无 Android SDK/设备，无法验收。
- macOS 构建受本机环境阻塞：Xcode 不完整 / CocoaPods 未安装；`flutter build macos` 未能产出可验收包。工作区中的 Xcode 工程与 Podfile.lock 改动无法在同一环境完成编译验证。
- Android toolchain 不完整：`cmdline-tools component is missing`；`adb` 存在，但没有完整 SDK / 真机验收。
- 本仓库不存在「用户信息录入 / 体检报告生成 / 体检数据查询」这三个具体功能，因此无法按字面进行普通用户场景测试；审计对象改为实际存在的模型密钥、会话、记忆、人设、历史、导入导出、备份恢复、插件装配与三端启动链路。
