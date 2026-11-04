/**
 * O-132 `ondra-organ-host` 的对外契约：**器官 ABI**（手册 §8.1，插件体系的宪法）。
 *
 * ## 这个包存在的理由
 *
 * 手册把「工具」与「器官」的差别定在**责任**上：谁付钱、谁能改状态、谁能进提示词、
 * 坏了会怎样、谁能装。四条责任各对应一条约束，缺一条，ABI 就只剩命名：
 *
 * - **C1** 器官永不直接写状态，只能 `feedback()` 提议，宿主统一 apply；
 * - **C2** 器官必须为自己的感知付能量，且允许被拒绝（`denied=true` 立刻放弃）；
 * - **C3** 器官错误不得传播（外层 try/catch，异常转 `degraded` 返回空）。
 *
 * ## 三条必须写在前面的判定
 *
 * 1. **`ctx` 是门面，不是裸 ctx。** 裸 ctx 能 `on('llm/stream')`、能全量 `tools.register`、
 *    能 `ctx.get` 别人的服务——那样 ABI 形同虚设。所以本包只交出十个方法
 *    （`state / consume / emit / proposeGap / onToolResult / onTick / registerTool /
 *    onPrompt / kv / log`），一个不多。
 * 2. **能力白名单 default-deny。** 没声明就调，抛 `CapabilityDeniedError`，
 *    **不是静默忽略**——静默忽略会让器官作者以为「这次没生效」，而不是「我没资格」。
 * 3. **`consume()` 不在白名单里。** 付能量是义务不是权限：能选「不付」的付费机制
 *    等于没有。所以 `consume` 永远可用，而 `state()` 反过来要求先拿到有效回执。
 *
 * ## 数值口径（三处都不许换算）
 *
 * - 能量报价与回执是 **0–100**（与 §3.3 / O-048 的能量同尺度）。
 * - 置信度是 **0–1**。
 * - 提示词 `order` 是**整数排序键**，越小越靠前；`SCAR_ORDER` 恒 `-1e4`，
 *   器官下限 `MIN_ORGAN_ORDER`（-1000）。**疤痕那一段是保留区，器官进不去。**
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const ORGAN_SERVICE_KEY = 'ondra-organ-host'

/** 服务键 / 工具名 / 配置键的唯一合法形状（手册 §8.4）。 */
export const KEY_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 疤痕片段的固定排序键：`-1e4`（手册 §8.1 逐字）。
 *
 * 为什么不用「-1000 再加一个布尔」：排序键本身要能表达「这一段必须在最前」，
 * 而任何器官都能申报 -1000。差一个数量级，是为了让「谁在前」不需要额外规则。
 */
export const SCAR_ORDER = -1e4

/** 器官可申报的最小 `order`。低于它 = 想挤进疤痕保留区，**拒收**而不是夹紧。 */
export const MIN_ORGAN_ORDER = -1000

/** 器官可申报的最大 `order`。超过它 = 排序键失去意义（尾部无限长），拒收。 */
export const MAX_ORDER = 10_000

/** 撤销函数。全部注册类方法都返回它（§3.3-4 可逆注册）。 */
export type Disposer = () => void

/**
 * 能力白名单（default-deny）。
 *
 * 刻意**不含** `energy.consume`：见文件头第 3 条。
 */
export const CAPABILITIES = Object.freeze([
  /** 读世界状态（`state()`）。 */
  'state.read',
  /** 向宿主发信号（`emit()`）。 */
  'emit',
  /** 提一条缺口（`proposeGap()`）。 */
  'gap.propose',
  /** 收工具结果（`onToolResult()`）。 */
  'tool.result',
  /** 收心跳（`onTick()`）。 */
  'tick',
  /** 注册工具（`registerTool()`）。 */
  'tool.register',
  /** 申报提示词片段（`onPrompt()`）。 */
  'prompt.fragment',
  /** 用自己的键值空间（`kv`）。 */
  'kv',
  /** 写自己的日志命名空间（`log`）。 */
  'log',
] as const)

/** 一个能力名。 */
export type Capability = (typeof CAPABILITIES)[number]

/** 查表版：`includes` 在 `readonly Capability[]` 上不接受任意字符串，故用 Set。 */
export const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(CAPABILITIES)

/** 计费模式（手册 §8.2 能量会计迁移期双模式）。 */
export type ChargeMode =
  /** 只记账不真扣，数字仍进遥测。**默认**。 */
  | 'shadow'
  /** 真扣。 */
  | 'additive'

/** 回执状态机（手册 §8.1 C2 逐字四态）。 */
export type EnergyState = 'full' | 'partial' | 'starved' | 'shadow'

/** 回执为什么是这个状态。只进日志与遥测，不进提示词。 */
export type EnergyReason =
  /** `chargeMode='shadow'`：只记账。 */
  | 'shadow-mode'
  /** 没有能量源（O-048 缺席）：不假装饥饿，也不假装付过。 */
  | 'no-source'
  /** 剩余为 0，一点都付不出。 */
  | 'insufficient'
  /** 付了一部分。 */
  | 'partial'
  /** 本次感知报价为 0（免票）。 */
  | 'free'
  /** 照单付清。 */
  | 'paid'
  /** 真扣失败（能量源抛错）：按没付成处理。 */
  | 'charge-failed'

/**
 * 一次感知的能量回执。
 *
 * `denied=true` 时器官**必须立刻放弃本次感知**（C2）。本包不替它放弃——
 * 但 `state()` 会因为「回执被拒」而抛 `PerceptionDeniedError`，
 * 所以「不放弃」这条路走不通，而不是「不放弃也没人管」。
 */
export interface EnergyReceipt {
  /** 谁花的。 */
  readonly organId: string
  /** 报价（0–100）。 */
  readonly requested: number
  /** 实际扣掉的量（0–100）。`shadow` 恒 0。 */
  readonly charged: number
  /** 扣后剩余；读不到能量源时省略（不是 0——0 是「确定没了」）。 */
  readonly remaining?: number
  /** 四态之一。 */
  readonly state: EnergyState
  /** 是否拒绝本次感知。 */
  readonly denied: boolean
  /** 计费模式。 */
  readonly mode: ChargeMode
  /** 原因码。 */
  readonly reason?: EnergyReason
  /** 回执时刻。 */
  readonly at: number
  /** 回执有效期截止（毫秒时间戳）。过期后 `state()` 要求重新 `consume()`。 */
  readonly expiresAt: number
}

/** 器官的能量报价单。 */
export interface OrganEnergySpec {
  /** 每次感知的报价（0–100）。0 = 免票（仍需 `consume()` 拿回执）。 */
  readonly cost: number
  /** 一句说明，只进日志。 */
  readonly note?: string
}

/** 器官申报提示词片段的默认策略。 */
export interface OrganPromptSpec {
  /** 默认排序键。须在 `[MIN_ORGAN_ORDER, MAX_ORDER]`。 */
  readonly order: number
  /** 默认存活毫秒；省略 = 不过期。 */
  readonly ttlMs?: number
  /** 默认置信度（0–1）；省略按 `0.5`。 */
  readonly confidence?: number
}

/** 器官清单：注册时一次性交出，之后只读。 */
export interface OrganManifest {
  /** 器官 id，须匹配 `KEY_RE`，全宿主唯一。 */
  readonly id: string
  /** 版本号，只进日志与遥测（本包不做兼容判定）。 */
  readonly version: string
  /** 中文名，只给界面与日志。 */
  readonly title?: string
  /** 声明即申请；未声明的能力调用一律抛 `CapabilityDeniedError`。 */
  readonly capabilities: readonly Capability[]
  /** 能量报价。 */
  readonly energy: OrganEnergySpec
  /** 提示词默认策略；不申报片段可省略。 */
  readonly prompt?: OrganPromptSpec
}

/** 一次授权的结果（含被策略拒掉的那部分）。 */
export interface CapabilityGrant {
  /** 谁。 */
  readonly organId: string
  /** 真正拿到的能力。 */
  readonly granted: readonly Capability[]
  /** 声明了但被宿主策略拒掉的。 */
  readonly denied: readonly Capability[]
  /** 授权时刻。 */
  readonly at: number
}

/** 注册被拒的原因。 */
export type OrganRefusalReason =
  /** 宿主总开关关着。 */
  | 'disabled'
  /** 同 id 已注册。 */
  | 'duplicate'
  /** id 不合规（§8.4）。 */
  | 'bad-id'
  /** 声明了白名单外的能力名。 */
  | 'unknown-capability'
  /** 清单字段不合法（缺版本、报价非数、order 越界…）。 */
  | 'bad-manifest'

/** 注册结果。判别联合：`accepted=false` 时没有 facade，逼调用方当场处理。 */
export type OrganRegistration =
  | {
      readonly accepted: true
      readonly id: string
      readonly facade: OrganFacade
      readonly grant: CapabilityGrant
      /** 撤销：摘掉监听、注销工具、清键值空间、丢弃未提交的提议。 */
      readonly dispose: Disposer
    }
  | {
      readonly accepted: false
      readonly id: string
      readonly reason: OrganRefusalReason
      /** 一句人话，直接进日志。 */
      readonly detail: string
    }

/**
 * O-026 情绪快照的**结构对位子集**（只读）。
 *
 * 不 `import` O-026 源码（§3.3-1）：那会让两个插件编译期互相绑定。
 * 只取三个字段，是因为器官只需要「她现在什么状态」，不需要 PAD 的派生视图。
 */
export interface EmotionView {
  readonly at: number
  readonly axes: Readonly<Record<string, number>>
  readonly labels: Readonly<Record<string, number>>
}

/**
 * 器官看到的世界状态（只读）。
 *
 * `emotion` 与 `values` 都是**浅拷贝**：器官拿不到持有者的对象引用，
 * 也就不可能「顺手改一下」——C1 的第一道物理防线。
 */
export interface OrganStateView {
  readonly at: number
  /** 情绪快照；O-026 缺席时省略（省略 = 不知道，不是「没有情绪」）。 */
  readonly emotion?: EmotionView
  /** 其他已登记状态源的读数，键为源 id。 */
  readonly values: Readonly<Record<string, unknown>>
}

/** 一条反馈提议：某个状态目标 + 一个增量。 */
export interface FeedbackDelta {
  /**
   * 目标键，须匹配 `KEY_RE`（例：`emotion-pleasure`）。
   *
   * **用连字符，不用点号**：`emotion.pleasure` 过不了 `^[a-z][a-z0-9_-]{1,63}$`，
   * 会被 `enqueue()` 判 `bad-target` 静默丢弃。这条示例原先就写成了点号形式，
   * 是被自己的校验器当场抓住的（见 README「自查找出并修掉的问题 1」）。
   */
  readonly target: string
  /** 增量。正负皆可，**不在这里夹紧**。 */
  readonly delta: number
  /** 一句理由，只进日志与遥测。 */
  readonly reason?: string
}

/** 提交结果（`feedback()` 的返回）。 */
export interface FeedbackQueueResult {
  /** 收下了几条。 */
  readonly queued: number
  /** 被拒的条目与原因。 */
  readonly rejected: readonly { readonly target: string; readonly reason: FeedbackRejectReason }[]
}

/** 单条提议被拒的原因。 */
export type FeedbackRejectReason =
  /** 目标键不合规（§8.4）。 */
  | 'bad-target'
  /** 增量不是有限数。 */
  | 'bad-delta'
  /** 待提交队列满了。 */
  | 'queue-full'

/** 一个目标在一次 flush 里的结局。 */
export type FeedbackOutcome =
  /** 按增量原样应用。 */
  | 'applied'
  /** 被边界或步长夹过，实际增量小于提议。 */
  | 'clamped'
  /** 没有持有者登记这个目标：丢弃并计数。 */
  | 'no-sink'
  /** 持有者抛错：丢弃并计数，**不影响其它目标**。 */
  | 'sink-error'

/** 一个目标的应用记录。 */
export interface FeedbackApply {
  readonly target: string
  readonly sum: number
  readonly delta: number
  readonly before?: number
  readonly after?: number
  readonly outcome: FeedbackOutcome
  /** 参与本条提议的器官（去重，升序）。 */
  readonly by: readonly string[]
}

/** 一次仲裁的结果。 */
export interface FeedbackReport {
  readonly at: number
  /** 触发原因（谁调的 flush）。 */
  readonly reason: string
  /** 参与的目标数。 */
  readonly targets: number
  readonly applied: number
  readonly clamped: number
  readonly dropped: number
  readonly items: readonly FeedbackApply[]
}

/**
 * 一个可被反馈写入的状态目标。
 *
 * **由持有者登记**，不由宿主猜。`min/max/maxStep` 三个边界是**可选**的：
 * 给了，宿主就在自己这边夹一次（夹的是**结果值**，不是增量）；
 * 不给，夹紧权归持有者——宿主绝不在别人家里立第二套边界。
 */
export interface FeedbackTarget {
  readonly key: string
  /** 结果下界（含）。 */
  readonly min?: number
  /** 结果上界（含）。 */
  readonly max?: number
  /** 单次 flush 的最大步长（绝对值）。 */
  readonly maxStep?: number
  /** 读当前值。省略 = 无法夹结果，增量原样应用。 */
  read?: () => number | undefined
  /** 应用一个**已经算好**的增量。宿主只调一次。 */
  apply(delta: number): void
}

/** 片段的种类。`scar` 是唯一能进疤痕保留区的种类。 */
export type FragmentKind =
  /** 疤痕：恒 `SCAR_ORDER`，由宿主强制，不看申报值。 */
  | 'scar'
  /** 执念 / 张力。 */
  | 'drive'
  /** 感知（看到、听到）。 */
  | 'sense'
  /** 备注（她自己在想的事）。 */
  | 'note'
  /** 规矩（边界、禁令）。 */
  | 'rule'

/** 器官申报的一片提示词（未过滤、未排序）。 */
export interface OrganPromptDraft {
  /** 稳定 id，用于跨轮去重。省略时宿主用 `器官 id + 序号` 兜底。 */
  readonly id?: string
  /** 正文。空白即拒收。 */
  readonly text: string
  /** 排序键；省略用清单里的默认值。 */
  readonly order?: number
  /** 存活毫秒；省略用清单里的默认值（也没有就不过期）。 */
  readonly ttlMs?: number
  /** 置信度 0–1；省略用清单里的默认值（也没有就 0.5）。 */
  readonly confidence?: number
  /** 种类；省略按 `note`。 */
  readonly kind?: FragmentKind
  /** 这片是什么时候产生的；省略按取片时刻。 */
  readonly at?: number
}

/** 被采纳的一片（已定序、已定型）。 */
export interface PromptFragment {
  readonly id: string
  readonly organId: string
  readonly text: string
  readonly order: number
  readonly confidence: number
  readonly kind: FragmentKind
  readonly at: number
  /** 排序键是否被宿主改写过（疤痕恒 -1e4 时为 true）。 */
  readonly forced: boolean
}

/** 被丢掉的一片与原因。**丢弃必须可数**，否则「没注入」与「没申报」同形。 */
export type FragmentDropReason =
  | 'empty-text'
  | 'too-long'
  | 'duplicate'
  | 'order-reserved'
  | 'order-out-of-range'
  | 'expired'
  | 'low-confidence'
  | 'over-limit'
  | 'provider-error'

/** 一条丢弃记录。 */
export interface DroppedFragment {
  readonly id: string
  readonly organId: string
  readonly reason: FragmentDropReason
  /** 一句人话（例如「order -5000 落在疤痕保留区」）。 */
  readonly detail: string
}

/** 一次拼装的结果。 */
export interface PromptAssembly {
  readonly at: number
  /** 拼好的正文（按 order 升序、`\n` 连接）。 */
  readonly text: string
  readonly fragments: readonly PromptFragment[]
  readonly dropped: readonly DroppedFragment[]
  /** 正文总字数（按码位，不按 UTF-16 单元）。 */
  readonly chars: number
}

/** 拼装选项。 */
export interface PromptOptions {
  /** 覆盖配置里的最低置信度。 */
  readonly minConfidence?: number
  /** 覆盖配置里的片段数上限。 */
  readonly maxFragments?: number
}

/** 一次工具结果的只读视图（宿主喂进来的）。 */
export interface ToolResultView {
  readonly at: number
  /** 工具名。 */
  readonly tool: string
  readonly ok: boolean
  /** 失败归因码。**本包不判定**，只透传（归因是 O-139 的职责）。 */
  readonly errorCode?: string
  /** 结果正文（可能被上游沙箱截断过）。 */
  readonly text?: string
  readonly durationMs?: number
}

/** 一次心跳的统计。 */
export interface TickReport {
  readonly at: number
  /** 收到心跳的器官数。 */
  readonly organs: number
  /** 真正调用的处理器数。 */
  readonly called: number
  /** 抛错的处理器数（已吞掉，对应器官转 degraded）。 */
  readonly failed: number
}

/** 一次工具结果分发的统计。 */
export interface ToolResultReport {
  readonly at: number
  readonly called: number
  readonly failed: number
}

/** 缺口来源（O-129 的闭合集，**不许加第四源**）。 */
export const GAP_SOURCES = Object.freeze(['model-unsure', 'tool-empty', 'request-failed'] as const)

/** 一个缺口来源。 */
export type OrganGapSource = (typeof GAP_SOURCES)[number]

/** 器官提缺口的入参。 */
export interface OrganGapInput {
  readonly text: string
  /** 必须是三源之一；给别的值一律拒收（不猜、不新开一源）。 */
  readonly source: OrganGapSource
  readonly query?: string
  readonly note?: string
}

/** 提缺口的结果。 */
export interface GapProposalResult {
  readonly accepted: boolean
  /** 拒收原因；接收时省略。 */
  readonly reason?: 'no-service' | 'bad-source' | 'refused' | 'threw'
  /** O-129 给的 id（接收时才有）。 */
  readonly id?: string
}

/** 器官注册工具的最小形状（结构对位，不 `import` 上游 `@ntars/ondra-tools`）。 */
export interface OrganToolSpec {
  readonly name: string
  readonly description: string
  /** 参数表，原样透传给宿主工具注册表。 */
  readonly parameters?: Readonly<Record<string, unknown>>
  /** 执行体。宿主会额外传执行上下文，本包不消费。 */
  readonly execute: (args: Record<string, unknown>) => unknown
}

/** 器官自己的键值空间（内存，**不落盘**）。 */
export interface OrganKv {
  get<T = unknown>(key: string): T | undefined
  /** @returns 是否写入成功（超上限时为 false，不淘汰别人的键）。 */
  set(key: string, value: unknown): boolean
  delete(key: string): boolean
  keys(): readonly string[]
  readonly size: number
}

/** 器官拿到的门面。**只有这十个成员**。 */
export interface OrganFacade {
  readonly id: string
  readonly grant: CapabilityGrant
  /** 读世界状态。需 `state.read` 能力 + 未过期的有效回执。 */
  state(): OrganStateView
  /** 付能量换一次感知权。永远可用（义务，不是权限）。 */
  consume(units?: number): EnergyReceipt
  /** 向宿主发信号。需 `emit`。 */
  emit(signal: string, payload?: unknown): void
  /** 提一条缺口。需 `gap.propose`。 */
  proposeGap(input: OrganGapInput): GapProposalResult
  /** 收工具结果。需 `tool.result`。 */
  onToolResult(fn: (result: ToolResultView) => void): Disposer
  /** 收心跳。需 `tick`。 */
  onTick(fn: (at: number) => void): Disposer
  /** 注册工具。需 `tool.register`。 */
  registerTool(tool: OrganToolSpec): Disposer
  /** 申报提示词片段。需 `prompt.fragment`。 */
  onPrompt(fn: (at: number) => readonly OrganPromptDraft[]): Disposer
  /** 自己的键值空间。需 `kv`。 */
  readonly kv: OrganKv
  /** 自己的日志命名空间。需 `log`。 */
  readonly log: LogLike
}

/** 器官运行态。`degraded` = 上次调用抛过错（C3 之后的状态，不是错误本身）。 */
export type OrganRuntimeState = 'ready' | 'degraded'

/** 单个器官的计数。 */
export interface OrganCounters {
  readonly receipts: number
  readonly denied: number
  readonly starved: number
  readonly partial: number
  readonly shadow: number
  readonly fragments: number
  readonly droppedFragments: number
  readonly proposals: number
  readonly appliedDeltas: number
  readonly clampedDeltas: number
  readonly droppedDeltas: number
  readonly ticks: number
  readonly toolResults: number
  readonly errors: number
  readonly capabilityDenied: number
}

/** 单个器官的快照（深冻结）。 */
export interface OrganSnapshot {
  readonly id: string
  readonly version: string
  readonly title?: string
  readonly state: OrganRuntimeState
  readonly grant: CapabilityGrant
  /** 最后一次回执；从未感知过时省略。 */
  readonly lastReceipt?: EnergyReceipt
  readonly counters: OrganCounters
}

/** 全宿主计数。 */
export interface OrganStats {
  readonly at: number
  readonly chargeMode: ChargeMode
  readonly organs: number
  readonly receipts: number
  readonly denied: number
  readonly starved: number
  readonly degraded: number
  readonly fragments: number
  readonly droppedFragments: number
  readonly flushes: number
  readonly appliedDeltas: number
  readonly clampedDeltas: number
  readonly droppedDeltas: number
  readonly sinkErrors: number
  readonly signals: number
  readonly targets: number
  readonly pending: number
}

/** 服务不可用的原因。 */
export type OrganHostReason = 'disabled'

/** 器官宿主服务。 */
export interface OrganHostService {
  /** 是否在工作（总开关 + 是否已 dispose）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: OrganHostReason
  /** 当前计费模式（可观测：§14.2 不许黑箱切换）。 */
  readonly chargeMode: ChargeMode

  /** 注册一个器官。**永不抛错**（失败走 `accepted:false`）。 */
  register(manifest: OrganManifest): OrganRegistration
  /** 摘掉一个器官。@returns 是否真的摘掉了。 */
  unregister(id: string): boolean
  has(id: string): boolean
  ids(): readonly string[]
  /** 取门面（已注册才有）。 */
  facade(id: string): OrganFacade | undefined
  grantOf(id: string): CapabilityGrant | undefined

  /** 登记一个可写状态目标。重复键**不覆盖**（返回空撤销函数并告警）。 */
  useFeedbackTarget(target: FeedbackTarget): Disposer
  targets(): readonly string[]

  /** 提交一批提议。只入队，**不动任何状态**（C1）。 */
  feedback(organId: string, deltas: readonly FeedbackDelta[]): FeedbackQueueResult
  /** 一次性应用：按目标累加 → 夹紧 → 每目标只调一次 `apply`。 */
  flush(reason?: string): FeedbackReport

  /** 取拼装后的提示词片段。纯读，不做 IO、不调模型。 */
  prompt(options?: PromptOptions): PromptAssembly

  /** 广播心跳（宿主调度，本包**不装定时器**）。 */
  tick(at?: number): TickReport
  /** 分发一次工具结果。 */
  toolResult(result: ToolResultView): ToolResultReport

  /** 宿主自己发信号。 */
  signal(signal: string, payload?: unknown): number
  /** 听信号。 */
  on(signal: string, fn: (payload: unknown, from: string) => void): Disposer

  /** 登记一个只读状态源。重复 id **不覆盖**。 */
  useStateSource(id: string, read: (at: number) => unknown): Disposer

  stats(): OrganStats
  snapshot(): readonly OrganSnapshot[]
  /** 卸载：摘全部器官、清全部监听、丢弃未提交提议。幂等。 */
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

/* ------------------------------------------------------------------ *
 * 四个上游的**结构对位子集**（只声明本包真的要用的成员）
 *
 * 一律不 `import` 上游源码（§3.3-1）：两个插件编译期互相绑定之后，
 * 任何一方单独卸载都会让另一方编译失败。代价是字段要人工同步，
 * 已写进 README「已知限制」。
 * ------------------------------------------------------------------ */

/** O-026 情绪服务：只要 `state(at)` 的六维 + 标签。 */
export interface EmotionSourceLike {
  state(at?: number): {
    readonly at: number
    readonly axes: Readonly<Record<string, number>>
    readonly labels: Readonly<Record<string, number>>
  }
}

/** O-048 生活层：读能量 / 扣能量。 */
export interface EnergySourceLike {
  energy(at?: number): { readonly energy: number }
  feed(delta: number, at?: number): unknown
}

/** O-129 缺口池：提一条缺口。`source` 用字符串收，由本包按三源闭合集校验。 */
export interface GapPoolLike {
  open(
    input: { readonly text: string; readonly source: string; readonly query?: string; readonly note?: string },
    at?: number,
  ): { readonly accepted: boolean; readonly gap?: { readonly id: string } }
}

/** 宿主的工具注册表（`@ntars/ondra-tools` 的 `ctx.tools`）：只声明 `register`。 */
export interface ToolsRegistryLike {
  register(tool: unknown): Disposer
}

/** O-003 时钟：只要 `now()`。 */
export interface ClockLike {
  now(): number
}

/* ------------------------------------------------------------------ *
 * 错误：全部在**调用期**抛，且都带 organId / capability 便于归因
 * ------------------------------------------------------------------ */

/** 调了没声明的能力（default-deny）。 */
export class CapabilityDeniedError extends Error {
  readonly organId: string
  readonly capability: string

  constructor(organId: string, capability: string) {
    super('器官「' + organId + '」没有能力「' + capability + '」：清单里没声明，或声明了但被宿主策略拒绝')
    this.name = 'CapabilityDeniedError'
    this.organId = organId
    this.capability = capability
  }
}

/** 清单不合法。注册期抛（运行期不抛）。 */
export class OrganManifestError extends Error {
  readonly field: string

  constructor(field: string, message: string) {
    super('器官清单的「' + field + '」不合法：' + message)
    this.name = 'OrganManifestError'
    this.field = field
  }
}

/** 没付能量就想读状态（C2）。 */
export class ReceiptRequiredError extends Error {
  readonly organId: string
  readonly why: 'missing' | 'expired'

  constructor(organId: string, why: 'missing' | 'expired') {
    super(
      why === 'missing'
        ? '器官「' + organId + '」还没 consume()：先付能量，再读状态（C2）'
        : '器官「' + organId + '」的回执已过期：重新 consume() 才能继续读状态',
    )
    this.name = 'ReceiptRequiredError'
    this.organId = organId
    this.why = why
  }
}

/** 回执被拒却还想读状态（C2 的牙齿）。 */
export class PerceptionDeniedError extends Error {
  readonly organId: string

  constructor(organId: string) {
    super('器官「' + organId + '」的能量回执是 denied：本次感知必须放弃（C2），不能读状态')
    this.name = 'PerceptionDeniedError'
    this.organId = organId
  }
}
