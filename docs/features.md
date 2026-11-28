# Ondra 功能登记（来源 / 许可 / 降级）

本文件按《空谷·会话内核复刻开发手册》§15.6 第 5 步登记：**每新增一项功能，先查内核包 → 再查 pub.dev → 再查 dsh-Go 公开文档 → 写降级方案 → 在这里登记一行，并同步 §15.5 功能对等表（已落在 `README.md:582`）。**

一行 = 功能 / 来源 / 许可 / 降级。来源如写「内核包」，表示 `runtime/<平台>-<架构>/dsh/node_modules/@deepseek-ai/` 下已有包，直接挂载、不从零写；写「本项目自研」表示内核与 pub.dev 均无现成实现。降级指该功能在 iOS / Web / OHOS 等不能起本地子进程的端上的行为，写不出降级的功能不进 v1。

## 功能登记

| 功能 | 来源 | 许可 | 降级（iOS / Web / OHOS） |
|---|---|---|---|
| 对话（会话主链、历史、压缩、工具调用、子代理） | 内核包 `dsh-agent` / `dsh-agent-loop` / `dsh-app-boot` / `dsh-session-*` + `dsh-sdk-minimal`；UI 四态机为本项目自研（`lib/plugins/ondra-core/ondra-ui/ondra-chat/ui/chat_client.dart`） | 内核包随上游 MIT；UI 为 Apache-2.0 | iOS / OHOS / Web 走 §13.2 R3（`dsh web` + 原生客户端），内核在远端，本端只画 UI；无本地子进程仍可对话 |
| 插件（加载、排序、隔离、注入） | 内核包 `cordis` 4.1.0 / `cordis-plugin-loader` / `cordis-plugin-group` / `cordis-plugin-include`；装配快照 `plugin-profile/` | Cordis MIT；本项目插件 Apache-2.0 | iOS（R3）与本端同构加载；Web / OHOS 只读——不加载用户自写插件，仅用随包闭包 |
| 终端工具（受控执行 + 沙箱档位） | 内核包 `dsh-bash-local` / `dsh-bash-sandbox` / `dsh-sandbox-policy` / `dsh-fs-sandbox` | 随上游 MIT | iOS / Web / OHOS 无本地子进程，功能关闭（§15.5 标 ✗）；这不是 bug，是能力边界，由 `ondraCapabilities.localSubprocess` 决定可见性而非 `Platform.is*` |
| 本地模型（受管段写回 + 预热） | 内核包 `dsh-llm-pi-ai`；受管段写入本项目自研（`lib/plugins/ondra-core/ondra-ui/ondra-settings/ondra-models/ui/runtime_model_config_io.dart`） | 内核包随上游 MIT；写入逻辑 Apache-2.0 | iOS / Web / OHOS 无本地模型子进程，模型路由走远端 R3 网关；不预热（无本地 MLX 编译） |
| 附件（选取、base64 传递、类型拒绝） | 内核包 `dsh-attachment` / `dsh-attachment-local`；选取降级用 `file_picker`/`desktop_picker` 现状 | 内核包随上游 MIT；本项目 UI Apache-2.0 | Web 仅上传；iOS / OHOS 走系统分享面板选文件，经 R3 远端会话传递 |
| 分享（会话/文本外发） | 本项目自研（宿主分享通道） | Apache-2.0 | OHOS 无端上证据（§15.5 标 ✗）；iOS / Web 走宿主 share sheet |
| 自动更新（发布包/刷新即更新） | 本项目自研（宿主生命周期） | Apache-2.0 | Linux 手动、iOS / OHOS 无端上证据（§15.5 标 ✗）；Web 刷新即更新 |
| 备份 / 恢复 / 记忆提炼 | 内核包 `dsh-memory-*` / `dsh-session-*`；备份 UI 本项目自研 | 内核包随上游 MIT；UI Apache-2.0 | 随会话在远端（R3）持久化；本端只做展示与导出 |
| 身份 / 人设 / 情绪 / 危机干预 | 本项目插件闭包 `plugin-profile/node_modules/@ondra/cordis-plugin-ondra-*` | Apache-2.0 | 与对话同构，R3 远端会话同样挂载插件闭包 |

## 不从零重写（§15.4 对齐）

JSON-RPC 框架（6 方法，直接写约 200 行）、SSH / 加密隧道（`dartssh2`）、Markdown 解析（现有实现）、代码高亮（`highlight`）、日期时区（`intl` + 内核时间戳）、图标（`flutter_svg` + 图标集）。内核与 pub.dev 已有现成实现时一律挂载，止步。

## 登记纪律

- 来源列写「内核包」的功能，改动内核时只动协议适配层（`rpc_frames.dart` / `chat_client.dart`），不动页面（§13.3 判据 3）。
- 许可列禁止引入 copyleft（GPL / LGPL / AGPL / MPL）；Cordis 为 MIT，dsh-Go 仅只读公开文档、代码不入库（§14.1）。
- 每登记一行，必须能指到 §15.5 表对应单元格；本文件与 `README.md:582` 不一致时，以有端上证据的一方为准并修正另一方。
