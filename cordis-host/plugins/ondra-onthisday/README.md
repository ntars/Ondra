# ondra-onthisday · 那年今日

> 手册 §2.6 八块装配的第 ④ 块 `【那年今日】`。上限 3 条，按同一月日回看旧记忆。
> 档位标记：**〔研〕**（台账 O-049 给定，判定依据见「技术来源」）。

## 一句话

每天问一次「今天有什么旧事」，它从记忆库里翻出最多三件，按「周年 → 整年 → 整月」排好交出来。
**它不拼字、不算清晰度、不开口、没有定时器、不调模型。**

## 职责

| 做 | 说明 |
|---|---|
| 判定「今天」 | 从 `ondra-clock` 的时区取今天的年月日，转成日历日序号（与时区、夏令时无关） |
| 三档锚点命中 | `anniversary`（往年同月同日，含 2 月 29 日折叠）/ `year-day`（正好 365 天）/ `month-day`（差 30/31 天），**一条只归一个档** |
| 全库取材 | 分页扫到 `scanLimit` 为止，**不抽样**；扫不完如实上报 `truncated` |
| 两级去重 | 字面指纹（同一条被写了两遍）+ 图谱关联度 ≥ 0.72（同一件事的不同措辞） |
| 定序截断 | 档位 → 年数（越久远越先）→ 显著度 → id；超出 `cap` 的条数如实报 `dropped` |
| 当天冻结 | 同一天内答案恒定（前缀缓存要求），跨天重算 |
| 带出记账 | `take()` 时对尚未记过账的条目 `markSeen` + `reinforce('mention')`，一天每条只一次 |

## 两条「不做什么」写在装载路径上

1. **装载期不预计算。** 此刻记忆库可能还没开好（或退回了空的内存兜底），
   算出来的「今天没有旧事」会被冻结点固定一整天，而日志里一切正常。
   第一次被问的时候再算——那时代价已经付过（宿主首屏已过）。
2. **一行都没扫到就不冻结。** 只有「确实看过库」（`scanned > 0`）才值得把结论固定一整天。
   扫到 0 条只说明「没看到」，不说明「没有」；下一次查询会重扫一次，成本是一次空表查询。

## 明确不负责

1. **不拼注入行。**「3 年前记下、提过 2 次」归 O-036 `ondra-prompt-inject` 的 `formatLine()`。
2. **不算清晰度。**「记不太清了」「只剩个模糊的影子」归 O-013 `ondra-memory-decay` 的 `clarityOfRecord()`，本插件原样透传 `clarity`。
3. **不在 21:05 自己开口。** 那是 ⑧ 固定回忆（手册 §2.3），归 O-018 `ondra-memory-humanlike`。本插件零定时器。
4. **不写记忆、不改权重。** 唯一写入口是 `markSeen` / `reinforce`，且只在 `take()` 且开关打开时。
5. **不做注入装箱与预算。** 装不下时写「另有 N 条未展开」是 O-036 的事；本插件只给 `dropped` 这个数字。
6. **不生成文本、不调模型。** 零 `llm-gateway` 依赖，零 token 成本。
7. **不碰封存条目。** `sealed` 一律跳过，任何开关都不放开（手册 §2.4）。

## 服务键与依赖

| 项 | 值 |
|---|---|
| 提供服务键 | `ondra-onthisday`（连字符，符合手册 §8.4 `^[a-z][a-z0-9_-]{1,63}$`） |
| 硬依赖 | `ondra-memory-core`（缺席 → `reason: 'no-memory'`，服务照常注册） |
| 软依赖 | `ondra-clock`（缺席 → 按本机时区，日志会提醒）· `ondra-memory-decay`（缺席 → 不带清晰度）· `ondra-memory-graph`（缺席 → 只做字面去重）· `ondra-path-layout`（缺席 → 纯内存）· `ondra-config-schema` / `ondra-identity`（缺席 → 用实例配置 / 默认日志名） |

**包间不 import**：全部经 `ctx.get()` 取服务，`undefined` 就静默降级（§3.3-1、§15.5）。

## 契约

```ts
interface OnThisDayService {
  readonly available: boolean
  readonly reason?: 'disabled' | 'no-memory' | 'memory-unavailable' | 'bad-day-key'
  readonly clockReady: boolean
  readonly memoryReady: boolean
  readonly stored: boolean

  today(at?: number): OnThisDayView        // 不记账，同一天恒定
  take(at?: number): OnThisDayTake         // 记账，同一天每条只一次
  explain(memoryId: string, at?: number): OnThisDayWhy | undefined
  reset(at?: number): void                 // 丢掉当天冻结点与记账
  stats(): OnThisDayStats
}
```

`OnThisDayItem` 的字段刻意对齐 O-036 `formatLine()` 的入参
（`category` / `text` / `createdAt` / `timesSaid` / `revisions` / `clarity`），
消费方拿到就能直接拼行，不需要再做一次映射。

`OnThisDayView` 里 **`dropped` 与 `truncated` 是两个数，不合并**：
前者是「今天有 6 条只给了 3 条」（该调 `cap`），后者是「库太大没扫完」（该调 `scanLimit`）。
合成一个数字，看报告的人一定按错的方向调。

## 配置

| 键（camel） | 段键（kebab） | 默认 | 出处 |
|---|---|---|---|
| `enable` | `enable` | `true` | — |
| `cap` | `cap` | `3` | 手册 §2.6 ④ 逐字「≤3」 |
| `scanLimit` | `scan-limit` | `5000` | 自定；扫不完会上报，不静默漏 |
| `pageSize` | `page-size` | `200` | 自定；真实页大小由存储层夹紧 |
| `shelfAnniversary` | `shelf-anniversary` | `true` | 手册「≥1 年」 |
| `shelfYearDay` | `shelf-year-day` | `true` | 手册「整 365 天」 |
| `shelfMonthDay` | `shelf-month-day` | `true` | 手册「整 30 天」 |
| `leapFold` | `leap-fold` | `true` | **自定，待裁决** |
| `includeArchived` | `include-archived` | `true` | 手册 §2.4「只忘不删」的推论 |
| `graphDedupe` | `graph-dedupe` | `true` | 手册 §9.7 `same_topic` 下沿 0.72 |
| `freezePerDay` | `freeze-per-day` | `true` | 手册 §8.5 前缀缓存 |
| `reinforceOnTake` | `reinforce-on-take` | `true` | 手册 §2.3「三种想起路径都会调 reinforce()」 |
| `verbose` | `verbose` | `true` | — |

`cordis.patch.yml` **刻意不写 `config`**：默认值唯一真源是 `src/settings.ts` 的 `FIELD_SPECS`，
写第二份必然分叉。

## 三档怎么落到代码里

手册只给一句话：「那年今日（≥1年 / 整365天 / 整30天，≤3）」，没给判定规则。本插件的落法：

| 档 | 判定 | 为什么单独成一档 |
|---|---|---|
| `anniversary` | 往年**同月同日**；另加「记忆是 2 月 29 日、今天是平年 2 月 28 日」的折叠 | 「那年今日」的语义本体 |
| `year-day` | 日历日差**正好 365**，且不同月同日 | 同月同日必然差 365 或 366 天，反过来却不一定：差 365 天而不同月同日的只剩闰日折叠那一种。**关掉 `leapFold` 时它是唯一的兜底**，否则 2 月 29 日的记忆在平年整年不见。刻意不放到 366——那只会让闰日那条在 2/28 与 3/1 各说一次 |
| `month-day` | 日历日差 **30 或 31** | 「一个月前」有 28/30/31 三种月份长度，取 30/31 是「宁可多带一条」 |

**一条记忆只归一个档**，优先级就是上表顺序（`matchShelf` 里三段 return）。
允许重叠会让同一条记忆在同一天被提两次，用户只会觉得「她怎么又说了一遍」。

**「同月同日」与「差 365 天」是两种口径，但这里不做分支**（§12.1「能融就融」）：
它们不是两个实现，是同一个判定里的两个条件，参数化成一个优先级序列即可。
做成两个文件反而会让「同一件事在哪个分支里」变成一个要读两处才能回答的问题。

## 隔离五问（§16.4）

1. **关掉我，谁受影响？** 只有 ④ 这一块。O-036 的其余七块照常，对话照常。
   当前状态下更准确的说法是：关掉我不会让任何东西消失——因为注入链的 ④ 仍走 O-036 的内联实现（见「已知限制」第 1 条）。
2. **我的状态存在哪？** `user/onthisday.json`（0600，临时文件 + `rename` 原子写）。
   只存「选了哪几条 id」与「哪几条已记账」，**不存记忆正文**。路径服务缺席时纯内存。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.onthisday`（经 `ondra-identity` 的 `loggerName('onthisday')`）。
   扫描失败会打 `warn` 并在 `issues` 里留一句中文；`stats().failures` 有累计。
4. **我依赖谁？缺席时我怎么降级？** 见「服务键与依赖」表。每个 `ctx.get()` 之后都判空，
   缺席时服务照常注册，`today()` 返回带 `reason` 的空视图，而不是让整包停在 PENDING。
5. **我和同域的谁共享了可变状态？** **没有。** 只读记忆库，唯一的写是 `markSeen` / `reinforce`，
   那是 O-010 的写入口，本插件是调用方而不是共享者。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 按日历日回看（档位表） | Kageetai / obsidian-plugin-journal-review | `https://github.com/Kageetai/obsidian-plugin-journal-review` | 未核对（只读说明，未引入） | 把「回顾跨度」写成「数量 + 单位 + 是否递推」的一张表，而不是硬编三档；视图在跨日时刷新 | `settings.ts` 三个 `shelf*` 布尔 + 常量区间，跨日重算 | 否 |
| 同月同日 + 容差 | Memos 社区的 On This Day 插件（讨论贴 6441） | `https://github.com/usememos/memos/discussions/6441` | 未核对（只读说明） | 除「同一天」外给 ±N 天容差，且离群匹配要标出来（+1 天 / -2 天） | `matchShelf()` 的 365 天与 30/31 天区间；`leapFolded` 字段标出折叠 | 否 |
| 「往年同一天」而不是任意范围 | BitmapAsset / dear-agent | `https://github.com/BitmapAsset/dear-agent` | 未核对（只读说明） | `on_this_day` 只回看往年同一日历日，不做范围检索 | 只按「同月同日 / 定差天数」命中，不做区间查询 | 否 |
| 按 `MM-DD` 触发、不调模型 | ondra-fount-memory | 见其发布说明（社区插件，MIT） | MIT（仅据说明） | 说明「按日历日注入」在 DSH 生态里已有先例，且完全不需要模型参与 | 纯规则判定，零 `llm-gateway` 依赖 | 否 |
| 三档锚点 / ≤3 条 / 只忘不删 / 归档语义 | 开发手册 §2.6、§2.4 | 仓内 `Ondra-dev-handbook.md` | 本项目文档 | 逐字参数 | 直接落参数与判定 | — |
| 行格式与「另有 N 条」 | O-036 `ondra-prompt-inject` | 仓内 `cordis/ondra-prompt-inject` | 本项目 | 行格式唯一实现 | **不重复实现**，只交原料 | 否 |
| 清晰度三档话术 | O-013 `ondra-memory-decay` | 仓内 `cordis/ondra-memory-decay` | 本项目 | 0.7 / 0.4 两个阈值 | **不重复实现**，调用 `clarityOfRecord()` | 否 |
| 关联度去重门槛 | O-015 `ondra-memory-graph`（§9.7 `same_topic` 0.72） | 仓内 `cordis/ondra-memory-graph` | 本项目 | 用 `relatedness()` 判「同一件事」 | 每检查一条候选问一次图谱 | 否 |

> **诚实说明**：上表前四行只读了项目说明页与 README，**没有读源码**，所以借鉴的是机制意图（档位怎么组织、容差怎么给），不是实现细节。没有任何一行代码被复制。

**为什么是〔研〕而不是〔复〕**：生态里的实现全是「按日历日翻文件 / 翻笔记」——
数据源是纯文本，判定只需字符串比对。本插件的数据源是结构化记忆表（`listFacts` **没有日期区间条件**），
还要与 O-013 的强度分档、O-015 的图谱去重、O-010 的带出记账协同，
这一层编排没有可复用实现。日期算术与档位判定是自己写的，但**没有自研历法**——
年月日全部来自 `ondra-clock`，本插件只做「同日比对」与整数日序号换算。

## 已知限制

1. **注入链的 ④ 仍走 O-036 的内联实现（契约冲突，已登记）。**
   `ondra-prompt-inject/src/blocks.ts` 的 ④ 段自己实现了 `anniversaryOf()` 与取材，
   与本插件构成**双真源**。切换点是那一段（约 336–367 行）改成
   `ctx.get('ondra-onthisday')?.take()` 并用返回的 `items` 拼行。
   本轮纪律是「不改已 done 的插件」，故**未改**，台账已记「契约冲突」并留待裁决。
   在切换之前，本插件的价值在面板侧（记忆抽屉的「那年今日」分组，手册 §2.5 第 5 条）
   与未来的预览/审计，**不在注入链上**。
2. **`scanLimit` 之外会漏。** 5 万条以上、且命中落在窗口外的记忆不会被发现，会报 `truncated`。
   这是「扫得完」与「一次算十几毫秒」之间的取舍，不是 bug。
3. **`offset` 翻页在并发写入时可能跳行。** 翻页期间新记忆被插入会让后续页整体后移，
   可能漏掉一条。重复行已用 id 去重兜住，**跳行兜不住**。频率极低（只在算这一天的几十毫秒内），
   且漏的是一条候选，不会让整块失效。
4. **图谱去重只看前 8 条候选**（`GRAPH_DEDUPE_WINDOW`）。再靠后的候选在有更靠前者时本来就选不上。
5. **状态文件坏掉会重算一次。** 表现为「当天重新选了一遍 + 可能重复加固一条」。
   没有做校验和，因为这块的失败代价远小于「为了修它引入一个坏不了的机制」。
6. **没有「排除某条」的接口。** 想让它别再提某件事，用 O-017 的 `seal()`（封存）——
   本插件对封存条目一律跳过。这是刻意的：多一个排除名单就多一份要同步的状态。

## 待裁决

| # | 项 | 当前取值 | 理由 | 备选 |
|---|---|---|---|---|
| ① | 2 月 29 日的记忆在平年怎么办 | 折叠到 2 月 28 日，标 `leapFolded` | 不折叠的话那天每四年才有一次机会；人回忆时也会说「是那年二月底」 | 严格跳过（`leapFold=false`） |
| ② | 同档内按「年数降序」 | 越久远越先 | 一年前的事用户自己还记得，三年前的可能真忘了；对应手册「越模糊越容易被想起」 | 年数升序 / 按显著度 |
| ③ | 归档条目是否参与 | 参与 | 归档 = 只忘不删，「忽然想起」正是它的用处 | 与 O-036 一致地排除 |
| ④ | 「整年」档要不要独立存在 | 独立 | 手册逐字列了三档；它也确实是关掉折叠后的唯一兜底 | 并入周年（数学上基本重合） |
| ⑤ | 「整月」容差取 30/31 | 两值都算 | 月份有 28/30/31 三种长度，取「宁可多带一条」 | 只算 30 / 只算 31 |
| ⑥ | 图谱去重门槛 0.72、窗口 8 | 常量 | 0.72 是 `same_topic` 初值下沿；窗口 8 覆盖到「前三条已选 + 五条观察」 | 提成配置项 |

## 自检

静态自检（不 `install`、不 `build`、不 `tsc`、不启动 app）：9 项机械检查 + 语言 5 项 + 交叉扫描 3 项，
结果见台账 `ondra-plugin-index.md` 的「第 9 组产出登记」。
