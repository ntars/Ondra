/**
 * O-049 `ondra-onthisday` 的对外契约。
 *
 * 定位：**「那年今日」的唯一判定真源**——哪条旧记忆算「今天该被想起来」，
 * 只在这里决定一次。手册 §2.6 八块装配的第 ④ 块（`【那年今日】`）就是本插件的产出。
 *
 * ## 五件必须先说清的事
 *
 * 1. **本插件不拼字。** 「3 年前记下」「提过 2 次」的措辞归 O-036
 *    （`ondra-prompt-inject` 的 `formatLine()`），「记不太清了」的话术归 O-013
 *    （`ondra-memory-decay` 的 `clarityOfRecord()`）。本插件只交结构化原料。
 *    两处各拼一次的下场不是报错，是**同一块注入里出现了两种排版**——
 *    用户只会觉得「这里读起来怪」，没人会去查是哪一行的锅。
 *
 * 2. **手册三档锚点原样保留，但一条记忆只归一个档。**
 *    `anniversary`（往年同月同日）→ `year-day`（正好 365 天）→ `month-day`（差 30/31 天），
 *    优先级即这个顺序。允许重叠会让同一条记忆在同一天被提两次，
 *    而用户看到的是「她怎么又说了一遍」。
 *
 * 3. **「严格同月同日」与「差 365 天」在数学上基本重合，但不完全。**
 *    同月同日必然差 365 或 366 天（闰年）；反过来差 365 天却不同月同日的，
 *    只剩「2 月 29 日 → 2 月 28 日」这一种（闰日折叠）。
 *    所以 `year-day` 不是重复档，它是**闰日与跨年错位的兜底**：
 *    少了它，2 月 29 日写下的记忆在平年就整年不见。
 *
 * 4. **归档条目参与，封存条目不参与。**
 *    手册 §2.4「只忘不删」说归档（`archived=1`）只是「不主动注入」，
 *    而「那年今日」恰恰是「忽然想起」的场景——归档条目正是最该被想起来的那些。
 *    封存（`sealed`）明确写着「不主动注入、不参与回忆」，故一律跳过。
 *    这一条与 O-036 的内联实现相反（它同时排除两者），已在 README 登记。
 *
 * 5. **零定时器。** 本插件不在 21:05 自己开口（那是 ⑧ 固定回忆，归 O-018）。
 *    它只在被问「今天有什么旧事」时回答，答案按自然日冻结一次。
 */

/** 本插件注册的服务键（连字符，非 `ondra:onthisday`）。全仓唯一归属。 */
export const ONTHISDAY_SERVICE_KEY = 'ondra-onthisday'

/** 命名硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/* ------------------------------------------------------------------ *
 * 一、三档锚点
 * ------------------------------------------------------------------ */

/**
 * 三档锚点（手册 §2.6 ④「≥1年 / 整365天 / 整30天」）。
 *
 * 数组顺序即优先级，也即排序的第一关键字。
 */
export const SHELVES = ['anniversary', 'year-day', 'month-day'] as const

/** 锚点档位。 */
export type Shelf = (typeof SHELVES)[number]

/** 档位中文名。只用于日志与面板，**不进注入行**（行里只有类别，没有档位）。 */
export const SHELF_ZH: Readonly<Record<Shelf, string>> = Object.freeze({
  anniversary: '周年',
  'year-day': '整年',
  'month-day': '整月',
})

/** 档位优先级（越小越先被选中）。 */
export const SHELF_ORDER: Readonly<Record<Shelf, number>> = Object.freeze({
  anniversary: 0,
  'year-day': 1,
  'month-day': 2,
})

/* ------------------------------------------------------------------ *
 * 二、条数与扫描边界
 * ------------------------------------------------------------------ */

/** 条数上限的绝对上界。手册逐字「≤3」，允许放宽到 10 但不许无限。 */
export const CAP_MAX = 10

/** 单页请求的行数上界。真实页大小由存储的 `maxSelectRows` 决定，见 `scan()`。 */
export const PAGE_SIZE_MAX = 500

/** 扫描行数上界。超过它就算「扫不完」，如实上报 `truncated`。 */
export const SCAN_LIMIT_MAX = 50_000

/**
 * 「整年」档的差值：**正好 365 天**（手册逐字「整 365 天」）。
 *
 * 刻意**不**放宽到 366。放下 366 看上去能兜住闰年，实际兜不住任何新东西：
 * 差 366 天而不同月同日的组合，只可能来自「2 月 29 日写下、次年 3 月 1 日看到」，
 * 而那一天已经被闰日折叠（2 月 28 日）或周年档（闰年 2 月 29 日）覆盖。
 * 多放一个 366，唯一的效果是让那条记忆在 2 月 28 日与 3 月 1 日各出现一次。
 */
export const YEAR_DAY = 365

/**
 * 「整 30 天」两档的容差（天）。
 *
 * 这里反过来**要两个值**：月份有 28/30/31 三种长度，只认 30 会让
 * 「10 月 2 日写的事」在 11 月 2 日（31 天）永远不进「整月」档，
 * 于是 31 天的月份整档静默失效。多认一天不制造重复——
 * 30 天与 31 天落在**不同的两天**上，不是同一天说两遍。
 */
export const MONTH_DAY_SPAN = [30, 31] as const

/** 闰日（2 月 29 日）折叠的目标月日。 */
export const LEAP_FOLD_TARGET = [2, 28] as const

/**
 * 图谱去重的关联门槛。取 `same_topic` 的初值下沿 0.72（手册 §9.7）。
 *
 * 用途只有一个：两条候选互为正相关的「同主题」时，只留显著度高的那条。
 * 记忆条目常出现「同一件事写了三遍」，三条一起注入会让用户觉得她啰嗦。
 * 达到 0.72 说明图谱已经认定它们同主题，这个判断比字面比对可靠。
 */
export const GRAPH_DEDUPE_WEIGHT = 0.72

/**
 * 图谱去重只看前几条候选。
 *
 * 每检查一条候选就要问一次图谱「它和我已经选中的几条有多像」，
 * 候选上百条时会变成上百次边查询。而实际只会取前 3 条，
 * 后面的候选在有更靠前者时本来就选不上。
 */
export const GRAPH_DEDUPE_WINDOW = 8

/** 正文归一化后的比对长度（去重用的字面指纹）。 */
export const TEXT_KEY_CHARS = 40

/* ------------------------------------------------------------------ *
 * 三、状态文件
 * ------------------------------------------------------------------ */

/** 状态文件名（落在 `user` 区）。只存 id 与判定结果，**不存记忆正文**。 */
export const STATE_FILE = 'onthisday.json'

/** 状态文件版本。读到不认识的版本按「今天还没算过」处理，不猜迁移。 */
export const STATE_VERSION = 1

/* ------------------------------------------------------------------ *
 * 四、视图
 * ------------------------------------------------------------------ */

/**
 * 一条「那年今日」。
 *
 * 字段刻意对齐 O-036 `formatLine()` 的入参（`category` / `text` / `createdAt` /
 * `timesSaid` / `revisions` / `clarity`），这样消费方不需要再做一次映射。
 */
export interface OnThisDayItem {
  /** 记忆 id。 */
  readonly memoryId: string
  /** 命中哪一档。 */
  readonly shelf: Shelf
  /** 11 类寿命类别（原样透传，中文名由渲染方查表）。 */
  readonly category: string
  /** 正文（原样透传，不截断——截断会让「那年今日」读起来像残缺的）。 */
  readonly text: string
  /** 写入时刻。 */
  readonly createdAt: number
  /** 被提起次数（O-010 口径：写入时为 0）。 */
  readonly timesSaid: number
  /** 订正次数。 */
  readonly revisions: number
  /** 显著度 0–100。 */
  readonly salience: number
  /** 隔了几个自然日。 */
  readonly daysAgo: number
  /** 隔了几年（`month-day` 档为 0）。 */
  readonly yearsAgo: number
  /** 是否走了闰日折叠（2 月 29 日 → 2 月 28 日）。 */
  readonly leapFolded: boolean
  /** 当前强度 R（0–1）；取不到时为 `null`。 */
  readonly retention: number | null
  /** 清晰度档位（来自 O-013）；取不到时为 `null`。 */
  readonly clarity: ClarityViewLike | null
  /** 这条记忆是否已归档（面板要能说清「这是从沉底里捞回来的」）。 */
  readonly archived: boolean
}

/**
 * 一次查询的结果。
 *
 * `dropped` 与 `truncated` **必须分开**：
 * 前者是「今天有 6 条，只给了 3 条」（该调上限），
 * 后者是「库里太多，没扫完」（该调扫描上限）。
 * 合成一个数字，看报告的人一定按错的方向调。
 */
export interface OnThisDayView {
  /** 自然日键（`YYYY-MM-DD`）。 */
  readonly dayKey: string
  /** 命中的条目，已按「档位 → 年数 → 显著度 → id」排好。 */
  readonly items: readonly OnThisDayItem[]
  /** 超过条数上限而没给的条数。 */
  readonly dropped: number
  /** 实际扫过的记忆条数。 */
  readonly scanned: number
  /** 是否因为扫描上限而没扫完（`true` 时 `dropped` 可能偏小）。 */
  readonly truncated: boolean
  /** 是否来自当天冻结点（`false` 表示这一次是新算的）。 */
  readonly frozen: boolean
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: OnThisDayReason
  /** 不算致命但该让人看见的问题（中文短句，直接显示）。 */
  readonly issues: readonly string[]
}

/** 一次「取走」的结果。 */
export interface OnThisDayTake extends OnThisDayView {
  /** 本次真正记了账的记忆 id（已带出过的不会再记）。 */
  readonly accounted: readonly string[]
}

/** 单条的解释（面板与审计用）。 */
export interface OnThisDayWhy {
  /** 记忆 id。 */
  readonly memoryId: string
  /** 命中哪一档。 */
  readonly shelf: Shelf
  /** 一句话说明判定依据。 */
  readonly detail: string
  /** 日历差值。 */
  readonly daysAgo: number
  /** 是否闰日折叠。 */
  readonly leapFolded: boolean
  /** 当前强度 R。 */
  readonly retention: number | null
  /** 是否已被记过账。 */
  readonly accounted: boolean
}

/** 不可用原因。 */
export type OnThisDayReason =
  /** 开关关掉了。 */
  | 'disabled'
  /** 记忆内核没装载。 */
  | 'no-memory'
  /** 记忆内核装载了但不可用（存储端口缺席、建表失败等）。 */
  | 'memory-unavailable'
  /** 时间服务返回的自然日键不成形状。 */
  | 'bad-day-key'

/** 清晰度视图（O-013 的形状，结构对位）。 */
export interface ClarityViewLike {
  /** 档位 `clear | faded | blur`。 */
  readonly band: string
  /** 拼在行尾的话术（`clear` 是空串）。 */
  readonly phrase: string
  /** 当时的强度 0–1。 */
  readonly strength: number
}

/** 运行计数（**只在内存**，进程重启归零）。 */
export interface OnThisDayStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 查询次数（`today` + `take`）。 */
  readonly lookups: number
  /** 真正新算出结果的次数（冻结点命中不算）。 */
  readonly computes: number
  /** `take()` 成功记账的次数。 */
  readonly takes: number
  /** 累计记过账的记忆条数。 */
  readonly accounted: number
  /** 最近一次扫描的行数。 */
  readonly lastScanned: number
  /** 最近一次计算耗时（毫秒）。 */
  readonly lastComputeMs: number
  /** 累计「扫不完」的次数。 */
  readonly truncatedRuns: number
  /** 累计扫描失败次数（失败一律降级为空，不抛）。 */
  readonly failures: number
}

/** 「那年今日」服务。 */
export interface OnThisDayService {
  /** 能不能工作（开关 + 记忆内核 + 自然日可解）。 */
  readonly available: boolean
  /** 不能工作的原因。 */
  readonly reason?: OnThisDayReason
  /** 时间服务是否在位（`false` 时退回本机时区，仍然可用）。 */
  readonly clockReady: boolean
  /** 记忆内核是否在位且可用。 */
  readonly memoryReady: boolean
  /** 状态是否真的落盘。 `false` 表示纯内存（重启后当天会重算、记账会重复一次）。 */
  readonly stored: boolean

  /**
   * 今天的「那年今日」。**不记账**，同一天内恒定。
   * @param at 时刻；省略取现在。
   */
  today(at?: number): OnThisDayView

  /**
   * 取走今天的「那年今日」并对尚未记过账的条目记账
   * （`markSeen` + `reinforce('mention')`）。
   *
   * 同一天重复调用返回同样的条目、`accounted` 为空数组——
   * 「一天只记一次账」由状态文件保证，不是靠调用方自觉。
   * @param at 时刻；省略取现在。
   */
  take(at?: number): OnThisDayTake

  /**
   * 解释某条为什么被选中。不在今天的列表里则返回 `undefined`。
   * @param memoryId 记忆 id。
   * @param at 时刻；省略取现在。
   */
  explain(memoryId: string, at?: number): OnThisDayWhy | undefined

  /**
   * 丢掉今天的冻结点与记账（下次 `today()` 会重算）。
   *
   * 只给面板的「重新算一次」用。**不会**撤销已经发出去的注入。
   * @param at 时刻；省略取现在。
   */
  reset(at?: number): void

  /** 运行计数。 */
  stats(): OnThisDayStats
}

/* ------------------------------------------------------------------ *
 * 五、结构对位（不 import 其他插件源码，§15.5）
 * ------------------------------------------------------------------ */

/** 日历切片（与 O-003 `CalendarParts` 对位，只取本插件用的三个字段）。 */
export interface CalendarPartsLike {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** 时间服务的结构对位子集。 */
export interface ClockLike {
  now(): number
  parts(epoch?: number): CalendarPartsLike
}

/** 记忆条目的结构对位子集（只镜像本插件真正读的字段）。 */
export interface MemoryRecordLike {
  readonly id: string
  readonly category: string
  readonly text: string
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly stabilityHours: number
  readonly salience: number
  readonly timesSaid: number
  readonly revisions: number
  readonly archived: boolean
  readonly sealed: boolean
}

/** 查条件的结构对位子集。 */
export interface FactQueryLike {
  readonly limit?: number
  readonly offset?: number
  readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
}

/** 强度视图的结构对位子集。 */
export interface StrengthViewLike {
  readonly strength: number
}

/** 记忆内核的结构对位子集。 */
export interface MemoryCoreLike {
  readonly available: boolean
  readonly reason?: string
  listFacts(query?: FactQueryLike): readonly MemoryRecordLike[]
  getFact(id: string): MemoryRecordLike | undefined
  strengthOf(record: MemoryRecordLike, at?: number): StrengthViewLike
  markSeen(ids: readonly string[], at?: number): number
  reinforce(id: string, kind: 'mention' | 'hit', at?: number): MemoryRecordLike
}

/** 衰减与清晰度的结构对位子集。 */
export interface DecayLike {
  clarityOfRecord(record: MemoryRecordLike, at?: number): ClarityViewLike
}

/** 图谱的结构对位子集（只用到「有几条候选其实是同一件事」）。 */
export interface GraphLike {
  readonly available: boolean
  relatedness(
    ids: readonly string[],
    seeds: readonly string[],
    options?: { readonly minWeight?: number },
  ): Readonly<Record<string, number>>
}

/** 路径服务的结构对位子集。 */
export interface PathLike {
  fileIn(area: 'user', ...segments: string[]): string
  prepareFile(filePath: string): string
}

/** 日志器的结构对位子集。 */
export interface LogLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** 字段声明（与 O-005 对位）。 */
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

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}
