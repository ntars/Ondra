/**
 * O-141 `ondra-memory-recognition` 的对外契约。
 *
 * 定位：**第三条检索分支——不用向量，把索引读给一个小模型听。**
 *
 * 手册 §2.3 原话：「全索引进 prompt（500 条≈6k token，走 prefix cache）+ 小模型挑 slug +
 * `[[links]]` 邻域游走；命中 ~2ms，未命中整索引+小模型 ~0.4s；与向量分支并列，默认仍倒排。」
 *
 * 五件必须先说清的事（每条都对应一处会静默出错的地方）：
 *
 * 1. **`search()` 是同步的，所以它只走「确定性那 2ms」。**
 *    O-014 的 `RecognitionSourceLike.search()` 返回数组而不是 Promise（那一条已 `done`，
 *    本轮不许改）。而手册里的 recognition 是两段：确定性命中（2ms）+ 未命中交小模型（0.4s）。
 *    两段塞不进一个同步方法，故本插件**拆成两个成员**：
 *    - `search()`：同步、纯本地、参与 O-014 的融合，只做确定性识别；
 *    - `recognize()`：异步、走 O-035 网关、由注入层在「同步没命中」时补一次。
 *    代价写进 README「已知限制」第 1 条：O-014 的 recognition 通道拿不到小模型的结果。
 *    这是**上游契约缺口**，不是本插件偷懒——改它要改已 `done` 的 O-014，按 §16.3 不动。
 *
 * 2. **索引块是「稳定前缀」，里面不许出现任何易变内容。**
 *    §8.5 要求只追加增量。故块内**只有索引行**：没有时间戳、没有条数、没有「另有 N 条」
 *    这种会随库变化的尾巴。`builtAt` / `omitted` / `revision` 全在**元数据**里，
 *    由调用方决定怎么说。任何一个数字漏进 `text`，缓存命中率就归零。
 *
 * 3. **索引行按 `seq` 升序，`seq` 是 `createdAt` 的排名——所以旧块恒是新块的前缀。**
 *    按分数或按 slug 字典序排都会让新条目插到中间，等于每加一条记忆就重写整块前缀。
 *    按 `createdAt` 排名则新条目永远追加在尾部，天然满足「只追加增量」。
 *    订正与删除仍会让中间变化，那时如实报 `rebuilt: true`，不假装缓存有效。
 *
 * 4. **封存（`sealed`）永不进索引，且没有开关。**
 *    手册 §2.4 与 O-014 的同一铁律：封存 = 不主动注入、不参与回忆。
 *    索引是「把记忆读给模型听」，比检索更容易泄露，所以这条在本插件里更硬：
 *    `includeArchived` 可配，`sealed` 恒排除且**不存在**对应配置项。
 *
 * 5. **模型给的 slug 必须能在索引里查到，查不到就是幻觉，丢弃并计数。**
 *    小模型会照着「像 slug 的样子」编造（`food-9z9z`）。不过滤就会把一条不存在的 id
 *    交给 O-014，而 O-014 会用它去 `getFact()` 拿到 `undefined`——整轮召回悄悄少一条，
 *    日志里一切正常。`hallucinated` 就是为这个准备的数字，它必须能被看到。
 *
 * 与 O-014 的关系：本文件**不 import** `ondra-memory-recall` 的源码（§18.5），
 * 只按它的 `RecognitionSourceLike` 做**结构对位**（`{ id, score }` + 同步 `search`）。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-recognition`）。全仓唯一归属。 */
export const RECOGNITION_SERVICE_KEY = 'ondra-memory-recognition'

/** 命名硬约束（手册 §8.4）：服务键 / 工具名 / 配置键 / slug 一律照此校验。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 记忆 id 的形状（O-010 生成 `m-<12 位 hex>`；这里只做宽松校验，不假设长度）。 */
export const MEMORY_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 邻域游走的圈权重（第 0 圈是种子本身）。
 *
 * 手册 §2.3 在「漫无目的联想」里给了三圈权重 `[1, 0.55, 0.3, 0.16]`，
 * 但**没有**给 recognition 的 `[[links]]` 游走单独定权重。此处借用同一组数，
 * 属 derived——理由是两者都是「沿关系边扩散、越远越不像」，共用一组数不会让口径分叉。
 * 若将来手册给它单独的值，改这里一处即可。
 */
export const RING_WEIGHTS: readonly number[] = Object.freeze([1, 0.55, 0.3, 0.16])

/**
 * 11 类寿命类别 → 三字母短码。
 *
 * slug 要短：`food-a1b2` 比 `person-a1b2` 省 3 个字符，而 500 条 × 每字符都是真金白银的
 * token。短码只影响 slug 的可读性，不影响任何语义——slug 只是索引入口，正文才是证据。
 */
export const CATEGORY_CODES: Readonly<Record<string, string>> = Object.freeze({
  watch: 'wat',
  daily: 'dly',
  misc: 'msc',
  feeling: 'fel',
  food: 'fod',
  place: 'plc',
  event: 'evt',
  self: 'slf',
  study: 'std',
  person: 'prs',
  promise: 'prm',
})

/** 三字母短码用不到时的兜底码（未知类别不进索引，但类型上留一个口子）。 */
export const CATEGORY_FALLBACK_CODE = 'unk'

/**
 * 一条识别的命中。
 *
 * **结构必须与 O-014 的 `ExternalHitLike` 对位**：只有 `id` 与 `score`，且 `score` 是
 * 0–1 的有限数。多一个字段无害（O-014 的 `sanitize()` 只读这两个），少一个字段就等于
 * 该条被静默丢掉。
 */
export interface RecognitionHit {
  /** 记忆 id。 */
  readonly id: string
  /** 识别分 0–1。同一轮内可比，跨轮不可比。 */
  readonly score: number
}

/**
 * 索引条目（内部结构与对外诊断共用一份，不另立第二套字段名）。
 *
 * `grams` 是**建索引时算好的**二元组集合，不在查询时重算：查询一次要扫全库，
 * 每条重算一遍二元组会把 2ms 变成 200ms。
 */
export interface IndexEntry {
  /** 记忆 id。 */
  readonly id: string
  /** 稳定短名（`<类别码>-<id 里 4 位 hex>`），订正后不变。 */
  readonly slug: string
  /** 稳定序号（`createdAt` 的排名，从 1 起）。排序只看它。 */
  readonly seq: number
  /** 识别触发词（2–6 字，最多 `triggersPerEntry` 个）。 */
  readonly triggers: readonly string[]
  /** 正文二元组集合（查询时做重合比）。 */
  readonly grams: readonly string[]
  /** 正文归一化后的全文（`[[links]]` 解析与兜底包含判断用）。 */
  readonly text: string
  /** 条目内出现的 `[[links]]` 目标原文。 */
  readonly links: readonly string[]
  /** 写入时间戳（排序依据、诊断用）。 */
  readonly createdAt: number
  /** 显著度（超预算时决定先丢谁）。 */
  readonly salience: number
}

/**
 * 索引块的对外形状。
 *
 * `text` 是唯一会被塞进 prompt 的字段，且**只含索引行**（见文件头第 2 条）。
 * 其余字段都是元数据，给界面与自检读。
 */
export interface IndexBlock {
  /** 索引正文（稳定前缀，可直接作为小模型调用的 system 前段）。 */
  readonly text: string
  /** 块内容哈希（FNV-1a 32 位，8 位 hex）。用来判断「变了没有」。 */
  readonly revision: string
  /** 进块的条目数。 */
  readonly entries: number
  /** 因预算或条数上限没进块的条目数。**不在 `text` 里**（见文件头第 2 条）。 */
  readonly omitted: number
  /** 字符数。 */
  readonly chars: number
  /** 估算 token 数（中文 1 字≈1 token，ASCII 4 字符≈1 token；估算，非精确分词）。 */
  readonly estTokens: number
  /** 建块时间戳（元数据，不进 `text`）。 */
  readonly builtAt: number
  /** 相对调用方给的 `since` 是否没有变化（`true` 时 `text` 为空串）。 */
  readonly unchanged: boolean
  /**
   * 本次是否**重写了整块**（相对上一次构建，中间有行被改动或删除）。
   * `true` 意味着调用方手上的旧前缀已经对不上，缓存不会再命中。
   */
  readonly rebuilt: boolean
}

/** 索引状态（供自检与界面读）。 */
export interface RecognitionIndexState {
  /** 进索引的条数。 */
  readonly entries: number
  /** 被预算挡在外面的条数。 */
  readonly omitted: number
  /** 建索引时间戳。 */
  readonly builtAt: number
  /** 距现在多久（毫秒）。 */
  readonly ageMs: number
  /** 是否已过期（下次查询会重建）。 */
  readonly stale: boolean
  /** 内容哈希。 */
  readonly revision: string
  /** 估算 token。 */
  readonly estTokens: number
}

/** 不可用原因。**分开命名**，别让「没装」与「装了但坏了」长一个样。 */
export type RecognitionUnavailableReason =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 没有记忆内核（O-010 未装载）。 */
  | 'no-core'
  /** 内核在位但不可用（建表失败 / 端口已关）。 */
  | 'core-unavailable'

/** 小模型那一路的失败原因（与「不可用」是两回事：这里服务本身是好的）。 */
export type PickFailureReason =
  /** 记忆内核缺席或不可用（整个服务使不上劲）。 */
  | 'service-unavailable'
  /** 没有模型网关（O-035 未装载）。 */
  | 'no-gateway'
  /** 网关在位但不可用。 */
  | 'gateway-unavailable'
  /** 索引为空，没有东西可挑。 */
  | 'empty-index'
  /** 配置里关掉了小模型那一路（`pickEnabled=off`）。 */
  | 'pick-disabled'
  /** 调用或解析过程抛错（C3：已转成返回值，不外抛）。 */
  | 'pick-failed'

/** 一次小模型识别的结果。 */
export interface RecognitionOutcome {
  /** 是否正常跑完。`false` 时 `hits` 必为空且 `reason` 必有值。 */
  readonly ok: boolean
  /** 失败原因。 */
  readonly reason?: PickFailureReason
  /** 原始问题。 */
  readonly query: string
  /** 命中（已过滤幻觉、已按顺序给分）。 */
  readonly hits: readonly RecognitionHit[]
  /** 模型一共点了几行（含幻觉，去重前）。 */
  readonly picked: number
  /** 点了但索引里查不到的条数（模型编的）。**这个数字必须能被看到。** */
  readonly hallucinated: number
  /** 本轮用的索引块元数据（不含 `text`，免得把 6k token 复制给调用方）。 */
  readonly block: {
    readonly entries: number
    readonly omitted: number
    readonly revision: string
    readonly estTokens: number
  }
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 给人看的一句话（失败或降级时必有）。 */
  readonly note?: string
}

/** 单条解释（「这条为什么被认出来 / 为什么没有被认出来」）。 */
export interface RecognitionExplanation {
  /** 记忆 id。 */
  readonly id: string
  /** 是否在索引里（不在 = 根本读不到它，不是「没认出来」）。 */
  readonly indexed: boolean
  /** slug。 */
  readonly slug?: string
  /** 是否被本轮命中。 */
  readonly found: boolean
  /** 识别分。 */
  readonly score?: number
  /** 怎么被认出来的：`slug` / `trigger` / `gram` / `ring` / null。 */
  readonly via: 'slug' | 'trigger' | 'gram' | 'ring' | null
  /** 中文说明。 */
  readonly reason: string
}

/** 统计快照。 */
export interface RecognitionStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: RecognitionUnavailableReason
  /** 索引状态。 */
  readonly index: RecognitionIndexState
  /** 累计同步查询次数。 */
  readonly searches: number
  /** 累计同步命中条数。 */
  readonly hits: number
  /** 累计小模型调用次数。 */
  readonly picks: number
  /** 累计小模型调用失败次数。 */
  readonly pickFailures: number
  /** 累计被丢弃的幻觉 slug 数。 */
  readonly hallucinated: number
  /** 索引重建次数。 */
  readonly rebuilds: number
  /** 最近一次错误文本。 */
  readonly lastError?: string
}

/** 错误码。 */
export type RecognitionErrorCode =
  /** 入参不合法（空查询之外的问题，如 `limit` 为负）。 */
  | 'bad-request'
  /** 索引构建失败（内核查询抛错）。 */
  | 'build-failed'
  /** 分支内部异常（已转成降级，不会外抛）。 */
  | 'branch-failed'

/** 识别错误。**只有 `bad-request` 会真的抛出去**（其余一律降级）。 */
export class RecognitionError extends Error {
  /** 错误码。 */
  readonly code: RecognitionErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: RecognitionErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'RecognitionError'
    this.code = code
    this.detail = detail
  }
}

/** `search()` 的选项。 */
export interface SearchOptions {
  /**
   * 返回上限（由 O-014 给，默认 200）。
   *
   * 这**不是**召回裁剪：被它挡掉的条目本来就没被识别出来，不构成「有证据却被砍」。
   * O-014 的 `dropped` 恒为 0 约束的是它自己那一层，不是本分支。
   */
  readonly limit?: number
}

/** `recognize()` 的选项。 */
export interface RecognizeOptions {
  /** 覆盖本轮返回上限。 */
  readonly limit?: number
  /** 覆盖本轮输出 token 上限。 */
  readonly maxTokens?: number
  /** 覆盖首块超时。 */
  readonly timeoutMs?: number
  /** 调用方取消信号（透传给网关）。 */
  readonly signal?: AbortSignal
}

/** `indexBlock()` 的选项。 */
export interface BlockOptions {
  /** 调用方手上那一版的 `revision`；相同则返回空 `text`。 */
  readonly since?: string
}

/** 识别服务。 */
export interface RecognitionService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: RecognitionUnavailableReason

  /**
   * 同步识别（确定性命中，不调模型）。参与 O-014 的融合。
   * @param text 当前来信（话头）。
   * @param options 选项。
   */
  search(text: string, options?: SearchOptions): readonly RecognitionHit[]

  /**
   * 异步识别（整索引进 prompt，小模型挑 slug，再沿 `[[links]]` 走一圈）。
   * 由注入层在「同步没命中」时补一次；不进 O-014 的同步融合（见文件头第 1 条）。
   * @param text 当前来信。
   * @param options 选项。
   */
  recognize(text: string, options?: RecognizeOptions): Promise<RecognitionOutcome>

  /**
   * 取索引块（稳定前缀）。
   * @param options `since` 为调用方手上那一版的 revision。
   */
  indexBlock(options?: BlockOptions): IndexBlock

  /** 索引状态。 */
  indexState(): RecognitionIndexState

  /**
   * 解释某一条。
   * @param id 记忆 id。
   * @param text 查询文本（与 `search` 同一个，避免两次结果不一致）。
   */
  explain(id: string, text: string): RecognitionExplanation

  /** 统计快照。 */
  stats(): RecognitionStats
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
  resolve(sectionId: string, section?: { readonly user?: Readonly<Record<string, unknown>> }):
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
  readonly createdAt: number
  readonly archived: boolean
  readonly sealed: boolean
}

/** 查询条件（只镜像本插件用到的几个字段）。 */
export interface FactQueryLike {
  readonly state?: 'active' | 'archived' | 'sealed'
  readonly limit?: number
  readonly offset?: number
  readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
}

/** 记忆内核的结构对位子集。 */
export interface MemoryCoreLike {
  readonly available: boolean
  readonly reason?: string
  listFacts(query?: FactQueryLike): readonly MemoryRecordLike[]
  countFacts(query?: FactQueryLike): number
  getFact(id: string): MemoryRecordLike | undefined
}

/* ------------------------------------------------------------------ *
 * O-035 模型网关的结构对位（不 import 源码）
 * ------------------------------------------------------------------ */

/** 一次非流式调用的结果（只镜像本插件读的字段）。 */
export interface GatewayCompletionLike {
  readonly text: string
  readonly finishKind: string
  readonly sourceId?: string
}

/** 模型网关（只镜像 `complete()` 与可用位）。 */
export interface LlmGatewayLike {
  readonly available: boolean
  readonly reason?: string
  complete(request: {
    readonly messages: readonly object[]
    readonly system?: string
    readonly temperature?: number
    readonly maxTokens?: number
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  }): Promise<GatewayCompletionLike>
}
