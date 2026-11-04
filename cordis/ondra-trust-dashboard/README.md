# ondra-trust-dashboard · 信任读数

> 台账 O-102（第 17 组 · L9 扩展池，B13 批次）｜档位〔研〕自研｜**默认开启**（纯只读，开着无副作用）

**一句话：把「她有多信你」拆成几项能核对来源的读数，读不到就说读不到，不用 0 假装。**

---

## 1. 它到底做什么

```
O-028 relation() ──→ trust / intimacy / familiarity ─┐
O-021 stats()    ──→ kept / broken（只算已结算）  ─┼─→ 五项读数（每项带 sources）
O-010 countFacts ──→ 活跃条数                      ─┤        │
O-017 pinned()   ──→ 钉子条数                      ─┘        ↓
                                                     TrustBoard（结构化，不渲染）
```

**五项读数**（`READING_IDS`，唯一真源在 `src/types.ts`）：

| 项 | 中文 | 真源 | 是什么 |
|---|---|---|---|
| `trust` | 信任 | O-028 `relation().trust` | 0–1，衰减半衰期 720h |
| `intimacy` | 亲密 | O-028 `relation().intimacy` | 0–1，半衰期 8760h |
| `familiarity` | 熟悉 | O-028 `relation().familiarity` | 0–1，由互动次数推导，不衰减 |
| `promise-kept` | 履约率 | O-021 `stats().promises` | kept / (kept + broken) |
| `memory-cover` | 记忆存量 | O-010 `countFacts()` + O-017 `pinned()` | **计数**，不是比例 |

---

## 2. 五条硬纪律（每条都能单独否掉一种「更顺手」的做法）

1. **不自算信任分。** 名字里有「仪表盘」，最容易犯的错就是编一个 0–100 分。那会立刻多出三个真源（关系四维 / 记忆规模 / 承诺履约），而三处读数迟早漂开、界面上两处都说得通。故每一项都是**投影**，并强制带 `sources`（服务键 + 字段名），供核对。

2. **不用 0 顶替缺失值。** 上游缺席给 0，界面显示「信任 0%」——用户读到的是「她一点都不信我」，真相是「这个数这会儿算不出来」。故 `value: null` + `state: 'unknown'` + `note` 说清缺谁。`unknown` 与 `low` 是两档，**不能合并**：合并后界面会在「读不到」时画一根贴底的柱子，看起来像「很差」。

3. **履约率的分母只算已结算的。** 把 `open` 算进分母，拖着不办会让比例虚高——那是最容易被刷的一项。`stats().overdue` 只在 `note` 里提一句，**不进分母**。

4. **只读：契约里连 `adjust()` 都不镜像。** 「只读插件」落到代码上就是接口里根本没有那条路，比文档写「请勿调用」有效（与 O-099 同一条理由）。

5. **不报比例、不评价、不鼓励。** 总结只说「读到几项、缺了谁、哪一项最低」。写「信任 68%，继续加油」会被当成评分系统，然后开始刷分（O-097 / O-100 同一条理由）。只指**最弱那一项**，不全指一遍——全指等于没指。

---

## 3. 服务键与契约

**服务键：`ondra-trust-dashboard`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓仅本插件 provide。

`TrustDashboardService` 方法集：

| 方法 | 说明 |
|---|---|
| `specs()` | 五项说明书（静态，不含数值） |
| `board(at?)` | 出表：`readings` / `counts` / `missing` / `summary` |
| `readingOf(id, at?)` | 取一项；无此项或被配置关掉抛 `no-such-reading` |
| `stats()` | `built` / `degraded`（上游调用失败次数） |
| `available` / `reason` | 可用性（`disabled`） |

```ts
const dash = ctx.get('ondra-trust-dashboard')
if (dash === undefined) return

const board = dash.board()
for (const r of board.readings) {
  if (r.value === null) renderUnknown(r.zh, r.note)   // 「读不到」，不画柱子
  else renderReading(r)                                // 怎么画归应用外壳
}
if (board.missing.length > 0) renderNotice(`缺：${board.missing.join('、')}`)
console.log(board.summary)   // 「读到 4 项、读不到 1 项。其中最低的是「熟悉」。缺：ondra-memory-audit。」
```

**`TrustReading` 的四个字段各有分工**：`value` 给机器、`state` 给颜色与柱子高度、`note` 给人看的中文原因、`sources` 给核对（**不给展示**——别把服务键渲染到界面上）。

---

## 4. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| 关系值的写入、衰减、结算 | O-028 `ondra-emotion-stage` | 本插件是只读的。契约里没有 `adjust()` / `observe()` / `settle()` |
| 承诺的识别、提醒、结算 | O-021 `ondra-memory-prospective` | 只读它一次 `stats()` |
| 记忆的计数口径（什么算 active） | O-010 `ondra-memory-core` | 本插件只传 `{ state: 'active' }`，怎么算归上游 |
| 钉子该钉什么、钉几条 | O-017 `ondra-memory-audit` | 本插件只读 `pinned().length` |
| **渲染、三栏、设计令牌、主题、Toast、仪表盘图形、关系阶段条** | **应用外壳（`desktop/`）** | L8 界面 14 个插件已整批下线。本插件只交 `TrustBoard` 结构化数据 |
| 什么时候出表 | 应用外壳 / 人 | 本插件**不装定时器**，也不在 `apply` 里出表（那时上游可能还没就绪） |

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | **`true`** | 总开关。纯只读，关掉后 `board()` 抛 `disabled` |
| `include-memory-cover` | boolean | `true` | 是否把「记忆存量」计入表。关掉只少一项计数，不影响其余四项 |
| `verbose` | boolean | `true` | 降级与上游缺席时打一行日志，只影响日志噪声 |

**刻意没有的配置项**：信任分权重（有权重就说明在自己算分）、阈值 / 及格线（设了就有人去刷那条线，刷的是关系值——那是 O-028 的地盘）、隐藏某一项（藏起来等于让人以为「只剩这些」）。

---

## 6. 降级与缺席（一张表说清）

| 缺席的上游 | 表现 | 哪些项读不到 |
|---|---|---|
| `ondra-emotion-stage` | 其余四项照出 | `trust` / `intimacy` / `familiarity` |
| `ondra-memory-prospective` | 其余四项照出 | `promise-kept` |
| `ondra-memory-core` | 其余照出 | `memory-cover` |
| `ondra-memory-audit` | **存量照出**，只是不说钉子数 | 只有钉子计数（`memory-cover` 的 `detail.pinned`） |
| `ondra-clock` | 退回系统时间 | 无 |
| `ondra-config-schema` | 退回插件实例配置 | 无 |

> 任一上游抛错只让**那一项**变成 `unknown` 并 `degraded += 1`，其余照常出表。
> 大盘挂一片红比「少一项」糟得多（C3：器官错误不得传播，本插件按同一条纪律办）。

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。纯只读、不装定时器、不在 `apply` 里出表；关掉后依赖本服务的外壳面板拿不到读数，对话链完全不受影响。
2. **我的状态存在哪？** **不落盘**。全部统计只在内存（`built` / `degraded`），进程重启归零。信任读数没有需要跨重启保留的状态——每次出表都是现算。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.trust-dashboard`；`stats().degraded` 记每一次上游调用失败；每项读数的 `sources[].ok` 逐项标出「这一项读到了没有」。
4. **我依赖谁？缺席时怎么降级？** 关系 / 承诺 / 记忆 / 审计 / 时钟（全软）+ 配置（软）。逐项见 §6；初始化任一步失败都不抛。
5. **我和同域的谁共享了可变状态？** **没有**。只读四个服务的公开只读方法，**不写任何东西**。契约里连 `adjust()` 都没镜像——接口上就没有那条路。

---

## 8. 已知限制（诚实清单）

1. **`memory-cover` 的 `value` 是计数不是比例，`state` 恒为 `mid`。** 计数没有「高/低」的意义，界面应按数字画而不是按档位画。刻意不换算成「占总量百分比」：分母（含已沉底、已封存）随时在变，算出来会被误读成「记忆覆盖度」。
2. **关系快照整块读或整块不读。** 不做「读到三项、第三项失败就用前两项」：拼半个对象会让界面显示「亲密 0」，而真相是读不到。
3. **`familiarity` 是推导值不是存量值。** 它由 O-028 从互动次数算（`min(1, interactions / 5000)`），本插件只投影；分母 5000 的口径归 O-028。
4. **履约率没有「加权」。** 一条重要承诺和一句随口的话权重相同——是否重要没有真源可依据，编一个权重就是编第二个口径。
5. **不区分「对人的信任」与「对能力的信任」。** 上游只有一个人的 `trust` 维度，本插件不臆造第二轴。
6. **`readingOf()` 会重算整张表**（内部调 `board()`）。单取一项没有单独的便宜路径：三项关系读数必须同一次取，否则会拿到三个不同时刻的快照。
7. **不出历史曲线。** 要曲线由应用外壳采样；本插件不维护第二份时间序列（与 O-097 同一条理由）。
8. **`state` 的两刀（0.35 / 0.7）是工程取值，不是产品口径。** 反推依据写在 `src/types.ts` 的 `STATE_CUTS` 注释里；若主人要给产品口径，只需改那一处。

---

## 9. 技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 可信度 / 信任度量的多维拆解 | Trusted Computing Group 的 trust metric 讨论、以及「信任 = 能力 + 善意 + 正直」三因素模型（Mayer, Davis & Schoorman, 1995） | — | — | 借「信任不是一个数，而是几个各自可解释的维度」这一判断；本插件据此**拒绝**合成单一分数 | 自研「五项读数 + 强制 sources」的投影层 | 否（仅思想参考） |
| 可观测性三支柱（指标 / 日志 / 追踪）中的「指标必须带来源」 | OpenTelemetry Metrics 数据模型（每个 metric 带 attributes） | opentelemetry.io | Apache-2.0 | 借「一个读数必须能回答它从哪来」这条要求 → `sources: { service, field, ok }[]` | 自研 `TrustReadingSource` | 否（仅思想参考） |
| 健康检查的「三态」（healthy / degraded / unknown） | Kubernetes readiness / liveness 探针语义 | kubernetes.io | Apache-2.0 | 借「unknown 与 unhealthy 必须分开」这条：混成一档会让「读不到」被当成「很差」 | 自研 `READING_STATES`（`unknown` 独立成档） | 否（仅思想参考） |
| 关系四维读数 | O-028 `ondra-emotion-stage` | — | — | **复用服务**：`relation()` 一次拿四项 | 只读投影，不镜像 `adjust()` | 否 |
| 承诺履约统计 | O-021 `ondra-memory-prospective` | — | — | **复用服务**：`stats().promises` | 只读，分母口径在本插件内说明 | 否 |
| 记忆计数与钉子 | O-010 `countFacts()` / O-017 `pinned()` | — | — | **复用服务** | 只读 | 否 |

**档位判定（master-plan §3.8）**：生态里有大量「trust score / reputation system」实现（如各种信用评分库），但它们都要求**自己维护一份可写的关系状态**——那就与本产品的单一真源直接冲突：O-028 已经是关系四维的唯一归属，再引一个评分库进来，就有两处在算「信任」。故判定：**机制自研（薄，约 350 行纯投影），上游能力全部复用**。本插件只贡献「怎么把已有读数摊开并说清来源」这一条规则，不贡献任何度量机制。

---

## 10. 多方案分支（master-plan §12）

按 §14.1 三条判定顺序，**不跳级**：

| 分歧点 | 处理 | 理由 |
|---|---|---|
| 呈现：单一综合分 / 多项读数 | **只做多项读数，不分支** | 综合分必然要权重，权重必然是第二套口径。留一个「合成总分」的开关，就等于留了一条造第二真源的路 |
| 缺失值：0 / 上一轮缓存 / `null` | **只 `null`，不分支** | 0 会被读成「很差」；缓存会让界面显示一个已经不成立的旧数。两者都比「读不到」危险 |
| 关系读法：只读 / 只读 + 可写 | **只读，不分支** | 可写就变成关系域的第二个写入口。正确 > 方便 |
| 履约率分母：含 open / 只含已结算 | **只含已结算** | 含 open 会被「拖着不办」刷高，那正是这一项最该防的作弊 |
| 计数型读数的呈现：比例 / 计数 | **只计数** | 比例的分母随时在变，算出来会被误读成「覆盖度」 |

**稳定优先**：任一项上游失败只让那一项 `unknown`，不让整张表失败——大盘挂一片红比「少一项」糟得多。

---

## 11. 文件清单（12）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单，含 `ondra.bundle.patch` |
| `tsconfig.json` | NodeNext + strict + declaration |
| `cordis.patch.yml` | 宿主补丁：`insert` 无 id → 追加根入口 |
| `src/index.ts` | 入口：`name` / `apply(ctx)` / `Config`，注册配置段与服务 |
| `src/types.ts` | 契约唯一真源：服务键、五项读数定义、状态闭集、错误码、上游镜像 |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → `DEFAULT_CONFIG` / `SectionDecl` / `completeConfig`） |
| `src/readings.ts` | 纯函数投影层（五项读数 + 档位 + 总结；**缺失值在此变 `null`**） |
| `src/service.ts` | 服务实现（只读取值 + 逐项降级） |
| `locale/zh.json` / `locale/en.json` | 中文 / 英文元数据 |
| `README.md` | 本文 |
| `icon.svg` | 由 `node tools/sync-plugin-icons.mjs` 从根 `icon.svg` 刷成（唯一真源） |

> 表里 12 行是因为 `locale` 与 `icon.svg` 合并了说明；实际 12 个文件。

---

## 12. 快速上手

```yaml
# cordis.yml（节选）
plugins:
  - ondra-trust-dashboard     # 依赖 ondra-emotion-stage / ondra-memory-prospective / ondra-memory-core / ondra-memory-audit / ondra-clock（全软）
```

```ts
// 干净卸载：不装定时器、不落盘、不持独占资源
// ctx.effect 会撤掉配置段与服务 provide；没有任何东西需要清理
```

---

## 13. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

本轮为**静态自检**，未 `pnpm install`、未 `build`、未 `tsc`、未启动 app。逐项结果见交付简报。
