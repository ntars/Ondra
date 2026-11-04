/**
 * O-130 `ondra-persona-evolve` 的对外契约。
 *
 * 定位：**人格的「可变量部分」唯一账本。**
 *
 * 手册 §3.1 原话：「出厂只给内分泌基线 + 表达倾向；最终性格由经历长成……
 * 人设包提供出厂基线 + 表达倾向，`persona-evolve` 在其上做**有界漂移**
 * （漂移上限 + 可回滚 + 可解释）」。
 *
 * ## 四个必须先说清的问题
 *
 * 1. **本插件不改人设正文。** 内核 5854–8623 字归 O-020/O-021。
 *    改正文等于换一个人，而「她变了」应该是「同一套设定、不同的取值」。
 *    所以本插件只动**数字**：特质分与阈值。
 * 2. **特质是「谁声明谁拥有」，本插件不内置一套心理学量表。**
 *    手册只写了「特质分」三个字，没给任何名字。硬凑五个词（大五之类）
 *    就是把一个没被裁决过的模型写进代码。所以 `defineTrait()` 由人设包/装配方声明，
 *    本插件只负责「有界、可回滚、可解释地记账」。
 * 3. **阈值不用注册、不留宿主副本。** `threshold = base × (1 + 0.6 × min(1, n/5000))`
 *    里的 `base` 属各自的持有者（O-028 的七阶、O-031 的六态、O-026 的张力线）。
 *    本插件只持久化**互动次数 `n`**，`base` 每次由调用方传入。
 *    存一份 base 就是第二真源，改一次参数会有一半地方不生效。
 * 4. **特质当前值是派生量。** 只存「基线 + 每次调整的增量」，当前值每次读取重算。
 *    存当前值会让「回滚」变成一道减法题（而减法遇到夹紧就不再可逆），
 *    派生出来的值天然可回滚、天然可解释。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。全仓唯一归属。 */
export const PERSONA_EVOLVE_SERVICE_KEY = 'ondra-persona-evolve'

/* ------------------------------------------------------------------ *
 * 手册里有的数
 * ------------------------------------------------------------------ */

/** 漂移速率（§3.5：`0.6`）。终值 = `base × (1 + 0.6 × progress)`。 */
export const DRIFT_RATE = 0.6

/** 饱和点（§3.5：互动 5000 次后不再上移）。 */
export const DRIFT_SATURATION = 5000

/**
 * 漂移上限（§3.5：**上限 +60%**）。
 *
 * 与 `DRIFT_RATE` 数值相同不是重复定义：一个是「斜率」，一个是「天花板」。
 * 写成两个常量是为了让「如果有人把斜率调成 0.8」这件事**自己暴露出来**——
 * 那时上限仍是 1.6，`factor` 会被夹到 1.6，而不是悄悄变成 1.8。
 */
export const MAX_DRIFT_RATIO = 0.6

/** 互动次数的合理上限（防脏数据把 `n` 写成 1e18 后乘法溢出成 `Infinity`）。 */
export const MAX_INTERACTIONS = 1_000_000_000

/* ------------------------------------------------------------------ *
 * 特质
 * ------------------------------------------------------------------ */

/** 特质声明（谁声明谁拥有；本插件不内置任何一条）。 */
export interface TraitDecl {
  /** 特质键，须匹配 `^[a-z][a-z0-9_-]{1,63}$`（§8.4）。 */
  readonly id: string
  /** 出厂基线（人设包给的那一个数）。 */
  readonly base: number
  /** 中文名，只给面板与日志用。 */
  readonly labelZh?: string
  /** 量程下界，默认 0。 */
  readonly min?: number
  /** 量程上界，默认 1。 */
  readonly max?: number
  /**
   * 漂移上限占量程的比例，默认取配置值（0.15）。
   *
   * 用「占量程的比例」而不是绝对值，是为了让 0–1 的特质与 0–100 的特质
   * 用同一个参数表达同一件事：0.15 在两种量程下都是「一成半」。
   */
  readonly maxDriftRatio?: number
}

/** 已登记的特质。 */
export interface TraitSpec {
  /** 特质键。 */
  readonly id: string
  /** 中文名。 */
  readonly labelZh: string
  /** 出厂基线。 */
  readonly base: number
  /** 量程下界。 */
  readonly min: number
  /** 量程上界。 */
  readonly max: number
  /** 漂移上限（= 量程 × 比例）。 */
  readonly maxDrift: number
}

/** 一次特质调整（写进漂移日志）。 */
export interface TraitDelta {
  /** 主键。 */
  readonly id: string
  /** 特质键。 */
  readonly trait: string
  /** **意图**增量（夹紧前的值；实际推动了多少见 `explainTrait`）。 */
  readonly delta: number
  /** 为什么（中文短句，进日志与面板）。 */
  readonly reason: string
  /** 谁提的（`relation` / `scar` / `gap` / `manual` …，只用于归因）。 */
  readonly source: string
  /** 时刻。 */
  readonly at: number
  /** 是否已被回滚。 */
  readonly rolledBack: boolean
}

/** 特质的对外视图。 */
export interface TraitView {
  /** 特质键。 */
  readonly id: string
  /** 中文名。 */
  readonly labelZh: string
  /** 基线。 */
  readonly base: number
  /** 当前值（派生：基线 + 未回滚增量，夹在漂移区间内）。 */
  readonly value: number
  /** 当前漂移量（`value − base`）。 */
  readonly drift: number
  /** 漂移下界（`base − maxDrift`，且不小于量程下界）。 */
  readonly floor: number
  /** 漂移上界（`base + maxDrift`，且不大于量程上界）。 */
  readonly ceiling: number
  /** 漂移上限。 */
  readonly maxDrift: number
  /** 还能往正方向走多少（负值表示已经到顶）。 */
  readonly headroom: number
  /** 是否已顶到上限。 */
  readonly saturated: boolean
  /** 参与计算的增量条数（不含已回滚）。 */
  readonly entries: number
}

/** 特质的可解释视图。 */
export interface TraitExplanation {
  /** 当前视图。 */
  readonly trait: TraitView
  /** 真正推动了值的条目（按时间升序，最多 `limit` 条）。 */
  readonly contributions: readonly TraitContribution[]
  /** 一句中文解释。 */
  readonly sentence: string
}

/** 单条贡献（意图 vs 实际）。 */
export interface TraitContribution {
  /** 条目 id。 */
  readonly id: string
  /** 时刻。 */
  readonly at: number
  /** 意图增量。 */
  readonly intended: number
  /** 实际推动量（受夹紧影响，可能小于意图，甚至为 0）。 */
  readonly applied: number
  /** 原因。 */
  readonly reason: string
}

/* ------------------------------------------------------------------ *
 * 阈值漂移
 * ------------------------------------------------------------------ */

/** 阈值漂移的对外视图（可解释）。 */
export interface ThresholdView {
  /** 调用方给的标签（只用于解释文案）。 */
  readonly key: string
  /** 调用方传进来的基线。**本插件不保存它。** */
  readonly base: number
  /** 当前互动次数。 */
  readonly interactions: number
  /** 进度 0–1（`min(1, n/5000)`）。 */
  readonly progress: number
  /** 系数（1 – 1.6）。 */
  readonly factor: number
  /** 生效阈值（`base × factor`）。 */
  readonly effective: number
  /** 相对基线的涨幅比例（0–0.6）。 */
  readonly rise: number
  /** 是否已饱和（`progress >= 1`）。 */
  readonly saturated: boolean
  /** 距离上限还剩多少「原始单位」（`base × 0.6 × (1 − progress)`）。 */
  readonly headroom: number
  /** 一句中文解释（回答「为什么以前 60 就算开心，现在要 80」）。 */
  readonly sentence: string
}

/* ------------------------------------------------------------------ *
 * 装配接口（§3.1 预留形状）
 * ------------------------------------------------------------------ */

/** 漂移日志的对外条目（`personaState.driftLog` 的元素）。 */
export interface DriftEntry {
  /** 时刻。 */
  readonly at: number
  /** 特质键。 */
  readonly trait: string
  /** 意图增量。 */
  readonly delta: number
  /** 原因。 */
  readonly reason: string
}

/**
 * 交给 `persona-assemble` 的人格状态（§3.1 原文：
 * `personaState?: { traits: Record<string, number>, driftLog: [] }`）。
 *
 * **字段名逐字对齐手册**，不改成 `traitValues` 之类更好听的名字：
 * 这个结构是要塞进别人入参的，改名就等于要求对方也改。
 */
export interface PersonaState {
  /** 特质键 → 当前值。 */
  readonly traits: Readonly<Record<string, number>>
  /** 漂移日志（时间升序）。 */
  readonly driftLog: readonly DriftEntry[]
}

/* ------------------------------------------------------------------ *
 * 入参与统计
 * ------------------------------------------------------------------ */

/** 调整特质的入参。 */
export interface TraitAdjustInput {
  /** 特质键。 */
  readonly trait: string
  /** 意图增量（正负皆可）。 */
  readonly delta: number
  /** 原因（进日志与面板；空串会被补成「未说明」）。 */
  readonly reason?: string
  /** 归因来源。 */
  readonly source?: string
  /**
   * 是否同时记一次互动。默认 `true`。
   *
   * **默认 true 是防漏，不是防重。** 一次真实的交流既改变了特质、
   * 也该算进「相处了多久」。若调用方另行调了 `noteInteraction()`，
   * 请把这里显式传 `false`——否则同一次对话被记两次，
   * 阈值会在你看不见的地方涨得快一倍。
   */
  readonly countInteraction?: boolean
}

/** 不可用原因（只有「配置关掉」这一种）。 */
export type EvolveUnavailableReason = 'disabled'

/** 累计计数（**只在内存**，重启归零）。 */
export interface EvolveCounters {
  /** 登记的特质数。 */
  readonly traits: number
  /** 收到的调整次数。 */
  readonly adjustments: number
  /** 被夹紧（意图未全额生效）的次数。 */
  readonly clamped: number
  /** 回滚的条目数。 */
  readonly rolledBack: number
  /** 记过的互动次数（本次进程内）。 */
  readonly interactions: number
  /** 回答过多少次阈值解释。 */
  readonly explained: number
}

/** 统计快照。 */
export interface EvolveStats {
  /** 是否可用。**没有存储时仍然是 true**（内存态，只是重启回到出厂）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: EvolveUnavailableReason
  /** 存储后端标识（无存储时为 `none`）。 */
  readonly storeProvider: string
  /** 持久化的互动次数（阈值漂移的唯一输入）。 */
  readonly interactions: number
  /** 当前阈值系数。 */
  readonly factor: number
  /** 漂移日志条数（含已回滚）。 */
  readonly driftEntries: number
  /** 最近一次调整时刻（0 表示还没调过）。 */
  readonly lastAdjustAt: number
  /** 累计计数。 */
  readonly counters: EvolveCounters
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/* ------------------------------------------------------------------ *
 * 服务接口
 * ------------------------------------------------------------------ */

/** 人格演化服务。 */
export interface PersonaEvolveService {
  /** 是否可用。没有存储时仍然可用（内存态）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: EvolveUnavailableReason

  /**
   * 声明一个特质（幂等：同 id 再声明一次只更新基线以外的量程参数，不重置漂移）。
   *
   * **不提供内置特质表**（见文件头第 2 条）。返回 `undefined` 表示 id 不合规。
   * @param decl 声明。
   */
  defineTrait(decl: TraitDecl): TraitView | undefined

  /** 全部特质（按 id 升序，顺序稳定）。 */
  traits(): readonly TraitView[]

  /** 取一个特质。 */
  traitOf(id: string): TraitView | undefined

  /**
   * 按经历调整一个特质。
   *
   * 会做三件事：夹紧（单次幅度 + 漂移上限）、记日志、按需记一次互动。
   * @param input 入参。
   * @param at 时刻。
   */
  adjust(input: TraitAdjustInput, at?: number): TraitView | undefined

  /**
   * 记互动次数（阈值漂移的唯一输入）。
   * @param n 增量，默认 1。
   * @param at 时刻。
   * @returns 记录后的总数。
   */
  noteInteraction(n?: number, at?: number): number

  /** 当前互动次数。 */
  interactions(): number

  /**
   * 阈值漂移：只要数。
   * @param key 标签（用于解释文案）。
   * @param base 调用方自己的基线。
   * @param at 时刻。
   */
  thresholdOf(key: string, base: number, at?: number): number

  /**
   * 阈值漂移：可解释视图（手册 §3.5 点名要求 `explainThreshold()`）。
   * @param key 标签。
   * @param base 调用方自己的基线。
   * @param at 时刻。
   */
  explainThreshold(key: string, base: number, at?: number): ThresholdView

  /** 漂移日志（时间降序；默认只给未回滚的）。 */
  driftLog(options?: { readonly includeRolledBack?: boolean; readonly limit?: number }): readonly TraitDelta[]

  /** 特质级解释（含每条贡献的意图与实际）。 */
  explainTrait(id: string, limit?: number): TraitExplanation | undefined

  /**
   * 回滚一条增量。
   * @param entryId 条目 id。
   * @param at 时刻。
   */
  rollback(entryId: string, at?: number): boolean

  /**
   * 回滚一个特质的全部未回滚增量（回到出厂）。
   * @param traitId 特质键。
   * @param at 时刻。
   * @returns 回滚条数。
   */
  rollbackTrait(traitId: string, at?: number): number

  /**
   * 人格状态（交给 O-023 的 `assemble()`）。
   * @param at 时刻。
   */
  personaState(at?: number): PersonaState

  /** 统计快照。 */
  stats(): EvolveStats
}

/* ------------------------------------------------------------------ *
 * 与邻座的结构对位（§18.5：不 import 源码）
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

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum'
  readonly default: unknown
  readonly doc: string
  readonly min?: number
  readonly max?: number
  readonly values?: readonly string[]
  readonly advancedOnly?: boolean
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位（只够建三张表）
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
  get(table: string, key: RowLike): RowLike | undefined
  select(table: string, query?: SelectQueryLike): RowLike[]
  count(table: string, where?: readonly FilterLike[]): number
  update(table: string, key: RowLike, patch: RowLike): number
  delete(table: string, key: RowLike): number
}
