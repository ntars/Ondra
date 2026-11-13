/**
 * O-012 `ondra-memory-dedupe` 的对外契约。
 *
 * 定位：**写入之前的判重裁决**。手册 §2.2 的「五分类判重」在这里落地：
 * `add / merge / append / conflict / drop`。
 *
 * 三件必须先说清的事：
 *
 * 1. **判重发生在写入之前，不是写入之后。**
 *    先写再合并，合并就只能退化成「删一条、改一条」——日志里再也看不出
 *    原本是两条独立的事实，事后也无法回答「我的记忆怎么少了一条」。
 *    故本插件的主入口是 `judge()`（纯判定，不写库）与 `settle()`（按裁决写库），
 *    而不是「扫出重复再合并」。存量重复只出**清单**（`scan()`），不改内容
 *    （手册 §2.7「无损自动 + 有损人审」）。
 *
 * 2. **阈值只认一个口径：包含度 0.4（手册 §12.3 裁决⑥）。**
 *    手册别处还出现过「余弦 0.85」「Jaccard 0.75」，那是别的场景的标定值。
 *    两套阈值并存，会让同一对记忆时而合并、时而建边——裁决⑥ 的原话就是
 *    「口径不同不可互搬」。本插件全程只用**字符二元组包含度**一把尺子。
 *
 * 3. **合并绝不等于遗忘。**
 *    合并时**不调** `forget()`：它会写墓碑，而墓碑的语义是「用户要求忘记」，
 *    一旦写了，同样的正文以后**永远写不进来**。把「合并」误当「遗忘」，
 *    代价是这条信息在未来的所有对话里都无法再被记起。
 *    故合并只改主条（`revise()` 会把旧正文存进 `oldText`，可回溯），不删任何东西。
 *
 * 与 O-010 的关系：本文件**不 import** `ondra-memory-core` 的源码（§18.5），
 * 只用「结构对位」的 `MemoryCoreLike` 镜像，且只镜像本插件真正调用的成员。
 * 代价是两边需人工同步——镜像得越少，漂移面越小。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-dedupe`）。全仓唯一归属。 */
export const DEDUPE_SERVICE_KEY = 'ondra-memory-dedupe'

/** 五分类（手册 §2.2 原文顺序）。 */
export const DEDUPE_ACTIONS = ['add', 'merge', 'append', 'conflict', 'drop'] as const

/** 判重动作。 */
export type DedupeAction = (typeof DEDUPE_ACTIONS)[number]

/**
 * 冲突处置策略。
 *
 * - `report-only`（默认，最稳）：**照常写入新条**，旧条一个字不动，冲突只进裁决与日志；
 * - `seal-old`：封存旧条再写入新条——这是手册 §2.3「双时态事实」在
 *   **没有 `valid_time` 字段时**的等价动作（旧值退出活跃位、新值成为唯一活跃值）。
 *
 * 为什么默认是 `report-only` 而不是「不写」：冲突判定是启发式，
 * 「今天吃了面条」与「今天吃了米饭」在字面上就是同一句式换了一个值。
 * 若判成冲突就**不写**，一次误判就等于把一条真事实永久丢掉；
 * 而「写进去 + 报出来」最坏只是两条并存（可被 O-017 审计与人审收拢）。
 * 代价不对称，所以默认选可逆的那一侧。
 */
export type ConflictPolicy = 'report-only' | 'seal-old'

/** 一条候选（与待写入正文的相似度）。 */
export interface DedupeCandidate {
  /** 候选记忆 id。 */
  readonly id: string
  /** 包含度：`|A∩B| / min(|A|,|B|)`，A/B 为字符二元组集合。 */
  readonly containment: number
  /** 新颖度：待写入正文里**旧条没有**的二元组占比。0 表示全是复述。 */
  readonly novelty: number
  /**
   * 旧条没有的二元组**个数**（绝对量）。
   *
   * 为什么新颖度之外还要一个绝对量：长句里加三个字，占比可能只有 0.2，
   * 但那三个字可能是「三岁了」这种真信息；短句里加两个字，占比就到 0.33。
   * **只用占比会漏掉长句的补充，只用绝对量会放过短句的补充**，两个一起用才分得开。
   */
  readonly freshGrams: number
  /**
   * 是否命中「槽位替换」（同一句式、只换了一个值）。
   *
   * 这个信号与包含度**互相独立**：`我28岁` 与 `我30岁` 的二元组包含度是 0
   * （每个二元组都不同），但它们是同一个槽位上的两个取值。
   * 只用包含度收集候选，这类冲突永远检不出来。
   */
  readonly slotMatch: boolean
  /** 候选正文。 */
  readonly text: string
  /** 11 类寿命类别（原样带出，便于调用方核对「是不是同一类事」）。 */
  readonly category: string
  /** 五类标签。 */
  readonly kind: string
  /** 主体。 */
  readonly subject: string | null
  /** 被提起次数（判定主条时用不到，只做展示）。 */
  readonly timesSaid: number
  /** 订正次数。 */
  readonly revisions: number
  /** 写入时间戳。 */
  readonly createdAt: number
}

/** 冲突细节。**只报告差异点，不替人下结论**。 */
export interface DedupeConflict {
  /** 冲突的旧条 id。 */
  readonly targetId: string
  /** 两条正文的否定词个数（`[旧, 新]`）。 */
  readonly polarity: readonly [number, number]
  /** 数字集合是否不一致。 */
  readonly digitsDiffer: boolean
  /** 中文说明，直接给人看。 */
  readonly detail: string
}

/** 裁决结果。**纯数据，不带任何副作用**。 */
export interface DedupeVerdict {
  /** 五分类之一。 */
  readonly action: DedupeAction
  /** 目标记忆 id（`add` 时没有）。 */
  readonly targetId?: string
  /** 与目标条的包含度（`add` 时为 0）。 */
  readonly containment: number
  /**
   * 是否属于「规则判不准、值得交模型再问一句」的灰区。
   *
   * 本插件**自己从不调模型**：手册 §2.2 的「候选 ≤5 条才交模型」是一道
   * **成本闸门**，闸门在这里（`maxCandidates`），真正发请求的是调用方。
   * 理由是提示词与解析已在 O-011 有一份，再造一份就是第二真源。
   */
  readonly needsModel: boolean
  /** 判定理由（中文，逐条可读，直接进日志与审计）。 */
  readonly reasons: readonly string[]
  /** `merge` 时建议写入主条的新正文。 */
  readonly mergedText?: string
  /** `conflict` 时的差异点。 */
  readonly conflict?: DedupeConflict
}

/** 判重入参（与 O-010 的 `FactInput` 字段对齐，但全部可选，缺省交给 O-010 补）。 */
export interface DedupeRequest {
  /** 待写入正文。 */
  readonly text: string
  /** 11 类寿命类别。 */
  readonly category?: string
  /** 五类标签。 */
  readonly kind?: string
  /** 主体。 */
  readonly subject?: string
  /** 通道。 */
  readonly channel?: string
  /** 摘要。 */
  readonly summary?: string
  /** 显著度（不传就让 O-010 按打分表算，**别在这里算第二份**）。 */
  readonly salience?: number
  /** 唤醒度。 */
  readonly arousal?: number
  /** 来源原文 id。 */
  readonly rawId?: string
  /** 四类引文。 */
  readonly evidence?: readonly EvidenceRefLike[]
  /** 写入时间；省略取当前时刻。 */
  readonly at?: number
}

/** 落库结果。 */
export interface DedupeOutcome {
  /** 裁决。 */
  readonly verdict: DedupeVerdict
  /** 是否真的写入了新条。 */
  readonly written: boolean
  /** 写入或改动后的记录（`add` / `merge` 有；`append` / `drop` / 只报告冲突时没有）。 */
  readonly record?: MemoryRecordLike
  /** 决策日志是否落盘（没有存储端口时为 false，不影响判定本身）。 */
  readonly logged: boolean
}

/** 存量疑似重复组（**只报告，不合并**）。 */
export interface DedupeGroup {
  /** 组内最早写入的那条 id（作锚点）。 */
  readonly anchorId: string
  /** 组内成员（含锚点）。 */
  readonly members: readonly DedupeCandidate[]
  /** 组内最高包含度。 */
  readonly maxContainment: number
}

/** 不可用原因。 */
export type DedupeUnavailableReason =
  /** 记忆内核服务缺席（O-010 没装载或没注册）。 */
  | 'no-core'
  /** 记忆内核在，但自己报不可用。 */
  | 'core-unavailable'
  /** 配置里关掉了。 */
  | 'disabled'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface DedupeCounters {
  /** 判过多少次。 */
  readonly judged: number
  /** 落过多少次库。 */
  readonly settled: number
  /** 写入新条次数。 */
  readonly added: number
  /** 合并次数。 */
  readonly merged: number
  /** 复述加固次数。 */
  readonly appended: number
  /** 丢弃次数。 */
  readonly dropped: number
  /** 冲突次数。 */
  readonly conflicts: number
}

/** 统计快照，供 `ondra-startup-check` 与成长面板读取。 */
export interface DedupeStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DedupeUnavailableReason
  /** 记忆内核后端标识（透传）。 */
  readonly coreProvider: string
  /** 是否在记决策日志。 */
  readonly logging: boolean
  /** 日志表行数。 */
  readonly logRows: number
  /** 累计计数。 */
  readonly counters: DedupeCounters
  /** 最近一次错误（成功一次就清空，避免旧错常驻）。 */
  readonly lastError?: string
}

/** 判重服务。 */
export interface DedupeService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DedupeUnavailableReason

  /**
   * 取候选（按包含度降序，最多 `maxCandidates` 条）。
   * @param text 待写入正文。
   * @param limit 条数上限，省略用配置。
   */
  candidates(text: string, limit?: number): readonly DedupeCandidate[]

  /**
   * 纯判定，**不写库、不改库**。
   * @param request 入参。
   */
  judge(request: DedupeRequest): DedupeVerdict

  /**
   * 判定并按裁决落库。
   * @param request 入参。
   */
  settle(request: DedupeRequest): DedupeOutcome

  /**
   * 存量疑似重复清单（**只报告，不改内容**，手册 §2.7「夜巡只出清单」）。
   * @param limit 参与比对的记录条数，省略用配置 `maxScanRows`。
   */
  scan(limit?: number): readonly DedupeGroup[]

  /** 统计快照。 */
  stats(): DedupeStats
}

/** 错误码。 */
export type DedupeErrorCode = 'no-core' | 'core-unavailable' | 'bad-request' | 'write-failed'

/** 判重错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class DedupeError extends Error {
  /** 错误码。 */
  readonly code: DedupeErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: DedupeErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'DedupeError'
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
  /** 数字读数的量纲（天 / 分钟 / 毫秒 / 字 / 轮）。空表示无量纲。 */
  readonly unit?: string
}

/* ------------------------------------------------------------------ *
 * O-010 记忆内核的结构对位（不 import 源码）
 *
 * 只镜像本插件真正调用的 9 个成员。刻意**不用** `listFacts` 的
 * `orderBy: 'salience'` 之类用不上的分支，也不用 `archiveDue` ——
 * 归档是 O-013 的活，本插件不碰状态位。
 * ------------------------------------------------------------------ */

/** 引文（与 O-010 的 `EvidenceRef` 同形）。 */
export interface EvidenceRefLike {
  readonly source: string
  readonly quote: string
  readonly messageIndex?: number
}

/** 一条事实（只镜像本插件读到的字段）。 */
export interface MemoryRecordLike {
  readonly id: string
  readonly kind: string
  readonly category: string
  readonly channel: string
  readonly text: string
  readonly summary: string | null
  readonly subject: string | null
  readonly salience: number
  readonly arousal: number
  readonly stabilityBaseHours: number
  readonly stabilityHours: number
  readonly timesSaid: number
  readonly hits: number
  readonly revisions: number
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly archived: boolean
  readonly sealed: boolean
}

/** 写入入参（与 O-010 的 `FactInput` 同形）。 */
export interface FactInputLike {
  readonly id?: string
  readonly rawId?: string
  readonly kind: string
  readonly category: string
  readonly text: string
  readonly summary?: string
  readonly subject?: string
  readonly channel?: string
  readonly salience?: number
  readonly arousal?: number
  readonly evidence?: readonly EvidenceRefLike[]
  readonly at?: number
}

/** 查询条件（与 O-010 的 `FactQuery` 同形，只镜像用到的键）。 */
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

/** 记忆内核的结构对位子集。 */
export interface MemoryCoreLike {
  readonly available: boolean
  readonly reason?: string
  addFact(input: FactInputLike): MemoryRecordLike
  getFact(id: string): MemoryRecordLike | undefined
  listFacts(query?: FactQueryLike): readonly MemoryRecordLike[]
  countFacts(query?: FactQueryLike): number
  revise(id: string, newText: string, at?: number): MemoryRecordLike
  seal(id: string, at?: number): MemoryRecordLike
  reinforce(id: string, kind: 'mention' | 'hit', at?: number): MemoryRecordLike
  tombstoned(text: string): boolean
  stats(): { readonly provider: string; readonly available: boolean }
}

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位（只用于决策日志，不是硬依赖）
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

/** 存储端口的结构对位子集（只够建一张日志表）。 */
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
  select(table: string, query?: SelectQueryLike): RowLike[]
  count(table: string, where?: readonly FilterLike[]): number
  delete(table: string, key: RowLike): number
}
