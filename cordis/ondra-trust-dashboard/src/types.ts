/**
 * O-102 `ondra-trust-dashboard` 的对外契约：**把「她有多信你、你有多信她」摊成一张能看懂的表**。
 *
 * ## 名字里的「仪表盘」指的是一件很窄的事（本文件第一条要澄清的）
 *
 * 它**不是界面**。L8 界面 14 个插件已整批下线，渲染归应用外壳（`desktop/`）。
 * 本插件只输出**结构化读数**：几项指标、各自的来源、以及「这一项现在为什么是这个数」。
 *
 * ## 它绝不自己算一套信任分（本文件最重要的一条）
 *
 * 最容易犯的错是：为了「信任仪表盘」这个名字，新编一个 0–100 的 trust score。
 * 那会立刻多出三个真源——关系四维（O-028）、记忆规模（O-010）、承诺履约（O-021）——
 * 而三处读数迟早会漂开，界面上两处都说得通。
 *
 * 故本插件的每一个读数都是 **`trust` / `intimacy` / `familiarity` / 承诺履约率** 的
 * **投影**，并强制带上 `sources`：说明这一项取自哪个服务、哪个字段。
 * `TrustReading.value === null` 就是「上游没给，我不猜」——**不用 0 顶替**。
 *
 * ## 为什么不用 0 顶替缺失值（这条最容易被当成小事）
 *
 * 上游缺席时给 0，界面上会显示「信任 0%」。用户看到的是「她一点都不信我」，
 * 真相是「这个数这会儿算不出来」。前者会让人难受、甚至去改本来没问题的设置；
 * 后者只需要一句「暂时读不到」。两者代价差得很远。
 *
 * ## 与其他插件的关系
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（master-plan §15.5 / 18.5），全部结构对位镜像。
 * 关系读数的真源是 O-028 `ondra-emotion-stage`（它承接了 affection/trust/intimacy/familiarity，
 * 见台账第 4 组 O-028 的第 3 条裁定）。本插件**只读**，不提供任何 `adjust()` 镜像。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const TRUST_DASHBOARD_SERVICE_KEY = 'ondra-trust-dashboard'

/**
 * 读数项。闭集，**只用这五项**。
 *
 * 每加一项都要同时回答：真源在哪、缺席时 `value` 是不是 `null`、`sources` 怎么填。
 * 没有真源的项一律不加——**宁可少一项，不编一个数**（§17-6 禁假开关的同一条道理）。
 */
export const READING_IDS = [
  /** 她对你的信任（O-028 `trust`）。 */
  'trust',
  /** 她对你的亲密（O-028 `intimacy`）。 */
  'intimacy',
  /** 熟悉度（O-028 `familiarity`，由互动次数推导）。 */
  'familiarity',
  /** 承诺履约率（O-021 `stats()` 的 kept / settled）。 */
  'promise-kept',
  /** 记忆覆盖面：有多少条还活着、有多少条被钉住（O-010 / O-017）。 */
  'memory-cover',
] as const

/** 一项读数 id。 */
export type ReadingId = (typeof READING_IDS)[number]

/**
 * 读数状态。
 *
 * `unknown` 与 `low` / `high` **必须分开**：把它们混成一档，
 * 界面就会在「读不到」时画一条贴底的柱子，看起来像「很差」。
 */
export const READING_STATES = ['unknown', 'low', 'mid', 'high'] as const

/** 读数状态。 */
export type ReadingState = (typeof READING_STATES)[number]

/**
 * 读数区间边界（**不是分数阈值，只是把 0–1 切成四段给眼睛用**）。
 *
 * 0.35 / 0.7 两刀：低于 0.35 连「认识」都算不上（O-028 的敌意→试探台阶在 0.1 上下），
 * 高于 0.7 才接近「落定」那档要求的信任水平（master-plan §9.1 落定需 trust ≥ .70）。
 * 这两刀都是从既有参数反推的，不是新标定。
 */
export const STATE_CUTS = Object.freeze({ low: 0.35, high: 0.7 })

/** 一个读数项的说明书（静态，不含数值）。 */
export interface ReadingSpec {
  /** 项 id。 */
  readonly id: ReadingId
  /** 中文名。只给日志与面板，**不进提示词**。 */
  readonly zh: string
  /** 一句话：这一项在说什么。 */
  readonly about: string
  /** 真源在哪个服务。 */
  readonly owner: string
  /** 这一项是不是 0–1 的比例（`false` 表示是计数）。 */
  readonly ratio: boolean
}

/**
 * 五项说明书 —— **本插件全部读数定义的唯一真源**。
 *
 * `owner` 不只是文档：`sources` 里的服务键由它派生，改归属只改这一处。
 */
export const READING_SPECS: Readonly<Record<ReadingId, ReadingSpec>> = Object.freeze({
  trust: Object.freeze({
    id: 'trust',
    zh: '信任',
    about: '她对你的信任水平。会随时间缓慢衰减（半衰期 720 小时），靠履约与安抚回升。',
    owner: 'ondra-emotion-stage',
    ratio: true,
  }),
  intimacy: Object.freeze({
    id: 'intimacy',
    zh: '亲密',
    about: '她对你的亲密程度。衰减最慢（半衰期 8760 小时），几乎只增不减。',
    owner: 'ondra-emotion-stage',
    ratio: true,
  }),
  familiarity: Object.freeze({
    id: 'familiarity',
    zh: '熟悉',
    about: '熟悉度，由累计互动次数推导（不是独立存的维度）。聊得越多越高，不衰减。',
    owner: 'ondra-emotion-stage',
    ratio: true,
  }),
  'promise-kept': Object.freeze({
    id: 'promise-kept',
    zh: '履约率',
    about: '已结算的承诺里，守约占多少。未结算的不进分母——否则拖着不办会让比例虚高。',
    owner: 'ondra-memory-prospective',
    ratio: true,
  }),
  'memory-cover': Object.freeze({
    id: 'memory-cover',
    zh: '记忆存量',
    about: '还活着的记忆有多少条、其中多少条被钉住（钉住的不参与衰减）。这是计数，不是比例。',
    owner: 'ondra-memory-core',
    ratio: false,
  }),
})

/** 一项读数。 */
export interface TrustReading {
  /** 项 id。 */
  readonly id: ReadingId
  /** 中文名。 */
  readonly zh: string
  /**
   * 数值。**`null` = 上游没给，不猜**。
   *
   * 比例项是 0–1；计数项是整数（`memory-cover` 的 `value` 是活跃条数，
   * 钉住条数在 `detail` 里）。
   */
  readonly value: number | null
  /** 档位。`value === null` 时恒为 `unknown`。 */
  readonly state: ReadingState
  /** 这一项为什么是这个值（中文，直接给人看）。不含任何「加油」式的评价。 */
  readonly note: string
  /** 这一项的数据来自哪（服务键 + 字段），**供核对，不供展示**。 */
  readonly sources: readonly TrustReadingSource[]
  /** 附加计数（只有 `memory-cover` 用）。 */
  readonly detail?: Readonly<Record<string, number>>
}

/** 一个数据来源。 */
export interface TrustReadingSource {
  /** 服务键。 */
  readonly service: string
  /** 字段或方法名。 */
  readonly field: string
  /** 读到了没有。 */
  readonly ok: boolean
}

/** 整张表。 */
export interface TrustBoard {
  /** 生成时刻。 */
  readonly at: number
  /** 五项读数（顺序即 `READING_IDS`）。 */
  readonly readings: readonly TrustReading[]
  /** 读到几项、读不到几项。**读不到要能一眼看见**。 */
  readonly counts: {
    readonly known: number
    readonly unknown: number
    readonly total: number
  }
  /** 缺席的上游（服务键）。空数组 = 全齐。 */
  readonly missing: readonly string[]
  /** 一句话总结（中文）。**只说事，不评价、不打分、不报比例。** */
  readonly summary: string
}

/** 统计快照。 */
export interface TrustStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: TrustUnavailableReason
  /** 累计出表次数。 */
  readonly built: number
  /** 累计上游调用失败次数。**不为 0 说明有读数在降级**。 */
  readonly degraded: number
}

/** 不可用原因。 */
export type TrustUnavailableReason =
  /** 配置关掉了。 */
  | 'disabled'

/** 错误码闭集。刻意没有「未知错误」一档：走到未知分支说明本插件有 bug，该让它抛出来。 */
export const TRUST_ERROR_CODES = [
  /** 配置关掉了。 */
  'disabled',
  /** 找不到这一项读数。 */
  'no-such-reading',
] as const

/** 错误码。 */
export type TrustErrorCode = (typeof TRUST_ERROR_CODES)[number]

/** 一件错误。每种都带中文 `detail`，直接给人看。 */
export class TrustError extends Error {
  /** 错误码。 */
  readonly code: TrustErrorCode

  /**
   * @param code 错误码。
   * @param detail 中文说明。
   */
  constructor(code: TrustErrorCode, detail: string) {
    super(detail)
    this.name = 'TrustError'
    this.code = code
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

/** O-003 时钟服务的结构对位子集（只要「现在」）。 */
export interface ClockLike {
  now(): number
}

/**
 * O-028 `ondra-emotion-stage` 的结构对位子集。
 *
 * **只取 `relation()`**：本插件不镜像 `adjust()` / `observe()` / `settle()`。
 * 「只读插件」落到代码上就是：接口里根本没有那条路，
 * 而不是文档里写一句「请勿调用」——后者从来没拦住过人。
 */
export interface StageLike {
  readonly available: boolean
  /**
   * 关系四维快照（已按闭式衰减投影到 `at`，不落盘）。
   * @param at 时刻。
   */
  relation(at?: number): {
    readonly affection: number
    readonly trust: number
    readonly intimacy: number
    readonly familiarity: number
    readonly days: number
    readonly interactions: number
  }
}

/** O-021 `ondra-memory-prospective` 的结构对位子集（只取统计）。 */
export interface ProspectiveLike {
  readonly available: boolean
  stats(): {
    readonly promises: {
      readonly open: number
      readonly kept: number
      readonly broken: number
      readonly expired: number
      readonly total: number
    }
    readonly overdue: number
  }
}

/** O-010 `ondra-memory-core` 的结构对位子集（只取计数）。 */
export interface MemoryCoreLike {
  readonly available: boolean
  countFacts(query?: { readonly state?: 'active' | 'archived' | 'sealed' }): number
}

/** O-017 `ondra-memory-audit` 的结构对位子集（只取钉子清单长度）。 */
export interface AuditLike {
  readonly available: boolean
  pinned(): readonly unknown[]
}

/** O-005 字段声明的结构对位子集。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/** O-005 段声明的结构对位子集。 */
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

/** 信任读数服务。 */
export interface TrustDashboardService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: TrustUnavailableReason

  /** 五项说明书（全量）。 */
  specs(): readonly ReadingSpec[]

  /**
   * 出表。**只读，不落盘，不写任何上游**。
   * @param at 时刻，省略取现在。
   */
  board(at?: number): TrustBoard

  /**
   * 取一项读数。找不到该项抛 `no-such-reading`。
   * @param id 项 id。
   * @param at 时刻。
   */
  readingOf(id: ReadingId, at?: number): TrustReading

  /** 统计快照。 */
  stats(): TrustStats
}
