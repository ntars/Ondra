/**
 * O-139 `ondra-failure-attrib` 的对外契约：**八类失败归因 + 处方表 + 伤口闭合判定**（手册 §8.6）。
 *
 * ## 这个包要治的病
 *
 * 手册原话：「Ondra 现在只有『静默降级』，没有归因。」
 * 静默降级的后果不是「难看」，是**学不到东西**：同一个错犯一百次，
 * 每次都被吞掉，下一次还是不知道为什么会失败。
 *
 * 八类的名字是手册逐字给的，本包一个字都不改：
 * `tool_missing / arg_error / permission / timeout / network / not_found / conflict / unknown`。
 *
 * ## 三条判定写在这里，不许下游自造
 *
 * 1. **`arg_error` 永不自动重试。** 手册逐字。这一条**不放在处方表里**，
 *    而是写在 `retryBudget()` 的第一行——表可以被配置覆盖，铁律不行。
 *    理由也写在手册里：让不知道密码的人重试 100 次还是登不进去。
 * 2. **伤口只在该工具下一次成功时才闭合。** 不是超时闭合，不是「过了就好」。
 *    超时闭合会让一个一直坏着的工具看起来「自愈了」。
 * 3. **5 分钟未闭合标 `chronic`。** 手册逐字（`chronicAfterMs = 300_000`）。
 *    标了 chronic 就**停止空转**：不再尝试，只等人。
 *
 * ## 为什么伤口按「工具」记账，而不是按「工具×因」
 *
 * 手册写的是「伤口只在该器官下次成功时才闭合」——主体是**器官**（这里映射为工具）。
 * 一个工具同时因为两个原因失败，仍然是「这个工具现在不好使」一件事。
 * 但**每个原因的次数要分开记**：O-144 的反射弧判据是「同工具×同因失败 3 次」，
 * 合并计数会让两个不同的病因凑成 3 次。
 *
 * ## 与「重试按钮画不画」的关系
 *
 * 原先 `ondra-ui-toast`（O-089）内嵌过一份八类裁决表，本包是**真源**、它是**副本**。
 * 2026-11-03 L8 界面整批下线后，**副本随插件一起移除，本包成为全仓唯一真源**；
 * `verdict` 的三个取值（`never` / `manual` / `retry`）保持不变，避免推翻既有调用方。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const ATTRIB_SERVICE_KEY = 'ondra-failure-attrib'

/** 八类归因。**手册 §8.6 / 语料·第一编 2.A 逐字，不许增删改。** */
export const CAUSES = Object.freeze([
  'tool_missing',
  'arg_error',
  'permission',
  'timeout',
  'network',
  'not_found',
  'conflict',
  'unknown',
] as const)

/** 一类归因。 */
export type Cause = (typeof CAUSES)[number]

/** 查表版（`includes` 在 readonly 元组上不接受任意字符串）。 */
export const CAUSE_SET: ReadonlySet<string> = new Set<string>(CAUSES)

/**
 * 重试裁决。取值与 O-089 `RETRY_RULES` 逐字一致：
 * `never` 永不重试 / `manual` 要人先动手 / `retry` 可以退避重试。
 */
export type RetryVerdict = 'never' | 'manual' | 'retry'

/** 处方要人做的那件事（比 verdict 更具体，给界面与日志用）。 */
export type RemedyAction =
  /** 补信息：告诉模型它缺了什么。 */
  | 'supplement'
  /** 改参数：先看清要什么，再补上缺的那项。 */
  | 'fix-args'
  /** 升级给人：权限、授权。 */
  | 'escalate'
  /** 退避重试。 */
  | 'retry-later'
  /** 先查清事实再决定。 */
  | 'inspect'
  /** 先装工具。 */
  | 'install'

/** 一张处方。 */
export interface Prescription {
  readonly cause: Cause
  /** 重试裁决。 */
  readonly verdict: RetryVerdict
  /** 具体动作。 */
  readonly action: RemedyAction
  /** 一句中文，给模型与日志看。**不许出现数值**（内感受铁律的延伸：处方不是读数）。 */
  readonly hint: string
  /** 是不是必须人来做。 */
  readonly needsHuman: boolean
  /** 是不是手册原文（`false` = 本包推导，必须标出来）。 */
  readonly derived: boolean
  /** 依据。 */
  readonly source: string
}

/** 一次归因的输入。全部可选，缺什么就按缺的判。 */
export interface FailureInput {
  /** 哪个工具。 */
  readonly tool: string
  /** 上游 `error.info.code`（例如 `UNKNOWN_TOOL` / `INVALID_TOOL_OUTPUT` / `ABORTED`）。 */
  readonly code?: string
  /** 上游 `error.message`（给模型看的那句）。 */
  readonly message?: string
  /** 耗时（毫秒）；上游不一定给。 */
  readonly durationMs?: number
}

/** 一次归因的结果。 */
export interface Attribution {
  readonly tool: string
  readonly cause: Cause
  /** 命中的是哪一条判据（`code:UNKNOWN_TOOL` / `msg:timeout` / `fallback`）。 */
  readonly matched: string
  /** 一句人话。 */
  readonly detail: string
  /** 原始 code（透传，便于对账）。 */
  readonly code?: string
}

/** 一个伤口。 */
export interface Wound {
  /** 哪个工具。 */
  readonly tool: string
  /** 最近一次失败的原因。 */
  readonly cause: Cause
  /** 第一次失败的时刻。 */
  readonly openedAt: number
  /** 最近一次失败的时刻。 */
  readonly lastAt: number
  /** 累计失败次数。 */
  readonly failures: number
  /** 每个原因各失败了几次（O-144 的判据要它）。 */
  readonly byCause: Readonly<Record<string, number>>
  /** 是否已标 chronic（超时未闭合）。 */
  readonly chronic: boolean
  /** 标 chronic 的时刻；没标就省略。 */
  readonly chronicAt?: number
}

/** 一个已闭合的伤口（留痕用，不进 `wounds()`）。 */
export interface HealedWound extends Wound {
  /** 闭合时刻。 */
  readonly closedAt: number
  /** 从开到合多久。 */
  readonly openMs: number
}

/** 伤口账本的统计。 */
export interface WoundStats {
  readonly open: number
  readonly chronic: number
  readonly healed: number
  readonly chronicHealed: number
  readonly meanHealMs: number
  /** 因账本满被拒的新伤口数。**不淘汰旧伤口**，所以这个数必须露出来。 */
  readonly refused: number
}

/** 一份失败报告。 */
export interface FailureReport {
  readonly at: number
  readonly wounds: WoundStats
  /** 各类失败的累计次数。 */
  readonly byCause: Readonly<Record<string, number>>
  /** 愈合率 = 已闭合 / (已闭合 + 未闭合)。手册的「21 伤口 100% 愈合」就是这个口径。 */
  readonly healRate: number
}

/** 服务统计。 */
export interface AttribStats {
  readonly at: number
  /** 收到多少个工具结果。 */
  readonly results: number
  /** 其中失败的。 */
  readonly failures: number
  /** 其中成功的。 */
  readonly successes: number
  /** 归因不了的结果数：没有工具名，或结果形状不可识别。不猜——猜错会污染整本账。 */
  readonly unnamed: number
  /** 喂给器官宿主的次数。 */
  readonly feeds: number
  /** 喂失败次数（宿主抛错）。 */
  readonly feedErrors: number
  readonly wounds: WoundStats
  readonly byCause: Readonly<Record<string, number>>
}

/** 服务不可用的原因。 */
export type AttribUnavailableReason = 'disabled'

/** 失败归因服务。 */
export interface FailureAttribService {
  /** 是否在工作。 */
  readonly available: boolean
  readonly reason?: AttribUnavailableReason

  /** 纯归因：不记账、不开伤口。界面、单测、审计走它。 */
  classify(input: FailureInput): Attribution
  /** 取一张处方。 */
  prescription(cause: Cause): Prescription
  /**
   * 还能不能再试一次。
   * @param cause 归因。
   * @param attempts 已经试过几次（不含这一次）。
   */
  shouldRetry(cause: Cause, attempts?: number): boolean

  /** 记一次失败：归因 + 开伤口 + 计数。 */
  noteFailure(input: FailureInput): Attribution
  /** 记一次成功：闭合该工具的伤口。@returns 被闭合的伤口（没有就是 undefined）。 */
  noteSuccess(tool: string): Wound | undefined

  /** 当前未闭合的伤口（按 `lastAt` 降序）。 */
  wounds(): readonly Wound[]
  /** 某个工具的伤口。 */
  woundOf(tool: string): Wound | undefined
  /** 检查超时：把该标 chronic 的标上。@returns 本次新标 chronic 的伤口。 */
  sweep(at?: number): readonly Wound[]
  /** 已闭合伤口的历史（最近 N 条，新的在前）。 */
  healed(limit?: number): readonly HealedWound[]

  /** 报告。 */
  report(): FailureReport
  /** 统计。 */
  stats(): AttribStats
  /** 卸载：清账本。幂等。 */
  dispose(): void
}

/** 日志形状（结构对位 Cordis logger 的子集）。 */
export interface LogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
  error(message: string, ...args: readonly unknown[]): void
}

/** O-001 身份服务的形状（只取日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(decl: unknown, by?: string): () => void
  resolve(id: string, layers: Record<string, unknown>): { readonly values: unknown; readonly fallbackCount: number } | undefined
}

/* ------------------------------------------------------------------ *
 * 上游形状的结构对位子集（只声明本包真的读的字段）
 *
 * 一律不 import 上游源码（§3.3-1）：两个插件编译期互相绑定之后，
 * 任何一方单独卸载都会让另一方编译失败。
 * ------------------------------------------------------------------ */

/** 上游 `ToolErrorInfo` 的子集。 */
export interface ToolErrorInfoLike {
  readonly name?: string
  readonly code?: string
  readonly reason?: string
}

/** 上游 `ToolFailure` 的子集。 */
export interface ToolFailureLike {
  readonly message?: string
  readonly info?: ToolErrorInfoLike
}

/** 上游 `ToolExecutionResult` 的子集。判别只看 `isError`。 */
export interface ToolResultLike {
  readonly isError?: boolean
  readonly error?: ToolFailureLike
  readonly content?: readonly unknown[]
}

/** 上游 `ToolExecution` 的子集。 */
export interface ToolExecutionLike {
  readonly name?: string
  readonly agent?: unknown
}

/** O-132 器官宿主的子集：只声明本包要喂的那一个方法。 */
export interface OrganHostLike {
  readonly available: boolean
  toolResult(result: {
    readonly at: number
    readonly tool: string
    readonly ok: boolean
    readonly errorCode?: string
    readonly text?: string
    readonly durationMs?: number
  }): unknown
}
