/**
 * O-048 `ondra-life-rhythm` 的对外契约。
 *
 * 定位：**她今天自己干了什么，以及她现在还剩多少力气**。两件事装在同一个插件里，
 * 是因为它们的失败域重合（都要「按时间往前走」、都要落一份状态、都要在面板上
 * 说清「为什么现在是这个样子」），分成两个包只会让「她困了所以不活动」这句话
 * 被拆到两处判定。
 *
 * ## 为什么不做独立脚本进程
 *
 * 台账原文写「独立脚本进程」，与 master-plan §12.4「只能是 app 插件包、
 * 禁止常驻后台服务」直接冲突。**按 §12.4 做成插件内的活动生成器**：
 * 没有子进程、没有端口、没有常驻循环——只有一个由 `ondra-clock` 驱动的
 * `tick()`，卸载即停。这条冲突记在 README。
 *
 * ## 为什么能量必须分段积分
 *
 * 一次乘法算不出「跨深睡与深夜窗口」的恢复：`+0.2/min` 与 `+1/min` 的切换点
 * 由**当时那一刻的能量与钟点**共同决定，而能量本身又在被积分改变。
 * 只能切 5 分钟一片往前推，每片按片首的能量定速率。上限 2000 段（≈7 天）：
 * 再长的缺口按「只算最后 7 天」处理并标记 `truncated`，而不是假装算过。
 *
 * ## 为什么概率与选择都要可复现
 *
 * 「10% 概率探索新兴趣」若用 `Math.random()`，同一个时间槽被重试几次就会
 * 每次都换结果（面板刷新一下兴趣就跳），而且日志里写不出「为什么是这次」。
 * 种子 = `(自然日, 槽号)`，同一槽恒定、换槽重抽。
 */

/** 本插件注册的服务键（连字符，非 `ondra:life-rhythm`）。全仓唯一归属。 */
export const LIFE_SERVICE_KEY = 'ondra-life-rhythm'

/** 服务键 / 工具名 / 配置键的硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（落在 `user/` 下，0600）。 */
export const STATE_FILE = 'life-rhythm.json'

/* ------------------------------------------------------------------ *
 * 能量（手册 §3.3）
 * ------------------------------------------------------------------ */

/** 清醒时的恢复速率（每分钟）。 */
export const WAKE_RATE = 0.2

/** 深度休眠或深夜的恢复速率（每分钟）。 */
export const SLEEP_RATE = 1

/** 高于自然上限时的回落速率（每分钟）。 */
export const FEED_DECAY_RATE = 0.1

/** 深度休眠门槛：能量低于它就算睡着了。 */
export const DEEP_BELOW = 20

/** 自然上限：自然恢复最多到 60（人工喂到 100 也按 0.1/min 回落）。 */
export const NATURAL_CAP = 60

/** 分段积分的片长（分钟）。 */
export const STEP_MINUTES = 5

/** 单次结算最多处理多少段（2000 段 ≈ 7 天）。 */
export const MAX_SEGMENTS = 2000

/** 睡多久算「睡了一觉」（分钟）。 */
export const SLEEP_BUFFER_MINUTES = 15

/** 能量上下限。 */
export const ENERGY_MIN = 0
export const ENERGY_MAX = 100

/** 深夜起点/终点（小时，0–6 点）。用 `minuteOfDay < LATE_END_MINUTE` 判定。 */
export const LATE_END_MINUTE = 6 * 60

/** 睡醒缓冲的行为指令。**取走即清零**，否则每次组装提示词都会重复提示。 */
export const SLEEP_BUFFER_TEXT = '你是被叫醒的：开头慢半拍，先缓一句接上话头'

/** 能量视图。 */
export interface EnergyView {
  /** 当前能量（0–100，保留两位小数）。 */
  readonly energy: number
  /** 结算到的时刻。 */
  readonly at: number
  /** 是否在睡（深睡或深夜）。 */
  readonly asleep: boolean
  /** 是否深睡（能量低于门槛）。 */
  readonly deepSleep: boolean
  /** 是否深夜。 */
  readonly lateNight: boolean
  /** 是否处于急停冻结。 */
  readonly frozen: boolean
  /** 当前速率（每分钟，负值表示回落）。 */
  readonly ratePerMin: number
  /** 自然上限。 */
  readonly cap: number
  /** 本次结算走过的段数。 */
  readonly slices: number
  /** 缺口太大、只算了最后 `MAX_SEGMENTS` 段。 */
  readonly truncated: boolean
}

/** 服务整体不可用的原因。 */
export type LifeReason =
  /** 配置里关掉了。 */
  | 'disabled'
  /** 时间服务缺席：分段积分没有「几点」，只能原地不动。 */
  | 'no-clock'

/* ------------------------------------------------------------------ *
 * 生活层（手册 §3.7）
 * ------------------------------------------------------------------ */

/** 六类活动。顺序即面板展示顺序。 */
export const ACTIVITY_KINDS = ['study', 'read', 'video', 'diary', 'daze', 'chat'] as const

/** 一类活动。 */
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** 活动中文名。只给日志与面板，**不进提示词**（措辞归 O-031/O-040）。 */
export const KIND_ZH: Readonly<Record<ActivityKind, string>> = Object.freeze({
  study: '学习',
  read: '看书',
  video: '刷视频',
  diary: '写日记',
  daze: '发呆',
  chat: '群里冒泡',
})

/** 兴趣标签：烧脑 / 放松 / 创造。 */
export const INTEREST_TAGS = ['focus', 'relax', 'create'] as const

/** 一个标签。 */
export type InterestTag = (typeof INTEREST_TAGS)[number]

/** 标签中文名。 */
export const TAG_ZH: Readonly<Record<InterestTag, string>> = Object.freeze({
  focus: '烧脑',
  relax: '放松',
  create: '创造',
})

/** 兴趣来源：种子表，还是探索长出来的。 */
export type InterestSource = 'seed' | 'explored'

/** 一条兴趣（落盘形状）。 */
export interface Interest {
  /** 稳定标识，由标签短语派生。 */
  readonly id: string
  /** 显示名，例如「看点天文」。 */
  readonly label: string
  /** 标签。 */
  readonly tag: InterestTag
  /** 权重（已含历次加权，未含时间衰减）。 */
  readonly weight: number
  /** 上次碰它的时刻。 */
  readonly lastAt: number
  /** 一共碰过几次。 */
  readonly times: number
  /** 来源。 */
  readonly source: InterestSource
}

/** 面板用的兴趣视图：多一个「按时间衰减后的有效权重」。 */
export interface InterestView {
  readonly id: string
  readonly label: string
  readonly tag: InterestTag
  /** 落盘的权重。 */
  readonly weight: number
  /** 按 `interestDecayHours` 半衰后的权重（选活动用的是它）。 */
  readonly effectiveWeight: number
  readonly lastAt: number
  readonly times: number
  readonly source: InterestSource
}

/** 一次活动的计划。**`plan()` 不改任何状态**。 */
export interface ActivityPlan {
  /** 计划的时刻。 */
  readonly at: number
  /** 时间槽：`自然日#槽号`。种子与去重都用它。 */
  readonly slot: string
  /** 是否这次是「探索新兴趣」。 */
  readonly explore: boolean
  /** 选中（或探索出）的兴趣。`reason !== 'ok'` 时可能为 undefined。 */
  readonly interest?: InterestView
  /** 活动类别。 */
  readonly kind?: ActivityKind
  /** 计划时长（分钟）。 */
  readonly minutes?: number
  /** 结论码。 */
  readonly reason: PlanReason
}

/** 计划结论。 */
export type PlanReason =
  /** 可以开始一次活动。 */
  | 'ok'
  /** 关掉了。 */
  | 'disabled'
  /** 在休息时段（默认 23:30–07:00）：她不活动，只睡觉。 */
  | 'resting'
  /** 距上一次活动还不够久。 */
  | 'cooldown'
  /** 兴趣表空了（正常不可能，除非存档被清成空数组）。 */
  | 'no-interests'
  /** 没有时钟，排不出槽。 */
  | 'no-clock'

/** 笔记保留期：长期进记忆候选，临时进 1 天工作记忆。 */
export type Retention = 'long' | 'temp'

/** 一条生活笔记。 */
export interface LifeNote {
  /** 标识：`时刻-槽号`，用于 `react()` 定位。 */
  readonly id: string
  readonly at: number
  readonly kind: ActivityKind
  /** 兴趣名（探索出的新兴趣也在这里）。 */
  readonly label: string
  /** 一句「她刚才在干什么」。 */
  readonly text: string
  /** 长期 / 临时。 */
  readonly retention: Retention
  /** 来源：活动产生，还是被回应后写回。 */
  readonly source: 'activity' | 'react'
  /** 用户对它的回应（`life_react` 写回）。 */
  readonly reacted?: 'like' | 'meh'
}

/** 一次 `tick()` 的结果。 */
export interface TickResult {
  readonly at: number
  readonly energy: EnergyView
  /** 这一次真的开始了一次活动。 */
  readonly started?: ActivityPlan
  /** 这一次产生的笔记。 */
  readonly note?: LifeNote
  /** 没开始时为什么。 */
  readonly reason: PlanReason
}

/** 生活日志摘要，供 O-036 注入时取用（**本插件不注入**）。 */
export interface LifeBrief {
  readonly from: number
  readonly to: number
  /** 按时间正序的笔记。 */
  readonly notes: readonly LifeNote[]
  /** 一行合并文本；没有笔记时为空串。 */
  readonly text: string
}

/** 运行计数（**只在内存**，进程重启归零）。 */
export interface LifeStats {
  /** 已产生的活动次数。 */
  readonly activities: number
  /** 探索出新兴趣的次数。 */
  readonly explored: number
  /** 当前笔记条数（内存环）。 */
  readonly notes: number
  /** 兴趣条数。 */
  readonly interests: number
  /** 当前能量。 */
  readonly energy: number
  /** 是否冻结。 */
  readonly frozen: boolean
  /** 状态是否真的落盘。 */
  readonly stored: boolean
}

/** 生活层与能量服务。 */
export interface LifeService {
  /** 服务能不能工作（开关 + 时钟）。 */
  readonly available: boolean
  /** 不能工作的原因。 */
  readonly reason?: LifeReason
  /** 时钟是否在位（与 `available` 分开：关了开关但时钟在位时，面板要能说清）。 */
  readonly clockReady: boolean
  /** 状态是否真的落盘。 */
  readonly stored: boolean

  /**
   * 取能量视图（先做一次懒结算）。
   *
   * **这个读会写盘**：能量是时间积分，不结算就永远是上次的数。
   * 只在真的走过至少一段时才写，所以 5 分钟内的重复读不会碰磁盘。
   * @param at 时刻。
   */
  energy(at?: number): EnergyView

  /** 显式结算一次。 */
  settle(at?: number): EnergyView

  /**
   * 喂一点能量（人工喂食 / 剧情）。
   * @param delta 增量（可为负）。
   * @param at 时刻。
   */
  feed(delta: number, at?: number): EnergyView

  /** 急停：冻结能量，**既不回血也不衰减**。 */
  freeze(at?: number): EnergyView

  /** 解除急停。 */
  unfreeze(at?: number): EnergyView

  /** 这一刻是不是在睡（深睡或深夜）。 */
  asleep(at?: number): boolean

  /**
   * 取走睡醒缓冲。**取走即清零**：同一觉只提示一次。
   * @param at 时刻。
   * @returns 行为指令，没有则 `undefined`。
   */
  takeSleepBuffer(at?: number): string | undefined

  /** 只看不取（面板用）。 */
  peekSleepBuffer(): string | undefined

  /** 算一次「现在该干什么」。**不改状态**。 */
  plan(at?: number): ActivityPlan

  /** 兴趣表（按有效权重降序）。 */
  interests(at?: number): readonly InterestView[]

  /**
   * 时间驱动的入口：结算能量，必要时开始一次活动并留下笔记。
   *
   * 由 `ondra-clock` 的 `every()` 驱动，**没有自己的定时器**。
   * @param at 时刻。
   */
  tick(at?: number): TickResult

  /** 最近的生活笔记（新的在前）。 */
  notes(limit?: number): readonly LifeNote[]

  /** 过去一段时间的生活摘要。 */
  brief(at?: number, windowMinutes?: number): LifeBrief

  /**
   * 写回一次回应（`life_react`）：`like` 加权、`meh` 减权，并把笔记标成已回应。
   * @param id 笔记标识。
   * @param reaction 回应。
   * @param at 时刻。
   */
  react(id: string, reaction: 'like' | 'meh', at?: number): LifeNote | undefined

  /** 运行计数。 */
  stats(): LifeStats
}

/* ------------------------------------------------------------------ *
 * 结构对位（不 import 其他插件源码，§15.5）
 * ------------------------------------------------------------------ */

/** 时间服务的结构对位子集。 */
export interface ClockLike {
  now(): number
  dayKey(epoch?: number): string
  minuteOfDay(epoch?: number): number
  withinWindow(start: string, end: string, epoch?: number): boolean
  every(intervalMs: number, fn: () => void): () => void
  after(ms: number, fn: () => void): () => void
}

/** 路径服务的结构对位子集。 */
export interface PathLike {
  fileIn(area: 'user', ...segments: string[]): string
  exists(filePath: string): boolean
  prepareFile(filePath: string): string
}

/** 日志器的结构对位子集。 */
export interface LogLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** 字段声明（与 O-005 对位）。 */
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

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}
