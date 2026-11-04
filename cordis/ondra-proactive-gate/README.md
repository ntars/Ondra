# ondra-proactive-gate

> O-042 · L4 主动（第 8 组第 1 项）· 档位〔薄〕 · 服务键 `ondra-proactive-gate`

一条待投递的消息，此刻能不能发出去。九道闸，一个结论。

---

## 一、职责

手册把「时机 / 话由 / 分寸」拆给三个插件。本插件只做**时机与分寸**：

| 能力 | 方法 | 手册依据 |
|---|---|---|
| 九道闸的判定 | `gate(request)` | §5.3 六道防封闸 + §5.5 三道门控 |
| 只读快照（面板/自检） | `peek(at?)` | — |
| 风控回报与熔断 | `reportRisk()` / `reportSuccess()` / `reportFailure()` | §5.3-6 |
| 一键静音（§5.7 红线） | `mute()` / `unmute()` | §5.7 |
| 状态持久化 | `flush()` / `stats().stored` | §5.3-7 / §9.3 |

九道闸的执行顺序（按手册那句「最便宜/最可能拒绝的放最前」排）：

| # | 闸 | 依据 | 拦下的后果 |
|---|---|---|---|
| 1 | 总开关 / 一键静音 / 群聊红线 | §5.7 | `drop` |
| 2 | 熔断 / 退避 / 失败暂停 | §5.3-6 | `drop`（熔断）或 `defer`（退避） |
| 3 | 内容红线（赌博 / 诈骗代办 / 色情） | §5.3-1 | `drop` |
| 4 | 静默时段（产品 23:00–08:00、防封 00:30–07:30） | §9.3 / §5.3-2 | `defer` |
| 5 | 每日主动预算（含沉默天数衰减） | §9.3 | `drop` |
| 6 | 空闲阈值 `idleMinutes` | §9.3 / §5.5 | `defer` |
| 7 | 同会话冷却（群 5s / 私聊 3s） | §5.3-5 | `defer` |
| 8 | 重复去重（30 分钟、minLen 4） | §5.3-3 | `drop` |
| 9 | 三层令牌桶（20/分 · 200/时 · 1500/日） | §5.3-4 | `defer`（分·时）/ `drop`（日） |

## 二、明确不负责

| 不做 | 归谁 |
|---|---|
| 排闹钟（once / interval / cron + 抖动） | `@ntars/ondra-schedule`（上游宿主包） |
| 到点唤醒冷会话 | 同上（`session resume`） |
| 生成「说什么」 | `ondra-proactive-reason`（O-043） |
| 额度策略的数值与放弃率 | `ondra-proactive-quota`（O-044，未建） |
| 真正发送、分条、打字 | 通道层（O-055 ~ O-067）+ `ondra-rhythm`（O-038） |
| `proactive_reclaim` 与墓碑折叠 | 会话上下文层（O-033 / O-036） |

四条**刻意不做**：

1. **不装定时器、不订阅事件。** 零常驻（§14.2）。所有时间从入参或 `now()` 取。
2. **不生成、不改写正文。** 门控只看正文。改写归 `ondra-filter-chain`（O-037）。
3. **不做 `proactive_reclaim`。** 手册 §5.5 提到「静默唤醒回合以 `proactive_reclaim` 结束并折叠 tombstone」，但本仓 `packages/` 下 grep `proactive_reclaim` / `tombstone` **零命中**，且它属于会话上下文管理，不属门控。硬做等于自己造一个会话协议。
4. **群聊不主动无开关。** §5.7 是合规章节级红线，不是偏好。给开关后的第一个用法一定是「先开着试试」。

## 三、服务键与方法

```
ondra-proactive-gate      ← 连字符，不是 ondra:proactive-gate
```

| 方法 | 说明 |
|---|---|
| `gate(request, at?)` | 判定一次投递。**放行时记账**（写记录、计数、更新冷却） |
| `peek(at?)` | 只读快照。**不消耗、不记账** |
| `reportRisk({code?, text?})` | 风控回报：命中计一次，连续 3 次熔断 30 分钟 |
| `reportSuccess(at?)` | 清零连续命中与连续失败 |
| `reportFailure(at?)` | 非风控失败：连续 3 次暂停 5 分钟 |
| `mute(ms, at?)` / `unmute()` | 一键静音 |
| `reset(at?)` | 人工复位（清熔断/退避/失败计数，**不清当日已用**） |
| `flush()` | 强制落盘 |
| `stats()` | 见下 |
| `available` / `reason` | 只看配置开关 |
| `stored` | 状态是否真的落盘。`false` = 重启会清零 |

`GateVerdict`：`allowed / action(send·defer·drop) / gate / code / detail / deferMs / jitterMs / stopUntil / budget / at`

`GateSnapshot`：`budget / buckets{minute,hour,day} / circuitOpen / openUntil / retryUntil / mutedUntil / stored / tracked / quietNow / antiBanQuietNow`

`GateStats`：`calls / allowed / deferred / dropped / byGate[9] / riskReports / circuitOpens / backoffs / writes / writeFailures / stored / tracked / budget`

`GateCode`（18 个）：`ok / disabled / muted / group-silent / circuit-open / backoff / fail-pause / content-blocked / content-empty / content-too-long / quiet-hours / anti-ban-quiet / budget-exhausted / session-busy / cooldown / duplicate / bucket-minute / bucket-hour / bucket-day / internal-error`

## 四、配置

| 键（camelCase） | 段字段（kebab） | 默认 | 依据 |
|---|---|---|---|
| `enable` | `enable` | `true` | — |
| `dailyQuota` | `daily-quota` | `3` | §9.3（上限锁 20） |
| `quietStart` / `quietEnd` | `quiet-start` / `quiet-end` | `23:00` / `08:00` | §9.3 |
| `antiBanQuietStart` / `antiBanQuietEnd` | `anti-ban-quiet-start` / `anti-ban-quiet-end` | `00:30` / `07:30` | §5.3-2 |
| `idleMinutes` | `idle-minutes` | `25` | §9.3 |
| `perMinute` / `perHour` / `perDay` | `per-minute` / `per-hour` / `per-day` | `20` / `200` / `1500` | §5.3-4（**上限也锁死**） |
| `maxLen` | `max-len` | `1800` | §5.3-1（扫描触发线，**不因此拒发**） |
| `hardMaxLen` | `hard-max-len` | `3000` | 手册未给，自定，见裁决 4 |
| `groupCooldownMs` / `privateCooldownMs` | `group-cooldown-ms` / `private-cooldown-ms` | `5000` / `3000` | §5.3-5 |
| `dedupeMinutes` / `dedupeMinLen` | `dedupe-minutes` / `dedupe-min-len` | `30` / `4` | §5.3-3 |
| `jitterMs` | `jitter-ms` | `400` | §5.3-6 |
| `circuitHits` / `circuitMinutes` | `circuit-hits` / `circuit-minutes` | `3` / `30` | §5.3-6 |
| `blockWords` | `block-words` | `[]` | 追加字面量屏蔽词（≤50 条） |
| `verbose` | `verbose` | `true` | 只影响噪声 |

段键 `proactive-gate`。三层速率与 `dailyQuota` 的 `max` 都锁在手册值——**调大不是更活泼，是吃掉余量**。

## 五、关键裁决

1. **两个「日」不是同一个日。** 每日投递预算（`dailyQuota`）是产品语义的「今天说了几句」，按自然日、跨零点归零、只算主动；令牌桶日层（`perDay`）是防封语义的「一天别超过 1500 条」，含回话。混成一个数会让「今天已经说了 3 句」把防封闸一起关掉。故状态里是**两个计数器**（`dayCount` / `daySent`）。
2. **两个静默窗口用途不同，不是同一个数的两种写法。** 产品静默 23:00–08:00 **只拦主动**（用户凌晨说话她该回）；防封深夜 00:30–07:30 **拦主动与回话、不拦被叫**。叠加时取**较长的等待**，否则调用方会在第一个窗口结束时立刻重试、然后被第二个窗口再拦一次。
3. **`reason` 三值而不是两值。** 手册只给 `active` / `mention`，但「用户刚说完话、她回一句」既不是主动也不是被 @。把她回话当主动拦掉，症状是「凌晨她不理人」——而人凌晨回消息是正常的。
4. **`maxLen=1800` 是扫描触发线，不是硬拒线。** 手册原话是「超长触发内容扫描」。真正的硬拒线手册没给，自定 `hardMaxLen=3000` 并登记待裁决。
5. **内容闸写得很窄。** §5.3-8 自己承认「正则不懂语义」。只匹配没有正常用法的专有名词（百家乐 / 六合彩 / 代开发票 / 约炮…），不写裸的「色情」「赌」。漏拦的代价是「一条她本来也不会说的话发出去了」；误伤的代价是「一句正常的话被丢掉」，而丢掉的症状是「她突然不说话了」，没有任何报错。两者不对称，选窄。
6. **红线匹配看原文，去重才归一化。** 归一化会去掉标点，`赌。球` 就变成 `赌球`——那反而是把一句正常话变成命中。两件事用两套归一化，刻意不合并。
7. **静音是 `drop` 不是 `defer`。** 改成 `defer` 会让调用方在解除静音那一刻把攒下的话一次说出来。
8. **熔断是 `drop` 且带 `stopUntil`。** 被盯上时唯一正确的做法是完全闭嘴，不是「等 30 分钟再说」。
9. **`jitterMs` 是上限，本插件不睡。** 零常驻不装定时器，随机等待由调用方在 `[0, jitterMs]` 内取。
10. **判定抛错时按「不发」处理。** `evaluate()` 是纯算术，它抛错说明本插件有 bug；「不知道能不能发」时发出去的代价（封号）比少说一句大得多。打 error 日志 + `stats().errors`，让降级看得见。
11. **连续沉默 ≥3 天减半取 floor。** 3 的一半是 1.5 → 1。宁可少说一句，多说的那半句正好落在用户最不想被打扰的那天。
12. **状态版本不认识就按空状态处理，不猜迁移。** 硬迁移一份「猜出来的计数」比清零更危险：清零最多多给几条额度，猜错会让计数停在一个谁也不知道的位置。

## 六、多方案说明（§12）

本插件**没有分支**。三处曾考虑分支，都按「能融就融」合成一个：

| 方案 | 结论 |
|---|---|
| 日层令牌桶用自然日 vs 滚动 24 小时 | ✅ 自然日。滚动更准，但状态文件从 3KB 涨到 30KB、每次发送都要重写；而小时层（滚动）已经把爆发挡住——一次爆发最多 200 条，凑满 1500 得连发 8 小时，那是脚本不是边界效应 |
| 静默窗口用一个可配窗口 vs 两个固定用途的窗口 | ✅ 两个。它们的作用域不同（只拦主动 / 也拦回话），压成一个就会二选一，总有一类场景判错 |
| 判定失败时 fail-open vs fail-closed | ✅ fail-closed（`drop`）。防封优先；且 `internal-error` 码 + error 日志让故障可见，不会静默沉默 |

## 七、契约对位（不 import，只镜像）

| 上游 | 用到的成员 | 镜像位置 |
|---|---|---|
| O-003 `ondra-clock` | `dayKey(epoch?)` / `minuteOfDay(epoch?)` | `ClockLike` |
| O-002 `ondra-path-layout` | `fileIn('user', …)` / `prepareFile(path)` | `PathLike` |
| O-005 `ondra-config-schema` | `register(section, owner)` / `resolve(id, layers)` | `ConfigSchemaLike` / `SectionDeclLike` / `FieldSpecLike` |
| O-001 `ondra-identity` | `loggerName(feature)` | `IdentityLike` |

下游（本插件不调用，只被调用）：

| 消费方 | 用到的成员 |
|---|---|
| 主动编排（O-044 或上层调度） | `gate()` 的 `action` / `deferMs` / `jitterMs` |
| 通道层（O-055 ~ O-067） | `gate()` 的 `allowed`；发送后 `reportSuccess()` / `reportFailure()` |
| 界面层 | `peek()` 的只读快照、`mute()` |
| 应用侧提示词预览 | 不涉及（本插件不进提示词） |

## 八、技术来源

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 定时与投递 | `@ntars/ondra-schedule`（本仓 `desktop/packages/schedule/schedule`，已读源码） | 仓内（上游） | 上游许可 | **复用**：五种时间选择器、到期恢复冷会话、投递历史（30 天 / 200 条）、声明式 schedule 幂等同步 | 不重写定时机制，只在投递前插一道门控 | 否（经宿主服务，不 import） |
| 心跳引擎整体形态 | 手册 §1.8 提到的 `ondra-proactive` | **本仓不存在**（`packages/` 下 grep 零命中） | — | 只借「模型自排闹钟 + 双门控 + `min_idle_seconds`」这组概念 | 概念落到本插件的三道门控上；`proactive_reclaim` / tombstone 折叠**不做**（见已知限制 2） | 否 |
| 防封六道闸参数 | 手册 §5.3（实测 12 拦截 0 误伤） | — | — | 参数逐条照抄：1800 / 三类正则 / 00:30–07:30 / 30min·4 / 20·200·1500 / 5s·3s / 400ms / 3 次熔断 30 分钟 / 退避 [30,60,120,300,600,1800] | 自研 `gate.ts` + `bucket.ts` + `content.ts` | 否 |
| 令牌桶 | 限流通用做法（生态共识） | — | — | 只借「三层窗口」这个形状 | 分钟/小时用滚动窗口，日层用自然日计数（见裁决 1） | 否 |
| 状态原子写 | 手册 §9.3（临时文件 + rename） | — | — | 写法逐字 | `state.ts` 的 `writeState()`：写 `.tmp`（0600）再 `rename` | 否 |

档位说明：手册 §1.8 把「心跳引擎（ondra-proactive 改造 + 墓碑折叠）」列**薄封装**。本插件只做门控这半件，定时投递归上游 `ondra-schedule`——比「薄封装」还薄一层。台账原写〔薄〕，一致。

## 九、隔离五问

1. **关掉我，谁受影响？** 主动消息不再被门控——上游照常按闹钟投递。回话不受影响（本插件从没管过回话的通道）。`enable=false` 时服务仍注册，`gate()` 返回 `drop/disabled`，所以调用方**不会**因为拿不到服务而崩溃。
2. **我的状态存在哪？** `user/proactive-state.json`（0600、临时文件 + rename）。内容：当日主动计数、当日总计数、最近一小时的发送记录、会话冷却表、熔断/退避/失败计数、最近用户开口时刻、静音截止。**不建表、不装定时器、不订阅事件**。
3. **我崩了，界面怎么知道是我崩了？** 日志命名空间 `ondra.proactive-gate`；探针是 `stats().byGate`（哪道闸在拦）、`stats().writeFailures`、`stats().errors`、`stored`。每条拒绝都带稳定 `code`。
4. **我依赖谁？缺席时怎么降级？** 见第七节。缺 O-003 → 本机时区（跨时区会差几小时）；缺 O-002 → 纯内存 + 一条 warn，`stored=false`；缺 O-005 → 用插件实例配置；缺 O-001 → 固定日志前缀。**没有一个依赖会让插件停在 PENDING。**
5. **我和同域的谁共享了可变状态？** 没有。O-003 / O-002 / O-005 / O-001 全部只读调用。状态文件是本插件独占的。

## 十、已知限制

1. **不做 `proactive_reclaim` 与墓碑折叠。** 手册 §5.5 有这条，但它属于会话上下文层（要改会话历史、要折叠 tombstone），且本仓没有对应实现可复用。本插件不碰会话历史。
2. **不排闹钟。** `deferMs` 只是一个数字，谁来重排由调用方定。若上层没有重排能力，`defer` 就退化成「这条不发了」——**这是接线问题，不是判定问题**，但症状是「主动消息比预期少」。
3. **日层令牌桶按自然日重置。** 23:59 与 00:01 各有 1500 额度。小时层（滚动 200）挡住了爆发，实际用量远低于此。
4. **`idleMinutes` 省略时空闲闸放行。** 「不知道就拦」会让一次字段漏传变成「她永远不主动」。`detail` 里会写 `unknown`，但没有任何报错。
5. **去重按归一化文本全等，不做相似度。** 「今天好累」与「今天好累啊」是两句。相似度判重会让「她换了个说法」也被拦，代价比重复一句更大。
6. **内容闸只有三类、且写得很窄。** 漏拦是刻意的（见裁决 5）。`blockWords` 只收字面量——用户填的正则一旦写成 `(a+)+$`，一次长文本就能把门控卡住（ReDoS），而卡住的表现是「她不说话了」。
7. **`reportRisk` 靠错误码 + 关键词认风控。** 平台改文案就认不出。`RISK_CODES` 是 §5.3-6 的实测值，不含后来新增的码。
8. **状态文件损坏时按「没有存档」处理。** 计数清零、熔断失效。只在启动时读一次，运行期不会重读。

## 十一、待裁决

1. **`reason` 要不要第三值 `reply`。** 手册只有 `active` / `mention`。当前三值化是为了让「她回话」不被当主动拦掉。若主人要严格照手册，去掉 `reply` 即可（一处枚举 + 两处判断）。
2. **`hardMaxLen` 取 3000。** 手册只给扫描触发线 1800，硬拒线没给。3000 是自定。
3. **连续沉默减半取 floor 还是 ceil。** 3 → 1（floor）还是 2（ceil）。当前 floor，理由见裁决 11。
4. **产品静默 23:00–08:00 与防封 00:30–07:30 是否应该合成一个窗口。** 当前分开，因为作用域不同。合成会让「只拦主动」与「也拦回话」二选一。
5. **`dedupeMinLen=4` 对中文是否合适。** 4 个字符在中文里是「今天好累」这种完整短句，会被去重；而手册这条参数出自英文语境（4 个字符≈半个词）。是否要按字符数翻倍（8）？
6. **群聊红线是否真的不给开关。** 当前无开关（§5.7）。若主人认为「群里偶尔说一句」是产品需求，需要先定「什么条件下可以」——那是一个新规则，不是打开一个布尔。
7. **谁来做「主动编排」——这是本插件之外缺的一整块。** 根 README 给 O-042 的口径写着「心跳由模型自排闹钟（一次、间隔、cron 加抖动），支持唤醒冷会话」，而本插件按零常驻纪律**不装任何定时器**；`proactive-quota` / `proactive-reason` 同样是 `plan()` / `pick()` 的纯拉取式。于是整条主动链在仓库里**没有调用方**：定时源（`ctx.schedule`）、话由、额度、门控、生成、发送六段谁先谁后没有定义。三条可选路径与代价：
   - **A 宿主调度器**：在 `desktop` 侧注册一个 `ctx.schedule` 的周期性投递，依次调用 `quota.plan()` → `reason.pick()` → `gate.gate()` → `dialogue.turn()` → 通道发送。改动集中在一个宿主包，但要新增依赖与 lockfile，且必须先定「周期多长、群聊算不算、退场句怎么发」。
   - **B 独立编排插件**：新增一个 `ondra-proactive-*` 插件承载这六段。语义最干净，但插件数从 133 变 134，要同步根 README 的九层统计表与台账编号。
   - **C 扩容 O-042**：把心跳并回本插件。改动最小，但与「零常驻、不订阅事件」的既有纪律正面冲突，且会让门控同时承担「生成什么」的责任。
   三条都要主人先定产品规则（何时算可开口、开口走哪条通道、退场如何表达），代码本身不构成决策依据。
