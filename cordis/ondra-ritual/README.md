# ondra-ritual · 节气仪式

> O-115 · L9 扩展池（〔复〕复用档）· 服务键 `ondra-ritual`
>
> 今天是什么日子，这一天适合做一件什么事。**不算历法、不编节日、一个数字都不给。**

## 1. 一句话定位

她问「今天是什么日子」时，这个插件给两样东西：**今天是不是节气 / 传统节日**，
以及如果是，**一句方向 + 一个具体动作**，让这一天有一点纹理。

前一半完全来自上游 O-046 `ondra-live`（节气、农历节日），本插件**一行历法都不算**；
后一半是查一张写死在代码里的仪式表。表里没有的日子，它报
**「今天没有可确认的仪式」**，不凑、不猜、不现编。

## 2. 服务键与契约

服务键 **`ondra-ritual`**（连字符，全仓唯一归属；`ondra:ritual` 会被模型侧直接拒绝）。

```ts
interface RitualService {
  readonly available: boolean
  readonly reason?: RitualErrorCode

  today(at?: number): DayFactsView                    // 只读：今天是什么日子
  ritualOf(day: DayFactsView, hint?: DayHint): RitualPlan  // 纯查表：这一天给什么仪式
  upcoming(at?: number): readonly UpcomingRitual[]    // 只有名字，没有天数
  wetHint(at?: number): Promise<boolean | undefined>  // 天气软判断，取不到就是 undefined
  stats(): RitualStats                                // 只在内存的计数
}
```

典型用法（外壳侧）：

```ts
const ritual = ctx.get('ondra-ritual')
if (ritual === undefined) return          // 缺席就安静退出
const day = ritual.today()                // 今天是立冬 / 春节 / 普通的一天
const plan = ritual.ritualOf(day)         // 有仪式就是方向 + 动作，没有就是「无仪式」
```

`DayFactsView` 的关键三个位：

| 字段 | 含义 |
|---|---|
| `kind` | `jieqi` / `festival` / `ordinary`——**这一天是什么** |
| `dayName` | 节气名或节日名；`ordinary` 与降级时为 `null` |
| `confirmed` | 上游是否**明确认定**了这一天。`false` 不代表出错，代表「不敢说」 |

`confirmed` 与 `kind` 之所以是两个位：上游说「今天是寒食」而我们表里没有寒食时，
`kind` 仍要如实记着这一天有名字，`confirmed` 仍为 `true`，而 `action` 是 `null`。
合成一个位，就只能二选一——说成普通的一天（撒谎），或者现编一条（更糟）。

`RitualPlan` 的 `action` 在无仪式时**恒为 `null`**：不拿「随便走走」占位，
因为占位会被当成建议念出来。`mustNot` 四条恒定禁令每一份都带。

## 3. 明确不负责

| 不负责 | 归谁 |
|---|---|
| 农历、节气、农历节日的计算 | O-046 `ondra-live`（本插件只读它的名字） |
| 说话、口吻、人称、要不要提这一天 | 人格 O-020 / 表达 O-047 |
| 什么时候主动开口、一天能说几次 | O-042 `ondra-proactive-gate`（静默时段、日额度、六道闸） |
| 天气实况与预报 | O-047 `ondra-weather`（本插件只问「会不会下」一件事） |
| 今天的日程、待办、打卡 | 不做（见 §6） |
| 渲染、Toast、日历视图 | 应用外壳 `desktop/`（L8 界面插件已整批下线） |
| 公历节日（元旦、国庆这类） | 不做（见 §6 第 2 条） |

## 4. 技术来源

**档位：〔复〕复用。** 农历与节气**完全复用上游**，本插件只做择取与文案骨架。

| 能力 | 来源 | 仓库地址 | 许可证 | 借鉴了什么 | 本项目如何实现 | 是否引入代码 |
|---|---|---|---|---|---|---|
| 农历换算 | `lunar-javascript`（6tail） | https://github.com/6tail/lunar-javascript | MIT | 农历月日、干支、节气名 | **不引入**：经 O-046 `ondra-live` 的 `branches/lunar-js.ts` 调用 | 否 |
| 农历换算（对拍分支） | `tyme4ts`（6tail） | https://github.com/6tail/tyme4ts | MIT | 同一套农历的另一实现，用于互相对拍 | **不引入**：经 O-046 的 `branches/tyme4ts.ts` 调用 | 否 |
| 节气名与农历节日名 | 本项目 O-046 `ondra-live` | 仓库内 | AGPL-3.0（同仓） | `DateFacts.jieQi` / `lunarFestivals` / `facts()` / `upcoming()` | 只读名字做**字符串相等**匹配，不读 `daysAway` | 否 |
| 公历季节 | 公历常识（月份三分） | — | — | 三到五月为春，依次类推 | `ritual.ts` 的 `seasonOf()`，不表 | 否 |
| 仪式文案 | 本插件自写 | — | AGPL-3.0（同仓） | 只有「方向是陈述、动作一步能做完」这一条原则 | `table.ts` 三十四条常量 | 否 |

**关于双分支对拍**：`lunar-javascript` 与 `tyme4ts` 的对拍在 O-046 里做（`crosscheck()`），
本插件**不重复对拍**——对拍的是历法，而本插件根本不算历法。它只信任上游选路的结果，
并把上游给的分支名记在 `DayFactsView.upstream` 里，便于排查「为什么今天没仪式」。

**关于不引入代码**：全仓禁装依赖，且 §18.5 要求相邻服务一律经服务键调用。
所以本插件对上游的全部知识就是 `src/types.ts` 末尾那几段结构对位声明，
**没有一条 `import` 指向 `ondra-*` 源码**。

## 5. 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enable` | boolean | `true` | 总开关。关掉后服务仍注册，`today()` / `upcoming()` 抛 `disabled`，`stats()` 照常 |
| `include-festivals` | boolean | `true` | 是否把传统节日也纳入仪式。关掉只认二十四节气 |
| `upcoming-limit` | number（1–5） | `3` | `upcoming()` 最多给几个（是条数，**不是天数**） |
| `scan-days` | number（1–60） | `15` | 往后翻几天去找下一个日子。**只用于扫描窗口，绝不出现在输出里** |
| `wet-adjust` | boolean | `true` | 有天气且今天要下雨下雪时，把动作换成室内替代；取不到天气就什么都不做 |

五个字段**全部是收窄用的**，没有一个是放宽的：没有「允许模型自己想一个节日」、
没有「允许报还有几天」、没有「允许主动提醒」。这三条是纪律，做成开关就等于留了一个会被打开的口子。

`scan-days` 默认半个月：两个节气大约隔十五天，窗口再短就会经常「看不到下一个」。

## 多方案分支（master-plan §12）

这一条在本插件上是**明确选边**，不是并做两套：

- 农历与节气有两条实现路线（`lunar-javascript` 与 `tyme4ts`），对拍发生在 **O-046 `ondra-live`** 内部，本插件只读它给的结果。这里刻意**不复刻第二套历法**：两套历法在节气边界上差一天时，用户会同时收到两个「今天是冬至」，而没有任何一方能说清谁对。
- 上游缺席时不切换算法，直接降级到公历季度，并明确报「今天没有可确认的仪式」（见第 6 节）。降级路径只有一条。
- 仪式清单写死在代码里，不做「外部可替换清单」的第二分支——外部 JSON 第一件事就是被改松。

## 6. 已知限制

1. **没有 `ondra-live` 时，降级成「只有公历季节 + 明确的无仪式」。**
   - `today()` 返回 `source='solar'`、`confirmed=false`、`weekdayName=''`（**连星期几也不自己排**，
     避免多一处会随时区漂的日历代码）；
   - `ritualOf()` 返回 `kind='season'`、`direction='今天没有可确认的仪式'`、`action=null`；
   - `upcoming()` 返回空数组；
   - `stats().degraded` 加一，日志里有一行原因。
2. **上游在、但没有农历分支（`lunarReady=false`）时，按第 1 条同样降级。**
   这时上游的 `jieQi` 恒为 `null`，若当成「今天什么都不是」就会撒谎——它只是不知道。
3. **公历节日（元旦、国庆、圣诞等）不在仪式表里**，报了也是「无仪式」。
   本插件的题目是节气与传统节日；把范围扩到所有节日，下一个问题就是「那生日要不要也算」。
4. **上游认定了但表里没有的日子**（例如某些年份的地方性节日），
   `today()` 如实报 `dayName`，`ritualOf()` 报无仪式，`note` 里写明「不现编一条」。
5. **`wetHint()` 是异步的**，因为它要问 O-047。外壳**不应在关键路径上 await 它**：
   取不到就按 `undefined` 处理（等于不知道），动作照原样给。这是刻意的——
   为了一个雨天提示而让「今天冬至」这句话晚到两秒，不划算。
6. **不判断「今天是不是补班 / 假期」**，那是日历服务的事，本插件没有这个依赖。
7. **不支持多人、不支持多时区。** 一天就是一天，按 `ondra-clock` 的自然日键算。

## 7. 隔离五问（master-plan §16.4）

1. **关掉我，谁受影响？** 只有我自己。她问「今天是什么日子」时，上游仍能给出日期事实，
   只是没有仪式、没有方向、没有动作。**不会有人因此说错话**——这是本插件的设计目标。
2. **我的状态存在哪？** **不存在任何地方。** 没有存档、没有「今天做过没有」、没有上一次给的仪式。
   唯一可变的是 `stats()` 的几个内存计数，重启归零。
3. **我崩了怎么知道是我崩了？** 日志命名空间 `ondra.ritual`（经 O-001 拼），
   `stats().lastIssue` 留一行中文原因，`stats().degraded` 数着降级次数。
   服务本身不抛异常：`today()` / `upcoming()` 只在 `bad-request`（时刻非法）与 `disabled` 时抛，
   上游的任何失败都变成降级事实。
4. **我依赖谁？缺席怎么降级？** 四项全软：`ondra-live` / `ondra-clock` / `ondra-weather` / `ondra-identity`，
   见 §6。任一缺席都能跑，降级处各有一行日志。
5. **我和同域的谁共享可变状态？** 没有。上游的缓存归上游，本插件只读返回值。
   与 O-046 共享的只有**名字字符串**这一层约定，改任一侧的名字都要两边一起改。

## 8. 关键裁决（为什么这样而不是那样）

| 裁决 | 理由 |
|---|---|
| **宁可报「无仪式」，绝不编节日** | 编一个不存在的节气，比没有仪式糟得多：用户会当真的用，而且它不会被任何一次测试发现——因为编出来的东西格式完全正确 |
| **仪式清单写死在代码里** | 外部 JSON 的第一件事一定是被改松：改松之后会有人加「雨天适合喝奶茶」，再然后会让模型自己往里写。到那一步它就不再是节气插件了 |
| **一个数字都不给** | 不说「距离冬至还有多少天」，也不说「这是第几个节气」。倒计时把一个日子变成一条进度条，而进度条是要被完成的 |
| **不做提醒、不装定时器、不主动发送** | 要不要说、什么时候说归 O-042 的六道闸。本插件只在她问起时回答，不问就不说 |
| **依赖全软** | 一个节气插件因为 `ondra-live` 晚装载三秒就拒绝加载，代价远大于它这三秒里少说一句「今天是立冬」 |
| **不落盘** | 一旦记了「今天已做过」，第二天它就会开始问「昨天为什么没做」。那是打卡应用，不是这个插件 |
| **`confirmed` 与 `kind` 分开** | 见 §2：合成一个位，在「上游说有、表里没有」时只能撒谎或现编 |

## 9. 自检（master-plan §16.1 九项 + §16.2 语言五项 + 图标一项）

| 类别 | 项 | 结果 |
|---|---|---|
| §16.1 | 1 结构完整（七必需 + icon） | 过 |
| §16.1 | 2 清单合法（JSON 可解析 / `ondra-*` / `type: module` / main+types+exports+files / `@ntars/cordis` 双声明） | 过 |
| §16.1 | 3 编译配置（target / module / moduleResolution / strict / rootDir / outDir / declaration） | 过 |
| §16.1 | 4 入口契约（`name` + `apply` + `Config` 默认值齐全） | 过 |
| §16.1 | 5 服务键唯一（`ondra-ritual` 全仓唯一） | 过 |
| §16.1 | 6 依赖可解析（4 个软依赖全部有提供方） | 过 |
| §16.1 | 7 无越界 import（`from 'ondra-` 零条，只有 `@ntars/cordis` 与相对路径） | 过 |
| §16.1 | 8 降级到位（5 处 `ctx.get` 全判 `undefined`） | 过 |
| §16.1 | 9 交付物齐全（技术来源 / 关键裁决 / 隔离五问 / 不负责 / 已知限制） | 过 |
| §16.2 | 括号配平 / 无残留半句 / `import type` 用法 / 无 TODO / UTF-8 无 BOM 无乱码 | 过 |
| 图标 | 与仓库根 `icon.svg` 逐字节一致 | 过 |

## 10. 文件清单（十三）

```
package.json          清单（含 ondra.bundle.patch 指向下方补丁）
tsconfig.json         NodeNext ×2 + strict + rootDir/outDir/declaration
cordis.patch.yml      入口补丁（insert 无 id → 追加根入口）
icon.svg              图标副本（真源＝仓库根 icon.svg，与 tools/sync-plugin-icons.mjs 的产物逐字节一致）
locale/en.json        英文元数据
locale/zh.json        中文元数据
README.md             本文件
src/index.ts          入口：name / apply(ctx, config) / Config
src/types.ts          契约：服务键、日子三档、仪式形状、错误码、结构对位
src/settings.ts       配置单一真源（FIELD_SPECS → DEFAULT_CONFIG / 段声明 / completeConfig）
src/table.ts          仪式表（三十四条写死的常量）+ 四条恒定禁令
src/ritual.ts         纯判定层：判季节 / 判日子 / 择取仪式（无 IO / 无 Date / 无定时器）
src/service.ts        接线与降级
```

## 11. 快速上手

```yaml
# cordis.yml（节选）
plugins:
  - ondra-ritual        # 零硬依赖；日期 / 时钟 / 天气 / 身份都是软依赖
```

外壳侧一个完整的调用（含可选的天气软判断）：

```ts
const ritual = ctx.get('ondra-ritual')
if (ritual === undefined) return
const day = ritual.today()
if (!day.confirmed) {
  // 今天不是日子，或上游不在——两种都不该硬说点什么
  return
}
const wet = await ritual.wetHint().catch(() => undefined)   // 取不到就是 undefined
const plan = ritual.ritualOf(day, { wet })
// plan.direction 是一句方向，plan.action 是一个动作，plan.mustNot 是四条禁令
// 怎么把这三样变成她的一句话，是 O-020 / O-047 的事
```
