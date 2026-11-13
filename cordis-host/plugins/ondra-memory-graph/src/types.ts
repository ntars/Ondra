/**
 * O-015 `ondra-memory-graph` 的对外契约。
 *
 * 定位：**记忆之间「谁和谁有关」的唯一真源**。它只碰一张表（`memory_link`），
 * 一个字节都不写 `memory_fact`——那是 O-010 的地盘（裁决⑪：条目衰减归 O-013，
 * 边的权重归本插件，两不混）。
 *
 * 五件必须先说清的事：
 *
 * 1. **边是双向的，但只存一行。**
 *    写库时把两端 id 按字典序排成规范方向（`from < to`），查询时查两个方向。
 *    存两行会带来「只更新了一边」的经典事故：A→B 权重 0.8、B→A 还是 0.15，
 *    而扩散恰好走了另一边。
 *
 * 2. **边的权重是「步进式」衰减，所以必须有 `decayed_at` 游标。**
 *    手册 §9.7 夜跑第 2 步原话「必须带 `decayed_at` 游标，否则会重复乘算成 0.5^N」。
 *    这条与 O-013 恰好相反：O-013 的条目强度是闭式函数 `0.5^(Δt/S)`，扫一百次也一样，
 *    所以它**不该**有游标；本插件的边是「每 90 天 ×0.5」的步进，扫一百次就是 ×0.5^100。
 *    两个插件对同一件事采取相反做法，是因为衰减形状不同——照抄会错。
 *
 * 3. **`surreal` 边永不进检索。**
 *    荒诞联想的边权只有 0.03，它的用途是「让她偶尔冒出不相干的话」，
 *    一旦被召回当成相关性证据，就会变成「她开始胡说」。
 *    故 `neighbors()` 默认排除它，`relatedness()` 也排除它，且**没有开关**。
 *
 * 4. **枢纽度上限 40，建链与扩散共用同一个常量。**
 *    手册 §9.7 原话「枢纽度上限 40（建链与扩散共用同一常量）」。
 *    分两处各写一个数，会出现「建的时候允许 40、扩散时按 30 截」这种自相矛盾。
 *
 * 5. **手册只逐字给出三个关系名，台账写「四边」。**
 *    `same_topic`（0.72–0.85，每次 +0.05）、`cooccur`（0.15，每次 +0.10）、
 *    `surreal`（0.03，永不进检索）是手册与语料里能查到的全部。
 *    第四条边的名字**在手册与语料里都不存在**，本插件不编一个假名字：
 *    `relation` 是**开放字符串**，`RELATION_PRESETS` 只登记这三个已知预设，
 *    第四个名字一旦裁决下来，加一条预设即可（`registerPreset()` 也可运行期加）。
 *
 * 与 O-014 的关系：本文件**不 import** `ondra-memory-recall` 的源码（§18.5）。
 * O-014 的 `GraphLike` 是本契约的子集（`available` + `neighbors()` + `relatedness()`），
 * 两侧结构对位、人工同步。**契约由 O-014 先落盘**（它先做、且是消费方），
 * 本插件按它实现——这是「先做方定义契约」在本轮的具体形态。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-graph`）。全仓唯一归属。 */
export const GRAPH_SERVICE_KEY = 'ondra-memory-graph'

/** 边表名。 */
export const TABLE_LINK = 'memory_link'

/**
 * 三个已知关系的预设（手册 §9.7）。
 *
 * `init` 是初值，`step` 是每次加固的增量，`step` 为 0 表示不加固（`surreal`）。
 */
export const RELATION_PRESETS = Object.freeze({
  /** 同主题：初值 0.72–0.85，每次 +0.05。本插件取下沿 0.72 作默认。 */
  same_topic: Object.freeze({ init: 0.72, step: 0.05, label: '同主题', surreal: false }),
  /** 共现：初值 0.15，每次 +0.10。 */
  cooccur: Object.freeze({ init: 0.15, step: 0.1, label: '共现', surreal: false }),
  /** 荒诞联想：0.03，永不进检索、永不加固、剪枝豁免。 */
  surreal: Object.freeze({ init: 0.03, step: 0, label: '荒诞联想', surreal: true }),
})

/** 已知关系名。`relation` 字段本身接受任意合法字符串（见文件头第 5 条）。 */
export type KnownRelation = keyof typeof RELATION_PRESETS

/**
 * 扩散门槛。手册 §9.7 原值 0.4，与 O-014 的 `graphMinWeight` **共用同一个数**。
 *
 * 注意这条门槛与 `cooccur` 初值 0.15 的关系：共现边要加固 3 次
 * （0.15 + 0.10×3 = 0.45）才越过门槛。这是刻意的——
 * 「见过一次」不足以成为「想起来」的依据。
 */
export const DIFFUSE_MIN_WEIGHT = 0.4

/** 枢纽度上限。建链与扩散共用（手册 §9.7 原话）。 */
export const HUB_CAP = 40

/** 边衰减间隔（天）。 */
export const DECAY_INTERVAL_DAYS = 90

/** 边衰减系数。 */
export const DECAY_FACTOR = 0.5

/** 软剪枝下界：权重低于它压到 `PRUNE_TO`。 */
export const PRUNE_BELOW = 0.05

/** 软剪枝落点。 */
export const PRUNE_TO = 0.01

/** 扩散圈权重（手册 §2.3「漫无目的联想」：从一词扩散 1–3 圈，圈权重 `[1, 0.55, 0.3, 0.16]`）。 */
export const RING_WEIGHTS = Object.freeze([1, 0.55, 0.3, 0.16])

/** 一条边（读出来的视图）。 */
export interface GraphEdge {
  /** 边 id（`from~to~relation`，规范方向）。 */
  readonly id: string
  /** 起点（字典序小的一端）。 */
  readonly from: string
  /** 终点（字典序大的一端）。 */
  readonly to: string
  /** 关系名。 */
  readonly relation: string
  /** 权重 0–1。 */
  readonly weight: number
  /** 被加固次数。 */
  readonly hits: number
  /** 最近一次被加固 / 被扩散用到的时间戳。 */
  readonly lastFiredAt: number
  /** 上次衰减结算的时间戳（**游标**，见文件头第 2 条）。 */
  readonly decayedAt: number
  /** 建边时间戳。 */
  readonly createdAt: number
  /** 是否人工批准（软剪枝豁免）。 */
  readonly approved: boolean
  /** 是否荒诞联想边（永不进检索）。 */
  readonly surreal: boolean
}

/** 建边入参。 */
export interface LinkInput {
  /** 一端记忆 id。 */
  readonly from: string
  /** 另一端记忆 id。 */
  readonly to: string
  /** 关系名；省略用 `same_topic`。 */
  readonly relation?: string
  /**
   * 显式权重。省略则按预设：新建用 `init`，已存在则 `+step`。
   *
   * `same_topic` 的初值区间是 0.72–0.85，本插件取下沿 0.72 当默认；
   * 调用方认为两条「极像」时可以显式给 0.85。
   */
  readonly weight?: number
  /** 是否人工批准（软剪枝豁免）。 */
  readonly approved?: boolean
  /** 时间戳。 */
  readonly at?: number
}

/** 建边结果。 */
export interface LinkResult {
  /** 落库后的边。**被拒时没有**（不返回一条假边，免得调用方以为建成功了）。 */
  readonly edge?: GraphEdge
  /** 这次是新建还是加固。被拒时为 `false`。 */
  readonly created: boolean
  /** 被拒原因（`hub-full` / `bad-endpoint` / `self-loop` / `bad-relation` / `edge-limit` / `unavailable`）。 */
  readonly refusal?: 'hub-full' | 'bad-endpoint' | 'self-loop' | 'bad-relation' | 'edge-limit' | 'unavailable'
}

/** 一个邻居。 */
export interface Neighbor {
  /** 邻居记忆 id。 */
  readonly id: string
  /** 关系名。 */
  readonly relation: string
  /** 边权 0–1。 */
  readonly weight: number
  /** 是否荒诞联想边。 */
  readonly surreal: boolean
}

/** 一圈扩散结果。 */
export interface DiffuseRing {
  /** 第几圈（1 起；0 是种子本身，不单列）。 */
  readonly ring: number
  /** 本圈的条目。 */
  readonly items: readonly DiffuseItem[]
}

/** 一条扩散结果。 */
export interface DiffuseItem {
  /** 记忆 id。 */
  readonly id: string
  /** 从哪个节点扩散来的。 */
  readonly via: string
  /** 关系名。 */
  readonly relation: string
  /** 边权。 */
  readonly weight: number
  /** 折扣后的分：`圈权重 × 边权`（**不沿路径连乘**，见 README 已知限制）。 */
  readonly score: number
  /** 第几圈。 */
  readonly ring: number
}

/** 扩散结果。 */
export interface DiffuseResult {
  /** 种子。 */
  readonly seeds: readonly string[]
  /** 各圈。 */
  readonly rings: readonly DiffuseRing[]
  /** 访问过的全部 id（含种子），用于调用方去重。 */
  readonly visited: readonly string[]
  /** 实际扩散了几圈。 */
  readonly ringsDone: number
}

/** 运行期发现的问题。**不致命但必须让人看见**。 */
export interface GraphIssue {
  /** 问题码。 */
  readonly code:
    | 'ensure-failed'
    | 'store-issue'
    | 'closed'
    | 'bad-relation'
    | 'bad-endpoint'
    | 'self-loop'
    | 'hub-full'
    | 'edge-limit'
    | 'too-many-issues'
  /** 相关边 id。 */
  readonly id?: string
  /** 中文说明。 */
  readonly detail: string
}

/** 不可用原因。 */
export type GraphUnavailableReason =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 没有存储端口。 */
  | 'no-store'
  /** 建表失败。 */
  | 'schema-failed'
  /** 端口已关闭。 */
  | 'closed'

/** 统计快照。 */
export interface GraphStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GraphUnavailableReason
  /** 后端标识。 */
  readonly provider: string
  /** 边总数。 */
  readonly edges: number
  /** 各关系条数（只列已知的三个）。 */
  readonly byRelation: Readonly<Record<KnownRelation, number>>
  /** 荒诞联想边条数。 */
  readonly surreal: number
  /** 人工批准条数。 */
  readonly approved: number
  /** 平均权重。 */
  readonly avgWeight: number
  /** 累计计数（**只在内存**）。 */
  readonly counters: {
    readonly links: number
    readonly reinforced: number
    readonly refused: number
    readonly decayed: number
    readonly pruned: number
    readonly unlinked: number
  }
  /** 最近的问题（最多 20 条）。 */
  readonly issues: readonly GraphIssue[]
}

/** 错误码。 */
export type GraphErrorCode = 'no-store' | 'closed' | 'bad-argument' | 'write-failed'

/** 图谱错误。 */
export class GraphError extends Error {
  /** 错误码。 */
  readonly code: GraphErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: GraphErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'GraphError'
    this.code = code
    this.detail = detail
  }
}

/** 图谱服务。 */
export interface GraphService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GraphUnavailableReason

  /**
   * 建边或加固。
   * @param input 入参。
   */
  link(input: LinkInput): LinkResult
  /**
   * 删边。
   * @param from 一端。
   * @param to 另一端。
   * @param relation 关系名；省略删两个方向的所有关系。
   */
  unlink(from: string, to: string, relation?: string): number
  /**
   * 取 1 跳邻居。
   * @param id 记忆 id。
   * @param options `minWeight` 门槛；`includeSurreal` 默认 false；`limit` 默认 `HUB_CAP`。
   */
  neighbors(
    id: string,
    options?: { readonly minWeight?: number; readonly includeSurreal?: boolean; readonly limit?: number },
  ): readonly Neighbor[]
  /**
   * 批量关联度：每个 id 与任一种子的最大边权（**O-014 的图谱因子就用这个**）。
   * @param ids 待评估的 id。
   * @param seeds 种子 id。
   * @param options `minWeight` 门槛。
   */
  relatedness(
    ids: readonly string[],
    seeds: readonly string[],
    options?: { readonly minWeight?: number },
  ): Readonly<Record<string, number>>
  /**
   * 1 跳（可到 3 跳）扩散。
   * @param seedIds 种子。
   * @param options `maxRings` 圈数（默认 1，上限 3）；`minWeight` 门槛。
   */
  diffuse(
    seedIds: readonly string[],
    options?: { readonly maxRings?: number; readonly minWeight?: number },
  ): DiffuseResult
  /**
   * 边衰减：每满 90 天 ×0.5，按 `decayed_at` 游标结算。
   * @param at 时间戳。
   * @returns 被改动的边数。
   */
  decay(at?: number): number
  /**
   * 软剪枝：权重 <0.05 压到 0.01，`surreal` 与 `approved` 豁免。
   * @param at 时间戳。
   * @returns 被改动的边数。
   */
  prune(at?: number): number
  /**
   * 记忆被 `forget()` 之后清边（避免孤儿边继续参与扩散）。
   * @param id 记忆 id。
   * @returns 删掉的边数。
   */
  forgetOf(id: string): number
  /**
   * 取一条边。
   * @param from 一端。
   * @param to 另一端。
   * @param relation 关系名。
   */
  edgeOf(from: string, to: string, relation: string): GraphEdge | undefined
  /** 统计快照。 */
  stats(): GraphStats
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
  /** 数字读数的量纲（天 / 分钟 / 毫秒 / 字 / 轮）。空表示无量纲。 */
  readonly unit?: string
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

/** O-010 记忆内核的结构对位子集（只用来验端点存在）。 */
export interface MemoryCoreLike {
  readonly available: boolean
  getFact(id: string): { readonly id: string } | undefined
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

/** 存储端口的结构对位子集（只走表级 CRUD，不用 `raw`，两个后端都能跑）。 */
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
