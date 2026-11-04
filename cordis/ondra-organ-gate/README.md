# ondra-organ-gate

> O-138 · 〔研〕自研 · 手册 §8.6「上下文经济」 · P0 · 批次 B6（运行时治理）
> 服务键 **`ondra-organ-gate`**（连字符，符合 §8.4）

## 一、职责

按本轮用户原话做**确定性意图路由**，把这一轮用不到的工具从该 agent 的 schema 视图里摘掉。

一句话概括动机：**96 个插件全量注册工具时，还没开口，上下文已经被工具说明书吃掉一半。**
手册实测 48 条命令 `55,154 → 8,433` schema token（84.7%）。

做法只有一步：`agent.ctx.tools.restrict({ deny })`。它是上游的正规接缝，作用在**单个
agent 的作用域**上，只改「这个 agent 能看见哪些工具」，不改任何工具的实现，不动全局注册表。

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 不做工具输出的裁剪 / 沙箱 | 手册 §8.6「工具输出沙箱」，归上游 `compaction-tool-result-pruner` / `ctx.toolResultPruner` |
| 不做失败归因与重试裁决 | O-139 `ondra-failure-attrib` |
| 不做提示词拼装与预算 | O-036 `ondra-prompt-inject` |
| 不做前缀缓存与压缩时机 | O-033 `ondra-dialogue`（§8.5） |
| 不注册任何工具 | 门控的意义就是**少**给 schema，自己再塞一个进去是自相矛盾 |
| 不写提示词、不调模型、不落盘 | — |
| 不改上游、不改别的插件 | §16.3 |

### 三条刻意的「不做」

1. **不用 `restrict({ allow })`。** 它更彻底（只给白名单），但会把**本插件不知道的新工具**
   （后装载的器官工具、别的插件临时注册的工具）一起藏掉。这种错误不报错，只让模型
   觉得「我没这个能力」，然后编一个替代路径。**摘已知的、留未知的，错的那一半是安全的。**
2. **不装定时器。** 门控只发生在 `agent/pre-step`。装了定时器，一个没人用的插件也在偷偷烧 CPU。
3. **不给模型加「查询门控状态」的工具。** 那会占 schema，与本包的立身之本相反。
   状态走服务键，给界面与审计看。

## 三、为什么它是**策略层**而不是器官

B6 是「器官 ABI 运行时」批次，所以这一条必须交代清楚：**本包不是器官，理由在门面里。**

`ondra-organ-host` 交出的门面只有十个成员：`state / consume / emit / proposeGap /
onToolResult / onTick / registerTool / onPrompt / kv / log`。其中：

- **没有 `restrict`。** 器官结构上无法摘工具视图，这是刻意的（门面越窄，ABI 越硬）。
- **没有「这一步的用户原话」。** `state()` 给的是世界状态，`onPrompt` 是**申报**片段（出），
  不是读入。门控要在模型推理之前知道用户说了什么，而 ABI 里没有这条通道。

硬做成器官只有两条路：给 O-132 加接口（它已 `done`，§16.3 不许动），或让本包绕过门面
直接拿裸 ctx（那 ABI 就形同虚设）。两条都不做。**本包按策略层实现，与上游
`timeout-policy` / `permission-presets` 同类：它们也不是器官。**

## 四、服务键与依赖

| 依赖 | 强度 | 缺席时 |
|---|---|---|
| `tools`（上游工具注册表） | 硬 | 服务仍注册，`available=false`、`reason='no-tools'`，每次调用不做事并记 `no-tools` |
| `ondra-identity` | 软 | 日志命名空间退回 `ondra.organ-gate` |
| `ondra-clock` | 软 | 用 `Date.now()` |
| `ondra-config-schema` | 软 | 用插件实例配置 + 内置默认值 |

**不依赖 O-132。** 门控与器官宿主没有调用关系（理由见第三节）。

`ctx.get('tools')` 每次现取，不在 `apply()` 里快照——装载顺序由用户配置决定，
快照会让「后装载」永远拿到 `undefined`。

## 五、门控算法（判定顺序即接口）

```
模式 off              → 不做事
没有用户原话          → 不做事（意图未知）
可见工具 < 门槛(8)    → 不做事（没什么可省，风险却是实的）
一条规则都没命中      → 不做事（认不准就全给）
命中但一个都没匹配    → 不做事（规则表与真实工具名对不上，单独计 no-match）
没有可摘的            → 不做事
会摘到只剩 < 下限(4)  → 不做事（熔断）
会摘掉 > 上限(90%)    → 不做事（熔断）
否则                  → 摘
```

两个细节值得单独说：

- **「没命中」与「命中但没匹配上」是两种放弃。** 前者说明这轮本来不该门控；后者说明
  **规则表坏了**（前缀拼错、工具改名）。并成一个，规则表写错就永远查不出来。
- **每轮先撤再算。** 顺序反了就是不会报错的慢性 bug：`schemas()` 读到的是被自己削过的
  视图，于是「该给的」越算越少，某轮只给两个工具之后再也回不来。

### 默认规则表（8 条）

| 规则 | 抓什么 | 工具模式 |
|---|---|---|
| `fs-read` | 看、读、搜、找、日志 | `read` `read_image` `glob` `grep` `lsp` `session_search` |
| `fs-write` | 改、写、删、替换、重构 | `edit` `write` `str_replace_editor` |
| `shell` | 跑命令、装依赖、构建、测试 | `bash` `pwsh` `terminal_*` `load_workspace_dependencies` |
| `web` | 联网、网页、下载、抓取 | `web_search` `web_fetch` `stagehand_*` |
| `agent` | 分工、并行、后台 | `subagent` `spawn_teammate` `team_task_*` `job_*` … |
| `plan` | 计划、待办、目标、提醒 | `todo_write` `create_goal` `schedule_*` … |
| `mcp` | 外部 MCP 资源 | `list_mcp_resources` `read_mcp_resource` … |
| `meta` | 插件、技能、市场 | `plugin_manager` `plugin_market` `skill` … |

工具名全部来自 `desktop/docs/tool-catalog.zh.md` 里**真实注册**的名字，不是编的。

### 永远不摘

`run_code`（上游保留传输名，`restrict()` 对它直接抛错）、`ask_user_question`、
`present`、`propose_action`、`exit_plan_mode`。

判据：它们是**说话的方式**，不是**做事的能力**。摘掉 `ask_user_question`，
模型遇到歧义就只能瞎猜；摘掉 `exit_plan_mode`，plan 模式会卡死。

## 六、配置

段键 `organ-gate`（O-005 配置真源），字段键全连字符。

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `observe` | `off` / `observe`（只算不拦）/ `enforce`（真摘） |
| `min-tools-to-gate` | 8 | 可见工具少于它就不门控 |
| `min-keep-tools` | 4 | 摘完至少剩这么多，否则整轮放弃 |
| `max-deny-ratio` | 0.9 | 摘掉比例超过它就放弃 |
| `chars-per-token` | 4 | 只用于报告里的估算，不参与决策 |
| `report-limit` | 50 | 决策留痕条数（只在内存） |
| `never-deny` | `[]` | 额外硬保护的工具名 |
| `intent-chars` | 200 | 取用户原话最多看多少码位 |
| `verbose` | false | 每步一行日志 |

**没有 `enable` 字段。** `mode: 'off'` 就是关。再给一个开关会出现
「`enable=true` 但 `mode=off`」这种两个字段打架的配置，谁赢要靠读代码才知道。

## 七、服务面

```ts
ctx.get('ondra-organ-gate')
  .available      // 模式非 off 且 tools 在位
  .reason         // 'mode-off' | 'no-tools' | undefined
  .mode           // 当前模式（可观测：§14.2 不许黑箱切换）
  .rules()        // 内置规则表（只读，供审计）
  .plan(text, tools)  // 纯计算，不动状态：界面预览 / 单测 / 审计都走它
  .report(limit)  // 最近 N 条决策（新的在前）
  .last()         // 最近一条
  .stats()        // 步数 / 计划数 / 生效数 / 放弃数 / 省下码位 / 各原因计数 / 各规则命中数
  .dispose()      // 撤掉所有 agent 上的限制，清空留痕，幂等
```

## 八、隔离五问（§16.4）

1. **关掉我，谁受影响？** 只有我自己：工具全量暴露（回到门控前的状态）。没有任何插件
   依赖我的服务，`ctx.get('ondra-organ-gate')` 拿到 `undefined` 就降级。
2. **我的状态存在哪？** 只在内存：每个 agent 一个 `{ turn, decision, lift }`，加一份
   决策留痕。**不落盘**——门控决定是这一轮的事，重启后重算即可。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.organ-gate`；服务上
   `available` / `reason` / `stats().byReason` 三个读数。`agent/pre-step` 里的异常
   一律降级为「本轮不门控」并打 `warn`，**绝不让对话卡住**。
4. **我依赖谁？缺席时怎么降级？** 见第四节。硬依赖只有 `tools`，缺席时服务仍注册、
   `available=false`，不静默消失。
5. **我和同域的谁共享了可变状态？** 没有。规则表是冻结常量，`restrict` 的撤销器
   只由本包持有；`schemas()` 是只读。

## 九、多方案分支说明（§12）

| 能力 | 方案 | 处理 |
|---|---|---|
| 门控方向 | A 摘黑名单（本包默认） / B 只给白名单 | **A**。B 会把本插件不知道的新工具一起藏掉，错误不可见（见第二节） |
| 意图来源 | A 关键词规则（确定性） / B 小模型分类 | **A**。B 要调模型，而本包存在的理由之一就是省 token；且 B 的每个决定不可解释 |
| 触发时机 | A `agent/pre-step`（每步） / B `agent/created`（每会话一次） | **A**。会话级一次会把「读文件」那轮的意图锁死到整个会话 |
| 模式 | 三档 `off/observe/enforce` | 不是分支，是迁移档位；默认最稳的 `observe` |

## 十、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 工具 schema 门控 | agent-body | `github.com/1420079678-ctrl/agent-body` | MIT | 「神经脉冲」先于模型推理把句子转成意图、按需暴露工具；48 条命令 55,154→8,433 的实测口径 | 自研 `rules.ts` + `gate.ts`：关键词规则表 → 工具族 → deny 名单 | 否 |
| 按作用域限制工具 | DSH 上游 `@ntars/ondra-tools` | 本仓 `desktop/packages/core/tools` | 随仓 | `restrict({ deny })` 的作用域语义、`schemas(scope)` 的读取口径、`run_code` 保留名的硬约束 | 直接调用上游服务（这是「复用」，不是自研） | 否（只调服务） |
| 意图脉冲 | agent-body | 同上 | MIT | 「确定性规则先于模型」这条设计取向 | 关键词命中 + 尾部星号模式，纯函数 | 否 |
| 迁移期双模式（影子跑） | DSH 器官宿主（O-132 §8.2） | 本仓 `cordis/ondra-organ-host` | 随仓 | `shadow` 先记账再真扣的迁移纪律 | `observe` 先算不拦，翻 `enforce` 才真摘 | 否 |

档位判定：**〔研〕自研**。生态里的「按需工具」几乎都是**会话级**的（一开始就给一份固定
子集），而本包要的是**轮次级**、且规则必须可审计到「因为出现了这两个字」。
没有现成实现同时满足这两条，故自研；但**执行动作完全复用上游 `restrict`**，
自研的只有规则表与判定顺序。

## 十一、已知限制

1. **默认 `observe`，所以默认不省 token。** 这是刻意的：规则表没在真实会话里跑过
   （本轮禁止实装运行），先看报告再翻 `enforce`。**这是本包最大的一个「未生效」。**
2. **token 数是估算。** 本包不做分词，`estTokens = chars / charsPerToken`。
   `chars` 是精确的，`estTokens` 不是。手册那个 84.7% 是别人拿真 tokenizer 量的，
   **本包不冒用**。
3. **规则表不懂语义。** 「不要读文件，直接跑测试」会同时命中 `fs-read` 与 `shell`，
   于是两族都给——结果偏保守（多给），不是偏危险（少给）。否定句没有特殊处理。
4. **一轮之内只按第一句的意图门控。** 中途步骤（工具结果回来之后）没有用户消息，
   重新算会把意图误判成「未知 → 全给」，所以沿用本轮第一次的决定。**一轮里意图变了，
   后半程不重新门控。**
5. **摘不掉 agent 作用域内注册的工具。** 上游明确「viewing scope's own registrations
   remain exempt」。这类工具本包看不见也摘不掉，`schemas()` 里本来就没有它们。
6. **看不见别的插件加的限制。** 只撤自己那层；别的插件（如 `browser-use-runtime`
   的 MCP 屏蔽）加的限制照旧生效，本包不越权解除。
7. **子代理按各自 agent 分别处理。** 若上游不为子代理发 `agent/pre-step`，子代理不门控。
   本包不猜事件，只处理收到的。
8. **`intent-chars` 截断会漏掉后文的意图。** 200 码位之后的转折句（「另外，顺便……」）
   不参与路由。截断是为了压误命中率，代价是漏。

## 十二、待裁决

1. `min-tools-to-gate 8` / `min-keep-tools 4` / `max-deny-ratio 0.9` **三个数手册没有出处**，
   是本包按「不许摘到危险区」补的工程取值。
2. **默认 `observe` 是否可接受？** 它是 P0 项，却默认不生效。理由与 O-132 的
   `charge-mode: shadow` 一致：先记账再真扣。若主人认为 P0 必须默认生效，
   改一个默认值即可（`settings.ts` 的 `FIELD_SPECS.mode.default`）。
3. **`always-keep` 那五个名字**（`ask_user_question` / `present` / `propose_action` /
   `exit_plan_mode` / `run_code`）里，前四个是本包按「说话的方式」判的，手册没有列。

## 十三、自查

见 `ondra-plugin-index.md` 的「产出登记（第 73 轮）」。本包首轮静态自检 9 项 + 语言 5 项
全过；交叉扫描 0 环、0 越界、服务键 0 冲突。
