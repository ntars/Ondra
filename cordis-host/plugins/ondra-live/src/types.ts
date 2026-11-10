/**
 * O-046 `ondra-live` 的对外契约。
 *
 * 定位：**「今天是什么日子」的唯一答案源**——公历、星期、农历、节气、节日，
 * 全部本机算，不联网。对话把它放在**易变段**（手册 §8.5），不放进冻结前缀。
 *
 * ## 为什么农历不在本插件里自己算
 *
 * 手册 §1.8 把「农历」明确列进**复用**档：`lunar-javascript` / `tyme4ts`。
 * 农历不是「几个公式」，是一张要按年份维护的历法表（闰月、定朔、节气时刻），
 * 自己写等于每年对着天文台数据校一次，写错就是节气差一天、除夕落到二十九。
 * 所以本插件只做三件事：**接线、对拍、降级**（§1.8 原话）。三件事分别落在
 * `branches/*.ts`（接线）、`select.ts`（对拍与选路）、`service.ts`（降级）。
 *
 * ## 「没有农历」必须是一种可表达的状态
 *
 * 本仓禁装依赖，所以**出厂态就是没有农历**。这时绝不允许：
 *
 * - 编一个农历日期出来（比不显示恶劣得多，用户会当真的用）；
 * - 把整个插件标成不可用（公历、星期、公历节日仍然完全可用）。
 *
 * 于是有两个位：`available`（开关开着）与 `lunarReady`（农历分支真的在位）。
 * 面板照这两个位显示「已启用 / 只有公历」——这是纪律 83 的又一次应用。
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（§18.5）。
 */

/** 本插件注册的服务键（连字符，非 `ondra:live`）。全仓唯一归属。 */
export const LIVE_SERVICE_KEY = 'ondra-live'

/** 服务键 / 工具名 / 配置键的形状（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 自然日键的形状。`solar.ts` 的合法性校验用它，别处不再重复写一遍正则。 */
export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 星期名。索引即 `Date.getDay()` 的返回值。 */
const WEEKDAY_NAMES_TMP: readonly string[] = [
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
]

/** 星期名出口。 */
export const WEEKDAY_NAMES: readonly string[] = Object.freeze(WEEKDAY_NAMES_TMP)

/* ------------------------------------------------------------------ *
 * 分支与状态
 * ------------------------------------------------------------------ */

/**
 * 历法分支。
 *
 * `solar-only` 是**默认底座**（§14.2「默认最稳」）：它永远可用，且不依赖任何外部包。
 * 另两条是可选增强，装了就接线、没装就降级——不是「二选一后另一半就废了」。
 */
export type ProviderName = 'lunar-js' | 'tyme4ts' | 'solar-only'

/** 一个分支的探测结论。 */
export interface ProviderStatus {
  /** 分支名。 */
  readonly name: ProviderName
  /** 能不能用（探测通过）。 */
  readonly ready: boolean
  /**
   * 不可用原因码。
   * - `not-installed`：包不在，正常降级；
   * - `api-mismatch`：包在但接口对不上（版本漂了）；
   * - `skeleton`：本仓未确认其取值链，**刻意不接**（不凭猜调用）；
   * - `threw`：探测时抛错。
   */
  readonly reason?: 'not-installed' | 'api-mismatch' | 'skeleton' | 'threw'
  /** 一句中文说明（可直接进日志与面板）。 */
  readonly detail: string
}

/* ------------------------------------------------------------------ *
 * 日期事实
 * ------------------------------------------------------------------ */

/** 农历快照。**数值与中文名分开给**：面板要数字（算节日），对话要中文（说话）。 */
export interface LunarSnapshot {
  /** 干支年，如「丙午」。分支不给时为空串。 */
  readonly yearGanZhi: string
  /** 生肖，如「马」。分支不给时为空串。 */
  readonly shengXiao: string
  /** 农历月，1–12（闰月仍是本月数，闰不闰看 `leap`）。 */
  readonly month: number
  /** 农历日，1–30。 */
  readonly day: number
  /** 月的中文名，如「九」。 */
  readonly monthName: string
  /** 日的中文名，如「廿三」。 */
  readonly dayName: string
  /** 是否闰月。 */
  readonly leap: boolean
}

/** 一个节气。 */
export interface JieQiView {
  /** 节气名，如「立冬」。 */
  readonly name: string
  /** 节气所在日的自然日键。 */
  readonly dayKey: string
  /** 距今天几天（`0` = 今天）。 */
  readonly daysAway: number
}

/** 一个「日子事件」（节日或节气），供主动话由与面板使用。 */
export interface LiveEvent {
  /** 种类。 */
  readonly kind: 'festival' | 'lunar-festival' | 'jieqi'
  /** 名字。 */
  readonly name: string
  /** 自然日键。 */
  readonly dayKey: string
  /** 距今天几天（`0` = 今天）。 */
  readonly daysAway: number
}

/** 某一天的全部日期事实。 */
export interface DateFacts {
  /** 自然日键 `YYYY-MM-DD`。 */
  readonly dayKey: string
  /** 公历年。 */
  readonly year: number
  /** 公历月 1–12。 */
  readonly month: number
  /** 公历日 1–31。 */
  readonly day: number
  /** 星期，0 = 周日。 */
  readonly weekday: number
  /** 星期中文名。 */
  readonly weekdayName: string
  /** 一年中的第几天（1–366）。 */
  readonly dayOfYear: number
  /** 是否闰年。 */
  readonly leapYear: boolean
  /** 农历快照；没有农历分支时为 `null`（**不猜**）。 */
  readonly lunar: LunarSnapshot | null
  /** 当天节气名；不是节气日时为 `null`。 */
  readonly jieQi: string | null
  /** 下一个节气（含今天之外的最近一个）；无法计算时为 `null`。 */
  readonly nextJieQi: JieQiView | null
  /** 当天的公历节日（元旦、国庆这类固定日期）。 */
  readonly solarFestivals: readonly string[]
  /** 当天的农历节日（春节、中秋这类要算农历的）；没有农历分支时为空。 */
  readonly lunarFestivals: readonly string[]
  /**
   * 当天的节日名，两个来源的**合并视图**（去重后按字典序）。
   *
   * 合并视图是给「她说话」用的；要区分来源（主动话由、面板分组）请读上面两个字段——
   * 从合并视图反推来源是不可能的，这也是它必须拆成三个字段的原因。
   */
  readonly festivals: readonly string[]
  /** 这份事实来自哪条分支。 */
  readonly provider: ProviderName
  /** 农历分支是否在位（`lunar === null` 未必是异常，可能只是没装包）。 */
  readonly lunarReady: boolean
}

/* ------------------------------------------------------------------ *
 * 对拍
 * ------------------------------------------------------------------ */

/** 一处对拍差异。 */
export interface CrosscheckMismatch {
  /** 自然日键。 */
  readonly dayKey: string
  /** 比的是哪个字段（`lunar.day` / `jieQi` 之类）。 */
  readonly field: string
  /** 两条分支各自给的答案（已转成文本，便于日志直接读）。 */
  readonly a: string
  /** 另一条分支给的答案。 */
  readonly b: string
}

/** 对拍结论。 */
export interface CrosscheckReport {
  /** 参与对拍的分支（少于两条时说明「无可对拍」）。 */
  readonly providers: readonly ProviderName[]
  /** 比了几天。 */
  readonly days: number
  /** 比了几个字段。 */
  readonly fields: number
  /** 差异。 */
  readonly mismatches: readonly CrosscheckMismatch[]
  /** 一句话结论。 */
  readonly summary: string
}

/* ------------------------------------------------------------------ *
 * 配置与统计
 * ------------------------------------------------------------------ */

/** 选路策略。`auto` = 按「默认最稳」的顺序挑第一个可用的农历分支。 */
export type ProviderChoice = 'auto' | 'lunar-js' | 'tyme4ts' | 'solar-only'

/** 统计快照（只在内存）。 */
export interface LiveStats {
  /** `facts()` / `of()` 调用次数。 */
  readonly calls: number
  /** 命中了缓存的次数。 */
  readonly cacheHits: number
  /** 缓存里现在有几天的数据。 */
  readonly cachedDays: number
  /** 各分支的探测结论。 */
  readonly providers: readonly ProviderStatus[]
  /** 当前生效分支。 */
  readonly provider: ProviderName
  /** 对拍次数。 */
  readonly crosschecks: number
  /** 累计对拍差异条数。 */
  readonly mismatches: number
  /** 重新探测次数。 */
  readonly refreshes: number
  /** 内部错误次数（已捕获）。 */
  readonly errors: number
}

/** 不可用原因。只有「配置关掉」才算真的不可用。 */
export type LiveUnavailableReason = 'disabled'

/** 日期事实服务。 */
export interface LiveService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: LiveUnavailableReason
  /** 当前生效分支。 */
  readonly provider: ProviderName
  /** 农历分支是否在位（与 `available` 分开，纪律 83）。 */
  readonly lunarReady: boolean

  /**
   * 某时刻所在日的全部事实。
   * @param at 毫秒时间戳，省略用系统时间。
   */
  facts(at?: number): DateFacts

  /**
   * 任意一天的事实（`YYYY-MM-DD`）。名字非法时返回**今天**的事实并标 `provider` 不变。
   * @param dayKey 自然日键。
   */
  of(dayKey: string): DateFacts

  /**
   * 一行注入文本，给**易变段**用（手册 §8.5：日期绝不进冻结前缀）。
   * @param at 毫秒时间戳，省略用系统时间。
   */
  text(at?: number): string

  /**
   * 未来若干天的事件（节日与节气）。
   * @param days 往后看几天，默认 7，上限 60。
   * @param at 毫秒时间戳，省略用系统时间。
   */
  upcoming(days?: number, at?: number): readonly LiveEvent[]

  /**
   * 对拍：把在位的分支逐日比一遍。
   * @param days 比几天，默认 7，上限 60。
   * @param at 起点时刻。
   */
  crosscheck(days?: number, at?: number): CrosscheckReport

  /** 重新探测分支（装完包不必重启）。 */
  refresh(): readonly ProviderStatus[]

  /** 统计快照。 */
  stats(): LiveStats
}

/* ------------------------------------------------------------------ *
 * 分支契约（同一接口，每分支一个文件，§14.2）
 * ------------------------------------------------------------------ */

/**
 * 一个历法分支。
 *
 * **接口唯一**：三条分支只实现它，不许各自定义返回形状（§14.2「接口唯一」）。
 * `solar-only` 分支对农历相关方法返回 `null` / 空串——这是「我没有」，不是「我坏了」。
 */
export interface CalendarProvider {
  /** 分支名。 */
  readonly name: ProviderName
  /**
   * 取农历快照。
   * @param dayKey 自然日键。
   * @returns 取不到时 `null`（绝不返回编的值）。
   */
  lunarOf(dayKey: string): LunarSnapshot | null
  /**
   * 取当天节气名。
   * @param dayKey 自然日键。
   * @returns 不是节气日或分支不支持时为空串。
   */
  jieQiOf(dayKey: string): string
}

/* ------------------------------------------------------------------ *
 * 相邻服务的结构对位（§18.5：不 import 源码）
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

/** O-003 时钟的结构对位子集（只用到自然日键与日历字段）。 */
export interface ClockLike {
  /** 自然日键 `YYYY-MM-DD`（生效时区）。 */
  dayKey(epoch?: number): string
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

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}
