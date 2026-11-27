# 空谷会话内核复刻：本地验收证据

本文件只记录当前工作区的本地验收结果，不表示已发布或已推送。工作树保持脏状态。

## 环境与范围

- 工作区：`/Users/ntars/Documents/Github/Ondra`
- 手册：`/Users/ntars/Downloads/空谷-内核复刻开发手册.md`（文件标题 v1.2；目标按 v1.1 阶段判据执行）
- 随包运行时：`runtime/macos-arm64`（仅本地装配，未下载发布包）
- 本次不涉及 Windows / Android 虚拟机。

## P0–P4 关键证据

- P0 真实探针返回 `{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}`；无 profile 缺失、无插件兼容禁用。
- P0 负向验证：故意制造兼容不匹配后，内核打印 `disabling profile plugin row "ondra-filter-chain"`，日志 `/tmp/ondra-p0-negative.log`。
- P1 正文只取自 `assistant/message -> event.data.message.content[] -> type == "text"`；`test/rpc_frames_test.dart` 10/10。
- P2 真实随包内核、stdio 传输、真实 ChatClient 与“你好”对话通过。
- P3 profile 种子与用户改动保留；`compatibility.json` / `cordis.patch.yml` 不再被错误标为应用所有，旧清单会迁移。
- P4 真实 `tools.view()` / `resolveExecution()` 插件集成已适配当前 SDK；完整 Node 套件最终 28/28 通过。

## P5：本地 qwen3-coder-next 与预热

真实内核、临时 DSH_HOME、随包 profile，参数 `provider=local-qwen`、`model=qwen3-coder-next`：

```text
ASSISTANT: 2
TURN_END: {"kind":"completed"}
```

长输入明确返回 `CONTEXT_WINDOW_EXCEEDED`，UI 文案为“上下文超限，请缩短输入或开启新会话”。

预热脚本 `tool/warmup.mjs` 使用真实内核跑一轮 `initialize + session/prompt + session/wait + shutdown`（不是只打 `max_tokens:1` 的假形状）。模型卸载并重新加载后，干净链路使用同一句“1+1 等于几”，预热与紧随其后的独立探针为：

```text
kernel warmup 3632ms

RESULT: {"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}
REQUEST_HEADER: keys=config,adapterDefaults,tools tools=8
USAGE: {"inputTokens":7601,"outputTokens":18,"totalTokens":7619}
FIRST_TEXT: 560ms
ASSISTANT: 2。
TURN_END: {"kind":"completed"}
```

LM Studio 对本次正式请求记录的 TTFT 为 `0.299s`，`promptTokens=7601`、`predictedTokens=18`。原始冷启动曾为 `FIRST_TEXT: 64592ms`；旧预热形状曾为 `12598ms` / `15211ms`。本轮修掉了旧 dry-run 预热只覆盖错误请求形状的问题。改正后，手册第 16 项“重启模型 → `node tool/warmup.mjs` → 随后首次对话首字 <2s”在干净重载链路通过。

同一冷重载轮次中还出现过一次独立进程首字 `2256ms`，紧接着连续三次探针为 `513ms / 314ms / 449ms`。这被如实保留为波动样本，不把“任意负载下都稳定 <2s”写成结论；手册要求的指定链路已通过。日志：`/tmp/ondra-cold16-bWLOGU/`、`/tmp/ondra-cold16b-Wg5WFh/`。

## P6：裁剪装配

```text
runtime/macos-arm64                  164M
runtime/macos-arm64/dsh/node_modules  66M
runtime/macos-arm64/profile          5.6M
```

均在手册验收线内（runtime 140–155MB 的推荐区间略高，但低于 170MB 硬线）。`assemble_runtime.mjs` 增加了“输入源在产物目录内则拒绝装配”的保护，避免把当前 runtime 当源反复装配。`--dry-run` 只估算体积，不再执行临时 Node，因此不会把一个依赖 Homebrew dylib 的开发期 Node 误判成装配失败；真实装配仍在落盘时验证 Node 可独立运行。使用 DeepSeek Harness App 内 DSH 与仓库 profile 的 dry-run 为 184 包，日志 `/tmp/ondra-assemble-dry-after.log`。

## 最终门禁（2026-11-26）

本轮门禁在 P5 预热修复、推理能力字段修复和装配脚本 dry-run 修复之后重新完整执行。

```text
flutter analyze --no-pub            No issues found!
flutter test --no-pub               589 passed / 4 skipped
Node 集成/同步/启动/沙箱测试          28 pass / 0 fail
git diff --check                    pass
```

日志：`/tmp/ondra-analyze-current.log`、`/tmp/ondra-full-test-current.log`、`/tmp/ondra-plugin-current.log`、`/tmp/ondra-sync-current.log`。

## 其他总验收项

- 冷启动首句 5 秒提示：`test/chat_ui_test.dart` 的“首轮 5 秒没出字时改成可解释的准备模型文案”通过，最终全量测试再次覆盖。
- 错误可见：错误 model id 的探针退出码 1，并明确报 `pi-ai provider "local-qwen" has no configured model ...`，日志 `/tmp/ondra-final-wrong-model.log`。
- 历史落盘：临时 DSH_HOME 下确认生成 `sessions/.../session.v4.jsonl`。
- 停止可用与恢复：`test/stdio_transport_test.dart` 的 stop / exit-turn / 自动恢复用例在全量测试中通过。
- 工具集冻结：会话期间不动态增删工具；预热与真实对话复用同一 profile 和工具集形状，未观察到重复编译告警。

## 实际 macOS App

此前已构建、装配 runtime、ad-hoc 签名并通过 `codesign --verify --deep --strict`；NSWorkspace 验证进程 `hidden=false active=true`，窗口日志显示 `frame=960x600`。真实回复落盘 `/tmp/ondra-visible-reply.txt`。该包在最新 ChatClient / warmup 改动之前构建，最终交付如需安装包应重新构建；本次目标不要求推送或上传。

## 最终 macOS App 复验

在最新代码上重新执行 `flutter build macos --release` 与 `tool/bundle_macos.sh --skip-build`，`codesign --verify --deep --strict` 通过，整包 210MB、内嵌 runtime 160MB。

用临时 home 启动应用（`ONDRA_SEND_TEXT` / `ONDRA_CHAT_RESULT` 显式开启本机探针，不影响普通启动）：

```text
name=空谷 Ondra hidden=false active=true policy=0 terminated=false
```

真实回复：

```text
user: 1+1 等于几
assistant: 二。

这种不用翻账本
```

日志：`/tmp/ondra-final-build.log`、`/tmp/ondra-final-bundle.log`、`/tmp/ondra-final-visible-state.txt`。
