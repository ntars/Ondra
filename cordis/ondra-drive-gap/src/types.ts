/**
 * O-129 `ondra-drive-gap` 的对外契约。
 *
 * 定位：**「她心里有没有事」的唯一账本。**
 *
 * 手册 §5.1 原话：「没有它，主动消息就是定时任务」。
 * 主动三闸门（时机 / 话由 / 分寸）回答的是「她该不该说话」，
 * 本插件回答的是「她心里有没有一件没解决的事、这件事现在压得多重」。
 *
 * ## 五个必须先说清的问题
 *
 * 1. **缺口不是待办。** 手册语料 §17 逐字写着「待办不进缺口池」——
 *    待办是「要做的事」，缺口是「没解决的困惑」。两者混在一个池子里，
 *    张力统计会整体失真（待办有截止时间，本来就该催；困惑没有）。
 *    所以 `GapSource` 只有手册给的三源，没有 `todo`。
 * 2. **张力是派生量，不是存量。** 原式 `tension = clamp(base + 小时数 × rate − relief)`，
 *    乘的是 `created_at` 到今天的小时数。**每次读都重算一次**，
 *    绝不能写成 `tension += rate` —— 后者「预检调多少次就膨胀多少次」，
 *    而预检是每轮都会跑的。
 * 3. **`+10` 只能落在 `bump` 上。** 手册说「相似度 ≥0.6 不新建，只 tension +10」，
 *    但派生式里没有「事件加成」这一项的位置。硬要表达只能去改 `created_at`
 *    （伪造「更早发生」，会把「多久以前」这个语义污染掉）或把 `relief` 减成负数
 *    （「缓解量为负」读起来就是错的）。故加第三个加项 `bump`，登记待裁决①。
 * 4. **本插件绝不外发。** 唤醒谁发、怎么发、发什么，归 O-042；
 *    本插件只回答 `dueForWake()` / `dueForDream()` / `recheck()`。
 *    投递前的「三种结局写进 wakeup_trigger.json」也是 O-042 的账，
 *    本插件只把判定结果交出去。
 * 5. **内感受铁律（§4.3）**：进提示词的片段**不带任何数字**，
 *    只写「有件事一直没弄明白，它压得你静不下来」。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。全仓唯一归属。 */
export const DRIVE_GAP_SERVICE_KEY = 'ondra-drive-gap'

/* ------------------------------------------------------------------ *
 * 手册里有的数
 * ------------------------------------------------------------------ */

/**
 * 第一源「模型说不知道」取整句后的截断长度（§5.1：截断 120 字）。
 *
 * 为什么是整句而不是关键词：句子里通常带着「她在问什么」这个上下文，
 * 只留「不知道」三个字，三天后回看谁也不知道当初卡在哪。
 */
export const TRUNCATE_CHARS = 120

/**
 * 判重阈值（§5.1：相似度 ≥0.6 不新建）。
 *
 * **这个 0.6 只用于缺口**。O-012 记忆判重用的是「包含度 0.4」，
 * 两套口径刻意不互搬（手册原话「口径不同不可互搬」）：记忆判重错一次是
 * 丢一条事实，缺口判重错一次只是少一条执念——容错空间不同，阈值就该不同。
 */
export const SIMILARITY_THRESHOLD = 0.6

/** 判重命中时给张力加的固定量（§5.1：只 `tension +10`）。 */
export const BUMP_STEP = 10

/** 自主唤醒的张力门槛（§5.1：`tension ≥ 80`）。 */
export const WAKE_TENSION = 80

/** 自主唤醒的能量下限（§5.1：`energy > 30`，0–100 口径，与 O-026 的 `axes.energy` 同尺度）。 */
export const WAKE_ENERGY_MIN = 30

/** 自主唤醒的闲置门槛（§5.1：`闲置 > 30min`）。 */
export const WAKE_IDLE_MINUTES = 30

/** 唤醒冷却期（§5.1：`不在冷却期(60min)`）。 */
export const WAKE_COOLDOWN_MINUTES = 60

/** 梦境自检的能量下限（§5.1：`energy > 30`）。 */
export const DREAM_ENERGY_MIN = 30

/** 梦境自检的闲置门槛（§5.1：`超 2 小时无交互`）。 */
export const DREAM_IDLE_HOURS = 2

/** 器官 ABI 的片段排序地板（§8.1：器官不得低于 −1000）。 */
export const MIN_FRAGMENT_ORDER = -1000

/**
 * 张力上限。
 *
 * 缺口的张力是 **0–100** 尺度，而 O-026 的 `axes.tension` 是 **0–1**。
 * 两者刻意不换算：这个 100 是 §5.1 的唤醒门槛（`≥80`）所在的尺度，
 * 换成 0–1 就得把手册里每一个门槛都改成小数，日后对拍要每次心算。
 * 交界处只在 `README` 的「已知限制」里写清楚，不在代码里做转换。
 */
export const MAX_TENSION = 100

/**
 * 执念片段的正文（§4.3 逐字口径：「`[未解执念] …它压得你静不下来`（不带张力数字）」）。
 *
 * 刻意写成一句「感觉」而不是「状态汇报」：她只知道心里压着事，
 * 不知道压着的是 78 还是 82。数字一进提示词，下一句就会变成
 * 「我现在执念张力 78，所以……」（§4.3 语料原话）。
 */
export const GAP_FRAGMENT_TEXT = '有件事一直没弄明白，它压得你静不下来。'

/* ------------------------------------------------------------------ *
 * 缺口本体
 * ------------------------------------------------------------------ */

/**
 * 缺口三源（§5.1，闭合集，**不许加 `todo`**）。
 *
 * - `model-unsure`：模型自己说「不知道 / 无法回答 / not sure」。
 * - `tool-empty`：`triggerTools` 名单内的搜索类工具返回空或报错。
 * - `request-failed`：请求失败（断网 / 超时），按失败分类归并。
 */
export const GAP_SOURCES = ['model-unsure', 'tool-empty', 'request-failed'] as const

/** 一个来源。 */
export type GapSource = (typeof GAP_SOURCES)[number]

/**
 * 状态。没有 `archived`：缺口只「开」与「闭」，不归档（归档归记忆域 O-010）。
 * 也不要有 `expired`——过期是一个时间判断，而时间判断已经写在张力公式里了。
 */
export type GapStatus = 'open' | 'closed'

/** 失败分类（§5.1「按失败分类归并」的归类键，同时也是归并键）。 */
export const FAILURE_KINDS = ['network', 'timeout', 'auth', 'rate-limit', 'server', 'unknown'] as const

/** 一类失败。 */
export type FailureKind = (typeof FAILURE_KINDS)[number]

/** 失败分类的中文名。 */
export const FAILURE_ZH: Readonly<Record<FailureKind, string>> = Object.freeze({
  network: '网络断了',
  timeout: '等太久了',
  auth: '没登上',
  'rate-limit': '被限流了',
  server: '对面出错了',
  unknown: '出了点问题',
})

/** 一条缺口的**存储形态**（不含派生量）。 */
export interface DriveGap {
  /** 主键，`g-<时间基36>-<序号基36>`。 */
  readonly id: string
  /** 正文（≤120 字）。 */
  readonly text: string
  /** 来源。 */
  readonly source: GapSource
  /**
   * 归并键。
   *
   * `tool-empty` 存搜索词；`request-failed` 存失败分类；
   * `model-unsure` 存空串。**同源同键直接加压，不做相似度比较**——
   * 断网十次是同一个「网络断了」，不是十条执念。
   */
  readonly query: string
  /** 状态。 */
  readonly status: GapStatus
  /** 起点张力 0–100。 */
  readonly base: number
  /** 每小时涨多少（0–100 尺度上的点/小时）。 */
  readonly ratePerHour: number
  /**
   * 累计缓解量（0–100）。想降张力只能加这个，不能改 `base`。
   *
   * **缓解是永久的**：减下去之后不会自己涨回来（放置项有天花板，见 `tensionOf`）。
   * 想让同一件事重新变重，就新建一条——那在语义上也确实是一件「新冒出来的心事」。
   */
  readonly relief: number
  /** 判重加压累计量（每次命中 +10）。 */
  readonly bump: number
  /**
   * 已扣除的休眠时长（毫秒）。
   *
   * §5.1：「深睡时长记进 `gap.paused_ms` 重算时扣掉；**只给那时已存在的缺口记账**」。
   * 睡觉时还没出生的焦虑不享受补偿——所以 `pause()` 只作用于**调用那一刻已 open 的条目**。
   */
  readonly pausedMs: number
  /** 创建时刻。 */
  readonly createdAt: number
  /** 闭合时刻（未闭合为 0）。 */
  readonly closedAt: number
  /** 闭合时连坐关掉了几条（不含自己）。 */
  readonly closedSiblings: number
  /** 被取用（当作话由）的次数。 */
  readonly picks: number
  /** 最近一次被取用的时刻。 */
  readonly lastPickedAt: number
}

/**
 * 一条缺口的**对外视图**（存储形态 + 派生量）。
 *
 * `tension` 与 `ageHours` 都是**当场算的**，别缓存——
 * 缓存一次就等于给派生量造了个第二真源。
 */
export interface GapView extends DriveGap {
  /** 当前张力 0–100（派生）。 */
  readonly tension: number
  /** 已计入的小时数（已扣休眠）。 */
  readonly ageHours: number
}

/* ------------------------------------------------------------------ *
 * 写入
 * ------------------------------------------------------------------ */

/** 开一条缺口的入参。 */
export interface GapInput {
  /** 正文。空白会被拒。 */
  readonly text: string
  /** 来源。 */
  readonly source: GapSource
  /** 归并键（`tool-empty` 的搜索词 / `request-failed` 的失败分类）。 */
  readonly query?: string
  /** 起点张力，省略用配置值。 */
  readonly base?: number
  /** 每小时增速，省略用配置值。 */
  readonly ratePerHour?: number
  /** 附注（只进日志，不落库）。 */
  readonly note?: string
}

/** 拒收原因。 */
export type GapRefusalCode =
  /** 配置里关掉了。 */
  | 'disabled'
  /** 正文为空（或全是标点）。 */
  | 'empty-text'
  /** 池子到上限，且没有可归并的相似条目。 */
  | 'pool-full'
  /** 来源不在闭集内。 */
  | 'bad-source'
  /** 没有存储端口，且内存池也满了（正常不会发生）。 */
  | 'store-unavailable'

/** 开缺口的结果。 */
export interface GapOpenResult {
  /** 是否被接收（`false` 时看 `refusal`）。 */
  readonly accepted: boolean
  /** 是否新建了一条（`false` 且 `accepted` 表示并入了已有的）。 */
  readonly created: boolean
  /** 是否命中判重加了压。 */
  readonly bumped: boolean
  /** 最终那条（新建或并入）。拒收时为 `undefined`。 */
  readonly gap?: GapView
  /** 并入的是哪一条（新建时为 `undefined`）。 */
  readonly similarTo?: string
  /** 拒收原因。 */
  readonly refusal?: GapRefusalCode
}

/** 闭合结果。 */
export interface GapCloseResult {
  /** 是否真的闭合了目标（已经闭合 / 不存在时为 `false`）。 */
  readonly closed: boolean
  /** 一起关掉的 id（含目标，按闭合顺序）。 */
  readonly closedIds: readonly string[]
  /** 连坐关掉的条数（不含目标）。 */
  readonly closedSiblings: number
}

/* ------------------------------------------------------------------ *
 * 三源判定
 * ------------------------------------------------------------------ */

/** 第一源的判定结果。 */
export interface GapDetection {
  /** 取到的整句（已截断）。 */
  readonly text: string
  /** 命中的标记词。 */
  readonly marker: string
}

/* ------------------------------------------------------------------ *
 * 唤醒与做梦
 * ------------------------------------------------------------------ */

/** 唤醒判定的入参。 */
export interface WakeInput {
  /** 能量 0–100；省略则向 O-026 现取。 */
  readonly energy?: number
  /** 闲置分钟；省略按 0 算（宁可不动）。 */
  readonly idleMinutes?: number
  /** 时刻。 */
  readonly at?: number
}

/** 唤醒被挡住的第一个原因（按「最便宜的先判」排序）。 */
export type WakeBlockReason =
  | 'disabled'
  | 'no-open-gap'
  | 'tension-low'
  | 'energy-unknown'
  | 'energy-low'
  | 'idle-short'
  | 'cooldown'

/** 唤醒判定用到的四个读数，全部带出去（可解释）。 */
export interface WakeChecks {
  /** 当前最高张力。 */
  readonly tension: number
  /** 能量；读不到为 `undefined`。 */
  readonly energy: number | undefined
  /** 闲置分钟。 */
  readonly idleMinutes: number
  /** 距上次投递多少分钟（从未投递为 `Infinity`）。 */
  readonly sinceWakeMinutes: number
  /** 冷却期还剩多少分钟（0 表示已过）。 */
  readonly cooldownLeftMinutes: number
}

/** 唤醒判定结果。 */
export interface WakeDecision {
  /** 该不该唤醒。 */
  readonly wake: boolean
  /** 被选中的那条（不唤醒时一般是最高张力那条，便于解释）。 */
  readonly gap?: GapView
  /** 四个读数。 */
  readonly checks: WakeChecks
  /** 被挡在哪个条件上。 */
  readonly blockedBy?: WakeBlockReason
}

/** 做梦判定的入参。 */
export interface DreamInput {
  /** 能量 0–100；省略则向 O-026 现取。 */
  readonly energy?: number
  /** 闲置分钟。 */
  readonly idleMinutes?: number
  /** 时刻（用来判 02:00–05:00）。 */
  readonly at?: number
}

/** 做梦被挡住的原因。 */
export type DreamBlockReason = 'disabled' | 'no-open-gap' | 'energy-unknown' | 'energy-low' | 'not-night-nor-idle'

/** 做梦判定用到的读数。 */
export interface DreamChecks {
  /** 能量；读不到为 `undefined`。 */
  readonly energy: number | undefined
  /** 闲置分钟。 */
  readonly idleMinutes: number
  /** 是否落在 02:00–05:00。 */
  readonly deepNight: boolean
}

/** 做梦判定结果。 */
export interface DreamDecision {
  /** 该不该入梦。 */
  readonly dream: boolean
  /** 入梦取哪一条（最高张力）。 */
  readonly gap?: GapView
  /** 三个读数。 */
  readonly checks: DreamChecks
  /** 被挡在哪个条件上。 */
  readonly blockedBy?: DreamBlockReason
}

/**
 * 投递前复核的结果（§5.1「时序竞态教训」）。
 *
 * 只回答「这条现在还开着吗、张力多少、是不是已经被合并到别处了」，
 * 三种结局（delivered / cancelled / replacedFrom）的记账归 O-042。
 */
export interface RecheckResult {
  /** 现状。 */
  readonly state: 'open' | 'closed' | 'missing'
  /** 当前张力（`missing` 为 0）。 */
  readonly tension: number
  /** 若原条已被闭合、但有一条相似的 open 条目接替，这里是接替者的 id。 */
  readonly replacedBy?: string
}

/* ------------------------------------------------------------------ *
 * 提示词片段
 * ------------------------------------------------------------------ */

/** 器官 ABI 的片段形状（§8.1：`order / ttl / confidence`）。 */
export interface PromptFragment {
  /** 排序键。 */
  readonly order: number
  /** 存活时长（分钟）。 */
  readonly ttlMinutes: number
  /** 置信度 0–1。 */
  readonly confidence: number
  /** 正文（**不含任何数字**）。 */
  readonly text: string
  /** 种类标记，供 O-036 去重与分段。 */
  readonly kind: 'drive'
}

/* ------------------------------------------------------------------ *
 * 汇总与统计
 * ------------------------------------------------------------------ */

/** 一句话汇总（给 O-042 与成长面板）。 */
export interface GapSummary {
  /** 开着的条数。 */
  readonly open: number
  /** 已闭合的条数。 */
  readonly closed: number
  /** 最高张力。 */
  readonly highestTension: number
  /** 最高张力那条的 id。 */
  readonly highestId?: string
  /** 现在该不该唤醒。 */
  readonly wake: boolean
  /** 最近一次投递时刻（0 表示从未）。 */
  readonly lastWakeAt: number
}

/** 累计计数（**只在内存**，重启归零）。 */
export interface GapCounters {
  /** 新建条数。 */
  readonly opened: number
  /** 并入（判重命中）次数。 */
  readonly merged: number
  /** 闭合条数（含连坐）。 */
  readonly closed: number
  /** 唤醒判定通过次数。 */
  readonly wakePassed: number
  /** 投递次数。 */
  readonly delivered: number
  /** 因池满被拒次数。 */
  readonly refusedFull: number
  /** 休眠扣账累计毫秒。 */
  readonly pausedMs: number
}

/**
 * 不可用原因。
 *
 * **只有「配置关掉」这一种。** 「没有存储」不是不可用（内存态照常记、
 * 照常判、照常出片段，只是重启丢），它由 `GapStats.storeProvider === 'none'` 表达。
 * 把两者混成一个布尔，下游会在「没装存储」时启用另一套兜底，
 * 两套兜底一撞，池子里的数就来回跳。
 */
export type GapUnavailableReason = 'disabled'

/** 统计快照。 */
export interface GapStats {
  /** 是否可用。**没有存储时仍然是 true**（内存态照常服务，只是重启丢）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GapUnavailableReason
  /** 存储后端标识（无存储时为 `none`）。 */
  readonly storeProvider: string
  /** 当前开着的条数。 */
  readonly open: number
  /** 历史闭合条数。 */
  readonly closed: number
  /** 最高张力。 */
  readonly highestTension: number
  /** 最近一次投递时刻。 */
  readonly lastWakeAt: number
  /** 累计计数。 */
  readonly counters: GapCounters
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/* ------------------------------------------------------------------ *
 * 服务接口
 * ------------------------------------------------------------------ */

/** 缺口池服务。 */
export interface DriveGapService {
  /** 是否可用。没有存储时仍然可用（内存态）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GapUnavailableReason

  /**
   * 判一句话里有没有「她自己没答上来」。
   *
   * **纯判定，不落库**。落库要调用方自己 `open()` ——
   * 分两步的理由是：上游可能只想在提示词里加一句「你没答上来」，
   * 未必想为每一句话开一条执念。
   * @param text 模型输出。
   */
  detect(text: string): GapDetection | undefined

  /**
   * 开一条缺口（三源共用这一入口）。
   * @param input 入参。
   * @param at 时刻。
   */
  open(input: GapInput, at?: number): GapOpenResult

  /**
   * 闭合一条，并连坐闭合相似度 ≥ 阈值的其它 open 条目。
   * @param id 目标 id。
   * @param at 时刻。
   */
  close(id: string, at?: number): GapCloseResult

  /**
   * 记一笔「缓解」（降低张力）。
   *
   * 手册口径：想降张力必须累计 `relief`，不能改 `base`。
   * @param id 目标 id。
   * @param amount 缓解量（0–100 尺度）。
   * @param at 时刻。
   */
  relieve(id: string, amount: number, at?: number): GapView | undefined

  /**
   * 休眠记账：把 `ms` 从所有**此刻已 open** 的缺口里扣掉。
   *
   * 手册那句「只给那时已存在的缺口记账」就是本方法的语义：
   * 之后新建的缺口不享受这次补偿（它们的 `createdAt` 在睡醒之后）。
   * @param ms 休眠毫秒。
   * @param at 时刻。
   * @returns 受影响的条数。
   */
  pause(ms: number, at?: number): number

  /** 列缺口（默认只列 open，按张力降序）。 */
  list(options?: { readonly status?: GapStatus; readonly limit?: number; readonly at?: number }): readonly GapView[]

  /** 取一条。 */
  get(id: string, at?: number): GapView | undefined

  /** 当前张力最高的那一条 open。 */
  highestTension(at?: number): GapView | undefined

  /** 唤醒判定（§5.1 四条件）。 */
  dueForWake(input?: WakeInput): WakeDecision

  /**
   * 记账：这条被当作话由投递出去了。
   *
   * 冷却期由它推进——不记这一步，`dueForWake` 每 30 秒都会说「可以唤醒」。
   * @param id 目标 id。
   * @param at 时刻。
   */
  markDelivered(id: string, at?: number): boolean

  /** 做梦判定（§5.1 离线梦境条件）。 */
  dueForDream(input?: DreamInput): DreamDecision

  /** 投递前复核。 */
  recheck(id: string, at?: number): RecheckResult

  /** 产出内感受片段（不含数字）。没有 open 缺口时返回 `undefined`。 */
  fragment(at?: number): PromptFragment | undefined

  /** 一句话汇总。 */
  summary(input?: WakeInput): GapSummary

  /** 清掉太久以前闭合的行（唯一的物理删除，只删 closed，且必须显式调用）。 */
  prune(olderThanDays?: number, at?: number): number

  /** 统计快照。 */
  stats(): GapStats
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

/** O-003 时钟的结构对位子集（只用来判深夜时段）。 */
export interface ClockLike {
  parts(epoch?: number): { readonly hour: number; readonly minute: number }
}

/**
 * O-026 情绪服务的结构对位子集。
 *
 * **只有 `state()`**：本插件要的是「她还有没有劲」这一个读数。
 * 结构里刻意没有 `feel` / `setAxis` —— 缺口池改不了情绪，
 * 这是 C1 在类型层面的落实。
 */
export interface EmotionLike {
  state(at?: number): {
    readonly axes: Readonly<Record<string, number>>
  }
}

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位（只够建两张表）
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
