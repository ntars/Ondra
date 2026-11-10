# ondra-prompt-inject

> O-036 · 对话链 · 档位〔研〕 · 服务键 `ondra-prompt-inject`

她这轮想起什么，由一只箱子决定。

---

## 一、职责

把「她这轮该想起什么」变成一段**有预算上限**的正文，并且**一条都不静默丢**。

1. **取材**：八块（手册 §2.6 的 ①~⑧）各自向上游要候选。
2. **装箱**：核心段整块装；其余全局按权重逐条试，**装不下跳过这条、继续试下一条**。
3. **渲染**：段标题 + 正文；段标题里写「另有 N 条未展开，chain_recall 可查」。

八块与来源：

| # | 块 | 标题 | 来源服务键 | 上限 |
|---|---|---|---|---|
| ① | `promises` | 【说好的事】 | `ondra-memory-prospective` | 3（**手册未给数**，见待裁决①） |
| ② | `pinned` | 【不能忘的】 | `ondra-memory-audit` + `ondra-memory-core` | 8（手册逐字 ≤8） |
| ③ | `persons` | 【我认识的人】 | `ondra-memory-recall` | 5（手册逐字 ≤5） |
| ④ | `anniversary` | 【那年今日】 | `ondra-memory-core` | 3（手册逐字 ≤3） |
| ⑤ | `recall` | 【这会儿想起来的】 | `ondra-memory-recall` | **不限**（P0：召回不按条数砍） |
| ⑥ | `lessons` | 【记下的道理】 | `ondra-memory-core` | 3（手册逐字 ≤3） |
| ⑦ | `ripple` | 【顺着话头想起来的】 | `ondra-memory-humanlike` | 不限（只受预算） |
| ⑧ | `resurface` | 【今天想起来的】 | `ondra-memory-core` | 1（手册「补 1 条」） |

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 人格四段拼装、预算裁剪 | `ondra-persona-assemble`（O-023） |
| 会话内冻结前缀、把注入拼进消息序列 | `ondra-dialogue`（O-033） |
| 已见 id 记账、压缩信号释放已见 | `ondra-inject-dedupe`（O-142） |
| 检索打分、五因子融合 | `ondra-memory-recall`（O-014） |
| 寿命与强度、`markSeen` 带出记账 | `ondra-memory-core`（O-010） |
| 三档清晰度话术 | `ondra-memory-decay`（O-013） |
| 池归属、海马体永不注入的判定 | `ondra-memory-pool`（O-131） |
| 面向模型的 `chain_recall` 工具入口 | `ondra-organ-host` / `ondra-organ-gate`（O-132 / O-138） |

三条**刻意不做**：

1. **不碰人格段。** 人格四段归 O-023、由 O-033 冻结成前缀；注入是易变段。把人格塞进注入，等于每轮都在改前缀，命中率会归零（§8.5）。
2. **不自己做去重记账。** `seen` 是入参不是状态：本插件不存「谁进过上下文」，只把 `suppressed` 与 `dropped` **分开报**——O-142 才能分清「该释放已见」还是「该加预算」。
3. **不注册工具。** 注册工具要 `inject: ['tools']`，上游缺席时整插件会停在 PENDING。`expand()` 是服务方法，工具面归 O-132/O-138。

## 三、服务键与方法

```
ondra-prompt-inject        ← 连字符，不是 ondra:prompt-inject
```

| 方法 | 说明 |
|---|---|
| `budgets()` | 三个预算预设（1200 / 2600 / 24000，手册 §2.6 逐字） |
| `budget()` | 当前生效预算。**唯一解析点**：`budgetChars > 0` 用它，否则用档位 |
| `plan(request?)` | 只装箱不渲染，返回完整报告。**永不抛出** |
| `render(request?)` | 装箱 + 拼成一段正文（段之间空一行） |
| `expand(ids, at?)` | 按条目 id 取回原文（「正文留盘按需展开」） |
| `stats()` | 见下 |
| `available` / `reason` | 只看配置开关（降级 ≠ 不可用） |

`plan()` 的入参：`budgetChars?` / `query?` / `at?` / `seen?` / `only?` / `includeHeadings?`。

`InjectionPlan` 的字段：`budgetChars / usedChars / remainingChars / overBudget / coreChars / segments / ids / suppressed / dropped / degradations / digest / at`。

`stats()`：`available / reason? / budgetChars / lastUsedChars / lastOverBudget / lastItems / lastDropped / lastSuppressed / plans / sources`

### 挂进宿主系统提示词（`ondra:injection`）

`apply()` 会把 `render()` 的正文注册成宿主 `@ntars/ondra-system-prompt` 的一条**运行时上下文**：

| 项 | 取值 | 说明 |
|---|---|---|
| 上下文名 | `ondra:injection` | 带 `ondra:` 前缀；裸名字迟早与宿主既有贡献者撞名，撞名时宿主抛 `already registered`，整次装配失败 |
| 排序位 | `220` | 宿主 `CONTEXT_ORDERS` 现用到 `200`（`PRODUCT_SOURCE`）与 `210`（`WEB_SURFACE`），本插件附在其后 |
| 插值 | `false` | 记忆正文可能出现 `{{…}}`；一旦被当成提示词变量，宿主 `renderPrompt` 会抛 `unknown prompt variable`，一条记忆就能毁掉整轮装配 |
| 正文 | `render().text` | `available=false` 时返回空串（空串在宿主里等于不贡献），渲染异常时返回空串并只报一次 |

三处取舍：

1. **用上下文、不用章节。** 章节进的是缓存前缀；注入每轮都可能不同，写进前缀会把缓存命中率打回 0（§8.5，见本文第 45 行）。
2. **宿主没有 `systemPrompt` 时不阻断。** 精简 profile 里不会有这个服务；此时只打一行 `warn`，插件照常提供 `render()`，供别的调用方使用。
3. **只管正文，不管消息序列。** 冻结前缀、把上下文拼进消息序列仍归 O-033 `ondra-dialogue`；本插件只负责「这一轮该想起什么」这段文字。

## 四、配置

| 键（camelCase） | 段字段（kebab） | 默认 | 依据 |
|---|---|---|---|
| `enable` | `enable` | `true` | — |
| `budgetPreset` | `budget-preset` | `standard` | 手册「默认 2600」 |
| `budgetChars` | `budget-chars` | `0` | 0 = 用档位预设；真源只有 `budgetOf()` |
| `maxPromises` | `max-promises` | `3` | **手册未给数**（待裁决①） |
| `maxPinned` | `max-pinned` | `8` | 手册 §2.6 逐字 ≤8 |
| `maxPersons` | `max-persons` | `5` | 手册 §2.6 逐字 ≤5 |
| `maxAnniversary` | `max-anniversary` | `3` | 手册 §2.6 逐字 ≤3 |
| `maxLessons` | `max-lessons` | `3` | 手册 §2.6 逐字 ≤3 |
| `anniversaryScanLimit` | `anniversary-scan-limit` | `500` | 扫描成本闸，截断会报 `anniversary-scan-capped` |
| `includeHeadings` | `include-headings` | `true` | 段标题是「另有 N 条未展开」的载体 |
| `respectPool` | `respect-pool` | `true` | 海马体永不注入是硬性质 |
| `claritySuffix` | `clarity-suffix` | `true` | 话术来自 O-013，不自己写阈值 |
| `rippleRings` | `ripple-rings` | `1` | 多一圈多一份「不一定准」 |
| `verbose` | `verbose` | `true` | 只影响噪声 |

## 五、关键裁决

1. **装箱对条目、不对块。** 「⑤ 装不下就整块停」会让 ⑥⑦⑧ 永远进不来，而它们里面常有短句。手册原话是「跳过这条、继续试下一条」。
2. **核心段是 ① ②。** 手册只说「核心段永不参与装箱」，没点名。取 ①（到期提醒）与 ②（钉住）：被预算挤掉一次，用户看到的是「她忘了我们的约定」。宁可 `overBudget: true`。**待裁决②**。
3. **`dropped` 三种原因不合并。** `over-budget`（该加预算）/ `block-cap`（该调上限）/ `pool-denied`（加预算没用，池说它不能进）。合成一个数字，看报告的人一定会按错的方向去改。
4. **`suppressed` 单独报。** 已见条目在装箱**之前**摘掉，所以它们既不占预算、也不进「未展开」的条数。
5. **段标题的括号改成逗号。** 手册写 `另有 N 条未展开（chain_recall 可查）`，而标题本身已有一层 `【…】`，两层圆括号会读成「可查（…）」。词一个没少。
6. **⑤ 不设条数上限，③ 的 ≤5 挡下的 person 会落到 ⑤。** 上限只作用在**块**上，不作用在**记忆**上——这是 P0「召回不按条数砍」在本插件里的具体形状。
7. **没有话头就不检索。** `query === ''` 时不调 `search('')`：那会把全库按新鲜度倒出来，那是「按层发牌」（O-018），不是召回。
8. **⑦ 没有种子就不扩散。** 不拿第一条记忆凑数——那是编一个话头。
9. **承诺行不套记忆行格式。** 记忆行说「多久以前记下」，承诺要说「还有多久到期」；套用会把「3 天后要考试」读成「3 天前记了一件事」，方向正好反。
10. **池判定按 `ref` 缓存一次。** ⑤ 有 40 条命中就是 40 次单行查询，否则每轮都在做无谓的库访问。
11. **`expand()` 对承诺返回 `found: false`。** 承诺正文本来就在注入行里；拿承诺 id 去查记忆只会查到一个不存在的记录。
12. **`digest` 用内容算，不用时间。** 「内容没变但时间变了」不该触发一次重推。

## 六、多方案说明（§12）

本插件**没有分支**。两处曾考虑分支，最终按「能融就融」合成一个：

| 方案 | 结论 |
|---|---|
| 预算「三档枚举」vs「一个数字 + 预设表」 | ✅ 一个数字 + 预设表（`budgetOf()` 唯一解析点）。两套并存 = 双真源 |
| 已见过滤「入参集合」vs「插件内记账」 | ✅ 入参集合。插件内记账会让 O-142 变成摆设，两处账本必然漂移 |

## 七、契约对位（不 import，只镜像）

| 上游 | 用到的成员 | 镜像位置 |
|---|---|---|
| O-010 `ondra-memory-core` | `getFact` / `listFacts` / `dueForResurfacing` | `src/types.ts` `CoreLike` |
| O-013 `ondra-memory-decay` | `clarityOfRecord().phrase` | `DecayLike` |
| O-014 `ondra-memory-recall` | `search().hits[]`（`id/text/category/strength/factors.importance`） | `RecallLike` |
| O-016 `ondra-memory-prospective` | `dueForReminder()`（`promise/hoursLeft/urgency/inGrace`） | `ProspectiveLike` |
| O-017 `ondra-memory-audit` | `pinned()`（`id/pinnedAt/note`） | `AuditLike` |
| O-018 `ondra-memory-humanlike` | `ripple().items[]`（`id/text/ring/weight`） | `HumanlikeLike` |
| O-131 `ondra-memory-pool` | `eligibleForInjection().eligible` | `PoolLike` |

O-033 的 `TailPart` 是 `id / text / order / ttlMinutes / confidence`。本插件的 `PackedSegment` **不冒充**那个形状：段标题要单独带出去（预览要显示「另有 N 条」），而 `TailPart` 没有 `heading` 字段。接线由调用方把 `heading + '\n' + text` 拼成一段 `text`，`order` 取 `segment.order`。**这是有损的**（标题与正文在 `TailPart` 里分不开），已写进「已知限制」。

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 上下文预算装箱 | Letta（MemGPT） | github.com/letta-ai/letta | Apache-2.0 | 「核心块常驻 + 其余按预算取」的分层思路（**只读其公开文档，未读源码**） | 自研 `pack.ts`：核心段豁免 + 条目级跳过 | 否 |
| 记忆注入形态对照 | mem0 | github.com/mem0ai/mem0 | Apache-2.0 | 反面对照：它是 topK 注入，与本插件「不按条数砍」互斥 | 无（只作机制对照） | 否 |
| 注入去重（接口形状） | ondra-meow-memory / ondra-memory-delta | 手册 §1.6 记载 | — | 「首轮大块 + 已见记账 + 只推增量」的接口形状（归 O-142） | 本插件只留 `seen` 入参与 `suppressed` 出口 | 否 |

档位说明：手册 §1.8 的三档清单**没有点名注入装箱**；台账标〔研〕。判据是「生态里全是 topK，语义互斥」——套适配只能改名不能改行为，故自研。

## 九、隔离五问

1. **关掉我，谁受影响？** 只有「她这轮想起了什么」这一块内容。对话照常进行（O-033 的易变段为空）。
2. **我的状态存在哪？** 仅在内存：累计计数与上一次的数字。**不落盘、不建表**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.prompt-inject`（有 O-001 时按 `loggerName('prompt-inject')`）；`stats()` 的 `lastUsedChars / lastDropped / sources` 是探针；`plan()` 异常时 `degradations` 里必有 `block-error`。
4. **我依赖谁？缺席时怎么降级？** 见第一节的表。七个来源全部可缺席：缺一个少一块，`degradations` 留痕；`core` 缺席时 ②④⑥⑧ 整块不出。
5. **我和同域的谁共享了可变状态？** 没有。所有上游只读，本插件不写任何表。

## 十、已知限制

1. **段标题在 `TailPart` 里分不开。** 接 O-033 时只能把标题并进 `text`；要保留结构得等 O-033 加 `heading` 字段（已登记，不改已 done 的插件）。
2. **两段预算不合并计数。** 人格段（O-023）与注入段（本插件）各有一份 `budgetChars`。人格侧默认已改为 12000（实测一份人设包完整装载需 7,725–10,057 字），本插件仍是 2600（手册 §2.6 的省 token 档，且本插件不在默认启用名单里）。合并总账应由 O-125（提示词预览）或 O-132（器官宿主）报，本插件不替它们算。
3. **④ 那年今日只能近似取材。** O-010 的 `listFacts` 没有日期区间条件，只能按 `last-seen` 升序（最久没被带出的在前）取 N 条再按日历日过滤。用 `created-at` 不行——它是**降序**，库一大就永远扫不到一年前的记忆。被截断时报 `anniversary-scan-capped`；**一个昨天刚被带出、却是两年前写下的记忆，可能落在窗口之外**。
4. **⑥ 的「语义归纳」标记缺失。** 手册 §2.7 的 gist 会标 `semantic:true`，而 O-010 的 `MemoryRecord` 没有这个字段。本插件因此**不在行尾写「是从几件小事里归纳出来的」**——写一句没根据的话比不写糟。
5. **⑦ 的行格式是简化的。** `RippleItem` 不带类别与写入时刻，所以只有 `- [想到的] 正文`，没有「X 前记下」。
6. **`expand()` 只认记忆 id。** 承诺条目展开返回 `found: false`（理由见裁决 11）。
7. **没做「首轮一次大块」的自动判断。** 什么时候传空 `seen`（首轮/压缩后）由 O-142 决定；本插件不猜。

## 十一、待裁决

1. **① 的条数上限（默认 3）**：手册只说「到期提醒」，没给数。
2. **核心段是哪几块**：手册只说「核心段永不参与装箱」。本插件取 ① ②；若要改成只 ①，改 `BLOCK_SPECS` 两处 `core` 即可。
3. **`pinned` 与海马体冲突**：钉住是用户动作，海马体「永不注入」是硬性质。当前**池判定优先**（钉住的记忆若被判 `hippocampus-never` 仍不进注入，记为 `pool-denied`）。
4. **预算 `2000` 与三档 `2600` 并存**：手册 §2.6 同一节既写「预算三档 2600/24000/1200」，又写「实现规范为 2000 字符」。本插件取 2600（与 master-plan §10.3、O-023 一致），2000 未实现。
5. **「常驻 3~6 条 / 检索 FTS 最多 4 条」未实现**：这两条与 P0「召回不按条数砍」直接冲突，且与「装箱制」互斥（装箱制本身就否掉了「取最近 N 条」）。本插件按 P0 执行。
