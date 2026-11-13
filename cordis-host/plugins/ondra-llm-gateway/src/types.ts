/**
 * O-035 `ondra-llm-gateway` 的对外契约（〔薄〕薄封装）。
 *
 * 定位：**全仓唯一的「模型从哪来」**。上游 `ctx.llm`（`@ntars/ondra-llm`）
 * 已经把「适配器注册表 + 流式调用 + 重试策略 + 模型解析」这套机制跑通了，
 * 但它是**面向会话**的：调用方必须自己写 `provider` / `model`，自己拿超时，
 * 自己判断「这条来源现在到底能不能用」。于是每个域插件都会各自抄一遍这三件事，
 * 而抄出来的版本必然不一致——这正是手册 §1.10 需求五（不想被供应商锁定）
 * 落地时最容易崩的地方。
 *
 * 所以本插件只做四件上游没做的事：
 *
 * 1. **三来源清单**（在线 API / 本地 / 免费）与优先级选路；
 * 2. **首块超时与块间隔超时**（流式场景下「总时长」不可预测，卡总时长会砍掉正常长回复）；
 * 3. **首块前的重试与跨来源降级**（首块之后一律不重试，见下）；
 * 4. **用量记账**（只记账，不判价；价格归 `token-meter` 与界面）。
 *
 * **不做的事（每一条都是刻意的）**：
 * - **不写 provider 适配器**：SSE 解码、重放状态、模型目录全是上游 `llm-*` 适配器的活。
 *   在这里再实现一遍等于把「协议编解码」自研一次，违反 §1.8。
 * - **不注入密钥**：见 `SourceSpec.credentialRef` 的说明。
 * - **不拼提示词**：`messages` 原样透传，一个字都不改——否则前缀缓存命中率归零（§8.5）。
 * - **不缓存响应**：多方案分支纪律要求「分支之间不共享缓存」（§14.2），而网关是所有分支的
 *   共同上游，它一旦缓存，就等于让所有来源共享一份可变状态。
 */

/** 本插件注册的服务键（连字符，非 `ondra:llm-gateway`）。全仓唯一归属。 */
export const LLM_GATEWAY_SERVICE_KEY = 'ondra-llm-gateway'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 来源 id 也是「会被模型与界面看见的键」，所以同样受这条约束——
 * 事故教训是「工具名/参数名不合规，模型侧直接拒绝」。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 凭据引用名的形状：POSIX 环境变量名。
 *
 * 与上游 `ctx.credentials` 的 `REF_PATTERN` 一致（`^[A-Za-z_][A-Za-z0-9_]*$`）。
 * 刻意用「引用名」而不是「值」：配置里只出现名字，值由凭据域持有。
 */
export const CREDENTIAL_REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 三种模型来源（手册 §1.10 需求五 + 宣传片 03 章逐字承诺）。
 *
 * 三种来源在**协议层没有区别**，区别只在默认参数与语义：
 * - `remote`：在线 API，要密钥，超时短；
 * - `local`：本地大模型，通常不要密钥，首块慢（模型要加载）；
 * - `free`：免费模型，要密钥但额度紧张，重试次数要少。
 *
 * 因此三者**共用同一份实现**，差异全部参数化在 `SourceSpec` 里（§12.1「能融就融」）。
 */
export type SourceKind = 'remote' | 'local' | 'free'

/** 三种来源的固定顺序（界面按此渲染，不许各插件自己排）。 */
export const SOURCE_KINDS: readonly SourceKind[] = Object.freeze([
  'remote',
  'local',
  'free',
] as const)

/**
 * 网关自己产生的失败码。
 *
 * 刻意与上游的失败码**分两层**：上游码（`AUTH` / `RATE_LIMIT` / `SERVER` …）
 * 描述「provider 那边怎么了」，本插件的码描述「网关这边怎么没走通」。
 * 混成一层会让「密钥没配」和「密钥被拒」长得一模一样。
 */
export type GatewayFailureCode =
  /** 上游 `ctx.llm` 缺席：本插件装了但使不上劲。 */
  | 'gateway-unavailable'
  /** 一条来源都没有（清单为空，或全部被禁用）。 */
  | 'no-source'
  /** 显式指定的来源 id 不在清单里。 */
  | 'source-unknown'
  /** 来源声明的 `provider` 路由未在上游注册（适配器没装）。 */
  | 'provider-missing'
  /** 凭据引用解析不到（环境变量没设 / 凭据文件没有）。 */
  | 'credential-missing'
  /** 首块超时：连第一个 token 都没等到。 */
  | 'first-chunk-timeout'
  /** 块间隔超时：已经开始吐字，但中途卡住。 */
  | 'idle-timeout'
  /** 调用方主动取消。 */
  | 'aborted'
  /** 上游抛错（不可重试类，或重试已耗尽）。 */
  | 'upstream-error'
  /** 请求本身不合法（没有消息、字段类型错）。 */
  | 'bad-request'

/**
 * 一条来源的声明。**这是配置里的形状**，也是注册表的唯一真源。
 *
 * 全部字段都有默认值（`completeSource()` 补），因为「默认给好，全部可调」
 * 是 §3.3-2 的硬约束；但 `provider` / `model` 没有合理默认——
 * 它们是用户自己那条链路的身份，编一个出来就是假开关。
 */
export interface SourceSpec {
  /** 来源 id，匹配 `NAME_RE`；全清单唯一。 */
  readonly id: string
  /** 来源种类；只影响默认参数与展示，不影响协议。 */
  readonly kind: SourceKind
  /**
   * 上游 `ctx.llm` 的 provider 路由键。
   *
   * **不能编**：路由键由具体适配器声明（`llm-deepseek` 的 route、
   * `llm-pi-ai` 的 `providers.*`），写死任何一个都会在别人机器上变成
   * `provider-missing`。所以默认清单是空的，由用户按自己装了什么来填。
   */
  readonly provider: string
  /** 模型 id，透传给上游 `GenerateOptions.model`。 */
  readonly model: string
  /** 优先级，**越小越先试**。同值按清单里的书写顺序。 */
  readonly priority: number
  /**
   * 该来源所需的凭据**引用名**（环境变量名），不是密钥值。
   *
   * 网关只拿它做**存在性预检**：解析不到就跳过这条来源，省掉一次注定失败的
   * 请求与一条让人摸不着头脑的 `AUTH` 报错。**值永不出网关**——
   * 真正的读取发生在适配器侧（同一引用名、per-operation 解析），
   * 所以网关于是把密钥复制了一份，而是根本不碰它。
   */
  readonly credentialRef?: string
  /** 首块超时毫秒；省略则用全局值。 */
  readonly timeoutMs?: number
  /** 块间隔超时毫秒；省略则用全局值。 */
  readonly idleTimeoutMs?: number
  /** 本条来源的最大尝试次数（含首次）；省略则用全局值。 */
  readonly maxAttempts?: number
  /** 是否启用。默认 `true`。关掉的来源不出现在选路里，但仍可被显式指定。 */
  readonly enabled: boolean
}

/** 一条来源声明里的问题。**逐条丢弃，不整体失败**（与 O-005 同口径）。 */
export interface SourceIssue {
  /** 出问题的来源 id；连 id 都没有时不带。 */
  readonly id?: string
  /** 问题码。 */
  readonly code:
    | 'not-array'
    | 'not-object'
    | 'bad-id'
    | 'duplicate-id'
    | 'bad-kind'
    | 'bad-provider'
    | 'bad-model'
    | 'bad-priority'
    | 'bad-credential-ref'
    | 'bad-timeout'
    | 'bad-attempts'
  /** 一句中文，可直接给设置页显示。 */
  readonly message: string
}

/** 一条来源此刻的可用性。**这是「可观测」那一栏**（§12.2）。 */
export interface SourceState {
  /** 补全后的声明。 */
  readonly spec: SourceSpec
  /** 现在能不能用。 */
  readonly available: boolean
  /** 不能用的原因码；能用时不带。 */
  readonly reason?: GatewayFailureCode
  /** 一句中文说明（给界面与自检用）。 */
  readonly detail?: string
}

/**
 * 一次模型调用的用量。
 *
 * 字段语义照抄上游 `TokenUsage`：**计数是不相交的**——`inputTokens` 只含未命中缓存的输入，
 * 命中部分单独记在 `cacheReadTokens`，计费输入 = 三者之和。抄错这一条会让成本报表
 * 少算掉缓存那部分（或者多算），而且从账单上根本看不出是统计错。
 */
export interface GatewayUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

/** 结束原因的结构对位（上游 `FinishReason` 的 `kind` 判别联合）。 */
export interface FinishFailureLike {
  readonly message: string
  readonly code: string
  readonly status?: number
}

/** 结束原因。`kind` 用 `string` 而不是字面量联合，是为了上游将来加值时不炸。 */
export interface FinishLike {
  readonly kind: string
  readonly failure?: FinishFailureLike
}

/**
 * 流式块的结构对位（上游 `StreamChunk`）。
 *
 * 刻意**结构对位**而不是 `import type`：插件之间不许互相 import（§15.5），
 * 对上游也一样——上游换代时形状一变，赋值处立刻报错，而不是悄悄错。
 * 协议约定见上游 `packages/llm/llm/src/types.ts` 的 `StreamChunk` 注释。
 */
export type GatewayChunk =
  | { readonly type: 'block-start'; readonly index: number; readonly blockType: string }
  | { readonly type: 'text-delta'; readonly index: number; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly text: string }
  | {
    readonly type: 'tool-call-delta'
    readonly index: number
    readonly id: string
    readonly name?: string
    readonly argumentsDelta: string
  }
  | { readonly type: 'block-end'; readonly index: number; readonly block: unknown }
  | { readonly type: 'usage'; readonly usage: GatewayUsage }
  | { readonly type: 'finish'; readonly reason: FinishLike; readonly replayState?: unknown }

/**
 * 消息序列的类型：**不透明**。
 *
 * 网关不读、不改、不重排消息，所以这里刻意不给它字段——
 * 一旦给了，就一定会有人在这里「顺手补一句系统提示」，
 * 而那就是前缀缓存归零的起点（§8.5）。
 */
export type GatewayMessages = readonly object[]

/** 传给上游的调用参数。只列本插件真正设置的字段。 */
export interface GatewayCallOptions {
  readonly provider: string
  readonly model: string
  readonly messages: GatewayMessages
  readonly system?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  readonly tools?: readonly object[]
  readonly reasoningEffort?: string
  readonly purpose?: string
  readonly signal?: AbortSignal
}

/** 一次请求。 */
export interface GatewayRequest {
  /** 消息序列，原样透传。 */
  readonly messages: GatewayMessages
  /** 一次性调用用的系统提示（会话内调用应留空，走消息里的 system 条）。 */
  readonly system?: string
  /** 采样温度。 */
  readonly temperature?: number
  /** 输出上限。 */
  readonly maxTokens?: number
  /** 停止串。 */
  readonly stop?: readonly string[]
  /** 工具 schema，原样透传。 */
  readonly tools?: readonly object[]
  /** 推理档位（适配器自有取值）。 */
  readonly reasoningEffort?: string
  /** 辅助调用用途（上游只认 `compaction` / `session-title`，其它值上游会自行忽略）。 */
  readonly purpose?: string
  /** 调用方取消信号。 */
  readonly signal?: AbortSignal
  /** 显式指定来源 id；省略则按优先级选路。 */
  readonly source?: string
  /** 覆盖首块超时。 */
  readonly timeoutMs?: number
  /** 覆盖块间隔超时。 */
  readonly idleTimeoutMs?: number
  /** 覆盖最大尝试次数（含首次）。 */
  readonly maxAttempts?: number
  /** 是否允许跨来源降级。默认 `true`；显式指定来源时恒为 `false`。 */
  readonly allowFallback?: boolean
}

/** 一次非流式调用的结果。 */
export interface GatewayCompletion {
  /** 拼起来的可见正文。 */
  readonly text: string
  /** 拼起来的推理内容（适配器不产出时为空串）。 */
  readonly reasoning: string
  /** 用量；上游没给时省略。 */
  readonly usage?: GatewayUsage
  /** 实际服务的来源 id。 */
  readonly sourceId: string
  /** 一共尝试了几次（跨来源累加）。 */
  readonly attempts: number
  /** 结束原因 `kind`（`stop` / `max-tokens` / `tool-calls` / `error` / `aborted`）。 */
  readonly finishKind: string
}

/** 单条来源的累计统计。 */
export interface SourceStat {
  readonly id: string
  readonly attempts: number
  readonly failures: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheRead: number
  readonly lastFailureCode?: string
  readonly lastLatencyMs?: number
}

/** 网关的累计统计。**只在内存**，不落盘（网关无状态，见 README 隔离五问 2）。 */
export interface GatewayStats {
  /** 上游 `ctx.llm` 是否在位。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GatewayFailureCode
  /** 全部来源的当前状态。 */
  readonly sources: readonly SourceState[]
  /** 累计尝试次数。 */
  readonly attempts: number
  /** 累计失败次数。 */
  readonly failures: number
  /** 累计跨来源降级次数。 */
  readonly fallbacks: number
  /** 因凭据缺失被跳过的来源次数。 */
  readonly credentialSkips: number
  /** 最近一次成功的来源 id。 */
  readonly lastSourceId?: string
  /** 最近一次的失败码（网关层）。 */
  readonly lastFailureCode?: GatewayFailureCode
  /** 逐来源统计。 */
  readonly perSource: readonly SourceStat[]
}

/** 对外服务。 */
export interface LlmGatewayService {
  /** 上游 `ctx.llm` 是否在位。 */
  readonly available: boolean
  /** 不可用原因；可用时不带。 */
  readonly reason?: GatewayFailureCode
  /** 全部来源的当前状态（只读快照，已按优先级排序）。 */
  readonly sources: readonly SourceState[]
  /**
   * 按请求挑一条来源（同步、纯函数，不发网络、不读凭据）。
   * @param request 只用到 `source` 与 `allowFallback` 两个字段。
   * @returns 选中的来源；没有可用来源时 `undefined`（**不抛错**）。
   */
  resolve(request?: Pick<GatewayRequest, 'source' | 'allowFallback'>): SourceState | undefined
  /**
   * 流式调用。
   *
   * 失败一律**抛 `GatewayError`**，不靠 `finish` 帧传达：`finish` 是上游协议的
   * 一部分，网关不往里面塞自己的语义。上游在流内报的 `finish{kind:'error'}` 原样转发。
   * @param request 请求。
   * @param trace 可选的回填对象，用来告诉调用方「最后是谁服务的、试了几次」。
   */
  stream(request: GatewayRequest, trace?: GatewayTrace): AsyncIterable<GatewayChunk>
  /**
   * 非流式调用：把正文拼起来一次给。
   *
   * 给「提炼记忆」「做梦」这类不需要逐字上屏的调用方用；内部仍走 `stream()`，
   * 所以超时、重试、降级、记账四条行为与流式完全一致。
   * @param request 请求。
   */
  complete(request: GatewayRequest): Promise<GatewayCompletion>
  /** 重新探测来源可用性（只读上游注册表，不发网络），返回最新状态。 */
  probe(): readonly SourceState[]
  /** 累计统计快照。 */
  stats(): GatewayStats
}

/** `stream()` 的回填对象：调用方传进来，网关往里写。 */
export interface GatewayTrace {
  /** 实际服务的来源 id。 */
  sourceId?: string
  /** 一共尝试了几次。 */
  attempts?: number
  /** 结束原因 `kind`。 */
  finishKind?: string
}

/**
 * 网关错误。
 *
 * 两个字段是给调用方分支用的，缺一个就会出现「重试了不该重试的」：
 * - `partial`：**已经下发过块**。为真时网关绝不会自己重试，调用方也不该重放——
 *   重放会让用户看到两遍开头（流式场景下这是最难查的重复文本来源）。
 * - `upstreamCode`：上游的机器码（`AUTH` / `RATE_LIMIT` …），用于区分
 *   「密钥错了」与「服务端 500」。
 */
export class GatewayError extends Error {
  /** 网关层失败码。 */
  readonly code: GatewayFailureCode
  /** 已下发过块。 */
  partial: boolean
  /** 上游机器码。 */
  readonly upstreamCode?: string
  /** 失败来源 id。 */
  readonly sourceId?: string
  /** 已尝试次数。 */
  attempts: number

  constructor(
    code: GatewayFailureCode,
    message: string,
    options?: {
      readonly partial?: boolean
      readonly upstreamCode?: string
      readonly sourceId?: string
      readonly attempts?: number
    },
  ) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.partial = options?.partial ?? false
    this.upstreamCode = options?.upstreamCode
    this.sourceId = options?.sourceId
    this.attempts = options?.attempts ?? 0
  }
}

/* ------------------------------------------------------------------ *
 * 以下是「外部形状」的结构对位：只声明本插件用到的那几个成员。
 * 一旦上游改了签名，这里的赋值处会立刻报错——这就是不要 import 的理由。
 * ------------------------------------------------------------------ */

/** 上游 provider 路由信息（`LlmProviderInfo` 的子集）。 */
export interface LlmProviderInfoLike {
  readonly id: string
  readonly name: string
}

/**
 * 上游 LLM 服务（`LlmRuntime`）的子集。
 *
 * `stream` 的参数刻意写 `unknown`：完整形状是上游 600 行的 `GenerateOptions`，
 * 抄一遍必然漂移；本插件只负责**填对其中几个字段**，填错由上游在运行期拒绝。
 */
export interface LlmRuntimeLike {
  /** 当前已注册的 provider 路由。 */
  listProviders(): readonly LlmProviderInfoLike[]
  /** 发起一次流式调用。 */
  stream(options: unknown): AsyncIterable<GatewayChunk>
}

/** 上游凭据服务（`CredentialProvider`）的子集。 */
export interface CredentialLike {
  /** 按引用名解析，per-operation 调用，**不许缓存**。 */
  resolve(ref: string): Promise<{ readonly value: string; readonly source: string } | undefined>
}

/** O-005 字段声明的结构对位（`FieldSpec` 的子集）。 */
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
  /** 数字读数的量纲（天 / 分钟 / 毫秒 / 字 / 轮）。空表示无量纲。 */
  readonly unit?: string
}

/** O-005 段声明的结构对位（`SectionDecl` 的子集）。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 解析结果的结构对位（`ResolvedSection` 的子集）。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 配置真源服务的结构对位（`ConfigSchemaService` 的子集）。 */
export interface ConfigSchemaLike {
  register(decl: SectionDeclLike, by?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}

/** O-001 身份服务的结构对位（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** 日志门面的最小形状。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}
