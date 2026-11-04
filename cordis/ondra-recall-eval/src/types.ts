/**
 * O-136 `ondra-recall-eval` 的对外契约。
 *
 * 定位：**「参数改动到底让召回变好还是变坏」的唯一裁判**。
 * 手册 §12.4 原话：「20–40 条真实问法评估集（含换说法）先行：recall@1 / recall@3 / MRR /
 * 端到端成功率；改一次跑一次；报告落盘。**没有评估集，所有参数调整都是玄学。**」
 *
 * 本插件只做**测量**，一个排序参数都不改。它不是调参器，是秤。
 *
 * 六件必须先说清的事（每条都对应一处会安静出错的地方）：
 *
 * 1. **指标口径必须写死在类型里，不能靠注释约定。**
 *    `recall@k` 有两个流行定义：①命中真值数 ÷ 真值总数（trec_eval 的 `recall`）
 *    ②至少命中一条即 1（常被写成 `hit@k`，但很多人也叫它 recall）。
 *    单真值题上两者相等，多真值题上可以差一倍。若不在报告里分开写，
 *    「这一版 62%，上一版 31%」可能只是换了口径。故 `MetricBlock` 同时给
 *    `recall` 与 `hitRate` 两张表，谁也不顶替谁。
 *
 * 2. **MRR 用「无命中计 0 且进分母」的 trec_eval 口径，不剔除失败题。**
 *    剔除失败题的 MRR 是「只统计答对的题答得多靠前」，天然偏高，
 *    正是本项目最怕的那种「越做数字越好看」的指标。`reciprocalRank`
 *    的类型是 `number`（不是 `number | null`），就是为了让「没命中」
 *    必须落成 0 而不能落成「跳过」。
 *
 * 3. **`ambiguous` 与 `missing` 必须从分母剔除，且必须报出来。**
 *    评估集里写 `expect: ["寿司"]`，而库里两条正文都含「寿司」——那不是
 *    「召回失败」，是**题目本身不可判**。把不可判的题按 0 分算，
 *    一次库重建就会让 recall 从 0.7 掉到 0.1，而没有任何人改过代码。
 *    故解析结果独立成 `ExpectResolution`，被剔除的题在 `skipped` 里逐条列出。
 *
 * 4. **`rrf` 模式下不能给编造题设分数阈值。**
 *    `rrf` 的 `score` 是名次分 `1/(k+rank)`，只表达「排第几」，不表达「有多像」；
 *    给它设 0.05 的置信阈值就是给一个没有量纲的数编了一个意义。
 *    故 `fabricatedJudge` 在 `rrf` 下被**强制**成 `no-hit`，并在报告里
 *    标 `judgedBy: 'no-hit (forced by rrf)'`。这是 §12「能融就融，不能融就分支」
 *    里「同一接口、按分支独立判据」的一次落地。
 *
 * 5. **报告必须带参数快照，否则两份报告不可比。**
 *    「改一次跑一次」的前提是「一次只改一个变量」。报告里写 `EngineSnapshot`
 *    （融合模式、k、BM25 参数、图谱种子…）+ `corpus.size` + `ks`，
 *    对比时先比快照：**参数不同就明说「这不是同一把尺子」**，
 *    而不是直接甩一个 Δ 让人误读。
 *
 * 6. **报告落盘必须脱敏。**
 *    评估报告会写到 `user/eval/`，而它会带每题命中的记忆 id 与查询原文。
 *    查询是用户亲口说的话，正文更是。故报告**不写记忆正文**（只写 id），
 *    查询按 `queryMaxChars` 截断，且 `redactQueries` 可整体关掉落盘里的原文。
 *
 * 与 O-014 的关系：本文件**不 import** `ondra-memory-recall` 的源码（§18.5），
 * 只用「结构对位」的 `RecallLike` 镜像，且只镜像真正调用的成员。
 */

/** 本插件注册的服务键（连字符，非 `ondra:recall-eval`）。全仓唯一归属。 */
export const EVAL_SERVICE_KEY = 'ondra-recall-eval'

/** 题目种类。 */
export const CASE_KINDS = ['real', 'paraphrase', 'fabricated'] as const

/**
 * 题目种类。
 *
 * - `real`：用户真实说过的话（手册要求 20–40 条的主体）；
 * - `paraphrase`：同一件事换个说法（手册实测「14 条含 6 条换说法」，
 *   这是唯一能测出「只会字面匹配」的题类）；
 * - `fabricated`：**库里根本没有的事**（二人版「20 题 + 5 题编造题」）。
 *   它测的不是召回，是**分心**：她会不会为一句没发生过的话硬凑一条记忆。
 */
export type CaseKind = (typeof CASE_KINDS)[number]

/** 报告基线状态。决定这份报告能不能用来调参。 */
export const REPORT_BASELINES = ['measured', 'template-unfilled', 'insufficient', 'empty-set'] as const

/**
 * 报告基线状态。
 *
 * - `measured`：可以直接用来判断「改好了还是改坏了」；
 * - `template-unfilled`：题集里还有 `needsRewrite` 或有空问法，指标不可用于调参；
 * - `insufficient`：题数少于 `minCases`（手册 20），结论只能参考；
 * - `empty-set`：一道可判题都没有，报告只有框架没有数字。
 *
 * 刻意做成枚举而不是 `ok/not-ok`：`insufficient` 与 `template-unfilled`
 * 是两种完全不同的「不能用」，混成一个布尔，看报告的人不知道该补题还是该改题。
 */
export type ReportBaseline = (typeof REPORT_BASELINES)[number]

/** 真值解析方式。 */
export const EXPECT_RESOLUTIONS = ['id', 'text', 'missing', 'ambiguous', 'none'] as const

/**
 * 真值解析方式。
 *
 * - `id`：`expectIds` 精确命中；
 * - `text`：按文本指纹唯一命中（**跨库重建后仍有效的那一种**）；
 * - `missing`：库里找不到这条真值（题失效，剔除）；
 * - `ambiguous`：指纹命中多条（题不可判，剔除）；
 * - `none`：编造题，本来就没有真值（不是错误）。
 */
export type ExpectResolution = (typeof EXPECT_RESOLUTIONS)[number]

/** 匹配方式取值表。 */
export const MATCH_KINDS = ['id', 'exact', 'partial', 'none'] as const

/**
 * 匹配方式（与 `ExpectResolution` **正交**：前者说「怎么找到的」，后者说「找没找到」）。
 *
 * 为什么必须单独一个字段：`text` 匹配内部还有两种天差地别的质量。
 *
 * - `exact`：指纹与某条记忆正文归一化后**完全相等**。可信。
 * - `partial`：指纹只是某条正文的**子串**。这时候会出事：
 *   `28` 会命中 `1280`，`喜欢猫` 会命中 `不喜欢猫`。
 *
 * 子串误命中不会报错，只会让 `recall` 悄悄变高——而「评估数字虚高」
 * 正是本插件最该防的东西（比数字难看糟得多）。故把它做成报告里的一列，
 * 并在提示里统计占比：片段匹配一多，就说明指纹该写长了。
 */
export type MatchKind = (typeof MATCH_KINDS)[number]

/** 磁盘上的单题定义（用户手写的那一份）。 */
export interface EvalCaseSpec {
  /** 题号，题集内唯一。 */
  readonly id: string
  /** 种类；缺省 `real`。 */
  readonly kind?: CaseKind
  /** 问法。空串表示「模板还没填」（会被判成 `template-unfilled`）。 */
  readonly query: string
  /**
   * 真值文本指纹（记忆正文片段）。
   *
   * **优先于 `expectIds`** 的语义在这里：写正文比写 id 更耐用——
   * id 会随库重建、搬迁、导入导出而变，正文不会。
   */
  readonly expect?: readonly string[]
  /** 真值记忆 id（精确匹配，最快也最脆）。 */
  readonly expectIds?: readonly string[]
  /** `paraphrase` 指向的原题题号（只用于报告分组，不参与计分）。 */
  readonly of?: string
  /** 备注。 */
  readonly note?: string
  /** 模板标记：`seed()` 生成的占位题会带它，填完手动删掉或改成 false。 */
  readonly needsRewrite?: boolean
}

/** 磁盘上的题集。 */
export interface EvalSetSpec {
  /** 格式版本；缺省 1。 */
  readonly version?: number
  /** 题集名。 */
  readonly name?: string
  /** 题目。 */
  readonly cases: readonly EvalCaseSpec[]
}

/** 解析后的题（真值已落成记忆 id）。 */
export interface ResolvedCase {
  /** 题号。 */
  readonly id: string
  /** 种类。 */
  readonly kind: CaseKind
  /** 问法。 */
  readonly query: string
  /** 解析出的真值 id 列表。 */
  readonly expected: readonly string[]
  /** 解析方式。 */
  readonly resolution: ExpectResolution
  /** 匹配方式（`partial` 意味着可能误命中，见 `MatchKind`）。 */
  readonly match: MatchKind
  /** 原题指向。 */
  readonly of?: string
  /** 备注。 */
  readonly note?: string
}

/** 单题结果。 */
export interface CaseResult {
  /** 题号。 */
  readonly id: string
  /** 种类。 */
  readonly kind: CaseKind
  /** 问法（已按 `redactQueries` 处理）。 */
  readonly query: string
  /** 真值条数（`fabricated` 恒为 0，`missing`/`ambiguous` 也记 0）。 */
  readonly expected: number
  /** 解析方式。 */
  readonly resolution: ExpectResolution
  /** 匹配方式（`partial` 时这一题的「命中」可能不是那条记忆，见 `MatchKind`）。 */
  readonly match: MatchKind
  /** 前 `recordHits` 条命中 id（**只存 id，不存正文**）。 */
  readonly hits: readonly string[]
  /** 首个真值的名次（从 1 起）；无命中为 `null`。 */
  readonly firstRank: number | null
  /** 倒数名次 `1/firstRank`；无命中为 0（trec_eval 口径，不跳过）。 */
  readonly reciprocalRank: number
  /** 各 k 的 recall（命中真值数 ÷ 真值总数）。键是 k 的字符串形式。 */
  readonly recallAt: Readonly<Record<string, number>>
  /** 各 k 的 hit（是否至少命中一条）。键是 k 的字符串形式。 */
  readonly hitAt: Readonly<Record<string, boolean>>
  /** 编造题专用：是否「没有为她没听过的事硬凑」；非编造题为 `null`。 */
  readonly avoided: boolean | null
  /** 本轮最高分；无命中为 `null`。 */
  readonly topScore: number | null
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 补充说明（不可判原因等）。 */
  readonly note?: string
}

/** 一块指标（整体或按种类分组共用同一个形状）。 */
export interface MetricBlock {
  /** 本块题数（含被剔除的）。 */
  readonly cases: number
  /** 真正进入分母的题数。 */
  readonly graded: number
  /** 各 k 的 recall 均值。键是 k 的字符串形式。 */
  readonly recall: Readonly<Record<string, number>>
  /** 各 k 的 hitRate 均值。键是 k 的字符串形式。 */
  readonly hitRate: Readonly<Record<string, number>>
  /** MRR（无命中计 0，进分母）。 */
  readonly mrr: number
  /** 编造题的「没硬凑」比例；本块没有编造题为 `null`。 */
  readonly avoidRate: number | null
}

/** 参数快照（对比报告的前提）。 */
export interface EngineSnapshot {
  /** 融合模式（取自召回结果的 `fuse`，**不猜**）。 */
  readonly fuse: string
  /** RRF 常数。 */
  readonly rrfK: number | null
  /** BM25 k1。 */
  readonly bm25K1: number | null
  /** BM25 b。 */
  readonly bm25B: number | null
  /** 本轮生效的参与因子（取自召回结果的 `normalizedBy` 与 `weights`）。 */
  readonly weights: Readonly<Record<string, number>>
  /** 归一化分母。 */
  readonly normalizedBy: number | null
  /** 各通道状态摘要（`rare=used` 这种）。 */
  readonly channels: readonly string[]
}

/** 报告。 */
export interface EvalReport {
  /** 格式版本。 */
  readonly version: 1
  /** 生成时间戳（毫秒）。 */
  readonly generatedAt: number
  /** 基线状态。 */
  readonly baseline: ReportBaseline
  /** 题集名。 */
  readonly setName: string
  /** 库容（评估时刻）。 */
  readonly corpus: { readonly size: number }
  /** 参数快照。 */
  readonly engine: EngineSnapshot
  /** 用到的 k 列表。 */
  readonly ks: readonly number[]
  /** 整体指标。 */
  readonly overall: MetricBlock
  /** 按种类分组的指标。 */
  readonly byKind: Readonly<Record<CaseKind, MetricBlock>>
  /** 逐题结果。 */
  readonly cases: readonly CaseResult[]
  /** 被剔除的题（`missing` / `ambiguous`），逐条给原因。 */
  readonly skipped: readonly SkippedCase[]
  /** 人读提示。 */
  readonly notes: readonly string[]
  /** 总耗时（毫秒）。 */
  readonly elapsedMs: number
}

/** 被剔除的题。 */
export interface SkippedCase {
  /** 题号。 */
  readonly id: string
  /** 原因码。 */
  readonly resolution: ExpectResolution
  /** 中文原因。 */
  readonly reason: string
}

/** 一个指标的变化。 */
export interface MetricDelta {
  /** 指标名（`recall@1` / `mrr` / `avoidRate`）。 */
  readonly key: string
  /** 上一次的值；不可比为 `null`。 */
  readonly before: number | null
  /** 本次的值。 */
  readonly after: number
  /** 变化量；不可比为 `null`。 */
  readonly delta: number | null
  /** 方向判断（`avoidRate` 越高越好，其余同理，都是「越高越好」）。 */
  readonly better: 'up' | 'down' | 'same' | 'unknown'
}

/** 对比结果。 */
export interface CompareResult {
  /** 是否比成了。 */
  readonly ok: boolean
  /** 不可比原因。 */
  readonly reason?: 'no-previous' | 'no-store' | 'unreadable'
  /** 上一次报告的时间戳。 */
  readonly beforeAt?: number
  /** 本次报告的时间戳。 */
  readonly afterAt?: number
  /** 参数快照是否一致（false 时 Δ 不可直接归因于参数）。 */
  readonly sameEngine: boolean
  /** 库容是否一致（false 时 Δ 可能只是「库里多了十条记忆」）。 */
  readonly sameCorpus: boolean
  /** 指标变化。 */
  readonly deltas: readonly MetricDelta[]
  /** 人读结论。 */
  readonly note: string
}

/** 运行请求。 */
export interface RunRequest {
  /** 覆盖题集名。 */
  readonly setName?: string
  /** 覆盖 `writeReport`：false 表示只算不落盘。 */
  readonly write?: boolean
  /**
   * 内存题集。给了它就不读磁盘，也不落盘。
   *
   * 存在的理由：没有 `ondra-path-layout` 时评估仍然要能跑（指标与路径无关），
   * 以及上层（如 `ondra-startup-check`）可以在不碰用户文件的前提下自测一次。
   */
  readonly cases?: readonly EvalCaseSpec[]
  /** 附注（写进报告的 `notes`）。 */
  readonly notes?: readonly string[]
  /**
   * 覆盖本轮融合模式，透传给 `ondra-memory-recall`。
   *
   * 存在的理由：手册 §2.3 的实测结论就是「`weighted` 与 `rrf` 哪个好」，
   * 而那必须**同一份题集、同一时刻**各跑一遍才有意义。
   * 若只能改配置文件再重启，两次之间库里的 `lastHitAt` 已经变了。
   */
  readonly fuse?: string
}

/** 运行结果。 */
export interface RunResult {
  /** 是否跑完。 */
  readonly ok: boolean
  /** 不可用原因。 */
  readonly reason?: EvalUnavailableReason
  /** 报告。 */
  readonly report?: EvalReport
  /** 落盘的文件绝对路径（未落盘为空）。 */
  readonly files?: readonly string[]
  /** 人读一句话。 */
  readonly note: string
}

/** 不可用原因。 */
export type EvalUnavailableReason =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 没有召回服务（O-014 未装载）。 */
  | 'no-recall'
  /** 召回服务在位但不可用（内核缺席 / 建表失败）。 */
  | 'recall-unavailable'
  /** 找不到题集文件。 */
  | 'no-set'
  /** 题集文件读不懂（JSON 坏 / 没有 `cases`）。 */
  | 'bad-set'

/** 题集信息（供界面与自检读）。 */
export interface SetInfo {
  /** 题集名。 */
  readonly name: string
  /** 文件绝对路径；内存题集为 `null`。 */
  readonly path: string | null
  /** 是否存在。 */
  readonly exists: boolean
  /** 题数。 */
  readonly cases: number
  /** 各类题数。 */
  readonly counts: Readonly<Record<CaseKind, number>>
  /** 还有几道模板题没填。 */
  readonly unfilled: number
  /** 是否够量（≥ `minCases`）。 */
  readonly sufficient: boolean
  /** 人读提示（缺文件时给一句能照做的话）。 */
  readonly note?: string
}

/** 一次种子生成的结果。 */
export interface SeedResult {
  /** 是否写成。 */
  readonly ok: boolean
  /** 文件绝对路径。 */
  readonly path: string | null
  /** 生成了几道模板题。 */
  readonly cases: number
  /** 人读一句话。 */
  readonly note: string
}

/** 历史报告引用。 */
export interface ReportRef {
  /** 生成时间戳（从文件名取，不从文件内容取——内容坏了也能列出来）。 */
  readonly generatedAt: number
  /** 题集名。 */
  readonly setName: string
  /** JSON 绝对路径。 */
  readonly json: string
  /** Markdown 绝对路径（可能不存在）。 */
  readonly markdown: string | null
}

/** 统计快照。 */
export interface EvalStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: EvalUnavailableReason
  /** 能否落盘。 */
  readonly canWrite: boolean
  /** 能否按文本指纹解析真值（需要记忆内核）。 */
  readonly canResolveText: boolean
  /** 默认题集名。 */
  readonly setName: string
  /** 已跑次数（本次进程内）。 */
  readonly runs: number
  /** 最近一次基线。 */
  readonly lastBaseline: ReportBaseline | null
  /** 最近一次 recall@1。 */
  readonly lastRecall1: number | null
  /** 最近一次错误。 */
  readonly lastError?: string
}

/* ------------------------------------------------------------------ *
 * 下游服务的结构对位（一律不 import 源码，§18.5）
 * ------------------------------------------------------------------ */

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

/** O-002 路径布局的结构对位子集。 */
export interface PathLayoutLike {
  /** 取某个区域的绝对路径（不创建）。 */
  area(area: string): string
  /** 确保某个区域下的子目录存在，返回绝对路径。 */
  ensure(area: string, ...segments: string[]): string
  /** 拼文件路径（不创建）。 */
  fileIn(area: string, ...segments: string[]): string
  /** 判断绝对路径是否落在数据根内部。 */
  isInside(filePath: string): boolean
  /** 判断文件是否存在（O-002 实际提供，镜像补齐）。 */
  exists(filePath: string): boolean
}

/* ------------------------------------------------------------------ *
 * O-014 召回的结构对位（不 import 源码）
 * ------------------------------------------------------------------ */

/** 召回命中（只镜像本插件真正读的字段）。 */
export interface RecallHitLike {
  readonly id: string
  readonly score: number
}

/** 一条通道状态（只镜像本插件真正读的字段）。 */
export interface ChannelStateLike {
  readonly channel: string
  readonly status: string
}

/** 召回结果（只镜像本插件真正读的字段）。 */
export interface RecallResultLike {
  readonly ok: boolean
  readonly reason?: string
  readonly hits: readonly RecallHitLike[]
  readonly fuse: string
  readonly weights: Readonly<Record<string, number>>
  readonly normalizedBy: number
  readonly channels: readonly ChannelStateLike[]
  readonly elapsedMs: number
}

/** 召回请求（只镜像本插件真正填的字段）。 */
export interface RecallRequestLike {
  readonly text: string
  readonly at?: number
  readonly fuse?: string
}

/** 召回服务（只镜像本插件真正调用的成员）。 */
export interface RecallLike {
  readonly available: boolean
  readonly reason?: string
  search(request: RecallRequestLike): RecallResultLike
}

/* ------------------------------------------------------------------ *
 * O-010 记忆内核的结构对位（只用于「按文本找 id」）
 *
 * 为什么需要它：评估集的真值若只写 id，库一重建就全 `missing`，
 * 表现是「recall 归零但代码没动」。故必须能按正文找 id。
 * 内核缺席时本插件照常跑，只是 `resolution` 只会出现 `id`。
 * ------------------------------------------------------------------ */

/** 一条记忆（只镜像本插件真正读的字段）。 */
export interface MemoryRecordLike {
  readonly id: string
  readonly text: string
}

/** 分页查询（只镜像本插件真正填的字段）。 */
export interface FactQueryLike {
  readonly state?: string
  readonly limit?: number
  readonly offset?: number
}

/** 记忆内核（只镜像本插件真正调用的成员）。 */
export interface MemoryCoreLike {
  readonly available: boolean
  listFacts(query?: FactQueryLike): readonly MemoryRecordLike[]
  countFacts(query?: FactQueryLike): number
}

/** 错误码。 */
export type EvalErrorCode =
  | 'bad-request'
  /** 题集结构不对（不是 JSON 对象 / `cases` 不是数组 / 题号重复）。 */
  | 'bad-set'
  /** 落盘失败（无权限 / 越界 / 磁盘满）。 */
  | 'write-failed'

/**
 * 评估错误。
 *
 * **只有 `bad-request` 与 `bad-set` 会真的抛出去**：前者是调用方写错了，
 * 后者是题集坏了（继续跑只会产出一份好看但无意义的报告）。
 * 其余（无召回、无题集、落盘失败）一律降级返回，由调用方看 `reason`。
 */
export class EvalError extends Error {
  /** 错误码。 */
  readonly code: EvalErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: EvalErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'EvalError'
    this.code = code
    this.detail = detail
  }
}

/** 评估服务。 */
export interface RecallEvalService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: EvalUnavailableReason

  /**
   * 跑一次评估。
   * @param request 请求。
   */
  run(request?: RunRequest): RunResult
  /**
   * 与上一次报告对比。
   * @param report 本次报告；省略时与「最近两份」比较。
   */
  compare(report?: EvalReport): CompareResult
  /**
   * 从库里抽若干条记忆，生成**待填模板**（不生成问法）。
   * @param setName 题集名。
   * @param size 抽几条。
   * @param force 已存在时是否覆盖。
   */
  seed(setName?: string, size?: number, force?: boolean): SeedResult
  /** 题集信息。 */
  setInfo(setName?: string): SetInfo
  /** 历史报告列表（新的在前）。 */
  reports(setName?: string): readonly ReportRef[]
  /** 统计快照。 */
  stats(): EvalStats
}
