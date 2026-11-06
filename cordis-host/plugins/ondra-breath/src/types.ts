/**
 * O-041 `ondra-breath` 的对外契约：**「正在输入」与呼吸感动作**。
 *
 * 手册只有两句原文，本插件只做这两件事：
 *
 * | 手册原文 | 本契约 |
 * |---|---|
 * | §4.2「呼吸感动作『（伸了个懒腰）』单日 ≤2 次」 | `take()` + `dailyCap`（上限锁 2） |
 * | master-plan §5「`ondra-breath`（『正在输入』与呼吸感，单日上限）」 | `presence()` |
 *
 * ## 三条边界
 *
 * 1. **不显示，只回答「该不该显示」。** 界面归 O-085+；本插件出 `show: boolean`
 *    与一句原因码，谁画谁负责。做成「我来控制指示器」就等于把 UI 塞进插件。
 *
 * 2. **不发消息。** `take()` 只返回「今天还能不能来一次、是哪一句」，
 *    真正发出去要经通道（O-055+）与分条（O-038）。本插件连 `setTimeout` 都不 import。
 *
 * 3. **长停顿期间不显示正在输入。** 这是 O-039 已经定下的口径
 *    （它的 README：「指示器亮 9 秒却一个字不来，比不亮更假」）。
 *    本插件把它变成一条可执行的映射，**不提供开关**——开关一开，
 *    症状是「她一直显示正在输入」，没人会怀疑到配置项上。
 *
 * ## 「单日上限 2」只管呼吸感动作
 *
 * 手册那一句的主语是「呼吸感动作」。`presence()` 不受它约束——
 * 一天说 200 句话不该只显示 2 次正在输入。
 */

/** 本插件注册的服务键（连字符，非 `ondra:breath`）。全仓唯一归属。 */
export const BREATH_SERVICE_KEY = 'ondra-breath'

/** 命名硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单日呼吸感动作硬上限。手册原文「单日 ≤2 次」，配置的 `max` 也锁 2。 */
export const HARD_DAILY_CAP = 2

/** 动作池上限。超过 12 条没有意义——一天最多用 2 次。 */
export const HARD_MAX_ACTIONS = 12

/**
 * 手册给的唯一一条呼吸感动作（§4.2 逐字）。
 *
 * **出厂只有这一条**。手册没给第二句，编三句「揉了揉眼睛」就是在替人设写动作；
 * 想要更多请 `registerActions()`。池子只有一条时，「同一动作单日最多一次」
 * 会把实际用量压到 1 次/天——一天伸两次懒腰本身也可疑。
 */
export const HANDBOOK_ACTION = '（伸了个懒腰）'

/* ------------------------------------------------------------------ *
 * 一、「正在输入」
 * ------------------------------------------------------------------ */

/** 打字阶段（镜像 O-039 的 `TypingPhase`，不 import）。 */
export type TypingPhaseLike = 'idle' | 'thinking' | 'typing' | 'paused'

/** 为什么显示 / 为什么不显示。 */
export type PresenceReason =
  /** 正在打字。 */
  | 'typing'
  /** 首条之前的思考。 */
  | 'thinking'
  /** 长停顿：她走神了，**不该显示正在输入**。 */
  | 'paused'
  /** 本轮结束。 */
  | 'idle'
  /** 没有 O-039，无从判断。 */
  | 'no-typing'
  /** 本插件被关掉。 */
  | 'disabled'

/** 「正在输入」判定结果。 */
export interface PresenceView {
  readonly conversationId: string
  /** 此刻是否该显示「正在输入」。 */
  readonly show: boolean
  /** 当前阶段（没有 O-039 时为 `idle`）。 */
  readonly phase: TypingPhaseLike
  readonly reason: PresenceReason
}

/** 阶段事件（转发 O-039 并附上判定）。 */
export interface BreathEvent extends PresenceView {
  readonly at: number
}

/* ------------------------------------------------------------------ *
 * 二、呼吸感动作
 * ------------------------------------------------------------------ */

/** 一条呼吸感动作。 */
export interface BreathAction {
  readonly id: string
  /** 完整片段，含全角括号，例如「（伸了个懒腰）」。 */
  readonly text: string
  /** 来源：手册原文，还是调用方注册的。 */
  readonly origin: 'handbook' | 'custom'
}

/** 注册时的最小形状。 */
export interface BreathActionInput {
  readonly id?: string
  readonly text: string
}

/** 注册结果。**永不抛错**：坏条目逐条丢弃并说明原因。 */
export interface ActionRegistration {
  readonly ok: boolean
  readonly size: number
  readonly dropped: number
  readonly issues: readonly string[]
}

/** 某个动作今天的用量。 */
export interface ActionUsage {
  readonly id: string
  readonly text: string
  readonly used: number
}

/** 今天的额度。 */
export interface BreathQuota {
  /** 自然日键（`YYYY-MM-DD`）。 */
  readonly dayKey: string
  readonly used: number
  readonly cap: number
  readonly remaining: number
  readonly actions: readonly ActionUsage[]
}

/** 为什么没给动作。 */
export type BreathReason =
  /** 给了。 */
  | 'ok'
  /** 本插件被关掉（或呼吸感关掉）。 */
  | 'disabled'
  /** 今天两次用完了。 */
  | 'quota'
  /** 池子里每个动作今天都用过了。 */
  | 'duplicate-action'
  /** 池子是空的（不该发生：出厂至少有一条手册动作）。 */
  | 'no-action'

/** 一次取动作的结果。 */
export interface BreathDecision {
  readonly allowed: boolean
  readonly reason: BreathReason
  /** 给的动作（没给时缺省）。 */
  readonly action?: BreathAction
  /** 动作正文（= `action.text`，省得调用方再解一层）。 */
  readonly text?: string
  readonly quota: BreathQuota
}

/** 取动作的入参。 */
export interface BreathTakeRequest {
  /** 时刻（判自然日用）。省略用系统时间。 */
  readonly at?: number
  /** 随机源（测试可注入）。 */
  readonly rng?: () => number
  /** 本次不要用的动作 id。 */
  readonly exclude?: readonly string[]
}

/* ------------------------------------------------------------------ *
 * 三、服务
 * ------------------------------------------------------------------ */

/** 统计快照。 */
export interface BreathStats {
  /** 取过多少次。 */
  readonly takes: number
  /** 给了多少次。 */
  readonly allowed: number
  /** 因为额度用完拒绝的次数。 */
  readonly deniedQuota: number
  /** 因为动作都用过拒绝的次数。 */
  readonly deniedDuplicate: number
  /** 跨过几个自然日（含首次）。 */
  readonly days: number
  /** 动作池大小。 */
  readonly actions: number
  /** 问 O-039 时抛错的次数（已吞掉，不外抛）。 */
  readonly typingErrors: number
}

/** 「正在输入」与呼吸感服务。 */
export interface BreathService {
  /** 是否启用（只看配置开关）。 */
  readonly available: boolean
  /** 不可用原因（**只有配置关掉**才算不可用）。 */
  readonly reason?: 'disabled'
  /**
   * 打字执行层此刻是否在位。
   *
   * 与 `available` 分开：只看前者会让面板显示「呼吸感已启用」，
   * 而实际 `presence()` 永远返回「不显示」——那种「一切正常但没效果」最难查。
   */
  readonly typingReady: boolean

  /** 此刻该不该显示「正在输入」。**只读**，不改任何状态。 */
  presence(conversationId?: string): PresenceView

  /**
   * 订阅阶段变化（转成 `BreathEvent`）。
   *
   * 返回 disposer。**在调用时取一次 O-039**：它缺席就返回空 disposer，
   * 之后它再装载也不会补订——这条限制写进 README，不做定时重试
   * （重试需要一个常驻定时器，违反零常驻）。
   */
  subscribe(listener: (event: BreathEvent) => void): () => void

  /** 全部动作（含今天的用量）。 */
  actions(): readonly BreathAction[]
  /** 注册/追加动作。**永不抛错**。 */
  registerActions(actions: readonly BreathActionInput[]): ActionRegistration

  /** 今天还剩几次（**只读**，不消耗额度）。 */
  peek(at?: number): BreathQuota
  /** 今天还剩几次（`peek()` 的别名，给面板用）。 */
  daily(at?: number): BreathQuota

  /** 取一次动作（**会消耗额度**）。 */
  take(request?: BreathTakeRequest): BreathDecision

  stats(): BreathStats
}

/* ------------------------------------------------------------------ *
 * 四、上游与宿主的结构对位（§18.5：不 import 源码）
 * ------------------------------------------------------------------ */

/** O-039 的阶段事件子集。 */
export interface TypingEventLike {
  readonly conversationId: string
  readonly phase: TypingPhaseLike
  readonly at: number
}

/** O-039 服务的结构对位子集。 */
export interface TypingServiceLike {
  phaseOf(conversationId?: string): TypingPhaseLike
  subscribe(listener: (event: TypingEventLike) => void): () => void
}

/** O-003 时间服务的结构对位子集（只要自然日键）。 */
export interface ClockLike {
  dayKey(epoch?: number): string
}

/** 日志门面的最小形状。 */
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
  readonly default?: unknown
  /** `kind: 'enum'` 的候选（O-005 的字段名是 `values`，不是 `options`）。 */
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
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
  resolve(
    sectionId: string,
    layers?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly total?: number; readonly fallbackCount: number }
    | undefined
}
