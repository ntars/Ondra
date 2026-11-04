/**
 * O-013 `ondra-memory-decay` 的对外契约。
 *
 * 定位：**衰减的调度者**，不是衰减公式的第二个持有者。
 *
 * 四件必须先说清的事：
 *
 * 1. **S 只有一个真源，在 O-010。**
 *    本插件**不重算任何寿命**：所有强度都走 `core.strengthOf()`，所有归档都走
 *    `core.archiveDue()`。第二份公式就是第二真源——改一次参数会有一半地方不生效，
 *    而且不报错。
 *
 * 2. **衰减是「闭式函数」，不是「每次扫描乘一次」。**
 *    手册 §9.7 的夜跑第 2 步要求带 `decayed_at` 游标，理由是「否则会重复乘算成
 *    0.5^N」——那条约束针对的是**步进式衰减**（每夜 ×0.5）。
 *    本插件的强度是 `0.5^(已过小时 / S)`，一个关于时间的闭式函数：
 *    扫描一次与扫描一百次，同一个时刻算出来的数**完全一样**。
 *    所以这里**不需要也不应该有** `decayed_at` 游标；加了反而会引入「两次扫描之间
 *    强度跳变」的假象。
 *
 * 3. **SM-2 管「什么时候复习」，不管「衰减多快」。**
 *    手册 §1.7 给 O-013 的增强是「SM-2 间隔复习（按记忆难度排复习，不靠固定半衰期）」。
 *    若把 SM-2 的间隔当成第二条衰减曲线，就会出现「S 说这条还能活 50 小时、
 *    SM-2 说它 3 天后复习」两个互相矛盾的答案。故：**复习排期归本插件，
 *    强度归 O-010**，两者只在「复习成功 → `reinforce('hit')` → S 变长」这一点上相交。
 *
 * 4. **只衰减条目，边归 O-015（裁决⑪）。**
 *    本插件从不读写 `card_links` 之类的图谱边；边的权重衰减是 O-015 的事。
 *
 * 与 O-010 的关系：本文件**不 import** `ondra-memory-core` 的源码（§18.5），
 * 只用「结构对位」的 `MemoryCoreLike` 镜像，且只镜像真正调用的成员。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-decay`）。全仓唯一归属。 */
export const DECAY_SERVICE_KEY = 'ondra-memory-decay'

/**
 * 清晰度三档（手册 §2.6「清晰度三档话术」）。
 *
 * `≥0.7` 正常 / `0.4–0.7` 「，记不太清了」/ `<0.4` 「，只剩个模糊的影子」。
 * 这是**用户可感知的遗忘表达**——手册原话是「越重要的记忆评级下降越慢」，
 * 而「重要」在 O-010 里体现为更长的 S，所以这里只需要按强度分档，不用再判重要性。
 */
export const CLARITY_BANDS = ['clear', 'faded', 'blur'] as const

/** 清晰度档位。 */
export type ClarityBand = (typeof CLARITY_BANDS)[number]

/** 清晰度视图。 */
export interface ClarityView {
  /** 档位。 */
  readonly band: ClarityBand
  /** 拼在记忆行尾的话术（`clear` 时是空串，不是 undefined）。 */
  readonly phrase: string
  /** 当时的强度 0–1。 */
  readonly strength: number
}

/** 一条待复习的记忆。 */
export interface ReviewItem {
  /** 记忆 id。 */
  readonly id: string
  /** 下次该复习的时刻。 */
  readonly dueAt: number
  /** 已经逾期多少小时（0 表示刚好到期）。 */
  readonly overdueHours: number
  /** 当前难度系数（SM-2 的 EF）。 */
  readonly ef: number
  /** 连续成功复习次数。 */
  readonly reps: number
  /** 遗忘次数。 */
  readonly lapses: number
  /** 当前强度 0–1（来自 O-010）。 */
  readonly strength: number
  /** 11 类寿命类别。 */
  readonly category: string
  /** 正文（给复习界面用；不参与任何计算）。 */
  readonly text: string
}

/** 一次复习的结果。 */
export interface ReviewOutcome {
  /** 记忆 id。 */
  readonly id: string
  /** 评分 0–5。 */
  readonly grade: number
  /** 更新后的 EF。 */
  readonly ef: number
  /** 更新后的连续成功次数。 */
  readonly reps: number
  /** 更新后的遗忘次数。 */
  readonly lapses: number
  /** 下一次的间隔（小时）。 */
  readonly intervalHours: number
  /** 下次该复习的时刻。 */
  readonly dueAt: number
  /** 本次是否算「没想起来」（`grade < 3`）。 */
  readonly lapsed: boolean
  /** 是否顺带加固了记忆（只有 `grade ≥ 3` 才会）。 */
  readonly reinforced: boolean
}

/** 一条已经暗下去的记忆。 */
export interface FadedItem {
  /** 记忆 id。 */
  readonly id: string
  /** 当前强度 0–1。 */
  readonly strength: number
  /** 清晰度档位。 */
  readonly band: ClarityBand
  /** 当前 S（小时）。 */
  readonly stabilityHours: number
  /** 距掉到地板还有多少小时（0 表示已到底）。 */
  readonly remainingHours: number
  /** 11 类寿命类别。 */
  readonly category: string
}

/** 一次衰减扫描的报告。 */
export interface DecayReport {
  /** 扫描时刻。 */
  readonly at: number
  /** 看了多少条活跃记忆。 */
  readonly scanned: number
  /** 本次为多少条新建了复习计划。 */
  readonly initialized: number
  /** 因为 `maxInitPerScan` 被推迟初始化的条数。 */
  readonly deferred: number
  /** 当前到期该复习的条数。 */
  readonly dueReviews: number
  /** 已经暗到「模糊」以下的记忆（按强度升序，最暗的在最前）。 */
  readonly faded: readonly FadedItem[]
  /** 本次被沉底的记忆 id（由 O-010 的 `archiveDue()` 决定）。 */
  readonly archived: readonly string[]
  /** 三档各多少条。 */
  readonly bands: {
    readonly clear: number
    readonly faded: number
    readonly blur: number
  }
  /** 是否因为 `maxScanRows` 只看了前一部分。 */
  readonly truncated: boolean
}

/** 不可用原因。 */
export type DecayUnavailableReason =
  /** 记忆内核服务缺席。 */
  | 'no-core'
  /** 记忆内核在，但自己报不可用。 */
  | 'core-unavailable'
  /** 存储端口缺席（复习计划无处可落）。 */
  | 'no-store'
  /** 建复习表失败。 */
  | 'schema-failed'
  /** 配置里关掉了。 */
  | 'disabled'

/** 累计计数（**只在内存**，进程重启归零；真正的计划在表里）。 */
export interface DecayCounters {
  /** 扫描次数。 */
  readonly scans: number
  /** 复习次数。 */
  readonly reviews: number
  /** 遗忘（`grade < 3`）次数。 */
  readonly lapses: number
  /** 初始化计划条数。 */
  readonly initialized: number
  /** 累计沉底条数。 */
  readonly archived: number
}

/** 统计快照，供 `ondra-startup-check` 与成长面板读取。 */
export interface DecayStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DecayUnavailableReason
  /** 记忆内核后端标识。 */
  readonly coreProvider: string
  /** 复习表行数。 */
  readonly reviews: number
  /** 当前到期该复习的条数。 */
  readonly dueNow: number
  /** 最近一次扫描的时刻（0 表示还没扫过）。 */
  readonly lastScanAt: number
  /** 累计计数。 */
  readonly counters: DecayCounters
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 衰减服务。 */
export interface DecayService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DecayUnavailableReason

  /**
   * 清晰度三档（**纯函数**，不读库）。
   * @param strength 强度 0–1。
   */
  clarityOf(strength: number): ClarityView

  /**
   * 一条记忆的清晰度（走 `core.strengthOf()`，不自己算）。
   * @param record 记忆。
   * @param at 时刻。
   */
  clarityOfRecord(record: MemoryRecordLike, at?: number): ClarityView

  /**
   * 到期该复习的清单（按逾期时长降序）。
   * @param at 时刻。
   * @param limit 条数上限，省略用配置 `maxReviewBatch`。
   */
  dueForReview(at?: number, limit?: number): readonly ReviewItem[]

  /**
   * 记一次复习（SM-2 评分 0–5）。
   * @param id 记忆 id。
   * @param grade 评分：`<3` 算没想起来。
   * @param at 时刻。
   */
  review(id: string, grade: number, at?: number): ReviewOutcome

  /**
   * 衰减扫描：算强度、补复习计划、统计清晰度、把到期该沉底的交给 O-010。
   *
   * **不删任何东西**（只忘不删）。
   * @param at 时刻。
   */
  scan(at?: number): DecayReport

  /**
   * 只做归档（`core.archiveDue()` 的转发），不扫强度。
   * @param at 时刻。
   */
  archive(at?: number): readonly string[]

  /** 统计快照。 */
  stats(): DecayStats
}

/** 错误码。 */
export type DecayErrorCode = 'no-core' | 'core-unavailable' | 'no-store' | 'bad-request' | 'write-failed'

/** 衰减错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class DecayError extends Error {
  /** 错误码。 */
  readonly code: DecayErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: DecayErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'DecayError'
    this.code = code
    this.detail = detail
  }
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

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
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

/* ------------------------------------------------------------------ *
 * O-010 记忆内核的结构对位（不 import 源码）
 * ------------------------------------------------------------------ */

/** 强度视图（与 O-010 的 `StrengthView` 同形）。 */
export interface StrengthViewLike {
  readonly stabilityHours: number
  readonly strength: number
  readonly remainingHours: number
  readonly fadedAt: number
}

/** 一条事实（只镜像本插件读到的字段）。 */
export interface MemoryRecordLike {
  readonly id: string
  readonly kind: string
  readonly category: string
  readonly text: string
  readonly stabilityBaseHours: number
  readonly stabilityHours: number
  readonly timesSaid: number
  readonly hits: number
  readonly revisions: number
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly lastHitAt: number | null
  readonly archived: boolean
  readonly sealed: boolean
}

/** 查询条件（只镜像用到的键）。 */
export interface FactQueryLike {
  readonly category?: string
  readonly kind?: string
  readonly channel?: string
  readonly state?: 'active' | 'archived' | 'sealed'
  readonly subject?: string
  readonly ids?: readonly string[]
  readonly limit?: number
  readonly offset?: number
  readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
}

/** 记忆内核的结构对位子集。**刻意不含 `addFact` / `revise` / `forget`**——
 *  衰减不该有写正文的能力，接口层面堵死比文档里写「请不要改正文」有效。 */
export interface MemoryCoreLike {
  readonly available: boolean
  readonly reason?: string
  getFact(id: string): MemoryRecordLike | undefined
  listFacts(query?: FactQueryLike): readonly MemoryRecordLike[]
  countFacts(query?: FactQueryLike): number
  strengthOf(record: MemoryRecordLike, at?: number): StrengthViewLike
  reinforce(id: string, kind: 'mention' | 'hit', at?: number): MemoryRecordLike
  archiveDue(at?: number): readonly string[]
  stats(): { readonly provider: string; readonly available: boolean }
}

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位（只够建一张复习表）
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
