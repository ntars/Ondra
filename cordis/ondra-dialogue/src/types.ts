/**
 * O-033 `ondra-dialogue` 的对外契约（〔研〕自研）。
 *
 * ## 本插件解决的唯一问题：前缀缓存
 *
 * 手册 §8.5 的实测数字是硬的：5 个会话 2001 次请求，缓存命中 99.3–99.6%，
 * 成本 ¥879.97 → ¥19.96。而**把命中率打到 0 只需要改一行**：每轮重拼 system prompt。
 *
 * 所以本插件的全部设计围绕一条纪律：
 *
 * > 会话内**冻结前缀**（人格 + 世界书常驻），易变段（日期 / 情绪）追加到**尾部**，
 * > 只追加增量，压缩只发生在**用户回合边界**。
 *
 * 具体落到三个不可让步的实现约束：
 *
 * 1. **稳定段只在 `begin()` 里拼一次**，之后没有任何接口能改它。想换人格？
 *    开新会话。这不是限制，这是「冻结」的定义——能改就不是冻结。
 * 2. **每轮只在数组尾部追加**：先追加 `user`，流结束后追加 `assistant`。
 *    前面的字节一个都不动，缓存才可能命中。
 * 3. **`compact()` 只在两轮之间可用**（`busy` 时返回 `busy`）。在一轮进行中
 *    裁剪历史，会让「已经发出去的前缀」和「下一轮要发的前缀」不是同一个东西。
 *
 * ## 明确不做（每一条都是刻意的边界）
 *
 * - **不建 Session、不写 `app_session_log`**（master-plan §6 禁令 5 / 决策 13）。
 *   一旦建会话，隐私收益归零——这是产品红线，不是实现选择。
 * - **不改写正文**。九步过滤链归 O-037；流式两闸（草稿剥离 / AI 自曝）
 *   也归它。本插件连 `text-replace` 帧都不发，理由见 `README` 的「不做」。
 * - **不做注入装箱**。装什么、装多少、装不下写「另有 N 条」归 O-036。
 *   本插件只决定「稳定段放头、易变段放尾」。
 * - **不取情绪投影**。易变段由调用方传进来：谁最清楚这一轮要说什么，
 *   谁负责准备。本插件不做每轮一次的情绪读取（那是「在组装提示词里做 IO」，
 *   手册 §8.2 反模式第 2 条）。
 */

/** 本插件注册的服务键（连字符，非 `ondra:dialogue`）。全仓唯一归属。 */
export const DIALOGUE_SERVICE_KEY = 'ondra-dialogue'

/** 命名硬约束正则（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 一条消息的角色。
 *
 * 只有三种：本产品没有 `tool` 角色（一轮对话不落工具态），也没有 `developer`。
 * 加一个角色意味着上游适配器要认识它，而三来源适配器各有一份角色映射。
 */
export type DialogueRole = 'system' | 'user' | 'assistant'

/** 一条消息。**只含字符串正文**：多媒体走消息附件，不在这一层。 */
export interface DialogueMessage {
  readonly role: DialogueRole
  readonly content: string
}

/**
 * 一段**稳定段**：会话开头拼进去之后就不再变的内容。
 *
 * `id` 是给人看的（界面能说出「这段是人格」），不参与哈希；
 * 参与哈希的是 `text`。改 `id` 不会让前缀失效，改 `text` 会——
 * 这正是我们要的语义。
 */
export interface StablePart {
  /** 段 id，匹配 `NAME_RE`（`persona` / `worldbook` / `custom-notes`）。 */
  readonly id: string
  /** 段正文。空串会被跳过（不占位、不加空行）。 */
  readonly text: string
  /** 来源，只用于展示与统计。 */
  readonly source: 'persona' | 'worldbook' | 'custom'
}

/**
 * 一段**易变段**：每轮都可能变，只能追加在尾部。
 *
 * 字段与器官 ABI 的提示词片段逐字对位（`order / ttlMinutes / confidence`，手册 §8.1）。
 * 对位而不是「差不多」：O-036 将来把各器官申报的片段直接传进来，
 * 中间不做字段改名——改一次名字就要在两边各写一份转换。
 */
export interface TailPart {
  /** 段 id，匹配 `NAME_RE`。 */
  readonly id: string
  /** 段正文。空串会被跳过。 */
  readonly text: string
  /** 排序键，**越小越靠前**。稳定段恒在最前，`order` 只在易变段之间排序。 */
  readonly order: number
  /** 存活时长（分钟）。**本插件不使用它**，原样透传给调用方做解释（见 README）。 */
  readonly ttlMinutes?: number
  /** 置信度 0–1。低于配置门槛的段会被丢弃（默认门槛 0）。 */
  readonly confidence?: number
}

/** `begin()` 的入参。 */
export interface BeginInput {
  /** 会话 id，匹配 `NAME_RE`；省略则自动生成。 */
  readonly id?: string
  /** 稳定段。省略则从 O-023 / O-024 自动收集（见 `includePersona` / `includeWorldbook`）。 */
  readonly stable?: readonly StablePart[]
  /** 历史原文（最近几条），会整段追加在 system 之后。 */
  readonly history?: readonly DialogueMessage[]
}

/** `begin()` 的返回值：一份**冻结快照**。 */
export interface ConversationView {
  /** 会话 id。 */
  readonly id: string
  /** 冻结前缀的指纹（djb2，8 位十六进制）。 */
  readonly prefixHash: string
  /** 冻结前缀的字符数。 */
  readonly prefixChars: number
  /** 拼进前缀的段（按拼装顺序）。 */
  readonly parts: readonly StablePart[]
  /** 历史条数（user + assistant 合计）。 */
  readonly historyCount: number
  /** 创建时刻。 */
  readonly createdAt: number
}

/** `prefixOf()` 的返回值。 */
export interface PrefixSnapshot {
  /** 与 `ConversationView.prefixHash` 同一个算法、同一个值。 */
  readonly hash: string
  /** 前缀全文（就是那条 system 消息的 `content`）。 */
  readonly text: string
  /** 字符数。 */
  readonly chars: number
  /** 拼进来的段。 */
  readonly parts: readonly StablePart[]
  /** 冻结时刻。 */
  readonly frozenAt: number
}

/** `turn()` 的入参。 */
export interface TurnInput {
  /** 本轮用户输入。空串合法（用户只发了一张图），但仍会作为一条 user 消息追加。 */
  readonly text: string
  /** 会话 id；省略用最近一个会话，没有则自动 `begin()` 一个。 */
  readonly conversationId?: string
  /** 本轮易变段。省略则尾部只有本轮用户输入。 */
  readonly tail?: readonly TailPart[]
  /** 取消信号。触发后本轮以 `aborted` 结束，**并整轮不写入历史**。 */
  readonly signal?: AbortSignal
  /** 覆盖温度；省略用配置值。 */
  readonly temperature?: number
  /** 覆盖输出上限；省略用配置值（0 表示不设）。 */
  readonly maxTokens?: number
  /** 显式指定模型来源 id（透传 O-035）；省略按网关优先级选路。 */
  readonly source?: string
}

/**
 * 结束原因，**四值闭集**，与 O-034 逐字一致。
 *
 * 本地再声明一次而不 import（§15.5 禁止跨包 import），代价是改一处要同改两处。
 * 这个代价是已知的、可接受的：两个文件都在 `cordis/` 下，改了帧格式的人
 * 一定会同时看到这两处 `README` 的对照表。
 */
export type DialogueStopReason = 'stop' | 'aborted' | 'error' | 'length'

/** 危机标签，与 O-034 逐字一致。 */
export type DialogueCrisisLabel = 'crisis' | 'privacy' | 'isolate'

/**
 * 五帧的判别联合，**与 O-034 的 `DialogueFrame` 逐字一致**（结构对位）。
 *
 * 本插件是帧的**生产者**（对话链产出帧），O-034 是**规范的持有者**
 * （形状、跨帧纪律、编解码）。生产者镜像形状而不 import，是为了让
 * 任一插件单独卸载都不会让另一个编译失败（§15.5）。
 */
export type DialogueFrame =
  | { readonly type: 'text-delta'; readonly seq: number; readonly delta: string }
  | { readonly type: 'text-replace'; readonly seq: number; readonly text: string }
  | { readonly type: 'crisis'; readonly seq: number; readonly kindLabel: DialogueCrisisLabel }
  | { readonly type: 'usage'; readonly seq: number; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'done'; readonly seq: number; readonly stopReason: DialogueStopReason }

/** 压缩的触发来源。 */
export type CompactReason = 'manual' | 'auto'

/** 压缩失败原因。 */
export type CompactFailure =
  /** 会话不存在。 */
  | 'not-found'
  /** 一轮正在跑。压缩只能在用户回合边界发生。 */
  | 'busy'

/** 压缩结果。 */
export interface CompactResult {
  readonly ok: boolean
  /** 失败原因；成功时不带。 */
  readonly reason?: CompactFailure
  /** 丢掉的条数（恒为偶数，见 `compact.ts`）。 */
  readonly dropped: number
  /** 保留下来的条数。 */
  readonly kept: number
  /** 压缩后的历史字符数。 */
  readonly chars: number
}

/** 累计统计。**只在内存**，不落盘。 */
export interface DialogueStats {
  /** 本插件是否启用（只看配置开关，不看网关——见 README 的「降级 vs 不可用」）。 */
  readonly available: boolean
  /** 网关此刻是否在位（每次现取，能自愈）。 */
  readonly gatewayReady: boolean
  /** 当前持有的会话数。 */
  readonly conversations: number
  /** 累计完成的回合数（含失败）。 */
  readonly turns: number
  /** 累计产出的帧数。 */
  readonly frames: number
  /** 累计以 `error` 结束的回合数。 */
  readonly errors: number
  /** 累计被取消的回合数。 */
  readonly aborted: number
  /** 累计**整轮作废**的回合数（`aborted` / `error`，历史未提交）。 */
  readonly discarded: number
  /** 累计压缩次数。 */
  readonly compactions: number
  /** 当前默认会话的冻结前缀字符数；无会话时为 0。 */
  readonly prefixChars: number
  /** 最近一次错误（一句中文，**不含用户原文**）。 */
  readonly lastError?: string
}

/** 对外服务。 */
export interface DialogueService {
  /** 是否启用（配置开关）。 */
  readonly available: boolean
  /** 网关此刻是否在位。 */
  readonly gatewayReady: boolean
  /**
   * 开一个新会话并**冻结前缀**。
   *
   * 同一 id 已存在时**不覆盖**，原样返回已有快照（覆盖等于偷偷重拼前缀，
   * 那正是本插件要防的事）。
   */
  begin(input?: BeginInput): ConversationView
  /**
   * 跑一轮。
   *
   * **永不抛出**：任何失败都以 `done{stopReason:'error'}` 收尾，原因进 `stats().lastError`。
   * 理由：调用方（通道 / 界面）已经在处理一个异步流，再让它同时处理异常，
   * 必然有一边漏——而漏掉的那边表现为「用户发了消息，她永远不回」。
   */
  turn(input: TurnInput): AsyncIterable<DialogueFrame>
  /** 取消当前回合。没有进行中的回合时返回 `false`。 */
  abort(conversationId?: string): boolean
  /** 关掉一个会话并释放内存。 */
  close(conversationId?: string): boolean
  /** 读冻结前缀快照。 */
  prefixOf(conversationId?: string): PrefixSnapshot | undefined
  /** 读历史副本（**只读快照**，改它不影响会话）。 */
  historyOf(conversationId?: string): readonly DialogueMessage[]
  /** 在回合边界裁剪历史。 */
  compact(conversationId?: string, reason?: CompactReason): CompactResult
  /** 累计统计快照。 */
  stats(): DialogueStats
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * ------------------------------------------------------------------ */

/**
 * 上游流式块的结构对位。
 *
 * 刻意写成**一个宽接口**而不是判别联合：上游的 `StreamChunk` 有七种成员，
 * 这里只用三种。写成联合就必须把七种全抄一遍，而且抄的那六种一旦上游改字段，
 * 本插件会在一个跟自己无关的地方编译报错。
 *
 * 代价是失去类型收窄，所以取值处必须 `typeof chunk.text === 'string'` 显式判定——
 * 这个代价换来的是「上游加一种块类型，本插件不用改」。
 */
export interface GatewayChunkLike {
  readonly type: string
  readonly text?: string
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
  }
  readonly reason?: { readonly kind: string }
}

/** O-035 请求的结构对位。 */
export interface GatewayRequestLike {
  readonly messages: readonly object[]
  readonly system?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly source?: string
  readonly signal?: AbortSignal
}

/** O-035 回填对象的结构对位。 */
export interface GatewayTraceLike {
  sourceId?: string
  attempts?: number
  finishKind?: string
}

/** O-035 服务的结构对位。 */
export interface GatewayLike {
  readonly available: boolean
  stream(request: GatewayRequestLike, trace?: GatewayTraceLike): AsyncIterable<GatewayChunkLike>
}

/** O-023 人格装配的结构对位（只取 `assemble().text`）。 */
export interface AssembleLike {
  assemble(input?: { readonly budgetChars?: number }): { readonly text: string; readonly chars: number }
}

/** O-024 世界书的结构对位（只取常驻块）。 */
export interface WorldbookLike {
  constantBlock(): { readonly text: string; readonly chars: number; readonly ids: readonly string[] }
}

/** O-005 字段声明的结构对位。 */
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

/** O-005 段声明的结构对位。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 解析结果的结构对位。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 配置真源服务的结构对位。 */
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
