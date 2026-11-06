# ondra-memory-pool

> O-131 ｜ L2 记忆域 ｜ 档位 **〔研〕自研** ｜ 批次 B2（记忆纵深 P0 第十二项）

八池分层表与三段天级时间轴。一句话职责：**她知道什么该永远记着、什么该自然淡出，而且「不知道该归哪儿」这件事本身会被记下来等人拍板。**

---

## 职责

1. **池表唯一真源**：`pools()` / `poolOf(id)` —— 宽限 / 半衰期 / 归档三列（手册 §2.5 逐行）。
2. **分类（不猜）**：`classify()` 纯判定、`assign()` 判定并落库。
   标签认不出 → 海马体 + `unclassified`。
3. **未归类线索**：同一句重复写满 3 次 → 升级「需人工定池」；`escalations()` 出清单、`resolveHint()` 销账。
4. **三段天级时间轴**：`timelineOf()` —— 宽限到哪天、第一档半衰期在何时、归档在何时、已跨几档。
5. **注入资格**：`eligibleForInjection()` —— 海马体永不注入；已到归档时刻退出主动位。
6. **归档候选**：`dueForArchive()` —— **只出清单，不改任何数据**（沉底动作归 O-013 / O-017）。
7. **人工定池**：`reassign(factId, pool, note)` —— 人改池有最终解释权。

## 明确不负责

- **不算强度、不算权重**。`S = baseHours × …` 只有一个真源，在 **O-010**；`0.5^(Δt/S)` 只在 O-010 一处。
  本插件**没有 `strengthOf` / `weightOf`**，`PoolTimeline` 里也**刻意没有权重字段**。
  加一个 0–1 权重，下一个人一定会拿它和 `strength` 比大小，然后两条衰减曲线永远对不上。
- **不改 `memory_fact` 任何一列**。池归属写 `memory_pool`；`createdAt` / `lastSeenAt` 只读。
  给记忆表加 `pool` 列要同时动 O-010 的 schema、O-008 的迁移与各消费方镜像——四个插件一起动，
  而收益只是省一次查表，端口没有 JOIN，这一次也省不掉。
- **不做沉底**。`dueForArchive()` 只出候选，`archived=1` 由 O-010 的 `archiveDue()` 写（经 O-013 / O-017 安排时机）。
- **不做注入装箱**。装得下几条、装不下写「另有 N 条未展开」，归 **O-036**。
  本插件只回答「这条**允不允许**进注入」，不回答「这一轮装它还是装它」。
- **不顶替单槽池的上一条**。`emotion` 是单槽，但 `assign()` 不替调用方归档旧的那条——
  只把同池成员通过 `slotHolders()` 摆出来。替用户删掉上一条情绪，等于替他改写「我刚刚是什么心情」。
- **不装定时器**。归档时机、夜巡节拍归 O-019 / O-033 / O-077 显式给。

## 服务键

| 项 | 值 |
|---|---|
| 服务键 | **`ondra-memory-pool`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`） |
| 提供 | `ctx.provide('ondra-memory-pool', service)` |
| 消费 | `ondra-store-sqlite` / `ondra-store-memory`（**硬**：池归属要落盘）、`ondra-memory-core`（**软**：只读时钟算时间轴）、`ondra-config-schema`（软）、`ondra-identity`（软，日志命名空间） |

软依赖缺席时**只降级不失败**，且降级可见：
内核缺席 → `stats().clockAvailable === false`，`timelineOf()` 返回 `undefined`、
`dueForArchive()` 返回空数组——**不拿 `assignedAt` 顶替锚点**（见「已知限制 3」）。

## 八池全表（手册 §2.5 逐行，单位天）

| 池 | 宽限 | 半衰期 | 归档 | 注入 | 可分配 | 单槽 | 语义 |
|---|---|---|---|---|---|---|---|
| `core` | ∞ | ∞ | ∞ | ✓ | ✓ | — | 原则 / 人格 / 边界，永不衰减，**上限 32** |
| `fact` | 15 | 365 | 1095 | ✓ | ✓ | — | 关于用户的事实，会变但慢 |
| `skillRule` | 120 | **730** | 3650 | ✓ | ✓ | — | **铁律：必须 / 不许 / 红线**，常驻全量 |
| `skillExp` | 15 | 60 | 365 | ✓ | ✓ | — | 经验：教训 / 工具 / 排障，按需拉 |
| `skill` | 15 | 90 | 365 | ✓ | **✗（legacy）** | — | 代码保留行，只用于读回旧数据 |
| `dailyCore` | 20 | 60 | 180 | ✓ | ✓ | — | 被反复提起的日常 |
| `dailyPartial` | 5 | 20 | 45 | ✓ | ✓ | — | 一次性进展，速朽 |
| `emotion` | 0.125 | 1 | 3 | ✓ | ✓ | **✓** | 单槽状态牌，会自己过期，**不是日志** |
| `hippocampus` | 0 | 1 | 14 | **✗ 永不** | ✓ | — | 原始片段缓冲，等夜巡整理 |

**`skillRule` 730 天 vs `skillExp` 60 天，差 12 倍**——「用户立的规矩」是最该长期保留的一档。
这是手册里最值得照抄的一条，也是本插件把「铁律」独立成池的全部理由。

## 为什么「不猜」

手册原文：

> **标签没命中任何池：不猜。** 落海马体（3 天过期、永不注入）+ 打「未归类」，夜巡单列；
> **同一句重复写满 3 次 → 升级「需人工定池」**。理由：「猜错的代价不对称——猜成 7 天的片面日常，那条就真没了。」

所以 `classifyByLabels()` **只认显式标签**：池 id 本身，或手册表「语义」列逐字出现过的中文名
（原则 / 人格 / 边界 / 事实 / 铁律 / 红线 / 经验 / 教训 / 日常 / 情绪 / 海马体…）。
**刻意不做正文关键词猜测**——「今天吃了拉面」猜成 `dailyPartial`（45 天）还是 `fact`（1095 天）差 24 倍，
而猜错的方向永远是「活得更短」。

「写满 3 次」必须**跨会话**累加，所以线索落 `memory_pool_hint` 表而不是内存计数器：
只放内存的话，进程一重启计数归零，「3 次」永远凑不够，那条记忆就永远躺在海马体里没人管。

## `core` 上限：拒绝，不淘汰

手册原话：

> 核心是不可衰减的那一层，代表「我是谁」。它一旦能被随手追加，就会越写越厚，最后变成一份谁都不读的清单。

所以 `core` 满 32 条时 `assign()` 抛 `PoolError('core-full')` 并记 issue，提示改去写 `AGENTS.md`。
**两个入口共用同一处判定**（`assertCoreRoom`）——上限不能因为走 `reassign()` 就失效，否则它形同虚设。

历史数据超限（例如人工改池把上限撑破）时 `stats()` 里会出一条 `core-full` issue：**只报不删**。

## 表结构

`memory_pool`（2 个索引）：

| 列 | 类型 | 说明 |
|---|---|---|
| `fact_id` | TEXT PK | 记忆 id。主键就是它 → 一条记忆最多一个池，重复分配天然幂等 |
| `pool` | TEXT | 池 id |
| `assigned_at` | INTEGER | 分配时刻（**审计用，不是时间轴锚点**） |
| `source` | TEXT | `explicit` / `label` / `fallback` / `manual` |
| `unclassified` | INTEGER | 是否未归类（只有 `fallback` 为 1） |
| `matched_label` | TEXT | 命中的原始标签 |
| `note` | TEXT | 备注（人工定池时写「为什么改到这儿」） |

`memory_pool_hint`（1 个索引）：

| 列 | 类型 | 说明 |
|---|---|---|
| `digest` | TEXT PK | 去空白后的 sha256 前 32 位（**与 O-010 `digestOf()` 逐字同口径**） |
| `preview` | TEXT | 正文预览（只展示，不回写） |
| `attempts` | INTEGER | 累计出现次数 |
| `escalated` | INTEGER | 是否已升级「需人工定池」 |
| `first_at` / `last_at` | INTEGER | 首末出现时刻 |

**两张表都不建外键**：`fact_id` 指向 `memory_fact.id`，但记忆会被真删（`forget`）。
外键级联有害——它会让人以为「池登记一定和记忆同生共死」。实际上 `forget()` 之后若登记没被清掉，
我们**需要看见**这条孤儿登记并报出来，而不是让数据库悄悄替我们决定。

## 三段天级时间轴：锚点是「最近一次被带出」

```
anchorAt   = lastSeenAt > 0 ? lastSeenAt : createdAt
guardUntil = anchorAt + guardDays    × 86400000
archiveAt  = anchorAt + archiveDays  × 86400000
halfLives  = ageDays ≤ guardDays ? 0 : floor((ageDays − guardDays) / halfLifeDays)
```

**这与 O-010 的新鲜度锚点 `lastHitAt ?? createdAt` 是两个不同的锚点，不要混**：
那一条答「还亮不亮」（小时级强度），这一条答「还占不占主动位」（天级分层）。

用 `assignedAt` 当锚点是错的：一条三年前的核心事实，重新分配一次就会被当成「刚分配」，
宽限重新计一遍，而这类错不会有任何报错。

`∞` 用 `Number.POSITIVE_INFINITY` 而不是 `null`，让 `ageDays < archiveDays` 恒真——
不然每个判定点都要写一次「是不是 null」。

## 配置（全部有默认值）

| 键 | 默认 | 来源 |
|---|---|---|
| `enable` | `true` | 本插件 |
| `coreCap` | `32` | 手册 §2.5「核心池上限 32（CORE_MAX）」 |
| `escalateAfter` | `3` | 手册 §2.5「同一句重复写满 3 次」 |
| `hintCap` | `2000` | 本插件补（线索表上限；到上限拒绝新建，不淘汰） |
| `previewChars` | `40` | 本插件补（只用于展示） |
| `allowLegacySkill` | `false` | 本插件补（legacy `skill` 行是否接受自动分配） |
| `dueScanLimit` | `5000` | 本插件补（归档候选扫描上限） |
| `pageSize` | `500` | 本插件补（分页大小） |

**刻意没有的两个配置项**：

- **没有「海马体是否注入」的开关。** 手册「永不注入」是硬性质。做成布尔就一定会有人打开它，
  然后未归类的原始片段开始挤占注入预算。
- **没有「各池宽限 / 半衰期 / 归档」的数值配置。** 那三列是**规范值**不是**偏好值**。
  做成可调，等于把「用户立的规矩能留 730 天」变成一道产品参数题。
  真要改就改 `src/pools.ts` 一处并留痕。

## 多方案分支说明（master-plan §12）

本插件**不设运行期分支**，落在 §14 的第一档「能融会贯通 → 融」：

| 表面上的多方案 | 怎么融的 | 没有做成分支的理由 |
|---|---|---|
| 「八池」标题 vs 9 行表 | 不融：9 行全部登记，`skill` 标 `legacy` / `assignable:false` | 这是**文档冲突**不是两套实现。删一行会让读回旧数据时 `pool='skill'` 无从判定 |
| 「有内核」与「没有内核」 | 纯分类照跑；时间轴相关接口返回 `undefined` / 空数组 | 这不是两套实现，是**一个可选的上游**。做成两套时间轴才是灾难（两种锚点） |
| 「SQLite」与「内存后端」 | 只走表级 CRUD，两个后端同一份代码 | 用上自定义 SQL 会让内存后端失效，而它存在的理由正是「SQLite 打不开」 |
| 「闸式还是自然沉底」 | 本插件**只出清单**，动作归 O-010 / O-013 / O-017 | 池表回答「哪天到期」，沉底回答「谁去按按钮」。合成一个就是既判又改 |

分区判定依据：§14.1「能融就融，能兼容就做兼容层，都不能才做分支」。

## 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 八池宽限 / 半衰期 / 归档三列 | `ondra-chain`（手册 §2.5 / §3.5 源码实读 `lib/pools.js`） | github.com/canglight/ondra-chain | MIT | 池参数取值（core ∞/32、skillRule 730、skillExp 60、hippocampus 1/14 永不注入）与「铁律独立成池」 | 自研 `pools.ts`，参数逐行抄手册表；表结构与判定逻辑自写 | 否（只读思路） |
| 「未归类不猜 → 海马体 + 重复 3 次升级人审」 | `ondra-chain` | 同上 | MIT | 不猜的判定顺序与升级阈值 | 自研 `classifyByLabels()` + `memory_pool_hint` 表（**跨会话累加**，原作是否为内存态未核实） | 否 |
| 三段天级时间轴 | 本仓手册 §2.5 | — | 自有 | 「宽限 / 半衰期 / 归档」的语义分层 | 自研 `timelineOfPreset()` 纯函数；锚点取 `lastSeenAt` 而非分配时刻 | 否 |
| 记录摘要口径 | **O-010 `ondra-memory-core`** | 本仓 | AGPL-3.0 | `digestOf()`（去空白 + sha256 前 32 位） | **同实现镜像**（不能 import，§18.5）；改一处必须同改两处 | 否（同仓对齐） |
| 记忆强度与寿命 | **O-010 `ondra-memory-core`** | 本仓 | AGPL-3.0 | 全部强度计算 | **不实现**：本插件一个 `Math.pow` 都不写，也不暴露权重 | 否（不调用，刻意留白） |

**档位判定**：手册 §1.8 把「记忆底层存储 / 检索 / 去重 / 衰减」列为复用档——本插件把
**存储（O-006/O-007）、记忆本体与时钟（O-010）、强度（O-010）、注入装箱（O-036）** 全部交了出去。
自研的只有「八池那三列参数的产品落点」「不猜的判定与跨会话线索」「天级时间轴与小时级强度的分工」，
这三样生态里没有对应物（`ondra-chain` 有池参数，但它是另一套记忆本体，不能直接引用其数据结构）。

## 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 没有任何插件崩。O-036 若读 `eligibleForInjection()` 会拿不到答复，
   于是按「未登记 → 默认放行」的等价语义处理（本插件缺席时下游走 `??` 分支）；
   O-019 夜巡少一节「海马体待整理」。记忆读写、衰减、召回全部照常。
2. **我的状态存在哪？** `memory_pool` + `memory_pool_hint` 两张表（走端口）。
   计数器只在内存，进程重启归零。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.memory-pool`；
   `stats()` 给出 `available` / `reason` / `byPool` / `core` / `unclassified` / `escalations` /
   `clockAvailable` / `issues`。开局还会自检池表本身（宽限 > 归档这类病态组合直接 `error`）。
4. **我依赖谁？缺席时怎么降级？** 存储缺席 → `available=false` + `no-store`；
   内核缺席 → 纯分类照常，时间轴接口返回 `undefined` / 空数组，`stats().clockAvailable=false`；
   O-005 缺席 → 退回插件实例配置。
5. **我和同域的谁共享了可变状态？** 没有。`memory_pool` / `memory_pool_hint` 是本插件独占的；
   `memory_fact` 只读两个时钟列，一列都不写。

## 已知限制

1. **手册 §2.5 标题写「八池」，表里是 9 行。** 多出的是 `skill`（表中注「代码保留，README 写 60，
   以代码 90 为准」）。本插件**按表登记 9 行**，并把 `skill` 标 `legacy: true` / `assignable: false`
   ——只用于读回旧数据，不接受自动分配。
   **为什么不删掉凑成 8 个**：删了之后读回旧数据遇到 `pool='skill'` 就无从判定（落海马体？报错？两种都糟）。
   表是证据、标题是概括；把证据改到符合概括是这轮最不该做的事。**已登记为待裁决项**：
   请主人裁定是「8 池，`skill` 并入 `skillExp`」还是「9 池，`skill` 保留」。
   裁决后本插件只需改 `pools.ts` 一处（`POOL_IDS` + `POOL_PRESETS` + `types.ts` 的联合类型）。
2. **`skill` 的半衰期口径存疑（60 还是 90）。** 手册自己写了「README 写 60，以代码 90 为准」。
   本插件取 90（跟手册的裁决走），但这意味着「技能」比「经验」活得更久——与直觉相反。
   同属上一条待裁决。
3. **内核缺席时算不出时间轴。** `lastSeenAt` / `createdAt` 只在 O-010 的记录里，
   本插件不缓存它们（缓存就是第二真源，且要处理失效）。故内核缺席时
   `timelineOf()` 返回 `undefined`、`dueForArchive()` 返回空数组。
   **不拿 `assignedAt` 顶替锚点**——那会让老记忆的宽限被重新计一遍且不报错。
4. **「没登记过池」默认放行。** `eligibleForInjection()` 对未登记记忆返回
   `{ eligible: true, reason: 'no-assignment' }`。理由：八池是「分层」不是「准入名单」，
   把未登记当拒绝会让升级前写入的全部老记忆突然不进注入——那是一次静默的大规模行为变化。
   代价：确实该被挡住的海马体记忆，若没登记就挡不住。**升级迁移时请跑一遍 `assign()` 补登记。**
5. **`halfLives` 只是计数，不是权重。** 它数「跨过几档」，用来给界面显示「已淡出 2 档」。
   真要做权重必须回 O-010 改强度公式，不能在池层再加一条曲线。
6. **单槽池（`emotion`）不自动顶替。** `assign()` 会让同池出现第二条，只通过
   `slotHolders()` 把成员列出来。谁被归档由调用方决定。若调用方不管，`emotion` 池会慢慢积累
   （归档天数 3 天，`dueForArchive()` 会把它列进候选，所以不会无声膨胀）。
7. **`dueForArchive()` 一次最多扫 `dueScanLimit`（默认 5000）条。** 撞上限时只扫到前 5000 条，
   **不报 `complete` 标志**（本插件的 `PoolStats` 没有这个字段；`stats()` 里的池统计会在撞上限时 `warn`）。
   超大库请调高 `dueScanLimit` 或按池分次调。
8. **`escalations()` 最多返回 200 条。** 人工定池是一次性动作，一次列两千条没人看得完。
   处理完调 `resolveHint(digest)` 销账，清单才会短下去。
9. **不提供「从 `category` 自动映射到池」。** O-010 的 11 类寿命类别（watch / daily / person…）
   与本插件 9 个池**不是一一对应**（`person` 该去 `fact` 还是 `core`？`promise` 呢？手册没给）。
   猜一张映射表就是替产品拍板。需要的话请显式给 `labels` 或 `pool`。

## 文件清单

```
ondra-memory-pool/
├── package.json          # ondra.bundle.patch 指向 cordis.patch.yml
├── tsconfig.json         # NodeNext + strict
├── cordis.patch.yml      # 必需；漏了宿主只打一行 stderr，插件永不加载
├── icon.svg
├── locale/en.json
├── locale/zh.json
├── README.md
└── src/
    ├── types.ts          # 契约（服务键 / 池 id / 时间轴 / 镜像）
    ├── pools.ts           # 八池表唯一真源 + 纯分类与纯算术
    ├── settings.ts        # 配置单一真源（FIELD_SPECS 派生一切）
    ├── schema.ts          # 两张表结构声明
    ├── store.ts           # 表级 CRUD
    ├── service.ts         # 门面（PoolRepository）
    └── index.ts           # Cordis 入口 name / apply / Config
```

## 与相邻插件的接口约定

| 谁 | 怎么用本插件 | 注意 |
|---|---|---|
| O-036 `ondra-prompt-inject` | `eligibleForInjection(id)` 判准入；`dueForArchive()` 拿「该退出主动位」的清单 | 装箱（装几条、装不下写「另有 N 条未展开」）仍在 O-036 |
| O-013 `ondra-memory-decay` / O-017 `ondra-memory-audit` | 池表给「哪天该归档」，实际沉底调 `core.archiveDue()` | 本插件**不写** `archived` |
| O-019 `ondra-memory-dream` | 夜巡「海马体待整理」一节读 `stats().unclassified` 与 `escalations()` | 本插件只出清单，不改正文 |
| 应用侧成长面板 | `pools()` / `stats().byPool` / `core` 直接渲染 | 只读快照 |
| O-010 `ondra-memory-core` | 写入后调 `assign()` 补登记 | **升级迁移时必须扫一遍老数据补登记**，否则 `no-assignment` 默认放行 |
