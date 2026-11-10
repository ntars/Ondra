/**
 * O-039 `ondra-rhythm-typing` 的对外契约：**把分条计划变成真实的时间线**。
 *
 * O-038 只回答「分几条、等多久」，一个字都不发。本插件负责把它跑出来：
 * 先「正在输入」，等够时间，发一条，再「正在输入」，再等，再发……
 *
 * ## 四件必须先说清的事
 *
 * 1. **降级是「一次性整段发出」，不是「不发」。** 没有 O-038、O-038 报错、
 *    或本插件被关掉，都退成一条消息直接发。**不模拟打字**——假装打字比直接发出
 *    更像骗人，而且没有计划就没有「该等多久」的依据。
 *
 * 2. **同一会话的新一轮会顶掉上一轮。** 上一轮还在打字、用户又说话了，
 *    继续把旧回复发完，会出现「新回答先到、旧回答后到」——顺序错乱比少发一条严重。
 *    被顶掉的那轮结果里 `superseded: true`，日志能查到。
 *
 * 3. **`run()` 永不抛出。** 调用方已经在处理一个异步发送流程，再让它同时处理异常，
 *    必然有一边漏——漏掉的那边表现为「她永远不回」。
 *
 * 4. **阶段事件是给 O-041 的。** `subscribe()` 暴露 `thinking / typing / paused / idle`，
 *    O-041 `ondra-breath` 靠它决定「什么时候显示正在输入、什么时候插一个呼吸感动作」。
 *    本插件不显示任何 UI。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * O-038 的形状用结构对位镜像。
 */

/** 本插件注册的服务键（连字符，非 `ondra:rhythm-typing`）。全仓唯一归属。 */
export const TYPING_SERVICE_KEY = 'ondra-rhythm-typing'

/** 命名硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/* ------------------------------------------------------------------ *
 * 一、阶段
 * ------------------------------------------------------------------ */

/**
 * 打字阶段。
 *
 * - `thinking`：首条之前的「看到了、在想」（首字延迟 800–2000ms）。
 * - `typing`：两条之间的正常打字等待。
 * - `paused`：长停顿（3000–9000ms）——她走神了，**此时不该显示「正在输入」**。
 * - `idle`：本轮结束（或没有在跑）。
 */
export type TypingPhase = 'idle' | 'thinking' | 'typing' | 'paused'

/** 一步：等多久，然后发什么。 */
export interface TypingStep {
  /** 序号，从 0 起。 */
  readonly index: number
  /** 要发的正文（**逐字来自 O-038，本插件不改一个字**）。 */
  readonly text: string
  /** 这条之前等多久（含长停顿）。 */
  readonly waitMs: number
  /** 这段等待期间对外报的阶段。 */
  readonly phase: TypingPhase
  /** 这段等待里是否含长停顿。 */
  readonly longPause: boolean
}

/** 降级原因。 */
export type TypingDegradeReason =
  /** 插件被关闭。 */
  | 'disabled'
  /** 没有 O-038（节奏服务缺席）。 */
  | 'no-rhythm'
  /** O-038 抛错。 */
  | 'rhythm-error'
  /** 正文为空。 */
  | 'empty-text'

/** 一次排好的时间线。 */
export interface TypingSchedule {
  /** 会话 id。 */
  readonly conversationId: string
  /** 逐步计划。 */
  readonly steps: readonly TypingStep[]
  /** 总时长（各步 `waitMs` 之和）。 */
  readonly totalMs: number
  /** 计划来源：`rhythm` 正常，`oneshot` 降级。 */
  readonly source: 'rhythm' | 'oneshot'
  /** 降级原因（正常时为 `null`）。 */
  readonly degraded: TypingDegradeReason | null
  /** 一句人话说明（日志与面板用）。 */
  readonly notes: readonly string[]
}

/* ------------------------------------------------------------------ *
 * 二、事件与回调
 * ------------------------------------------------------------------ */

/** 阶段事件。 */
export interface TypingEvent {
  readonly conversationId: string
  readonly phase: TypingPhase
  /** 当前是第几条（0 起）。`idle` 时等于总条数。 */
  readonly index: number
  /** 本轮共几条。 */
  readonly total: number
  /** 事件时刻（毫秒）。 */
  readonly at: number
}

/** 发送回调。 */
export interface TypingHandlers {
  /**
   * 发一条。
   *
   * 允许返回 Promise（通道发送是异步的）。**抛错会终止本轮**：
   * 发送失败通常意味着通道坏了，继续发剩下的只会把错误放大。
   */
  send(text: string, index: number): void | Promise<void>
  /** 阶段变化回调（可选）。与 `subscribe()` 收到的是同一个事件。 */
  phase?(event: TypingEvent): void
}

/** 执行选项。 */
export interface TypingOptions {
  /** 会话 id，省略用配置里的默认值。 */
  readonly conversationId?: string
  /** 时刻（判深夜用），省略用系统时间。 */
  readonly at?: number
  /**
   * 刚睡醒（开头慢半拍）。
   *
   * 手册第 1363 行把「刚醒缓冲」列为缺口，建议并入 `rhythm-typing` 或
   * `life-rhythm`。本插件提供这个开关，但**默认缓冲为 0**——
   * 「刚醒」的信号源属于 O-049 `ondra-life-rhythm`（尚未建）。
   */
  readonly justWoke?: boolean
  /** 外部取消信号。 */
  readonly signal?: AbortSignal
  /** 表达档（透传给 O-038）。 */
  readonly style?: TypingStyle
}

/** 表达档（与 O-038 的 `RhythmStyle` 同形）。 */
export interface TypingStyle {
  readonly speechRateDelta?: number
  readonly tempo?: string
  readonly sentenceShape?: string
}

/** 一次执行的结果。 */
export interface TypingResult {
  readonly conversationId: string
  /** 实际发出几条。 */
  readonly sent: number
  /** 计划共几条。 */
  readonly total: number
  /** 是否被取消（外部 signal 或 `cancel()`）。 */
  readonly aborted: boolean
  /** 是否被同会话的下一轮顶掉。 */
  readonly superseded: boolean
  /** 降级原因（正常时为 `null`）。 */
  readonly degraded: TypingDegradeReason | null
  /** 实际耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 失败原因（发送抛错时）。 */
  readonly error?: string
}

/** 统计快照。 */
export interface TypingStats {
  /** 跑过多少轮。 */
  readonly runs: number
  /** 累计发出条数。 */
  readonly sent: number
  /** 被取消的轮数。 */
  readonly aborted: number
  /** 被顶掉的轮数。 */
  readonly superseded: number
  /** 降级轮数。 */
  readonly degraded: number
  /** 发送失败的轮数。 */
  readonly failed: number
  /** 当前在跑的会话数。 */
  readonly active: number
  /** 平均耗时（毫秒，保留整数）。 */
  readonly avgElapsedMs: number
}

/* ------------------------------------------------------------------ *
 * 三、服务
 * ------------------------------------------------------------------ */

/** 打字执行服务。 */
export interface TypingService {
  /** 是否启用（只看配置开关）。 */
  readonly available: boolean
  /** 不可用原因（配置关闭）。 */
  readonly reason?: 'disabled'
  /**
   * 节奏服务此刻是否在位。
   *
   * 与 `available` 分开：`available` 只说「本插件开着」，`rhythmReady` 说
   * 「分条与停顿真的能用」。只看前者会让面板显示「打字节奏已启用」，
   * 而实际每一轮都在降级——那种「一切正常但没效果」最难查。
   */
  readonly rhythmReady: boolean

  /** 只排时间线，不执行（面板预览、调试用）。 */
  schedule(text: string, options?: TypingOptions): TypingSchedule

  /**
   * 跑一条时间线。
   *
   * **永不抛出**：任何失败都写进返回值（`error` / `aborted` / `superseded`）。
   */
  run(text: string, handlers: TypingHandlers, options?: TypingOptions): Promise<TypingResult>

  /** 取消某会话（省略则取消全部）在跑的一轮。没有在跑时返回 `false`。 */
  cancel(conversationId?: string): boolean

  /** 读某会话当前的阶段（没有在跑时为 `idle`）。 */
  phaseOf(conversationId?: string): TypingPhase

  /**
   * 订阅阶段事件（O-041 用）。
   *
   * 返回 disposer。监听器抛错只记日志，**绝不影响发送循环**。
   */
  subscribe(listener: (event: TypingEvent) => void): () => void

  /** 统计快照。 */
  stats(): TypingStats
}

/* ------------------------------------------------------------------ *
 * 四、上游与宿主的结构对位（§18.5：不 import 源码）
 * ------------------------------------------------------------------ */

/** O-038 的一条消息（只取本插件要用的字段）。 */
export interface RhythmMessageLike {
  readonly index: number
  readonly text: string
  readonly delayMs: number
  readonly pauseMs: number
}

/** O-038 的计划（只取本插件要用的字段）。 */
export interface RhythmPlanLike {
  readonly messages: readonly RhythmMessageLike[]
  readonly totalMs: number
}

/** O-038 服务的结构对位子集。 */
export interface RhythmServiceLike {
  readonly available: boolean
  plan(request: {
    readonly text: string
    readonly at?: number
    readonly style?: TypingStyle
  }): RhythmPlanLike
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
  resolve(
    sectionId: string,
    layers?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly total?: number; readonly fallbackCount: number }
    | undefined
}
