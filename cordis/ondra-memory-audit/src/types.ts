/**
 * O-017 `ondra-memory-audit` 的对外契约。
 *
 * 定位：**「她为什么记不清了」的唯一解释口，与「怎么删」的唯一执行口**。
 * 它**不持有**任何记忆：正文、强度、寿命、状态全在 O-010；它也不**重算**任何公式，
 * 只把 O-010 已经算好的东西翻译成人话，并按手册 §2.4 的四态执行删除动作。
 *
 * 五件必须先说清的事：
 *
 * 1. **解释到「因子输入」为止，不算「因子数值」。**
 *    `S = baseHours × (0.45 + salience/100×1.25) × (1 + arousal×0.65) × 通道 × 提及 × 命中 × 订正`。
 *    这些因子由 O-010 算，本插件**一个 `Math.pow` / `Math.exp` 都不写**。
 *    所以 `ExplainView` 给的是「输入」（`salience` / `arousal` / `timesSaid` / `hits` /
 *    `revisions` / 类别基线）与「结果」（`baseHours` / `currentHours` / `strength` /
 *    `remainingHours`），中间那层因子数值**刻意不给**——给了就是第二份公式。
 *    代价：界面无法显示「显著度系数 = 1.575」。真要显示，得让 O-010 暴露
 *    `stabilityOf()`（它内部有，只是没进服务接口）。已登记为契约缺口。
 *
 * 2. **三档话术只有一个真源，在 O-013。**
 *    手册 §2.6 的清晰度三档（`≥0.7` 正常 / `0.4–0.7` 记不太清了 / `<0.4` 只剩个模糊的影子）
 *    已经由 O-013 的 `clarityOf(strength)` 实现。本插件**调用它**，
 *    缺席时 `clarity` 为 `undefined`——**宁可不说话术，也不复制一份阈值**。
 *    复制一份的后果是：哪天产品调了 0.7 → 0.65，一半界面还在说「正常」。
 *
 * 3. **钉住是标记，不是行为。**
 *    `pin()` 只往 `memory_pin` 写一行；它**不改** `memory_fact` 的任何一列
 *    （没有 `pinned` 列，也不该加——加了就要改 O-010 的表与迁移）。
 *    「钉住的不参与衰减」由 O-013 读 `isPinned()` 自己跳过；
 *    「钉住的必进注入」由 O-036 读 `pinned()` 自己装。本插件只登记事实。
 *
 * 4. **`sink`（自然沉底）没有方法。**
 *    手册 §2.4 四态里「自然沉底：什么都不做」——字面意义上的不做。
 *    故 `deletionModes()` 会给出四种模式，其中 `sink.hasMethod === false`。
 *    这不是漏实现，是**刻意的空**：给它写一个 `sink()` 方法，就等于给了它一个
 *    「被调用但什么也不做」的假接口，而 §17-6 明令禁止假开关。
 *
 * 5. **删除动作全部经 O-010 的公开方法，绝不直接写表。**
 *    `forget()` / `seal()` / `revise()` 都是 O-010 的服务方法；本插件额外做两件
 *    O-010 不管的事：清钉子（`memory_pin`）与清孤儿边（调 O-015 的 `forgetOf()`）。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。镜像的代价是两边人工同步，纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-audit`）。全仓唯一归属。 */
export const AUDIT_SERVICE_KEY = 'ondra-memory-audit'

/** 钉子表名。 */
export const TABLE_PIN = 'memory_pin'

/**
 * 四态删除（手册 §2.4，逐字）。
 *
 * `sink` 是「自然沉底 = 什么都不做」，故**没有对应方法**（见文件头第 4 条）。
 */
export type DeletionMode = 'forget' | 'seal' | 'sink' | 'revise'

/** 一种删除模式的说明书。 */
export interface DeletionModeDoc {
  /** 模式。 */
  readonly mode: DeletionMode
  /** 中文名。 */
  readonly label: string
  /** 是否有对应方法。`sink` 恒为 `false`。 */
  readonly hasMethod: boolean
  /** 是否不可逆。只有 `forget` 是。 */
  readonly irreversible: boolean
  /** 一句话说明（手册口径）。 */
  readonly doc: string
}

/** 四态说明书。**顺序即界面渲染顺序**。 */
export const DELETION_MODES: readonly DeletionModeDoc[] = Object.freeze([
  {
    mode: 'forget',
    label: '忘记',
    hasMethod: true,
    irreversible: true,
    doc: '真删并写墓碑，合并时不许复活。不可逆——这是唯一一个删了就没了的状态。',
  },
  {
    mode: 'seal',
    label: '封存',
    hasMethod: true,
    irreversible: false,
    doc: '不主动注入、不参与回忆，按类检索仍可能翻到，到期只归档。',
  },
  {
    mode: 'sink',
    label: '自然沉底',
    hasMethod: false,
    irreversible: false,
    doc: '什么都不做。等归档窗口（普通 30 天 / 重要 90 天）自己把它沉下去。',
  },
  {
    mode: 'revise',
    label: '订正',
    hasMethod: true,
    irreversible: false,
    doc: '留 oldText、revisions+1、S×1.3，合并时新版本必胜。',
  },
])

/** 清晰度档位（**镜像 O-013**，不 import）。 */
export type ClarityBandLike = 'clear' | 'fuzzy' | 'shadow'

/** 清晰度视图（**镜像 O-013 的 `ClarityView`**）。 */
export interface ClarityViewLike {
  /** 档位。 */
  readonly band: ClarityBandLike | string
  /** 拼在记忆行尾的话术（`clear` 时是空串）。 */
  readonly phrase: string
  /** 当时的强度 0–1。 */
  readonly strength: number
}

/** 记忆状态（与 O-010 的 `MemoryState` 同形）。 */
export type MemoryStateLike = 'active' | 'archived' | 'sealed'

/** 引文（镜像 O-010 的 `EvidenceRef`）。 */
export interface EvidenceLike {
  /** 来源标记：`USER` / `TOOL` / `ACT` / `SELF`。 */
  readonly source: string
  /** 逐字引文。 */
  readonly quote: string
  /** 引文来自本轮第几条消息。 */
  readonly messageIndex?: number
}

/**
 * 一条记忆（**镜像 O-010 的 `MemoryRecord`**）。
 *
 * 只镜像本插件用到的字段，但字段名与语义必须逐字对齐。加字段前先确认
 * O-010 真的有——凭想象加一个字段，编译期不会报错（结构对位是宽匹配），
 * 运行期永远是 `undefined`，这类错误最难查。
 */
export interface MemoryRecordLike {
  /** 记忆 id。 */
  readonly id: string
  /** 五类标签。 */
  readonly kind: string
  /** 11 类寿命类别。 */
  readonly category: string
  /** 通道。 */
  readonly channel: string
  /** 正文。 */
  readonly text: string
  /** 摘要。 */
  readonly summary: string | null
  /** 主体。 */
  readonly subject: string | null
  /** 显著度 0–100。 */
  readonly salience: number
  /** 唤醒度 0–1。 */
  readonly arousal: number
  /** **基线** S（小时）。 */
  readonly stabilityBaseHours: number
  /** 订正累计倍数。 */
  readonly stabilityMult: number
  /** **当前** S（小时）。 */
  readonly stabilityHours: number
  /** 被提起次数。 */
  readonly timesSaid: number
  /** 被检索命中次数。 */
  readonly hits: number
  /** 订正次数。 */
  readonly revisions: number
  /** 写入时间戳。 */
  readonly createdAt: number
  /** 最近一次被带出。 */
  readonly lastSeenAt: number
  /** 最近一次被检索命中。 */
  readonly lastHitAt: number | null
  /** 是否已沉底。 */
  readonly archived: boolean
  /** 是否已封存。 */
  readonly sealed: boolean
  /** 是否重要。 */
  readonly important: boolean
  /** 来源原文 id。 */
  readonly sourceRawId: string | null
  /** 订正前的正文。 */
  readonly oldText: string | null
  /** 四类引文。 */
  readonly evidence: readonly EvidenceLike[]
}

/** 强度视图（镜像 O-010 的 `StrengthView`）。 */
export interface StrengthViewLike {
  /** 当前 S（小时）。 */
  readonly stabilityHours: number
  /** 当前强度 0–1。 */
  readonly strength: number
  /** 距离掉到地板还有多少小时（0 表示已到底）。 */
  readonly remainingHours: number
  /** 预计掉到地板的时间戳。 */
  readonly fadedAt: number
}

/** 一条钉子。 */
export interface PinRecord {
  /** 记忆 id（主键）。 */
  readonly id: string
  /** 钉住时刻。 */
  readonly pinnedAt: number
  /** 备注（为什么钉住它）。 */
  readonly note: string
}

/**
 * 一条记忆的完整解释。
 *
 * 字段分三组，**刻意不混**：
 * - 「输入」：`salience` / `arousal` / `timesSaid` / `hits` / `revisions` / `category`；
 * - 「结果」：`baseHours` / `currentHours` / `strength` / `remainingHours` / `fadedAt`；
 * - 「人话」：`reasons`（逐条说明）+ `clarity`（三档话术，来自 O-013）。
 */
export interface ExplainView {
  /** 记忆 id。 */
  readonly id: string
  /** 正文（原样，不裁剪——裁剪会让「为什么记不清」变成「为什么记错了」）。 */
  readonly text: string
  /** 五类标签。 */
  readonly kind: string
  /** 11 类寿命类别。 */
  readonly category: string
  /** 通道。 */
  readonly channel: string
  /** 状态。 */
  readonly state: MemoryStateLike
  /** 是否被钉住。 */
  readonly pinned: boolean
  /** 是否重要（决定归档窗口 30 / 90 天）。 */
  readonly important: boolean
  /** 显著度。 */
  readonly salience: number
  /** 唤醒度。 */
  readonly arousal: number
  /** 被提起次数。 */
  readonly timesSaid: number
  /** 被检索命中次数。 */
  readonly hits: number
  /** 订正次数。 */
  readonly revisions: number
  /** **基线** S（小时，来自 O-010）。 */
  readonly baseHours: number
  /** **当前** S（小时，来自 O-010）。 */
  readonly currentHours: number
  /** 当前强度 0–1（来自 O-010 的 `strengthOf()`）。 */
  readonly strength: number
  /** 距离掉到地板还有多少小时。 */
  readonly remainingHours: number
  /** 预计掉到地板的时间戳。 */
  readonly fadedAt: number
  /** 三档话术；O-013 缺席时**没有**（不自算阈值）。 */
  readonly clarity?: ClarityViewLike
  /** 逐条人话解释。 */
  readonly reasons: readonly string[]
}

/** 一条「快淡了」的记忆。 */
export interface FadingItem {
  /** id。 */
  readonly id: string
  /** 正文摘要（**这里可以截断**：它只用于清单展示，不用于回写）。 */
  readonly preview: string
  /** 类别。 */
  readonly category: string
  /** 当前强度。 */
  readonly strength: number
  /** 剩余小时。 */
  readonly remainingHours: number
  /** 是否被钉住。 */
  readonly pinned: boolean
}

/** 审计报告（**只出清单，不改内容**）。 */
export interface AuditReport {
  /** 扫描时刻。 */
  readonly at: number
  /** 扫了多少条。 */
  readonly scanned: number
  /** 是否扫完（`false` 表示撞了 `scanLimit`，清单不完整）。 */
  readonly complete: boolean
  /** 各状态条数。 */
  readonly states: {
    readonly active: number
    readonly archived: number
    readonly sealed: number
  }
  /** 快淡了的（剩余低于 `fadingDays`，且未沉底未封存）。 */
  readonly fading: readonly FadingItem[]
  /** 该被「最低曝光」补一条的（超过 `resurfaceDays` 没被带出）。 */
  readonly resurfaceDue: readonly string[]
  /** 钉子条数。 */
  readonly pins: number
  /** 运行期问题。 */
  readonly issues: readonly AuditIssue[]
}

/** 归档报告。 */
export interface ArchiveReport {
  /** 归档时刻。 */
  readonly at: number
  /** 本次被沉底的 id。 */
  readonly sunk: readonly string[]
  /** 因被钉住而**续命**的 id（本插件先 `markSeen()`，故它们没被沉底）。 */
  readonly pinnedKept: readonly string[]
  /** 被钉住却仍被沉底的 id。**正常应为空**；非空说明续命失效，必须告警。 */
  readonly pinnedSunk: readonly string[]
}

/** 忘记的结果。 */
export interface ForgetOutcome {
  /** 记忆是否真的被删了（`false` = 内核说没有这条）。 */
  readonly forgotten: boolean
  /** 钉子是否被一并清掉。 */
  readonly pinRemoved: boolean
  /** 被清掉的孤儿边条数（O-015 缺席时为 `0`）。 */
  readonly edgesRemoved: number
  /** 是否清了孤儿边（O-015 缺席时为 `false`，调用方据此提示「边可能还在」）。 */
  readonly edgesCleared: boolean
}

/** 运行期发现的问题。**不致命但必须让人看见**。 */
export interface AuditIssue {
  /** 问题码。 */
  readonly code:
    | 'ensure-failed'
    | 'store-issue'
    | 'closed'
    | 'not-found'
    | 'pin-full'
    | 'pinned-sunk'
    | 'core-missing'
    | 'scan-truncated'
    | 'too-many-issues'
  /** 相关 id。 */
  readonly id?: string
  /** 中文说明。 */
  readonly detail: string
}

/** 不可用原因。 */
export type AuditUnavailableReason =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 没有记忆内核（解释与删除全部依赖它）。 */
  | 'no-core'
  /** 没有存储端口（钉子无处可放）。 */
  | 'no-store'
  /** 建表失败。 */
  | 'schema-failed'

/** 累计计数（**只在内存**）。 */
export interface AuditCounters {
  /** 解释次数。 */
  readonly explained: number
  /** 钉住次数。 */
  readonly pinned: number
  /** 拔钉次数。 */
  readonly unpinned: number
  /** 忘记次数。 */
  readonly forgotten: number
  /** 封存次数。 */
  readonly sealed: number
  /** 订正次数。 */
  readonly revised: number
  /** 归档扫描次数。 */
  readonly archivedScans: number
}

/** 统计快照。 */
export interface AuditStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: AuditUnavailableReason
  /** 后端标识。 */
  readonly provider: string
  /** 钉子条数。 */
  readonly pins: number
  /** 钉子上限。 */
  readonly pinCap: number
  /** 记忆总条数（来自 O-010）。 */
  readonly facts: number
  /** 三档话术是否可用（O-013 在不在）。 */
  readonly clarityAvailable: boolean
  /** 孤儿边清理是否可用（O-015 在不在）。 */
  readonly graphAvailable: boolean
  /** 累计计数。 */
  readonly counters: AuditCounters
  /** 最近的问题（最多 20 条）。 */
  readonly issues: readonly AuditIssue[]
}

/** 错误码。 */
export type AuditErrorCode = 'no-core' | 'no-store' | 'closed' | 'bad-argument' | 'not-found' | 'pin-full'

/** 审计错误。带稳定错误码，消费方按码分支，不必匹配中文文案。 */
export class AuditError extends Error {
  /** 错误码。 */
  readonly code: AuditErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: AuditErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'AuditError'
    this.code = code
    this.detail = detail
  }
}

/** 遗忘审计服务。 */
export interface AuditService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: AuditUnavailableReason

  /**
   * 解释一条记忆为什么变成现在这样（强度 / 半衰期 / 剩余 / 三档话术 / 逐条原因）。
   * @param id 记忆 id。
   * @param at 时间戳。
   */
  explain(id: string, at?: number): ExplainView | undefined

  /**
   * 钉住一条（上限 8，见手册 §2.6 注入块 ②）。
   * @param id 记忆 id。
   * @param note 备注。
   * @param at 时间戳。
   */
  pin(id: string, note?: string, at?: number): PinRecord

  /**
   * 拔钉。
   * @param id 记忆 id。
   */
  unpin(id: string): boolean

  /**
   * 是否被钉住（**O-013 衰减时读它**：钉住的不参与衰减）。
   * @param id 记忆 id。
   */
  isPinned(id: string): boolean

  /** 全部钉子（**O-036 注入块 ② 的取材端**）。 */
  pinned(): readonly PinRecord[]

  /**
   * 忘记：真删并写墓碑，随后清钉子与孤儿边。
   *
   * **不可逆**。调用方必须先拿到用户确认（手册 §2.4「删是不可逆的」）。
   * @param id 记忆 id。
   * @param reason 原因（写进墓碑）。
   */
  forget(id: string, reason: string): ForgetOutcome

  /**
   * 封存：不主动注入、不参与回忆，按类检索仍可能翻到。
   * @param id 记忆 id。
   * @param at 时间戳。
   */
  seal(id: string, at?: number): MemoryRecordLike

  /**
   * 订正：留 `oldText`、`revisions+1`、`S×1.3`。
   * @param id 记忆 id。
   * @param text 新正文。
   * @param at 时间戳。
   */
  revise(id: string, text: string, at?: number): MemoryRecordLike

  /** 四种删除模式的说明书（含 `sink` 为何没有方法）。 */
  deletionModes(): readonly DeletionModeDoc[]

  /**
   * 审计扫描：**只出清单，不改内容**（手册 §2.7「无损自动 + 有损人审」）。
   * @param at 时间戳。
   */
  scan(at?: number): AuditReport

  /**
   * 归档扫描：把超过窗口的记忆沉底。
   *
   * 钉住的会先 `markSeen()` 续命（它们本来就每轮都进注入），故不会被沉底。
   * @param at 时间戳。
   */
  archive(at?: number): ArchiveReport

  /** 统计快照。 */
  stats(): AuditStats
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

/**
 * O-010 记忆内核的结构对位子集。
 *
 * 只镜像本插件真的会调的方法。**`strengthOf()` 是重点**：
 * 强度与剩余时间必须由它算，本插件不重算（第二份公式 = 第二真源）。
 */
export interface MemoryCoreLike {
  readonly available: boolean
  getFact(id: string): MemoryRecordLike | undefined
  listFacts(query?: {
    readonly state?: MemoryStateLike
    readonly limit?: number
    readonly offset?: number
    readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
  }): readonly MemoryRecordLike[]
  countFacts(query?: { readonly state?: MemoryStateLike }): number
  revise(id: string, newText: string, at?: number): MemoryRecordLike
  forget(id: string, reason: string): boolean
  seal(id: string, at?: number): MemoryRecordLike
  archiveDue(at?: number): readonly string[]
  reinforce(id: string, kind: 'mention' | 'hit', at?: number): MemoryRecordLike
  markSeen(ids: readonly string[], at?: number): number
  strengthOf(record: MemoryRecordLike, at?: number): StrengthViewLike
  dueForResurfacing(days?: number, limit?: number): readonly MemoryRecordLike[]
}

/** O-013 衰减服务的结构对位子集（**只借一句话术函数**）。 */
export interface DecayLike {
  clarityOf(strength: number): ClarityViewLike
}

/** O-015 图谱服务的结构对位子集（**只借清孤儿边**）。 */
export interface GraphLike {
  forgetOf(id: string): number
}

/* ------------------------------------------------------------------ *
 * 上游存储端口的结构对位（不 import O-006 / O-007 源码）
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
  readonly issues: readonly { readonly code: string; readonly table: string; readonly column?: string; readonly detail: string }[]
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

/** 存储端口的结构对位子集（只走表级 CRUD，两个后端都能跑）。 */
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
 * 1. **`MemoryRecordLike` 与 O-010 的 `MemoryRecord` 必须逐字对齐。**
 *    结构对位是宽匹配：多一个字段不报错、少一个字段也不报错（运行期 undefined）。
 *    改 O-010 的字段时，必须同步改这里——这是 §18.5「禁止同轮互相 import」
 *    的直接代价，写在两边的文件头里。
 * 2. **`ClarityViewLike` 与 O-013 的 `ClarityView` 同上。**
 *    `band` 写成 `ClarityBandLike | string` 而不是锁死联合类型：
 *    锁死会让 O-013 加一档时本插件编译不过，而本插件根本不需要穷举它。
 * 3. **`DeletionMode` 里的 `sink` 永远没有方法。** 见文件头第 4 条。
 * ------------------------------------------------------------------ */
