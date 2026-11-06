/**
 * O-016 `ondra-memory-prospective` 的对外契约。
 *
 * 定位：**「说好的事」与「要做的事」的唯一真源**。手册 §2.8 把这两件事分成两张表，
 * 语料 §17 又补了一刀「待办不进缺口池」。本文件把这条分界写成类型：
 *
 * ```
 * memory_promise（承诺）           working_todo（待办）
 * ├─ 进记忆：写 memory_fact        ├─ 不进记忆：只在本表
 * ├─ category = promise（8000h）   ├─ 不参与衰减、不进星云图
 * ├─ kept / broken 结算            ├─ 最多 3 条、3 天没提起自动过期
 * └─ 锁原文、提前 24h 提醒、宽限 24h  └─ 说「做好了 / 发过去了」就删
 * ```
 *
 * 五件必须先说清的事：
 *
 * 1. **两张表绝不合并。** 手册 §2.8 原话「待办与承诺分表」，语料 §17 给了理由：
 *    待办是「要做的事」，把它塞进记忆域会**污染衰减统计与检索**——
 *    一条「记得买牛奶」按 `daily` 类（3 小时基线）三小时就淡掉，
 *    而它三天后还没做；反过来按 `promise` 类（8000 小时）活着，
 *    它又会长期霸占注入名额。混表的代价不是「不准」，是**两个统计都失真**。
 *
 * 2. **「反向权重」= 越近越重，方向与记忆强度相反。**
 *    记忆的强度是 `0.5^(Δt/S)`，越久越淡；承诺的紧迫度在到期前**单调上升**，
 *    到期日与宽限期内恒为 1。这不是「给记忆加一个字段」，是**另一条时间轴**：
 *    一条 8000 小时基线的承诺，在它到期前 2 小时里比任何日常记忆都该被优先想起。
 *    **手册没有给这条曲线的公式**，本插件自定口径并登记为待裁决（见 README 已知限制 1）。
 *
 * 3. **结算只出建议，绝不写情绪。**
 *    手册 §3.4 的违约金 `{trust−0.05, warmth−0.03, tension+0.04}`、履约奖
 *    `{trust+0.02, warmth+0.02}` 属于**关系域**（O-026）。本插件的 `settle()` 把这份
 *    增量**算出来交出去**，自己一个字节都不写。`SettleOutcome.applied` 的类型写成
 *    字面量 `false`——想让它变成 `true` 必须先改类型，改不动就是不该写。
 *
 * 4. **锁原文，不改写、不摘要。** 承诺的正文逐字存两处：本表 `text` 与
 *    `memory_fact.text`。`summary` 字段刻意**不填**——摘要会漂移，而「我说过什么」
 *    这件事一旦被改写，用户第一眼就能看出来，信任代价远高于省下的几十个字。
 *
 * 5. **纯正则，不调模型。** 手册 §2.8 原话「纯正则不调模型」。
 *    故本插件**不消费** `ondra-llm-gateway`——抽错了最多漏一条，
 *    调模型的代价是每条消息都过一次 API，而承诺本来就有明确的时间词可认。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 消费 O-010 的 `MemoryCoreService` 时用结构对位的 `MemoryCoreLike` 镜像。
 * 镜像的代价是两边人工同步，纪律见文件末尾。
 */

/** 本插件注册的服务键（连字符，非 `ondra:memory-prospective`）。全仓唯一归属。 */
export const PROSPECTIVE_SERVICE_KEY = 'ondra-memory-prospective'

/** 承诺表名（**进记忆**的那张）。 */
export const TABLE_PROMISE = 'memory_promise'

/** 待办表名（**不进记忆链**的那张）。 */
export const TABLE_TODO = 'working_todo'

/**
 * 承诺的寿命类别。
 *
 * 手册 §2.4 的 11 类里 `promise` 的基线是 **8000 小时**（约 333 天），
 * 是除 `self`（20000h）之外最长的一档。写死在这里是**引用**而不是另立一套：
 * 真正的基线数值仍然只在 O-010 的 `STABILITY_BASE_HOURS` 里。
 */
export const PROMISE_CATEGORY = 'promise'

/**
 * 时间词表（手册 §9.3 承诺抽取：只认明确时间词）。
 *
 * `order` 是匹配优先级：**长词在前**，否则「大后天」会被「后天」吃掉、
 * 「今晚」会被「晚上」吃掉。这是本表唯一的排序约束。
 */
export interface TimeWordSpec {
  /** 词本身。 */
  readonly word: string
  /** 命中后解析出的相对天数；`null` 表示不按天算（见 `mode`）。 */
  readonly days: number | null
  /** 解析模式。 */
  readonly mode: 'day' | 'today' | 'weekend' | 'next-week' | 'soon' | 'open'
  /** 说明（进 README 与界面提示）。 */
  readonly doc: string
}

/** 时间词表。顺序即匹配优先级（长词在前）。 */
export const TIME_WORDS: readonly TimeWordSpec[] = Object.freeze([
  { word: '大后天', days: 3, mode: 'day', doc: '第 3 个自然日结束前' },
  { word: '后天', days: 2, mode: 'day', doc: '第 2 个自然日结束前' },
  { word: '明天', days: 1, mode: 'day', doc: '次日结束前' },
  { word: '今晚', days: 0, mode: 'today', doc: '当日结束前' },
  { word: '晚上', days: 0, mode: 'today', doc: '同「今晚」' },
  // 「下周末」必须排在「周末」前面：否则「下周末」会被「周末」吃掉，算成本周日。
  { word: '下周末', days: null, mode: 'next-week', doc: '下周日结束前' },
  { word: '周末', days: null, mode: 'weekend', doc: '最近的周日结束前' },
  { word: '下周', days: null, mode: 'next-week', doc: '下周日结束前（宽口径，见已知限制 3）' },
  { word: '一会儿', days: null, mode: 'soon', doc: '当前时刻 + soonHours（默认 2 小时）' },
  { word: '下次', days: null, mode: 'open', doc: '无期限：进清单但不参与到期提醒' },
])

/**
 * 承诺标记词。命中任一个 + 命中时间词 → 判为承诺。
 *
 * 只收「明确表态」的词。刻意**不收**「应该 / 可能 / 要不要」——
 * 那些是商量，不是答应。把商量记成承诺，会让 `broken` 结算无端扣信任。
 */
export const PROMISE_MARKERS: readonly string[] = Object.freeze([
  '答应',
  '说好',
  '讲好',
  '保证',
  '承诺',
  '我一定',
  '我会',
  '我帮你',
  '我陪你',
  '我请你',
])

/**
 * 待办标记词（手册 §2.8 工作记忆块的正则：`记得/待会/明天/答应过/我准备`）。
 *
 * 其中「明天」「答应过」归承诺侧（承诺必须带时间词），故这里只留其余四个，
 * 另补三个日常说法。**待办允许没有时间词**——「记得买牛奶」就是待办。
 */
export const TODO_MARKERS: readonly string[] = Object.freeze([
  '记得',
  '待会',
  '我准备',
  '别忘',
  '要记着',
  '提醒我',
  '得去',
])

/** 完成语（说「做好了 / 发过去了」就删相关那条，手册 §2.8）。 */
export const DONE_MARKERS: readonly string[] = Object.freeze([
  '做好了',
  '做完了',
  '弄好了',
  '发过去了',
  '发出去了',
  '交了',
  '搞定了',
  '完成了',
])

/** 条目种类。 */
export type ItemKind = 'promise' | 'todo'

/** 承诺状态。 */
export type PromiseState = 'open' | 'kept' | 'broken' | 'expired'

/** 结算结果。 */
export type Settlement = 'kept' | 'broken'

/**
 * 一次抽取的产物（**纯函数结果，不落库**）。
 *
 * `text` 是原文（`trim` 过，逐字不动）。`markers` 只记命中了哪些词，
 * 不记「置信度」——手册没给置信度的定义，编一个数字只会让人以为它有意义。
 */
export interface DetectedItem {
  /** 判为承诺还是待办。 */
  readonly kind: ItemKind
  /** 原文（锁住的正文）。 */
  readonly text: string
  /** 命中的时间词；没有则 `null`。 */
  readonly timeWord: string | null
  /** 解析出的到期时刻；`null` = 无期限（「下次」）或待办未给时间。 */
  readonly dueAt: number | null
  /** 命中的标记词。 */
  readonly markers: readonly string[]
}

/** 一条承诺（读出来的视图）。 */
export interface PromiseRecord {
  /** 本表主键（`p-<factId>`，确定性）。 */
  readonly id: string
  /** 对应 `memory_fact` 的记忆 id。 */
  readonly factId: string
  /** **锁住的原文**。 */
  readonly text: string
  /** 到期时刻；`0` 表示无期限。 */
  readonly dueAt: number
  /** 提醒时刻（`dueAt - remindAheadHours`）。 */
  readonly remindAt: number
  /** 宽限截止（`dueAt + graceHours`）。 */
  readonly graceUntil: number
  /** 状态。 */
  readonly state: PromiseState
  /** 写入时刻。 */
  readonly createdAt: number
  /** 结算时刻；`0` = 未结算。 */
  readonly settledAt: number
  /** 最近一次被提醒的时刻；`0` = 没提醒过（防重复提醒）。 */
  readonly remindedAt: number
  /** 命中的时间词。 */
  readonly timeWord: string
}

/** 一条待办（读出来的视图）。 */
export interface TodoRecord {
  /** 主键。 */
  readonly id: string
  /** 正文。 */
  readonly text: string
  /** 写入时刻。 */
  readonly createdAt: number
  /** 最近一次被提起的时刻（3 天没提起就过期）。 */
  readonly lastMentionedAt: number
  /** 过期时刻（`lastMentionedAt + todoIdleDays`）。 */
  readonly expiresAt: number
  /** 是否已完成。 */
  readonly done: boolean
}

/** 一条到期提醒。 */
export interface ReminderItem {
  /** 承诺。 */
  readonly promise: PromiseRecord
  /** 距到期还有多少小时（负数表示已过期、仍在宽限期内）。 */
  readonly hoursLeft: number
  /** 紧迫度 0–1（反向权重，见 `urgencyOf`）。 */
  readonly urgency: number
  /** 是否已过到期时刻（处于宽限期）。 */
  readonly inGrace: boolean
}

/**
 * 关系增量建议（手册 §3.4 的原值）。
 *
 * **只是建议**：本插件不写情绪。关系域归 O-026，它自己决定要不要采纳、
 * 要不要按单次变化上限 0.06 夹紧（手册 §3.4「单次变化 cap 0.06」）。
 */
export interface RelationshipDelta {
  /** 信任变化。 */
  readonly trust: number
  /** 温暖度变化。 */
  readonly warmth: number
  /** 张力变化。 */
  readonly tension: number
}

/** 结算结果。 */
export interface SettleOutcome {
  /** 结算后的承诺。 */
  readonly promise: PromiseRecord
  /** 关系增量建议。 */
  readonly delta: RelationshipDelta
  /**
   * 是否已由本插件写入关系。
   *
   * **类型是字面量 `false`**：本插件永不写情绪。想让它是 `true` 必须先改这个类型，
   * 而改它就得先回答「凭什么由记忆域改关系域的数」。
   */
  readonly applied: false
}

/** 运行期发现的问题。**不致命但必须让人看见**。 */
export interface ProspectiveIssue {
  /** 问题码。 */
  readonly code:
    | 'ensure-failed'
    | 'store-issue'
    | 'closed'
    | 'promise-full'
    | 'todo-full'
    | 'not-found'
    | 'bad-state'
    | 'core-missing'
    | 'too-many-issues'
  /** 相关 id。 */
  readonly id?: string
  /** 中文说明。 */
  readonly detail: string
}

/** 不可用原因。 */
export type ProspectiveUnavailableReason =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 没有存储端口。 */
  | 'no-store'
  /** 建表失败。 */
  | 'schema-failed'
  /** 端口已关闭。 */
  | 'closed'

/** 累计计数（**只在内存**）。 */
export interface ProspectiveCounters {
  /** 抽取次数。 */
  readonly detected: number
  /** 写入的承诺条数。 */
  readonly promises: number
  /** 写入的待办条数。 */
  readonly todos: number
  /** 履约次数。 */
  readonly kept: number
  /** 违约次数。 */
  readonly broken: number
  /** 过期清理条数。 */
  readonly expired: number
  /** 提醒次数。 */
  readonly reminded: number
}

/** 统计快照。 */
export interface ProspectiveStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ProspectiveUnavailableReason
  /** 后端标识。 */
  readonly provider: string
  /** 承诺条数（按状态）。 */
  readonly promises: {
    readonly open: number
    readonly kept: number
    readonly broken: number
    readonly expired: number
    readonly total: number
  }
  /** 待办条数。 */
  readonly todos: {
    readonly open: number
    readonly done: number
    readonly total: number
  }
  /** 到期提醒候选条数。 */
  readonly dueSoon: number
  /** 逾期未结算条数。 */
  readonly overdue: number
  /**
   * 承诺能不能写（记忆内核在位）。
   *
   * **与 `available` 分开**：内核缺席时待办照常工作，把两件事混成一个布尔，
   * 会让「待办也不能用了」这种假象传出去。
   */
  readonly promiseWritable: boolean
  /** 累计计数。 */
  readonly counters: ProspectiveCounters
  /** 最近的问题（最多 20 条）。 */
  readonly issues: readonly ProspectiveIssue[]
}

/** 错误码。 */
export type ProspectiveErrorCode =
  | 'no-store'
  | 'closed'
  | 'bad-argument'
  | 'write-failed'
  | 'not-found'
  | 'promise-full'
  | 'todo-full'
  | 'bad-state'
  | 'no-core'

/** 承诺与待办错误。带稳定错误码，消费方按码分支，不必匹配中文文案。 */
export class ProspectiveError extends Error {
  /** 错误码。 */
  readonly code: ProspectiveErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: ProspectiveErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'ProspectiveError'
    this.code = code
    this.detail = detail
  }
}

/** 承诺与待办服务。 */
export interface ProspectiveService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ProspectiveUnavailableReason

  /**
   * 从一句话里认出承诺 / 待办（**纯函数，不落库、不调模型**）。
   * @param text 原文。
   * @param at 参照时刻（解析「明天」的基准）。
   */
  detect(text: string, at?: number): readonly DetectedItem[]

  /**
   * 记一条承诺：锁原文、写记忆（`category=promise`）、落本表。
   * @param text 原文。
   * @param options `dueAt` 显式给到期时刻；省略则按时间词解析。
   */
  remember(text: string, options?: { readonly dueAt?: number; readonly at?: number }): PromiseRecord

  /**
   * 记一条待办（**不写记忆**）。
   * @param text 原文。
   * @param at 时间戳。
   */
  addTodo(text: string, at?: number): TodoRecord

  /**
   * 完成一条待办（说「做好了 / 发过去了」时调）。
   * @param id 待办 id。
   * @param at 时间戳。
   */
  completeTodo(id: string, at?: number): TodoRecord

  /**
   * 按一句话找「相关的那条待办」并完成它（手册 §2.8：说「做好了 / 发过去了」
   * 就删相关那条）。
   *
   * **找不到就什么都不做**并返回 `undefined`：宁可漏删（人还能自己清），
   * 不可错删（用户再也看不到那条待办）。否定式（「还没做好」）一律不认。
   * @param text 原文。
   * @param at 时间戳。
   */
  completeByText(text: string, at?: number): TodoRecord | undefined

  /**
   * 手动删一条待办。
   * @param id 待办 id。
   */
  dropTodo(id: string): boolean

  /**
   * 待办被重新提起（刷新 3 天计时）。
   * @param id 待办 id。
   * @param at 时间戳。
   */
  touchTodo(id: string, at?: number): TodoRecord

  /**
   * 到期提醒候选：`remindAt ≤ now < graceUntil` 且未结算的承诺。
   *
   * 提前 24 小时提醒、宽限 24 小时（手册 §3.4）。**不按条数砍**——
   * 少提醒一条承诺比多提醒一条的代价大得多。
   * @param at 时间戳。
   */
  dueForReminder(at?: number): readonly ReminderItem[]

  /**
   * 逾期未结算：过了宽限期仍是 `open` 的承诺。
   * @param at 时间戳。
   */
  overdue(at?: number): readonly PromiseRecord[]

  /**
   * 标记「已提醒过」（防重复提醒）。
   *
   * 存在库里而不是内存里：重启会丢的内存标记，等于每重启一次就再提醒一遍。
   * @param id 承诺 id。
   * @param at 时间戳。
   */
  markReminded(id: string, at?: number): number

  /**
   * 结算一条承诺。**只出关系增量建议，不写情绪**。
   * @param id 承诺 id。
   * @param outcome `kept` 履约 / `broken` 违约。
   * @param at 时间戳。
   */
  settle(id: string, outcome: Settlement, at?: number): SettleOutcome

  /**
   * 清理：过宽限期 3 天仍 `open` 的承诺转 `expired`；超 `todoIdleDays` 的待办删掉。
   * @param at 时间戳。
   * @returns 各自清理了多少条。
   */
  expire(at?: number): { readonly promises: number; readonly todos: number }

  /**
   * 反向权重（紧迫度）：越接近到期越高，与记忆强度方向相反。
   * @param record 承诺。
   * @param at 时间戳。
   */
  urgencyOf(record: PromiseRecord, at?: number): number

  /**
   * 取一条承诺。
   * @param id 承诺 id。
   */
  promiseOf(id: string): PromiseRecord | undefined
  /**
   * 取一条待办。
   * @param id 待办 id。
   */
  todoOf(id: string): TodoRecord | undefined

  /** 未结算的承诺（按紧迫度倒序——这是注入块 ① 的取材端）。 */
  listOpen(at?: number): readonly ReminderItem[]
  /** 未完成的待办（按创建时间正序）。 */
  listTodos(): readonly TodoRecord[]

  /** 统计快照。 */
  stats(): ProspectiveStats
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

/** O-003 时钟服务的结构对位子集（只用日历日算术，不算寿命）。 */
export interface ClockLike {
  /** 取某个时刻所在自然日的 00:00:00 时间戳。 */
  startOfDay(at?: number): number
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

/**
 * O-010 记忆内核的结构对位子集。
 *
 * 只用三个方法：`addFact()`（承诺进记忆）、`getFact()`（验事实还在）、
 * `listFacts()`（按 `category=promise` 取候选）。**不调 `strengthOf()`**——
 * 本插件不需要强度，只需要紧迫度（那是另一条时间轴）。
 */
export interface MemoryCoreLike {
  readonly available: boolean
  addFact(input: {
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
    readonly evidence?: readonly { readonly source: string; readonly quote: string; readonly messageIndex?: number }[]
    readonly at?: number
  }): { readonly id: string }
  getFact(id: string): { readonly id: string; readonly text: string } | undefined
  listFacts(query?: { readonly category?: string; readonly limit?: number }): readonly { readonly id: string }[]
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

/** 存储端口的结构对位子集（只走表级 CRUD，两个后端都能跑）。 */
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
 * 1. `MemoryCoreLike.addFact()` 的 `kind` / `category` 是**字符串**而不是联合类型：
 *    真正的枚举在 O-010 里，锁死会让 O-010 加一档时本插件必须跟着改。
 *    代价是拼错了不会在编译期报错——故 `PROMISE_CATEGORY` 只在这里定义一次，
 *    任何地方都不许再写字符串字面量 `'promise'`。
 * 2. `MemoryCoreLike.listFacts()` 的返回只取 `id`：本插件不关心正文以外的东西。
 *    要加字段先确认 O-010 真的给了（否则是编 API）。
 * 3. 手册 §2.8 说待办「存 `working.json`」。本插件用表 `working_todo` 承载
 *    同一语义（字段同构、可原样导出成那个 JSON），理由是不新开文件通道、
 *    复用端口的事务与迁移。这条差异登记在 README 已知限制 2。
 * ------------------------------------------------------------------ */
