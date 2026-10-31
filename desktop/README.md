# 空谷 Ondra

[中文](./README.md) ｜ [English](./README_EN.md)

**于无声处，听见共鸣。**

空谷 Ondra 是星玖工作室（Ntarstudio）出品的桌面 AI 陪伴体应用，基于 DeepSeek Harness 深度定制，可一键部署、高度自定义。中文名「空谷」取自成语「空谷足音」——寂静的山谷里听见人的脚步声，喻极难得的音讯。

| 项目 | 内容 |
| --- | --- |
| 英文名 | Ondra |
| 仓库 | [ntars/Ondra](https://github.com/ntars/Ondra) |
| 官网 | <https://ai.ntars.cn/> |
| 形态 | 桌面应用（Electron 外壳 + 本地 Agent 运行时） |
| 平台 | macOS（Apple Silicon 优先） |
| 版本 | 1.0.1 |
| 许可 | [AGPL-3.0](LICENSE) |
| 上游基线 | DeepSeek Harness `0.2.2-alpha.2`（MIT） |
| 运行时依赖 | 内置 Node.js 24 运行时，无需用户另装 |

---

## 一、项目名称与定位

**名称**：空谷 Ondra。中文名「空谷」，英文名「Ondra」，两者指同一产品，代码与仓库中的 `Ondra`、`ondra`、`空谷 Ondra` 均指本产品。

**一句话定位**：一个可一键部署、高度自定义的本地 AI 陪伴体桌面应用，用户拥有完整的模型选择权与数据所有权。

**上游关系**：本项目是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh，一个「一切皆插件」的 Agent 框架，以 MIT 许可发布）的深度定制发行版。dsh 提供 Agent 内核、插件容器、会话持久化与图形界面基座；空谷 Ondra 在其之上完成了品牌重塑、界面裁剪、插件精简、数据目录隔离与构建工具链适配。上游的每一处修改都记录在本文档与 [NOTICE](NOTICE) 中。

**与上游的关系边界**：本项目不是 dsh 的官方发行版，也不代表 DeepSeek 的立场。上游代码的版权与许可声明完整保留，本项目自身的改动以 AGPL-3.0 发布。

---

## 二、项目简介

### 2.1 背景

主流 AI 产品把「陪伴」做成了三种形态：一是把情绪写进提示词，每轮对话独立随机；二是把记忆放在云端，用户无法查看、无法删除、无法迁出；三是把模型与产品绑定，用户既不能换模型，也不能在断网时继续对话。

这三种形态共同指向同一个结构性问题：**陪伴的前提是记得住、有情绪、说得像人，而这三件事都需要长期状态**。长期状态一旦放在服务商手里，用户就同时失去了隐私与控制权。

### 2.2 要解决的问题

1. **数据归属问题**：对话内容属于最私密的一类信息，交给云端意味着它长期存在于他人的服务器上，随服务条款与商业变动而不可控。
2. **供应商锁定问题**：推理能力与产品绑定，用户无法选择模型来源，也无法在无网络环境下继续使用。
3. **状态连续性问题**：AI 的情绪与记忆按会话切断，隔一夜就遗忘，关系无法累积。
4. **部署门槛问题**：可自定义的本地 Agent 方案通常需要命令行、Node 环境、依赖编译，普通用户无法完成。

### 2.3 核心思路

本项目选择「把运行时整体装进应用」的路线：

- **内核**：采用 dsh 的 Cordis 插件容器。所有能力（模型接入、工具执行、界面模块、存储后端）都是插件，通过 YAML 补丁层声明式组装，不修改内核源码即可改变产品行为。
- **外壳**：Electron 负责窗口、菜单、图标、签名与自动更新；Agent 运行时作为子进程启动，与界面进程分离。
- **数据**：全部落在 `~/.ondra` 单一根目录下，不读写系统文档目录，也不与其他 dsh 安装交叉。
- **分发**：应用包内置 Node.js 24 运行时与全部依赖，用户双击即可运行，无需安装开发环境。

### 2.4 适用场景

| 场景 | 说明 |
| --- | --- |
| 个人长期陪伴对话 | 单机单用户，数据不出本机 |
| 自建模型或第三方网关接入 | 通过 YAML 配置指向任意兼容 OpenAI 协议的端点 |
| 桌面 Agent 工作台 | 文件读写、命令执行、子代理、技能、工作流等能力可按预设组装 |
| 二次开发与品牌定制 | 插件体系与补丁层允许在不改内核的前提下改造产品 |
| 离线或内网环境 | 接入本地推理服务后可在无外网条件下运行 |

---

## 三、核心功能

以下功能均以当前版本的实际代码为准。凡标注「预设层」的能力，指该能力由 Agent 预设（preset）按会话组装，而非全局常驻。

### 3.1 界面与交互

1. **三栏常驻工作台**：左侧会话列表、中部对话区、右侧第三栏同时可见。第三栏永不收起，无会话时显示占位面板而非空白。
2. **中英双语界面**：仅保留简体中文与英文两套文案，语言回退基准为英文。
3. **无登录门槛**：启动后直接进入工作区，不出现登录页、不要求填写账号或密钥即可浏览界面。
4. **主题跟随**：默认跟随系统浅色与深色偏好，可在设置中固定为浅色或深色。
5. **会话自动恢复**：启动时若上次选中的会话已失效，自动打开目标工作区中最近更新的会话。

### 3.2 Agent 能力（预设层组装）

标准预设（`standard`）挂载以下能力，共 32 个插件条目：

| 类别 | 能力 |
| --- | --- |
| 命令执行 | `tool-bash`（POSIX Shell）、`tool-pwsh`（PowerShell） |
| 文件操作 | `tool-fs`（读写与编辑）、`tool-fs-search`（内容检索） |
| 联网 | `tool-web`（搜索与抓取） |
| 任务管理 | `tool-todo`、`tool-goal`、`tool-jobs`（后台任务）、`tool-schedule`（定时） |
| 计划与压缩 | `plan-mode`、`planning`、`compaction`、`compaction-basic`、`command-compact`、`tool-result-pruner` |
| 子代理 | `tool-subagent`、`tool-subagent-control`、`tool-subagent-fork`、`delegation` |
| 技能与工作流 | `skill-filesystem`、`tool-skill`、`workflow-ptc`、`tool-workflow` |
| 插件管理 | `tool-plugin-manager`、`tool-plugin-market` |
| 交互与呈现 | `tool-ask-user`、`present`、`persona`、`agent-instructions`、`time-context` |

其余三套预设：

| 预设 | 定位 | 与标准预设的差异 |
| --- | --- | --- |
| `cordis` | 插件开发者 | 增加 `tool-cordis`，可直接读写插件配置与类型图谱 |
| `ptc` | 程序化工具调用 | 增加 `tool-executor-ptc`，工具以代码形式编排执行 |
| `minimal` | 最小可用 | 仅保留文件操作与持久终端（`persistent-shell`、`pty`、`terminal-bash`、`terminal-pwsh` 等 12 项） |

### 3.3 模型接入

1. **多来源配置**：模型接入通过 `llm-deepseek` 插件配置 `baseURL` 与 `models` 列表，支持官方端点、第三方网关、本地推理服务。
2. **模型条目自定义**：每个模型条目可声明 `id`、`name`、`contextWindow`、`systemPromptUpdate`、`toolUpdate`、`inputModalities`，用于适配不同上下文长度与多模态能力。
3. **密钥本地存储**：API 密钥写入本机凭据存储，不进入配置文件明文。

### 3.4 数据与工作区

1. **单一数据根**：全部应用数据位于 `~/.ondra`。
2. **固定工作区**：Agent 的工作目录恒为 `~/.ondra/workspace`，界面不提供更改入口，配置层也不读取系统文档目录。
3. **会话持久化**：会话以 zstd 分帧日志格式落盘，目录名由工作目录路径编码生成。
4. **工作区注册表**：`~/.ondra/storages/workspace.json` 记录工作区实体。

### 3.5 构建与分发

1. **三种出包粒度**：产物层热更新（约 40 秒）、源码层增量出包（约 4 分钟）、完整重打（数分钟），见第七章。
2. **类型门禁**：客户端与宿主两侧分别有 TypeScript 工程配置，任何 TypeScript 改动后必须通过 `tsc -b` 编译校验。
3. **品牌资产**：应用图标按 Apple HIG 光学尺寸重制，画布 1024 px、图形底座 856 px（占画布 83.6%，与 macOS 系统应用一致）、圆角 186 px。

---

## 四、核心亮点

### 4.1 三栏常驻：把「随时可用的上下文面板」变成产品前提

- **价值**：解决右侧信息栏被用户误收起后再也找不到的问题。收起动作一旦发生，用户往往不知道如何恢复，第三栏因此长期处于隐藏状态，面板价值归零。
- **实现方式**：在状态层把所有「收起」意图统一改写为「展开」。`packages/client/ui-sidebar-right/src/client/stores.ts` 的 `setExpanded` 与 `toggleExpanded` 两个写入点恒调用 `planSetExpanded(state, true)`，忽略传入的布尔值；渲染层 `SidebarRight.tsx` 的 `expanded` 恒为 `true`；页签可见性判定中移除对 `state.expanded` 的门控；`ExpandButton` 组件不再注册，界面不存在收起入口。
- **差异化**：常见方案是隐藏按钮或增加配置项，但状态机仍然接受收起操作，一旦通过快捷键、深度链接或旧版配置触发，界面依旧会回到折叠态。本实现从写入点收敛，任何来源的收起请求都在进入状态机前被吸收，不存在旁路。
- **证据**：`stores.ts` 第 279 至 283 行保留 `planSetExpanded(state, true)` 的调用与说明「Ondra's third column is permanent」；布局历史栈（撤销与重做）仍然记录这次「展开」动作，因此撤销不会把界面带回折叠态。

### 4.2 空态第三栏：没有会话时也保持结构完整

- **价值**：解决新建或切换工作区时第三栏突然消失导致的布局跳变。两栏与三栏之间的宽度突变会让中部对话区重新排版，用户正在阅读的内容发生位移。
- **实现方式**：`packages/client/ui-sidebar-right/src/client/shell/RightbarRoot.tsx` 在会话视图集合为空时渲染 `RightbarEmpty`，绘制与外层一致的面板边框与占位文案，而不是返回 `null`。
- **差异化**：多数桌面应用在无内容时直接不渲染侧栏，视觉上更「干净」，但代价是布局不稳定。本实现选择用空态占位换取布局恒定。
- **证据**：`RightbarRoot.tsx` 第 42 行 `if (views.length === 0) return <RightbarEmpty />`，第 52 行起为 `RightbarEmpty` 组件定义。

### 4.3 数据目录彻底隔离：一个安装一个根

- **价值**：解决同机安装多个 dsh 系应用时互相覆盖工程文件的风险。上游默认把工作区解析到系统「文稿」目录下的共享路径，多个应用会读写同一棵树。
- **实现方式**：重写 `packages/api/workspace-controller/src/default-directory.ts`，`defaultWorkspaceDirectory()` 不再查询系统文稿目录，恒返回 `$DSH_HOME/workspace`，其中 `$DSH_HOME` 缺省为 `~/.ondra`。
- **差异化**：常见做法是允许用户自选目录，把隔离责任交给用户。本实现选择「不可选」——代价是灵活性，收益是任何一次安装都不会写坏另一次安装的数据。
- **证据**：该文件第 50 至 63 行的实现，以及第 39 至 42 行的注释，明确记录「另一个装在机器上的 dsh 拥有 `<Documents>/deepseek-harness`，共享该树会让两个应用互相读写对方工程文件」。`DSH_HOME` 环境变量仍可整体迁移数据根，用于测试与非典型部署。

### 4.4 无登录直达工作区：把权限判断收敛到一处

- **价值**：解决陪伴类应用首屏被登录墙占据的问题。用户打开应用的第一诉求是对话，而非注册。
- **实现方式**：`apps/desktop/src/welcome-api.ts` 的 `needsWelcome()` 恒返回 `false`。该函数未被删除，因为每个调用点仍在提问，保留单一可检索的判断点是可维护性的选择。
- **差异化**：直接删除登录窗口会留下散落在各处的判断分支，后续若要恢复登录需重新梳理调用链。保留函数并把答案固定为 `false`，使恢复登录只需改一行。
- **证据**：`welcome-api.ts` 第 68 至 79 行，函数体为 `return false`，注释说明「Ondra ships without a sign-in step: the workspace is the first screen」。

### 4.5 快捷键服务位保留、实现清空：避免启动期服务缺失

- **价值**：解决「删除快捷键功能导致启动卡死」的连锁故障。界面插件中有 11 个依赖 `ctx.shortcuts` 服务位，服务一旦缺席，这些插件进入 pending 状态，应用停在启动画面。
- **实现方式**：删除独立的 `packages/client/ui-shortcuts` 整包；保留 `packages/client/shortcuts`，但把宿主侧 `apply()` 改为空函数、客户端只提供惰性服务占位，不注入任何页面、不读取任何配置。
- **差异化**：彻底的删除方案在单元测试中干净，但在运行时会出现服务依赖断裂。保留服务位是「接口留、实现去」的折中，功能确实消失，启动链路保持完整。
- **证据**：`packages/client/shortcuts/src/index.ts` 的 `apply()` 为空实现，文件头注释记录「The plugin row still mounts so the `shortcuts` service seat exists for feature plugins」。

### 4.6 界面文案裁剪：从 1752 个语言文件收敛到中英两套

- **价值**：解决安装包体积与升级包体积被六种无用语言撑大的问题，同时消除界面语言与产品定位不一致的情况。
- **实现方式**：删除 `ja`、`es`、`fr`、`de`、`ru`、`pt` 六种语言的本地化文件，共 1765 个文件；把 68 处 `locale.register` 调用收敛为仅注册 `zh` 与 `en`；语言回退基准 `FALLBACK_LOCALE` 设为 `en`。
- **差异化**：常见做法是保留语言文件但在界面上隐藏语言选项，安装体积不变。本实现直接删除资源，体积与维护面同步下降。
- **证据**：本次改动累计删除 37 317 行、1765 个文件，`git diff --stat` 可复现。

### 4.7 图标按 Apple HIG 光学尺寸重制

- **价值**：解决应用图标在访达与程序坞中显示偏小的问题。直接使用满幅画布会显得比系统图标「缩水」，原因是系统图标的图形并未铺满方形画布。
- **实现方式**：画布 1024 px，图形底座 856 px（占画布 83.6%，与系统「备忘录」「音乐」的实际比例一致），圆角 186 px；字形按光学尺寸加粗，补偿小尺寸下的笔画丢失；导出 PNG 后打包为 `.icns` 并替换应用包内资源。
- **差异化**：多数自定义图标把图形画到画布边缘，视觉上「大」，实际观感比系统图标「胀」。按系统实测比例回退到 83.6% 是在访达中看起来「一样大」的关键。
- **证据**：`apps/desktop/resources/icon-macos.png` 与 `icon.png` 均为 1024 画布、48 KB 量级；`.icns` 已替换进 `空谷 Ondra.app`。

### 4.8 四种 Agent 预设：能力由组合决定，而非编译期开关

- **价值**：解决「同一份安装包要服务不同使用强度用户」的问题。重度用户需要命令执行与子代理，轻度用户只需要对话与文件读写，二者不应是两个安装包。
- **实现方式**：能力以 YAML 补丁声明，`packages/bundle/web-app/presets/` 下四份补丁文件分别组装 `standard`（32 项）、`cordis`（33 项）、`ptc`（33 项）、`minimal`（12 项）。全局层（`web-app/cordis.patch.yml`）只保留界面骨架与注册表，工具类插件下沉到预设层按会话挂载。
- **差异化**：编译期裁剪需要维护多套构建产物；运行期开关容易导致依赖图不完整。预设层组装的粒度是「每个会话的 Agent」，能力集合随会话可切换，安装包只有一份。
- **证据**：`packages/bundle/web-app/presets/standard.patch.yml` 等四份文件的 `id` 列表可直接统计，见第三章 3.2 节。

---

## 五、设计细节与小巧思

本章记录非显而易见的实现决策，包括边界条件、降级策略、默认值取舍与跨平台适配。

### 5.1 异常输入与边界情况

1. **会话选择失效回退**：`packages/client/ui-workspace/src/client/navigation.ts` 新增 `newestSessionIn()`（第 594 行定义，第 496 行调用）。用户上次选中的会话若已被删除或迁移，界面不会停在空白页，而是打开该工作区中最近更新的会话。选择这一回退目标而非「新建空会话」，是为了避免每次失效都产生一个无用会话目录。
2. **空工作区**：工作区中一个会话都没有时，第三栏进入 `RightbarEmpty` 空态，中部显示新建提示，不进入错误状态。
3. **路径编码的会话目录**：会话目录名由工作目录路径编码生成，规则为 `/` 替换为 `-`，其他特殊字符转义为 `~XXXX`。因此 `~/.ondra/workspace` 对应的目录名为 `--Users-ntars-.ondra-workspace--`。更改工作区路径时，目录名与会话文件内部的 `cwd` 字段必须同步迁移，否则界面按路径找不到会话。
4. **配置值为空的处理**：`defaultWorkspaceDirectory()` 对 `DSH_HOME` 做「存在且去空白后非空」判断，避免传入空字符串时生成相对路径。

### 5.2 超时、重试、降级与容错

1. **编译器内存上限**：宿主侧编译在本机实测需要超过默认堆上限，构建脚本设置 `NODE_OPTIONS=--max-old-space-size=8192`，否则进程以内存溢出退出。
2. **服务依赖断裂的兜底**：`shortcuts` 服务位保留为空实现，见 4.5。同类做法适用于任何「界面插件依赖某服务、但该服务已无功能」的场景。
3. **插件禁用与预设成员的交叉校验**：禁用某插件前必须确认它不在任何预设的成员集合内，否则新建会话会因 `agent-preset/invalid` 失败。历史上禁用 `goal` 插件导致 `tool-goal` 等待 `goals` 服务超时，进而使整条新建会话链路失败。校验规则为「预设成员集合 ∩ 禁用清单 = 空集」。
4. **登录流程的降级**：`needsWelcome()` 恒 `false`，即使账号信息读取失败也不会阻塞进入工作区。

### 5.3 缓存与性能优化

1. **三级构建粒度**：产物层热更新只同步 `app.asar` 内已解包的文件，约 40 秒；源码层增量出包会重新编译 `packages/**/src`、同步产物、重签名并重启，约 4 分钟；完整重打处理依赖树、包清单与图标，数分钟。按改动范围选择粒度，避免每次都走完整流程。
2. **配置文件同步范围**：增量出包脚本除同步编译产物 `lib` 外，还同步包根目录下的 `*.yml`（`cordis.patch.yml`、`presets/*.yml`）。遗漏这一项会导致配置改动「编译通过但不生效」，是排查成本最高的一类失效。
3. **页面按需加载**：界面模块以插件形式注册，未启用的插件不进入渲染树，不产生运行时代码路径。

### 5.4 并发与数据一致性

1. **配置写入加锁**：桌面主进程对 profile 目录的写入通过锁定文件串行化（`apps/desktop/src/project-manager.ts` 的 `withLock`），并校验锁路径必须是普通文件，防止并发写入产生半截配置。
2. **布局历史的撤销语义**：第三栏的「展开」动作仍被记录进布局历史栈。撤销一次页签操作不会把界面带回折叠态，因为历史中不存在折叠状态。
3. **会话日志的分帧写入**：会话日志采用「每行一个 zstd 帧」格式，首帧必须恰好是一行 header。整体解压后重新压缩会合并帧并破坏格式，报错 `first frame is not exactly one header line`。任何会话改写必须按帧重建，不得整体重压。

### 5.5 内存与存储优化

1. **语言资源删除**：删除六种语言共 1765 个文件，减少的是安装体积与文件句柄数量，不涉及运行时内存。
2. **输出溢出与结果修剪**：预设层挂载 `tool-result-pruner` 与 `compaction` 系列插件，对超长工具输出做修剪与上下文压缩，避免单次工具调用耗尽上下文窗口。
3. **附件与二进制分离**：二进制附件由独立插件管理，不进入会话文本流。

### 5.6 安全与防护设计

1. **进程隔离**：Agent 运行时作为子进程启动，与 Electron 主进程分离，界面崩溃不带走运行时，运行时崩溃可被主进程重启。
2. **权限最小化**：工具在会话级挂载，未挂载的工具不存在调用入口。
3. **数据不出本机**：会话、配置、凭据全部落在 `~/.ondra`，除非用户主动配置远程模型端点。
4. **沙箱的边界说明**：上游提供进程限制与审批机制，但不构成安全隔离保证。详见第十三章。

### 5.7 用户体验上的微小决策

1. **语言回退基准设为英文**：当界面语言文件缺失某个键时回退到英文而非中文，原因是英文条目在裁剪后覆盖最完整。
2. **第三栏无收起按钮**：界面不提供收起入口，而不是提供一个「不可用」的灰色按钮。不可用控件比没有控件更让人困惑。
3. **默认主题跟随系统**：不预设品牌色主题，避免用户在深色系统下首次启动被浅色界面刺眼。
4. **窗口标题与版本号**：应用包内不显示 Electron 自带的构建号，只显示产品版本，避免版本信息出现两个来源。

### 5.8 默认值的取舍依据

| 默认值 | 取值 | 依据 |
| --- | --- | --- |
| 数据根 | `~/.ondra` | 与其他 dsh 安装隔离，且不污染系统文稿目录 |
| 工作区 | `~/.ondra/workspace` | 固定路径使会话目录名可预测，便于备份与迁移 |
| 语言回退 | `en` | 裁剪后英文条目覆盖最完整 |
| 图标底座比例 | 83.6% | 与 macOS 系统应用实测比例一致 |
| 编译器堆上限 | 8192 MB | 本机宿主侧编译的实测最低可用值 |
| 主题 | 跟随系统 | 避免深色系统下首次启动的亮度突变 |

### 5.9 跨平台与版本兼容策略

1. **路径分隔符处理**：`default-directory.ts` 按 `process.platform` 选择 `posix` 或 `win32` 路径模块，Windows 盘符根路径被显式拒绝为工作区。
2. **打包目标**：当前构建脚本覆盖 macOS arm64、macOS x64、Windows x64 三类目标，其中 macOS arm64 为实测验证平台，其余目标保留脚本但未经本版本验证。
3. **上游会话格式兼容**：会话格式由上游维护，本项目不修改格式版本号，迁移会话时按上游定义的版本规则处理。

---

## 六、技术栈与依赖清单

### 6.1 核心技术栈

| 层次 | 技术 | 版本 | 用途 |
| --- | --- | --- | --- |
| 桌面外壳 | Electron | 见依赖清单 | 窗口、菜单、图标、签名、自动更新 |
| Agent 内核 | DeepSeek Harness（dsh） | `0.2.2-alpha.2` | Agent 循环、会话、工具执行、插件容器 |
| 插件框架 | Cordis（源码内置） | 见 `vendor/README.md` | 依赖注入、插件生命周期、配置补丁 |
| 界面 | React | 18.3.x | 渲染层组件 |
| 语言 | TypeScript | 见依赖清单 | 全部源码 |
| 构建 | tsdown + Vite | 见依赖清单 | 宿主与客户端产物打包 |
| 包管理 | pnpm workspace | lockfile v9.0 | 单仓 396 个包 |
| 运行时 | Node.js | 24.x | 内置，随应用分发 |
| 会话存储 | zstd 分帧日志 + SQLite | 见依赖清单 | 会话持久化与索引 |

### 6.2 依赖披露的完整性与口径

本项目的依赖披露遵循以下口径，避免遗漏与夸大：

1. **直接依赖**：在各 `package.json` 的 `dependencies`、`peerDependencies`、`optionalDependencies` 中声明的外部包，共 121 项，逐项列于 6.3。
2. **传递依赖**：完整闭包记录在 `pnpm-lock.yaml`（lockfile v9.0，1753 条解析记录），可用 `pnpm licenses list` 复核。本机不逐条复述，以免与锁文件产生两份真源。
3. **源码内置依赖**：Cordis 框架及其基础库以源码形式内置在仓库而非从 npm 安装，共 9 项，全部为 MIT，各自保留上游 `LICENSE` 文件，上游提交与本地修改记录在 `vendor/README.md`。
4. **开发期依赖**：仅用于构建、测试、静态检查，不随应用分发，共 75 项，列于 6.4。开发期依赖不受分发许可约束，但仍完整披露。
5. **版权方的取值**：版权方字段取自各包随附 `LICENSE` 文件中的版权行。部分包的许可证文件使用标准模板而未包含独立版权行，此类条目记为「见包内 LICENSE」，不做推断。
6. **是否修改**：除 `vendor/` 下 9 项源码内置依赖外，其余第三方包均未修改源码。`vendor/` 内各项的修改情况逐项记录在 `vendor/README.md` 与 [NOTICE](NOTICE) 中。
7. **用途归类**：本表按包在项目中的实际作用归类，不以包名推测。归类依据为 `package.json` 的引用关系与构建配置。

### 6.3 运行时依赖（121 项）

以下依赖随应用分发，或被打包进宿主与浏览器产物。

<details>
<summary>展开完整清单（121 项）</summary>

| 包名 | 版本 | 许可证 | 版权方 | 官方地址 |
| --- | --- | --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.4.0 | Apache-2.0 | 见包内 LICENSE | https://github.com/agentclientprotocol/typescript-sdk |
| `@anthropic-ai/claude-agent-sdk` | 0.3.263 | SEE LICENSE IN README.md | 见包内 LICENSE | https://github.com/anthropics/claude-agent-sdk-typescript |
| `@anthropic-ai/sdk` | 0.93.0 | MIT | Copyright 2023 Anthropic, PBC. | https://github.com/anthropics/anthropic-sdk-typescript |
| `@babel/code-frame` | 7.29.7 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors | https://github.com/babel/babel |
| `@botiverse/oar` | 0.67.0 | Apache-2.0 | 见包内 LICENSE | https://github.com/botiverse/oar |
| `@browserbasehq/stagehand` | 4.1.0 | MIT | Copyright (c) 2024 Browserbase Inc. | https://github.com/browserbase/stagehand |
| `@deepseek-ai/libreoffice-kit` | 0.1.5 | MPL-2.0 | 见包内 LICENSE | https://github.com/deepseek-ai/dsh-libreoffice-kit |
| `@earendil-works/pi-ai` | 1.3.0 | MIT | 见包内 LICENSE | https://github.com/earendil-works/pi |
| `@earendil-works/pi-coding-agent` | 1.3.0 | MIT | 见包内 LICENSE | https://github.com/earendil-works/pi |
| `@eslint-community/regexpp` | 4.12.2 | MIT | Copyright (c) 2018 Toru Nagashima | https://github.com/eslint-community/regexpp |
| `@fortune-sheet/core` | 1.0.4 | MIT | 见包内 LICENSE | https://github.com/ruilisi/fortune-sheet |
| `@fortune-sheet/react` | 1.0.4 | MIT | 见包内 LICENSE | https://github.com/ruilisi/fortune-sheet |
| `@joplin/turndown-plugin-gfm` | 1.0.67 | MIT | Copyright (c) 2017 Dom Christie | https://github.com/laurent22/joplin-turndown-plugin-gfm |
| `@jridgewell/gen-mapping` | 0.3.13 | MIT | Copyright 2024 Justin Ridgewell <justin@ridgewell.name> | https://github.com/jridgewell/sourcemaps |
| `@js-temporal/polyfill` | 0.5.1 | ISC | Copyright 2017, 2018, 2019, 2020 ECMA International | https://github.com/js-temporal/temporal-polyfill |
| `@lexical/history` | 0.49.0 | MIT | 见包内 LICENSE | https://github.com/facebook/lexical |
| `@lexical/plain-text` | 0.49.0 | MIT | 见包内 LICENSE | https://github.com/facebook/lexical |
| `@lexical/text` | 0.49.0 | MIT | 见包内 LICENSE | https://github.com/facebook/lexical |
| `@lexical/utils` | 0.49.0 | MIT | 见包内 LICENSE | https://github.com/facebook/lexical |
| `@modelcontextprotocol/client` | 2.2.0 | MIT | 见包内 LICENSE | https://github.com/modelcontextprotocol/typescript-sdk |
| `@modelcontextprotocol/sdk` | 1.31.0 | MIT | Copyright (c) 2024 Anthropic, PBC | https://github.com/modelcontextprotocol/typescript-sdk |
| `@noble/hashes` | 2.4.0 | MIT | Copyright (c) 2022 Paul Miller (https://paulmillr.com) | https://github.com/paulmillr/noble-hashes |
| `@octokit/webhooks` | 14.2.0 | MIT | Copyright (c) GitHub 2025 - Licensed as MIT. | https://github.com/octokit/webhooks.js |
| `@openai/codex` | 0.153.4-win32-x64 | Apache-2.0 | 见包内 LICENSE | https://github.com/openai/codex |
| `@opentelemetry/api` | 1.9.1 | Apache-2.0 | 见包内 LICENSE | — |
| `@opentelemetry/api-logs` | 0.222.0 | Apache-2.0 | 见包内 LICENSE | — |
| `@opentelemetry/core` | 2.9.0 | Apache-2.0 | 见包内 LICENSE | — |
| `@opentelemetry/otlp-exporter-base` | 0.222.0 | Apache-2.0 | 见包内 LICENSE | — |
| `@opentelemetry/otlp-transformer` | 0.222.0 | Apache-2.0 | 见包内 LICENSE | — |
| `@opentelemetry/resources` | 2.11.0 | Apache-2.0 | 见包内 LICENSE | — |
| `@opentelemetry/sdk-logs` | 0.222.0 | Apache-2.0 | 见包内 LICENSE | https://github.com/open-telemetry/opentelemetry-js |
| `@playwright/mcp` | 0.0.80 | Apache-2.0 | 见包内 LICENSE | https://github.com/microsoft/playwright-mcp |
| `@puppeteer/browsers` | 3.2.2 | Apache-2.0 | 见包内 LICENSE | https://github.com/puppeteer/puppeteer/tree/main/packages/browsers |
| `@shikijs/langs` | 4.4.3 | MIT | Copyright (c) 2021 Pine Wu | https://github.com/shikijs/shiki |
| `@standard-schema/spec` | 1.1.0 | MIT | Copyright (c) 2024 Colin McDonnell | https://github.com/standard-schema/standard-schema |
| `@tanstack/react-virtual` | 3.14.10 | MIT | Copyright (c) 2021-present Tanner Linsley | https://github.com/TanStack/virtual |
| `@trycua/cua-driver` | 0.28.0 | MIT | 见包内 LICENSE | https://github.com/trycua/cua |
| `@vscode/ripgrep` | 1.18.0 | MIT | 见包内 LICENSE | https://github.com/microsoft/vscode-ripgrep |
| `@xterm/addon-fit` | 0.11.0 | MIT | Copyright (c) 2019, The xterm.js authors (https://github.com/xtermjs/xterm.js) | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit |
| `@xterm/addon-serialize` | 0.14.0 | MIT | 见包内 LICENSE | https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize |
| `@xterm/headless` | 6.0.0 | MIT | 见包内 LICENSE | https://github.com/xtermjs/xterm.js |
| `@xterm/xterm` | 6.0.0 | MIT | Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js) | https://github.com/xtermjs/xterm.js |
| `@yarnpkg/parsers` | 3.1.0 | BSD-2-Clause | 见包内 LICENSE | https://github.com/yarnpkg/berry |
| `acorn` | 8.18.0 | MIT | Copyright (C) 2012-2022 by various contributors (see AUTHORS) | https://github.com/acornjs/acorn |
| `acorn-walk` | 8.3.5 | MIT | Copyright (C) 2012-2020 by various contributors (see AUTHORS) | https://github.com/acornjs/acorn |
| `ajv` | 8.20.0 | MIT | Copyright (c) 2015-2021 Evgeny Poberezkin | — |
| `anser` | 2.3.5 | MIT | Copyright (c) 2012-25 Ionică Bizău <bizauionica@gmail.com> (https://ionicabizau.net) | — |
| `big.js` | 7.0.1 | MIT | Copyright © `<2025>` `Michael Mclaughlin` | https://github.com/MikeMcl/big.js |
| `birpc` | 4.2.0 | MIT | Copyright (c) 2021 Anthony Fu <https://github.com/antfu> | https://github.com/antfu-collective/birpc |
| `buffer` | 6.0.3 | MIT | Copyright (c) Feross Aboukhadijeh, and other contributors. | — |
| `chokidar` | 5.0.0 | MIT | Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker | https://github.com/paulmillr/chokidar |
| `chrome-devtools-frontend` | 1.0.1638082 | BSD-3-Clause | // Copyright 2014 The Chromium Authors | https://github.com/ChromeDevTools/devtools-frontend |
| `chrome-devtools-mcp` | 1.9.0 | Apache-2.0 | 见包内 LICENSE | — |
| `clsx` | 2.1.1 | MIT | 见包内 LICENSE | — |
| `commander` | 9.5.0 | MIT | Copyright (c) 2011 TJ Holowaychuk <tj@vision-media.ca> | https://github.com/tj/commander.js |
| `compression` | 1.8.2 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> | — |
| `cross-spawn` | 7.0.6 | MIT | Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio> | https://github.com/moxystudio/node-cross-spawn |
| `diff` | 9.0.0 | BSD-3-Clause | Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com> | https://github.com/kpdecker/jsdiff |
| `dompurify` | 3.4.16 | (MPL-2.0 OR Apache-2.0) | 见包内 LICENSE | — |
| `electron-updater` | 6.8.9 | MIT | Copyright (c) 2015 Loopline Systems | https://github.com/electron-userland/electron-builder |
| `eventsource-parser` | 3.1.0 | MIT | Copyright (c) 2026 Espen Hovlandsdal <espen@hovlandsdal.com> | — |
| `exceljs` | 4.4.0 | MIT | Copyright (c) 2014-2019 Guyon Roche | https://github.com/exceljs/exceljs |
| `execa` | 10.0.1 | MIT | 见包内 LICENSE | — |
| `fast-xml-parser` | 5.11.1 | MIT | Copyright (c) 2017 Amit Kumar Gupta | https://github.com/NaturalIntelligence/fast-xml-parser |
| `fflate` | 0.8.3 | MIT | Copyright (c) 2026 Arjun Barrett | https://github.com/101arrowz/fflate |
| `got` | 14.6.6 | MIT | 见包内 LICENSE | — |
| `hosted-git-info` | 9.0.3 | ISC | Copyright (c) 2015, Rebecca Turner | https://github.com/npm/hosted-git-info |
| `immer` | 9.0.21 | MIT | Copyright (c) 2017 Michel Weststrate | https://github.com/immerjs/immer |
| `ipaddr.js` | 2.5.0 | MIT | Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org> | https://github.com/whitequark/ipaddr.js |
| `js-yaml` | 4.3.2 | MIT | Copyright (C) 2011-2015 by Vitaly Puzrin | — |
| `katex` | 0.18.7 | MIT | Copyright (c) 2013-2020 Khan Academy and other contributors | https://github.com/KaTeX/KaTeX |
| `koffi` | 3.1.1 | MIT | Copyright (C) 2026  Niels Martignène <niels.martignene@protonmail.com> | https://github.com/Koromix/koffi |
| `lexical` | 0.49.0 | MIT | 见包内 LICENSE | https://github.com/facebook/lexical |
| `mdast-util-from-markdown` | 2.0.3 | MIT | 见包内 LICENSE | — |
| `mdast-util-gfm` | 3.1.0 | MIT | 见包内 LICENSE | — |
| `mdast-util-math` | 3.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> | — |
| `micromark-core-commonmark` | 2.0.3 | MIT | 见包内 LICENSE | https://github.com/micromark/micromark/tree/main/packages/micromark-core-commonmark |
| `micromark-extension-gfm` | 3.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> | — |
| `micromark-extension-math` | 3.1.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> | — |
| `micromark-factory-space` | 2.0.1 | MIT | 见包内 LICENSE | https://github.com/micromark/micromark/tree/main/packages/micromark-factory-space |
| `micromark-util-character` | 2.1.1 | MIT | 见包内 LICENSE | https://github.com/micromark/micromark/tree/main/packages/micromark-util-character |
| `micromark-util-classify-character` | 2.0.1 | MIT | 见包内 LICENSE | https://github.com/micromark/micromark/tree/main/packages/micromark-util-classify-character |
| `micromark-util-decode-string` | 2.0.1 | MIT | 见包内 LICENSE | https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-string |
| `micromark-util-sanitize-uri` | 2.0.1 | MIT | 见包内 LICENSE | https://github.com/micromark/micromark/tree/main/packages/micromark-util-sanitize-uri |
| `micromark-util-symbol` | 2.0.1 | MIT | 见包内 LICENSE | https://github.com/micromark/micromark/tree/main/packages/micromark-util-symbol |
| `mime` | 4.1.1 | MIT | Copyright (c) 2023 Robert Kieffer | https://github.com/broofa/mime |
| `mime-types` | 3.0.2 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> | — |
| `minisearch` | 7.2.0 | MIT | Copyright 2022 Luca Ongaro | https://github.com/lucaong/minisearch |
| `negotiator` | 1.1.0 | MIT | Copyright (c) 2012-2014 Federico Romero | — |
| `node-addon-require-builtin` | 0.1.9 | MIT | Copyright (c) 2026 node-addon-require-builtin contributors | https://github.com/deepseek-ai/dsh-node-addon-require-builtin |
| `node-pty` | 1.2.0-beta.15 | MIT | Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/) | — |
| `open` | 11.0.4 | MIT | 见包内 LICENSE | — |
| `p-limit` | 7.3.3 | MIT | 见包内 LICENSE | — |
| `papaparse` | 5.7.0 | MIT | Copyright (c) 2015 Matthew Holt | https://github.com/mholt/PapaParse |
| `pdfjs-dist` | 6.3.289 | Apache-2.0 | 见包内 LICENSE | https://github.com/mozilla/pdf.js |
| `picomatch` | 4.0.7 | MIT | Copyright (c) 2017-present, Jon Schlinkert. | — |
| `react` | 18.3.1 | MIT | 见包内 LICENSE | https://github.com/facebook/react |
| `react-dom` | 18.3.1 | MIT | 见包内 LICENSE | https://github.com/facebook/react |
| `readable-stream` | 4.7.0 | MIT | Copyright Node.js contributors. All rights reserved. | — |
| `resolve.exports` | 2.0.3 | MIT | 见包内 LICENSE | — |
| `semver` | 7.8.5 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors | https://github.com/npm/node-semver |
| `serve-static` | 2.2.1 | MIT | Copyright (c) 2010 Sencha Inc. | — |
| `sharp` | 0.35.5 | Apache-2.0 | 见包内 LICENSE | https://github.com/lovell/sharp |
| `shell-quote` | 1.12.0 | MIT | Copyright (c) 2013 James Halliday (mail@substack.net) | http://github.com/ljharb/shell-quote |
| `sherpa-onnx-node` | 1.13.8 | Apache-2.0 | 见包内 LICENSE | https://github.com/csukuangfj/sherpa-onnx |
| `shiki` | 4.4.3 | MIT | Copyright (c) 2021 Pine Wu | https://github.com/shikijs/shiki |
| `simple-icons` | 16.31.0 | CC0-1.0 | 见包内 LICENSE | — |
| `string_decoder` | 1.3.0 | MIT | Copyright Node.js contributors. All rights reserved. | — |
| `supports-color` | 9.4.0 | MIT | 见包内 LICENSE | — |
| `tar` | 7.5.22 | BlueOak-1.0.0 | 见包内 LICENSE | https://github.com/isaacs/node-tar |
| `tsx` | 4.23.13 | MIT | 见包内 LICENSE | — |
| `turndown` | 7.2.4 | MIT | Copyright (c) 2017 Dom Christie | https://github.com/mixmark-io/turndown |
| `typescript` | 6.0.3 | Apache-2.0 | 见包内 LICENSE | https://github.com/microsoft/TypeScript |
| `undici` | 8.11.2 | MIT | Copyright (c) Matteo Collina and Undici contributors | https://github.com/nodejs/undici |
| `use-sync-external-store` | 1.6.0 | MIT | 见包内 LICENSE | https://github.com/facebook/react |
| `which` | 6.0.1 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors | https://github.com/npm/node-which |
| `ws` | 8.21.3 | MIT | Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com> | https://github.com/websockets/ws |
| `xlsx` | 0.20.3 | Apache-2.0 | 见包内 LICENSE | https://git.sheetjs.com/SheetJS/sheetjs |
| `yaml` | 2.9.0 | ISC | 见包内 LICENSE | https://github.com/eemeli/yaml |
| `zod` | 4.4.3 | MIT | Copyright (c) 2025 Colin McDonnell | https://github.com/colinhacks/zod |
| `zustand` | 4.5.7 | MIT | Copyright (c) 2019 Paul Henschel | https://github.com/pmndrs/zustand |

</details>

### 6.4 开发期依赖（75 项）

仅用于构建、测试与静态检查，不进入分发产物。完整清单与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 的 Development-only 章节。

需要特别注意的两项：

| 包 | 许可证 | 说明 |
| --- | --- | --- |
| `eslint-plugin-sonarjs` | LGPL-3.0-only | 仅静态检查期调用，其代码不被链接进任何分发产物 |
| `lightningcss` | MPL-2.0 | 仅构建期调用，产物为 CSS，不包含其源码 |

### 6.5 非 npm 依赖

| 组件 | 版本 | 许可证 | 说明 |
| --- | --- | --- | --- |
| Node.js 运行时 | 24.x | MIT | 随应用分发，位于应用包 `Resources` 下 |
| Python 发行版 | 见 `THIRD_PARTY_NOTICES.md` | 各自许可 | 供 Python SDK 与部分工具使用，共 14 项 |
| Python SDK 依赖 | 见 `python/sdk/uv.lock` | 各自许可 | 共 5 项 |
| Claude Code 平台载荷 | 见 `THIRD_PARTY_NOTICES.md` | 各自许可 | 共 9 项，随可选的 ACP 通道提供 |

### 6.6 非宽松许可证的处理

本项目以 AGPL-3.0 发布，与上游 MIT 许可的组合关系如下：

1. **MIT 上游代码**：MIT 允许再许可为 AGPL-3.0。上游 dsh 的版权声明与 MIT 许可全文完整保留在 `NOTICE` 中，未被删除或改写。
2. **MPL-2.0 组件**（`@deepseek-ai/libreoffice-kit`、`dompurify`）：MPL-2.0 允许组合进适用 AGPL 的更大作品，条件是保留其源代码获取途径与修改声明。`dompurify` 同时提供 Apache-2.0 双许可，可按更宽松的一项处理。
3. **LGPL-3.0-only 组件**（`eslint-plugin-sonarjs`）：仅开发期使用，不随产品分发，因此不触发 LGPL 的链接条款。
4. **CC0-1.0**（`simple-icons`）：公共领域贡献，无附加条件。
5. **BlueOak-1.0.0**（`tar`）：宽松许可，允许再许可。
6. **Apache-2.0 组件**：与 AGPL-3.0 兼容，需保留其 `NOTICE` 与专利授权声明。

---

## 七、安装与部署

### 7.1 环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | macOS 12 及以上（Apple Silicon 优先）；Windows 构建脚本存在但本版本未验证 |
| Node.js | 24.9 及以上（构建用；运行时已内置，用户无需安装） |
| pnpm | 与 lockfile v9.0 兼容的版本（随 corepack 提供） |
| 磁盘 | 源码与依赖约 3 GB，完整应用包约 1.3 GB |
| 内存 | 构建期建议 16 GB 以上，编译进程堆上限需 8 GB |

### 7.2 从源码构建

```bash
# 1. 获取源码
git clone https://github.com/ntars/Ondra.git
cd Ondra

# 2. 安装依赖（单仓 396 个包，耗时较长）
pnpm install

# 3. 全量构建
pnpm run build

# 4. 打包 macOS arm64 应用
pnpm run package:desktop:mac:arm64
```

构建产物输出至 `build/` 目录，应用名为 `空谷 Ondra.app`。

### 7.3 编译校验

任何 TypeScript 源码改动后必须通过两侧工程编译，退出码为 0 才视为通过：

```bash
node node_modules/typescript/bin/tsc -b tsconfig.client.json tsconfig.host.json
echo "EXIT=$?"
```

宿主侧编译对内存敏感，若进程以内存溢出退出，需设置：

```bash
export NODE_OPTIONS=--max-old-space-size=8192
```

### 7.4 三种出包粒度

| 方式 | 耗时 | 适用改动范围 | 行为 |
| --- | --- | --- | --- |
| 产物层热更新 | 约 40 秒 | 仅 `app.asar` 内已解包的文件 | 直接替换产物文件并重启应用 |
| 源码层增量出包 | 约 4 分钟 | `packages/**/src` 下的 TypeScript 源码 | 编译、同步产物、重签名、重启 |
| 完整重打 | 数分钟 | 依赖树、包清单、图标等 | 重新执行完整打包流程 |

**重要**：源码层增量出包除同步编译产物外，必须同步包根目录下的 `*.yml` 配置文件（`cordis.patch.yml`、`presets/*.yml`）。遗漏这一项会导致配置修改「编译通过、运行不生效」。

上述三类脚本属于开发者的本地工作区工具，未随仓库分发。公开仓库的构建以 7.2 的 pnpm 流程为准。

### 7.5 运行时目录

首次启动会自动创建以下目录，无需手动准备：

```
~/.ondra/
├── profiles/desktop/        # 插件配置与补丁层
├── sessions/                # 会话日志，按工作区路径分目录
├── storages/                # 工作区注册表等非会话存储
└── workspace/               # Agent 的工作目录，固定路径
```

### 7.6 卸载

删除应用包与 `~/.ondra` 目录即可完全移除。删除 `~/.ondra` 会丢失全部会话与配置，操作前应手动备份。

---

## 八、快速开始

### 8.1 首次启动

1. 打开 `空谷 Ondra.app`。首次启动会在 `~/.ondra` 下初始化配置目录与工作区。
2. 应用直接进入工作区，不出现登录页。
3. 左侧为会话列表，中部为对话区，右侧为常驻面板。

### 8.2 配置模型接入

模型配置位于 `~/.ondra/profiles/desktop/cordis.patch.yml`。以下为最小可用配置：

```yaml
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    baseURL: https://api.example.com/v1
    models:
      - id: deepseek-flash
        name: DeepSeek-V4.1-Flash
        contextWindow: 1048576
        systemPromptUpdate: in-history
        toolUpdate: addition-only
        inputModalities:
          - text
          - image
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `baseURL` | 兼容 OpenAI 协议的端点地址，可指向官方、第三方网关或本地服务 |
| `models[].id` | 请求中使用的模型标识，需与服务端一致 |
| `models[].name` | 界面显示名称 |
| `contextWindow` | 上下文窗口大小，单位为 token，影响压缩与截断策略 |
| `systemPromptUpdate` | 系统提示词更新方式，`in-history` 表示写入会话历史 |
| `toolUpdate` | 工具定义更新方式，`addition-only` 表示只增不减 |
| `inputModalities` | 支持的输入模态，可选 `text`、`image` |

修改配置后需重启应用生效。

### 8.3 新建对话

1. 在左侧会话列表底部选择新建会话。
2. 选择 Agent 预设（默认 `standard`）。
3. 输入内容后发送。会话自动保存至 `~/.ondra/sessions/`。

### 8.4 验证安装是否正常

```bash
# 确认数据目录已创建
ls ~/.ondra

# 确认工作区固定路径生效
cat ~/.ondra/storages/workspace.json

# 确认会话目录已生成
ls ~/.ondra/sessions/
```

---

## 九、配置说明

### 9.1 配置层级

配置按以下顺序叠加，后应用的层级覆盖先应用的层级：

| 层级 | 位置 | 作用范围 |
| --- | --- | --- |
| 基础包 | `packages/bundle/base/cordis.patch.yml` | 全部预设共享的插件骨架，80 项启用、15 项硬禁用 |
| 应用包 | `packages/bundle/web-app/cordis.patch.yml` | 界面骨架与注册表，51 项启用、63 项下沉 |
| 预设 | `packages/bundle/web-app/presets/*.patch.yml` | 按会话组装 Agent 能力 |
| 用户层 | `~/.ondra/profiles/desktop/cordis.patch.yml` | 用户自己的覆盖配置，优先级最高 |

### 9.2 补丁语法

补丁文件是一个 YAML 数组，每个条目按 `id` 定位一行插件：

```yaml
# 覆盖某插件的配置
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light

# 禁用某插件
- id: tool-web
  disabled: true

# 新增插件行
- insert:
    - id: my-plugin
      name: "@scope/my-plugin"
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `id` | 目标行的标识，同一层级内唯一 |
| `name` | 插件包名，新建行时必需 |
| `config` | 覆盖该行的完整配置对象，不是深合并 |
| `disabled` | 是否禁用该行，支持 `!!js` 表达式 |
| `insert` | 新增插件行列表 |

**注意**：`config` 是整体替换而非深合并，因此一个在不同模式下取值不同的插件行不应放在共享层，否则会被后一层整块覆盖。

### 9.3 环境变量

| 变量 | 作用 | 默认值 |
| --- | --- | --- |
| `DSH_HOME` | 数据根目录 | `~/.ondra` |
| `NODE_OPTIONS` | 构建期 Node 参数，宿主侧编译需要较大的堆上限 | 无 |
| `TMPDIR` | 构建期临时目录 | 系统默认 |
| `ELECTRON_RUN_AS_NODE` | 构建前需确保未设置，否则 Electron 以 Node 模式启动 | 未设置 |

### 9.4 常用行为开关

| 目标 | 做法 |
| --- | --- |
| 固定浅色主题 | 在用户层覆盖 `ui-theme` 的 `preference` 为 `light` |
| 固定深色主题 | 在用户层覆盖 `ui-theme` 的 `preference` 为 `dark` |
| 关闭某工具 | 在用户层对该工具 `id` 设置 `disabled: true` |
| 更换模型端点 | 修改 `llm-deepseek` 的 `baseURL` 与 `models` |
| 迁移数据根 | 设置 `DSH_HOME` 环境变量后重启，并手动迁移目录内容 |

---

## 十、API / 模块说明

### 10.1 模块组织原则

本项目采用「一切皆插件」的组织方式。每个能力是一个独立的 workspace 包，包名形如 `@deepseek-ai/dsh-<group>-<name>`，通过 Cordis 容器完成依赖注入与生命周期管理。插件之间不直接引用彼此的内部实现，而是通过服务位（service）协作。

### 10.2 主要模块分组

| 分组 | 职责 | 包数 |
| --- | --- | --- |
| `core` | Agent 循环、会话、系统提示词、工具执行器 | 10 |
| `session` | 会话持久化、格式版本、迁移 | 22 |
| `llm` | 模型提供方接入 | 9 |
| `shell` | 命令执行抽象 | 10 |
| `subprocess` | 子进程管理 | 3 |
| `sandbox` | 进程限制 | 4 |
| `fs` | 文件系统访问 | 7 |
| `web` | 搜索与抓取 | 7 |
| `subagent` | 子代理编排 | 9 |
| `skill` | 技能加载 | 5 |
| `workflow` | 工作流执行 | 3 |
| `preset` | Agent 能力组装与人格注入 | 3 |
| `bundle` | 预设包与补丁层 | 6 |
| `client` | 图形界面插件（界面模块、面板、设置页） | 66 |
| `api` | 界面与宿主的通信层 | 10 |
| `host` | 图形宿主 | 9 |
| `boot` | 应用启动与插件管理 | 6 |
| `storage` | 非会话存储 | 4 |
| `credentials` | 凭据与授权 | 5 |
| `util` | 零依赖工具函数 | 21 |
| `experimental` | 已评估但未承诺产品支持的能力 | 65 |

完整分组说明见 `packages/README.md`，各包的契约见包内 README 与 `src/index.ts` 的导出类型。

### 10.3 界面与宿主的通信

界面插件运行在渲染进程，无法直接访问文件系统与子进程。所有特权操作经由 IPC 通道转发至主进程或 Agent 运行时：

| 通道族 | 用途 |
| --- | --- |
| `dsh-welcome:*` | 首屏引导窗口的私有通道，仅在窗口存在期间安装 |
| 平台视图通道 | 界面插件注册的面板与视图 |
| Agent 运行时通道 | 会话读写、工具调用、模型请求 |

通道的命名与载荷类型在 `apps/desktop/src/` 下按模块划分，新增通道需同时更新类型定义与调用方。

### 10.4 会话格式

会话以「每行一个 zstd 帧」的格式存储：

1. 第一帧必须是且仅是一行 header，包含格式版本。
2. 后续每帧承载一条事件记录。
3. 帧边界是格式的一部分，整体解压后重新压缩会合并帧并破坏格式。

修改会话文件时必须按帧重建，不得整体解压后重写。格式版本由上游维护，本项目不引入私有版本号。

### 10.5 新增插件的步骤

1. 在 `packages/<group>/<name>/` 下创建包，`package.json` 的 `name` 使用 `@deepseek-ai/dsh-<group>-<name>`。
2. 导出 `apply(ctx)` 函数，在其中注册服务、工具或界面模块。
3. 在目标预设的 `*.patch.yml` 中以 `insert` 声明该行，或在用户层配置中声明。
4. 若插件禁用会影响预设成员，需同步检查「预设成员集合 ∩ 禁用清单」是否为空。
5. 运行编译校验与相关测试。

---

## 十一、目录结构

```
.
├── apps/                       应用层
│   ├── desktop/                Electron 桌面外壳
│   │   ├── src/                主进程、预加载、IPC、窗口管理
│   │   ├── renderer/           首屏渲染资源
│   │   ├── resources/          图标与品牌资产
│   │   ├── scripts/            打包、签名、公证、冒烟测试
│   │   └── packaging/          各平台打包配置
│   ├── web/                    浏览器版入口
│   ├── cli/                    命令行入口
│   ├── desktop-host/           桌面宿主运行时
│   └── plugin-market-generator/插件市场索引生成
├── packages/                   workspace 包，共 396 个
│   ├── core/                   Agent 内核
│   ├── session/                会话持久化
│   ├── llm/                    模型接入
│   ├── client/                 界面插件（66 个）
│   ├── bundle/                 预设包与补丁层
│   ├── preset/                 Agent 组装与人格
│   ├── experimental/           实验性能力（65 个）
│   └── ...                     其余 45 个分组
├── vendor/                     源码内置的 Cordis 框架（9 个包）
├── native/                     原生插件源码
├── python/                     Python SDK 与运行时
├── benchmarks/                 性能门禁
├── scripts/                    校验脚本与生成器
├── docs/                       开发文档
├── website/                    文档站点
├── AGENTS.md                   面向自动化的仓库约定
├── THIRD_PARTY_NOTICES.md      第三方依赖披露
├── LICENSE                     AGPL-3.0 全文
├── NOTICE                      版权与合规声明
└── README.md / README_EN.md    本文档
```

---

## 十二、性能表现

### 12.1 已知的确定性数据

以下数值为本机实测或文件系统直接测量，可复现：

| 指标 | 数值 | 测量方式 |
| --- | --- | --- |
| 应用包体积 | 约 1.3 GB | `du -sh "空谷 Ondra.app"` |
| 主资源包体积 | 约 522 MB | `du -sh Contents/Resources/app.asar` |
| 语言资源删除量 | 1765 个文件 / 37 317 行 | `git diff --stat` |
| workspace 包数量 | 396 | 统计不含 `node_modules` 的 `package.json` |
| lockfile 解析记录 | 1753 条 | `pnpm-lock.yaml` 的 `packages` 段 |

### 12.2 构建耗时

| 方式 | 耗时 | 说明 |
| --- | --- | --- |
| 产物层热更新 | 约 40 秒 | 本机实测 |
| 源码层增量出包 | 约 4 分钟 | 含编译、同步、重签名、重启 |
| 完整重打 | 数分钟 | 随依赖树规模变化 |

### 12.3 未提供的指标

本项目**未提供**以下经独立测试的基准数据，不做推测性陈述：

1. 冷启动时间、首屏渲染时间、首字延迟。
2. 单会话内存占用与长时间运行的内存增长曲线。
3. 工具调用的端到端延迟。
4. 不同模型端点下的吞吐对比。

仓库内置 `benchmarks/` 目录与相关门禁脚本，用于回归检测而非发布对外指标。若需性能数据，应在本机按同一硬件与同一模型端点条件下实测，不应引用他处数值。

### 12.4 影响性能的结构性因素

1. **应用包体积主要来自内置运行时**：Node.js 运行时、Python 发行版与原生库占据主要体积，JavaScript 产物的占比很小。
2. **启动路径包含插件装配**：插件数量直接影响启动时的装配耗时，禁用插件可缩短启动链路。
3. **预设决定工具数量**：`minimal` 预设挂载 12 项能力，`standard` 挂载 32 项，工具定义会进入每次请求的上下文，能力越少上下文开销越低。

---

## 十三、安全与隐私

### 13.1 数据处理原则

1. **数据本地化**：会话、配置、凭据、工作区文件全部位于 `~/.ondra`，默认不上传任何服务。
2. **唯一的出站点是模型端点**：除非用户配置远程模型服务，应用不产生对外网络请求。搜索与抓取类工具仅在用户显式调用时访问目标地址。
3. **无账号体系**：不收集账号信息，不存在跨设备同步，也不存在服务端侧的对话副本。
4. **备份由用户掌握**：应用不自动上传备份，备份文件的生成与保存位置由用户决定。

### 13.2 权限与执行边界

1. **工具按会话挂载**：未在预设中挂载的工具没有调用入口，模型无法调用不存在的工具。
2. **命令执行需要显式能力**：`tool-bash` 与 `tool-pwsh` 提供命令执行能力，是否挂载由预设决定。
3. **沙箱的定位**：进程限制与审批机制降低风险，但不构成安全隔离保证。沙箱无法保护应用被授权访问的资源。

### 13.3 需要用户自行承担的风险

以下风险无法由软件消除，需要用户在使用前评估：

1. 模型生成的命令可能修改或删除文件。执行前应确认目标路径与操作范围。
2. 第三方插件可能读写宿主资源。安装插件前应审查其源码与权限声明。
3. 配置指向不可信的模型端点时，对话内容会发送至该端点。端点由用户选择，其数据处理策略由该端点负责。
4. 工作区内的文件对 Agent 可见。敏感文件不应放入工作区。

### 13.4 安全建议

1. 仅授予完成任务所需的最小权限。
2. 在一次性虚拟机或容器中首次试用新的插件与预设。
3. 定期备份 `~/.ondra`。
4. 不将生产凭据放入工作区目录。
5. 审查配置文件中出现的每一个远程端点。

---

## 十四、兼容性说明

### 14.1 平台支持矩阵

| 平台 | 架构 | 状态 | 说明 |
| --- | --- | --- | --- |
| macOS 12+ | Apple Silicon (arm64) | 已实测 | 本版本的主要验证平台 |
| macOS 12+ | Intel (x64) | 脚本存在，未验证 | 打包脚本可用，未做真机验证 |
| Windows 10/11 | x64 | 脚本存在，未验证 | 打包脚本可用，未做真机验证 |
| Linux | — | 不支持 | 无打包目标 |

### 14.2 运行时兼容性

1. **Node.js**：构建需要 24.9 及以上。应用内置 24.x 运行时，用户无需安装。
2. **pnpm**：使用 lockfile v9.0，需与 v9 兼容的 pnpm 版本。
3. **Electron**：版本锁定在 lockfile 中，升级需同步验证签名与自动更新链路。

### 14.3 数据兼容性

1. **会话格式版本**：由上游维护，升级可能引入新的格式版本。上游规则允许新增版本号，不允许就地改写已提交的旧版本数据。
2. **配置格式**：补丁文件为 YAML，字段随插件版本演进。升级后若某插件字段被移除，用户层残留字段会被忽略而非报错。
3. **跨版本回退**：不支持降级。旧版本可能无法读取新版本写出的会话。

### 14.4 与上游 dsh 的兼容性

本项目基于上游 `0.2.2-alpha.2` 定制，不与上游保持 API 兼容。上游的后续版本需要人工合并，合并时必须重新核对：语言注册点数量、快捷键服务位、右侧栏状态写入点、工作区路径解析、预设成员与禁用清单的交集。

---

## 十五、已知问题与限制

本章如实记录当前版本的缺陷与边界，不做粉饰。

### 15.1 功能层面的缺口

1. **陪伴类核心能力尚未移植**。上游旧实现中的六维情绪引擎、双层长期记忆、九步输出过滤链、拟人节奏、日记、主动消息闸门等机制，在本版本中**不存在**。当前版本具备的是：Agent 对话能力、人格段落注入（`packages/preset/persona`）、会话历史持久化。情绪状态、跨会话记忆抽取、关系阶段判定均未实现。
2. **工作区选择入口仍存在**。`ui-conversation` 中仍保留「选择工作区」的交互入口，而工作区路径在数据层已固定为 `~/.ondra/workspace`。当前状态是「可选但无效」，应移除该入口。
3. **插件禁用清单未做系统性复核**。本次 70 处新增禁用是在未完整校验预设成员的情况下完成的，存在「禁用了某插件导致某预设能力缺失」的潜在缺口。已知历史上禁用 `goal` 曾导致新建会话失败，同类问题可能仍存在。

### 15.2 已知缺陷

1. **残留的多余语言文件**。语言裁剪后仍有 36 个 `ja`、`es`、`fr`、`de`、`ru`、`pt` 文件未被删除，分布在 `boot/plugin-manager`、`bundle/web-app`、`extensions/tool-cordis`、`preset/agent-preset/skills/templates`（decoration 与 mcp 两套）、`subagent/tool-subagent` 六处。这些文件不影响运行时行为，但与本项目「仅中英」的定位不一致。
2. **侧栏测试用例失效**。`packages/client/ui-sidebar-right/tests/` 下仍有验证「收起与展开」行为的用例，而该行为已按设计删除。这些用例会失败，应改写为验证「恒展开」语义而非直接删除。
3. **图标在访达中的观感未最终确认**。图标已按 83.6% 底座比例重制，但与系统图标的并排对比尚未定稿，可能存在微调空间。

### 15.3 工程层面的限制

1. **构建脚本未开源**。产物层热更新、源码层增量出包、完整重打三类脚本属于开发者本地工作区，不随仓库分发。公开仓库只能使用 pnpm 标准流程，构建耗时更长。
2. **宿主侧编译对内存敏感**。未设置较大堆上限时，编译进程会以内存溢出退出。
3. **配置文件同步易被遗漏**。增量出包若只同步编译产物而不同步 `*.yml`，会出现「编译通过、配置不生效」的静默失效。
4. **无辅助功能权限时无法脚本化操作界面**。界面自动化测试依赖辅助功能授权，未授权环境下只能走进程级验证。

### 15.4 文档层面的限制

1. 本项目的性能指标未做独立基准测试，第十二章只披露确定性数据。
2. 部分第三方包的许可证文件未包含独立版权行，依赖清单中的版权方字段记为「见包内 LICENSE」。

---

## 十六、更新日志

### 1.0.1（当前版本）

**文档与合规**

- 建立完整文档体系：中文主版本、英文完整版、开源合规声明。
- 项目许可证由上游 MIT 变更为 AGPL-3.0，保留上游版权声明于 NOTICE。
- 补齐 121 项运行时依赖与 75 项开发期依赖的逐项披露。

**工程**

- 应用包版本号同步至 1.0.1。
- 清理残留的六种非目标语言文件。

**已知未完成**

- 陪伴类核心能力（情绪、记忆、关系阶段）尚未移植，见第十五章。
- 插件禁用清单的系统性复核未执行。

### 1.0.0

**基线**

- 基于 DeepSeek Harness `0.2.2-alpha.2` 建立定制基线，提交 `81e326b1`。
- 品牌改造：产品名、应用标识、图标、首屏资源。

**界面**

- 三栏常驻：状态层收敛全部收起意图，渲染层移除折叠门控，取消收起按钮。
- 第三栏空态：无会话时渲染占位面板。
- 界面文案裁剪：删除 1765 个语言文件，仅保留中文与英文，回退基准设为英文。
- 快捷键功能移除：删除独立快捷键包，保留服务位空实现。
- 首屏登录改为直接进入工作区。

**数据**

- 工作区路径固定为 `~/.ondra/workspace`，不再读取系统文稿目录。
- 迁移工作区注册表、会话目录名与会话内 `cwd` 字段。
- 启动时自动打开最近会话。

**构建**

- 适配本地 Node.js 24 工具链与内存参数。
- 图标按 Apple HIG 光学比例重制并替换应用包资源。

---

## 十七、后续路线图

以下为方向性规划，不构成交付承诺。顺序按依赖关系排列。

### 17.1 近期（1.0.x）

1. **清理残留**：删除 36 个多余语言文件；改写侧栏失效测试为「恒展开」语义验证。
2. **移除无效入口**：删除 `ui-conversation` 中的工作区选择交互。
3. **图标定稿**：与系统图标并排比对，确定最终底座比例。
4. **插件禁用复核**：建立「禁用清单 × 预设成员 × 服务契约」三方校验脚本，消除潜在的能力缺失。

### 17.2 中期（1.1）

1. **陪伴能力移植**：按优先级引入人格装配、长期记忆、情绪状态三类能力。移植顺序为记忆、人格、情绪，原因是情绪需要记忆提供时间线。
2. **第三栏改版**：现有第三栏为多页签容器，目标形态为固定面板（状态、关系、记忆、桌宠）。需先确定共存方式：新增常驻页签，或开辟独立插槽。
3. **构建脚本开源化**：把增量出包脚本整理为仓库内工具，降低二次开发门槛。

### 17.3 远期

1. **跨平台验证**：完成 Windows x64 与 macOS Intel 的真机验证。
2. **插件生态**：完善插件市场索引与安装流程。
3. **多模态**：语音输入与形象呈现。

---

## 十八、参与贡献方式

### 18.1 提交问题

提交问题时请包含以下信息，缺少这些信息的问题难以定位：

1. 操作系统版本与架构。
2. 应用版本号（关于页面可见）。
3. 复现步骤，从启动开始逐步描述。
4. 期望结果与实际结果。
5. 相关日志。会话相关问题需说明是新建会话还是既有会话。

### 18.2 提交代码

1. 从 `main` 分支切出特性分支，分支名使用 `feat/`、`fix/`、`docs/`、`chore/` 前缀。
2. 任何 TypeScript 改动后必须通过编译校验，退出码为 0。
3. 涉及运行时行为的改动必须实际启动应用验证，仅通过编译不足以证明可用。
4. 修改插件配置时，必须确认「预设成员集合」与「禁用清单」的交集为空。
5. 修改会话文件处理逻辑时，必须按 zstd 帧重建，不得整体解压后重写。
6. 提交信息说明「改了什么、为什么改」，不使用夸张表述。
7. 涉及破坏性操作（删除、移动、覆盖用户数据）的改动，必须在提交说明中写明影响范围与恢复方式。

### 18.3 文档贡献

1. 中文文档为主版本，英文版必须与中文版章节一一对应，不是摘要。
2. 术语首次出现时给出定义。
3. 引用第三方内容时必须标注来源与许可。
4. 文档中的数值必须可复现，不可复现的数值应标注测量条件。

### 18.4 许可证约束

本项目以 AGPL-3.0 发布。提交代码即表示同意以同一许可证授权你的贡献。若贡献中包含第三方代码，必须在提交中说明来源与许可证，并确认其与本项目许可证兼容。

---

## 十九、版权与许可

### 19.1 本项目版权

Copyright © 2024–2026 Ntarstudio（星玖工作室）. All Rights Reserved.

本项目依据 GNU Affero General Public License v3.0（AGPL-3.0）授权发布，许可证全文见 [LICENSE](LICENSE)。

AGPL-3.0 的核心义务：分发本软件或其修改版本时，必须提供完整源代码；若通过网络提供服务，也必须向使用者提供源代码。本项目的所有修改同样受此约束。

### 19.2 上游版权

本项目基于 DeepSeek Harness 定制，上游版权声明如下，并完整保留：

```
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 19.3 品牌与设计资产

应用图标、品牌视觉、产品名「空谷」「Ondra」、官网内容均为星玖工作室自有资产，随本项目按 AGPL-3.0 分发。AGPL-3.0 授予的是代码权利，不授予商标使用权。二次分发不得使用本项目名称与图标暗示官方背书。

### 19.4 免责声明

本软件按「现状」提供，不附带任何明示或暗示的保证。在适用法律允许的最大范围内，作者与版权持有人不对使用本软件造成的任何损害承担责任，包括但不限于数据丢失、设备损坏、业务中断。

本产品是陪伴工具，不是心理治疗、医疗服务或专业建议的替代品。应用内人格为虚构角色设定，不代表任何真实人物的立场。

---

## 二十、NOTICE 开源合规声明

本项目的完整开源合规声明见 [NOTICE](NOTICE)，与本章互为补充。NOTICE 包含：

1. 本项目版权与许可声明，含 AGPL-3.0 的英文法律原文。
2. 上游 DeepSeek Harness 的 MIT 许可与版权声明全文。
3. 品牌与设计资产的归属与派生说明。
4. 源码内置依赖（`vendor/`，9 项）的逐项披露，含上游提交与本地修改记录。
5. 运行时依赖（121 项）的逐项披露，含版本、许可证、版权方、官方地址。
6. 开发期依赖（75 项）的披露与非分发声明。
7. 非 npm 依赖（Node.js 运行时、Python 发行版、Python SDK、平台载荷）的披露。
8. 非宽松许可证组件的兼容性分析与义务说明。

### 20.1 合规要点速览

| 事项 | 状态 |
| --- | --- |
| 上游 MIT 版权声明保留 | 已保留，见 19.2 与 NOTICE |
| 本项目自身版权声明 | 已声明，AGPL-3.0 |
| 运行时依赖逐项披露 | 121 项，见 6.3 与 NOTICE |
| 开发期依赖披露 | 75 项，见 6.4 与 NOTICE |
| 传递依赖披露 | 记录于 `pnpm-lock.yaml`，可 `pnpm licenses list` 复核 |
| 源码内置依赖披露 | 9 项，见 NOTICE 与 `vendor/README.md` |
| 第三方许可证原文 | 随各包保留于 `node_modules`；`vendor/` 内各项保留独立 `LICENSE` |
| 修改他人代码的标注 | `vendor/` 内各项记录于 `vendor/README.md`；上游代码改动见本文档与提交历史 |
| 素材来源 | 图标与品牌资产为自有设计，未使用第三方素材 |
| 无法确认的版权归属 | 依赖清单中标注「见包内 LICENSE」，未做推断 |

### 20.2 复核方式

```bash
# 校验第三方声明与依赖树是否一致
pnpm run verify-third-party-notices

# 重新生成第三方声明
pnpm run gen-third-party-notices

# 列出全部依赖的许可证
pnpm licenses list

# 校验包元信息
pnpm run verify-package-meta
```

---

## 附：相关文档

| 文档 | 内容 |
| --- | --- |
| [README_EN.md](README_EN.md) | 英文完整版，章节与本文一一对应 |
| [NOTICE](NOTICE) | 开源合规声明与完整依赖披露 |
| [LICENSE](LICENSE) | AGPL-3.0 全文 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 自动生成的第三方依赖清单 |
| [SAFETY.md](SAFETY.md) / [SAFETY.zh.md](SAFETY.zh.md) | 安全说明 |
| [AGENTS.md](AGENTS.md) | 面向自动化的仓库约定 |
| [packages/README.md](packages/README.md) | 包分组说明 |
| [vendor/README.md](vendor/README.md) | 源码内置依赖的上游提交与修改记录 |
