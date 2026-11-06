/**
 * O-014 `ondra-memory-recall` 的对外契约。
 *
 * 定位：**「她此刻想起什么」的唯一裁决者**。O-010 管「一条记忆能活多久」，
 * O-012 管「该不该新写一条」，O-013 管「什么时候复习」；本插件只回答一件事：
 * 给定一句话，按什么顺序把记忆端上来。
 *
 * 五件必须先说清的事（每条都对应一处会静默出错的地方）：
 *
 * 1. **`dropped` 恒为 0，是类型级约束，不是口号。**
 *    手册 §12.1 的 P0 第二条是「召回不按条数砍」——`topK` / `slice` / `limit`
 *    在召回层是**物理删除**：用户说过的第十一条，模型永远看不见，而且不报错。
 *    故本契约里 `RecallResult.dropped` 的类型写成字面量 `0`，`RecallRequest`
 *    **没有** `topK` / `limit` 字段。谁想加，先改这个类型——改不动就是不该加。
 *    装不进预算的条数由 O-036 的装箱制写进段标题（「另有 N 条未展开」）。
 *
 * 2. **封存（`sealed`）永不参与回忆，且没有开关。**
 *    手册 §2.4：封存 = 不主动注入、不参与回忆，按类检索仍可能翻到。
 *    「按类检索」是 O-017 审计的入口，不是这里。本插件连一个
 *    `includeSealed` 配置项都不提供——提供就等于允许有人把封存的记忆重新灌回提示词。
 *
 * 3. **五因子的分母只算「本轮真正参与」的因子。**
 *    手册 §2.3 原话「归一化只除以参与权重的因子」。图谱因子来自 O-015，
 *    向量因子来自 O-122，两者都可能缺席。若缺席时按 0 分算并仍除以 1.00，
 *    全库分数会一起被压低，表现为「今天她什么都想不起来」——一个查不出原因的降级。
 *    故 `RecallFactors.used` 是**参与集合**，`normalized` 是它对应的权重和。
 *
 * 4. **两条硬规矩靠结构满足，不靠自觉。**
 *    手册 §2.3：①没有词面证据的条目不进候选；②新鲜度与权重只做平局裁决。
 *    - ①由「候选闸门」实现：字面通道要求与查询至少共享一个二元组，共享数为 0 的直接不入候选。
 *    - ②由权重本身实现：三个先验（图谱 .11 + 重要 .14 + 新鲜 .11）合计 **0.36**，
 *      小于关键词单项 **0.46**——先验在任何组合下都压不过词面证据，这不是约定，是算术。
 *      默认 `fuse: 'rrf'` 时更进一步：五因子完全不进主排序，只在名次分**完全相等**时裁决。
 *
 * 5. **`fuse` 是参数化的两条实现，不是同一个函数里的 `if`。**
 *    手册 §2.3 建议「增 `fuse: 'weighted' | 'rrf'`，默认 rrf，weighted 留 LEGACY」，
 *    裁决⑦ 又要求五因子加权「不能混用」。两者不矛盾：`weighted` 就是裁决⑦ 那一套
 *    （五因子加权和），`rrf` 是名次融合（`fused += 1/(k+i+1)`，`k=60`，消掉尺度混合）。
 *    两条都在 `src/fuse.ts` 里各自成函数，互不共享缓存、互不调用。
 *
 * 与 O-010 的关系：本文件**不 import** `ondra-memory-core` 的源码（§18.5），
 * 只用「结构对位」的 `MemoryCoreLike` 镜像，且只镜像真正调用的成员。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-recall`）。全仓唯一归属。 */
export const RECALL_SERVICE_KEY = 'ondra-memory-recall'

/**
 * 五因子权重（手册 §2.3 / §9.8，**已定版**）。
 *
 * 合计恰好 1.00；三个先验合计 0.36 < 关键词 0.46（见文件头第 4 条）。
 * 刻意写成冻结常量而不是配置：改权重属于「调参」，手册 §12.4 要求
 * **先有评估集（O-136）再改**，改一次跑一次。做成配置项会让人随手改。
 */
export const SPEC_WEIGHTS = Object.freeze({
  /** 语义（向量分支得分；O-122 缺席时该项不参与）。 */
  semantic: 0.18,
  /** 关键词（BM25 与罕见词通道；**唯一主导项**）。 */
  keyword: 0.46,
  /** 图谱（与种子的 1 跳最大边权；O-015 缺席时该项不参与）。 */
  graph: 0.11,
  /** 重要（`salience / 100`）。 */
  importance: 0.14,
  /** 新鲜（`0.5^(距上次想起 ÷ 当前 S)`）。 */
  freshness: 0.11,
})

/** 五因子名。 */
export type RecallFactorName = keyof typeof SPEC_WEIGHTS

/** 五因子名列表（顺序即界面渲染顺序）。 */
export const RECALL_FACTORS = ['semantic', 'keyword', 'graph', 'importance', 'freshness'] as const

/** RRF 常数（手册 §2.3：`k = 60`）。 */
export const RRF_K = 60

/** BM25 参数（手册 §2.3：`k1=1.2, b=0.75`）。 */
export const BM25_K1 = 1.2

/** BM25 长度归一项。 */
export const BM25_B = 0.75

/**
 * 四条召回通道。
 *
 * `rare` 与 `bigram` 同属字面族（手册 §2.3 实测「两路融合 50% / 64% / 0.48」）；
 * `vector` 属向量族（O-122）；`recognition` 属识别族（O-141）。
 * **两条自带语义证据的通道不要求字面重合**——它们本身就是另一种证据，
 * 「没有词面证据不进候选」约束的是字面通道，不是把另外两条通道判死刑。
 */
export const RECALL_CHANNELS = ['rare', 'bigram', 'vector', 'recognition'] as const

/** 召回通道。 */
export type RecallChannel = (typeof RECALL_CHANNELS)[number]

/** 通道族。 */
export type RecallFamily = 'lexical' | 'semantic' | 'recognition'

/** 通道 → 族。 */
export const CHANNEL_FAMILY: Readonly<Record<RecallChannel, RecallFamily>> = Object.freeze({
  rare: 'lexical',
  bigram: 'lexical',
  vector: 'semantic',
  recognition: 'recognition',
})

/** 融合模式（手册 §2.3）。`rrf` 默认，`weighted` 是裁决⑦ 那一套，留作 LEGACY。 */
export type FuseMode = 'rrf' | 'weighted'

/** 融合模式取值表。 */
export const FUSE_MODES = ['rrf', 'weighted'] as const

/**
 * 一条通道在本轮的状态。
 *
 * `absent` 与 `empty` 必须分开：`absent` 是「这条通道没有来源」（没装 O-122 / O-141），
 * `empty` 是「装了、跑了、这轮没命中」。混成一个空数组，监控分不清
 * 「能力缺失」与「今天没什么可想起的」——这正是 O-011 里 `ok` 与 `facts` 拆开的同一个理由。
 */
export interface ChannelState {
  /** 通道名。 */
  readonly channel: RecallChannel
  /** 通道族。 */
  readonly family: RecallFamily
  /** 状态。 */
  readonly status: 'used' | 'empty' | 'absent' | 'error'
  /** 命中条数。 */
  readonly items: number
  /** 中文说明（`absent` / `error` 时必有）。 */
  readonly detail?: string
}

/** 五因子拆解。 */
export interface RecallFactors {
  /** 语义因子 0–1；通道缺席为 `null`。 */
  readonly semantic: number | null
  /** 关键词因子 0–1；永远参与（字面族是本插件自带能力）。 */
  readonly keyword: number
  /** 图谱因子 0–1；O-015 缺席为 `null`。 */
  readonly graph: number | null
  /** 重要因子 0–1（`salience/100`）。 */
  readonly importance: number
  /** 新鲜因子 0–1（`0.5^(Δt/S)`）。 */
  readonly freshness: number
  /** 本轮真正参与归一化的因子。 */
  readonly used: readonly RecallFactorName[]
  /** 参与因子的权重和（归一化分母）。 */
  readonly normalized: number
}

/** 某条通道上的一次命中。 */
export interface RecallPathHit {
  /** 通道名。 */
  readonly channel: RecallChannel
  /** 名次（从 1 起）。 */
  readonly rank: number
  /** 通道原始分（BM25 分 / 向量相似度 / 识别分）。**不参与跨通道比较**。 */
  readonly raw: number
  /** RRF 贡献 `1/(k+rank)`。 */
  readonly rrf: number
}

/** 一条召回结果。 */
export interface RecallHit {
  /** 记忆 id。 */
  readonly id: string
  /** 正文。 */
  readonly text: string
  /** 摘要。 */
  readonly summary: string | null
  /** 11 类寿命类别。 */
  readonly category: string
  /** 五类标签。 */
  readonly kind: string
  /** 通道视图。 */
  readonly channel: string
  /** 最终分：`rrf` 模式是名次分，`weighted` 模式是五因子加权和。 */
  readonly score: number
  /** 五因子拆解（两种模式都算，界面与审计都要能解释）。 */
  readonly factors: RecallFactors
  /** 来自哪些通道、各是什么名次。 */
  readonly paths: readonly RecallPathHit[]
  /** 当前强度 0–1；内核不支持时为 `null`。 */
  readonly strength: number | null
  /** 是否「重要」（决定归档窗口）。 */
  readonly important: boolean
  /** 是否已沉底。 */
  readonly archived: boolean
  /** 写入时间戳。 */
  readonly createdAt: number
  /** 最近一次被检索命中的时间戳。 */
  readonly lastHitAt: number | null
}

/** 召回请求。**刻意没有 `topK` / `limit`**（见文件头第 1 条）。 */
export interface RecallRequest {
  /** 当前来信（话头）。空串合法——无话头时「按层发牌」归 O-018，不归这里。 */
  readonly text: string
  /** 时间戳；省略取当前时刻。 */
  readonly at?: number
  /** 是否把已沉底的记忆也纳入候选。默认 `false`（沉底的不该主动冒头）。 */
  readonly includeArchived?: boolean
  /** 覆盖本轮融合模式；省略用配置。 */
  readonly fuse?: FuseMode
  /** 图谱种子的条数（取字面命中的前几条当种子）。省略用配置。 */
  readonly graphSeeds?: number
  /** 只看某个主体（`user` / `self` / 人名）。省略则不限。 */
  readonly subject?: string
}

/** 不可用原因。 */
export type RecallUnavailableReason =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 没有记忆内核（O-010 未装载）。 */
  | 'no-core'
  /** 内核在位但不可用（建表失败 / 端口已关）。 */
  | 'core-unavailable'

/** 召回结果。 */
export interface RecallResult {
  /** 本轮是否正常跑完。`false` 时 `hits` 必为空且 `reason` 必有值。 */
  readonly ok: boolean
  /** 不可用原因。 */
  readonly reason?: RecallUnavailableReason
  /** 原始查询。 */
  readonly query: string
  /** 本轮时间戳。 */
  readonly at: number
  /** 命中列表（已排序）。**不做条数裁剪**。 */
  readonly hits: readonly RecallHit[]
  /**
   * 因「条数上限」被砍掉的条数。
   *
   * **类型是字面量 0**：不是「本轮恰好是 0」，是「这个字段永远只能是 0」。
   * 手册 §12.1 P0 第二条。
   */
  readonly dropped: 0
  /** 扫描过的记忆条数（全量分页扫，不设窗口）。 */
  readonly scanned: number
  /** 通过候选闸门的条数（≥ `hits.length`，差额来自去重与失效 id）。 */
  readonly candidates: number
  /** 本轮生效的融合模式。 */
  readonly fuse: FuseMode
  /** 各通道状态。 */
  readonly channels: readonly ChannelState[]
  /** 五因子权重（原样回传，便于界面解释「为什么这条排在前面」）。 */
  readonly weights: Readonly<Record<RecallFactorName, number>>
  /** 归一化分母（参与因子的权重和）。 */
  readonly normalizedBy: number
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 给人看的一句话（空查询 / 全库无候选 / 降级时必有）。 */
  readonly note?: string
}

/** 单条解释（「她为什么想起 / 为什么没想起这条」）。 */
export interface RecallExplanation {
  /** 记忆 id。 */
  readonly id: string
  /** 是否在候选里。 */
  readonly found: boolean
  /** 正文（找到时）。 */
  readonly text?: string
  /** 名次（从 1 起；未进候选为 `null`）。 */
  readonly rank: number | null
  /** 五因子拆解。 */
  readonly factors?: RecallFactors
  /** 最终分。 */
  readonly score?: number
  /** 来自哪些通道。 */
  readonly paths?: readonly RecallPathHit[]
  /** 中文说明：为什么没进候选。 */
  readonly reason: string
}

/** 索引状态（供自检与界面读）。 */
export interface RecallIndexState {
  /** 已索引的条数。 */
  readonly size: number
  /** 建索引时间戳。 */
  readonly builtAt: number
  /** 距现在多久（毫秒）。 */
  readonly ageMs: number
  /** 是否已过期（下次查询会重建）。 */
  readonly stale: boolean
}

/** 统计快照。 */
export interface RecallStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: RecallUnavailableReason
  /** 融合模式。 */
  readonly fuse: FuseMode
  /** 索引状态。 */
  readonly index: RecallIndexState
  /** 本轮累计查询次数。 */
  readonly queries: number
  /** 平均命中条数。 */
  readonly avgHits: number
  /** 平均耗时（毫秒）。 */
  readonly avgMs: number
  /** 最近一次错误文本。 */
  readonly lastError?: string
}

/** 错误码。 */
export type RecallErrorCode =
  | 'bad-request'
  /** 内核不可用。 */
  | 'no-core'
  /** 分支内部异常（已被转成通道 `error` 状态，不会外抛）。 */
  | 'branch-failed'

/** 召回错误。**只有 `bad-request` 会真的抛出去**（其余一律降级）。 */
export class RecallError extends Error {
  /** 错误码。 */
  readonly code: RecallErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: RecallErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'RecallError'
    this.code = code
    this.detail = detail
  }
}

/** 召回服务。 */
export interface RecallService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: RecallUnavailableReason

  /**
   * 召回。
   * @param request 请求。
   */
  search(request: RecallRequest): RecallResult
  /**
   * 解释某一条为什么在 / 不在结果里。
   * @param id 记忆 id。
   * @param request 与 `search` 同一个请求（用同一轮候选，避免两次结果不一致）。
   */
  explain(id: string, request: RecallRequest): RecallExplanation
  /** 索引状态。 */
  indexState(): RecallIndexState
  /** 统计快照。 */
  stats(): RecallStats
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

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/* ------------------------------------------------------------------ *
 * O-010 记忆内核的结构对位（不 import 源码）
 * ------------------------------------------------------------------ */

/** 一条记忆（只镜像本插件真正读的字段）。 */
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
  /** **当前** S（小时）：基线 × 提及因子 × 命中因子 × 订正倍数。新鲜度直接用它，不重算。 */
  readonly stabilityHours: number
  readonly timesSaid: number
  readonly hits: number
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly lastHitAt: number | null
  readonly archived: boolean
  readonly sealed: boolean
  readonly important: boolean
}

/** 查询条件（只镜像本插件用到的两个字段）。 */
export interface FactQueryLike {
  readonly state?: string
  readonly subject?: string
  readonly limit?: number
  readonly offset?: number
  readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
}

/** 强度视图（只镜像 `strength`）。 */
export interface StrengthViewLike {
  readonly strength: number
}

/** 记忆内核的结构对位子集。 */
export interface MemoryCoreLike {
  readonly available: boolean
  readonly reason?: string
  listFacts(query?: FactQueryLike): readonly MemoryRecordLike[]
  countFacts(query?: FactQueryLike): number
  getFact(id: string): MemoryRecordLike | undefined
  strengthOf?(record: MemoryRecordLike, at?: number): StrengthViewLike
}

/* ------------------------------------------------------------------ *
 * 可选分支的结构对位（O-122 向量 / O-141 recognition）
 *
 * 两者都不存在也不影响本插件可用：它们缺席时只是从「参与因子」里退出去。
 * 刻意不 import 它们的源码——§18.5 禁止跨包 import，且单独卸载它们
 * 不该让本插件编译失败。
 * ------------------------------------------------------------------ */

/** 一条外部通道命中。 */
export interface ExternalHitLike {
  /** 记忆 id。 */
  readonly id: string
  /** 相似度 / 识别分 0–1。 */
  readonly score: number
}

/** 向量分支（O-122）。 */
export interface VectorSourceLike {
  /** 可选：显式可用位。省略视为可用。 */
  readonly available?: boolean
  /**
   * 检索。
   * @param text 查询文本。
   * @param options 选项（`limit` 由本插件给，是**该分支的返回上限**，不是召回裁剪——
   *   被它挡掉的条目本来就不具备语义证据）。
   */
  search(text: string, options?: { readonly limit?: number }): readonly ExternalHitLike[]
}

/** recognition 分支（O-141）。 */
export interface RecognitionSourceLike {
  /** 可选：显式可用位。省略视为可用。 */
  readonly available?: boolean
  search(text: string, options?: { readonly limit?: number }): readonly ExternalHitLike[]
}

/* ------------------------------------------------------------------ *
 * O-015 图谱的结构对位（**本轮由本插件定契约、O-015 实现**）
 *
 * 顺序说明：O-014 在前、O-015 在后，而依赖方向是 O-014 → O-015。
 * 故契约由**消费方**先写死在这里，O-015 按它实现，两侧结构对位、人工同步。
 * 这与 §18.3「先做方定义契约」不冲突：先做方 = 先落盘的那一方，不是被依赖方。
 * ------------------------------------------------------------------ */

/** 一个邻居。 */
export interface GraphNeighborLike {
  /** 邻居记忆 id。 */
  readonly id: string
  /** 关系名（`same_topic` / `cooccur` / `surreal` / 其它注册关系）。 */
  readonly relation: string
  /** 边权 0–1。 */
  readonly weight: number
}

/** 图谱服务（只镜像本插件调用的两个成员）。 */
export interface GraphLike {
  /** 是否可用。 */
  readonly available: boolean
  /**
   * 取 1 跳邻居。
   * @param id 记忆 id。
   * @param options `minWeight` 边权门槛；`includeSurreal` 默认 false（surreal 永不进检索）。
   */
  neighbors(
    id: string,
    options?: { readonly minWeight?: number; readonly limit?: number; readonly includeSurreal?: boolean },
  ): readonly GraphNeighborLike[]
  /**
   * 批量关联度：每个 id 与任一种子的最大边权。**有就优先用它**（一次调用胜过 N 次）。
   * @param ids 待评估的 id。
   * @param seeds 种子 id。
   * @param options `minWeight` 门槛。
   */
  relatedness?(
    ids: readonly string[],
    seeds: readonly string[],
    options?: { readonly minWeight?: number },
  ): Readonly<Record<string, number>>
}
