/**
 * O-018 `ondra-memory-humanlike` 的对外契约。
 *
 * 定位：**「她没有话头的时候，会想起什么」**。
 * O-014 回答「用户这句话让她想起什么」；本插件回答「没人跟她说话时，她自己冒出什么」。
 * 两者都不许做「按条数砍」——那是 P0 红线。
 *
 * ## 三件必须先说清的事
 *
 * ### 1. 三个「三」同名不同义，别再混（这是第三次踩）
 *
 * | 出处 | 三个是什么 | 归谁 |
 * |---|---|---|
 * | 手册 §2.1「三块记忆」 | 短期 / 实体画像 / 长期情景 | 存储分层，归 O-010 |
 * | 手册 §2.3「三检索分支」 | 字面 / 向量 / recognition | 归 O-014（+ O-122 / O-141） |
 * | 手册 §2.4「三通道」 | `fact` 4d / `gist` 12d / `affect` 180d | **本插件的 `channels()` 视图** |
 *
 * 前两个在 O-014 里已经辨析过一次，这里是第三次——所以写进契约而不是只写 README。
 * **通道是「这条记忆走哪条调制曲线」，不是「用哪条通道检索」。**
 *
 * ### 2. 三通道的**天数不在本插件出现**
 *
 * 4 / 12 / 180 天是 O-010 的调制参数（`CHANNEL_DAYS` + `channelAnchorDays`）。
 * 本插件若抄一份用来算「通道系数」，就出现两个真源：改 O-010 一处，本插件不生效且不报错。
 * 故 `ChannelView` **只给聚合与定性档位**（`modulation: '最短' | '中位' | '最长'`），
 * 一个天数、一个系数都不写。界面要显示「事实 4 天」，得向 O-010 要。
 *
 * ### 3. 「三条想起路径」里，本插件只做两条半
 *
 * 手册 §2.3 的三条路径：
 * - **固定回忆**（每天 21:05，越模糊越容易被想起）→ `dice()`，本插件做。
 * - **漫无目的联想**（从一词扩散 1–3 圈）→ `ripple()`，本插件做（扩散交 O-015）。
 * - **被话头勾起**（2-gram 重合 + 概率）→ `cue()`，本插件只做**概率闸与后果**，
 *   候选由调用方从 O-014 拿。**本插件不重建检索**——那会是第二套倒排索引。
 *
 * 这一条是刻意的边界：`cue()` 的入参里没有「查询 → 结果」这一步，只有「候选 → 要不要想起」。
 *
 * ## 与 O-010 的关系
 *
 * 本文件**不 import** `ondra-memory-core` 的源码（§18.5 / §15.5），只用结构对位的
 * `MemoryCoreLike` 镜像，且只镜像真正调用的成员。代价是两边人工同步，纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-humanlike`）。全仓唯一归属。 */
export const HUMANLIKE_SERVICE_KEY = 'ondra-memory-humanlike'

/**
 * 三通道（与 O-010 的 `MEMORY_CHANNELS` **逐字一致**，改动必须两边同步）。
 *
 * 为什么这里要重复一份常量：O-018 要按通道分组，而 `ctx.get()` 只给服务实例、
 * 不给常量。三字符串的重复比「为一个常量加一个服务方法」便宜。
 * **纪律：O-010 增删通道，本文件必须同改**（否则 `channelOf()` 会把新通道归错组）。
 */
export const MEMORY_CHANNELS = ['fact', 'gist', 'affect'] as const

/** 记忆通道。 */
export type MemoryChannel = (typeof MEMORY_CHANNELS)[number]

/** 通道的用途（手册 §2.1 三块记忆各自的用法）。 */
export const CHANNEL_PURPOSES = ['lookup', 'semantic', 'episodic'] as const

/** 通道用途：查表 / 语义 / 情景。 */
export type ChannelPurpose = (typeof CHANNEL_PURPOSES)[number]

/** 一条通道的产品语义说明（**纯静态文字，不含任何数值参数**）。 */
export interface ChannelProfile {
  /** 通道。 */
  readonly channel: MemoryChannel
  /** 中文名。 */
  readonly label: string
  /** 用途。 */
  readonly purpose: ChannelPurpose
  /** 定性档位（不含天数，见文件头第 2 条）。 */
  readonly modulation: '最短' | '中位' | '最长'
  /** 这类记忆该怎么查（写给调用方与界面看的）。 */
  readonly howToQuery: string
  /** 最容易搞错的一点。 */
  readonly caveat: string
}

/**
 * 三通道的产品语义（手册 §2.1 + §2.4）。
 *
 * 这张表是**说明**，不是参数表：它不参与任何计算，故不构成第二真源。
 */
export const CHANNEL_PROFILES: Readonly<Record<MemoryChannel, ChannelProfile>> = Object.freeze({
  fact: Object.freeze({
    channel: 'fact',
    label: '事实',
    purpose: 'lookup',
    modulation: '最短',
    howToQuery: '键值查表：「她记得你怕狗」靠查表，不靠相似度',
    caveat: '会变但变得慢；变了要能改（`revise`），不能靠再写一条把旧的盖住',
  }),
  gist: Object.freeze({
    channel: 'gist',
    label: '语义',
    purpose: 'semantic',
    modulation: '中位',
    howToQuery: '语义归纳后的「道理」：「这类事发生过 3 次」',
    caveat: 'gist 与 episode 是两个层次；归纳件不占注入名额，原件进归档',
  }),
  affect: Object.freeze({
    channel: 'affect',
    label: '情感',
    purpose: 'episodic',
    modulation: '最长',
    howToQuery: '情景回忆：当时的感受与场景，靠模糊召回',
    caveat: '情感通道活得最久，**不代表它最该被注入**——归档窗口是另一把尺子',
  }),
})

/** 三条想起路径。 */
export const RECALL_PATHS = ['fixed', 'cue', 'ripple'] as const

/** 想起路径：固定回忆 / 被话头勾起 / 漫无目的联想。 */
export type RecallPath = (typeof RECALL_PATHS)[number]

/* ------------------------------------------------------------------ *
 * 一、三通道视图
 * ------------------------------------------------------------------ */

/**
 * 一条通道的聚合视图。**只读**，不改任何记忆。
 *
 * 说明文字**不在这里复制一份**（中文名 / 用途 / 档位都在 `profile` 里）：
 * 三个字段抄三遍，改一次 `CHANNEL_PROFILES` 就要记得改三处，
 * 而漏改不会报错，只会让界面上「事实」写成「事实」、档位写错一格。
 */
export interface ChannelView {
  /** 通道。 */
  readonly channel: MemoryChannel
  /** 总条数。 */
  readonly count: number
  /** 活跃条数。 */
  readonly active: number
  /** 已沉底条数。 */
  readonly archived: number
  /** 已封存条数。 */
  readonly sealed: number
  /** 平均强度 0–1；该通道没有活跃记忆时为 `null`（**不是 0**：0 会被读成「全都快忘了」）。 */
  readonly avgStrength: number | null
  /** 平均当前 S（小时）；无数据时 `null`。 */
  readonly avgStabilityHours: number | null
  /** 示例 id（最多 3 条，按最近带出排序）。 */
  readonly sampleIds: readonly string[]
  /** 本通道的说明。 */
  readonly profile: ChannelProfile
}

/* ------------------------------------------------------------------ *
 * 二、固定回忆（骰子）
 * ------------------------------------------------------------------ */

/** 固定回忆的入参。 */
export interface DiceOptions {
  /** 时间戳；省略取当前时刻。 */
  readonly at?: number
  /**
   * 随机源，默认 `Math.random`。
   *
   * 抽一条是**随机**不是排序——「越模糊越容易被想起」是权重，不是名次。
   * 传入确定性随机源可复现（自检与评估集需要）。
   */
  readonly random?: () => number
  /** 是否把已沉底的记忆也纳入。默认 `false`（沉底的不该占主动注入位）。 */
  readonly includeArchived?: boolean
}

/** 一条进入骰子池的候选。 */
export interface DiceCandidate {
  /** 记忆 id。 */
  readonly id: string
  /** 正文。 */
  readonly text: string
  /** 11 类寿命类别。 */
  readonly category: string
  /** 五类标签。 */
  readonly kind: string
  /** 通道。 */
  readonly channel: string
  /** 当前强度 R（0–1，来自 O-010）。 */
  readonly strength: number
  /** 重要度 0–100（`salience`）。 */
  readonly importance: number
  /** 是否「永久档」（基线 ≥ `permanentBaseHours`）。 */
  readonly permanent: boolean
  /** 抽中权重 `(1−R) × (0.5 + 重要度/100) × (永久 ? 0.6 : 1)`。 */
  readonly weight: number
}

/** 被筛掉的四类原因（**分开计数**，合成一个数就查不出「为什么今晚没想起任何事」）。 */
export interface DiceSkips {
  /** 基线不够长（不是「长期/永久」档）。 */
  readonly shortTerm: number
  /** 强度不在 `[minStrength, maxStrength]` 区间。 */
  readonly outOfBand: number
  /** 最近 `recentSkipDays` 天内已经被想起过。 */
  readonly recent: number
  /** 已封存（永不参与回忆）。 */
  readonly sealed: number
  /** 已沉底（`includeArchived` 为假时）。 */
  readonly archived: number
}

/** 固定回忆的结果。 */
export interface DiceResult {
  /** 是否跑完。`false` 时 `picked` 必为 `null` 且 `reason` 必有值。 */
  readonly ok: boolean
  /** 不可用原因。 */
  readonly reason?: HumanlikeUnavailableReason
  /** 本轮时间戳。 */
  readonly at: number
  /** 路径名（固定回忆）。 */
  readonly path: 'fixed'
  /** 抽中的那一条；池为空时 `null`。 */
  readonly picked: DiceCandidate | null
  /** 进入池子的候选条数。 */
  readonly candidates: number
  /** 各类筛掉条数。 */
  readonly skips: DiceSkips
  /** 权重和（复现用）。 */
  readonly totalWeight: number
  /** 给人看的一句话（池为空 / 扫描被截断时必有）。 */
  readonly note?: string
}

/* ------------------------------------------------------------------ *
 * 三、被话头勾起（概率闸）
 * ------------------------------------------------------------------ */

/** 一条候选（通常来自 O-014 的 `hits`）。 */
export interface CueCandidateInput {
  /** 记忆 id。 */
  readonly id: string
  /** 正文（**必须给**：重合比要算，不能只给 id）。 */
  readonly text: string
}

/** 勾起的入参。 */
export interface CueOptions {
  /** 当前来信（话头）。 */
  readonly text: string
  /** 候选。**本插件不自己检索**，见文件头第 3 条。 */
  readonly candidates: readonly CueCandidateInput[]
  /** 时间戳；省略取当前时刻。 */
  readonly at?: number
  /** 随机源，默认 `Math.random`。 */
  readonly random?: () => number
}

/** 一条候选的评估。 */
export interface CueEvaluation {
  /** 记忆 id。 */
  readonly id: string
  /** 正文。 */
  readonly text: string
  /** 与话头的二元组覆盖率 0–1（**覆盖率，不是判重口径**，见 `cue.ts`）。 */
  readonly overlap: number
  /** 共享二元组个数。 */
  readonly shared: number
  /** 当前强度 R。 */
  readonly strength: number
  /** 想起概率 `0.10 + 覆盖率×0.55 + R×0.35`。 */
  readonly probability: number
  /** 是否已沉底。 */
  readonly archived: boolean
}

/** 勾起的结果。 */
export interface CueResult {
  /** 是否跑完。候选为空也算跑完（`ok: true` + `passed: 0`）。 */
  readonly ok: boolean
  /** 不可用原因。 */
  readonly reason?: HumanlikeUnavailableReason
  /** 本轮时间戳。 */
  readonly at: number
  /** 路径名（被话头勾起）。 */
  readonly path: 'cue'
  /** 进来的候选条数。 */
  readonly considered: number
  /** 过「共享二元组 ≥ `minSharedGrams`」闸门的条数。 */
  readonly passed: number
  /** 概率最高的那条（无论中没中）。 */
  readonly best: CueEvaluation | null
  /** 最高概率。 */
  readonly probability: number
  /** 是否真的想起来了。 */
  readonly hit: boolean
  /** 命中后是否加固了（调 `core.reinforce(id,'hit')`）。 */
  readonly reinforced: boolean
  /**
   * 命中一条**已沉底**记忆时的捞回状态。
   *
   * `unsupported` = 内核没有 `unarchive()`，捞不回来——**如实说，不假装捞过**。
   */
  readonly unsink: 'done' | 'unsupported' | 'not-needed'
  /**
   * 未命中时「S ×0.92」是否生效。
   *
   * **类型是字面量 `false`**：内核没有「按系数压低 S」的接口，本插件不硬做。
   * 想改成 `true` 必须先给 O-010 加接口——改不动就是不该假装。
   */
  readonly penaltyApplied: false
  /** 该条累计未命中次数（本次之后）。 */
  readonly misses: number
  /** 给人看的一句话。 */
  readonly note?: string
}

/* ------------------------------------------------------------------ *
 * 四、漫无目的联想（水波纹）
 * ------------------------------------------------------------------ */

/** 水波纹的入参。 */
export interface RippleOptions {
  /** 时间戳；省略取当前时刻。 */
  readonly at?: number
  /** 圈数 1–3；省略用配置 `rippleRings`。 */
  readonly maxRings?: number
}

/** 一圈里的一条。 */
export interface RippleItem {
  /** 记忆 id。 */
  readonly id: string
  /** 正文；内核里查不到时为 `null`（不编一句假正文）。 */
  readonly text: string | null
  /** 第几圈（从 1 起）。 */
  readonly ring: number
  /** 关系名。 */
  readonly relation: string
  /** 边权 0–1。 */
  readonly weight: number
  /** 圈权重 × 边权（**O-015 已算好，本插件不再乘一次**）。 */
  readonly score: number
}

/** 水波纹的结果。 */
export interface RippleResult {
  /** 是否跑完。 */
  readonly ok: boolean
  /** 不可用原因。 */
  readonly reason?: HumanlikeUnavailableReason
  /** 本轮时间戳。 */
  readonly at: number
  /** 路径名（漫无目的联想）。 */
  readonly path: 'ripple'
  /** 种子记忆 id。 */
  readonly seed: string
  /** 实际扩散了几圈。 */
  readonly ringsDone: number
  /** 扩散到的全部条目（**不裁剪**）。 */
  readonly items: readonly RippleItem[]
  /** 给人看的一句话。 */
  readonly note?: string
}

/* ------------------------------------------------------------------ *
 * 五、记账（本插件独占的小表）
 * ------------------------------------------------------------------ */

/**
 * 一条记忆的「想起记账」。
 *
 * **只记内核没有的东西**：`miss_count`（内核没有「未命中」这个概念）。
 * 「上次被想起」不在这里——那归 O-010 的 `lastHitAt`（`reinforce('hit')` 会写），
 * 记两份就会出现「骰子说昨天想起过、注入说三天没见」的矛盾。
 */
export interface RecallTrace {
  /** 记忆 id。 */
  readonly id: string
  /** 被话头勾起但没想起来的累计次数。 */
  readonly missCount: number
  /** 固定回忆抽中的累计次数。 */
  readonly diceCount: number
  /** 勾起评估过的累计次数（不论中没中）。 */
  readonly cueCount: number
  /** 最近一次未命中的时间戳（0 表示从未）。 */
  readonly lastMissAt: number
  /** 最近一次被抽中的时间戳（0 表示从未）。 */
  readonly lastDiceAt: number
}

/* ------------------------------------------------------------------ *
 * 六、问题、统计、错误
 * ------------------------------------------------------------------ */

/** 运行期发现的问题。**不致命但必须让人看见**。 */
export interface HumanlikeIssue {
  /** 问题码。 */
  readonly code:
    | 'no-core'
    | 'core-unavailable'
    | 'no-graph'
    | 'store-issue'
    | 'unsink-unsupported'
    | 'penalty-unsupported'
    | 'scan-truncated'
    | 'trace-memory-only'
    | 'too-many-issues'
  /** 相关记忆 id（若适用）。 */
  readonly id?: string
  /** 中文说明，直接给人看。 */
  readonly detail: string
}

/** 不可用原因。 */
export type HumanlikeUnavailableReason =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 没有记忆内核（O-010 未装载）。 */
  | 'no-core'
  /** 内核在位但不可用（建表失败 / 端口已关）。 */
  | 'core-unavailable'
  /** 没有图谱服务（只有 `ripple()` 需要）。 */
  | 'no-graph'

/** 运行期计数（**只在内存**，进程重启归零）。 */
export interface HumanlikeCounters {
  /** 固定回忆跑了多少次。 */
  readonly diceRuns: number
  /** 勾起评估了多少次。 */
  readonly cueRuns: number
  /** 勾起命中了多少次。 */
  readonly cueHits: number
  /** 水波纹跑了多少次。 */
  readonly rippleRuns: number
  /** 累计未命中次数。 */
  readonly misses: number
}

/** 统计快照，供 `ondra-startup-check` 与成长面板读取。 */
export interface HumanlikeStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: HumanlikeUnavailableReason
  /** 记忆总条数（`core.countFacts()`）。 */
  readonly facts: number
  /** 三通道视图。 */
  readonly channels: readonly ChannelView[]
  /** 累计计数。 */
  readonly counters: HumanlikeCounters
  /** 记账是否落盘（无存储端口时为 `false`，只存内存）。 */
  readonly tracePersisted: boolean
  /** 图谱是否可用（水波纹需要）。 */
  readonly graphAvailable: boolean
  /** 最近的问题（最多 20 条）。 */
  readonly issues: readonly HumanlikeIssue[]
}

/** 错误码。 */
export type HumanlikeErrorCode =
  /** 入参不合法（**唯一会真抛的一类**）。 */
  | 'bad-request'
  /** 内核不可用。 */
  | 'no-core'
  /** 图谱不可用。 */
  | 'no-graph'

/** 记忆拟人化错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class HumanlikeError extends Error {
  /** 错误码。 */
  readonly code: HumanlikeErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: HumanlikeErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'HumanlikeError'
    this.code = code
    this.detail = detail
  }
}

/** 记忆拟人化服务。 */
export interface HumanlikeService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: HumanlikeUnavailableReason

  /**
   * 三通道视图（**只读聚合**）。
   * @param at 时间戳；省略取当前时刻。
   */
  channels(at?: number): readonly ChannelView[]
  /**
   * 一条记忆走哪条通道。
   * @param record 记忆。
   */
  channelOf(record: MemoryRecordLike): MemoryChannel
  /**
   * 一条通道的说明（静态文字，不含数值）。
   * @param channel 通道。
   */
  describe(channel: string): ChannelProfile | undefined

  /**
   * 固定回忆：从「长期/永久」里抽一条，**越模糊越容易被想起**。
   * @param options 入参。
   */
  dice(options?: DiceOptions): DiceResult
  /**
   * 被话头勾起：对候选算概率，命中则加固。
   * @param options 入参。
   */
  cue(options: CueOptions): CueResult
  /**
   * 漫无目的联想：从一条记忆扩散 1–3 圈（扩散交 O-015）。
   * @param seed 种子记忆 id。
   * @param options 入参。
   */
  ripple(seed: string, options?: RippleOptions): RippleResult

  /**
   * 读一条记账（查不到返回 `undefined`）。
   * @param id 记忆 id。
   */
  traceOf(id: string): RecallTrace | undefined

  /** 统计快照。 */
  stats(): HumanlikeStats
}

/* ------------------------------------------------------------------ *
 * 依赖的结构对位（不 import 任何 `ondra-*` 源码）
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

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** 记忆状态。 */
export type MemoryStateLike = 'active' | 'archived' | 'sealed'

/**
 * 一条记忆（只镜像本插件真正读的字段）。
 *
 * **纪律**：字段名与 O-010 的 `MemoryRecord` 逐字一致；O-010 改名或删字段，
 * 本文件必须同改。镜像得越少，漂移面越小——所以这里没有 `evidence` / `oldText`。
 */
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
  readonly createdAt: number
  readonly lastSeenAt: number
  readonly lastHitAt: number | null
  readonly archived: boolean
  readonly sealed: boolean
  readonly important: boolean
}

/** 强度视图（O-010 `StrengthView` 的子集）。 */
export interface StrengthViewLike {
  readonly stabilityHours: number
  readonly strength: number
  readonly remainingHours: number
  readonly fadedAt: number
}

/** 记忆内核的结构对位子集。 */
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
  reinforce(id: string, kind: 'mention' | 'hit', at?: number): MemoryRecordLike
  strengthOf(record: MemoryRecordLike, at?: number): StrengthViewLike
}

/** 扩散里的一条（O-015 `DiffuseItem` 的子集）。 */
export interface DiffuseItemLike {
  readonly id: string
  readonly via: string
  readonly relation: string
  readonly weight: number
  readonly score: number
  readonly ring: number
}

/** 扩散结果（O-015 `DiffuseResult` 的子集）。 */
export interface DiffuseResultLike {
  readonly seeds: readonly string[]
  readonly rings: readonly { readonly ring: number; readonly items: readonly DiffuseItemLike[] }[]
  readonly visited: readonly string[]
  readonly ringsDone: number
}

/** 图谱服务的结构对位子集（**只借扩散**）。 */
export interface GraphLike {
  readonly available: boolean
  diffuse(
    seedIds: readonly string[],
    options?: { readonly maxRings?: number; readonly minWeight?: number },
  ): DiffuseResultLike
}

/* ------------------------------ 存储端口 ------------------------------ */

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

/**
 * 存储端口的结构对位子集。
 *
 * 只走表级 CRUD，**不用 `raw`**：用上自定义 SQL 就会绑死 SQLite，
 * 而内存后端存在的理由正是「SQLite 打不开」。
 */
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
 * 1. `MemoryRecordLike` 与 O-010 的 `MemoryRecord` 必须逐字对齐（字段名、可空性）。
 * 2. `MEMORY_CHANNELS` 与 O-010 的 `MEMORY_CHANNELS` 必须逐字一致。
 * 3. `CHANNEL_PROFILES` 里**不许出现天数或系数**——那是 O-010 的参数。
 * 4. `CueResult.penaltyApplied` 的类型是字面量 `false`。要改它，先给 O-010 加
 *    「按系数压低 S」的接口，而不是把 `false` 改成 `true` 了事。
 * ------------------------------------------------------------------ */
