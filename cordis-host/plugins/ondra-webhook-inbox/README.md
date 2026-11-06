# ondra-webhook-inbox · 事件播报收件箱

> 一句话：**外面刚发生了一件事——要不要说、什么时候说、说哪一类？** 只回答这三个问题，发出去不归它。

**档位：〔复〕复用档**（master-plan §3.8）。收件箱 / 去重 / 限流都是成熟模式，本插件只做接线与配置。

---

## 1. 它到底做什么

宿主把 webhook 解析成一张简单的事件表（源、类型、关键字段、一句摘要、优先级），交给 `ingest()`。本插件负责四件事：

1. **去重** —— 指纹 = `sha256(源 + 类型 + 排序后的关键字段)` 取前 16 位十六进制。同一件事在去重窗（默认 24 小时）内只入箱一次。
2. **入箱** —— 队列有上限（默认 64 条）。满了丢最旧的，**并且在日志里说丢了哪几条**。
3. **静默压住** —— 23:00–08:00 只入箱、不进可投递批次。判断只在本层做软的（读 O-003 的小时数）。
4. **排队** —— 三档优先级（`high` / `normal` / `low`）只影响顺序与截断取舍。一批最多 8 条，每小时最多 12 条（按 `ack()` 计数）。

它**没有**任何主动行为：不连谁、不监听、不等待、不发送。事件进来、进箱、等人来取。

## 2. 六条硬纪律

1. **同一件事不许播两遍。** 指纹只存 16 位十六进制且不可逆，因此「按指纹去重」这件事本身不可能被拿来还原事件内容。指纹的**时刻不因重复上报而刷新**——否则一个每分钟上报一次的事件会让窗口无限延长。
2. **只存摘要与指纹，绝不存原文。** 契约里 `body` / `raw` / `payload` 三个字段的类型是 `never`：不是忽略，是**编译期拒绝**。想让这个插件保存请求体，得先把它自己的类型改掉，那是一次看得见的改动。读盘时还逐字段白名单重建，手工改过的存档里塞进 `body` 也读不回来。
3. **静默时段只入箱不投递。** 23:00–08:00 一律压住，**高优先级也不例外**。留一条「紧急所以可以半夜说」的路，等于把静默时段降级成建议。
4. **高优先级不能绕过总开关。** `enable=false` 时 `ingest()` / `ack()` 一律抛 `disabled`，读接口照常。
5. **队列满了丢最旧的，并且说出来。** 静默截断会让「为什么这条没播」永远查不出来。丢条目时**连指纹一起丢**——只丢条目会让「从未播过的事件」被当成播过了，那是最难查的一类漏播。
6. **不自己发消息、不起服务器、不装定时器。** 接 webhook 与验签归宿主（它才有权限与说明义务）；发送归 O-042 的六道闸。本插件唯一的入口是**宿主调它**的 `ingest()`。

## 3. 服务键与契约方法表

服务键：`ondra-webhook-inbox`（连字符，匹配 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。

| 方法 | 写盘 | 作用 | 谁该调 |
|---|---|---|---|
| `ingest(event, at?)` | 是 | 入箱（去重 → 排序键 → 落盘） | 宿主：解析完 webhook 就调 |
| `pending(at?)` | 否 | 取一批可投递的条目 | 外壳：决定「现在要不要说」时调 |
| `ack(ids, at?)` | 是 | 确认这些条目已经投递出去 | **真正发消息的那一方**（发失败就别 ack） |
| `snapshot(at?)` | 否 | 全量只读视图（队列、是否静默、剩余额度） | 外壳画收件箱、自检 |
| `stats()` | 否 | 累计计数与最近一次失败原因 | 自检与体检面板 |

另有三个只读属性：`available`（只看总开关）、`reason`（`disabled` 时给出原因）、`stored`（上次落盘是否成功）。

```ts
interface InboxEvent {
  readonly source: string            // 'github'
  readonly type: string              // 'ci-failed'
  readonly key?: readonly string[]   // ['main', 'abc1234']：只用于算指纹，算完即丢
  readonly summary?: string          // 'main 分支 CI 挂了'：压缩 + 截断后落盘
  readonly priority?: 'high' | 'normal' | 'low'
  readonly at?: number
  readonly body?: never              // 这三个字段的存在就是禁令
  readonly raw?: never
  readonly payload?: never
}
```

```ts
interface PendingBatch {
  readonly items: readonly InboxItem[]
  readonly reason: 'ok' | 'queue-empty' | 'quiet-hours' | 'rate-limited' | 'stale'
  readonly quiet: boolean
  readonly quota: number    // 本小时剩余额度
  readonly queued: number
  readonly stale: number    // 被超龄过滤掉的条数
}
```

`reason` 的六个值刻意都能解释「为什么是空的」：没货（`queue-empty`）、被静默压住（`quiet-hours`）、额度用完（`rate-limited`）、全是过期货（`stale`）。只返回空数组而不给原因，调用方就分不清「今天真的没事」和「有事但被压着」。

**取与确认必须分开。** 投递一定会在外面失败（网络、通道、六道闸）。如果 `pending()` 取出即算投递，一次失败就是永久漏播；所以取到的条目在 `ack()` 之前会一直出现在下一批里——最多重复取，不会丢。

## 4. 明确不负责

| 不负责的事 | 归谁 |
|---|---|
| 接 webhook、监听端口、验签、解析载荷、重放防御 | **宿主 / 应用外壳**（本插件连一个 HTTP 服务器都不起） |
| 什么时候发、额度、静默时段的**真正**执行 | O-042 `ondra-proactive-gate` 的六道闸（本插件只在自己这层做一次软判断） |
| 说什么话、什么语气、消息模板 | O-020 人格 / O-037 九步过滤（本插件不生成任何给人看的句子，摘要即调用方给的那一句） |
| 通道选择与重试策略 | O-042 + 各适配器（`ondra-adapter-*`） |
| **渲染、收件箱界面、Toast、日志视图** | **应用外壳（`desktop/`）**。L8 界面插件已整批下线，永久不得再新建任何 `ondra-ui-*` 包 |
| 事件的业务含义（哪条 CI 重要、哪个订单该催） | 事件源与宿主；本插件只按调用方给的优先级排序，不判断 |
| 长期事件归档、审计、检索 | 不在本插件：存档只服务去重与队列，播完即删 |

## 5. 技术来源

档位：**〔复〕复用档**。判断依据：收件箱、指纹去重、定窗限流三件事在生态里都有成熟实现，本项目**不自研机制、不引入依赖、不复制代码**，只做接线与配置——把这三件事接进 Ondra 的口径（0600 原子存档、全软依赖降级、静默时段、只有三档优先级）。

| 能力 | 参考项目 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 队列上限与「满了丢最旧」的丢弃策略 | BullMQ | github.com/taskforcesh/bullmq | MIT | 上限必须显式、丢弃必须可观测（计数 + 日志），不做静默截断 | `service.ts` 的 `#items` 上限循环 + `evicted` 计数 + `warn` 一行 | 否 |
| 指纹去重与「同一件事只处理一次」 | Prometheus Alertmanager（inhibition / 分组） | github.com/prometheus/alertmanager | Apache-2.0 | 用「标签组合」而不是整条载荷来认定同一件事；同类事件合并而非逐条播报 | `fingerprint.ts` 的 `fingerprintOf()`：源 + 类型 + 排序后关键字段，取 16 位 | 否 |
| 静默时间窗（窗内照收不照发） | Alertmanager `mute_time_intervals` | github.com/prometheus/alertmanager | Apache-2.0 | 「时间窗内抑制投递、但不丢事件」这一语义 | `priority.ts` 的 `inQuietHours()` + `pending()` 的 `quiet-hours` 原因 | 否 |
| 定窗限流（按已确认的投递计数） | node-rate-limiter-flexible | github.com/animir/node-rate-limiter-flexible | ISC | 以「最近一小时已用量」反推剩余额度，而不是维护一个会漂移的令牌桶 | `service.ts` 的 `#quota()`：数 `ackedAt` 中落在窗口内的时刻 | 否 |
| 0600 + 临时文件 + rename 原子写 | 本仓 O-108 `ondra-absence` | 本仓库 | AGPL-3.0 | 同仓既有手法，并非外部来源；列在此处是为了说明「没有另立一套」 | `store.ts` 的 `writeState()` | 同仓 |

> Apache-2.0 / MIT / ISC 三者的纪律一致：**只读思路，不复制代码**。本包没有一个函数是从上述仓库搬来的。
> 三处实现都只有几十行纯函数——引入它们反而要引入依赖树，与「禁装依赖」直接冲突。

## 6. 配置

| 字段 | 默认 | 区间 | 说明 |
|---|---|---|---|
| `enable` | `true` | — | 总开关。关掉后服务照常注册，`ingest()` / `ack()` 抛 `disabled`，读接口照常 |
| `queueCap` | `64` | 8–512 | 队列上限（条）。满了丢最旧的并记日志 |
| `maxBatch` | `8` | 1–32 | 一批最多投递几条（**自动保持 ≤ `queueCap`**） |
| `maxPerHour` | `12` | 1–120 | 每小时最多投递几条，按 `ack()` 的时刻计数 |
| `fingerprintTtlHours` | `24` | 1–168 | 去重窗。**从第一次见到算起**，不因重复上报延长 |
| `maxAgeHours` | `12` | 1–168 | 条目最长存活时长。超龄的清理掉、不投递 |
| `summaryMaxChars` | `140` | 20–500 | 摘要字符上限（含省略号） |
| `quietHours` | `true` | — | 是否启用静默时段 |
| `quietStartHour` | `23` | 0–23 | 静默起点（含） |
| `quietEndHour` | `8` | 0–23 | 静默终点（不含） |

> **这些数从哪来**：master-plan §9 参数速查里**没有**「事件播报」这一组，故全部是本插件的
> **工程取值**，依据（一天的事件量、一次说几句话像人话、半天前的事件还有没有用）写在
> `src/settings.ts` 的文件头与 `FIELD_SPECS` 里。

三条口径细节：

- `quietStartHour === quietEndHour` 视为**不设静默**。有歧义时选那个「不会让人整天收不到播报」的解释。
- 静默判断只到**小时**：23:00 整点生效，23:59 仍算静默；不按分钟精确。
- 去重表上限由 `queueCap × 8` 推导（夹在 64–4096），不做成配置：调大只是多占内存，调小会让播过的事件被重播。

## 7. 降级与缺席（一张表说清）

| 缺谁 | 表现 | 日志 |
|---|---|---|
| `ondra-identity` | 命名空间退回 `ondra.webhook-inbox` | 无（正常降级） |
| `ondra-clock` | 静默判断退回系统本地时区（可能与 O-042 的口径不一致） | 无（正常降级） |
| `ondra-path-layout` | **只在内存**，`stored=false`，重启后收件箱为空 | 无（宁可安静，不谎称落盘） |
| `ondra-config-schema` | 只用插件实例配置，无四层合并与来源追溯 | `warn` 一行 |

四项全是软依赖，故 `cordis.patch.yml` 里**不写 `inject`**。

## 多方案分支（master-plan §12）

本插件是「事件进箱」的单一路径，不做按事件源分支：

- 去重靠统一指纹（源 + 类型 + 关键字段哈希），不为某个供应商单独写一套判重。一旦按源分支，就会出现「A 源算重复、B 源不算」的两套口径，而这正是收件箱最容易被信任又被骗过的地方。
- 传输层刻意不存在分支：本插件**不建 HTTP 服务、不监听端口**，`ingest()` 由宿主调用。宿主用哪种路由框架都与本插件无关。
- 优先级只有三档且写死在类型里，不提供「自定义优先级表」这种配置化分支。

## 8. 已知限制（诚实清单）

- **摘要不做脱敏。** 本插件折空白、截断、落盘，**不判断**摘要里有没有密钥、手机号、正文片段——判断不了，假装判断了反而更危险（会让人以为塞正文进去是安全的）。调用方只应传一句话。
- **去重靠调用方选对关键字段。** `key` 漏了订单号，两个订单会变成同一件事（漏播）；`key` 塞了时间戳，同一件事每次都是新的（重播）。这是本插件最容易被用错的地方，而且错了不会报错。
- **密钥漏在 `summary` 里就会进存档。** 类型层面只挡 `body` / `raw` / `payload`，挡不住「把正文塞进摘要」。
- **额度依赖调用方诚实 ack。** 不调 `ack()` 就一直取到同一批，额度也不会消耗——「发出去但忘了 ack」会让队列只增不减。
- **指纹 16 位，理论上会碰撞。** 概率在「一个人一天几十条」这个量级下可忽略，但碰撞的后果是**漏播**（两件事被当成一件），且只有日志对不上时才发现。
- **去重窗不延长。** 一个每天失败一次的健康检查，每天都会播一次——这是设计（跨天重播有意义），不是 bug。
- **时钟缺席时静默口径可能与 O-042 不一致。** 两处各判一次是刻意的冗余，代价是时区来源不同时会短暂不一致。
- **超龄条目要等下一次写盘才真正消失。** `pending()` 只是把它们排除在批次外（`stale` 计数），物理清理由下一次 `ingest()` / `ack()` 完成——因为读接口不写盘。
- **`ackedAt` 上限 64 条。** 一小时内 ack 超过 64 条时，额度统计会低估已用量（按上限算）。
- **不写盘就等于没有历史。** 缺路径服务时每次重启都从空箱、空去重表开始。
- **不验签、不去重 HTTP 层。** 同一个 webhook 被重复投递、但宿主没给出相同 `key` 时，会各入一条。
- **队列满时补投的历史事件会出局。** 一条比箱内最旧还旧的事件在满箱时直接丢弃（`reason: 'evicted'`），这是「丢最旧」的自然推论。

## 9. 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。外壳拿不到 `pending()` 的批次，事件不再被播报，其余插件全部照常——本插件不 provide 任何别人依赖的东西。
2. **我的状态存在哪？** `user/webhook-inbox.json`（0600，临时文件 + `rename` 原子写）；缺路径服务时**仅在内存**。
3. **我崩了怎么知道是我崩了？** 日志命名空间 `ondra.webhook-inbox`（经 O-001 拼），`stats().lastIssue` 留一行中文原因，`writeFailures` / `evicted` / `expired` / `fingerprintEvicted` 各自单独计数。
4. **我依赖谁？缺席怎么降级？** 四项全软依赖，见 §7。
5. **我和同域的谁共享可变状态？** 没有。与 O-042 共用「23:00–08:00」这个口径，但**不共用代码、不共用状态、不共用文件**——两处各判一次是刻意的冗余，共用会让「改一处静默」变成没人敢做的改动。

## 10. 文件清单（13）

| 文件 | 作用 |
|---|---|
| `package.json` | 清单；含 `ondra.bundle.patch`（宿主读这个键，漏了永远不加载） |
| `tsconfig.json` | NodeNext + strict |
| `cordis.patch.yml` | 入口补丁（`insert` 无 id → 追加根入口） |
| `README.md` | 本文 |
| `locale/en.json` / `locale/zh.json` | 元数据标题与描述（`{"meta":{...}}`） |
| `src/index.ts` | 入口：解析配置、建服务、`provide`、注册配置段 |
| `src/types.ts` | **契约唯一真源**（服务键、优先级闭集、事件/视图/统计、错误码、外部形状对位） |
| `src/settings.ts` | 配置唯一真源（`FIELD_SPECS` → 默认值 / 段声明 / 校验 / 口径换算） |
| `src/fingerprint.ts` | 纯函数：指纹、摘要压缩、输入形状判据（无 IO、无时钟） |
| `src/priority.ts` | 纯函数：优先级排序、静默窗判定、批次挑选、超龄清理（无 IO、无时钟） |
| `src/store.ts` | 读写存档（0600 + 原子替换 + 逐字段重建） |
| `src/service.ts` | 服务实现（去重、入箱、丢弃、额度、落盘） |

> `icon.svg` 不在上表：它由 `tools/sync-plugin-icons.mjs` 从仓库根 `icon.svg` 逐字节复制，
> **不许手绘**。本包未生成图标文件，`package.json` 的 `./icon` 导出与 `files` 已预留位置，
> 跑一次同步脚本即可补齐。

## 11. 快速上手

```yaml
# cordis.yml（节选）
- ondra-webhook-inbox:
    queueCap: 64
    maxBatch: 8
    maxPerHour: 12
    quietHours: true
```

```ts
// 宿主侧：webhook 收完、验签完、解析完，才交给它（这里不传正文）
const inbox = ctx.get('ondra-webhook-inbox')
inbox?.ingest({
  source: 'github',
  type: 'ci-failed',
  key: ['main', run.head_sha],
  summary: 'main 分支 CI 挂了',
  priority: 'high',
})

// 外壳侧：要说话之前取一批，发成功了才 ack
const batch = inbox?.pending()
if (batch?.reason === 'ok') {
  for (const item of batch.items) {
    // 交给 O-042 的六道闸；发成功后再 ack(item.id)，失败就不 ack（下一轮还会取到）
  }
}
```

## 12. 自检（master-plan §16.1 九项 + §16.2 语言五项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 结构完整（7 必需 + 6 业务模块 = 13 文件，无自绘 icon） | 过 |
| 2 | 清单合法（JSON 可解析 / `ondra-webhook-inbox` / `type: module` / `main`+`types`+`exports`+`files` / `@ntars/cordis` 双处 / `ondra.bundle.patch`） | 过 |
| 3 | 编译配置（`target` / `module` / `moduleResolution` / `strict` / `rootDir` / `outDir` / `declaration`） | 过 |
| 4 | 入口契约（`name` / `apply` / `Config`，十个字段逐项有默认值） | 过（无 `inject`：全软依赖） |
| 5 | 服务键唯一（`ondra-webhook-inbox` 未被任何包占用，仅台账与 README 提及） | 过 |
| 6 | 依赖可解析（四个 `ctx.get` 键均有提供方：identity / clock / path-layout / config-schema） | 过 |
| 7 | 无越界 import（只 `import type { Context } from '@ntars/cordis'`，`from 'ondra-` 零命中） | 过 |
| 8 | 降级到位（每个 `ctx.get` 后均判 `undefined` 并降级） | 过 |
| 9 | 交付物齐全（技术来源表 / 六条硬纪律 / 隔离五问 / 已知限制） | 过 |

语言五项：括号配平 · 无残留半句 · `import type` 正确 · 无 TODO · UTF-8 无 BOM —— 全过。
