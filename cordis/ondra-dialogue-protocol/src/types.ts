/**
 * O-034 `ondra-dialogue-protocol` 的对外契约（〔研〕自研）。
 *
 * ## 这一层为什么必须独立成插件
 *
 * 手册 §9.5 与 master-plan §9.5 都写死了**五种**事件帧，而不是两种：
 * `text-delta` / `text-replace` / `crisis` / `usage` / `done`。
 * 旧项目里这五个形状分散在三处——会话循环产出、界面侧消费、通道侧转发，
 * 每处各写一份判别逻辑。于是出现两类只能靠肉眼发现的失真：
 *
 * 1. 界面不认 `text-replace`，把它当 `text-delta` 追加 → **用户看到两遍开头**；
 * 2. 通道侧只转发 `text-delta`，`crisis` 被静默丢掉 → **危机提示永远到不了用户**。
 *
 * 所以帧的形状、顺序纪律、编解码只允许在这里存在一份。消费者按结构对位
 * （`§15.5` 不许 import 源码），但**判别式与字段名逐字一致**。
 *
 * ## 本插件刻意不做的事
 *
 * - **不做业务判断**：不判断「这句该不该说」、不判断危机等级是否成立。
 *   协议层只回答「这帧合不合法、还能不能继续写」。
 * - **不改写正文**：`text-replace` 是**告知**替换，不是由协议层去算替换成什么。
 * - **不落盘**：帧是流的一部分，写谁的不归这里（会话不落盘，见 O-033 的边界）。
 * - **不建 Session、不碰 `app_session_log`**（master-plan §6 禁令 5）。
 *
 * ## 一处本地扩展，已登记待裁决
 *
 * 手册只给了五帧的**名字与业务字段**，没有给序号。本插件给每帧加了 `seq`
 * （从 1 起、跨类型共用一个计数器）。理由：没有序号就无法区分
 * 「同一句话被重发」与「她真的说了两遍」——而这正是流式重连时最难查的一类重复。
 * 这一条是本插件的扩展，不是手册原文。
 */

/**
 * 本插件注册的服务键（连字符，非 `ondra:dialogue-protocol`）。
 *
 * 手册 §8.4：服务键/工具名/配置键必须匹配 `^[a-z][a-z0-9_-]{1,63}$`。
 * 带冒号的写法会被模型侧直接拒绝，而且是**运行期**才拒绝。
 */
export const DIALOGUE_PROTOCOL_SERVICE_KEY = 'ondra-dialogue-protocol'

/** 命名硬约束正则（手册 §8.4），与全仓其余插件同一份口径。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 五种帧的判别式取值。
 *
 * **这五个名字不得增删改名**：界面、通道、自检都按字面量分支。
 * 想要表达新语义，先加字段，不要加类型——加一个类型等于让所有消费者
 * 落到 `default` 分支，而 `default` 分支的行为永远是「静默忽略」。
 */
export type FrameType = 'text-delta' | 'text-replace' | 'crisis' | 'usage' | 'done'

const FRAME_TYPE_LIST: readonly FrameType[] = [
  'text-delta',
  'text-replace',
  'crisis',
  'usage',
  'done',
]

/** 五种帧类型（界面按此顺序渲染调试面板）。 */
export const FRAME_TYPES: readonly FrameType[] = Object.freeze(FRAME_TYPE_LIST)

/**
 * 结束原因，**四值闭集**（master-plan §9.5，代码为准）。
 *
 * `length` 对应上游的 `max-tokens`：命中输出上限被截断。它与 `stop` 必须分开，
 * 因为界面对「说完了」和「被截断了」的反应不同（后者要允许「继续说」）。
 */
export type StopReason = 'stop' | 'aborted' | 'error' | 'length'

const STOP_REASON_LIST: readonly StopReason[] = ['stop', 'aborted', 'error', 'length']

/** 四种结束原因。 */
export const STOP_REASONS: readonly StopReason[] = Object.freeze(STOP_REASON_LIST)

/**
 * 危机帧的三类标签（手册 §9.5 逐字：`crisis|privacy|isolate`）。
 *
 * 三个标签对应三种**不同的处置**：危机要转现实支持、隐私要说清数据边界、
 * 孤立要提示找现实里的人。压成一个布尔会让界面无法决定说哪句话。
 */
export type CrisisLabel = 'crisis' | 'privacy' | 'isolate'

const CRISIS_LABEL_LIST: readonly CrisisLabel[] = ['crisis', 'privacy', 'isolate']

/** 三类危机标签。 */
export const CRISIS_LABELS: readonly CrisisLabel[] = Object.freeze(CRISIS_LABEL_LIST)

/**
 * 文本增量帧。
 *
 * `delta` 是**追加**语义：消费者把它接到当前可见文本后面。
 * 空串刻意不算内容（见 `WriterOptions.allowEmptyDelta`）——发一个空帧
 * 会让下游多一次渲染与一次动画重启，看起来像「她说了一句然后卡了一下」。
 */
export interface TextDeltaFrame {
  readonly type: 'text-delta'
  /** 帧序号，从 1 起、跨类型共用。 */
  readonly seq: number
  readonly delta: string
}

/**
 * 整段替换帧。
 *
 * `text` 是**替换**语义：消费者应当用它对**当前这一轮的可见文本**整体覆盖，
 * 而不是追加。这条语义是「撤回重说」的唯一正确表示。
 *
 * 把 `text-replace` 当 `text-delta` 处理，就是「用户看到两遍开头」这个
 * 旧项目事故的成因；反过来把 `text-delta` 当替换处理，会让她每说一个字
 * 就把前面的话擦掉。
 */
export interface TextReplaceFrame {
  readonly type: 'text-replace'
  readonly seq: number
  readonly text: string
}

/**
 * 危机帧。
 *
 * **它不是终帧**：危机提示之后仍然可以有 `done`（一次完整回合总要收尾），
 * 也允许后面继续有正文（比如提示之后补一句安抚）。协议层刻意不替业务
 * 决定「危机时必须停」——那是 `ondra-filter-chain` 与通道层的事。
 *
 * 但**一轮最多一次**：重复的危机提示会让用户以为出了两件事。
 */
export interface CrisisFrame {
  readonly type: 'crisis'
  readonly seq: number
  /** 字段名逐字取 master-plan §9.5 的 `kindLabel`（`kind` 已被判别式占用）。 */
  readonly kindLabel: CrisisLabel
}

/**
 * 用量帧。
 *
 * 两个计数**不相交**：`inputTokens` 只含未命中缓存的输入，命中部分不计入
 * （上游 `TokenUsage` 的口径）。抄错这一条会让成本报表少算缓存那部分，
 * 而账单上看不出是统计错——只会觉得「怎么比算出来的便宜」。
 *
 * **一轮最多一次**：重复上报会让下游重复累加，直接表现为「账单翻倍」。
 */
export interface UsageFrame {
  readonly type: 'usage'
  readonly seq: number
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * 终帧。
 *
 * **`done` 是唯一的终帧**：写出一帧 `done` 之后，这个 writer 就关闭了，
 * 后续任何写入都会被拒绝（返回 `undefined` 并计入 `rejected`），**不抛错**。
 * 不抛的理由很实际：抛错发生在流式路径上，用户会看到半句话然后插件崩掉，
 * 而真正的错误信息在日志里——两边都没得到好结果。
 */
export interface DoneFrame {
  readonly type: 'done'
  readonly seq: number
  readonly stopReason: StopReason
}

/** 五帧的判别联合。 */
export type DialogueFrame =
  | TextDeltaFrame
  | TextReplaceFrame
  | CrisisFrame
  | UsageFrame
  | DoneFrame

/**
 * 单帧校验的失败原因。
 *
 * 分得这么细，是因为「哪一帧坏了」决定了修哪里：
 * `bad-seq` 是生产者计数器错，`missing-field` 是版本不匹配，
 * `bad-label` 是业务侧传了没定义过的标签。混成一个 `invalid` 等于没报。
 */
export type FrameIssueCode =
  /** 不是对象（`null` / 数组 / 原始值）。 */
  | 'not-object'
  /** `type` 不是五个已知值之一。 */
  | 'unknown-type'
  /** `seq` 不是 ≥1 的整数。 */
  | 'bad-seq'
  /** 文本类帧的正文不是字符串。 */
  | 'bad-text'
  /** `crisis.kindLabel` 不是三个已知值之一。 */
  | 'bad-label'
  /** `done.stopReason` 不是四个已知值之一。 */
  | 'bad-stop-reason'
  /** `usage` 的两个计数不是非负有限数。 */
  | 'bad-tokens'

/** 校验成功。 */
export interface FrameValid {
  readonly ok: true
  readonly frame: DialogueFrame
}

/** 校验失败。 */
export interface FrameInvalid {
  readonly ok: false
  readonly reason: FrameIssueCode
  /** 一句中文，可直接进日志；**不带帧的原始内容**（可能含用户原文）。 */
  readonly detail: string
}

/** 校验结果。 */
export type ValidateResult = FrameValid | FrameInvalid

/** 创建一个 writer 时的选项。 */
export interface WriterOptions {
  /**
   * 是否放行空文本增量。默认 `false`。
   *
   * 放行的唯一合理场景是「心跳」：某些通道需要周期性发帧保活。
   * 默认关，是因为空帧在界面上表现为「她卡了一下」。
   */
  readonly allowEmptyDelta?: boolean
}

/**
 * 帧写入器：**一个回合一个**，自带序号与终态。
 *
 * 每个方法返回 `DialogueFrame | undefined`：`undefined` 表示这一帧被拒绝
 * （已终态 / 重复 usage / 重复 crisis / 空增量）。调用方拿到 `undefined`
 * 就跳过，不需要 try/catch——这是刻意设计的**无异常写入面**。
 */
export interface FrameWriter {
  /** 下一个将要发出的序号（已被拒的帧不占号）。 */
  readonly seq: number
  /** 是否已写出 `done`。 */
  readonly closed: boolean
  /** 已成功写出的帧数。 */
  readonly frames: number
  /** 被拒绝的写入次数（含终态后的写入）。 */
  readonly rejected: number
  /** 写一帧文本增量；空串在默认选项下被拒。 */
  textDelta(text: string): TextDeltaFrame | undefined
  /** 写一帧整段替换。 */
  textReplace(text: string): TextReplaceFrame | undefined
  /** 写一帧危机标记；一轮最多一次。 */
  crisis(label: CrisisLabel): CrisisFrame | undefined
  /** 写一帧用量；一轮最多一次。 */
  usage(inputTokens: number, outputTokens: number): UsageFrame | undefined
  /** 写终帧并关闭 writer。 */
  done(stopReason: StopReason): DoneFrame | undefined
}

/** 协议层的累计统计。**只在内存**，不落盘。 */
export interface ProtocolStats {
  /** 创建过的 writer 数（≈ 回合数）。 */
  readonly writers: number
  /** 累计成功写出的帧数。 */
  readonly frames: number
  /** 累计被拒绝的写入次数。 */
  readonly rejected: number
  /** 最近一次拒绝原因（一句中文）。 */
  readonly lastReject?: string
  /** 累计编解码次数（`encode` + `decode`）。 */
  readonly codecCalls: number
}

/** 对外服务。 */
export interface DialogueProtocolService {
  /** 五种帧类型（只读，供界面与自检枚举）。 */
  readonly frames: readonly FrameType[]
  /** 四种结束原因。 */
  readonly stopReasons: readonly StopReason[]
  /** 三类危机标签。 */
  readonly crisisLabels: readonly CrisisLabel[]
  /** 为一个回合创建 writer。 */
  create(options?: WriterOptions): FrameWriter
  /**
   * 把上游的结束原因映射成四值闭集。
   *
   * **全仓唯一一份完整的映射**：O-033（对话链）消费它，协议缺席时只退化成
   * 「aborted / 其它」，刻意不在那边再写一份——两份映射必然漂移，
   * 而漂移的表现是「界面有时提示被截断、有时不提」。
   */
  stopReasonOf(kind: string | undefined): StopReason
  /** 校验一个未知值是不是合法帧。**纯函数，无副作用**。 */
  validate(value: unknown): ValidateResult
  /** 把帧序列化成一行 NDJSON（不含换行符）。非法帧抛 `TypeError`。 */
  encode(frame: DialogueFrame): string
  /** 把一行 NDJSON 解回帧；不合法返回 `undefined`（不抛）。 */
  decode(line: string): DialogueFrame | undefined
  /** 累计统计快照。 */
  stats(): ProtocolStats
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * ------------------------------------------------------------------ */

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
