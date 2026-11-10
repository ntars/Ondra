/**
 * O-010 `ondra-memory-core` 的对外契约。
 *
 * 定位：L2 记忆域的**唯一读写入口**与**寿命公式的唯一真源**。双层表
 * （`memory_raw` 原文 / `memory_fact` 提炼）在这里建一次，其余记忆插件只声明
 * 「我要读写哪一列」，不各自开表、不各自算寿命。
 *
 * 三件必须在这里说清的事：
 *
 * 1. **「11 类」与「五类」是两个字段，不是同一个。**
 *    手册 §2.4 的 11 类是**寿命类别**（watch 2h … self 20000h），决定「这条能活多久」；
 *    §9.8 的五类是**记忆种类标签**（episode / fact / reflection / skill / lesson），
 *    决定「这条是什么」。两者正交：一条 `person` 类的事实可以是 `fact` 也可以是 `episode`。
 *    硬压成一个 `kind` 字段的后果是可预见的——11 个基线要映射到 5 个标签，
 *    映射表本身就得靠猜，而猜错的那条会被按错误的基线算寿命。
 *    故：`category`（11 类）与 `kind`（五类）并列，**永不互相推导**。
 *
 * 2. **寿命公式是「公式变更」，不是新增。**
 *    `S(小时) = baseHours × (0.45 + salience/100 × 1.25) × (1 + arousal × 0.65)`
 *    替换的是旧实现里「所有记忆同一把尺子」的单一半衰期。同一份数据在升级后
 *    会算出不同的存活时间，这是预期行为，不是 bug（手册 §2.4 明写要求注明）。
 *
 * 3. **本插件不排序、不裁剪、不决定「该想起谁」。**
 *    召回不按条数砍（`dropped` 恒为 0）是 O-014 的红线；本插件只负责
 *    「写进去时把寿命算准」「读出来时把状态说清」。任何在这里加 `topK` 的改动都是越界。
 *
 * 与上游存储端口的关系：本文件**不 import** `ondra-store-sqlite` / `ondra-store-memory`
 * 的源码（§15.5 / §18.5），只用「结构对位」的 `StoreLike` 镜像。代价是两边需人工同步，
 * 维护纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-core`）。全仓唯一归属。 */
export const MEMORY_CORE_SERVICE_KEY = 'ondra-memory-core'

/**
 * 记忆 id / 服务键共用的命名正则（手册 §8.4）。
 *
 * 记忆 id 也会被模型与界面看见（工具参数、星云图节点），所以与工具名同一把尺子。
 */
export const MEMORY_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 11 个寿命类别（手册 §2.4，源码实读）。
 *
 * 顺序即界面渲染顺序：从「最快忘」到「最难忘」。
 */
export const MEMORY_CATEGORIES = [
  'watch',
  'daily',
  'food',
  'place',
  'misc',
  'event',
  'feeling',
  'study',
  'person',
  'promise',
  'self',
] as const

/** 寿命类别。 */
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/**
 * 5 个记忆种类标签（手册 §9.8 / master-plan §14.3「五类做 kind 标签体系」）。
 *
 * 与 `MemoryCategory` **正交**，见文件头第 1 条。
 */
export const MEMORY_KINDS = ['episode', 'fact', 'reflection', 'skill', 'lesson'] as const

/** 记忆种类。 */
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/**
 * 三通道视图（手册 §2.4「保留 CHANNEL_PARAMS 作为第二层调制」）。
 *
 * - `fact` 事实通道：4 天；
 * - `gist` 语义通道：12 天（三档中位，作为归一化锚点，见 `channelAnchorDays`）；
 * - `affect` 情感通道：180 天。
 */
export const MEMORY_CHANNELS = ['fact', 'gist', 'affect'] as const

/** 记忆通道。 */
export type MemoryChannel = (typeof MEMORY_CHANNELS)[number]

/**
 * 一条记忆的存续状态。
 *
 * - `active`：正常参与注入与回忆；
 * - `archived`：已沉底（**只忘不删**，仍可被按类检索翻到）；
 * - `sealed`：已封存（不主动注入、不参与回忆，到期只归档）。
 */
export type MemoryState = 'active' | 'archived' | 'sealed'

/**
 * 四态删除（手册 §2.4）。
 *
 * `sink` 是「自然沉底」——什么都不做，所以它**没有对应方法**，只在这里登记，
 * 免得后人以为漏实现了一个 API。
 */
export type DeletionMode = 'forget' | 'seal' | 'sink' | 'revise'

/**
 * 引文来源（手册 §2.2 的四类）。
 *
 * 刻意在契约层收成 `string` 而不锁成联合类型：证据门控的**判定**归 O-140，
 * 本插件只是把引文原样存下来（谁写的、写了什么）。锁死枚举会让 O-140 将来加
 * 第五类来源（例如 `[FILE]`）时必须改本插件。
 */
export interface EvidenceRef {
  /** 来源标记：`USER` / `TOOL` / `ACT` / `SELF`（大小写不敏感，原样存）。 */
  readonly source: string
  /** 逐字引文。 */
  readonly quote: string
  /** 引文来自本轮第几条消息（从 0 起）。 */
  readonly messageIndex?: number
}

/** 原文层一行。短期记忆只用于指代消解，**不参与寿命计算**。 */
export interface RawRecord {
  /** 原文 id。 */
  readonly id: string
  /** 所属轮次 id。 */
  readonly turnId: string
  /** 说话方：`user` / `assistant` / `tool`。 */
  readonly role: string
  /** 原文，**不裁剪**（裁剪会毁掉引文校验）。 */
  readonly text: string
  /** 写入时间戳（毫秒）。 */
  readonly createdAt: number
  /** 附加元数据（原样存 JSON）。 */
  readonly meta: Readonly<Record<string, unknown>>
}

/** 追加一轮对话的入参。 */
export interface TurnInput {
  /** 轮次 id，调用方生成（同一轮内唯一）。 */
  readonly turnId: string
  /** 说话方。 */
  readonly role: string
  /** 原文。 */
  readonly text: string
  /** 写入时间；省略取当前时刻。 */
  readonly at?: number
  /** 附加元数据。 */
  readonly meta?: Readonly<Record<string, unknown>>
  /**
   * 同一事务里一并写入的提炼结果。
   *
   * 给「已经拿到事实、不想两次落盘」的调用方用；O-011 走的是**异步**路径，
   * 它调 `addFact()`，两条路径写的是同一张表。
   */
  readonly facts?: readonly FactInput[]
}

/** 写入一条事实的入参。 */
export interface FactInput {
  /** 指定 id（幂等重放用）；省略则生成。 */
  readonly id?: string
  /** 来源原文 id。 */
  readonly rawId?: string
  /** 五类标签；非法值退回 `fact`。 */
  readonly kind: MemoryKind | string
  /** 11 类寿命类别；非法值退回 `misc` 并记一条 issue。 */
  readonly category: MemoryCategory | string
  /** 正文，上限见 `maxTextChars`（超长截断并记 issue）。 */
  readonly text: string
  /** 摘要，上限见 `maxSummaryChars`。 */
  readonly summary?: string
  /** 主体（谁的事）：`user` / `self` / 具体人名。 */
  readonly subject?: string
  /** 通道；省略取配置 `defaultChannel`。 */
  readonly channel?: MemoryChannel | string
  /** 显著度 0–100；省略则按写入打分表算。 */
  readonly salience?: number
  /** 唤醒度 0–1；省略取 0.5。 */
  readonly arousal?: number
  /** 四类引文。 */
  readonly evidence?: readonly EvidenceRef[]
  /** 写入时间；省略取当前时刻。 */
  readonly at?: number
}

/** 一条事实（读出来的视图）。 */
export interface MemoryRecord {
  /** 记忆 id。 */
  readonly id: string
  /** 五类标签。 */
  readonly kind: MemoryKind
  /** 11 类寿命类别。 */
  readonly category: MemoryCategory
  /** 通道。 */
  readonly channel: MemoryChannel
  /** 正文。 */
  readonly text: string
  /** 摘要。 */
  readonly summary: string | null
  /** 主体。 */
  readonly subject: string | null
  /** 显著度 0–100（写入打分结果或调用方显式给的值）。 */
  readonly salience: number
  /** 唤醒度 0–1。 */
  readonly arousal: number
  /** **基线** S（小时）：类别 × 显著度 × 唤醒度 × 通道，不含提及/命中调制。 */
  readonly stabilityBaseHours: number
  /** 订正累计倍数（每次 `revise` ×1.3，复利）。 */
  readonly stabilityMult: number
  /** **当前** S（小时）：基线 × 提及因子 × 命中因子 × 订正倍数。 */
  readonly stabilityHours: number
  /** 被提起次数（含写入时的第一次）。 */
  readonly timesSaid: number
  /** 被检索命中次数。 */
  readonly hits: number
  /** 订正次数。 */
  readonly revisions: number
  /** 写入时间戳。 */
  readonly createdAt: number
  /** 最近一次被带出（注入/提及）的时间戳。 */
  readonly lastSeenAt: number
  /** 最近一次被检索命中的时间戳。 */
  readonly lastHitAt: number | null
  /** 是否已沉底。 */
  readonly archived: boolean
  /** 是否已封存。 */
  readonly sealed: boolean
  /** 是否「重要」（`salience ≥ importantSalience`），决定归档窗口是 90 天还是 30 天。 */
  readonly important: boolean
  /** 来源原文 id。 */
  readonly sourceRawId: string | null
  /** 订正前的正文（只有 `revise` 过的才有）。 */
  readonly oldText: string | null
  /** 四类引文。 */
  readonly evidence: readonly EvidenceRef[]
}

/** 寿命拆解。四个因子各自可查，便于 `explainThreshold()` 那类解释性接口复用。 */
export interface Stability {
  /** 类别基线（小时）。 */
  readonly baseHours: number
  /** 显著度系数 `0.45 + salience/100 × 1.25`。 */
  readonly salienceFactor: number
  /** 唤醒度系数 `1 + arousal × 0.65`。 */
  readonly arousalFactor: number
  /** 通道系数 `channelDays / anchorDays`。 */
  readonly channelFactor: number
  /** 提及因子 `min(15, 3×(1+ln(1+timesSaid))) / 3`。 */
  readonly mentionFactor: number
  /** 命中因子 `min(4, 1+0.6·log2(1+hits))`。 */
  readonly hitFactor: number
  /** 合计（小时）。 */
  readonly hours: number
}

/** 强度视图。 */
export interface StrengthView {
  /** 当前 S（小时）。 */
  readonly stabilityHours: number
  /** 当前强度 0–1（地板见 `floorWeight`）。 */
  readonly strength: number
  /** 距离掉到地板还有多少小时（0 表示已到底）。 */
  readonly remainingHours: number
  /** 预计掉到地板的时间戳。 */
  readonly fadedAt: number
}

/** 查询条件（表级 CRUD 面，**不是**召回打分）。 */
export interface FactQuery {
  /** 类别。 */
  readonly category?: MemoryCategory
  /** 五类标签。 */
  readonly kind?: MemoryKind
  /** 通道。 */
  readonly channel?: MemoryChannel
  /** 状态。 */
  readonly state?: MemoryState
  /** 主体。 */
  readonly subject?: string
  /** 指定 id 集合。 */
  readonly ids?: readonly string[]
  /** 返回上限；省略用 `maxSelectRows`（**这是内存保护，不是召回预算**）。 */
  readonly limit?: number
  /** 跳过条数。 */
  readonly offset?: number
  /** 排序；省略按 `created_at` 倒序。 */
  readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
}

/** 运行期发现的问题。**不致命但必须让人看见**。 */
export interface MemoryIssue {
  /** 问题码。 */
  readonly code:
    | 'ensure-failed'
    | 'store-issue'
    | 'bad-category'
    | 'bad-kind'
    | 'bad-id'
    | 'text-truncated'
    | 'summary-truncated'
    | 'not-found'
    | 'closed'
    | 'id-collision'
    | 'digest-empty'
    | 'too-many-issues'
  /** 相关记忆 id（若适用）。 */
  readonly id?: string
  /** 中文说明，直接给人看。 */
  readonly detail: string
}

/** 不可用原因。 */
export type MemoryUnavailableReason =
  /** 上游存储端口缺席（`ondra-store-sqlite` 与 `ondra-store-memory` 都没有）。 */
  | 'no-store'
  /** 建表失败。 */
  | 'schema-failed'
  /** 端口已关闭。 */
  | 'closed'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface MemoryCounters {
  /** 追加的轮次数。 */
  readonly turns: number
  /** 写入的事实条数。 */
  readonly facts: number
  /** 订正次数。 */
  readonly revisions: number
  /** 忘记次数。 */
  readonly forgotten: number
  /** 封存次数。 */
  readonly sealed: number
  /** 被加固次数（提及 + 命中）。 */
  readonly reinforced: number
}

/** 统计快照，供 `ondra-startup-check` 与成长面板读取。 */
export interface MemoryStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: MemoryUnavailableReason
  /** 后端标识（`sqlite` / `memory`）。 */
  readonly provider: string
  /** 三张表的行数。 */
  readonly tables: {
    readonly raw: number
    readonly fact: number
    readonly tombstone: number
  }
  /** 各状态条数。 */
  readonly states: {
    readonly active: number
    readonly archived: number
    readonly sealed: number
  }
  /** 平均显著度（**按最近 500 条取样估算**，不是全库精确值——端口没有聚合面）。 */
  readonly avgSalience: number
  /** 累计计数。 */
  readonly counters: MemoryCounters
  /** 最近的问题（最多 20 条）。 */
  readonly issues: readonly MemoryIssue[]
}

/** 记忆内核服务。 */
export interface MemoryCoreService {
  /** 是否可用（建表成功且端口未关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: MemoryUnavailableReason

  /**
   * 追加一轮对话的原文（可选同事务写事实）。
   * @param input 入参。
   */
  appendTurn(input: TurnInput): RawRecord
  /**
   * 写入一条事实：算寿命、算打分、落库。
   * @param input 入参。
   */
  addFact(input: FactInput): MemoryRecord

  /**
   * 按 id 取一条。
   * @param id 记忆 id。
   */
  getFact(id: string): MemoryRecord | undefined
  /**
   * 条件查询。**不做相关性排序**（那是 O-014 的事）。
   * @param query 条件。
   */
  listFacts(query?: FactQuery): readonly MemoryRecord[]
  /**
   * 条件计数。
   * @param query 条件。
   */
  countFacts(query?: FactQuery): number

  /**
   * 订正：留 `oldText`、`revisions+1`、S ×1.3（复利）。合并时新版本必胜由调用方按
   * `revisions` 判定。
   * @param id 记忆 id。
   * @param newText 新正文。
   * @param at 时间戳。
   */
  revise(id: string, newText: string, at?: number): MemoryRecord
  /**
   * 真删并写墓碑（合并时不许复活）。
   * @param id 记忆 id。
   * @param reason 原因，写进墓碑。
   * @returns 是否删掉了。
   */
  forget(id: string, reason: string): boolean
  /**
   * 封存：不主动注入、不参与回忆，按类检索仍可能翻到。
   * @param id 记忆 id。
   * @param at 时间戳。
   */
  seal(id: string, at?: number): MemoryRecord
  /**
   * 归档扫描：把超过归档窗口（普通 30 天 / 重要 90 天）且未被带出的记忆沉底。
   *
   * **只改状态位，不删数据**（`archived=1` 之后仍能被按类检索翻到）。
   * 扫描时机由调用方决定（O-013 衰减、O-017 审计、或夜间任务），本插件不装定时器。
   * @param at 时间戳。
   * @returns 本次被沉底的记忆 id。
   */
  archiveDue(at?: number): readonly string[]

  /**
   * 加固。
   * @param id 记忆 id。
   * @param kind `mention` 被提起 / `hit` 被检索命中。
   * @param at 时间戳。
   */
  reinforce(id: string, kind: 'mention' | 'hit', at?: number): MemoryRecord
  /**
   * 标记「已带出」（更新 `lastSeenAt`），注入之后调。
   * @param ids 记忆 id 列表。
   * @param at 时间戳。
   * @returns 实际更新的条数。
   */
  markSeen(ids: readonly string[], at?: number): number

  /**
   * 算当前强度。**纯函数**，不改库。
   * @param record 记忆。
   * @param at 时间戳。
   */
  strengthOf(record: MemoryRecord, at?: number): StrengthView
  /**
   * 最低曝光候选：超过 N 天没被带出的记忆。
   *
   * 「30 天未带出强行补 1 条」的**取材端**在这里，**决定注入谁**在 O-036。
   * @param days 天数，省略用配置 `resurfaceDays`。
   * @param limit 条数，默认 1（手册原话是「补 1 条」）。
   */
  dueForResurfacing(days?: number, limit?: number): readonly MemoryRecord[]

  /**
   * 这段正文是否已被忘记（按去空白后的摘要比对）。
   * @param text 正文。
   */
  tombstoned(text: string): boolean

  /** 统计快照。 */
  stats(): MemoryStats
}

/** 错误码。 */
export type MemoryErrorCode =
  | 'no-store'
  | 'closed'
  | 'empty-text'
  | 'not-found'
  | 'bad-argument'
  | 'write-failed'

/** 记忆内核错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class MemoryError extends Error {
  /** 错误码。 */
  readonly code: MemoryErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: MemoryErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'MemoryError'
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
 * 上游存储端口的结构对位（不 import O-006 / O-007 源码）
 *
 * 为什么不用 `import type`：§18.5 禁止同轮互相 import，而 O-006 / O-007 与
 * 本插件不同轮；即便跨轮允许，编译期绑定也会让「单独卸载存储后端」直接编译失败。
 * 结构对位的代价是**两边要人工同步**，所以这里只镜像本插件真正调用的成员，
 * 镜像得越少，漂移面越小。
 * ------------------------------------------------------------------ */

/** 列类型（与 O-006 的 `ColumnType` 一致，刻意不含 `NUMERIC`）。 */
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

/**
 * 存储端口的结构对位子集。
 *
 * 只镜像本插件真正调用的 10 个成员；`raw`（原始 SQL 面）刻意**不用**——
 * 一旦用上 FTS5 或自定义 SQL，本插件就会绑死 SQLite，内存后端立刻失效。
 * 记忆内核必须两个后端都能跑，所以只走表级 CRUD。
 */
export interface StoreLike {
  /** 后端标识。 */
  readonly provider: string
  /** 端口状态。 */
  readonly state: string
  /** 能力位。 */
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
