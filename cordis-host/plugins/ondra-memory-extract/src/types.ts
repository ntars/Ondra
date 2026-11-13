/**
 * O-011 `ondra-memory-extract` 的对外契约。
 *
 * 定位：把一轮对话变成**带出处的事实候选**，并在写库之前用确定性代码把
 * 「编造」「错归属」「凭印象写数字」三类污染挡在门外。
 *
 * 为什么这道闸必须存在（手册 §2.2 原话）：「自我强化幻觉污染整库是提示词拦不住的，
 * 必须确定性代码闸门。」模型说「用户怕狗」很容易，但要在原文里指出哪一句说了「怕狗」，
 * 就难得多——**逐字校验把「记得」从生成任务变成了检索任务**，而检索是可以验证的。
 *
 * 三处刻意的边界：
 *
 * 1. **不做判重裁决**。`add / merge / append / conflict / drop` 五分类是 O-012 的活。
 *    本插件只保证「交出去的是干净候选」，合并策略由 O-012 定；O-012 缺席时按 `append`
 *    直接写（不合并），并在结果里标 `dedupe: 'absent'`——**绝不假装合并过**。
 * 2. **不算寿命、不算显著度**。那是 O-010 的事。本插件只给 `salienceHint`（可选提示），
 *    最终分值由 O-010 的打分表决定——否则同一句话会有两个分数，且没人知道哪个生效。
 * 3. **不建会话、不写 session_log**（master-plan §6 禁令 5）。
 *
 * 与 O-010 的关系：**结构对位，不 import 源码**（§18.5）。代价是 11 类清单与
 * `FactInput` 字段要在两边人工同步，维护纪律见本文件末尾。
 */

/** 本插件注册的服务键（连字符）。全仓唯一归属。 */
export const EXTRACT_SERVICE_KEY = 'ondra-memory-extract'

/**
 * 11 个寿命类别（与 O-010 的 `MEMORY_CATEGORIES` **必须逐字一致**）。
 *
 * 为什么这里要再抄一份：提示词必须把可选值告诉模型，否则它会自己发明类别
 * （「宠物」「工作」这类），而 O-010 收到未知类别只能退回 `misc`——
 * 一条关于「她自己」的记忆被当成杂项，寿命从 20000 小时掉到 20 小时。
 *
 * **维护纪律**：改这里必须同步改 O-010 `src/types.ts` 的 `MEMORY_CATEGORIES`。
 * O-010 侧对未知类别做的是「退回 misc + 记 issue」，所以漏同步不会崩，
 * 只会静默降级——这正是要人工同步的原因。
 */
export const EXTRACT_CATEGORIES = [
  'watch',
  'daily',
  'food',
  'place',
  'misc',
  'event',
  'feeling',
  'study',
  'person',
  'promise',
  'self',
] as const

/** 寿命类别。 */
export type ExtractCategory = (typeof EXTRACT_CATEGORIES)[number]

/** 5 个种类标签（与 O-010 的 `MEMORY_KINDS` 必须逐字一致）。 */
export const EXTRACT_KINDS = ['episode', 'fact', 'reflection', 'skill', 'lesson'] as const

/** 种类标签。 */
export type ExtractKind = (typeof EXTRACT_KINDS)[number]

/**
 * 引文来源四类（手册 §2.2）。
 *
 * - `USER`：用户说的话；
 * - `TOOL`：工具/命令/搜索的返回；
 * - `ACT`：实际发生的动作或系统事件；
 * - `SELF`：她自己说过的话。
 */
export const EVIDENCE_SOURCES = ['USER', 'TOOL', 'ACT', 'SELF'] as const

/** 引文来源。 */
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

/** 一条引文。 */
export interface Evidence {
  /** 来源。 */
  readonly source: EvidenceSource
  /** 逐字引文。 */
  readonly quote: string
  /** 来自本轮第几条消息（从 0 起）。 */
  readonly messageIndex: number
}

/** 本轮的一条消息。 */
export interface TurnMessage {
  /** 角色。 */
  readonly role: 'user' | 'assistant' | 'tool'
  /** 正文。 */
  readonly text: string
  /**
   * 引文来源覆盖。
   *
   * 默认由 `role` 推导（user→USER、assistant→SELF、tool→TOOL）。
   * 需要区分「她说」与「她做」时（`ACT`），调用方在这里显式标注——
   * 从文本里猜「这是不是动作」必然猜错，而猜错会让归属判定失效。
   */
  readonly source?: EvidenceSource
}

/** 会话场景。群聊默认不提炼（手册 §2.2 准入红线：不收群友闲聊）。 */
export type ExtractScope = 'private' | 'group'

/** 一次提炼请求。 */
export interface ExtractRequest {
  /** 轮次 id（同一轮内唯一，只用于日志与结果溯源）。 */
  readonly turnId: string
  /**
   * 本轮原文在 `memory_raw` 里的 id。
   *
   * 与 `turnId` **不是一回事**：`turnId` 是调用方自己编的轮次号，
   * `rawId` 是 O-010 `appendTurn()` 返回的原文行 id。只有 `rawId` 能让
   * O-017 顺着「事实 → 原文」查回去，所以能传就传。
   */
  readonly rawId?: string
  /** 本轮消息。 */
  readonly messages: readonly TurnMessage[]
  /** 场景，默认 `private`。 */
  readonly scope?: ExtractScope
  /** 时间戳，默认当前时刻。 */
  readonly at?: number
  /** 本轮最多提炼几条，默认取配置。 */
  readonly maxFacts?: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/** 提炼出来的一条事实（**已通过校验**）。 */
export interface ExtractedFact {
  /** 种类标签。 */
  readonly kind: ExtractKind
  /** 寿命类别。 */
  readonly category: ExtractCategory
  /** 正文，≤ `maxTextChars`。 */
  readonly text: string
  /** 摘要，≤ `maxSummaryChars`。 */
  readonly summary: string
  /** 主体：`user` / `self` / 具体人名。 */
  readonly subject: string
  /** 四类引文，至少一条。 */
  readonly evidence: readonly Evidence[]
  /** 显著度提示（0–100，可选）。**只是提示**，最终分归 O-010 的打分表。 */
  readonly salienceHint?: number
}

/** 拒绝原因码。 */
export type RejectionCode =
  /** 一条引文都没有。 */
  | 'no-evidence'
  /** 引文与原文不逐字一致。 */
  | 'quote-not-verbatim'
  /** 引文太短（默认 <2 字），做不了证据。 */
  | 'quote-too-short'
  /** 正文里有数字，但没有 TOOL 引文覆盖。 */
  | 'digit-without-tool'
  /** 归功断言（主体不是她自己）却没有 USER 引文。 */
  | 'attribution-without-user'
  /** 正文为空。 */
  | 'empty-text'
  /** 正文超过上限（截断后仍为空，或截断前就没有内容）。 */
  | 'text-too-long'
  /** 类别不在 11 类里。 */
  | 'bad-category'
  /** 种类不在五类里。 */
  | 'bad-kind'
  /** 本轮内重复（按去空白后的正文比对）。 */
  | 'duplicate'
  /** 命中墓碑：这条被明确要求忘记过，不许复活。 */
  | 'tombstoned'
  /** 群聊场景，按准入红线不提炼。 */
  | 'group-chatter'
  /** 写入端失败。 */
  | 'write-failed'
  /** 超过本轮条数上限。 */
  | 'over-limit'

/** 一条被拒绝的候选。 */
export interface ExtractRejection {
  /** 原因码。 */
  readonly code: RejectionCode
  /** 中文说明，直接给人看。 */
  readonly detail: string
  /** 原候选在本轮输出里的序号（从 0 起）。 */
  readonly index?: number
}

/** 解析路径（五级兜底，见 `parse.ts`）。 */
export type ParsePath = 'strict-json' | 'fenced-json' | 'line' | 'key-value' | 'none'

/** 一次提炼的结果。 */
export interface ExtractResult {
  /** 是否走通了模型调用（`false` 表示降级返回空，不是「没有事实」）。 */
  readonly ok: boolean
  /** 已通过校验并写库的事实。 */
  readonly facts: readonly ExtractedFact[]
  /** 被拒绝的候选。**不是错误**，是证据闸门的正常工作。 */
  readonly rejections: readonly ExtractRejection[]
  /** 解析路径。 */
  readonly parsePath: ParsePath
  /** 成功写入条数（`propose()` 恒为 0）。 */
  readonly written: number
  /** 不可用或失败的原因（`ok=true` 时不带）。 */
  readonly reason?: ExtractUnavailableReason | ExtractErrorCode
  /** 实际服务的来源 id。 */
  readonly sourceId?: string
  /** 用量。 */
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
}

/**
 * 提炼服务。
 *
 * 两个入口刻意分开：`propose()` 只提炼不写，`extract()` 提炼并直写。
 * 为什么不是「一个入口 + 一个 dedupe 开关」：O-012 判重需要**先看到候选、再决定合并谁**，
 * 而「先写进去再合并」会让合并变成删改，日志里看不出原本是两条。
 */
export interface ExtractService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ExtractUnavailableReason
  /**
   * 只提炼、不写库（给 O-012 判重用）。
   * @param request 请求。
   */
  propose(request: ExtractRequest): Promise<ExtractResult>
  /**
   * 提炼并直写（O-012 缺席时的默认路径，语义是 append，不合并）。
   * @param request 请求。
   */
  extract(request: ExtractRequest): Promise<ExtractResult>
  /** 统计快照。 */
  stats(): ExtractStats
}

/** 累计统计（**只在内存**）。 */
export interface ExtractStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ExtractUnavailableReason
  /** 调用次数。 */
  readonly calls: number
  /** 成功次数（拿到了模型输出）。 */
  readonly succeeded: number
  /** 失败次数。 */
  readonly failed: number
  /** 累计写入事实数。 */
  readonly factsWritten: number
  /** 累计拒绝数（按原因分桶）。 */
  readonly rejected: Readonly<Record<string, number>>
  /** 最近一次失败原因。 */
  readonly lastError?: string
}

/** 不可用原因。 */
export type ExtractUnavailableReason =
  /** 配置里关掉了。 */
  | 'disabled'
  /** 网关插件没装。 */
  | 'no-gateway'
  /** 网关装了但上游模型不可用。 */
  | 'gateway-unavailable'
  /** 记忆内核没装。 */
  | 'no-core'
  /** 记忆内核装了但不可用。 */
  | 'core-unavailable'

/** 错误码。 */
export type ExtractErrorCode = 'bad-request' | 'unavailable' | 'aborted' | 'parse-failed' | 'upstream'

/** 提炼错误。 */
export class ExtractError extends Error {
  /** 错误码。 */
  readonly code: ExtractErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: ExtractErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'ExtractError'
    this.code = code
    this.detail = detail
  }
}

/* ------------------------------------------------------------------ *
 * 消费方的结构对位（不 import 源码）
 * ------------------------------------------------------------------ */

/**
 * O-010 `addFact()` 的入参形状（结构对位子集）。
 *
 * 只镜像本插件真正会填的字段。`salience` 传 `salienceHint` 时要注意：
 * 一旦传了，O-010 就**不再按打分表算分**——所以本插件默认不传，
 * 把「这条值几分」完整交给 O-010，避免同一句话两个分数。
 */
export interface FactWriteLike {
  readonly kind: string
  readonly category: string
  readonly text: string
  readonly summary?: string
  readonly subject?: string
  readonly salience?: number
  readonly arousal?: number
  readonly evidence?: readonly { readonly source: string; readonly quote: string; readonly messageIndex?: number }[]
  readonly rawId?: string
  readonly at?: number
}

/** O-010 `addFact()` 的返回形状（只用到 id）。 */
export interface FactWrittenLike {
  readonly id: string
}

/** O-010 记忆内核的结构对位子集。 */
export interface MemoryCoreLike {
  readonly available: boolean
  addFact(input: FactWriteLike): FactWrittenLike
  tombstoned(text: string): boolean
}

/** O-035 网关返回的结构对位子集。 */
export interface GatewayCompletionLike {
  readonly text: string
  readonly sourceId: string
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number }
}

/** O-035 网关请求的结构对位子集。 */
export interface GatewayRequestLike {
  readonly messages: readonly object[]
  readonly system?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly purpose?: string
  readonly signal?: AbortSignal
}

/** O-035 网关的结构对位子集。 */
export interface LlmGatewayLike {
  readonly available: boolean
  complete(request: GatewayRequestLike): Promise<GatewayCompletionLike>
}

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
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
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
