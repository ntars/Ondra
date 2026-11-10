/**
 * O-122 `ondra-memory-vector` 的对外契约：**向量检索分支 + 混合检索**。
 *
 * 定位（手册 §12.3「记忆检索」行）：**2-gram 倒排 + 时间半衰（O-014）是默认底座**，
 * 本插件是可选的语义增强分支。O-014 已经在消费侧写死了本插件的形状
 * （`VectorSourceLike`：`available?` + `search(text, {limit})`），本文件与之**结构对位**——
 * 刻意不 import O-014 的源码（§15.5 / §18.5），形状分叉时 O-014 的 `as` 赋值处立刻报错。
 *
 * 与 O-014 的分工边界（写死，防越界）：
 *
 * 1. **本插件不替代 O-014 的五因子**。`search()` 只回答「语义上像不像」，
 *    不做重要性、新鲜度、图谱因子的融合——那是 O-014 的归一化职责。
 *    本插件内部的 `hybridSearch()`（字面 + 向量 RRF）只服务**本分支内部**的模式切换，
 *    不是 O-014 的替代品；O-014 仍按它自己的通道融合口径消费 `search()`。
 * 2. **本插件只读记忆内核**。`sync()` 走 O-010 的 `listFacts()` 拉取，
 *    绝不写记忆表、不改 `hits`、不改任何 O-010 的状态。
 * 3. **嵌入器可注入**。默认内置确定性哈希嵌入（零依赖、可复现、离线），
 *    真向量模型（手册 §9.8 提到的 bge-m3 1024 维）通过 `setEmbedder()` 注入——
 *    仓内没有已确认的 embedding 服务键，本插件**不编造 API**，只留端口。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-vector`）。全仓唯一归属。 */
export const VECTOR_SERVICE_KEY = 'ondra-memory-vector'

/**
 * 嵌入维度。哈希嵌入的桶数，也是注入外部嵌入器时的期望维度校验值。
 * 128 是「区分度够 + 建索引快」的工程折中（手册的 bge-m3 是 1024 维，注入时以实际为准）。
 */
export const EMBED_DIM = 128

/**
 * 模式自动切换阈值（台账第 16 组・裁决④口径）：
 * 文档数 < 300 纯字面；300–1000 混合；> 1000 向量 + ANN。
 * 两个数字都来自台账原文，不是本插件发明的。
 */
export const MODE_THRESHOLD_LITERAL = 300
export const MODE_THRESHOLD_VECTOR = 1000

/** 检索模式。`auto` 按文档数在另外三档间自动切换（默认）。 */
export type VectorMode = 'auto' | 'literal' | 'hybrid' | 'vector'

/** 实际生效的分支（`mode()` 返回值，供自检与界面读，不许黑箱切换——手册 §12.2）。 */
export type EffectiveMode = 'literal' | 'hybrid' | 'vector'

/** 一条命中。与 O-014 的 `ExternalHitLike` 结构对位：`id` + 0–1 的 `score`。 */
export interface VectorHit {
  /** 记忆 id。 */
  readonly id: string
  /** 相似度 0–1（已夹紧）。 */
  readonly score: number
}

/**
 * O-122 提供给消费方的服务面。
 *
 * `available` 与 `search()` 两个成员与 O-014 的 `VectorSourceLike` **必须逐字对位**；
 * 其余是本插件的扩展面（同步、混合检索、统计）。
 */
export interface VectorService {
  /**
   * 是否可用。`false` 的情形：配置关闭、嵌入器不可用、同步彻底失败。
   * O-014 的探测逻辑把它视为「缺席」，语义因子退出归一化。
   */
  readonly available: boolean
  /** 不可用原因（available=false 时有值）。 */
  readonly reason?: string

  /**
   * 向量检索（O-014 的消费入口）。按**当前生效模式**返回语义相似的记忆。
   * @param text 查询文本。
   * @param options `limit` 是本分支返回上限（不是召回裁剪——被挡掉的条目本来就没有语义证据）。
   */
  search(text: string, options?: { readonly limit?: number }): readonly VectorHit[]

  /**
   * 混合检索（本分支内部的字面 + 向量 RRF 融合，供想一步拿结果的高级消费方用）。
   * **不是 O-014 的替代品**——五因子归一化仍在 O-014。
   */
  hybridSearch(text: string, options?: { readonly limit?: number }): readonly VectorHit[]

  /** 当前生效分支（`mode: auto` 时按文档数实时判定，可观测）。 */
  mode(): EffectiveMode

  /**
   * 从记忆内核全量同步一次索引（按 `id + 文本指纹` 增量，只重嵌变化的条目）。
   * 装载时若配置了 `autoSync` 会自动跑一次；之后由消费方按需再调（本插件不装定时器）。
   * @returns 本次新增 / 更新 / 删除的条数。
   */
  sync(): VectorSyncResult

  /** 手动喂一条（记忆内核缺席时的兜底数据源）。 */
  upsert(id: string, text: string): void
  /** 手动移除一条。 */
  remove(id: string): void
  /** 索引内文档数。 */
  count(): number

  /** 注入外部嵌入器（bge-m3 等真向量模型的入口）。传入 null 恢复内置哈希嵌入。 */
  setEmbedder(embedder: EmbedderLike | null): void

  /** 运行期统计。 */
  stats(): VectorStats
}

/** 一次同步的结果。 */
export interface VectorSyncResult {
  /** 新嵌入的条数。 */
  readonly added: number
  /** 文本变化而重嵌入的条数。 */
  readonly updated: number
  /** 内核里已不存在而移除的条数。 */
  readonly removed: number
  /** 同步后索引内总数。 */
  readonly total: number
}

/** 运行期统计，供 `ondra-startup-check` 与自检读取。 */
export interface VectorStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 当前生效分支。 */
  readonly effectiveMode: EffectiveMode
  /** 配置的模式。 */
  readonly configuredMode: VectorMode
  /** 索引内文档数。 */
  readonly docs: number
  /** 嵌入维度。 */
  readonly dim: number
  /** 当前嵌入器：内置哈希（`hash`）或外部注入（`external`）。 */
  readonly embedder: 'hash' | 'external'
  /** 索引是否持久化到存储端口。 */
  readonly persisted: boolean
  /** 累计同步次数。 */
  readonly syncs: number
  /** 累计检索次数。 */
  readonly searches: number
  /** 累计重嵌入次数（文本变化）。 */
  readonly reembeds: number
  /** 最后一次错误（同步 / 检索），没有则 null。 */
  readonly lastError: string | null
}

/**
 * 外部嵌入器端口。**仓内没有已确认的 embedding 服务键，本插件不编造 API**——
 * 想用真向量模型（bge-m3 等）由宿主侧注入本接口；不注入就用内置哈希嵌入。
 */
export interface EmbedderLike {
  /**
   * 把一批文本变成向量。
   * @param texts 文本数组。
   * @returns 与输入等长的向量数组；每条向量维度须与 `EMBED_DIM` 一致（注入时校验）。
   */
  embed(texts: readonly string[]): readonly Float64Array[]
}

/**
 * O-010 记忆内核的结构对位子集（只镜像本插件真正读的成员；写法沿 O-014 的镜像）。
 */
export interface MemoryRecordLike {
  /** 记忆 id。 */
  readonly id: string
  /** 原文（嵌入的对象）。 */
  readonly text: string
  /** 最近激活时间（参与指纹：文本没变但时间变了不重嵌）。 */
  readonly lastSeenAt: number
}

/** 拉取查询（只镜像本插件用的字段）。 */
export interface FactQueryLike {
  readonly limit?: number
  readonly offset?: number
}

/** 记忆内核的结构对位子集。 */
export interface MemoryCoreLike {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: string
  /**
   * 拉取记忆列表。
   * @param query 分页。
   */
  listFacts(query?: FactQueryLike): readonly MemoryRecordLike[]
  /**
   * 计数。
   * @param query 分页。
   */
  countFacts(query?: FactQueryLike): number
}

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位子集（O-006 / O-007 / O-121 三后端通用）
 *
 * `provider` 刻意收窄成 `string`：三个后端各自把 provider 定成自己的字面量
 * （'sqlite' | 'memory' | 'jsonl'），本插件只读它做日志，不参与类型运算——
 * 收窄成联合反而会跟某个后端的镜像对不上。
 * ------------------------------------------------------------------ */

/** 列声明（镜像 O-006 的子集）。 */
export interface StoreColumnSpec {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'
  readonly notNull?: boolean
  readonly primaryKey?: boolean
}

/** 表声明（镜像 O-006 的子集）。 */
export interface StoreTableSpec {
  readonly name: string
  readonly columns: readonly StoreColumnSpec[]
}

/** 行（镜像 O-006 的子集）。 */
export type StoreRow = Record<string, unknown>

/** 过滤条件（镜像 O-006 的子集）。 */
export interface StoreFilter {
  readonly column: string
  readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'is-null' | 'not-null'
  readonly value?: unknown
}

/** 三个存储后端的结构对位子集：本插件只做「存向量、读向量」这一件事。 */
export interface StorePortLike {
  readonly provider: string
  readonly state: 'open' | 'degraded' | 'closed'
  ensureTable(spec: StoreTableSpec): unknown
  tableExists(table: string): boolean
  upsert(table: string, row: StoreRow): void
  delete(table: string, key: StoreRow): number
  select(table: string, query?: { readonly where?: readonly StoreFilter[]; readonly limit?: number }): StoreRow[]
  count(table: string, where?: readonly StoreFilter[]): number
}

/** 错误码。 */
export type VectorErrorCode = 'bad-argument' | 'embed-failed' | 'dim-mismatch' | 'not-available'

/** 端口错误。带稳定错误码，消费方可按码分支。 */
export class VectorError extends Error {
  /** 错误码。 */
  readonly code: VectorErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: VectorErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'VectorError'
    this.code = code
    this.detail = detail
  }
}
