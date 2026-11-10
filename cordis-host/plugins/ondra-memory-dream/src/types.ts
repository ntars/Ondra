/**
 * O-019 `ondra-memory-dream` 的对外契约。
 *
 * 定位：**她睡着以后，把白天见过的东西重新过一遍**。
 * 三个分支共用一个接口（§14.2「接口唯一，分支只实现接口」）：
 *
 * | 分支 | 做什么 | 模型 | 手册依据 |
 * |---|---|---|---|
 * | `gate`（默认） | 闸式做梦：只补**带逐字出处**的事实，四道闸全过才写 | 需要 | §2.7「闸式做梦」 |
 * | `lightweight` | 纯规则挖五类卡片（pitfall/playbook/hotspot/unresolved/fact），零模型调用 | 不需要 | §1.7 / §2.7「轻量分支」 |
 * | `surreal` | 荒诞联想（`surreal` 边 0.03，永不进检索）+ 梦话（30–50 字呓语） | 梦话需要 | §9.7 第 4–5 步 |
 *
 * ## 为什么「不可兼得」用枚举而不是运行期告警
 *
 * 手册 §2.7 裁决⑤：「闸式做梦的闸会 **100% 拒掉梦话**，二者不可兼得」。
 * 闸式要求「出处逐字可查」，而梦话按定义就是没有出处的呓语——
 * 同一个晚上既做闸式又做荒诞，等于让四道闸去审一句它必然要拒的话。
 *
 * 所以 `mode` 是**单一枚举**，不是两个布尔。这不是「用配置表达约束」，
 * 是让约束在类型层面成立：写不出「同时开两个」的配置，也就不需要一句
 * 「已为你自动关闭」的告警——那种告警从来没人看。
 *
 * ## 三件必须先说清的事
 *
 * 1. **梦不写「摘要」。** 手册 §9.7 第 6 步「重写摘要」需要「只改摘要」的接口，
 *    而 `MemoryCoreService.revise()` 会改**正文**并把 S ×1.3。用它做摘要重写，
 *    等于「改个摘要顺手让记忆变牢 30%」——一个静默副作用。故本插件不做，
 *    已登记契约缺口（见 README 已知限制 1）。
 * 2. **梦不改人格。** 闸 2 拒掉一切「你是 / 你叫 / 你的设定是」类断言。
 *    人格归 `ondra-persona-evolve`，而且那里的漂移有上限与日志。
 * 3. **梦不装定时器。** 22:00 归调用方（宿主 / `ondra-proactive-gate`）。
 *    本插件只提供「做一场梦」这个动作。
 *
 * 与 O-010 / O-011 / O-035 的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。引文归一化的口径**逐字对齐 O-011 的 `normalizeQuote`**
 * （见 `quote.ts` 文件头），因为两处口径漂移的后果是「提炼时能过、做梦时过不了」，
 * 而两边都不报错。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-dream`）。全仓唯一归属。 */
export const DREAM_SERVICE_KEY = 'ondra-memory-dream'

/** 三个分支。默认 `gate`（§14.2「默认最稳」：闸式不产出无出处的内容）。 */
export const DREAM_MODES = ['gate', 'lightweight', 'surreal'] as const

/** 做梦模式。 */
export type DreamMode = (typeof DREAM_MODES)[number]

/** 五类卡片（手册 §1.7「纯规则挖掘五类卡片」）。 */
export const CARD_KINDS = ['pitfall', 'playbook', 'hotspot', 'unresolved', 'fact'] as const

/** 卡片类型。 */
export type CardKind = (typeof CARD_KINDS)[number]

/** 四类引文来源（手册 §2.2）。**来源由素材标注，不由模型声明**（见 `gate.ts`）。 */
export const EVIDENCE_SOURCES = ['USER', 'TOOL', 'ACT', 'SELF'] as const

/** 引文来源。 */
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

/** 拒收原因。 */
export const REJECTION_CODES = [
  /** 正文为空。 */
  'empty-text',
  /** 正文超长（> `maxTextChars`）。 */
  'too-long',
  /** 没有引文。 */
  'quote-missing',
  /** 引文不是素材里的逐字子串。 */
  'quote-not-verbatim',
  /** 引文太短（< `minQuoteChars`）。 */
  'quote-too-short',
  /** 改人格 / 改称呼。 */
  'persona-rewrite',
  /** 无人称的纯工程结论。 */
  'impersonal',
  /** 正文已被用户明确要求忘记（墓碑）。 */
  'tombstoned',
  /** 与已有记忆重复。 */
  'duplicate',
  /** 今晚额度用完。 */
  'max-items',
] as const

/** 拒收码。 */
export type RejectionCode = (typeof REJECTION_CODES)[number]

/* ------------------------------------------------------------------ *
 * 一、素材
 * ------------------------------------------------------------------ */

/**
 * 一条素材。
 *
 * **来源由调用方标注**，不由模型声明。理由：让模型说「这句话是用户说的」，
 * 正是证据门控要防的那个幻觉——模型完全可以把 `[SELF]` 的推断标成 `[USER]`。
 * 素材是谁给的，调用方最清楚。
 */
export interface DreamMaterialItem {
  /** 原文（**不裁剪**：裁剪会毁掉逐字校验）。 */
  readonly text: string
  /** 来源类别。 */
  readonly source: EvidenceSource
  /** 这条素材的时刻；省略取本轮时刻。 */
  readonly at?: number
}

/** 做梦的素材。 */
export interface DreamMaterial {
  /** 素材条目。 */
  readonly items: readonly DreamMaterialItem[]
}

/* ------------------------------------------------------------------ *
 * 二、入参与出参
 * ------------------------------------------------------------------ */

/** 一条工具调用信号（轻量分支的输入）。 */
export interface ToolSignal {
  /** 工具名。 */
  readonly tool: string
  /** 是否成功。 */
  readonly ok: boolean
  /** 时刻。 */
  readonly at: number
}

/**
 * 睡眠输入（轻量分支）。
 *
 * `idleMs` 由调用方给：**本插件不自己检测空闲**。检测空闲需要一个 tick 源，
 * 而「谁在什么时候 tick」是宿主的职责；本插件自己装定时器，就成了
 * 「不知道第几个装载的定时器」——那类问题排查成本远高于收益。
 */
export interface SleepInput {
  /** 已经空闲多久（毫秒）。< 2 分钟不做事。 */
  readonly idleMs: number
  /** 工具调用信号。 */
  readonly signals: readonly ToolSignal[]
}

/** 做梦的入参（按分支判别）。 */
export type DreamInput =
  | {
      /** 分支。 */
      readonly mode: 'gate'
      /** 素材。 */
      readonly material: DreamMaterial
      /** 时间戳；省略取当前时刻。 */
      readonly at?: number
      /** 取消信号。 */
      readonly signal?: AbortSignal
    }
  | {
      /** 分支。 */
      readonly mode: 'surreal'
      /** 素材（梦话的种子）。 */
      readonly material: DreamMaterial
      /** 时间戳；省略取当前时刻。 */
      readonly at?: number
      /** 取消信号。 */
      readonly signal?: AbortSignal
    }
  | {
      /** 分支。 */
      readonly mode: 'lightweight'
      /** 睡眠输入。 */
      readonly sleep: SleepInput
      /** 时间戳；省略取当前时刻。 */
      readonly at?: number
    }

/** 一条被闸拒掉的候选（**留档**：拒了什么比写了什么更能解释「为什么今晚没记下东西」）。 */
export interface DreamRejection {
  /** 拒收码。 */
  readonly code: RejectionCode
  /** 候选正文（可能为空）。 */
  readonly text: string
  /** 中文说明。 */
  readonly detail: string
}

/** 一条写进记忆的事实。 */
export interface DreamFactRecord {
  /** 记忆 id。 */
  readonly id: string
  /** 正文。 */
  readonly text: string
  /** 11 类寿命类别。 */
  readonly category: string
  /** 五类标签。 */
  readonly kind: string
  /** 逐字引文。 */
  readonly quote: string
  /** 引文来源。 */
  readonly source: EvidenceSource
  /** 写完是否回读校验通过（手册 §2.7「梦正文必须交回来」）。 */
  readonly readback: boolean
}

/** 一张卡片（轻量分支）。 */
export interface DreamCard {
  /** 卡片 id。 */
  readonly id: string
  /** 类型。 */
  readonly kind: CardKind
  /** 标题（同类型内唯一，去重用）。 */
  readonly title: string
  /** 正文。 */
  readonly body: string
  /** 标签。 */
  readonly tags: readonly string[]
  /** 创建时刻。 */
  readonly createdAt: number
  /** 最近一次被用到的时刻（0 表示没用过）。 */
  readonly lastUsedAt: number
  /** 被用到的次数。 */
  readonly uses: number
  /** 当前权重 0–1（`0.5^(闲置小时/168)`）。 */
  readonly weight: number
  /** 是否已归档（权重低于阈值；**算出来的，不是写出来的**）。 */
  readonly archived: boolean
}

/** 一张卡片的**存储行**（不含权重：权重是算出来的，见 `DreamCard`）。 */
export interface CardRow {
  /** 卡片 id。 */
  readonly id: string
  /** 类型。 */
  readonly kind: string
  /** 标题。 */
  readonly title: string
  /** 正文。 */
  readonly body: string
  /** 标签。 */
  readonly tags: readonly string[]
  /** 创建时刻。 */
  readonly createdAt: number
  /** 最近一次被用到的时刻（0 表示没用过）。 */
  readonly lastUsedAt: number
  /** 被用到的次数。 */
  readonly uses: number
}

/** 一句梦话。 */
export interface DreamTalk {
  /** id。 */
  readonly id: string
  /** 梦话正文（30–50 字）。 */
  readonly text: string
  /** 哪一晚的梦（`YYYY-MM-DD`）。 */
  readonly date: string
  /** 写入时刻。 */
  readonly createdAt: number
  /** 被注入的时刻（0 表示还没注入）。 */
  readonly consumedAt: number
}

/** 一次做梦的记账。 */
export interface DreamLogEntry {
  /** id。 */
  readonly id: string
  /** 哪一晚（`YYYY-MM-DD`）。 */
  readonly date: string
  /** 分支。 */
  readonly mode: DreamMode
  /** 时刻。 */
  readonly at: number
  /** 写入的事实条数。 */
  readonly facts: number
  /** 产出的卡片条数。 */
  readonly cards: number
  /** 产出的梦话条数。 */
  readonly talk: number
  /** 新建的荒诞边条数。 */
  readonly edges: number
  /** 一句话说明。 */
  readonly note: string
}

/** 一场梦的报告。 */
export interface DreamReport {
  /** 是否跑完。`false` 时 `reason` 必有值。 */
  readonly ok: boolean
  /** 不可用原因。 */
  readonly reason?: DreamUnavailableReason
  /** 实际走的分支。 */
  readonly mode: DreamMode
  /** 本轮时间戳。 */
  readonly at: number
  /** 哪一晚。 */
  readonly date: string
  /** 候选条数（模型给出的 / 规则挖出的）。 */
  readonly candidates: number
  /** 写进记忆的事实。 */
  readonly written: readonly DreamFactRecord[]
  /** 被拒掉的候选。 */
  readonly rejected: readonly DreamRejection[]
  /** 产出的卡片。 */
  readonly cards: readonly DreamCard[]
  /** 产出的梦话。 */
  readonly talk: readonly DreamTalk[]
  /** 新建的荒诞边条数。 */
  readonly edges: number
  /** 三道保险之一：开工前备份。 */
  readonly backup: 'created' | 'skipped' | 'failed'
  /** 记账是否落盘。 */
  readonly logged: boolean
  /** 给人看的一句话。 */
  readonly note?: string
}

/** 不可用原因。 */
export type DreamUnavailableReason =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 没有记忆内核。 */
  | 'no-core'
  /** 内核在位但不可用。 */
  | 'core-unavailable'
  /** 没有模型网关（`gate` / `surreal` 的梦话需要）。 */
  | 'no-model'
  /** 入参的 `mode` 与配置的分支不一致。 */
  | 'mode-mismatch'

/** 运行期计数（**只在内存**）。 */
export interface DreamCounters {
  /** 做了几场梦。 */
  readonly runs: number
  /** 写进记忆的事实条数。 */
  readonly facts: number
  /** 被拒条数。 */
  readonly rejected: number
  /** 产出卡片条数。 */
  readonly cards: number
  /** 产出梦话条数。 */
  readonly talk: number
  /** 新建荒诞边条数。 */
  readonly edges: number
}

/** 运行期发现的问题。 */
export interface DreamIssue {
  /** 问题码。 */
  readonly code:
    | 'no-core'
    | 'core-unavailable'
    | 'no-model'
    | 'no-store'
    | 'no-graph'
    | 'no-dedupe'
    | 'readback-failed'
    | 'backup-failed'
    | 'summary-unsupported'
    | 'parse-empty'
    | 'scan-truncated'
    | 'gateway-failed'
    | 'talk-rejected'
    | 'too-many-issues'
  /** 相关 id。 */
  readonly id?: string
  /** 中文说明。 */
  readonly detail: string
}

/** 统计快照。 */
export interface DreamStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DreamUnavailableReason
  /** 当前分支。 */
  readonly mode: DreamMode
  /** 累计计数。 */
  readonly counters: DreamCounters
  /** 记忆条数。 */
  readonly facts: number
  /** 待注入的梦话条数。 */
  readonly pendingTalk: number
  /** 未归档的卡片条数。 */
  readonly liveCards: number
  /** 重复拒是否走 O-012（否则只做「同批去重 + 墓碑」）。 */
  readonly dedupeGate: 'service' | 'local'
  /** 备份钩子是否可用（O-009）。 */
  readonly snapshotAvailable: boolean
  /** 图谱是否可用（荒诞边）。 */
  readonly graphAvailable: boolean
  /** 最近的问题（最多 20 条）。 */
  readonly issues: readonly DreamIssue[]
}

/** 错误码。 */
export type DreamErrorCode = 'bad-request' | 'no-core' | 'no-model' | 'mode-mismatch'

/** 做梦错误。**只有 `bad-request` 会真的抛出去**（其余一律降级返回）。 */
export class DreamError extends Error {
  /** 错误码。 */
  readonly code: DreamErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: DreamErrorCode, message: string, detail?: string) {
    super(message)
    this.code = code
    this.detail = detail
  }
}

/** 做梦服务。 */
export interface DreamService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DreamUnavailableReason
  /** 当前分支（只读；由配置决定，运行期不变）。 */
  readonly mode: DreamMode

  /**
   * 做一场梦。
   * @param input 入参（`mode` 必须与 `this.mode` 一致，否则返回 `mode-mismatch`）。
   */
  run(input: DreamInput): Promise<DreamReport>

  /**
   * 待注入的梦话（次日首次对话用）。
   *
   * **不接受时间参数**：待注入 = `consumedAt === 0`，与「现在几点」无关。
   * 给一个用不上的参数就是假开关。
   */
  talk(): readonly DreamTalk[]
  /**
   * 标记梦话已注入。
   * @param ids 梦话 id。
   * @param at 时间戳。
   * @returns 实际标记的条数。
   */
  consume(ids: readonly string[], at?: number): number

  /**
   * 卡片清单（按权重降序，**含已归档**——归档不删除）。
   * @param at 时间戳。
   */
  cards(at?: number): readonly DreamCard[]
  /**
   * 标记一张卡片被用到（刷新它的半衰期起点）。
   * @param id 卡片 id。
   * @param at 时间戳。
   */
  useCard(id: string, at?: number): boolean

  /**
   * 做梦记账（新→旧）。
   * @param limit 条数上限。
   */
  history(limit?: number): readonly DreamLogEntry[]

  /** 统计快照。 */
  stats(): DreamStats
}

/* ------------------------------------------------------------------ *
 * 三、分支要用的端口
 * ------------------------------------------------------------------ */

/**
 * 记账端口（由 `store.ts` 实现）。
 *
 * 三个表分开：`dream_log`（一晚一条记账）、`dream_talk`（梦话要逐条消费）、
 * `dream_card`（卡片要单独衰减）。合成一张表会让「已注入」变成行级覆盖，
 * 而「这一晚写了什么」与「这句梦话注没注入」是两个粒度。
 */
export interface DreamLogPort {
  /** 是否可用（没有存储端口时为 `false`）。 */
  readonly available: boolean
  /** 写一条记账。 */
  recordDream(entry: DreamLogEntry): void
  /** 读记账（新→旧）。 */
  recentDreams(limit: number): readonly DreamLogEntry[]
  /** 写一句梦话。 */
  addTalk(talk: DreamTalk): void
  /** 待注入的梦话。 */
  pendingTalk(): readonly DreamTalk[]
  /** 标记梦话已注入。 */
  consumeTalk(ids: readonly string[], at: number): number
  /** 写一张卡片（存的是行，不含权重）。 */
  addCard(row: CardRow): void
  /** 同类型同标题的卡片是否已存在。 */
  cardExists(kind: string, title: string): boolean
  /** 全部卡片行（权重由调用方算）。 */
  listCards(): readonly CardRow[]
  /** 标记卡片被用到。 */
  useCard(id: string, at: number): boolean
}

/** 分支运行上下文。 */
export interface BranchContext {
  /** 记忆内核。 */
  readonly core: MemoryCoreLike | undefined
  /** 模型网关。 */
  readonly gateway: GatewayLike | undefined
  /** 图谱（荒诞边）。 */
  readonly graph: GraphLike | undefined
  /** 判重（重复拒）。 */
  readonly dedupe: DedupeLike | undefined
  /** 快照（三道保险之一）。 */
  readonly snapshot: SnapshotLike | undefined
  /** 记账端口。 */
  readonly store: DreamLogPort
  /** 配置。 */
  readonly settings: DreamBranchSettings
  /** 日志。 */
  readonly log: LogLike
  /** 时间源。 */
  readonly now: () => number
  /** 记一条问题。 */
  readonly report: (issue: DreamIssue) => void
}

/**
 * 分支接口（§14.2「同一能力只有一个接口，分支只实现接口」）。
 *
 * 三个分支各在一个文件里，互不调用、互不共享缓存。`needsModel` 是**给自检与界面看的**：
 * `lightweight` 为 `false` 意味着「模型网关全挂了这个分支照跑」，
 * 那是它在 §14.2「独立降级」里唯一的优势，必须可观测。
 */
export interface DreamBranch {
  /** 分支名。 */
  readonly mode: DreamMode
  /** 是否需要模型网关。 */
  readonly needsModel: boolean
  /**
   * 跑一场梦。
   * @param input 入参（`mode` 已由服务校验过与配置一致）。
   * @param at 时间戳。
   * @param context 上下文。
   */
  run(input: DreamInput, at: number, context: BranchContext): Promise<DreamReport>
}

/** 分支需要的配置子集（避免分支 import 整个 `Config`）。 */
export interface DreamBranchSettings {
  /** 每晚最多写几条事实。 */
  readonly maxItems: number
  /** 候选上限（解析保护）。 */
  readonly maxCandidates: number
  /** 梦事实的显著度。 */
  readonly dreamSalience: number
  /** 引文最短字数。 */
  readonly minQuoteChars: number
  /** 正文上限。 */
  readonly maxTextChars: number
  /** 荒诞联想的最短时间差（天）。 */
  readonly surrealMinGapDays: number
  /** 每晚最多建几条荒诞边。 */
  readonly maxSurrealPerNight: number
  /** 「同实体」的近似门槛（共享二元组数）。 */
  readonly surrealMinSharedGrams: number
  /** 荒诞联想从最近多少条出发找远处的伴。 */
  readonly surrealRecentSeeds: number
  /** 卡片半衰期（小时）。 */
  readonly cardHalfLifeHours: number
  /** 卡片归档权重。 */
  readonly cardArchiveWeight: number
  /** 浅睡门槛（毫秒）。 */
  readonly idleShallowMs: number
  /** 深睡门槛（毫秒）。 */
  readonly idleDeepMs: number
  /** 梦话最短字数。 */
  readonly talkMinChars: number
  /** 梦话最长字数。 */
  readonly talkMaxChars: number
  /** 扫描条数上限。 */
  readonly scanLimit: number
  /** 分页大小。 */
  readonly pageSize: number
  /** 事实卡片取最近几天。 */
  readonly factCardDays: number
  /** 事实卡片的最低显著度。 */
  readonly factCardSalience: number
  /** 事实卡片最多几条。 */
  readonly maxFactCards: number
  /** `pitfall`：同一工具连续失败几次算坑（手册 ≥3）。 */
  readonly toolPitfallStreak: number
  /** `playbook`：同一条成功链路重复几次算套路（手册 ≥2）。 */
  readonly toolPlaybookRepeat: number
  /** `hotspot`：调用几次以上才看成功率（手册 ≥8）。 */
  readonly toolHotspotCalls: number
  /** `hotspot`：成功率低于多少算热点（手册 <70%）。 */
  readonly toolHotspotRate: number
  /** `unresolved`：上次成功之后累计失败几次算卡住（手册 ≥3）。 */
  readonly toolUnresolvedFails: number
  /** 做梦调用的温度。 */
  readonly temperature: number
  /** 做梦调用的输出上限。 */
  readonly maxTokens: number
  /** 梦话调用的温度。 */
  readonly talkTemperature: number
}

/* ------------------------------------------------------------------ *
 * 四、依赖的结构对位（不 import 任何 `ondra-*` 源码）
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

/** 记忆状态。 */
export type MemoryStateLike = 'active' | 'archived' | 'sealed'

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

/** 写入事实的入参（O-010 `FactInput` 的子集）。 */
export interface FactInputLike {
  readonly id?: string
  readonly kind: string
  readonly category: string
  readonly text: string
  readonly summary?: string
  readonly subject?: string
  readonly channel?: string
  readonly salience?: number
  readonly arousal?: number
  readonly evidence?: readonly { readonly source: string; readonly quote: string; readonly messageIndex?: number }[]
  readonly at?: number
}

/** 记忆内核的结构对位子集。 */
export interface MemoryCoreLike {
  readonly available: boolean
  addFact(input: FactInputLike): MemoryRecordLike
  getFact(id: string): MemoryRecordLike | undefined
  listFacts(query?: {
    readonly state?: MemoryStateLike
    readonly limit?: number
    readonly offset?: number
    readonly orderBy?: 'created-at' | 'last-seen' | 'salience'
  }): readonly MemoryRecordLike[]
  countFacts(query?: { readonly state?: MemoryStateLike }): number
  tombstoned(text: string): boolean
}

/** 网关返回（O-035 `GatewayCompletion` 的子集）。 */
export interface GatewayCompletionLike {
  readonly text: string
  readonly sourceId: string
  readonly attempts: number
  readonly finishKind: string
}

/** 模型网关的结构对位子集。 */
export interface GatewayLike {
  readonly available: boolean
  complete(request: {
    readonly messages: readonly object[]
    readonly system?: string
    readonly temperature?: number
    readonly maxTokens?: number
    readonly signal?: AbortSignal
  }): Promise<GatewayCompletionLike>
}

/** 图谱服务的结构对位子集（只借建边）。 */
export interface GraphLike {
  readonly available: boolean
  link(input: {
    readonly from: string
    readonly to: string
    readonly relation?: string
    readonly weight?: number
    readonly approved?: boolean
    readonly at?: number
  }): { readonly created: boolean; readonly refusal?: string }
}

/** 判重裁决（O-012 `DedupeVerdict` 的子集）。 */
export interface DedupeVerdictLike {
  readonly action: string
  readonly reasons: readonly string[]
}

/** 判重服务的结构对位子集（只借 `judge`）。 */
export interface DedupeLike {
  readonly available: boolean
  judge(request: { readonly text: string; readonly category?: string; readonly kind?: string; readonly subject?: string }): DedupeVerdictLike
}

/** 快照结果（O-009 `SnapshotOutcome` 的子集）。 */
export interface SnapshotOutcomeLike {
  readonly ok: boolean
}

/** 快照服务的结构对位子集（只借 `create`）。 */
export interface SnapshotLike {
  readonly available: boolean
  create(reason?: string): SnapshotOutcomeLike
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

/** 存储端口的结构对位子集（只走表级 CRUD，不用 `raw`）。 */
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
 * 1. `MemoryRecordLike` / `FactInputLike` 与 O-010 的 `MemoryRecord` / `FactInput`
 *    字段名逐字对齐。O-010 改名，本文件必须同改。
 * 2. `quote.ts` 的归一化口径与 O-011 的 `normalizeQuote` 逐字一致。改一处必须改另一处。
 * 3. `mode` 是单一枚举，**不许拆成两个布尔**——拆了就出现「闸式和荒诞同时开」的
 *    合法配置，而那正是裁决⑤ 禁止的组合。
 * 4. `DreamCard.archived` 是**算出来的**（权重 < 阈值），不是写出来的。
 *    读接口不写库；想让它变成持久状态，先想清楚「谁在什么时候写」。
 * ------------------------------------------------------------------ */
