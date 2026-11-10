# ondra-forget-right · 被遗忘权

> 台账 O-103（第 17 组 · L9 扩展池，B13 批次）｜档位〔研〕自研｜**默认开启**（`plan()` 只读，`execute()` 必须带令牌）

**一句话：用户说「忘掉这件事」时，把「这件事还散落在哪十一处」一次摊开——能删的删掉并报数，删不掉的直接写「删不掉」。**

---

## 1. 它到底做什么

```
                     ┌─ todo       O-021 dropTodo()          ✅ 能按条删
                     ├─ capsule    O-101 drop()              ✅ 仅未开封
                     ├─ memory-edge O-015 forgetOf()         ✅
  ForgetTarget ──→ plan() ─→ ├─ memory-vector O-122 remove() ✅
  (fact/subject/            ├─ memory-pin O-017 unpin()      ✅
   capsule/todo)            ├─ memory-fact O-010 forget()    ✅ 真源，**最后删**
                     ├─ promise    O-021 （无删除方法）      ❌ 只数得出
                     ├─ lexicon    O-137 （只有 reset）      ⚠️ 只能整份清
                     ├─ diary      O-045 （无删除方法）      ❌ 删不掉
                     ├─ trace      O-135 （只有 prune）      ❌ 删不掉
                     └─ snapshot   O-009 （整份旧库）        ❌ 本插件不代删
```

**十一面**（`SURFACE_IDS`，唯一真源在 `src/types.ts`）：

| 面 | 中文 | 真源 | 能力 |
|---|---|---|---|
| `memory-fact` | 记忆正文 | O-010 `forget(id, reason)` | **真删**（唯一真源） |
| `memory-pin` | 记忆钉子 | O-017 `unpin()` | **真删** |
| `memory-edge` | 记忆图边 | O-015 `forgetOf()` | **真删** |
| `memory-vector` | 向量索引 | O-122 `remove()` | **真删** |
| `todo` | 待办 | O-021 `dropTodo()` | **真删** |
| `capsule` | 时间胶囊 | O-101 `drop()` | **真删**（仅未开封） |
| `promise` | 承诺行 | O-021 `listOpen()` | **删不掉**（契约里没有删承诺的方法） |
| `lexicon` | 语感样本 | O-137 `reset()` | **只能整份清** |
| `diary` | 日记 | O-045 `list()` | **删不掉**（无删除方法） |
| `trace` | 叙事日志 | O-135 `prune()` | **删不掉**（只按保留期） |
| `snapshot` | 快照 | O-009 `list()` | **不代删**（归 O-009） |

---

## 2. 五条硬纪律（每条都能单独否掉一种「更顺手」的做法）

1. **两阶段，删除必须带令牌。** `plan()` 纯只读、只出清单；`execute()` 必须传 `{ confirm: 'forget' }`。没有令牌的删除入口，迟早会被某个自动重试循环顺手调用一次——而「忘记」是**不可逆**的。

2. **先清下游、后删真源。** `SCRUB_ORDER` 把 `memory-fact` 排在第六位（后面只剩五面删不掉的）。反序的话真源一没，id 列表就再也拼不出来，下游全部只能跳过——而「跳过」在报告里长得像「本来就没什么要删」。**这个顺序不做成配置项**：调顺序的开关一定能调出一个删不干净的顺序。

3. **任何一面失败就让 `complete = false`。** 「删了 9 面、跳过 1 面」不许报成成功。被遗忘权只有「全对」与「没做到」两种结果，中间那档叫「还以为删干净了」——那比直接失败更糟，因为用户从此不会再看第二眼。

4. **删不掉就写「删不掉」。** 承诺行（O-021 契约里没有删承诺的方法，只有 `expire()` 转状态）、日记（`DiaryService` 只有读和写）、叙事日志（只有按保留期 `prune()`）、快照（整份库副本）——这四面如实标 `blind`，并尽量数出还剩多少。给它们各编一个「已清除」的假回执，等于把用户最需要看见的东西盖起来（§17-6 禁假开关的同一条道理）。

5. **不直连任何数据表、不自己删文件。** 每一面只调上游公开方法。图边数不出来（O-015 没有「列举全部边」的入口）就报「数不出来」，不去 `SELECT * FROM memory_link`；日记删不掉就说删不掉，不去 `unlink()` 那个 Markdown。**绕过服务边界一次，边界就再也说不清了。**

---

## 3. 服务键与契约

**服务键：`ondra-forget-right`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓仅本插件 provide。

`ForgetRightService` 方法集：

| 方法 | 说明 |
|---|---|
| `surfaces()` | 十一面说明书（静态，不含数值） |
| `plan(target, at?)` | **只读**出清单：`scrubs` / `erasable` / `residual` / `summary` / `warning` |
| `execute(plan, { confirm: 'forget' })` | 执行：`outcomes` / `complete` / `residue` / `summary` |
| `residue(target?, at?)` | 残余扫描：逐面 `remaining`（`null` = 数不出来，**不用 0 顶替**） |
| `stats()` | `planned` / `executed` / `refused` / `erasedBySurface` / `failedSurfaces` |
| `available` / `reason` | 可用性（`disabled`） |

```ts
const right = ctx.get('ondra-forget-right')
if (right === undefined) return

const plan = right.plan({ kind: 'fact', values: ['m-abc123'], reason: '用户要求忘掉这件事' })
// ↑ 只读。先把 plan.warning 显示给人看，再等人点确认。
console.log(plan.summary)    // 「清单一共 11 面：能真删 6 面，另有 5 面删不掉或不会动。」
console.log(plan.warning)    // 「记忆正文删除不可逆…以下面删不掉：承诺行、日记、回复决策日志、数据库快照。」

const run = right.execute(plan, { confirm: 'forget' })
if (!run.complete) {
  // 关键分支：**没清干净必须让人看见**，不能只显示「已完成」
  showResidue(run.residue)   // ['promise', 'diary', 'trace', 'snapshot']
  console.warn(run.summary)
}
```

**`execute()` 收计划而不是收目标**：让「人看过的清单」与「实际执行的清单」是同一份。重新按目标算一遍的话，中间库里变了，人批的就不是这件事了。

---

## 4. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| 记忆正文的寿命、打分、墓碑格式 | O-010 `ondra-memory-core` | 只调 `forget()`，不碰公式 |
| 钉子该钉什么、删除模式话术 | O-017 `ondra-memory-audit` | `audit.forget()` 在位时它是**唯一执行口**（台账原话） |
| 承诺的删除入口 | **必须改上游** | O-021 契约里没有删承诺的方法，只有 `expire()` 转状态 |
| 日记文件的删除 | **必须改上游 / 由人手工** | `DiaryService` 没有删除方法；本插件不代删文件 |
| 叙事日志的按条清理 | **必须改上游** | `NarrativeLogService.prune()` 只按保留期整天清理 |
| 快照的轮转与恢复 | O-009 `ondra-snapshot` | 删快照不可逆；本插件只读清单 |
| 图边的总数统计 | **上游缺入口** | O-015 没有「列举全部边」；同一条限制 O-100 已登记待裁决 |
| **渲染、三栏、设计令牌、主题、Toast、确认弹窗** | **应用外壳（`desktop/`）** | L8 界面 14 个插件已整批下线。本插件只交三份结构化数据 |
| 什么时候执行忘记 | 人 | 本插件**不装定时器**、不做后台常驻；「忘记」是用户发起的一次性动作 |

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | **`true`** | 总开关。关掉后服务仍注册，但 `plan()` / `execute()` 抛 `disabled` |
| `scan-diary` | boolean | `true` | 残余扫描时数日记篇数。关掉后那一行显示「未统计」而不是 0 |
| `scan-trace` | boolean | `true` | 残余扫描时数叙事日志条数。同上 |
| `clear-lexicon` | boolean | **`false`** | 允许对 `lexicon` 面调 `reset()`。**默认关**：它会清掉所有语感样本，包括别人说的话 |
| `verbose` | boolean | `true` | 降级与上游缺席时打一行日志，只影响日志噪声 |

**刻意没有的配置项**：删哪些面的勾选列表（让用户勾「只删正文不删图边」，得到的就是一个删不干净的忘记——真要少删，那叫「封存」或「订正」，O-017 已有另外三种模式）、跳过确认的开关（一个开关就能让令牌失效的话，它从一开始就不算令牌）、自动清理定时器（忘记不是后台任务）。

---

## 6. 降级与缺席（一张表说清）

| 缺席的上游 | 表现 | 哪一面 |
|---|---|---|
| `ondra-memory-core` | **`execute()` 抛 `no-core`**（正文真源都删不了，这次忘记没意义） | `memory-fact` |
| `ondra-memory-audit` | 改走 `core.forget()` 单删，钉子靠 `unpin` 单独拔 | `memory-pin` 仍能删 |
| `ondra-memory-graph` | 这一面报 `absent`（**不假装清过**） | `memory-edge` |
| `ondra-memory-vector` | 报 `absent`（多数环境本来就没装） | `memory-vector` |
| `ondra-memory-prospective` | 待办与承诺两面一起报 `absent` | `todo` / `promise` |
| `ondra-time-capsule` | 报 `absent` | `capsule` |
| `ondra-lexicon` | 报 `absent` | `lexicon` |
| `ondra-diary` / `ondra-narrative-log` / `ondra-snapshot` | 报 `absent`（它们本来就 `blind`） | 对应面 |
| `ondra-clock` | 退回系统时间 | 无 |
| `ondra-config-schema` | 退回插件实例配置 | 无 |

> 单面抛错只把那一面记 `failed` 并继续走完（C3：错误不传播，但**绝不咽下去**），
> 随后 `complete=false`、该面进 `residue`。半途停下的清算最糟——
> 用户既不知道删到哪儿了，也不知道还剩多少。

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。不装定时器、不在 `apply` 里执行、不持独占资源；关掉后应用外壳的「忘记」按钮拿不到服务，其余插件完全不受影响。
2. **我的状态存在哪？** **不落盘**。全部统计只在内存（`planned` / `executed` / `refused` / `erasedBySurface` / `failedSurfaces`），进程重启归零。**故意不落盘**：给「遗忘操作」写一份持久日志，本身就是一处新的残留。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.forget-right`；`stats().failedSurfaces` 记每一次面失败；`ForgetRun.residue` 逐面列出没清干净的项；每面 `ScrubOutcome.detail` 写明为什么。
4. **我依赖谁？缺席时怎么降级？** 十一面上游（全软）+ 时钟 + 配置，逐个见 §6；初始化任一步失败都不抛。
5. **我和同域的谁共享了可变状态？** **没有**。只通过上游公开方法操作它们自己的数据，本插件自己不存任何副本。

---

## 8. 已知限制（诚实清单）

1. **承诺行删不掉。** `ProspectiveService` 里只有 `dropTodo()`，**没有删承诺的方法**；`expire()` 只是把状态转成 `expired`，原文 `text` 仍在表里。本插件只数得出还剩几条。要真删必须给 O-021 补一个入口，属「必须改上游」范畴。
2. **日记删不掉。** `DiaryService` 有 `write()` / `ensure()` / `tick()` / `catchUp()`，**没有任何删除方法**。本插件不代删 Markdown 文件（那是绕过服务边界）。要删只能由人在文件系统里做。
3. **叙事日志删不掉。** `prune()` 只按保留期清整天文件，且会连带删掉无关条目；没有按 id 或按内容删的入口。
4. **快照不代删。** `SnapshotService.prune()` 存在，但删快照不可逆、且是 O-009 的地盘。本插件只读 `list()` 并在 `blindDetail` 里数出份数。**这一面是最容易被漏掉的**：`VACUUM INTO` 做的是整份库副本，删完记忆之后旧快照里一个字都没少。
5. **图边数不出来。** O-015 `GraphService` 只有 `edgeOf` / `neighbors` / `forgetOf` / `relatedness` / `diffuse` / `decay` / `prune`，**没有「列举全部边」的入口**。残余扫描对 `memory-edge` 报 `countable: false`。同一条限制 O-100 已登记为待裁决（第 6 条）。
6. **向量面按目标扫时数不出来。** `VectorService` 有 `count()` 但没有「按 id 查在不在」，故传了目标时该面只报「数不出来」，不传目标才给总数。
7. **`subject` 目标靠上游筛。** `fact` 类给 `ids`、`subject` 类交给 O-010 的 `listFacts({ subject })`——**不自己比字符串**（主体名归一化口径归上游，自己比会漏掉大小写与空白差异）。`fact` 类额外做一次「哪些 id 不存在」的核对并打日志，避免计划里写「将删 5 条」而实际只删得掉 3 条。
8. **一次最多 200 个目标**（`MAX_TARGETS`），单项最长 120 字（`MAX_VALUE_CHARS`）。超出直接抛 `bad-target`，**不做宽容截断**——悄悄丢掉一条会删出「看起来成功、其实少一条」的结果。
9. **`execute()` 一遍跑完十一面，中途不暂停。** 不做「删除过程中再问一次」：确认发生在执行前，执行中途再问，一旦用户关掉窗口就停在半路。
10. **本插件不提供预览「将被删的正文」。** 计划里只有 id 与条数，不含正文——把即将删除的原文摊在确认页上，等于给它多造一处副本（与 O-101「封存期结构性不可读」同一条理由）。

---

## 9. 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 「被遗忘权」的三层含义（内容删除 / 传播阻断 / 下游通知） | GDPR 第 17 条（Right to erasure）的法律释义与工程实践讨论 | gdpr-info.eu | — | 借「删除不只是删主表，还要通知并清掉所有下游副本」这一条判断；本插件据此把清算拆成十一面而不是只调一个 `forget()` | 自研 `SURFACE_SPECS` + `SCRUB_ORDER` 清算表 | 否（仅思想参考） |
| 两阶段删除（预览 → 确认 → 执行） | AWS / GCP 控制台的 destructive-action 模式（type-to-confirm） | — | — | 借「不可逆动作必须让人先看到影响面」这条；本插件据此让 `plan()` 只读、`execute()` 收令牌 | 自研 `ForgetPlan` / `{ confirm: 'forget' }` | 否（仅思想参考） |
| 「删除失败不能报成功」的幂等清算 | S3 批量删除的分条结果模型（逐条 `Deleted` / `Error`） | docs.aws.amazon.com | — | 借「批量删除必须逐条报结果，不能只报一个总数」这条 → `ScrubOutcome[]` 逐面 + 逐条 | 自研 `isComplete()` / `residueOf()` | 否（仅思想参考） |
| 记忆正文与墓碑 | O-010 `ondra-memory-core` | — | — | **复用服务**：`forget(id, reason)` / `listFacts()` / `countFacts()` | 只调公开方法，不碰公式 | 否 |
| 钉子与「唯一执行口」 | O-017 `ondra-memory-audit` | — | — | **复用服务**：`forget()` / `unpin()` / `pinned()` | 在位时优先走它 | 否 |
| 图边清理 | O-015 `ondra-memory-graph` | — | — | **复用服务**：`forgetOf()` | 只调这一个方法 | 否 |
| 其余七面上游 | O-021 / O-101 / O-122 / O-137 / O-045 / O-135 / O-009 | — | — | **复用服务** | 逐面一个方法，删不掉就报 `blind` | 否 |

**档位判定（master-plan §3.8）**：生态里有通用的「数据删除编排」库（如各种数据保留期框架、DSAR 工具），但它们都假设**自己能直连数据库**——那与本产品的服务边界直接冲突：一旦本插件拿到 SQL 句柄，它就能绕过 O-010 的墓碑、绕过 O-017 的钉子，几个月后没人说得清哪条记录是谁删的。故判定：**机制自研（约 700 行纯编排 + 纯判定），十一面的上游能力全部复用**。本插件只贡献「怎么把已经存在的删除口排成一张清算表并如实报残余」这一条规则，不贡献任何存储或删除机制。

---

## 10. 多方案分支（master-plan §12）

按 §14.1 三条判定顺序，**不跳级**：

| 分歧点 | 处理 | 理由 |
|---|---|---|
| 删除入口：直连表 / 走上游服务 | **只走上游，不分支** | 直连能删得更干净（比如承诺行、日记），但代价是绕过墓碑与服务边界；正确 > 方便 |
| 执行粒度：单面 / 全十一面 | **只做全十一面** | 让调用方挑面，等于让它自己判断「哪些面要紧」——那正是本插件存在的意义 |
| 顺序：固定 / 可配 | **固定，不分支** | 可配顺序一定能调出一个先删真源的顺序，而那个顺序下一切都删不干净 |
| 承诺行：`expire()` 转状态 / 报 `blind` | **报 `blind`** | `expire()` 只改状态、正文仍在，报「已处理」就是假回执 |
| 台词库：自动清 / 等人点名 | **等人点名（`clear-lexicon` 默认关）** | `reset()` 会连别人说的话一起清掉，不能替用户做这个决定 |
| 残余计数：数不出来就报 0 / 报 `null` | **报 `null`** | 0 会被读成「已经干净了」，而真相是「查不了」。与 O-102 同一条理由 |

**稳定优先**：任一面失败只让那一面 `failed`，其余照常走完——半途停下比走完再报残余更糟。但**失败一定让 `complete=false`**。

---

## 11. 文件清单（11）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单，含 `ondra.bundle.patch` |
| `tsconfig.json` | NodeNext + strict + declaration |
| `cordis.patch.yml` | 宿主补丁：`insert` 无 id → 追加根入口 |
| `src/index.ts` | 入口：`name` / `apply(ctx)` / `Config`，注册配置段与服务 |
| `src/types.ts` | 契约唯一真源：服务键、十一面定义、能力闭集、状态闭集、错误码、上游镜像 |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → `DEFAULT_CONFIG` / `SectionDecl` / `completeConfig`） |
| `src/plan.ts` | 计划层纯函数（目标规整 / 面能力判定 / 计划构建 / 残余行）；**不碰任何服务** |
| `src/scrub.ts` | 判定层纯函数（目标解析 / 面结果构造 / 完成判定 / 残余判定）；**不含任何 IO** |
| `src/service.ts` | 服务实现（十一面逐面执行 + 逐面降级 + 残余计数） |
| `locale/zh.json` / `locale/en.json` | 中文 / 英文元数据 |
| `README.md` | 本文 |
| `icon.svg` | 由 `node tools/sync-plugin-icons.mjs` 从根 `icon.svg` 刷成（唯一真源） |

> 表里 11 行是因为 `locale` 与 `icon.svg` 合并了说明；实际 12 个文件。

---

## 12. 快速上手

```yaml
# cordis.yml（节选）
plugins:
  - ondra-forget-right     # 依赖 ondra-memory-core（执行期硬）+ 其余十面（全软）
```

```ts
// 干净卸载：不装定时器、不落盘、不持独占资源
// ctx.effect 会撤掉配置段与服务 provide；没有任何东西需要清理
```

---

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

本轮为**静态自检**，未 `pnpm install`、未 `build`、未 `tsc`、未启动 app。逐项结果见交付简报。
