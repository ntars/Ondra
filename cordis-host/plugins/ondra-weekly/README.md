# ondra-weekly · 周报骨架

> 台账 O-113（L9 扩展池）｜档位**〔薄〕**｜**默认开启**（纯只读，开着无副作用）

**一句话：把「这一周发生过什么」整理成一份四段骨架，读不到的段就写「读不到」，空周就写「这周很安静」。**

---

## 1. 一句话定位

```
O-010 listFacts ──→ 这周新记住的事 ─┐
O-021 stats/listOpen → 眼下悬着的承诺 ─┼─→ 四段骨架（每段带 sources）
O-045 list/entry ──→ 这周写下的日记 ─┤        │
O-003 clock ──────→ 窗口的日界       ─┘        ↓
                                        WeeklyDraft（结构化，不渲染、不成稿）
```

它交的是**骨架**：四段分别写什么、哪些必须提、哪些可以省、可以引用哪几条素材片段。
它不交成稿——把骨架拼成一篇周记，是应用外壳与人格层的事。

**四条关键裁决（每条都能单独否掉一种「更顺手」的做法）**：

1. **不报情绪数值。** 周报是全仓「禁报数铁律」最容易破的地方：一旦出现「本周幸福度 7.2 分」，下一次就会有人为了让分数好看去调人格参数。本插件一个情绪读数都不取。
2. **可以有客观计数，但不换算成评分 / 等级 / 趋势百分比。** 「本周记住 6 件事、写下 3 篇日记」是事实；「本周亲密度上升 12%」不是事实，是编出来的度量。故 `WeeklyCount` 只承载计数，且强制带 `window`（这一周 / 此刻）与 `exact`（是不是全量）。
3. **空周也要出骨架，但必须显式说「这周很安静」。** `draft().quiet` 只有在三段都**真的**回了「没有材料」时才为 `true`；只要有一段读不到，`quiet` 恒为 `false`——**读不到不等于安静**。
4. **每项读数强制带 `sources{service, field, ok}`，缺的显式标 `not-available`。** `no-material`（上游说这周确实没有）与 `not-available`（上游没给）必须分两档：合成一档，降级的机器会长期显示一个平静的空周，而那正是最该被看见的故障。

---

## 2. 服务键与契约

**服务键：`ondra-weekly`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓仅本插件 provide。

`WeeklyService` 方法集：

| 方法 | 返回 | 说明 |
|---|---|---|
| `range(at?)` | `WeeklyRange` | 窗口：`from` / `to` / `days` / `fromKey` / `toKey` / `clock` |
| `sections(at?)` | `WeeklySection[]` | 四段骨架（不含账目与缺席名单） |
| `draft(at?)` | `WeeklyDraft` | 四段 + `tally` + `missing` + `quiet` + 一句话 `summary` |
| `stats()` | `WeeklyStats` | `built` / `degraded`（上游调用失败次数） |
| `available` / `reason` | `boolean` / `'disabled'` | 可用性 |

```ts
const weekly = ctx.get('ondra-weekly')
if (weekly === undefined) return

const draft = weekly.draft()
for (const section of draft.sections) {
  if (section.state === 'not-available') note(`读不到：${section.title}`)  // 不是「没有」，是「不知道」
  else if (section.state === 'no-material') note(`${section.title}：这周没有材料`)
  else console.log(section.title, section.material, section.counts)
}
if (draft.quiet) console.log('这周很安静——不要编事。')
console.log(draft.summary)
```

**`WeeklySection` 的六个字段各有分工**：`ask` 说这段写什么，`mustMention` / `maySkip` 是写作口径（不是文案），`material` 是可直接引用的原话片段（**不是成稿句子**），`counts` 是客观计数，`sources` 供核对（**不给展示**——别把服务键渲染到界面上）。

`state` 三态：`has-material` / `no-material`（上游答了「这周没有」）/ `not-available`（上游没答）。

---

## 3. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| 把骨架拼成一篇周记、定语气与称呼 | 应用外壳 + 人格层（`desktop/`、O-020/O-047） | 本插件给一句成句的正文，周报的口气就由插件决定了 |
| 发周报 | O-042 主动链路（静默时段 + 额度 + 六道闸） | 「什么时候适合发」不是读数的函数 |
| 什么时候出报 | 应用外壳 / 人 | 本插件**不装定时器**，也不在 `apply` 里出报（那时上游可能还没就绪） |
| 渲染、面板、图表、主题 | 应用外壳（`desktop/`） | L8 界面插件已整批下线，渲染不属于 cordis 插件 |
| 「本周新记住」的统计口径 | O-010 `ondra-memory-core` | 本插件只按 `created-at` 过滤它给的列表，什么算 `active` 归上游 |
| 承诺的识别、提醒、结算 | O-021 `ondra-memory-prospective` | 本插件只读 `stats()` 与 `listOpen()` |
| 日记的生成与正文 | O-045 `ondra-diary` | 契约里连 `write()` / `ensure()` 都不镜像，接口上就没有那条路 |
| 情绪数值、评分、等级、趋势百分比 | 没有人——这条就是不做 | 见 §1 第 1、2 条裁决 |
| 同一件事的合并去重 | O-012 `ondra-memory-dedupe` | 骨架可能把同一件事写成两条，合并是别人的口径 |

---

## 4. 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 周回顾的「四问清单」结构 | GTD Weekly Review（David Allen, *Getting Things Done*, 2001） | — | — | 借「周回顾是清单式的几问，不是抒情散文」这一判断；本插件据此把周报拆成固定四段，每段只给口径不给句子 | 自研 `SECTION_SPECS`（四段说明书） | 否（仅思想参考） |
| 自然周的两种起点惯例 | ISO 8601 周编号（周一为第一天）与美式日历（周日为第一天） | iso.org | — | 借「周起点有两套互不兼容的惯例」这条教训 | **判据：不判自然周**，只做滚动窗口（默认最近 7 天，含今天），并把 `fromKey` / `toKey` 交出去，看到日期就没有歧义 | 否（仅思想参考） |
| 「读数必须能回答它从哪来」 | OpenTelemetry Metrics 数据模型（每个 metric 带 attributes） | opentelemetry.io | Apache-2.0 | 借「一个数必须能回答来源」这条要求 → `sources: { service, field, ok }[]` | 自研 `WeeklySource`，每段强制携带 | 否（仅思想参考） |
| 先骨架后成稿（outline-first writing） | 写作教学与文档工具里的 skeleton / outline 范式 | — | — | 借「骨架与成稿分离」：骨架定「写什么」，成稿才定「怎么写」 | `material` 只放原话片段，`mustMention` / `maySkip` 只放口径，全包不产出一句成句的周报正文 | 否（仅思想参考） |
| 记忆新增条目 | O-010 `ondra-memory-core` `listFacts()` | — | — | **复用服务**：`orderBy: 'created-at'` 倒序取最近若干条，再按窗口过滤 | 只读；**不用 `countFacts()`** 算本周（它没有时间条件，会撒谎） | 否 |
| 承诺存量与未结算清单 | O-021 `ondra-memory-prospective` `stats()` / `listOpen()` | — | — | **复用服务**：条数取统计，原话取未结算清单 | 只读，且标 `window: 'now'`（此刻存量，不冒充本周新增） | 否 |
| 日记索引与标题 | O-045 `ondra-diary` `list()` / `entry()` | — | — | **复用服务**：列表取日期与篇数，`entry()` 只取标题 | 只读，正文一个字都不读 | 否 |
| 窗口日界 | O-003 `ondra-clock` `startOfDay()` / `dayKey()` / `daysBetween()` | — | — | **复用服务**：日历算术，避开夏令时那 23/25 小时 | 只读；缺席时退回本机时区并在 `range.clock=false` 标明 | 否 |

**档位判定（master-plan §3.8）**：市面上的 weekly digest / 自动周报工具（Weekdone、Statusbrew、GitHub weekly digest 一类）都要求**自己维护一份事件流或统计库**，再把结果渲染成稿。引入任何一套都立刻产生两个冲突：一是第二份真源（事件流与 O-010 / O-021 / O-045 各存一份，迟早漂开），二是它自带界面与调度，而这两件事都不属于 cordis 插件。故判定：**机制自研（薄，`window.ts` + `skeleton.ts` 约 480 行纯投影，取数与接线另计），上游能力全部复用**。本插件只贡献「把已有读数摊成一份能照着写的骨架，并说清每段的材料从哪来」这一条规则，不贡献任何统计机制。

---

## 5. 配置项

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | **`true`** | 总开关。纯只读，关掉后服务仍注册但 `available=false`，`draft()` 抛 `disabled` |
| `window-days` | number | `7` | 窗口天数（滚动，含今天），夹到 1–31。**不判自然周** |
| `max-items-per-section` | number | `5` | 每段最多几条素材，夹到 1–20 |
| `scan-limit` | number | `500` | 单次向上游扫描的最大条数，夹到 50–2000。回满时计数标为「下界」 |
| `verbose` | boolean | `true` | 降级与上游缺席时打一行日志，只影响日志噪声 |

**刻意没有的配置项**：周报模板 / 语气 / 称呼（那是成稿的事，归外壳与人格层）、出报时间（装定时器就得替人决定「什么时候该看这一周」）、隐藏某一段（藏起来等于让人以为「这周只剩这些」）。

---

## 多方案分支（master-plan §12）

不涉及 §14 裁决事项。周报只有一套口径，不做「简版 / 详版」两种产出：

- 数据源多寡不产生分支，只产生**降级**：某一段取不到就标 `not-available`，并把该段写成「这周这块没有材料」，而不是换一套简版报告。两套报告会立刻分叉出「哪一版才是真周报」的问题。
- 若将来要按数据量分级（例如材料很少时缩短骨架），按 §12 第一档「能融就融」处理：用同一套分段函数、由参数控制段落长度，不新增第二种结构。
- 唯一真源是 `src/types.ts` 的段落枚举与 `src/settings.ts` 的窗口配置。

## 6. 已知限制

1. **窗口是滚动的，不是自然周。** 周一还是周日算起点，各地说法不一，判错会让同一周出现两份周报或漏掉一段。要看自然周，请在外壳侧按 `range.fromKey` / `range.toKey` 自己切。
2. **「本周新记住」可能是下界，不是精确值。** `listFacts()` 没有时间条件，本插件只能按 `created-at` 倒序取最近 `scan-limit` 条再过滤；若扫描回满、且一条都没扫到早于窗口起点的条目，就无法确定窗口内是否取全，此时 `counts[].exact=false`，数字标为下界。扫到更早的条目即说明窗口已取全（`exact=true`）。
3. **「这周悬着的事」是此刻存量，不是本周变化。** O-021 的 `stats()` 给的是当前状态与累计结算数，没有「按 `settledAt` 区间查询」的入口，因此这一段所有计数都带 `window: 'now'`，骨架里也写明「不是本周新增」。
4. **没有「本周互动 N 次」。** 记忆内核只给 raw 表的总行数，没有按时间区间取对话轮次的入口；数不出来就不报——不编一个近似值。周报里能出现的计数只有：本周新增记忆条数、本周日记篇数、此刻悬着的承诺条数、此刻已过期的承诺条数。
5. **日记标题读不到时退化为日期键。** `readEntries=false` 时 `material` 里只有 `YYYY-MM-DD`，篇数仍然可信（列表读到了）。
6. **同一件事可能出现两条。** 去重与合并归 O-012，本插件不猜「这两条说的是不是同一件事」。
7. **日界退让会差一天。** 时钟缺席或算错时，窗口退回本机时区，`range.clock=false` 且 `summary` 会带一句提示；跨时区使用时这一天的边界可能偏。
8. **素材截断到 48 字。** 长记忆只剩开头一句，要看全文去原表；骨架给的是「有这件事」，不是它的全文。
9. **空周判定很严。** 三段里任一段 `not-available`，`quiet` 就是 `false`——因为「读不到」只能推出「不知道」，推不出「安静」。
10. **`stats().degraded` 只在内存。** 重启归零；要长期看降级趋势，请让外壳采样，本插件不维护第二份时间序列。

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。纯只读、不装定时器、不在 `apply` 里出骨架；关掉后外壳拿不到骨架，对话链完全不受影响。
2. **我的状态存在哪？** **不落盘**。全部统计只在内存（`built` / `degraded`），进程重启归零。周报骨架没有需要跨重启保留的状态——每次出骨架都是现算。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.weekly`（经 O-001 `loggerName('weekly')`）；`stats().degraded` 记每一次上游调用失败；每段 `sources[].ok` 逐项标出「这一段读到了没有」。
4. **我依赖谁？缺席时怎么降级？** 记忆 / 承诺 / 日记 / 时钟 / 身份 / 配置（全软）。

   | 缺席的上游 | 表现 | 哪一段受影响 |
   |---|---|---|
   | `ondra-memory-core` | 其余三段照出 | 「这周留下的事」→ `not-available` |
   | `ondra-memory-prospective` | 其余三段照出 | 「这周悬着的事」→ `not-available` |
   | `ondra-diary` | 其余三段照出 | 「她自己写的」→ `not-available` |
   | `ondra-clock` | 退回本机时区，`range.clock=false` | 无（窗口可能差一天） |
   | `ondra-config-schema` | 退回插件实例配置 | 无 |
   | `ondra-identity` | 日志命名空间退回 `ondra.weekly` | 无 |

   > 任一上游抛错只让**那一段**变成 `not-available` 并 `degraded += 1`，其余照常出骨架。一份只有三段、但标清缺了谁的骨架，比一份整页「读不到」的周报有用得多（C3：器官错误不得传播）。
5. **我和同域的谁共享了可变状态？** **没有**。只读四个服务的公开只读方法：记忆 `listFacts()`、承诺 `stats()` / `listOpen()`、日记 `list()` / `entry()`、时钟 `startOfDay()` / `dayKey()` / `daysBetween()`。**不写任何东西**——日记乃至契约里连 `write()` 都没镜像，承诺也没镜像 `settle()`。

---

## 8. 文件清单（12）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单，含 `ondra.bundle.patch` |
| `tsconfig.json` | NodeNext + strict + declaration |
| `cordis.patch.yml` | 宿主补丁：`insert` 无 id → 追加根入口 |
| `src/index.ts` | 入口：`name` / `apply(ctx, config)` / `Config`，注册配置段与服务 |
| `src/types.ts` | 契约唯一真源：服务键、四段说明书、三态、计数口径、错误码、上游镜像 |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → `DEFAULT_CONFIG` / `SectionDecl` / `completeConfig`） |
| `src/window.ts` | 纯函数：窗口算术（**滚动窗口，不判自然周**；日界问 O-003） |
| `src/skeleton.ts` | 纯函数：四段投影（**`no-material` 与 `not-available` 在此分开**） |
| `src/service.ts` | 服务实现（只读取值 + 逐段降级） |
| `locale/zh.json` / `locale/en.json` | 中文 / 英文元数据（结构 `{"meta":{"title","description"}}`） |
| `README.md` | 本文 |

> 计 12 个文件：上表 11 行里 `locale` 占 2 个。`icon.svg` **不在本轮手写范围内**，由 `node tools/sync-plugin-icons.mjs` 从根 `icon.svg` 刷成（唯一真源）；本轮按纪律未运行该脚本，故磁盘上暂无此文件。
