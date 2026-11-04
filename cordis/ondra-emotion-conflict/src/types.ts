/**
 * O-030 `ondra-emotion-conflict` 的对外契约。
 *
 * 定位：**吵架这件事只归一处管。**
 *
 * 手册 §3.2 原话：「冲突事件（否定 / 指责 / 冷暴力）→ tension +0.15、mood 压低位；
 * 锁定期间不撒娇、不主动、回复变短；解除条件 = 致歉或连续 2 次正向信号且 mood 回升过阈。」
 *
 * ## 三个必须先说清的问题
 *
 * 1. **「锁」与「情绪数值」是两件事，本插件只拥有前者。**
 *    锁（锁着没有、从什么时候起、正向信号几次）是本插件的状态，落盘；
 *    `tension +0.15`、`mood 压到低位`、`tension 压回 ≤0.25` 是**情绪数值**，
 *    属 O-026，本插件只产出 `Δ` 建议（器官 ABI C1：只提议，不落笔）。
 *    所以下面每个带数值的动作都带 `applied: false` 这个**字面量**字段——
 *    接口层面就写不出「我已经改好了」。
 * 2. **两个进锁入口，缺一不可。**
 *    ①事件入口 `enter(reason)`：上游认出「否定 / 指责 / 冷暴力」。
 *    ②阈值入口：`tension > 0.5`（§3.2 六态里「炸毛」的判据）或
 *    `stress > 0.85`（旧项目语域择档口径，见 §2.2 引文）。
 *    只做①会出现「她已经炸毛了，但因为没人说出『你错了』这三个字，行为一点没变」。
 * 3. **阈值入口不落盘。**
 *    阈值是**派生**的（每次读当时的张力算一次），锁是**存**的。
 *    两个混在一起，就会出现「张力自己降下去了，锁还挂着」这种解不开的死结。
 *    故 `status()` 同时给 `stored`（存的）与 `threshold`（算的），
 *    `locked` 是二者的**或**——而这一处「或」只写在一个函数里（`rules.ts`）。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。全仓唯一归属。 */
export const CONFLICT_SERVICE_KEY = 'ondra-emotion-conflict'

/* ------------------------------------------------------------------ *
 * 手册里有的数
 * ------------------------------------------------------------------ */

/** 一次冲突事件给张力加的增量（§3.2 冲突锁定）。 */
export const TENSION_ADD = 0.15

/**
 * 「mood 压低位」的那个「低位」（上界，不是减量）。
 *
 * 手册只说「压低位」，没给数。取 `0.35` 不是拍的：§3.2 的六态映射里
 * 「蔫」的判据正是 `mood < 0.35`——**「压到低位」= 压进「蔫」这一档**。
 * 用绝对值上界而不是减量，还有个副产品：同一次吵架里被判定十次，
 * mood 也只被压到 0.35 一次，不会一路减到 0。
 */
export const MOOD_CEILING = 0.35

/** 进锁阈值之一：张力高于「炸毛」线（§3.2 六态：`tension > 0.5`）。 */
export const LOCK_TENSION = 0.5

/**
 * 进锁阈值之二：应激高于 `0.85`（手册 §2.2 引用的旧项目语域择档口径
 * 「`stress > 0.85 && mood < 0.4`」）。`stress` 是 `cortisol / 100`。
 *
 * **这一条是反推的**（手册正文没有把它写成冲突锁的触发条件），已登记待裁决①。
 */
export const LOCK_STRESS = 0.85

/** 解锁：心情要回到「平静」档下界（§3.2 六态：平静 `0.45–0.55`）。 */
export const MOOD_RISE = 0.45

/** 解锁：连续正向信号次数（§3.2「连续 2 次正向信号」）。 */
export const POSITIVE_STREAK = 2

/**
 * 解锁后张力上限（**任务书口径，手册未给数值**）。
 *
 * 它存在的理由不只是「消气」：`LOCK_TENSION = 0.5` 是派生进锁条件，
 * 解锁后若张力还在 0.5 以上，「锁一解开、阈值立刻把它扣回去」——
 * 表现为「哄了半天，她下一句又冷了」，而代码里没有任何错。
 * `0.25` 低于 0.5 且留了一半余量，正好把这条回路切断。
 */
export const RELEASE_TENSION_MAX = 0.25

/* ------------------------------------------------------------------ *
 * 锁、读数、状态
 * ------------------------------------------------------------------ */

/** 进锁原因。前三个是 §3.2 的三类冲突事件，第四个是阈值触发。 */
export type ConflictReason = 'negation' | 'blame' | 'coldness' | 'threshold'

/** 进锁原因的中文名。**只给面板与日志**，不进提示词。 */
export const REASON_ZH: Readonly<Record<ConflictReason, string>> = Object.freeze({
  negation: '否定',
  blame: '指责',
  coldness: '冷暴力',
  threshold: '张力越线',
})

/** 信号种类。 */
export type SignalKind =
  /** 致歉（对不起 / 抱歉 / 我错了）：**立即解锁**（§3.2）。 */
  | 'apology'
  /** 正向信号（夸、服软、撒娇被接住）：累计到 2 次且心情回升才解锁。 */
  | 'positive'
  /** 负向信号（再怼一句）：正向计数归零。 */
  | 'negative'

/** 解锁途径。手册只给两条，**不提供「手动解锁」**（那是第三套口径）。 */
export type ReleaseBy = 'apology' | 'positives'

/** 锁的存储形态。 */
export interface ConflictLock {
  /** 是否锁着（**存储里**的锁，不含阈值派生）。 */
  readonly locked: boolean
  /** 进锁原因；没锁时为 `undefined`。 */
  readonly reason: ConflictReason | undefined
  /** 进锁时刻；没锁时为 0。 */
  readonly since: number
  /** 进锁那一刻的心情（用于判「回升」）。 */
  readonly moodAtLock: number | undefined
  /** 进锁那一刻的张力（用于解释）。 */
  readonly tensionAtLock: number | undefined
  /** 连续正向信号计数。 */
  readonly positiveStreak: number
  /** 历史解锁次数（跨会话累计，给面板用）。 */
  readonly releases: number
}

/** 从情绪服务读到的那三个数。 */
export interface ConflictReading {
  /** 张力 0–1。 */
  readonly tension: number
  /** 心情 0–1。 */
  readonly mood: number
  /** 应激 0–1（= `cortisol / 100`）。 */
  readonly stress: number
  /** 读数来源：情绪服务 / 出厂基线。 */
  readonly source: 'emotion' | 'baseline'
}

/** 对外状态快照。**所有判定只产这一个对象**（解释与执行共用，§第 31 轮纪律 #47）。 */
export interface ConflictStatus {
  /** 判定时刻。 */
  readonly at: number
  /** 对外生效的锁 = `stored || threshold`。 */
  readonly locked: boolean
  /** 存储里的锁。 */
  readonly stored: boolean
  /** 阈值派生出来的锁。 */
  readonly threshold: boolean
  /** 进锁原因（阈值触发时为 `threshold`）。 */
  readonly reason: ConflictReason | undefined
  /** 进锁时刻（阈值触发时为 0，因为它没有「起点」）。 */
  readonly since: number
  /** 连续正向信号。 */
  readonly positiveStreak: number
  /** 情绪读数。 */
  readonly reading: ConflictReading
  /** 张力是否越过炸毛线。 */
  readonly tensionTriggered: boolean
  /** 应激是否越过 0.85。 */
  readonly stressTriggered: boolean
  /** 心情闸：过 / 没过 / 读不到（读不到按「过」处理，见 README）。 */
  readonly moodGate: 'pass' | 'low' | 'unknown'
  /** 现在能不能解锁（只由 `positives` 这条路算；致歉恒可解）。 */
  readonly canRelease: boolean
  /** 一句话说明，直接可上面板。 */
  readonly note: string
}

/** 进锁结果。 */
export interface ConflictEntry {
  /** 判定后的状态。 */
  readonly status: ConflictStatus
  /** `entered` 真进锁；`already` 本来就锁着（**不重复加张力**）；`disabled` 配置关掉。 */
  readonly outcome: 'entered' | 'already' | 'disabled'
  /** 本次按哪个原因进锁。 */
  readonly reason: ConflictReason
  /** 是否已落笔。**字面量 `false`**：C1，本插件不改情绪。 */
  readonly applied: false
  /** 落笔方式：调用方一次 `setAxis('tension', …)` 后夹到上限。 */
  readonly applyPath: 'set-axis'
  /** 建议的张力增量（`already` / `disabled` 时为 0）。 */
  readonly tensionAdd: number
  /** 建议的心情上限（`already` / `disabled` 时为 1，即不压）。 */
  readonly moodCeiling: number
}

/** 解锁结果。 */
export interface ConflictRelease {
  /** 解锁后的状态。 */
  readonly status: ConflictStatus
  /** `released` 真解锁；`not-locked` 本来没锁；`refused` 条件不足；`disabled` 关掉了。 */
  readonly outcome: 'released' | 'not-locked' | 'refused' | 'disabled'
  /** 走的哪条路。 */
  readonly by: ReleaseBy
  /** 是否已落笔。**字面量 `false`**。 */
  readonly applied: false
  /** 落笔方式。 */
  readonly applyPath: 'set-axis'
  /** 建议的张力上限（`setAxis('tension', min(现值, 0.25))`）。 */
  readonly tensionMax: number
  /** 是否建议调用方顺手调 O-026 的 `comfort()`（致歉时 true，它自带 −0.08 的「嘴硬」）。 */
  readonly comfortSuggested: boolean
  /** 被拒的原因。 */
  readonly refusedBecause?: 'mood-not-risen' | 'streak-short'
}

/** 信号处理结果。 */
export interface ConflictSignalResult {
  /** 处理后的状态。 */
  readonly status: ConflictStatus
  /** 收到的是哪种信号。 */
  readonly kind: SignalKind
  /** 处理后的连续正向计数。 */
  readonly streak: number
  /** 若这次信号触发了自动解锁，这里带出解锁结果。 */
  readonly release?: ConflictRelease
}

/** 行为后果（给 O-031 / O-038 落成具体参数，本插件不给数字）。 */
export interface ConflictBehavior {
  /** 当前是否生效（= `status().locked`）。 */
  readonly locked: boolean
  /** 还允许撒娇吗。 */
  readonly coquetry: boolean
  /** 还允许主动找他吗。 */
  readonly proactive: boolean
  /** 回复长度取向。具体系数归 O-038 / O-040。 */
  readonly brevity: 'normal' | 'short'
}

/* ------------------------------------------------------------------ *
 * 提示词片段（器官 ABI §8.1，形状与 O-029 逐字对位）
 * ------------------------------------------------------------------ */

/**
 * 一条提示词片段。
 *
 * 与 O-029 `ondra-emotion-stress` 的 `PromptFragment` **结构逐字一致**
 * （§18.5 不许同轮互相 import，故两处各留一份镜像；改一处必须同改两处）。
 * O-036（段装箱）按 `order / ttlMinutes / confidence / text / kind` 取。
 */
export interface PromptFragment {
  /** 排序键，越小越靠前。疤痕恒为 `-1e4`；器官不得低于 `-1000`。 */
  readonly order: number
  /** 存活时长（分钟）。 */
  readonly ttlMinutes: number
  /** 置信度 0–1。 */
  readonly confidence: number
  /** 片段正文。**不含任何数字**（内感受铁律 §4.3）。 */
  readonly text: string
  /** 片段种类。 */
  readonly kind: 'stress' | 'conflict'
}

/** 排序键的硬下限：`-1e4` 是疤痕专用。 */
export const MIN_FRAGMENT_ORDER = -1000

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/** 不可用原因。**只有配置关掉**才算不可用。 */
export type ConflictUnavailableReason = 'disabled'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface ConflictCounters {
  /** 进锁次数（`entered`）。 */
  readonly enters: number
  /** 重复进锁被挡下的次数（`already`）。 */
  readonly duplicates: number
  /** 解锁次数。 */
  readonly releases: number
  /** 因心情没回升被拒的次数。 */
  readonly refusedByMood: number
  /** 因正向信号不足被拒的次数。 */
  readonly refusedByStreak: number
  /** 收到致歉的次数。 */
  readonly apologies: number
  /** 产出行为指令的次数。 */
  readonly directives: number
}

/** 统计快照。 */
export interface ConflictStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ConflictUnavailableReason
  /** 存储后端标识（无存储时为 `none`）。 */
  readonly storeProvider: string
  /** 当前锁状态（含阈值派生）。 */
  readonly locked: boolean
  /** 存储里的锁。 */
  readonly stored: boolean
  /** 存储的锁从何时起（0 = 无）。 */
  readonly since: number
  /** 历史解锁次数。 */
  readonly releases: number
  /** 累计计数。 */
  readonly counters: ConflictCounters
  /** 情绪读数来源。 */
  readonly readingSource: 'emotion' | 'baseline'
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 冲突锁服务。 */
export interface ConflictService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ConflictUnavailableReason

  /**
   * 一次冲突事件进锁。
   * @param reason 原因。传 `threshold` 时按阈值触发记。
   * @param at 时刻。
   */
  enter(reason: ConflictReason, at?: number): ConflictEntry

  /**
   * 一条关系信号。
   * @param kind 信号种类。
   * @param at 时刻。
   */
  signal(kind: SignalKind, at?: number): ConflictSignalResult

  /**
   * 当前状态（纯读：**不写库、不改状态**）。
   * @param at 时刻。
   */
  status(at?: number): ConflictStatus

  /**
   * 显式解锁（只有手册给出的两条路）。
   * @param by 途径。
   * @param at 时刻。
   */
  release(by: ReleaseBy, at?: number): ConflictRelease

  /**
   * 行为后果（给表达层）。
   * @param at 时刻。
   */
  behavior(at?: number): ConflictBehavior

  /**
   * 锁着时的行为指令（器官 ABI 片段）。
   * @param at 时刻。
   * @returns 没锁时为 `undefined`（不返回空片段）。
   */
  directive(at?: number): PromptFragment | undefined

  /**
   * 一句话解释（面板用，允许出现数字）。
   * @param at 时刻。
   */
  explain(at?: number): string

  /** 统计快照。 */
  stats(): ConflictStats
}

/* ------------------------------------------------------------------ *
 * 宿主相邻服务的结构对位（§18.5：不 import 源码）
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-001 身份服务的结构对位子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layer?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly options?: readonly string[]
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/**
 * O-026 `ondra-emotion-core` 的结构对位子集。
 *
 * **只读三个数，且刻意没有 `comfort` / `setAxis`**：
 * 致歉该降多少（`−0.08` 保留嘴硬）是 O-026 的口径，
 * 由**调用方**按 `comfortSuggested` 去调；本插件自己调就是第二条写情绪的路径。
 */
export interface EmotionLike {
  state(at?: number): {
    readonly axes: Readonly<Record<string, number>>
    readonly hormones: Readonly<Record<string, number>>
  }
}

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位（只够建一张单行表）
 * ------------------------------------------------------------------ */

/** 列类型。 */
export type ColumnTypeLike = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'

/** 列声明。 */
export interface ColumnSpecLike {
  readonly name: string
  readonly type: ColumnTypeLike
  readonly notNull?: boolean
  readonly primaryKey?: boolean
  readonly default?: string
}

/** 索引声明。 */
export interface IndexSpecLike {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique?: boolean
}

/** 表声明。 */
export interface TableSpecLike {
  readonly name: string
  readonly columns: readonly ColumnSpecLike[]
  readonly indexes?: readonly IndexSpecLike[]
  readonly strict?: boolean
}

/** 一行数据。 */
export type RowLike = Record<string, unknown>

/** 过滤算子。 */
export type FilterOpLike = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'is-null' | 'not-null'

/** 过滤条件。 */
export interface FilterLike {
  readonly column: string
  readonly op: FilterOpLike
  readonly value?: unknown
}

/** 查询条件。 */
export interface SelectQueryLike {
  readonly where?: readonly FilterLike[]
  readonly orderBy?: readonly { readonly column: string; readonly direction?: 'asc' | 'desc' }[]
  readonly limit?: number
  readonly offset?: number
}

/** 存储端口的结构对位子集。 */
export interface StoreLike {
  readonly provider: string
  readonly state: string
  readonly caps: {
    readonly sql: boolean
    readonly fts: boolean
    readonly persist: boolean
    readonly transaction: boolean
  }
  ensureTable(spec: TableSpecLike): {
    readonly table: string
    readonly created: boolean
    readonly issues: readonly { readonly code: string; readonly detail: string }[]
  }
  tableExists(table: string): boolean
  insert(table: string, row: RowLike): void
  upsert(table: string, row: RowLike): void
  select(table: string, query?: SelectQueryLike): RowLike[]
  count(table: string, where?: readonly FilterLike[]): number
  update(table: string, key: RowLike, patch: RowLike): number
  delete(table: string, key: RowLike): number
}
