/**
 * O-120 `ondra-daily-brief` 的对外契约：**早上第一屏的三件事**。
 *
 * ## 名字里的「简报」指的是一件很窄的事
 *
 * 它**不是**日报、不是摘要、不是待办清单。它把三件事按固定顺序摆出来：
 *
 * ```
 * 1 承诺（有时限的）    ← 今天不做就会误事的那一件
 * 2 悬着的事            ← 昨天之前就记下、到现在还没勾掉的那一件
 * 3 环境                ← 今天是什么日子、外面什么样
 * ```
 *
 * **每段只点名一件，总共最多三件。** 三个以上就不叫简报，叫清单；
 * 而清单的第一屏永远读不完，于是第一屏就废了。
 *
 * ## 三条绝不能破的口径
 *
 * 1. **不报数字。** 不许出现「你还有 7 条待办」这种句子。数字会被当成进度条，
 *    然后开始对着进度条过日子。宁可点名具体那一件（「答应过周三前把稿子发过去」）。
 *    段内出现的时刻（「今天 18:00 前」）与气温不算违规——那是那一件事的属性，
 *    不是对主人的计数。
 *
 * 2. **空与读不到是两件事。** `empty`（上游在位，今天确实没有）与
 *    `not-available`（读不到）必须分开。合成一档，用户会把「读不到」
 *    当成「今天没什么事」——那是最糟的一种误导，它让人以为一切已被检查过。
 *
 * 3. **只在被调用时生成。** 契约里没有「推送」「订阅」「到点触发」任何一种形状。
 *    本插件不声明 `inject`、不装定时器、不调用任何发送服务：
 *    「什么时候看」归应用外壳与主人，「看不看得到」不该由插件替人决定。
 *
 * ## 它新算的东西是零
 *
 * 承诺来自 O-016、记忆来自 O-010、节气与节日来自 O-046、天气来自 O-047。
 * 本插件只做**选择与排序**：挑哪一条、摆在第几位、怎么说清楚它。
 * 任何一个数都不在这里重新定义——上游口径变了，简报跟着变，这才是投影。
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（§18.5），全部结构对位镜像。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const DAILY_BRIEF_SERVICE_KEY = 'ondra-daily-brief'

/**
 * 一份简报最多几条。
 *
 * 写成常量而不是配置项：**能调成十条的那天，它就不再是简报**。
 * 想多看的人直接去看承诺服务与待办服务，那里本来就是全量。
 */
export const MAX_ITEMS = 3

/**
 * 三个槽位，顺序即优先级。
 *
 * 顺序是**结构**，不是偏好：有时限的承诺今天不做就会误事，
 * 悬着的事只是越来越旧，环境信息今天不看明天也不会消失。
 * 故刻意不提供「调整顺序」的配置。
 */
export const BRIEF_SLOTS = ['promise', 'carry-over', 'ambient'] as const

/** 槽位 id。 */
export type BriefSlot = (typeof BRIEF_SLOTS)[number]

/** 一个槽位的说明书（静态，不含内容）。 */
export interface SlotSpec {
  /** 槽位 id。 */
  readonly slot: BriefSlot
  /** 中文名。只给日志与外壳标签，**不进提示词**。 */
  readonly zh: string
  /** 一句话：这一段在回答什么。 */
  readonly about: string
  /** 真源在哪个服务。 */
  readonly owner: string
}

/**
 * 三段说明书 —— **本插件全部槽位定义的唯一真源**。
 *
 * `owner` 不只是文档：每段的 `sources` 服务键由它派生，改归属只改这一处。
 */
export const SLOT_SPECS: Readonly<Record<BriefSlot, SlotSpec>> = Object.freeze({
  promise: Object.freeze({
    slot: 'promise',
    zh: '承诺',
    about: '有时限、且今天不做就会误事的那一件承诺。只点名一件，报的是最早到期的那件。',
    owner: 'ondra-memory-prospective',
  }),
  'carry-over': Object.freeze({
    slot: 'carry-over',
    zh: '悬着的事',
    about: '昨天之前就记下、到现在还没勾掉的那一件待办。挑最早会过期的那件。',
    owner: 'ondra-memory-prospective',
  }),
  ambient: Object.freeze({
    slot: 'ambient',
    zh: '外面',
    about: '今天是什么日子（节气 / 节日）与外面的天气。取不到就明说取不到。',
    owner: 'ondra-live',
  }),
})

/**
 * 一段的状态。**三态，不是两态。**
 *
 * `empty` 与 `not-available` 混成一档，界面就会把「承诺服务没装」显示成
 * 「今天没有承诺」——前者要人去装/去查，后者可以放心过日子，代价差得很远。
 */
export const ITEM_STATES = ['ready', 'empty', 'not-available'] as const

/** 一段的状态。 */
export type ItemState = (typeof ITEM_STATES)[number]

/** 一个数据来源。 */
export interface BriefSource {
  /** 服务键。 */
  readonly service: string
  /** 字段或方法名。 */
  readonly field: string
  /** 读到了没有。 */
  readonly ok: boolean
}

/** 简报里的一段。 */
export interface BriefItem {
  /** 槽位。 */
  readonly slot: BriefSlot
  /** 槽位中文名（外壳画标签用）。 */
  readonly zh: string
  /** 三态。 */
  readonly state: ItemState
  /**
   * 点名的那一件（原文，**不摘要、不改写**）。
   *
   * `state !== 'ready'` 时是一句说明「这一段今天为什么没有」。
   */
  readonly title: string
  /** 第二句：时间、紧迫度、或缺失原因。可能为空串（表示没有第二句可说）。 */
  readonly detail: string
  /** 这一段的数据来自哪（服务键 + 字段），**供核对，不供展示**。 */
  readonly sources: readonly BriefSource[]
  /** 能跳到原件时给出原件的位置。环境段没有 id，故可缺。 */
  readonly ref?: {
    readonly service: string
    readonly id: string
  }
}

/** 一份晨间简报。 */
export interface DailyBrief {
  /** 自然日键 `YYYY-MM-DD`（生效时区）。 */
  readonly dayKey: string
  /** 生成时刻。 */
  readonly at: number
  /** 三段（`include-ambient=false` 时只有两段）。顺序即优先级。 */
  readonly items: readonly BriefItem[]
  /** 今天这份是否已经被 `ack()` 认领过（只在本次进程内有效）。 */
  readonly acked: boolean
  /** 一句话总述（中文）。只说「今天提哪几段、哪段没有、哪段读不到」。 */
  readonly summary: string
}

/** 统计快照。 */
export interface BriefStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: BriefUnavailableReason
  /** 累计生成份数。 */
  readonly built: number
  /** 累计降级次数（上游缺席、调用失败、时钟退回本机时区）。**不为 0 说明有段在降级**。 */
  readonly degraded: number
  /** 本次进程里最后认领的自然日键；从没认领过为 `undefined`。 */
  readonly ackedDayKey?: string
  /** 最近一次降级的说明。 */
  readonly lastIssue?: string
}

/** 认领结果。 */
export interface AckView {
  /** 自然日键。 */
  readonly dayKey: string
  /** 认领时刻（重复认领时是第一次的时刻）。 */
  readonly ackedAt: number
  /** 是不是重复认领（同一自然日第二次及以后）。 */
  readonly repeat: boolean
}

/** 不可用原因。只有「配置关掉」才算真的不可用。 */
export type BriefUnavailableReason = 'disabled'

/** 错误码闭集。刻意没有「未知错误」一档：走到未知分支说明本插件有 bug，该让它抛出来。 */
export const BRIEF_ERROR_CODES = [
  /** 配置关掉了。 */
  'disabled',
  /** 入参不合法。 */
  'bad-request',
] as const

/** 错误码。 */
export type BriefErrorCode = (typeof BRIEF_ERROR_CODES)[number]

/** 一件错误。每种都带中文说明，直接给人看。 */
export class BriefError extends Error {
  /** 错误码。 */
  readonly code: BriefErrorCode

  /**
   * @param code 错误码。
   * @param detail 中文说明。
   */
  constructor(code: BriefErrorCode, detail: string) {
    super(detail)
    this.name = 'BriefError'
    this.code = code
  }
}

/**
 * 时刻运算的最小面（时钟服务缺席时由本插件退回本机时区实现）。
 *
 * 投影层只经这一个口子算日子与时刻，因此「不准」只会有一个来源。
 */
export interface BriefClock {
  /** 自然日键 `YYYY-MM-DD`。 */
  dayKey(at: number): string
  /** `HH:MM`。 */
  hhmm(at: number): string
  /** 相差几个自然日（`b - a`，带方向）。 */
  daysBetween(a: number, b: number): number
}

/** 日志门面的最小形状（Cordis Logger 的结构对位子集）。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-003 时钟服务的结构对位子集。 */
export interface ClockLike {
  now(): number
  dayKey(epoch?: number): string
  hhmm(epoch?: number): string
  daysBetween(a: number, b: number): number
}

/** 一条承诺（O-016 `PromiseRecord` 的结构对位子集，只取简报要说的那些）。 */
export interface PromiseRecordLike {
  /** 承诺 id。 */
  readonly id: string
  /** 锁住的原文。**简报原样引用，不摘要**。 */
  readonly text: string
  /** 到期时刻；`0` 表示无期限（「下次」那种）。 */
  readonly dueAt: number
  /** 宽限截止。 */
  readonly graceUntil: number
  /** 对应 `memory_fact` 的记忆 id（用来核对它是否已被删除）。 */
  readonly factId: string
}

/** 一条到期候选（O-016 `ReminderItem` 的结构对位子集）。 */
export interface ReminderLike {
  readonly promise: PromiseRecordLike
  /** 距到期还有多少小时（负数表示已过期、仍在宽限期）。 */
  readonly hoursLeft: number
  /** 是否已过到期时刻（处于宽限期）。 */
  readonly inGrace: boolean
}

/** 一条待办（O-016 `TodoRecord` 的结构对位子集）。 */
export interface TodoLike {
  readonly id: string
  readonly text: string
  readonly createdAt: number
  /** 最近一次被提起的时刻。 */
  readonly lastMentionedAt: number
  /** 过期时刻（再不提就会被清理）。 */
  readonly expiresAt: number
  readonly done: boolean
}

/**
 * O-016 `ondra-memory-prospective` 的结构对位子集。
 *
 * **只取读方法**：`listOpen()` 与 `listTodos()`。契约里没有任何写路径
 * （没有 `remember` / `settle` / `touchTodo`）——「只读」落到代码上就是接口里没那条路。
 */
export interface ProspectiveLike {
  readonly available: boolean
  listOpen(at?: number): readonly ReminderLike[]
  listTodos(): readonly TodoLike[]
}

/** O-010 `ondra-memory-core` 的结构对位子集（只用来核对一条承诺背后的记忆是否还在）。 */
export interface MemoryCoreLike {
  readonly available: boolean
  getFact(id: string): unknown
}

/** 某个节气。 */
export interface JieQiLike {
  readonly name: string
  readonly dayKey: string
  /** 距今天几天（`0` = 今天）。 */
  readonly daysAway: number
}

/** 某一天的日期事实（O-046 `DateFacts` 的结构对位子集）。 */
export interface DateFactsLike {
  readonly dayKey: string
  readonly weekdayName: string
  /** 当天节气名；不是节气日时为 `null`。 */
  readonly jieQi: string | null
  /** 下一个节气；算不出时为 `null`。 */
  readonly nextJieQi: JieQiLike | null
  /** 当天的节日名（已合并公历与农历两个来源）。 */
  readonly festivals: readonly string[]
}

/** O-046 `ondra-live` 的结构对位子集。 */
export interface LiveLike {
  readonly available: boolean
  facts(at?: number): DateFactsLike
}

/** 天气事实（O-047 `WeatherFacts` 的结构对位子集）。 */
export interface WeatherFactsLike {
  /** 地点名（用户自己填的标签）。 */
  readonly place?: string
  /** 一句中文，上游已经写好，**本插件原样引用，不重写**。 */
  readonly text: string
  readonly tempC: number
  readonly feelsC?: number
  readonly highC?: number
  readonly lowC?: number
  readonly precipProb?: number
  readonly phenomenon?: string
  readonly day: boolean
  readonly observedAt: number
}

/**
 * O-047 `ondra-weather` 的结构对位子集。
 *
 * `facts()` 是 `Promise`：天气要发网络请求。本插件的 `brief()` 因此**也是异步的**——
 * 为了让 `brief()` 变成同步而在这里缓存一份天气，等于自己养第二份天气真源。
 */
export interface WeatherLike {
  readonly available: boolean
  facts(at?: number): Promise<WeatherFactsLike | undefined>
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** 晨间简报服务。 */
export interface DailyBriefService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: BriefUnavailableReason

  /** 三段说明书（静态，不含内容）。 */
  sections(): readonly SlotSpec[]

  /**
   * 出简报。**只在被调用时生成**：不落盘、不推送、不装定时器。
   * @param at 时刻，省略取现在。
   */
  brief(at?: number): Promise<DailyBrief>

  /**
   * 记一次「今天这份看过了」，让同一自然日内重复出简报时能标 `acked`。
   * @param at 时刻，省略取现在。
   */
  ack(at?: number): AckView

  /** 统计快照。 */
  stats(): BriefStats
}
