/**
 * O-131 `ondra-memory-pool` 的对外契约。
 *
 * 定位：**八池分层表的唯一真源**，以及「这条记忆属于哪个池、还能在主动位上待多久」
 * 的唯一判定口。
 *
 * 五件必须先说清的事：
 *
 * 1. **池表归本插件，强度公式仍归 O-010。**
 *    手册 §2.5 的八池给的是「宽限 / 半衰期 / 归档」三段**天级时间轴**，
 *    回答「这条还占不占主动位」；O-010 的 11 类基线给的是**小时级强度**，
 *    回答「这条还亮不亮」。两者是两条独立时间轴，**既不互推、也不相乘**。
 *    本插件因此**不提供任何 0–1 权重**（`weightOf` / `strengthOf` 都不给）：
 *    给了就是第二套衰减曲线，而 O-013 已经把「强度只有一份」定死了。
 *
 * 2. **分类不猜。**
 *    手册原话：「标签没命中任何池：**不猜**。落海马体 + 打『未归类』」。
 *    所以 `classify()` 只认**显式标签**（池名或手册逐字出现过的中文别名），
 *    一个都认不出就落 `hippocampus` 并置 `unclassified=true`，
 *    再由 `hint` 记账：同一句写满 3 次 → 升级「需人工定池」。
 *    **刻意不做关键词猜测**——猜错的代价不对称：猜成「7 天的片面日常」，那条就真没了。
 *
 * 3. **本插件不改 `memory_fact` 任何一列。**
 *    池归属写在独立的 `memory_pool` 表里。给记忆表加 `pool` 列要同时动
 *    O-010 的 schema、O-008 的迁移与各消费方的镜像，收益只是省一次查表，
 *    而端口没有 JOIN，省不掉。
 *
 * 4. **`hippocampus` 永不注入，这一点是**硬性质**，不是配置项。**
 *    手册 §2.5 表末列写「原始片段缓冲，**永不注入**，等夜巡整理」。
 *    写成可配置布尔，就一定会有人打开它，然后「未归类的原始片段」开始挤占注入预算。
 *    故 `PoolPreset.injectable` 在该池上恒为 `false`，且没有对应开关。
 *
 * 5. **`core` 满了直接拒绝，不淘汰。**
 *    手册原话：「核心是不可衰减的那一层，代表『我是谁』。它一旦能被随手追加，
 *    就会越写越厚，最后变成一份谁都不读的清单。」上限 32，满了抛 `core-full`
 *    并提示改去写 `AGENTS.md`。删一条核心等于替用户决定「你不该是自己」。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。镜像的代价是两边人工同步，纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-pool`）。全仓唯一归属。 */
export const POOL_SERVICE_KEY = 'ondra-memory-pool'

/** 池归属表名。 */
export const TABLE_POOL = 'memory_pool'

/** 「未归类」线索表名。 */
export const TABLE_HINT = 'memory_pool_hint'

/**
 * 池 id 全表（手册 §2.5）。
 *
 * **注意一处文档级冲突，已按「表为准」处理**：手册小节标题写「八池」，
 * 但表里有 **9 行**——多出一个 `skill`（表中注「代码保留，README 写 60，以代码 90 为准」）。
 * 本插件**不猜着删掉它**：9 个 id 全部登记，其中 `skill` 标 `legacy: true`、
 * `assignable: false`，只用于「读回旧数据」时认得出它，不参与新记忆的分类。
 * 详见 `pools.ts` 文件头与 README「已知限制 1」。
 */
export const POOL_IDS = [
  'core',
  'fact',
  'skillRule',
  'skillExp',
  'skill',
  'dailyCore',
  'dailyPartial',
  'emotion',
  'hippocampus',
] as const

/** 池 id。 */
export type PoolId = (typeof POOL_IDS)[number]

/**
 * 一个池的完整声明（手册 §2.5 表的逐行）。
 *
 * 三个天级参数里，`Number.POSITIVE_INFINITY` 表示手册里的「∞ / 永不」。
 * 用 `Infinity` 而不是 `null`，是为了让比较运算直接成立（`age < archiveDays` 恒真），
 * 不必在每个判定点写一次「是不是 null」。
 */
export interface PoolPreset {
  /** 池 id。 */
  readonly id: PoolId
  /** 中文名（界面与日志用）。 */
  readonly label: string
  /** 宽限（天）：这段时间内**完全不动**，连半衰期都不开始计。 */
  readonly guardDays: number
  /** 半衰期（天）：宽限结束之后，每过这么久算「一档」。 */
  readonly halfLifeDays: number
  /** 归档（天）：超过它就该沉底（只忘不删，仍可按类翻到）。 */
  readonly archiveDays: number
  /**
   * 是否允许进注入。
   *
   * `hippocampus` 恒为 `false`（手册「永不注入」）。其余为 `true`。
   * 注意这**不是**「该不该注入」的最终判断——装不装得下归 O-036 的装箱制。
   */
  readonly injectable: boolean
  /**
   * 是否允许新记忆被分配到本池。
   *
   * `skill` 为 `false`（legacy 行，只用于读回旧数据）。
   */
  readonly assignable: boolean
  /**
   * 是否单槽（同池只留一条）。
   *
   * 只有 `emotion` 为 `true`（手册「单槽状态牌，会自己过期，**不是日志**」）。
   * 单槽的**顶替动作不在本插件**：`assign()` 只把「当前占槽者」列出来交回去，
   * 由调用方决定归档谁。替用户删掉上一条情绪，等于替他改写「我刚刚是什么心情」。
   */
  readonly singleSlot: boolean
  /** 是否是代码保留的 legacy 行（只有 `skill`）。 */
  readonly legacy: boolean
  /** 一句话语义（手册口径，逐字或近逐字）。 */
  readonly doc: string
}

/**
 * 一次池分配的来源。
 *
 * - `explicit`：调用方直接指定了池（例如「人工定池」）。
 * - `label`：调用方给的标签命中了别名表。
 * - `fallback`：一个都认不出 → 海马体（手册「不猜」）。
 * - `manual`：`reassign()` 改的池（人工定池的落地动作）。
 */
export type PoolAssignSource = 'explicit' | 'label' | 'fallback' | 'manual'

/** 一条池归属记录。 */
export interface PoolAssignment {
  /** 记忆 id。 */
  readonly factId: string
  /** 池 id。 */
  readonly pool: PoolId
  /** 归属时刻（毫秒）。这是三段天级时间轴的**起点**。 */
  readonly assignedAt: number
  /** 来源。 */
  readonly source: PoolAssignSource
  /** 是否「未归类」（只有 `fallback` 会是 `true`）。 */
  readonly unclassified: boolean
  /** 命中的原始标签（没命中则为 `null`）。 */
  readonly matchedLabel: string | null
  /** 备注（人工定池时写「为什么改到这儿」）。 */
  readonly note: string
}

/** 分配入参。 */
export interface AssignInput {
  /** 记忆 id。 */
  readonly factId: string
  /** 正文（只为「未归类」计数与预览，**不参与任何打分**）。 */
  readonly text?: string
  /** 调用方给的标签（池名 / 中文别名都认，见 `pools.ts` 的别名表）。 */
  readonly labels?: readonly string[]
  /** 调用方直接指定池（优先于 `labels`）。 */
  readonly pool?: PoolId | string
  /** 备注。 */
  readonly note?: string
  /** 时刻，省略取当前。 */
  readonly at?: number
}

/** 分类结果（纯判定，不落库）。 */
export interface PoolClassify {
  /** 判定的池。 */
  readonly pool: PoolId
  /** 来源。 */
  readonly source: PoolAssignSource
  /** 命中的原始标签。 */
  readonly matchedLabel: string | null
  /** 是否未归类。 */
  readonly unclassified: boolean
  /** 没认出来的标签（原样交回，便于日记里说清「哪个标签不认识」）。 */
  readonly unknownLabels: readonly string[]
}

/**
 * 「未归类」记账行。
 *
 * 手册：「同一句重复写满 3 次 → 升级『需人工定池』」。
 * 所以这条线索必须能在**跨轮、跨会话**里累加，否则「写满 3 次」永远凑不够。
 */
export interface PoolHint {
  /** 归一化正文的摘要（sha256 前 32 位，与 O-010 的 `digestOf` 同口径）。 */
  readonly digest: string
  /** 正文预览（**只用于展示，不回写**）。 */
  readonly preview: string
  /** 累计出现次数。 */
  readonly attempts: number
  /** 是否已升级为「需人工定池」。 */
  readonly escalated: boolean
  /** 第一次出现的时刻。 */
  readonly firstAt: number
  /** 最近一次出现的时刻。 */
  readonly lastAt: number
}

/**
 * 时间轴判定结果。
 *
 * **只有时刻，没有权重**（见文件头第 1 条）。
 */
export interface PoolTimeline {
  /** 记忆 id。 */
  readonly factId: string
  /** 池 id；没有归属时为 `null`。 */
  readonly pool: PoolId | null
  /** 锚点：`lastSeenAt`（最近一次被带出）；它是 0 时退回 `createdAt`。 */
  readonly anchorAt: number
  /** 宽限结束时刻；`∞` 池为 `null`。 */
  readonly guardUntil: number | null
  /** 第一次半衰期打点时刻；`∞` 池为 `null`。 */
  readonly firstHalfLifeAt: number | null
  /** 归档时刻；`∞` 池为 `null`。 */
  readonly archiveAt: number | null
  /** 已过天数（可为小数）。 */
  readonly ageDays: number
  /** 已跨过几档半衰期（宽限期内恒 0；`∞` 池恒 0）。 */
  readonly halfLives: number
  /** 当前阶段。 */
  readonly phase: PoolPhase
}

/**
 * 阶段。
 *
 * - `permanent`：归档 ∞，永不沉底（core）；
 * - `guarded`：宽限期内，完全不动；
 * - `decaying`：宽限期已过、还没到归档；
 * - `archive-due`：该归档了（只忘不删）。
 */
export type PoolPhase = 'permanent' | 'guarded' | 'decaying' | 'archive-due'

/** 估算时间轴所需的最小时钟（从 O-010 的记录里只读这两列）。 */
export interface PoolClock {
  /** 记忆 id。 */
  readonly id: string
  /** 写入时刻。 */
  readonly createdAt: number
  /** 最近一次被带出的时刻。 */
  readonly lastSeenAt: number
}

/** 注入资格审查结果。 */
export interface InjectionEligibility {
  /** 是否允许参与注入。 */
  readonly eligible: boolean
  /** 池 id；没登记过池时为 `null`。 */
  readonly pool: PoolId | null
  /** 原因码。 */
  readonly reason:
    /** 正常，可参与注入（装不装得下归 O-036）。 */
    | 'ok'
    /** 海马体：永不注入。 */
    | 'hippocampus-never'
    /** 已到归档时刻，不再进主动位（仍可按类检索翻到）。 */
    | 'archive-due'
    /** 没有池归属——**默认放行**，见 README「已知限制 4」。 */
    | 'no-assignment'
}

/** 一条「该归档」候选。 */
export interface PoolDueItem {
  /** 记忆 id。 */
  readonly factId: string
  /** 池 id。 */
  readonly pool: PoolId
  /** 归档时刻。 */
  readonly archiveAt: number
  /** 已逾期多少小时（0 表示刚好到期）。 */
  readonly overdueHours: number
}

/** 运行期问题。**不致命但必须让人看见。** */
export interface PoolIssue {
  /** 问题码。 */
  readonly code:
    | 'ensure-failed'
    | 'store-issue'
    | 'bad-pool'
    | 'bad-fact-id'
    | 'core-full'
    | 'not-assignable'
    | 'hint-truncated'
    | 'too-many-issues'
  /** 相关记忆 id。 */
  readonly factId?: string
  /** 中文说明，直接给人看。 */
  readonly detail: string
}

/** 不可用原因。 */
export type PoolUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** 上游存储端口缺席。 */
  | 'no-store'
  /** 建表失败。 */
  | 'schema-failed'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface PoolCounters {
  /** 分配次数（含重复分配）。 */
  readonly assigned: number
  /** 未归类落海马体的次数。 */
  readonly fellBack: number
  /** 人工改池次数。 */
  readonly reassigned: number
  /** 被 core 上限拒掉的次数。 */
  readonly coreRejected: number
}

/** 统计快照，供 `ondra-startup-check` 与成长面板读取。 */
export interface PoolStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: PoolUnavailableReason
  /** 后端标识（`sqlite` / `memory`）。 */
  readonly provider: string
  /** 已登记池归属的条数。 */
  readonly assigned: number
  /** 各池条数（未出现的池不列）。 */
  readonly byPool: Readonly<Partial<Record<PoolId, number>>>
  /** 核心池条数 / 上限。 */
  readonly core: { readonly count: number; readonly cap: number }
  /** 未归类条数。 */
  readonly unclassified: number
  /** 已升级「需人工定池」的线索条数。 */
  readonly escalations: number
  /** 记忆内核是否在位（缺它就只能判池，不能算时间轴）。 */
  readonly clockAvailable: boolean
  /** 累计计数。 */
  readonly counters: PoolCounters
  /** 最近的问题（最多 20 条）。 */
  readonly issues: readonly PoolIssue[]
}

/** 八池服务。 */
export interface PoolService {
  /** 是否可用（建表成功且未关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: PoolUnavailableReason

  /** 八池全表（9 行，含 legacy `skill`）。返回冻结副本，调用方不得改。 */
  pools(): readonly PoolPreset[]
  /**
   * 取一个池的声明。
   * @param poolId 池 id。
   */
  poolOf(poolId: string): PoolPreset | undefined

  /**
   * 纯分类判定（**不落库**）。
   * @param input 入参。
   */
  classify(input: AssignInput): PoolClassify
  /**
   * 分配并落库。`core` 满时抛 `PoolError('core-full')`。
   * @param input 入参。
   */
  assign(input: AssignInput): PoolAssignment
  /**
   * 改池（人工定池的落地动作）。
   * @param factId 记忆 id。
   * @param pool 新池。
   * @param note 为什么改。
   * @param at 时刻。
   */
  reassign(factId: string, pool: PoolId | string, note: string, at?: number): PoolAssignment
  /**
   * 取一条池归属。
   * @param factId 记忆 id。
   */
  assignOf(factId: string): PoolAssignment | undefined
  /**
   * 撤销池归属（**不删记忆**，只把登记行去掉）。
   * @param factId 记忆 id。
   */
  unassign(factId: string): boolean

  /**
   * 算三段天级时间轴。时钟来自 O-010（只读 `createdAt` / `lastSeenAt`）。
   * @param factId 记忆 id。
   * @param at 时刻。
   */
  timelineOf(factId: string, at?: number): PoolTimeline | undefined
  /**
   * 注入资格审查。
   * @param factId 记忆 id。
   * @param at 时刻。
   */
  eligibleForInjection(factId: string, at?: number): InjectionEligibility
  /**
   * 该归档的候选清单（**只出清单，不改任何数据**）。
   * @param poolId 限定池，省略则全池。
   * @param at 时刻。
   */
  dueForArchive(poolId?: PoolId | string, at?: number): readonly PoolDueItem[]
  /**
   * 单槽池的当前占槽者（只有 `emotion` 会用到）。
   * @param poolId 池 id。
   */
  slotHolders(poolId: PoolId | string): readonly string[]

  /** 已升级「需人工定池」的线索清单（按最近出现倒序）。 */
  escalations(): readonly PoolHint[]
  /**
   * 清掉一条未归类线索（人工定池之后调，避免它一直挂在清单上）。
   * @param digest 线索摘要。
   */
  resolveHint(digest: string): boolean

  /** 统计快照。 */
  stats(): PoolStats
}

/** 错误码。 */
export type PoolErrorCode =
  | 'no-store'
  | 'disabled'
  | 'schema-failed'
  | 'closed'
  | 'core-full'
  | 'not-assignable'
  | 'bad-pool'
  | 'bad-argument'
  | 'write-failed'

/** 八池错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class PoolError extends Error {
  /** 错误码。 */
  readonly code: PoolErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: PoolErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'PoolError'
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

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/* ------------------------------------------------------------------ *
 * 上游记忆内核的结构对位（不 import O-010 源码）
 *
 * 只镜像本插件真正用到的成员：`getFact` / `listFacts` / `countFacts` / `available`。
 * **刻意不含** `addFact` / `revise` / `forget` / `archiveDue` / `strengthOf`：
 * 池插件不该有写正文、算强度、沉底的能力——接口层面堵死比文档写「请不要」有效。
 * ------------------------------------------------------------------ */

/** 一条事实（只镜像本插件读到的字段）。 */
export interface MemoryRecordLike {
  readonly id: string
  readonly category: string
  readonly text: string
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly archived: boolean
  readonly sealed: boolean
}

/** 查询条件（只镜像用到的键）。 */
export interface FactQueryLike {
  readonly state?: 'active' | 'archived' | 'sealed'
  readonly limit?: number
  readonly offset?: number
}

/** 记忆内核的结构对位子集（**只读**）。 */
export interface MemoryCoreLike {
  readonly available: boolean
  readonly reason?: string
  getFact(id: string): MemoryRecordLike | undefined
  listFacts(query?: FactQueryLike): readonly MemoryRecordLike[]
  countFacts(query?: FactQueryLike): number
}

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位（只够建两张表）
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

/** 建表结果。 */
export interface EnsureResultLike {
  readonly table: string
  readonly created: boolean
  readonly addedColumns: readonly string[]
  readonly createdIndexes: readonly string[]
  readonly issues: readonly {
    readonly code: string
    readonly table: string
    readonly column?: string
    readonly detail: string
  }[]
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

/** 存储端口的结构对位子集（只走表级 CRUD，不用 `raw`）。 */
export interface StoreLike {
  readonly provider: string
  readonly state: string
  readonly caps: {
    readonly sql: boolean
    readonly fts: boolean
    readonly persist: boolean
    readonly transaction: boolean
  }
  ensureTable(spec: TableSpecLike): EnsureResultLike
  tableExists(table: string): boolean
  insert(table: string, row: RowLike): void
  upsert(table: string, row: RowLike): void
  update(table: string, key: RowLike, patch: RowLike): number
  delete(table: string, key: RowLike): number
  get(table: string, key: RowLike): RowLike | undefined
  select(table: string, query?: SelectQueryLike): RowLike[]
  count(table: string, where?: readonly FilterLike[]): number
  transaction<T>(fn: () => T): T
  stats(): { readonly provider: string; readonly state: string }
}

/* ------------------------------------------------------------------ *
 * 维护纪律（改契约前必读）
 *
 * 1. **`PoolPreset` 的三列数值只能改在 `pools.ts` 一处。**
 *    这是本插件存在的理由（八池表的唯一真源）。任何在别处再写一份
 *    「730 / 60 / 20」的改动都是第二真源，改一处参数会有一半地方不生效。
 * 2. **`MemoryRecordLike` 与 O-010 的 `MemoryRecord` 必须逐字对齐**（本插件只用两列：
 *    `createdAt` / `lastSeenAt`）。结构对位是宽匹配：多一个字段不报错、少一个也不报错
 *    （运行期 undefined）。改 O-010 的字段时，必须同步改这里。
 * 3. **不要在 `PoolTimeline` 里加权重。** 见文件头第 1 条；加一个 `weight` 字段
 *    就会有人拿它和 O-010 的 `strength` 比大小，然后两条衰减曲线永远对不上。
 * ------------------------------------------------------------------ */
