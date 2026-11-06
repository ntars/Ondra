# ondra-daily-brief · 晨间简报

> 台账 O-120（L9 扩展池）｜档位〔薄〕｜**默认开启**（纯只读，开着无副作用）

**一句话：早上第一屏只放三件事，多一件都不放——有时限的承诺、昨天没说完的事、外面。**

---

## 1. 它到底做什么（以及与 O-113 的分工）

```
O-016 listOpen()  ──→ 最早到期的那一条承诺 ─┐
O-016 listTodos() ──→ 昨天之前没勾掉的那件 ─┼─→ 三段（每段带 sources）──→ DailyBrief
O-046 facts()     ──→ 节气 / 节日          ─┤                           （结构化，不渲染）
O-047 facts()     ──→ 外面什么样           ─┘
O-010 getFact()   ──→ 只核对：这条承诺背后的记忆还在不在（被遗忘权）
```

**三段，顺序固定，每段只点名一件：**

| 顺位 | 槽位 | 中文 | 点名谁 | 真源 |
|---|---|---|---|---|
| 1 | `promise` | 承诺 | 最早到期、且有时限的那一条承诺 | O-016 `listOpen()` |
| 2 | `carry-over` | 悬着的事 | 昨天之前就记下、还没勾掉、最早会过期的那条待办 | O-016 `listTodos()` |
| 3 | `ambient` | 外面 | 今天是什么日子 + 外面的天气 | O-046 `facts()` / O-047 `facts()` |

**排序的裁决（写进代码，不做成配置）**：有时限的承诺 > 昨天没说完的事 > 环境信息。
理由是「今天不做会怎样」：承诺今天不做会误事；悬着的事只是越来越旧；环境不看也在那儿。

**与 O-113 `ondra-weekly`（周报）的分工：**

| | O-120 `ondra-daily-brief` | O-113 `ondra-weekly` |
|---|---|---|
| 时间尺度 | 日：今天这一天 | 周：过去七天 |
| 回答的问题 | **当下要做什么** | **发生过什么** |
| 取材方向 | 往前看（到期、将过期） | 往回看（已完成、已发生） |
| 条数 | 最多三件，每段一件 | 按周聚合 |
| 关系 | **零共享、零 import**：不同包、不同服务键、不共用文件、不读对方任何状态 | 同左 |

两者都读「承诺」与「记忆」两个上游，但那是**同一份真源的两次投影**，不是两份数据。
本插件不产出任何周维度的东西，也不为周报预留字段。

**它新算的东西是零。** 挑哪一条、摆第几位、怎么把那一句说清楚——只有这三件事归它。

---

## 2. 服务键与契约

**服务键：`ondra-daily-brief`**（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓仅本插件 provide。

| 方法 | 返回 | 说明 |
|---|---|---|
| `sections()` | `SlotSpec[]` | 三段说明书（静态：槽位、中文名、这一段在回答什么、真源） |
| `brief(at?)` | `Promise<DailyBrief>` | 出简报。**异步**，因为天气本身是网络请求 |
| `ack(at?)` | `AckView` | 记一次「今天这份看过了」；同一自然日重复认领返回 `repeat: true` 且不改时刻 |
| `stats()` | `BriefStats` | `built` / `degraded` / `ackedDayKey` / `lastIssue` |
| `available` / `reason` | `boolean` / `'disabled'` | 可用性只看总开关 |

```ts
const brief = ctx.get('ondra-daily-brief')
if (brief === undefined) return

const today = await brief.brief()
for (const item of today.items) {
  if (item.state === 'ready') renderItem(item.zh, item.title, item.detail)  // 怎么画归外壳
  else if (item.state === 'empty') renderQuiet(item.zh, item.title)         // 「今天确实没有」
  else renderUnavailable(item.zh, item.detail)                              // 「这块读不到」——要能一眼分开
}
console.log(today.summary)   // 「今天提：承诺、外面。今天没有：悬着的事。」
brief.ack()                  // 看过就记一笔（只在内存，重启归零）
```

**`BriefItem` 四个字段各有分工**：`state` 给机器与颜色、`title` 是点名的那一件（原文，绝不摘要）、
`detail` 是第二句（时间或缺失原因，可能为空串）、`sources` 供核对（**不要渲染到界面上**——别把服务键给人看）。

**三态而不是两态**：`ready` / `empty` / `not-available`。
`empty` 是「上游在位，今天确实没有」；`not-available` 是「这块读不到」。
合成一档，用户会在上游挂掉那天以为一切安好——那是最糟的一种误导，它让人以为一切已被检查过。

---

## 3. 明确不负责

| 不负责的事 | 归谁 | 为什么 |
|---|---|---|
| 认出承诺、算到期、结算履约 | O-016 `ondra-memory-prospective` | 本插件只读 `listOpen()` / `listTodos()`，契约里没有任何写路径 |
| 用什么标准算「昨天没说完」 | O-016 的待办表 | 「3 天没提起就过期」是上游口径；本插件只按上游给的 `expiresAt` 挑最早到期的那件 |
| 记忆能不能删、删了怎么算 | O-103 / O-010 | 本插件只用 `getFact()` 核对「这条记忆还在不在」；**删了就不再点名** |
| 节气、农历、节日怎么算 | O-046 `ondra-live` | 本插件只读一次 `facts()` |
| 天气怎么取、坐标怎么填、取不到时说什么 | O-047 `ondra-weather` | 本插件原样引用 `facts().text`，不重写、不换算、不补「记得带伞」 |
| **发消息、推送、挑时机开口** | O-042 `ondra-proactive-gate`（投递闸） | 本插件的契约里连发送服务都不取 |
| **早上几点生成、要不要自动弹** | 应用外壳 / 主人 | **不装定时器、不在 `apply` 里出简报** |
| **渲染、卡片、配色、Toast** | 应用外壳（`desktop/`） | 本插件只交 `DailyBrief` 结构化数据 |
| 周维度的回顾 | O-113 `ondra-weekly` | 日与周是两种东西，零共享（见 §1） |
| 成稿文案（一段念给人听的早安语） | 表达域（O-052 `ondra-expression-decide` / O-137 `ondra-lexicon`） | 本插件只说事实与约束，不写台词 |

---

## 4. 技术来源

| 能力 | 参考 | 许可 | 借鉴了什么 | 本项目如何实现 | 引入代码 |
|---|---|---|---|---|---|
| 「晨间简报」只放少数几件事（少而定点，而非全量汇总） | 各类 daily standup / morning-briefing 实践中的「三件事」约定 | — | 借「第一屏有预算，超了就没人读」这条判断 → `MAX_ITEMS = 3` 写成结构常量 | 自研三段定长投影 | 否（仅思想参考） |
| 可观测性里「一个读数必须能回答它从哪来」 | OpenTelemetry Metrics（每个 metric 带 attributes） | Apache-2.0 | 借「每段必须带来源」→ `sources: { service, field, ok }[]` | 自研 `BriefSource` | 否 |
| 健康检查的三态（healthy / degraded / unknown） | Kubernetes readiness / liveness 探针语义 | Apache-2.0 | 借「unknown 与 unhealthy 分开」→ `empty` 与 `not-available` 独立成档 | 自研 `ITEM_STATES` | 否 |
| 承诺与待办 | O-016 `ondra-memory-prospective` | 仓内 | **复用服务**：`listOpen()` / `listTodos()` | 只读，不镜像任何写方法 | 否 |
| 记忆「还在不在」 | O-010 `ondra-memory-core` | 仓内 | **复用服务**：`getFact()` | 只读一次，用于被遗忘权的旁路核对 | 否 |
| 日期事实（节气 / 节日） | O-046 `ondra-live` | 仓内 | **复用服务**：`facts()` | 只读投影 | 否 |
| 天气 | O-047 `ondra-weather` | 仓内 | **复用服务**：`facts()`（异步） | 原样引用 `text` | 否 |
| 时刻与自然日 | O-003 `ondra-clock` | 仓内 | **复用服务**：`dayKey()` / `hhmm()` / `daysBetween()` | 缺席退回本机时区并记日志 | 否 |

**档位判定：〔薄〕。** 判据（master-plan §3.8）：本插件**零机制**——没有算法、没有阈值标定、
没有新的评分或权重，全部逻辑是「按上游给的顺序挑一条，用一句中文说清它」。
可复用性上也没有现成实现可搬：把「今天最该提哪三件」做成通用库的尝试（各类 productivity
aggregator）都要求自己持有一份待办状态，那与本仓的单一真源直接冲突——待办的真源已经是 O-016。
故判定：**自研，且薄到接近一个渲染前的选题器**（`src/aggregate.ts` + `src/ambient.ts` 合计约 300 行纯函数），
上游能力全部复用。

---

## 5. 配置

| 配置键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | **`true`** | 总开关。纯只读；关掉后 `brief()` / `ack()` 抛 `disabled` |
| `include-ambient` | boolean | `true` | 是否要「外面」那一段。关掉只少一段，不影响前两段 |
| `verbose` | boolean | `true` | 降级与上游缺席时打一行日志（同一降级点只提示一次），只影响日志噪声 |

**刻意没有的配置项（四条，各有理由）**：

1. **没有 `max-items`。** 能调成十条的那天，它就不再是简报。
2. **没有「段顺序 / 优先级」。** 承诺 > 悬着的事 > 环境，是「今天不做会怎样」的排序。
   做成配置，第一天就会被调成「把天气放最前」，于是真正会误事的那条沉到第三位。
3. **没有「生成时间」。** 留一个 `at: '07:00'` 的配置项，下一个人就会去装 `setInterval`。
4. **没有「推送渠道」。** 发消息归 O-042 主动投递闸，本插件连发送服务都不取。

---

## 多方案分支（master-plan §12）

聚合路径只有一条，缺数据只降级不分支：

- 四个上游（O-016 承诺 / O-010 记忆 / O-046 节气 / O-047 天气）任一缺席，就地把该段标 `not-available` 并写成「这块今天没有」，**不切换成另一套「精简简报」**。两套简报会让「今天到底有没有提醒过她那件事」变成两个答案。
- 天气多 provider 的选边在 O-047 内部完成，本插件只读结果，不按 provider 分支。
- 三条上限与排序规则写死在代码里，不做「按场景切换排序」的配置分支。

## 6. 已知限制（各上游缺席时降级成什么）

| 缺席的上游 | 降级成什么 | 用户看到什么 |
|---|---|---|
| `ondra-memory-prospective` | 前两段 `not-available` | 「承诺这一块今天读不到」「悬着的事这一块今天读不到」+ 一行日志 |
| `ondra-live` | 「外面」那段只剩天气 | 天气那句照出；细节里明说「今天是什么日子这一块没有」 |
| `ondra-weather` | 「外面」那段只剩节气与节日 | 节气那句照出；细节里明说「天气这一块没有」 |
| `ondra-live` 与 `ondra-weather` 都缺 | 「外面」那段 `not-available` | 「外面这一块今天读不到」——不是「今天没什么特别」 |
| `ondra-memory-core` | **不筛**（照常点名承诺） | 无感。读不到不构成「已删除」的证据——宁可多提一条，不可误吞一条 |
| `ondra-clock` | 自然日与时刻按**本机时区**算 | 一行日志；跨时区旅行时「今天」可能与 O-003 的口径差一天 |
| `ondra-config-schema` | 退回插件实例配置 + 本地 `completeConfig` | 一行日志 |

**其他限制（诚实清单）**：

1. **每段只点名一件，其余不汇总、不报数。** 有三条今天到期的承诺时，只报最早那一条。
   想全量的人去看 O-016——**故意不在这里给「还有 N 条」**，因为那既报了数字，又让人以为自己已知道全貌。
2. **「昨天没说完的事」不含今天才记下的待办。** 晨间简报说的是「新的一天」，
   今天刚记下的事已经在眼前了；把它们放进来，第一屏会变成当天流水。
3. **`ack()` 不落盘。** 重启后今天这份会重新变成「没认领」，代价是一句提示多出现一次。
   为一句提示新开一个状态文件，比这点代价贵。
4. **待办的「快过期」窗是工程取值（2 天）。** 依据是 O-016 待办「3 天没提起就过期」，
   提前一天提醒正好落在简报里；不是新标定，改它只改 `CARRY_URGENT_MS` 一处。
5. **`brief()` 会真的触发一次天气请求**（O-047 内有 10 分钟缓存，命不命中归它）。
   本插件不自建缓存——自建就是第二份天气真源。
6. **被遗忘权会静默减少候选。** 承诺背后的记忆若已被删掉，这条承诺不会被点名，
   也不显示「某条被隐去」——说明被隐去什么，本身就是在重新提起它。
7. **本包暂无 `icon.svg`。** 图标由 `node tools/sync-plugin-icons.mjs` 从根 `icon.svg` 生成，
   本轮禁跑该脚本，故 `package.json` 里也**不声明** `./icon` 导出（不声明不存在的文件）。

---

## 7. 隔离五问（手册 §16.4）

1. **关掉我，谁受影响？** 只有我自己。纯只读、不装定时器、不在 `apply` 里出简报、
   不写任何上游；关掉后依赖本服务的外壳拿不到简报，对话链完全不受影响。
2. **我的状态存在哪？** **不落盘**。`built` / `degraded` / `ackedDayKey` 只在内存，进程重启归零。
   简报是「此刻的投影」，没有需要跨重启保留的内容。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.daily-brief`；
   `stats().degraded` 记每一次上游缺席与调用失败，`stats().lastIssue` 是最近那一句人话；
   每段的 `sources[].ok` 逐项标出「这一段读到了没有」，段级 `state` 有第三档 `not-available`。
4. **我依赖谁？缺席时怎么降级？** 时钟 / 身份 / 承诺 / 记忆 / 日期 / 天气，**全软**，逐项见 §6；
   初始化与生成任一步失败都不抛（只有 `bad-request` 与 `disabled` 两种错误码会抛出）。
5. **我和同域的谁共享了可变状态？** **没有**。只读五个服务的公开只读方法，不写任何东西；
   契约里没有 `remember` / `settle` / `touchTodo` / `send` 任何一条写或发路径。
   与 O-113 `ondra-weekly` **零共享、零 import**：不同包、不同服务键、不共用文件。

---

## 8. 文件清单（12；表内 locale 两个文件合并成一行）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单，含 `ondra.bundle.patch` |
| `tsconfig.json` | NodeNext + strict + declaration |
| `cordis.patch.yml` | 宿主补丁：`insert` 无 id → 追加根入口 |
| `src/index.ts` | 入口：`name` / `apply(ctx, config)` / `Config`，注册配置段与服务 |
| `src/types.ts` | 契约唯一真源：服务键、三段说明、三态、错误码、上游镜像 |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → `DEFAULT_CONFIG` / `SectionDecl` / `completeConfig`） |
| `src/aggregate.ts` | 纯投影：承诺段与悬着的事段的选择与措辞、总述句 |
| `src/ambient.ts` | 纯投影：「外面」那段的合成（两个上游缺一个时怎么说） |
| `src/service.ts` | 服务实现：取值 + 逐段降级 + 时钟兜底 + 被遗忘权核对 |
| `locale/zh.json` / `locale/en.json` | 中文 / 英文元数据 |
| `README.md` | 本文 |

---

## 9. 快速上手

```yaml
# cordis.yml（节选）
plugins:
  - ondra-daily-brief   # 依赖 ondra-memory-prospective / ondra-memory-core / ondra-live / ondra-weather / ondra-clock / ondra-identity（全软）
```

```ts
// 干净卸载：不装定时器、不落盘、不持独占资源
// ctx.effect 会撤掉配置段与服务 provide；没有任何东西需要清理
```

---

## 10. 自检

本轮为**静态自检**：未 `pnpm install`、未 `build`、未 `tsc`、未启动 app、未跑任何运行期脚本。
逐项结果见交付简报。
