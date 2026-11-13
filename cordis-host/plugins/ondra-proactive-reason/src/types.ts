/**
 * O-043 `ondra-proactive-reason` 的对外契约。
 *
 * 定位：**此刻该拿什么当由头**。它不决定「发不发」（那是 O-042 的九道闸），
 * 也不生成聊天正文（那是对话链与模型）。它只回答一件事：如果要说，说什么由头最合适。
 *
 * ## 手册给了三套排序，本插件把它们合成一套
 *
 * | 出处 | 排序 |
 * |---|---|
 * | §5.1 缺口 / 执念 | `highestTension()` > 承诺到期 > 待办 > 近期事件 > 时间线 > 环境 |
 * | §9.3 主动（旧项目实测） | 到点承诺 > 情绪偏离基线 ≥0.08 > 记忆事实非空 > 台词池兜底 |
 * | 台账 O-043 | 承诺 > 待办 > 近期事件 > 时间线 > 环境 + 缺口池 |
 *
 * 三套的**种类集合不同**（§9.3 有「情绪偏离」与「台词池」，§5.1 有「时间线」与「环境」），
 * 所以不是「选一套」，而是**并集 + 定序**。定序按「手册优先、§5.1 的规范位置为骨架」：
 *
 * ```
 * 缺口 > 承诺 > 情绪偏离 > 待办 > 近期事件 > 时间线 > 环境 > 台词池
 * ```
 *
 * 缺口放第一是 §5.1 的原话（「highestTension() > 承诺到期」）；情绪偏离插在承诺之后
 * 是 §9.3 的相对位置；台词池垫底也是 §9.3 的原话（「兜底」）。
 * 这条合并登记为待裁决——三处口径没有一处能单独覆盖全集。
 *
 * ## 为什么权重不参与跨种类比较
 *
 * 手册说的是**「优先级」**，不是「加权打分」。一条刚生成的弱承诺（紧迫度 0.1）
 * 若能和一条张力 95 的执念比大小，就会出现「该说心事的时候在提明天交周报」。
 * 故排序是**字典序**：先按种类，再按强度。`score` 只是把这个字典序压成一个
 * 可排序的数字（`(8 − 序位) × 10 + 权重`），方便面板与调用方用一个键排。
 *
 * ## 72 小时冷却按「话题」而不是按「正文」
 *
 * 同一件事换个说法仍然是同一件事。所以冷却键取自**稳定 id**（缺口 id / 承诺 id /
 * 待办 id），只有调用方只给了自由文本时才退回文本前缀。刻意**不做相似度**：
 * 模板化正文（「搜索「X」没有结果」）会让任意两句话都有 0.7 以上的相似度，
 * 那是 O-129 已经踩过的坑。
 */

/** 本插件注册的服务键（连字符，非 `ondra:proactive-reason`）。全仓唯一归属。 */
export const REASON_SERVICE_KEY = 'ondra-proactive-reason'

/** 服务键 / 工具名 / 配置键的形状（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名。与 O-042 的 `proactive-state.json` **分开**：两个插件两个写者，合一个文件必然互相覆盖。 */
export const STATE_FILE_NAME = 'proactive-reason.json'

/** 冷却窗口：72 小时（台账 O-043）。 */
export const COOLDOWN_HOURS = 72

/**
 * 话由种类，**顺序即优先级**（高 → 低）。
 *
 * 增删会同时改变排序与 `score` 的刻度，故这张表是唯一的定序真源。
 */
export const KIND_ORDER = [
  'gap',
  'promise',
  'emotion',
  'todo',
  'recent',
  'timeline',
  'ambient',
  'pool',
] as const

/** 一种话由。 */
export type ReasonKind = (typeof KIND_ORDER)[number]

/** 种类中文名。**只给面板与日志**，不进提示词。 */
export const KIND_ZH: Readonly<Record<ReasonKind, string>> = Object.freeze({
  gap: '执念',
  promise: '承诺',
  emotion: '情绪',
  todo: '待办',
  recent: '近期事件',
  timeline: '时间线',
  ambient: '环境',
  pool: '台词池',
})

/**
 * 情绪偏离 → 由头正文。
 *
 * **六态名一个都不出现**（O-031 已定：`STATE_ZH` 只给面板与日志）。
 * 这里写的是身体感，不是情绪命名——「有点提不起劲」而不是「困」。
 *
 * `calm` / `soft` 刻意不在表里：没偏离就没有由头。
 * 「软和」是一个好状态，但「我今天心情不错」不是需要主动说的事。
 */
export const EMOTION_SEEDS: Readonly<
  Record<string, { readonly text: string; readonly weight: number } | undefined>
> = Object.freeze({
    bristled: Object.freeze({ text: '心里有点堵，想找人说两句', weight: 0.9 }),
    wilted: Object.freeze({ text: '有点提不起劲，想有人陪一下', weight: 0.75 }),
    joyful: Object.freeze({ text: '心情挺好的，想说给你听', weight: 0.7 }),
    sleepy: Object.freeze({ text: '有点撑不住了，想说一声', weight: 0.5 }),
  })

/** 未知情绪状态时的权重（O-031 若改了状态名，退化成这个，不崩）。 */
export const UNKNOWN_EMOTION_WEIGHT = 0.4

/** 排序刻度：每种相差 10。 */
export const KIND_STEP = 10

/** 话题键取多少字（自由文本兜底时）。 */
export const TOPIC_CHARS = 12

/** `note()` 判「这句话在说她哪条由头」时的最短片段。 */
export const NOTE_MIN_FRAGMENT = 4

/** `note()` 判重时试到的最长片段。 */
export const NOTE_MAX_FRAGMENT = 8

/**
 * 每轮最多把几条执念递进候选表。
 *
 * ## 为什么要多于一条
 *
 * 只递最高那一条时，它一旦在 72 小时冷却里，`pickOf()` 就再无候选可选，
 * 整轮判 `content-empty`——而池里同张力档的其它执念从未被看过一眼。
 *
 * ## 为什么不设成「全池」
 *
 * 候选表会进面板、进日志、进 `note()` 的话题扫描，条数无限增长会把
 * 一次 tick 的成本与噪声一起放大。8 条足够覆盖「最高那几条都在冷却里」
 * 这种现实情形：冷却表最多 2000 条，而同一晚新生的执念通常 1–3 条。
 */
export const GAP_CANDIDATE_LIMIT = 8

/* ------------------------------------------------------------------ *
 * 输入
 * ------------------------------------------------------------------ */

/** 调用方塞进来的一条事件（近期事件 / 时间线 / 环境都用它）。 */
export interface EventSeed {
  /** 稳定键。省略则由正文派生。 */
  readonly key?: string
  /** 正文（一句话）。 */
  readonly text: string
  /** 发生时刻。 */
  readonly at?: number
  /** 强度 0–1。省略用 0.5。 */
  readonly weight?: number
}

/** 一次取话由的入参。 */
export interface ReasonInput {
  /** 时刻。 */
  readonly at?: number
  /** 近期事件（调用方从 O-014 的检索结果里取）。 */
  readonly events?: readonly EventSeed[]
  /** 时间线（O-049「那年今日」未建，暂由调用方给）。 */
  readonly timeline?: readonly EventSeed[]
  /** 环境（日期 / 天气；O-046 / O-047 未建，暂由调用方给）。 */
  readonly ambient?: readonly EventSeed[]
  /** 台词池兜底（手册 §9.3 的最后一位）。 */
  readonly pool?: readonly string[]
  /**
   * 执念这一源此刻够不够格开口（由调用方问 O-129 的 `dueForWake()` 得到）。
   *
   * ## 为什么这个判断要由调用方给，不能本插件自己算
   *
   * 「张力够不够、能量够不够、闲置够不够、冷却过没过」这四条是 O-129 的
   * `judgeWake()` 的**唯一真源**。本插件若自己写 `tension >= 80`，那份判据
   * 就会与插件里那份慢慢漂开，症状是「面板显示她该醒了，实际没醒」。
   *
   * ## 为什么缺省是 `undefined` 而不是 `false`
   *
   * `undefined` = 调用方没问（或缺口池没装）。此时按旧行为照常产候选——
   * 本插件的面板与测试都走这条路径，它们不该因为「没人去问唤醒判定」
   * 而突然一条执念都看不见。只有调用方**明确**说「不够格」时才不产。
   */
  readonly gapEligible?: boolean
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

/** 收集阶段的一条候选（还没排序、没判冷却）。 */
export interface CandidateSeed {
  /** 种类。 */
  readonly kind: ReasonKind
  /** 稳定键（同一条候选跨轮不变）。 */
  readonly key: string
  /** 冷却键。 */
  readonly topic: string
  /** 由头正文（一句话，不是聊天正文）。 */
  readonly text: string
  /** 强度 0–1。只在同种类内比较。 */
  readonly weight: number
  /** 到期时刻（`0` = 无期限）。 */
  readonly dueAt: number
  /** 数据来源（服务键或 `caller`）。 */
  readonly source: string
}

/** 排好序的一条候选。 */
export interface ReasonCandidate extends CandidateSeed {
  /** 排序分：`(种类数 − 序位) × 10 + 权重`。降序即优先级。 */
  readonly score: number
  /** 名次（1 = 最高）。 */
  readonly rank: number
  /** 是否在 72 小时冷却里。 */
  readonly cooling: boolean
  /** 冷却截止时刻（`0` = 不在冷却）。 */
  readonly cooledUntil: number
}

/** 一次取话由的结论。 */
export interface ReasonPlan {
  /** 时刻。 */
  readonly at: number
  /** 结论码。 */
  readonly code: PlanCode
  /** 全部候选（含冷却中的，**不按条数砍**）。 */
  readonly candidates: readonly ReasonCandidate[]
  /** 最高分且未冷却的那条。 */
  readonly pick: ReasonCandidate | undefined
  /** 各来源是否在位。 */
  readonly sources: SourceStatus
}

/** 结论码。 */
export type PlanCode =
  /** 有可说的话由。 */
  | 'ok'
  /** 一条候选都没有（上游全缺席或全空）。 */
  | 'no-candidate'
  /** 有候选，但全在 72 小时冷却里。 */
  | 'all-cooling'
  /** 配置关掉了。 */
  | 'disabled'

/** 各来源是否在位（面板要能回答「为什么没话说」）。 */
export interface SourceStatus {
  /** 缺口池（O-129）。 */
  readonly gap: boolean
  /** 承诺 / 待办（O-016）。 */
  readonly promise: boolean
  /** 情绪六态（O-031）。 */
  readonly emotion: boolean
  /** 调用方给的近期事件 / 时间线 / 环境 / 台词池。 */
  readonly caller: boolean
}

/** 不可用原因。只有「配置关掉」才算真的不可用（§15-49）。 */
export type ReasonUnavailableReason = 'disabled'

/** 统计快照。 */
export interface ReasonStats {
  /** `plan()` 调用次数。 */
  readonly plans: number
  /** 出过 `pick` 的次数。 */
  readonly picks: number
  /** `all-cooling` 的次数（说明冷却把话由吃光了）。 */
  readonly allCooling: number
  /** `markUsed()` 次数。 */
  readonly marks: number
  /** `note()` 记下的条数。 */
  readonly noted: number
  /** 冷却表当前条数。 */
  readonly cooling: number
  /** 各来源出过多少条候选（累计）。 */
  readonly byKind: Readonly<Record<ReasonKind, number>>
  /** 落盘成功次数。 */
  readonly writes: number
  /** 落盘失败次数。 */
  readonly writeFailures: number
  /** 冷却表是否真的落盘。 */
  readonly stored: boolean
}

/** 话由服务。 */
export interface ReasonService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ReasonUnavailableReason
  /** 冷却表是否真的落盘。`false` = 重启后 72 小时冷却失效。 */
  readonly stored: boolean

  /**
   * 取一次话由计划。
   * @param input 入参。
   */
  plan(input?: ReasonInput): ReasonPlan

  /**
   * 只要候选列表（不判 `pick`，等价于 `plan().candidates`）。
   * @param input 入参。
   */
  candidates(input?: ReasonInput): readonly ReasonCandidate[]

  /**
   * 只要那一条。
   * @param input 入参。
   */
  pick(input?: ReasonInput): ReasonCandidate | undefined

  /**
   * 记一次「这条用过了」：进 72 小时冷却。
   * @param topic 话题键（传 `pick.topic`）。
   * @param at 时刻。
   * @returns 冷却截止时刻。
   */
  markUsed(topic: string, at?: number): number

  /**
   * 从她真的说出口的那句话里，认出「说的是哪条由头」并记冷却。
   *
   * 启发式：拿每条候选正文的前 4–8 字去比对。误判的代价是「72 小时内不再提这件事」，
   * 漏判的代价是「过一会儿又说一遍同一件事」——后者用户立刻能察觉，故宁可多记。
   * @param text 她发出去的话。
   * @param at 时刻。
   * @returns 记下了几条。
   */
  note(text: string, at?: number): number

  /**
   * 某话题是否在冷却里。
   * @param topic 话题键。
   * @param at 时刻。
   */
  cooling(topic: string, at?: number): boolean

  /**
   * 一句中文解释（面板用，**允许出现数字**）。
   * @param candidate 候选。
   */
  explain(candidate: ReasonCandidate): string

  /**
   * 清掉过期的冷却条目。
   * @param at 时刻。
   * @returns 清掉几条。
   */
  prune(at?: number): number

  /** 统计快照。 */
  stats(): ReasonStats
}

/* ------------------------------------------------------------------ *
 * 相邻服务的结构对位（§18.5：不 import 源码）
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
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
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
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-002 路径服务的结构对位子集。 */
export interface PathLike {
  /** 在某个区域下拼文件路径（不创建）。 */
  fileIn(area: 'user', ...segments: string[]): string
  /** 确保私有文件可用：父目录 0700、文件 0600。 */
  prepareFile(filePath: string): string
}

/** O-016 的承诺视图（只用到三个字段）。 */
export interface PromiseLike {
  /** 主键。 */
  readonly id: string
  /** 锁住的原文。 */
  readonly text: string
  /** 到期时刻（`0` = 无期限）。 */
  readonly dueAt: number
}

/** O-016 的一条到期提醒。**只镜像用到的两个字段**（多镜像一个字段就多一处会漂的契约）。 */
export interface ReminderItemLike {
  /** 承诺。 */
  readonly promise: PromiseLike
  /** 紧迫度 0–1。 */
  readonly urgency: number
}

/** O-016 的一条待办。 */
export interface TodoLike {
  /** 主键。 */
  readonly id: string
  /** 正文。 */
  readonly text: string
  /** 写入时刻。 */
  readonly createdAt: number
  /** 过期时刻。 */
  readonly expiresAt: number
  /** 是否已完成。 */
  readonly done: boolean
}

/** O-016 承诺服务的结构对位子集。 */
export interface ProspectiveLike {
  /** 到期提醒候选（**不按条数砍**）。 */
  dueForReminder(at?: number): readonly ReminderItemLike[]
  /** 未完成的待办。 */
  listTodos(): readonly TodoLike[]
}

/** O-129 的缺口视图（只用到四个字段）。 */
export interface GapViewLike {
  /** 主键。 */
  readonly id: string
  /** 正文。 */
  readonly text: string
  /** 当前张力 0–100。 */
  readonly tension: number
  /** 状态。 */
  readonly status: string
}

/** O-129 缺口池的结构对位子集。 */
export interface DriveGapLike {
  /** 张力最高的那条 open。 */
  highestTension(at?: number): GapViewLike | undefined
  /**
   * 池里全部 open（按张力降序）。**可选**：老实现没有这个方法，
   * 缺席时采集层退回 `highestTension()` 单条行为。
   *
   * ## 为什么必须有它
   *
   * 只读最高那一条会导致一个静默死锁：最高那条一旦进了 72 小时冷却，
   * `pickOf()` 跳过它之后候选表**空了**，于是整轮判 `content-empty`，
   * 而池里另外几条同样过唤醒线的执念从未进过候选表——症状是
   * 「她明明心里压着四件事，却一句话都不主动说」。
   *
   * `rank.ts` 的设计原话是「冷却不是砍掉，是标出来…答案是『有 3 条，
   * 但全在冷却里』，而不是『一条都没有』」。要让那句话成立，采集层就得
   * 把多条都递上去，由排序层自己去标冷却、跳过。
   */
  list?(options?: {
    readonly status?: 'open'
    readonly limit?: number
    readonly at?: number
  }): readonly GapViewLike[]
}

/**
 * O-031 的表达视图。
 *
 * **只镜像 `state` 一个字段**：本插件不需要 mood/energy/tension 的数值——
 * 一旦读了它们，就会有人想「用 0.08 的偏离阈值自己再算一遍」，
 * 而那是把 O-031 的判定复制成第二份。
 */
export interface ExpressViewLike {
  /** 状态名（六态之一）。 */
  readonly state: string
}

/** O-031 情绪表达服务的结构对位子集。 */
export interface ExpressLike {
  /** 判定当前状态。 */
  stateOf(at?: number): ExpressViewLike
}
