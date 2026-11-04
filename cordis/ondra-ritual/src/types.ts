/**
 * O-115 `ondra-ritual` 的对外契约（〔复〕复用档，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「今天是什么日子，这一天该怎么过一点点？」**
 *
 * 输出两样东西：今天是不是节气 / 传统节日；如果是，给一句方向 + 一个具体动作。
 *
 * ## 为什么农历与节气一行都不在本插件里写
 *
 * 农历不是「几个公式」，是一张要按年维护的历法表（闰月、定朔、节气时刻精确到分）。
 * 手册 §1.8 把农历列进**复用**档，本仓已有 O-046 `ondra-live` 做完了接线、对拍与降级。
 * 在这里再写一遍的唯一后果是**两个真源**：某一年节气差一天，一处对一处错，
 * 而错的那处不会报错，只会安静地把立冬说成大寒。
 *
 * 所以本插件对上游的用法是：**只读 `jieQi` 与两个节日数组**，全部拿名字去查表。
 * 名字对不上就当没有——宁可报「无仪式」，也绝不猜。
 *
 * ## 三档事实（`kind` 与 `confirmed` 是分开的两个位）
 *
 * | 情形 | `kind` | `confirmed` | `action` |
 * |---|---|---|---|
 * | 上游确认是节气，且表里有 | `jieqi` | `true` | 有 |
 * | 上游确认是节日，且表里有 | `festival` | `true` | 有 |
 * | 上游确认是节气 / 节日，但表里没有 | 原样保留 | `true` | `null`（无仪式） |
 * | 上游在，但今天什么都不是 | `ordinary` | `false` | `null` |
 * | 上游不在（或缺农历分支） | `season` | `false` | `null` |
 *
 * 「确认是这一天」与「这一天有仪式」**必须是两个位**。合成一个，就会在
 * 「上游说了是寒食，但表里没有寒食」这种情况下被迫二选一：要么假装普通的一天
 * （撒谎），要么现编一条仪式（更糟）。分开之后两件事都能如实说。
 *
 * ## 明确不做
 *
 * 不算农历节气（O-046 的活）、不编节日、不报「还有几天」（一个数字都不给）、
 * 不做提醒与定时器、不主动发消息（O-042 的活）、不做界面、不记录「今天做过没有」。
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（§18.5），相邻服务只声明结构对位子集。
 */

/** 本插件注册的服务键（连字符，非 `ondra:ritual`）。全仓唯一归属。 */
export const RITUAL_SERVICE_KEY = 'ondra-ritual'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法不会在编译期报错，
 * 只在**运行期**被模型侧拒绝——写的时候一切正常，跑起来才发现插件没加载。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/* ------------------------------------------------------------------ *
 * 日子
 * ------------------------------------------------------------------ */

/**
 * 公历季节。只由月份粗粒度决定，**不用节气判断**——
 * 二十四个节气是上游的事，这里只需要一个「上游不在时也能说出口」的粗格子。
 */
export type Season = 'spring' | 'summer' | 'autumn' | 'winter'

const SEASON_LIST: readonly Season[] = ['spring', 'summer', 'autumn', 'winter']

/** 四个季节（只读，供外壳枚举）。 */
export const SEASONS: readonly Season[] = Object.freeze(SEASON_LIST)

/** 日子的种类闭集。 */
export type DayKind =
  /** 节气日。 */
  | 'jieqi'
  /** 传统节日。 */
  | 'festival'
  /** 上游在场，但今天什么都不是。 */
  | 'ordinary'

/** 事实来自哪里。`solar` = 只有公历，且**没有**任何日子判定。 */
export type DaySource = 'live' | 'solar'

/** 某一天的只读事实。**没有天数、没有「还有几天」。** */
export interface DayFactsView {
  /** 自然日键 `YYYY-MM-DD`。 */
  readonly dayKey: string
  /** 星期中文名；没有上游时为空串（**不自己排一份会漂的星期表**）。 */
  readonly weekdayName: string
  /** 种类。 */
  readonly kind: DayKind
  /** 这一天的名字（节气名 / 节日名）；`ordinary` 与降级时为 `null`。 */
  readonly dayName: string | null
  /** 公历季节。 */
  readonly season: Season
  /** 上游是否**明确认定**了这一天。`false` 不代表出错，代表「不敢说」。 */
  readonly confirmed: boolean
  /** 事实来源。 */
  readonly source: DaySource
  /** 上游历法分支名（`lunar-js` / `tyme4ts` / `solar-only` / `none`）。 */
  readonly upstream: string
  /** 上游农历分支是否在位。与 `source` 分开，便于面板显示「只有公历」。 */
  readonly lunarReady: boolean
}

/** 天气软判断。`wet` 省略 = 不知道，此时一律按原动作给。 */
export interface DayHint {
  /** 今天会不会下（雨 / 雪）。`undefined` = 不知道，不要猜。 */
  readonly wet?: boolean
}

/** 一份仪式。**没有台词，也没有任何数字。** */
export interface RitualPlan {
  /** 仪式的种类。`season` = 上游不在时的降级；`none` = 这一天没有可确认的仪式。 */
  readonly kind: 'jieqi' | 'festival' | 'season' | 'none'
  /** 这一天的名字；无仪式时为 `null`。 */
  readonly dayName: string | null
  /** 上游是否明确认定。**`false` 时 `action` 恒为 `null`。** */
  readonly confirmed: boolean
  /** 公历季节。 */
  readonly season: Season
  /** 一句话的方向。**无仪式时也有一句**，那句就是「今天没有可确认的仪式」。 */
  readonly direction: string
  /** 一个具体动作；无仪式时为 `null`（**不拿「随便走走」占位**）。 */
  readonly action: string | null
  /** 同一动作的室内替代（下雨时用）；没有替代时为 `null`。 */
  readonly actionIndoor: string | null
  /** 恒定禁令。每一份都带，顺序固定。 */
  readonly mustNot: readonly string[]
  /** 一句中文，说明这份判定**依据什么**。给日志与外壳看，不是台词。 */
  readonly note: string
}

/** 一个「快到了」的日子。**只有名字，没有日期、没有天数。** */
export interface UpcomingRitual {
  /** 种类。 */
  readonly kind: 'jieqi' | 'festival'
  /** 名字。 */
  readonly name: string
}

/** 累计统计。**只在内存**，进程重启归零；不落盘、不打卡。 */
export interface RitualStats {
  /** `today()` 调用次数。 */
  readonly calls: number
  /** 返回过「有仪式」的次数。 */
  readonly confirmed: number
  /** 返回过「无仪式」的次数。 */
  readonly empty: number
  /** 上游缺席而降级的次数。 */
  readonly degraded: number
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type RitualErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（时刻不是有限正数、日子对象形状不对）。 */
  | 'bad-request'

/** 节气仪式错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class RitualError extends Error {
  /** 错误码。 */
  readonly code: RitualErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: RitualErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'RitualError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface RitualService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因（`available=true` 时为 `undefined`）。 */
  readonly reason?: RitualErrorCode

  /**
   * 今天是什么日子。**只读、不落盘。**
   * @param at 毫秒时间戳，省略用系统时间。
   */
  today(at?: number): DayFactsView

  /**
   * 由日子的判定择取仪式。**纯查表，不重算历法。**
   * @param day `today()` 的返回值。
   * @param hint 天气软判断，省略即「不知道」。
   */
  ritualOf(day: DayFactsView, hint?: DayHint): RitualPlan

  /**
   * 快到了的几个日子。**只有名字，没有天数。** 上游缺席时返回空数组。
   * @param at 毫秒时间戳，省略用系统时间。
   */
  upcoming(at?: number): readonly UpcomingRitual[]

  /**
   * 问一次天气，只回答「今天会不会下」。取不到返回 `undefined`（**不要猜**）。
   * @param at 毫秒时间戳，省略用系统时间。
   */
  wetHint(at?: number): Promise<boolean | undefined>

  /** 累计统计快照。 */
  stats(): RitualStats
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * §18.5：相邻服务一律经服务键调用，不 import 源码。
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状。 */
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

/** O-003 时钟服务的结构对位子集。**只取自然日键，不重写日历。** */
export interface ClockLike {
  dayKey(epoch?: number): string
}

/** O-046 的农历快照（本插件只用到「有没有」这一个事实）。 */
export interface LunarLike {
  readonly yearGanZhi: string
  readonly shengXiao: string
  readonly month: number
  readonly day: number
  readonly monthName: string
  readonly dayName: string
  readonly leap: boolean
}

/**
 * O-046 的某天事实（结构对位子集）。
 *
 * 刻意**不声明** `nextJieQi` / `dayOfYear` 这类带距离的字段：
 * 用不上它们，声明了就会有人顺手拿来算「还有几天」。
 */
export interface DayFactsLike {
  readonly dayKey: string
  readonly month: number
  readonly day: number
  readonly weekdayName: string
  readonly lunar: LunarLike | null
  readonly jieQi: string | null
  readonly solarFestivals: readonly string[]
  readonly lunarFestivals: readonly string[]
  readonly festivals: readonly string[]
  readonly provider: string
  readonly lunarReady: boolean
}

/** O-046 的一个未来事件。`daysAway` 同上，只存在于对位形状里。 */
export interface LiveEventLike {
  readonly kind: 'festival' | 'lunar-festival' | 'jieqi'
  readonly name: string
  readonly dayKey: string
  readonly daysAway: number
}

/** O-046 日期事实服务的结构对位子集。 */
export interface LiveLike {
  readonly available: boolean
  readonly lunarReady: boolean
  readonly provider: string
  facts(at?: number): DayFactsLike
  upcoming(days?: number, at?: number): readonly LiveEventLike[]
}

/** O-047 的精简天气事实（只用到降水与现象两项）。 */
export interface WeatherFactsLike {
  readonly text?: string
  readonly precipProb?: number
  readonly phenomenon?: string
}

/** O-047 天气服务的结构对位子集。**只有 `facts()` 会被调用。** */
export interface WeatherLike {
  facts(at?: number): Promise<WeatherFactsLike | undefined>
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 的解析结果形状。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 配置真源服务的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
