# 空谷 Ondra · 插件总纲（ondra-master-plan）

> 本文件是「插件拆分」的规则真源，只定义**怎么拆、怎么接、谁不能碰谁**。
> 具体执行清单与进度见同目录 `ondra-plugin-index.md`。
> 编制依据：对 `/Volumes/Expand/Material` 的全量扫描与精读（见第 1 节）。
> 编制日期：2026-10-31

---

## 0. 这份文档要解决什么

主人点出四类风险：**遗漏技术、分工不清、交叉调用、混乱**。本文件逐个治：

| 风险 | 治理手段 | 在哪一节 |
|---|---|---|
| 遗漏技术 | 双向覆盖校验：旧 40 包 → 新插件，创新 92 方案 → 归属插件，缺一即报缺口 | §7 |
| 分工不清 | 每个插件必须写「职责」与「明确不负责」两栏，不写清不许开工 | §5 |
| 交叉调用 | 分层依赖矩阵 + 服务键单一真源 + 禁止横向 import | §4、§6 |
| 混乱 | 固定批次顺序 + 台账逐项勾选 + 每轮只做一项 | §8、见 index |

---

## 1. 素材地图（扫描结果，2026-10-31）

| 路径 | 体量 | 性质 | 它能提供什么 |
|---|---|---|---|
| `Ondra/` | 5.5 GB | **旧项目本体**（可编译工作树） | 40 个 `@ondra/*` 包源码、Electron 壳、11 份 docs、personas |
| `Ondra/packages/` | 40 包 | 插件实现 | 契约、服务键、算法、配置默认值、测试 |
| `Ondra/docs/ARCHITECTURE.md` | 80 KB / 17 章 | 架构设计定稿 | 八条设计原则、子系统设计、失败降级矩阵 |
| `Ondra/docs/DECISIONS.md` | 92 条 | 决策记录 | 每条含「结论/理由/反例」，拆分约束全在此 |
| `Ondra/docs/TECH-RESEARCH.md` | 809 行 | 实测底账 | 流式形状、隐私开关、profile 机制实测结论 |
| `Ondra/docs/ROADMAP-STATUS.md` | — | M0–M8 对照 | 已完成 / 部分 / 未做，缺口位置 |
| `空谷Ondra-断奶包-全量复现手册.md` | 2.8 MB / 69269 行 | 单文件全量复现 | **第 6 章 = 40 包逐条契约**（最高密度），第 5 章装配机制，第 11 章 17 条坑 |
| `Ondra-拟人化方案-情感记忆拟人.md` | 62 KB | E/M/P 三层设计 | 情感维度和数据结构、三通道记忆、图谱四边、前瞻记忆、表达映射表 |
| `Ondra-创新方案.md` | 60 KB | 92 个方案 | 方案 1–92 逐条机制，扩展插件池的来源 |
| `Ondra-技术全景清单.md` | 101 KB | 18 域 306 仓库 | 技术选型池、许可矩阵、已实现/计划/调研分级 |
| `记忆系统-实现规范.md` 等 4 份 | 100 KB | 记忆方案 | 小满 / 糯糯 / 鲸汐 / 通用实现规范、做梦机制、神经元结构 |
| `Ondra-UI重构方案-HIG×QQ×Morphicons.md` | 40 KB | 界面规范 | 三栏 IA、7 档标题、5 层灰阶、44 图标、18 个组件规格 |
| `Ondra-旧项目迁移方案.md` | 20 KB | 九大机制移植规格 | 世界书/关系/过滤/节奏/日记/环境/承诺/检索/主动的精确参数 |
| `Ondra-全面体验与痛点逐条清单.md` | 44 KB | 66 条痛点 | P0–P3，每条痛点对应一个应当存在的功能 |
| `Ondra-新旧对比-缺陷与技术缺口.md` | 20 KB | 缺口盘点 | 已实现但未接线、写在文档但没代码的部分 |
| `Ondra-标题栏方案-macOS.md` | 16 KB | 壳细节 | hiddenInset、44px 拖动区、红绿灯避让 |
| `旧项目备份/NT-Dpet/`、`NT-Sine/` | 1.9 GB | 更早前身 | 机制原型（五阶段关系、冲突锁、记忆抽取来源） |
| `素材/万年历算法js.zip` | 758 KB | 算法资产 | `ondra-live` 的农历/节气/干支实现来源 |
| `素材/morphicons/` | — | 图标资产 | 12 组 morph 配对动画 |
| `素材/人格设定.md`、`构建提示词.md`、`工作规范.md` | — | 约定 | 人格与工程约定 |
| `APPA-QQ机器人部署教程.md`、`QQ防封控.md` | 32 KB | 通道实操 | NapCat 部署与风控边界 |
| 各种 `*.zip`（大肥鱼整套、灵枢记忆库、极简记忆模组、小鲸鱼接入） | 10 MB | 外部方案包 | 记忆与人设的外部实现参考 |

**不在本次范围**：`旧项目备份/NT-Sine/模型权重`、`素材/Xael-迁移方案`（属玄玖灵犀项目，与 Ondra 无关）。

---

## 2. 真源优先级（冲突时听谁的）

向下递减，高层不得推翻低层：

1. **代码** `Ondra/packages/*/src` —— 记录「现在是什么」。
2. **断奶包手册第 6 章** —— 40 包的契约与实现状态总览。
3. **`ARCHITECTURE.md` + `DECISIONS.md`** —— 记录「为什么这么定」。
4. **方案类文档**（拟人化 / 创新 / 记忆 / UI 重构）—— 记录「打算怎么做」，未实现。
5. **痛点清单与新旧对比** —— 记录「哪里坏了、哪里缺」。

**已知滞后必须记住**：`DECISIONS.md` 决策 88 仍写旧命名（`NT-Dpet` / `@nt-dpet/*` / `NTDPET_`），代码里已是 `空谷 Ondra` / `@ondra/*` / `ONDRA_`。**以代码为准，不为「文档一致」去改代码。**

---

## 3. 插件形态总则

### 3.1 形态

每个插件是一个独立的 Cordis 插件包（与 APP 官方插件同构），目录与包名统一 `ondra-<kebab-短名>`，注册的服务键统一 `ondra:<短名>`。

### 3.2 目录结构（对齐 `desktop/packages/experimental/badge-skill-bundle` + 手册 §8.3）

```
ondra-<name>/
├── package.json      # name: ondra-<name>; type: module; main: lib/index.js
│                     # ★ 必须含 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├── tsconfig.json     # NodeNext + strict; rootDir src; outDir lib
├── cordis.patch.yml  # ★ 必需，缺失即静默不加载（手册 §8.3-1）
├── src/index.ts      # export const name / inject / apply(ctx) / Config
├── locale/en.json    # meta.title / meta.description
├── locale/zh.json
├── README.md         # 职责 / 不负责 / 服务键 / 配置 / 边界 / 已知限制
└── icon.svg          # 可选，自包含几何图形
```

**手册 §8.3 三条静默失败（必须逐条防住）**：

1. `package.json` 漏 `dsh.bundle.patch` → 宿主只在 stderr 打一行 `skipping profile bundle ... declares no dsh.bundle`，包在 `node_modules` 里、bundles 里也写了名字，**但插件永远不加载**。这是最隐蔽的失败。
2. 补丁语义：`insert` 无 `id` → 追加根入口列表；`insert` 带 `id` → 目标必须是 `group: true`；无 `insert` 的补丁行 → 必须给 `id`；目标不存在 / 不是 group / `name` 不一致 → 只告警然后**跳过**。
3. 入口字段只有六个：`id / name / config / group / disabled / inject`。`id` 就是命名空间（工具名、存储目录、日志前缀都靠它），`name` 必须与安装后的包名完全一致。

### 3.3 六条硬约束（旧项目四条 + APP 规范一条 + 手册第六条）

1. **包间不互相 import**：一律 `ctx.get('ondra-xxx')`，取到 `undefined` 就静默降级（`if (!svc) return`）。
2. **默认给好，全部可调**：每个参数有合理默认值；简单模式四档（关闭/缓慢/标准/快速），高级模式才露具体数值。
3. **失败静默降级**：增强能力挂了，主对话必须还能进行，降级不弹错、不阻断。
4. **可逆注册**：定时器、监听器、路由、UI 面板全部经 `ctx.effect()` / `ctx.on()` 注册并返回 disposer，卸载即撤销。
5. **单一真源**：数据结构、默认值、算法只存在一份，由提供方拥有，消费方只读。
6. **命名硬约束（手册 §8.4）**：**服务键、工具名、配置键必须匹配 `^[a-z][a-z0-9_-]{1,63}$`**。
   - 含义：**服务键用连字符，不用冒号**——`ondra-memory-core` ✅ / `ondra:memory-core` ❌（冒号不匹配正则，模型侧会直接拒绝）。
   - 旧项目的 `ondra:xxx` 属历史写法，新插件一律改成连字符。

### 3.4 器官 ABI（手册 §8.1，插件体系的宪法）

**三条不可让渡约束**：

- **C1**：器官永不直接写状态，只能 `feedback()` 提议，宿主统一 apply。
- **C2**：器官必须为自己的感知付能量且允许被拒绝（`EnergyReceipt` 状态机 `full | partial | starved | shadow`；`denied=true` 时必须立刻放弃本次感知）。
- **C3**：器官错误不得传播（外层 try/catch，异常转 `degraded` 返回空）。

**ctx 是门面，不是裸 ctx**：只暴露 `state(只读) / consume / emit / proposeGap / onToolResult / onTick / registerTool / onPrompt / kv / log`。裸 ctx 能 `on('llm/stream')`、能全量 `tools.register`、能拿别人的服务，ABI 就形同虚设。

**另四条**：

- 能力白名单 **default-deny**：调了没声明的东西抛 `CapabilityDeniedError`，不是静默忽略。
- 反馈仲裁：多个器官的 Δ 值**累加后一次性 apply 再 clamp**；逐条 apply 会让后面的器官看到前面的结果，产生顺序依赖。
- 提示词拼装：各器官申报片段带 `order / ttl / confidence`，按 order 排序、过滤过期与低置信度；**疤痕永远在 -1e4，器官不得低于 -1000**。
- 反模式六条：①器官自己 `setState`；②在 `getPromptContext()` 里做 IO 或调模型（**每次组装提示词都会被调用**）；③器官间用全局变量通信；④在 `feedback` 里做超过 50ms 的计算（在工具返回临界路径上）；⑤把"能力"（如意志）做成器官；⑥WebUI 提供写接口。

### 3.5 前缀缓存三原则（手册 §8.5，省 97.7% 成本）

实测：5 个真实会话 2001 次请求 / 6.45 亿 input tokens，缓存命中 **99.3–99.6%**，成本 ¥879.97 → **¥19.96**。

1. **会话内冻结前缀**：稳定段（人格 + 世界书常驻）冻结在会话开头，易变段（日期 / 情绪）**追加到尾部**。
2. **只追加增量**。
3. **压缩只发生在用户回合边界**。

> **这条直接否掉「每轮重拼 system prompt」的写法**：`ondra-dialogue` 每轮重拼会让命中率接近 0。这是"改一行省 90% 成本"的地方，插件实现必须遵守。

### 3.6 分级自动审批三档（手册 §8.7）

`监督`（每个高风险都弹确认）/ `自动`（低风险直接执行，高风险确认）/ `全自动`（免审批但**自动开启沙箱写边界，可回滚**）。关键细节：**`organ_*` 工具也算"自己人"**，自己造的器官调自己的工具不该弹确认。作为全局配置项，与 `privacy` / `startup-check` 同级。

### 3.7 拆分粒度判定（防止越拆越细）

一个功能**同时满足**下列三条才独立成插件，否则并入宿主插件：

1. 有独立的服务键，能被别的插件按名字查找；
2. 能独立启停而不导致宿主插件崩溃（关掉它，其余功能照跑）；
3. 有独立的失败域（它坏了，界面能说清是哪一块坏了）。

**反例（不拆）**：`filter-passes.ts` 里的单条正则不拆（属 `ondra-filter-chain`）；`persona.md` 的解析函数不拆（属 `ondra-persona-loader`）。

---

## 3.8 三档复用（手册 §1.8，替代原「全部自研」）

> 手册强制：**96 项清单重排为「复用 / 薄封装 / 自研」三档，自研压到 15 个以内。**

| 档位 | 含义 | 落地方式 | 代表项 |
|---|---|---|---|
| **复用** | 生态成熟，直接用 | 插件只做接线、配置与降级，不重写机制 | QQ/微信/飞书通道（≥5 个 QQ 通道）、语音合成（102 个）、视觉/OCR（161 个）、桌宠（dsh-pet / agentpet / airi）、插件市场（dsh-market）、UI 骨架/图标（1558 个）、农历（lunar-javascript / tyme4ts）、记忆底层存储/检索/去重/衰减（344 个中选型） |
| **薄封装** | 有可用实现，但要包一层适配 | 保留外部实现，插件负责契约转换与护栏 | 语言锁（dsh-language-guard）、CoT 锚（dsh-cot-anchor）、输出评审（dsh-answer-reviewer）、心跳（dsh-proactive 改造 + 墓碑折叠）、生活日志（dsh-simulated-life）、证据门控（distill-kura 思路自写闸门） |
| **自研** | 生态没有或只有雏形 | 完全自写，允许写厚 | 七阶关系弧 + 防跃迁 + 冲突锁、人格生成论阈值漂移、语感统计、九步输出过滤、节制设计、器官 ABI 运行时、O-138~O-144 七个治理插件（合计 < 15 个） |

**判定纪律**：动手前必须先查生态（GitHub + DSH 插件目录），在 README「技术来源」表写明档位与依据；**能复用却自研 = 违规**，必须给出理由（如许可证不兼容、语义不匹配）。

### 3.9 P0 三条（手册 §12.1，比立绘/语音/界面都更早被用户感知）

**如果只能做三件**：

1. **寿命计算**（11 类基线乘积式）；
2. **召回不按条数砍**（`dropped` 恒为 0）；
3. **禁止报数铁律**（内感受不得报数值）。

完整 9 条 P0：寿命计算（#1/#2）、召回不许按条数砍（#3）、八池铁律（#10）、缺口池张力（#13）、禁报数铁律（#16）、阈值漂移（#17）、应激倍率（#21）、唤醒身份纪律（#25）、器官 ABI（#26）。

**阻塞关系**：先建 `ondra-llm-gateway`（O-035），`O-011` extract / `O-014` recall 扩展 / `O-019` dream 全部等它的模型调用路径。

---

## 4. 分层骨架

上层可以依赖下层，**下层绝不反向依赖上层**；同层之间只许经服务键通信，不许 import。

| 层 | 名称 | 内容 | 崩溃后果 |
|---|---|---|---|
| L0 | 基座 | 命名、路径、日志、配置真源 | 谁也不知道出了什么问题 |
| L1 | 存储 | SQLite 端口、内存兜底、快照、迁移 | 记忆回不来 |
| L2 | 内核 | 记忆域、人格域、情绪域 | 对话质量下降，但还能说话 |
| L3 | 对话链 | 对话编排、协议、模型网关、注入、过滤 | 不能说话 |
| L4 | 表达与生活 | 节奏、口语、主动、日记、语音、贴纸、形象 | 没有语音/表情/生活感 |
| L5 | 通道 | 路由、公共段、探针、10 个适配器 | 某一渠道收不到消息 |
| L6 | 端侧 | adb、MCP、浏览器、GUI、桌宠 | 某项扩展不可用 |
| L7 | 系统与交付 | 隐私、自检、市场、安装器、进程托管、引导 | 装不上或起不来 |
| L8 | 界面 | 页面骨架、令牌、图标、接口、各视图 | 白屏 |
| L9 | 扩展池 | 创新方案里可独立成件的想法 | 无影响（默认关闭） |

> 分层依据沿用旧项目「按生命周期与崩溃半径分组」，不按功能多少分。

---

## 5. 插件清单

> 每项格式：`插件名` ｜ 职责 ｜ **明确不负责** ｜ 提供服务键 ｜ 依赖服务键 ｜ 来源 ｜ 优先级。
> 优先级：P0 = 对话能跑起来的最小闭环；P1 = 完整产品体验；P2 = 扩展与打磨。
> 完整可勾选表格见 `ondra-plugin-index.md`，本节只写**边界规则**，逐项定义以 index 为准。

### L0 基座（5）
| 插件 | 职责 | 明确不负责 |
|---|---|---|
| `ondra-identity` | 产品名、进程名、pidfile 名、环境变量前缀的**唯一真源** | 不做路径创建、不读文件 |
| `ondra-path-layout` | 数据根解析（`app-home` / `agents` / `user` / `tmp` / `logs`）、目录创建、0700/0600 权限 | 不决定目录叫什么（问 identity） |
| `ondra-log-zh` | 中文日志：概览层（给人看）+ 代码级层（开发者模式才可见）、4MB×3 轮转、环形缓冲 | 不上报、不落远端 |
| `ondra-config-schema` | 配置四层结构与全部默认值的单一真源 | 不做界面、不做持久化 |
| `ondra-clock` | 统一时间源与「自然日」判定（关系天数去重依赖它） | 不算农历（属 live） |

### L1 存储（4）
| 插件 | 职责 | 明确不负责 |
|---|---|---|
| `ondra-store-sqlite` | `node:sqlite` 端口实现：WAL、外键、建表、`addColumn` 补列、chmod 0600 | 不管业务表结构（由域插件声明） |
| `ondra-store-memory` | 内存实现，SQLite 打不开时的兜底（决策 92） | 不持久化 |
| `ondra-snapshot` | 记忆快照：`VACUUM INTO`、KEEP=3、显式 `restore()` | **绝不自动恢复**；不备份会话与情绪 |
| `ondra-data-migrate` | 幂等初始化与版本迁移 | 不改用户手改过的记录 |

### L2 记忆域（10）
`ondra-memory-core`（读写与管理入口）、`ondra-memory-extract`（LLM 提炼 + 五级解析兜底）、`ondra-memory-dedupe`（去重裁决）、`ondra-memory-decay`（衰减与容量淘汰）、`ondra-memory-recall`（三层检索打分）、`ondra-memory-graph`（图谱四边）、`ondra-memory-prospective`（承诺与待办前瞻）、`ondra-memory-audit`（遗忘可解释 / 钉住 / 忘掉）、`ondra-memory-humanlike`（三通道权重与随机回顾）、`ondra-memory-dream`（做梦：重放与巩固）。

**边界铁律**：记忆域不读情绪、不读人格、不调 LLM 网关以外的东西；情绪值由调用方以参数传入，记忆域自己不取。

### L2 人格域（6）
`ondra-persona-loader`（**读 `cordis/ondra-persona-skills/*.skill.zip` 并注册为可用人设**，人设包本体只读不写）、`ondra-persona-core`（L1 内核 + 五关系变体）、`ondra-persona-vars`（变量替换与浓度提示）、`ondra-persona-assemble`（四段拼装 + 预算裁剪）、`ondra-worldbook`（六层世界书选择器）、`ondra-worldbook-scenes`（场景卡数据与触发规则）。

**边界铁律**：拼装顺序恒为「内核 → 关系微调 → 浓度 → 边界」，`priority` 只用于超预算时决定先砍谁；边界层整层豁免裁剪，宁可返回 `overBudget: true` 也不悄悄少一条禁令。

### L2 情绪域（7）
`ondra-emotion-core`（状态容器 + 惰性回归 + 落盘判定）、`ondra-emotion-diffuse`（跨会话弥散）、`ondra-emotion-stage`（七阶关系弧与防跃迁）、`ondra-emotion-stress`（应激倾斜）、`ondra-emotion-conflict`（冲突锁定与解除）、`ondra-emotion-express`（状态 → 六段语域映射）、`ondra-emotion-project`（情感投影，注入用户消息尾部）。

**边界铁律**：情绪只提供数值与语域码，**不生成文本**；表达约束的落笔在 `ondra-dialogue`、时长参数在 `ondra-rhythm`、闸门阈值在 `ondra-tts-gate`。

### L3 对话链（5）
`ondra-dialogue`（编排：取上下文 → 组装 → 流式 → 收尾）、`ondra-dialogue-protocol`（`text-delta` / `done` 帧格式）、`ondra-llm-gateway`（模型供给、密钥注入、超时与重试）、`ondra-prompt-inject`（注入位置与预算分配）、`ondra-filter-chain`（九步输出过滤）。

**边界铁律**：`ondra-dialogue` **绝不创建 APP Session、绝不写 `app_session_log`**——一旦建会话，隐私收益归零（决策 13）。

### L4 节奏与拟人（4）
`ondra-rhythm`（分条与停顿，纯计算无副作用）、`ondra-rhythm-typing`（打字速度、首条延迟、长停顿、自我修正）、`ondra-oral`（口头禅池、语气词、不完整句、标点习惯、长度分布）、`ondra-breath`（「正在输入」与呼吸感，单日上限）。

### L4 主动（3）
`ondra-proactive-gate`（时机 / 话由 / 分寸三闸门，**服务端权威**）、`ondra-proactive-quota`（额度、冷却、连续无回应衰减）、`ondra-proactive-reason`（话由排序：承诺到期 > 待办 > 近期事件 > 时间线 > 环境）。

**边界铁律**：闸门必须跨页面刷新持久；前端只轮询上屏，不自判。

### L4 生活感（5）
`ondra-diary`（每日第一人称日记，Markdown 一天一文件，不打扰）、`ondra-live`（日期事实：星期/农历/节气/节日，本机算）、`ondra-weather`（天气，需显式配坐标，取不到就不提）、`ondra-life-rhythm`（作息：深夜变慢、起床气）、`ondra-onthisday`（那年今日回忆）。

### L4 表达（5）
`ondra-tts`（合成通道：`say` / 本地 HTTP / 云端接口）、`ondra-tts-gate`（四闸门：开关 / 6–30 字 / 情绪强度 / 3 秒频控 + 连续两条后强制文本）、`ondra-expression-decide`（正文 → 表情，规则版）、`ondra-sticker`（贴纸包读取与分发，文件名即标签）、`ondra-avatar`（立绘：Live2D，静态降级）。

### L5 通道（13）
`ondra-router`（唤醒判断与多会话排队）、`ondra-channel-kit`（收 → 问人格 → 回，公共段）、`ondra-channel-health`（只读探针，界面不失明）、`ondra-adapter-qq-official`、`ondra-adapter-qq-napcat`、`ondra-adapter-wechat-official`、`ondra-adapter-wechat-kf`、`ondra-adapter-wechat-personal`、`ondra-adapter-wecom`、`ondra-adapter-feishu`、`ondra-adapter-dingtalk`、`ondra-adapter-telegram`、`ondra-adapter-discord`。

**边界铁律**：`channel-kit` **不做消息落盘**（跨渠道串味会毁人格连续性），**不做限流/重试**（各平台语义不同，交给适配器自己）。个人微信、NapCat 属高危通道，`enabled` 与 `confirmed` 必须同时为真。

### L6 端侧（8）
`ondra-adb`、`ondra-device-mcp`、`ondra-desktop-mcp`、`ondra-browser`、`ondra-gui-agent`、`ondra-minecraft`、`ondra-pet`、`ondra-pet-mobile`。

**边界铁律**：`device-mcp` / `desktop-mcp` 全部只读（剪贴板只返回类型与长度，不返回内容）；`gui-agent` 单步决策环、写操作逐条确认、检测到已填表单立即收手。

### L7 系统与交付（9）
`ondra-privacy`（合规告知与风控提醒，硬关在配置层）、`ondra-startup-check`（判定与报告，**不负责拒绝启动**）、`ondra-market`（组合包清单，只读）、`ondra-installer`（九步流水线）、`ondra-process-host`（子进程托管：detached + pidfile + 组杀 + 异常重启 1 次）、`ondra-window`（窗口与 macOS 标题栏）、`ondra-onboarding`（四段首启引导）、`ondra-port-picker`（9060–9079 回环挑端口）、`ondra-dev-rebrand`（Dev.app 改名换图标并逐层重签）。

### L8 界面（12）
`ondra-ui-shell`（三栏骨架与单页 DOM）、`ondra-ui-tokens`（设计令牌单一真源：色彩/字号/圆角/密度三档）、`ondra-ui-icons`（44 图标 + 12 组 morph 配对）、`ondra-ui-api`（`/api/ntdpet` 19 条路由 + token 自鉴权）、`ondra-ui-chat`（对话渲染、流式、时间分隔、富消息）、`ondra-ui-sessions`（会话列表、搜索、右键菜单）、`ondra-ui-panel`（右栏状态卡：情绪/记忆/关系/连接）、`ondra-ui-settings`（九 pane 设置面板 + 搜索 + 恢复默认）、`ondra-ui-a11y`（aria、键盘、焦点、对比度）、`ondra-ui-theme`（系统深浅色 + 日出日落回退）、`ondra-ui-toast`（分级 Toast、空态、骨架、错误重试）、`ondra-ui-logs`（中文简易日志视图 + 开发者代码日志）。

**边界铁律**：界面**只显示不自判**——自检结论由 `ondra-startup-check` 给出，界面不许自己判断「服务未就绪」并编一句提示语。

### L9 扩展池（不排入小时队列，核心完成后按需）
从创新方案 92 条里筛出「能独立启停、有独立失败域」的 24 项，见 index 第 9 组。默认全部 `enabled: false`。

---

## 6. 依赖矩阵（允许的调用方向）

`A → B` 表示 A 可调用 B 的服务；反向禁止。

| 消费方 | 允许依赖 |
|---|---|
| 记忆域各插件 | `ondra:store-*`、`ondra:llm-gateway`、`ondra:clock` |
| 人格域各插件 | `ondra:store-*`、`ondra:memory-core`（只读画像） |
| 情绪域各插件 | `ondra:store-*`、`ondra:clock` |
| `ondra-dialogue` | `ondra:memory-*`、`ondra:persona-*`、`ondra:worldbook`、`ondra:emotion-*`、`ondra:rhythm`、`ondra:live`、`ondra:llm-gateway`、`ondra:filter-chain` |
| `ondra-filter-chain` | `ondra:persona-core`（边界条目）、`ondra:emotion-express`（语域） |
| `ondra-proactive-*` | `ondra:memory-prospective`、`ondra:emotion-core`、`ondra:live` |
| `ondra-tts-gate` | `ondra:emotion-core` |
| 各 adapter | `ondra:channel-kit`、`ondra:router` |
| `ondra-channel-kit` | `ondra:dialogue`、`ondra:persona-core` |
| `ondra-ui-*` | 各域服务键（只读为主）+ `ondra:ui-api` |
| `ondra-ui-api` | 全部域服务键 |
| L7 各插件 | `ondra:identity`、`ondra:path-layout`、`ondra:log-zh` |
| L6 各插件 | `ondra:channel-kit`、`ondra:log-zh` |

**全局禁令**（写进每个插件 README 的「不负责」栏）：

1. 记忆域不反向读情绪、人格、界面。
2. 通道层不直接调 UI，不直接写记忆。
3. UI 不自己判定服务状态、不自己拼错误文案。
4. 任何插件不得 `import` 另一个 `@ondra/*` 包的源码（唯一例外：`channel-kit` 的类型导出）。
5. 任何插件不得创建 APP Session、不得写 `app_session_log`。
6. 任何插件不得把密钥写进配置文件。

---

## 7. 覆盖校验（不漏技术）

开工前逐项核对，缺一项就补插件或写进「明确不做」。

| 来源 | 项数 | 落点 | 状态 |
|---|---|---|---|
| 旧项目 40 个 `@ondra/*` 包 | 40 | 见 index 附录 A 映射表，每个旧包至少落一个新插件 | 待核 |
| 迁移方案九大机制 | 9 | 世界书→`worldbook`、关系→`emotion-stage`、过滤→`filter-chain`、节奏→`rhythm*`、日记→`diary`、环境→`live`、承诺→`memory-prospective`、检索→`memory-recall`、主动→`proactive-*` | 已落 |
| 拟人化 E/M/P 三层 | 3 层 19 节 | E→情绪域 7 包、M→记忆域 10 包、P→节奏/口语/主动/非语言/生活感/一致性守卫 | 已落 |
| UI 重构 18 个组件规格 | 18 | `ui-chat` / `ui-sessions` / `ui-panel` / `ui-settings` / `ui-toast` / `ui-shell` 分摊 | 已落 |
| `/api/ntdpet` 19 条路由 | 19 | `ui-api` | 已落 |
| 桌面壳组件 | 9 | `installer` / `process-host` / `window` / `onboarding` / `port-picker` / `dev-rebrand` / `identity` / `path-layout` | 已落 |
| 创新方案 92 条 | 92 | 24 条进 L9 扩展池；其余归入既有插件或标注不插件化 | 见 index 附录 B |
| 痛点清单 66 条 | 66 | 不新建插件，逐条落到对应插件的「验收要点」 | 待逐条落 |

---

## 8. 执行方式

1. 每轮只做一个插件，严格按 index 的批次顺序，不跳项。
2. 做完一个，把 index 该行状态改为 `done` 并记产出文件清单。
3. 每轮开工前先读 index，取第一条 `pending`。
4. 只写 `cordis/` 下的新目录，不改既有项目、不装依赖、不构建、不测试。
5. 遇到「必须改上游才能实现」的功能，不硬做：在插件 README 的「已知限制」写清阻塞点，状态标 `blocked`，并在 index 备注原因。

---

## 9. 已核实参数速查（代码级，可直接抄进 Config）

> 全部来自源码实读，不是方案文档的设想值。写插件时以此为准；方案文档与代码冲突时用代码值。

### 9.1 情绪（emotion，1687 行）

| 项 | 值 |
|---|---|
| 全局维度 | `mood` 0.5、`energy` 0.7、`stress` 0.15（初值） |
| 按人维度 | `affection` 0.1、`trust` 0.1、`intimacy` 0、`familiarity` 0、`tension` 0 |
| 回归公式 | `v(t)=baseline+(v₀−baseline)·e^(−λt)`，`λ=ln2/半衰期` |
| 半衰期四档 | fast 1h / **standard 4h（默认）** / slow 12h / never ∞ |
| 固定衰减 | `stress` 2h、`tension` 24h 归零 |
| 弥散 | `(mood−baseline)×0.4×(1−familiarity×0.5)` |
| 七阶阈值 | 敌意 → 试探 → 心动(3天,.18,.15) → 占有(14,.38,.32) → 病态(30,.62,.30且trust≤.55) → 献祭(45,.70,.45且需sacrifice标记) → 落定(60,.75,.70) |
| 防跃迁四闸 | 时间闸 / 步长闸 0.06 / 只升不降 / 冲突锁覆盖为「敌意」 |
| 语域码六段 | A冷 / B常 / C软 / D烫 / E炸 / F崩（中位字数 12/13/14/12/11/14） |
| 择档顺序 | locked 或 tension>0.5 → stress>0.85&mood<0.4 → stress>0.7 → energy<0.3 → mood>0.7&energy>0.6 → mood>0.55 → 默认 |
| 冲突锁 | 进锁 `tension>0.5 或 stress>0.85`；解锁需连续 2 次正向信号，解锁后 tension 压到 ≤0.25 |
| 落盘 | `user/emotion.db`；周期 60s；关系跨 0.25/0.5/0.75 立即落盘 |

### 9.2 节奏（rhythm，336 行）

| 项 | 值 |
|---|---|
| 分条上限 | `maxMessages=4`（官方 QQ 5 次留 1 次余量） |
| 单条上限 | `maxCharsPerMessage=40` |
| 字速 | `charsPerSecond=6` |
| 标点附加 | 。！？ 各 300ms；……/—— 各 500ms；，； 各 150ms |
| 停顿时限 | `minDelayMs=300`、`maxDelayMs=6000`；**先卡限→乘深夜 1.6（23:00–06:00）→再卡限** |
| 首条延迟 | 800–2000ms |
| 长停顿 | 概率 0.2，时长 3000–9000ms，**整轮最多一次** |
| 自我修正 | 概率 0.05，3 句模板，默认不自动插入 |
| 超限策略 | 保留前 3 条，其余**从尾部合并**成第 4 条 |

### 9.3 主动（proactive，562 行）

| 项 | 值 |
|---|---|
| 静默时段 | 23:00–08:00 |
| 空闲阈值 | `idleMinutes=25` |
| 日额度 | `dailyQuota=3`；`silentDays≥3` 减半、`≥7` 归零 |
| 放弃率 | 30%（性格化沉默） |
| 话由优先级 | 到点承诺 > 情绪偏离基线 ≥0.08 > 记忆事实非空 > 台词池兜底 |
| 退场规则 | `silentDays≥2` 或「用户开口后已主动说 2 次」→ 只说一句退场句 |
| 承诺抽取 | 只认明确时间词（后天/明天/大后天/下周/周末/今晚/晚上/一会儿/下次），长度 4–120 字，疑问句尾排除，过期 3 天清理，最多 20 条 |
| 状态落点 | `user/proactive-state.json`（0600，临时文件 + rename 原子写） |

### 9.4 语音（tts，193 行）

| 项 | 值 |
|---|---|
| 句长闸 | 去空白后 6–30 字（<6 太短、>30 太长） |
| 情绪闸 | `max(\|mood−0.5\|,(energy−0.5)×0.5) ≥ 0.15`，或本轮有情绪词 |
| 频控闸 | 距上次放行 ≥3000ms |
| 通道优先级 | local(GPT-SoVITS) > macos-say > none；GPT-SoVITS 超时 15000ms |
| 失败策略 | 任何失败返回 `speak:false`，绝不抛错 |

### 9.5 对话（dialogue，1249 行）

| 项 | 值 |
|---|---|
| 上下文装配顺序 | `live 日期 → persona.buildPrompt() → worldbook.collect() → emotion.expression() → 长度纪律`，`\n\n` 拼接 |
| 消息序列 | system → 记忆事实摘要(≤500 字，独立 system 条) → 最近原文(≤10 条且≤2000 字) → 调用方 history → 本轮 input |
| 长度纪律 | ≤384 tokens → 一两句 ≤40 字；≥2048 → ≤200 字两段；其余 → 一到三句 ≤80 字 |
| 流式两闸 | 句首草稿剥离（`LEAD_BUFFER_MAX=64`，≥24 字符才做 ASCII 密度判定，阈值 0.5）+ AI 自曝替换（滑动窗 12 字符） |
| 收尾六道闸 | `stripMetaPlan → stripSettingLeak → stripNarration → stripServiceTone → trimOverAgree → collapseRepeat`，最后 `guardRedLine` 兜底 |
| 复读判定 | 4/3 字片段重复 ≥3 次、2 字 ≥4 次 → 折叠 |
| 长度回退 | 末尾无句界且残尾 <64 字 → 丢到最后一个句界 |

**事件帧（以代码为准，共 5 种，不是 2 种）**：
`text-delta{delta}` / `text-replace{text}` / `crisis{kindLabel: crisis|privacy|isolate}` / `usage{inputTokens,outputTokens}` / `done{stopReason: stop|aborted|error|length}`。

### 9.6 界面接口（ui，4902 行 + 前端 6761 行）

| 项 | 值 |
|---|---|
| 挂载 | `inject=['webServer']`，`register({kind:'prefix', path:'/api/ntdpet'})` |
| 鉴权 | 令牌 32 字节随机 → 64 位十六进制，落 `user/api-token`(0600)，请求头 `X-Ondra-Token` |
| 路由数 | 手册写 19 条核心路由，**代码实为 40+ 条**（含 `/proactive/*`、`/data/*`、`/model/config`、`/memory/*`、`/diary/*`、`/channels*`） |
| 响应包 | 成功 `{ok,data}`；失败 `{ok,error:{code,message}}`；未就绪 `NotReadyError → 503` |
| 关系结算 | 逐轮累计 `base=0.004×min(1, log10(len)/log10(300))`（熟悉×1.5、好感×1、信任×0.6、亲密×0.8，仅情绪轮）；静默 15 分钟后封顶 ±0.06 |
| 情绪步长 | `MOOD_STEP=0.03`；应激映射：被骂 +0.45、说要走 +0.5、道歉 −0.3、被安抚 −0.15 |
| 前端超时 | `api.js` 8000ms |

---

### 9.7 做梦与神经元结构（实现规范版）

**夜跑六步（22:50 起，每步独立限额、全部软删）**：

1. **共现加固**：24 小时内同时出现 → 边权 +0.1（上限 200 对）
2. **衰减**：90 天未激活 ×0.5（**必须带 `decayed_at` 游标**，否则会重复乘算成 0.5^N）
3. **软剪枝**：权重 <0.05 压到 0.01（`surreal` / `approved` 豁免）
4. **荒诞联想**：同实体但时间差 >3 天 → 建 `surreal` 边 0.03（每晚 ≤3 条，**永不进检索**）
5. **梦话**：30–50 字呓语存 `dream_log`，次日首次对话注入并标注「这是梦话」
6. **重写摘要**：`facts≥5` 且摘要 <25 字 → 重写（≤20 张，旧稿入 `summary_history`）

**三道保险**：开工前 `VACUUM INTO` 备份、每步限额、删除一律软删。
**四道闸**：出处逐字可查 / 人格保护 / 常驻层不碰 / 工程结论隔离。

**链路表**：`card_links(from_id, to_id, relation, weight∈[0,1], hits, last_fired, decayed_at)`

| 参数 | 值 |
|---|---|
| `same_topic` 初值 | 0.72–0.85，每次 +0.05 |
| `cooccur` 初值 | 0.15，每次 +0.10（用 0.05 需 8 晚才越线） |
| 扩散门槛 | 0.4 |
| 枢纽度上限 | 40（建链与扩散共用同一常量） |
| 权重方向 | 上下都必须 clamp |

### 9.8 记忆分类与打分（`未命名.md` 硬规格）

| 项 | 值 |
|---|---|
| 五类 | `episode` / `fact` / `reflection` / `skill` / `lesson` |
| 权重 | 语义 0.18 + 关键词 0.46 + 图谱 0.11 + 重要性 0.14 + 新鲜度 0.11 |
| 合并阈值 | 余弦 0.92 |
| 清理 | 180 天；每 12 条生成一次摘要 |
| 去重三档 | 余弦 ≥0.85 合并 / 0.72–0.85 建边 / Jaccard 0.75 跳过 |
| 四套方案差异 | 小满＝FTS5+bigram、硬作用域；鲸汐＝文件即记忆、只做无损整理；糯糯＝五层四元组、双时间轴；实现规范＝卡片+突触 |
| 向量模型 | `bge-m3` 1024 维（**待定**：旧项目实为倒排，见附录 C-7） |

### 9.9 界面精确规格（UI 重构方案）

| 项 | 值 |
|---|---|
| 栏宽 | 272 / 1fr（最小 520）/ 300 |
| 字号 7 档 | H1 15/590、H2 13/590、H3 12/590、H4 11/500、Body 14/1.62、UI 13、Caption 11、Micro 10（**删 17、22 两档**） |
| 圆角 6 档 | 4 / 6 / 8 / 10 / 12 / 999（删 14、18） |
| 间距 7 档 | 4 / 8 / 12 / 16 / 20 / 24 / 32 |
| 品牌色 | `#6E56E0`（白字 5.16:1），hover `#5B45C9`；深色 ink `#A99BF5`、fill `#6E56E0` **必须分开用**（否则白字仅 2.6:1） |
| 文字色 | α .74 / α .72 两档；灰阶 5 层；语义色 16 → 8（情绪用长度不用色相） |
| 图标 | morphicons 2.0.2（MIT，零依赖，dom 9.3 KB gzip），vendor 直拷；44 个注册表；12 组 morph；同屏 morph ≤2；描边 16→2 / 20→1.8 / 24→1.6 |
| 断点 | 1440 / 1240 / 1080 / 900（右栏折叠抽屉）/ 860 / <860（**删 820 死断点**） |
| 关键尺寸 | 会话行 60、搜索框 30、气泡圆角 12（靠头像上角 4）、文字发送键 34、关系阶段条分母 **7** |
| 标题栏 | 48px 标题区横跨整窗，三列共用圆心 y=25；`trafficLightPosition{x:20,y:19}` |
| 无障碍 | 焦点环 3px、`outline:none` 归零、aria-label 100%、快捷键 `⌘,` `⌘F` `⌘N` `⌘⇧S` `⌘↵` |

### 9.10 高价值复用资产（旧项目里能直接搬的）

| 资产 | 体量 | 用途 |
|---|---|---|
| 台词库 | 39 池 2615 条 | `ondra-oral` 口头禅池、`proactive-reason` 兜底话术 |
| 世界书场景卡 | 22 张（后扩 36/43 张） | `ondra-worldbook-scenes` |
| 训练样本 | 3699 条 | 训练侧，非运行时 |
| 人格源 | xia-ningqi 三件套 + 五变体 | `ondra-persona-core` |
| 记忆工艺参数 | 见 §9.7 / §9.8 | 记忆域全部插件 |
| UI 参考图与令牌 | — | `ondra-ui-tokens` |

**明确不搬**：24 GB `llama.cpp` 源码树、11 GB 权重（仅 2.1 GB 基座另存）、`node_modules` / `runtime` / `release`、LoRA 813 MB、网文语料。

### 9.11 通道层与端侧实证（纠正 description 与实现不符之处）

**通道分层真实依赖**：9 个适配器 + adb + device-mcp + desktop-mcp 以 workspace 依赖 `channel-kit`（唯一允许的 import 例外）；运行期只 `ctx.get('ondra:dialogue')` 与 `ctx.get('ondra:persona').buildPrompt?.()`，缺席即 warn + return，不崩。

**channel-kit 关键签名**：`callPersona(ctx, input, history, options, system?) → Promise<string|null>`；默认 provider `magpie` / model `group/ntars` / maxTokens `800` / reasoning `off`；`PeerHistory` 上限 12 条（仅在内存，不落盘）；`chunkText(text,max)`；`loadChannelConfig(id, patch)` 读 `user/channels.json` 后浅合并，读不到就回退 patch；`isEnabled` 严格 `=== true`。

**九个适配器实测（默认全部关闭，patch 均只 insert 不写 config）**：

| 通道 | 传输 | 鉴权 | 分条上限 | 去重/重试 |
|---|---|---|---|---|
| telegram | getUpdates 长轮询 timeout 50 | token 在 URL | 4000 | offset 去重；失败 3s 退避 |
| discord | Gateway WS v10 自实现 IDENTIFY+心跳 | `Bot <token>` | 1900 | 4004 停止重连，其余 5s；无去重 |
| dingtalk | Webhook 3454（需公网） | HmacSHA256 验签 | 4000 | 先回 empty 再异步 |
| feishu | Webhook 3453（需公网） | verificationToken | 4000 | 先 200 再异步；`encryptKey` 不支持加密体 |
| wecom | Webhook 3455（需公网） | 自实现 WXBizMsgCrypt（AES-256-CBC） | 2000 | 先回 success |
| wechat-official | Webhook 3456（需公网） | sha1 验签 | 800 | **5 秒硬限**→先回降级话术，真回复走客服消息 48h |
| wechat-kf | 拉取式 `sync_msg` 每 5s + cursor | sha1 验签 | 800 | 游标去重 |
| qq-official | WS 长连 + `/app/getAppAccessToken` | `QQBot <t>` | 1200 | 被动回复须带原 `msg_id` |
| wechat-personal | 入站 3457 + 出站用户 webhook | 无（仅回环）+ **`confirmed===true` 硬闸门** | 1000 | 无 |

**端侧实证（与包 description 不符，以此为准）**：

- `adb`（包名实为 `@ondra/adapter-adb`）：**只做只读短信轮询**（`content://sms/inbox`，未读 20 条，15s 轮询，`seen` 集合超 1000 裁到 500）；**没有截图、点击、中文输入**；发短信不做，靠 `replyWebhook` + 用户自备 Intent 桥。
- `device-mcp`：`device.notifications / sms / contacts / battery / foreground`，全只读，timeout 8s。
- `desktop-mcp`：`desktop.processes`（不取命令行，防 token 泄露）/ `foreground` / `clipboardMeta`（**只返回长度**）/ `findFiles`（关键词必填，深度 ≤2、≤30 条）/ `sysinfo`，timeout 5s。
- `browser` / `minecraft` / `pet`：各 27 行左右占位，`enabled` 为真时只 warn「本版未实现」。
- `pet-mobile`：`apply()` 空实现，**连 enabled 判断都没有**。
- `gui-agent`：已实现 observe（screencapture + 前台 App）、executeStep（仅 click/type/key，走 osascript）、classifyRisk（type/click/system）、审计 jsonl；**「三层安全网」「表单红线」「dailyBudget 计量」只有注释与文档，无代码**；`classifyRisk` 永不返回 `readonly`。
- `startup-check`：`inject=['profileContext']`，判据实为**三项**——`entry-count`(warn) / `privacy-switches`(**fatal**) / `key-packages`(warn)，三项跑完不短路，只判定不拦启动。
- `market`：清单实为 2 个包（`xia-ningqi-complete` / `xia-ningqi-light`），只读，安装依赖 snapshot 还原点。

### 9.12 界面与适配器字段不一致（必须在插件里修掉）

旧项目 UI 表单字段与适配器读取的键对不上，导致「界面填了但通道读不到」：

| 通道 | UI 字段 | 源码实际读 | 后果 |
|---|---|---|---|
| wechat-personal | `enabled`/`endpoint`/`token` | `confirmed`/`webhook` | 界面永远开不起来（缺二次确认）+ 地址键错 |
| qq-napcat | `wsUrl`+`token` | `port`（反向 WS，由 NapCat 连入） | 语义相反 |
| qq-official | `token` | `appId`+`clientSecret` | 鉴权填错 |
| dingtalk | `appKey` | 只有 `appSecret`+`port` | 多余字段 |
| adb | `serial` | `adbPath`/`pollSeconds`/`replyWebhook` | 全部错位 |
| device-mcp / desktop-mcp | `endpoint` | 无（走本地命令） | 假字段 |

**新体系要求**：字段定义由各插件用 `Config` 声明，`ui-settings` 只按 schema 渲染，**不允许界面自己写死字段名**。

---

### 9.13 手册新增参数（`material/Ondra-dev-handbook.md`，效力高于此前所有口径）

**记忆寿命（§2.4，O-010 改造，README 必须注明「公式变更」不是新增）**：

```
S(小时) = baseHours × (0.45 + salience/100 × 1.25) × (1 + arousal × 0.65)
```

11 类基线：watch 2 / daily 3 / misc 20 / feeling 50 / food 10 / place 12 / event 40 / self 20000 / study 80 / person 240 / promise 8000。
写入打分（夹 0–100）：基底 30（长期类 70）、第一次 +26、最/特别 +22、答应/约定 +20、难过/哭/后悔 +16、一辈子/永远 +12、≥40 字 +6、刷视频 −14、吃了饭 −10、没什么/还行 −12、≤8 字 −8。
命中拉长半衰期：`min(15, 3×(1+ln(1+times_said)))` 天；检索命中 `1 + 0.6·log2(1+次数)`，封顶 4 倍。
归档：normal 30 天 / important 90 天未引用；**只忘不删**（archived=1 + 地板权重 0.01）；**30 天未带出强行补 1 条**（制造"忽然想起"）。
四态删除：`forget`（写 tombstones，合并不许复活）/ `seal`（封存）/ 自然沉底 / `revise`（留 oldText、revisions+1、S×1.3，合并时新版本必胜）。

**八池（§2.5，O-131）**：core ∞/上限 32（满了再写原则直接拒绝）/ fact 宽限15·半衰365·归档1095 / skillRule 120·**730**·3650（铁律常驻全量）/ skillExp 15·60·365 / skill 15·90·365 / dailyCore 20·60·180 / dailyPartial 5·20·45 / emotion 0.125·1·3 / hippocampus 0·1·14（**永不注入**）。标签未命中任何池 → **不猜**，落海马体 + 打"未归类"，同句重复 3 次升级"需人工定池"。

**注入（§2.6，O-036/O-142）**：**装箱制**（按权重全局排序逐条装，装不下跳过继续试，段标题写 `另有 N 条未展开`）；预算三档 2600（默认）/ 24000 / 1200 字符；核心段永不参与装箱。

**情绪（§3.2，O-026）**：PAD 三维 + 10 固定标签（开心/生气/难过/害怕/委屈/害羞/得意/感动/焦虑/无聊）；单条上限 0.12、标签上限 0.6、标签半衰期 45min、心情 6h；道歉降幅 0.08（**保留嘴硬**）。
化学池：dopamine 50/45min、cortisol 20/30min、serotonin 50/120min；stress：cortisol≥70 时 −1.5/min；recover：energy>80 且无 ≥70 张力执念时 +0.8/min，ceiling 100。
气质四旋钮：sensitivity / resilience / enthusiasm / metabolism。动态激素 `inflict()` 上限 12 种，通用 baseline 50 / halfLife 30min / `runtime:true`。**存档缺字段补 50 不补 0**。

**能量（§3.3，O-048）**：清醒 +0.2/min；深睡（energy<20）或深夜 0–6 点 +1/min；`naturalCap=60`（人工喂到 100 按 0.1/min 回落）；**急停期间冻结不恢复**；分段积分 `stepMinutes=5`、上限 2000 段；睡醒缓冲**取走即清零**。

**阈值漂移（§3.5，O-130，P0）**：`threshold = base × (1 + 0.6 × min(1, interactions/5000))`，上限 +60%；必须落盘且 `explainThreshold()` 可解释。

**应激倍率（§3.8，O-029，P0）**：cortisol ≥80 → 危机 ×3 / 日常 ×0.1；60 → ×2 / ×0.55；≤40 → 均 ×1；≥80 时系统提示词最前注入行为指令。

**缺口池张力（O-129，P0）**：`tension = clamp(base + h×rate − relief)`；相似度 ≥0.6 只 +10；唤醒门槛 tension ≥80。

**关系（§3.4）**：七阶底座 + 五阶段只读映射 + 六段 0–1000 对外；衰减半衰期 `{affection 240h, trust 720h, intimacy 8760h, tension 24h}`；`settle_on_session_end true`、idle 15min 结算、单次 cap 0.06；承诺违约 `{trust−0.05, warmth−0.03, tension+0.04}`、履约 `{trust+0.02, warmth+0.02}`。

**承诺闸门（§3.6，默认关闭）**：三道解锁缺一不可——①生命维持工具绝对豁免 ②只拦"自作主张"的写/删/外发，不拦读 ③TTL 20 分钟自动过期；`ctx.tools` 只有 `get` 没有 `has`；拒绝理由必须写全。

**防封六道闸（§5.3，O-042）**：实测 12 拦截 0 误伤；叠加 `min_idle_seconds`、静默时段、每日投递预算。

**器官 ABI（§8.1，O-132，P0）**：见 §3.4。

**上下文经济（§8.6）**：schema 门控 55,154→8,433 token（84.7%）；工具输出沙箱 315KB→5.4KB；`arg_error` 永不自动重试；伤口 5 分钟未闭合标 chronic。

**前缀缓存（§8.5）**：实测命中 99.3–99.6%，成本 ¥879.97 → ¥19.96。见 §3.5。

---

## 10. 从旧架构里发现并必须修掉的问题

节选自查中发现的**真实缺陷**，新插件体系不得照抄。这些不是锦上添花，是「交叉调用」与「失真」的具体来源。

| # | 旧架构问题 | 后果 | 新体系怎么改 |
|---|---|---|---|
| 1 | **情绪与关系的写入口在 `ui` 包**（`driveEmotion` / `driveStress` / `settleSession` 都在接口层） | 界面成了状态真源，换界面即丢状态；应答逻辑与展示逻辑耦合 | 写入口归 `ondra-emotion-core`（唯一写者），`ui-api` 只能读与转发命令 |
| 2 | `ui` **不 provide 任何服务**，纯消费者 | 其他插件无法查询界面状态，只能各自猜 | 新增 `ondra:ui-api` 服务键，界面状态由它代言 |
| 3 | `avatar` 是 19 行空骨架，却计入「全部已激活」 | 用户点了没反应，属无效控件 | `O-054` 明确标 `skeleton`：未实现时给「本版未实现」提示，不做假开关 |
| 4 | 40 包中 8 个 19–30 行空壳仍显示已激活 | 同上 | 台账新增 `skeleton` 子状态，界面必须显式区分 |
| 5 | `router` 骨架但组合包仍挂载 | 语义混乱 | `O-055` 要么补完，要么标骨架并给提示 |
| 6 | 手册写 19 条路由、代码 40+ 条 | 文档滞后会误导后续实现 | 以代码为准（§9.6），文档口径统一为「核心 19 + 扩展 40+」 |
| 7 | 五个关系变体曾被写成「只是亲密度不同」 | 五个人读起来是同一个人 | `O-021` 强制：`l1_core` 放共享内核，变体**只写关系差异**（称呼/相处节奏/典型反应） |
| 8 | 提示词曾被按 `priority` 全局排序 | 模型第一句就是「不许做什么」 | `O-023` 强制四段固定顺序，`priority` 只用于裁剪 |

---

## 11. 开源复用与技术来源纪律

### 12.1 三条硬规则

1. **优先参考**：每个功能动手前，先在 GitHub 找到该领域成熟实现，读源码、读参数、读边界处理，把机制吃透。
2. **自己写，不照搬**：禁止整段复制他人代码、禁止改改变量名后据为己有。借鉴的是**机制、参数取值、边界取舍**；代码由本项目独立实现，注释写明「参考了谁、借鉴了哪一点」。
3. **允许引入的唯一情形**：难度极高或体量巨大（渲染引擎、历法算法、协议编解码、向量检索），短期自研不现实。此时**先引入、用适配层包住、README 标注「临时引入 + 替换计划」**，后续批次再替换为自研实现。

### 12.2 每个插件 README 必填「技术来源」表

不填不许算完成。格式：

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 指数回归衰减 | 例：某记忆库项目 | github.com/xxx/yyy | MIT | 半衰期公式与地板值思路 | 自研纯函数 `decay.ts` | 否 |

### 12.3 许可纪律

| 上游许可证 | 允许做什么 | 禁止 | 留痕要求 |
|---|---|---|---|
| MIT / BSD / ISC | 可引入代码，可改 | 去除版权声明 | README + `THIRD-PARTY` 记录原文 |
| Apache-2.0 | 可引入代码，可改 | 使用其商标、去除 NOTICE | 保留 NOTICE 与修改声明 |
| LGPL | 可动态链接式引入 | 静态并入闭源分发 | 保留许可与源码获取途径 |
| GPL / AGPL | **只读书思路，不复制代码** | 复制代码进本项目 | 仅在 README 记「思想参考」 |
| 无许可证 | 一律不引入、不复制 | 任何形式复用 | 只能自研 |

**特别注意**：`NapCat` 等协议端明确禁止衍生开发，本项目只以**外部进程对接**，不引入其代码。人格包、品牌素材不在 AGPL 授权范围内，`ondra-persona-skills/` 下文件只读。

### 12.4 成品形态（唯一允许）

**只能是 app 插件包**（Cordis 插件：`apply(ctx)` 形态）。禁止产出：

- 独立 CLI 工具、独立 HTTP 服务、systemd/launchd 常驻服务、独立 npm 脚本；
- 独立前端页面工程（界面必须以插件形式贡献 DOM 与路由）；
- 任何要求用户手工跑命令才能生效的东西。

壳侧能力（安装器、进程托管、窗口）以 **`runtime: host` 的插件**存在，仍走 `apply(ctx)` 与 `ctx.effect()`，不是独立可执行程序。

### 12.5 高体量项的处理预案

| 能力 | 候选开源 | 处理方式 |
|---|---|---|
| Live2D 渲染 | `pixi-live2d-display`（MIT）、Cubism SDK | 体量大 → 引入 + 适配层，`avatar` 里包一层接口 |
| 农历 / 节气 / 干支 | `lunar-javascript`（MIT）、`tyme4ts`、素材内「万年历算法 js」 | 算法密集 → 优先复用素材内已 vendor 的包，避免新增依赖 |
| SQLite | `node:sqlite`（Node 内建） | 直接用，无需引入 |
| OneBot11 / QQ 协议 | `NapCat`、`Lagrange` | **不引入代码**，只做反向 WS 客户端对接外部进程 |
| 向量检索 | `sqlite-vec` | 体量中等 → `memory-recall` 的可选后端，默认不启用 |
| 文档解析 | `MinerU` | 体量大 → L9 才考虑，先用轻量自研 |

---

## 12. 多方案并存与分支纪律（稳定优先）

> 主人的原话：**「各功能有很多种方案，如果不能融会贯通或者是兼容，那就做成不同的分支，稳定优先，不要追求轻量和速度，达到最佳效果。」**
> 这一节优先级高于「最小实现」——凡是稳定性与简洁冲突，一律选稳定。

### 14.1 三条判定顺序

同一功能遇到多种方案时，按下列顺序处理，**不许跳级**：

1. **能融会贯通 → 融**：把多种口径抽象成一个实现，参数化差异（例：衰减四档 `never/slow/standard/fast` 就是用一档参数统合多种半衰期主张）。
2. **能兼容 → 做兼容层**：口径确实冲突但可共存时，以一个为底座，另一个做只读转换层（例：七阶关系为底座，五阶段作为映射视图，不改底座数据）。
3. **都不能 → 做成不同分支**：同一服务键下注册多个实现，由配置 `provider` 选择，**互不共享可变状态**，各自独立降级。

### 14.2 分支实现规范

| 要求 | 说明 |
|---|---|
| 接口唯一 | 同一能力只有一个 `types.ts` 接口，分支只实现接口，不许各自定义返回形状 |
| 文件隔离 | 每分支一个文件（`recall/inverted.ts` / `recall/vector.ts`），不许在同一个文件里 `if (mode===...)` 铺开三套逻辑 |
| 默认最稳 | 配置默认值选**最稳**的那个分支，不是最快的、不是最省的（例：检索默认 2-gram 倒排，向量为可选增强） |
| 独立降级 | 每个分支自带失败路径，分支 A 挂了不影响分支 B 被选中 |
| 可观测 | 当前生效分支必须能被 `ondra-startup-check` 与界面读到，不许黑箱切换 |
| 不共享状态 | 分支之间不共享缓存、不共享连接、不共享定时器 |

### 14.3 已知多方案登记（必须逐一落实，不许合并掉）

| 能力 | 方案 A（默认/底座） | 方案 B | 方案 C | 处理方式 |
|---|---|---|---|---|
| 关系阶段 | **七阶**（代码现状：敌意→试探→心动→占有→病态→献祭→落定） | 五阶段（迁移方案：cold→thawing→attached→possessive→yandere） | — | 七阶为底座，五阶段做只读映射视图（兼容层，不写库） |
| 情绪维度 | **`mood`/`energy`/`stress` + 四关系维度** | 加激素（cortisol/oxytocin/dopamine） | 效价-唤醒二维（valence-arousal） | 核心三维为底座；激素做 `ondra-emotion-hormone` 可选插件；二维做展示层派生，不改存储 |
| 记忆结构 | **原文层 + 事实层（双层）** | 五类（episode/fact/reflection/skill/lesson） | 三通道（fact 4d / gist 12d / affect 180d） | 双层为存储底座；五类做 `kind` 标签体系；三通道做 `channel` 视图层，三者共用一张表 |
| 记忆检索 | **2-gram 倒排 + 时间半衰** | 向量（bge-m3 1024 维） | 混合 BM25 + 向量 + 重排 | 倒排默认；向量做 `ondra-memory-vector` 可选插件；混合检索在向量插件内提供 |
| 衰减公式 | 指数半衰期 | 遗忘曲线（Ebbinghaus） | 引用加权（hit_count 复利） | 指数为底座，引用加权已并入 strength 公式，遗忘曲线作为档位参数 `slow/standard/fast` |
| 做梦机制 | **六步夜跑**（共现→衰减→软剪枝→荒诞→梦话→重写摘要） | 简化巩固（只做衰减+摘要） | REM 重放（方案 40） | 六步为默认；简化版作为 `lightMode` 参数；REM 重放并入第 4 步荒诞联想 |
| 持久化后端 | **SQLite（WAL）** | JSONL / JSON 文件 | 内存 | 三层并存，用 provider 切换；内存仅作兜底，JSON 供无 SQLite 环境 |
| 农历算法 | **素材内「万年历算法 js」包**（无网络、已 vendor） | `lunar-javascript`（MIT） | `tyme4ts` | 素材包默认；另两者做可选分支，用于交叉校验（对拍） |
| TTS 通道 | **macOS `say`**（零依赖） | 本地 GPT-SoVITS HTTP | 云端接口 | 三条并存（旧设计即如此），按可用性降级 |
| 界面渲染 | **原生 ESM + CSS 变量令牌**（现状 11590 行） | 组件框架（Vue/React） | — | 原生为底座；**不引入框架**（引入会破坏插件热插拔与体积可控），差异用组件化文件拆分消化 |
| 提示词拼装 | 四段固定顺序 | 按 priority 全局排序 | — | 四段固定为唯一实现；priority 只用于裁剪（旧坑已记录） |
| 通道唤醒 | 本地唤醒（`wakeProbability`） | 全量响应 | 关键词唤醒 | 本地唤醒默认；另两者做配置项 |

### 14.4 与「最小实现」的关系

- **代码量最小 ≠ 目标**。目标顺序是：**正确 > 稳定 > 可维护 > 省资源**。
- 允许为一个功能写多份实现（分支），允许为边界情况多写校验，允许为兼容旧数据多写迁移层。
- 仍然禁止的：无需求的炫技式抽象、为一个字段引入整个框架、把三个分支揉进一个函数。
- 每份分支代码必须有单测级别的边界注释（输入范围、异常、降级）。**不跑测试不代表不写清**。

### 14.5 多方案项在台账里的标注方式

台账的职责栏若涉及 §12.3 的任一能力，必须写出「分支策略」四个字并注明默认分支，例如：
`ondra-memory-recall` 职责写「三层检索打分；分支策略：倒排默认 / 向量可选 / 混合在向量分支内」。

---

## 13. 分类体系与隔离规范

### 16.1 三级分类：域 → 组 → 插件

编号 `O-xxx` 全局唯一，域用固定前缀标识，便于按类检索与分批交付。

| 域码 | 域 | 层 | 插件数 | 编号段 |
|---|---|---|---|---|
| BASE | 基座 | L0 | 5 | O-001 ~ O-005 |
| STORE | 存储 | L1 | 4 | O-006 ~ O-009 |
| MEM | 记忆 | L2 | 10 | O-010 ~ O-019 |
| PER | 人格与世界书 | L2 | 6 | O-020 ~ O-025 |
| EMO | 情绪与关系 | L2 | 7 | O-026 ~ O-032 |
| DLG | 对话链 | L3 | 5 | O-033 ~ O-037 |
| RHY | 节奏与口语 | L4 | 4 | O-038 ~ O-041 |
| PRO | 主动 | L4 | 3 | O-042 ~ O-044 |
| LIF | 生活感 | L4 | 5 | O-045 ~ O-049 |
| EXP | 表达（语音/表情/形象） | L4 | 5 | O-050 ~ O-054 |
| CHN | 通道 | L5 | 13 | O-055 ~ O-067 |
| DEV | 端侧 | L6 | 8 | O-068 ~ O-075 |
| SYS | 系统与交付 | L7 | 9 | O-076 ~ O-084 |
| UI | 界面 | L8 | 12 | O-085 ~ O-096 |
| VAR | 多方案分支 | — | 3 | O-121 ~ O-123 |
| EXT | 扩展池 | L9 | 24 | O-097 ~ O-120 |

### 16.2 通道隔离六条（主人明确要求「单独隔离开」）

1. **目录隔离**：一个通道一个 `ondra-adapter-<name>/`，不与其他通道共用源码目录。
2. **配置隔离**：每个通道用自身 `Config` 声明字段，凭据落 `user/channels/<channel-id>.json`（0600），**不共用凭据、不共用配置文件**。
3. **日志隔离**：日志命名空间 `channel.<id>`，`channel-health` 为每通道建独立探针实例，互不串。
4. **状态隔离**：`PeerHistory` 每通道独立实例、仅内存、上限 12 条；通道消息**不进主会话**（跨渠道串味会毁人格连续性）。
5. **失败隔离**：单通道超时/断连/被风控只影响自身；打开与关闭走同一套 `enabled` + `destroy` 路径，关闭后不残留定时器与 socket。
6. **风险隔离**：高危通道（`qq-napcat`、`wechat-personal`）单独成块展示风控说明，二次确认独立存档，不与合规通道混在一张开关列表里。

### 16.3 端侧同类隔离

`adb` / `device-mcp` / `desktop-mcp` / `browser` / `gui-agent` / `minecraft` / `pet` / `pet-mobile` 各自独立插件、独立权限声明、独立开关，默认全部关闭；只读能力不得因同组其他插件被授权而获得写权限。

### 16.4 每个插件的隔离自检（五问，写进 README）

1. 关掉我，谁受影响？（必须能答「只有我自己」）
2. 我的状态存在哪？（必须答出文件路径或「仅在内存」）
3. 我崩了，界面怎么知道是我崩了？（必须答出日志命名空间与探针）
4. 我依赖谁？缺席时我怎么降级？（必须答出 `if (!svc) return` 之类）
5. 我和同域的谁共享了可变状态？（必须答「没有」）

---

## 14. 已裁决事项（主人 2026-10-31 01:49 拍板，优先级最高）

| # | 事项 | 裁决 |
|---|---|---|
| 1 | 包名 | **无 scope**：目录与 `package.json` 的 `name` 都写 `ondra-<kebab>` |
| 2 | 交付范围 | **核心 96 项 + 多方案分支 3 项 + 扩展池 24 项，全部排入队列**；先做核心，扩展后续接 |
| 3 | 关系阶数 | **七阶**（敌意→试探→心动→占有→病态→献祭→落定），五阶段仅作只读映射 |
| 4 | 节奏 | **每小时 2 个**；交叉风险按 §15 的七条硬约束规避 |
| 5 | 边界 | **只做插件 + 插件自检；禁止实装运行、禁止改其他代码**（详见 §16） |

> 这五条一旦与本文其他段落冲突，**以本节为准**。

---

## 15. 每小时 2 个：交叉风险七条防控

一轮做两个插件，最大的风险是「两个插件对同一个服务键的理解不一致」或「后做的推翻先做的」。以下七条是硬约束，违反即停：

### 18.1 同域优先，禁止跨域混做

一轮只从**同一个域**取两个（例：都取 MEM 或都取 UI）。跨域同轮会同时牵动两条依赖链，出问题无法归因。

### 18.2 编号相邻，被依赖的先做

一轮内两个编号必须相邻（如 O-010 + O-011），且**被依赖方必须排在前面**。台账已按依赖顺序编排，照编号取即可，不要跳号。

### 18.3 契约先行（本轮最关键的防交叉手段）

涉及**共享数据结构**的插件（记忆表结构、情绪状态、人格提示词段、事件帧），第一个插件开工时**必须先在其 `src/types.ts` 里把接口与服务键完整定义**，第二个插件只能 `import type` 该契约或按契约调用，**不得自行另立一套字段名**。

### 18.4 服务键单一归属

一个服务键只能有一个 `provide` 方。第二个插件若需要同一能力，只能消费，不能重复 `provide`。台账的「提供服务键」列即归属登记，冲突时以先登记者为准。

### 18.5 禁止同轮互相 import

一轮内的两个插件即使同域，也只允许经服务键调用，**不允许 `import` 对方源码**。这样任一插件单独卸载都不会让另一个编译失败。

### 18.6 收尾必做交叉扫描

每轮结束时执行三项机械检查，结果写进简报：

1. **服务键闭合**：全仓 `ctx.get('ondra:xxx')` 出现的每个键，都能在台账里找到 `provide` 方；
2. **无环**：按台账依赖列建图，检查无循环依赖；
3. **无越界 import**：全仓 `import ... from 'ondra-xxx'` 只允许出现在 `channel-kit` 类型的消费方（唯一例外），其余一律报错。

### 18.7 冲突即回写台账，不静默处理

若第二个插件发现第一个插件的契约有问题（字段缺、语义错、与旧项目不符），**不许偷偷改第一个插件**，而是在台账备注里记「契约冲突：O-xxx 的 xxx 字段需修正」，把两个插件都标 `blocked`，等下一轮统一处理。这样才追得回来。

---

## 16. 插件自检清单（替代「不验证」，仍禁止实装运行）

> 主人的边界：**只做插件和测试检查，禁止实装运行，禁止改其他代码**。
> 因此「检查」= **纯静态自检**，不 `pnpm install`、不 `build`、不 `tsc`、不启动 app。

### 19.1 九项机械自检（每轮必做，逐项在简报里报「过/不过」）

| # | 检查项 | 判定方法 | 不过怎么办 |
|---|---|---|---|
| 1 | 结构完整 | 8 个必需文件均存在（package.json / tsconfig.json / src/index.ts / locale/en.json / locale/zh.json / README.md，可选 icon.svg） | 补齐后再交付 |
| 2 | 清单合法 | `package.json` 可被 JSON 解析；`name` 为 `ondra-*`；`type: module`；`main` / `types` / `exports` / `files` 齐全；`@deepseek-ai/cordis` 同时出现在 `peerDependencies` 与 `devDependencies` | 修正清单 |
| 3 | 编译配置 | `tsconfig.json` 含 `module: NodeNext`、`moduleResolution: NodeNext`、`strict: true`、`rootDir: src`、`outDir: lib`、`declaration: true` | 修正配置 |
| 4 | 入口契约 | `src/index.ts` 导出 `name`（字符串）与 `apply`（函数）；`inject` 若存在必须是字符串数组；`Config` 若存在每个字段都有默认值 | 修入口 |
| 5 | 服务键唯一 | 本插件 `provide` 的键在台账中未被其他插件占用 | 见 §15.7 记冲突 |
| 6 | 依赖可解析 | `src` 中每个 `ctx.get('ondra:x')` 的键，在台账中存在提供方 | 记 `blocked` |
| 7 | 无越界 import | `grep "from 'ondra-"` 结果为空（`channel-kit` 类型消费除外） | 改为服务键调用 |
| 8 | 降级到位 | 每个 `ctx.get(...)` 之后都有 `undefined` 判断并安静返回，未直接调用 | 补判空 |
| 9 | 交付物齐全 | README 含技术来源表（§11.2）、多方案分支说明（若涉及 §14）、隔离五问（§13.4） | 补齐 README |

### 19.2 语言层自检（不依赖 TypeScript 编译器）

没有编译器也能查的语法级问题，用文本手段兜住：

1. 花括号 / 括号配平；
2. 每个 `export` 语句与文件末尾无残留半句；
3. `import type` 与 `import` 使用正确（类型导入不得混入运行时值）；
4. 无 `TODO` 占位留在核心逻辑里（骨架包除外，必须显式标 `skeleton`）；
5. 中文注释无乱码，UTF-8 无 BOM。

### 19.3 仍然禁止的事

- **禁止实装运行**：不启动 app、不 `pnpm install`、不 `build`、不 `tsc`、不跑任何运行期脚本。
- **禁止改其他代码**：不改 `desktop/`、不改既有 README / NOTICE / LICENSE / package.json、不改 `ondra-persona-skills/` 里的人设包、不改已 `done` 的其他插件（发现问题走 §15.7）。
- 允许的工具：读文件、grep、结构核对、JSON 解析、台账回写。

### 19.4 自检结论分级

| 结论 | 含义 | 台账状态 |
|---|---|---|
| 全过 | 9 项 + 语言 5 项全过 | `done` |
| 部分过 | 非致命项未过（如 README 缺多方案说明） | `done` 并在备注列未过项 |
| 致命 | 结构不全、清单不合法、入口无 `apply`、服务键冲突未解 | `blocked` |

---

## 17. 明确不做的事（防止跑偏）

1. 不 fork、不改写 APP 上游源码（决策 85）。
2. 不把桌宠窗口做进主窗口（决策已裁：桌宠砍掉，`pet` / `pet-mobile` 保留为能力入口空壳）。
3. 不给记忆库加密（决策 89：本地加密对同机同用户几乎无防护，却牺牲「数据属于用户」）。
4. 不做「规避 AI 标识」类功能。
5. 不抽「跨平台桌宠引擎」。
6. 不做「假开关」：未接后端的能力必须显示「未接入」，不许点了没反应。
7. 不动 `cordis/ondra-persona-skills/` 下已有的 12 个人设包。
