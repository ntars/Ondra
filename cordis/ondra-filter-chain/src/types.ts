/**
 * O-037 `ondra-filter-chain` 的对外契约：**九步过滤链 + 锚点检测 + 事后评审回环**。
 *
 * 手册 §4.1 只给了九个名字与顺序：
 *
 * ```
 * strip_draft → ai_self_expose → hard_redline → relation_redline → stage_redline
 * → narration_trim → repeat_4gram → service_tone → length_fallback
 * ```
 *
 * 加一句「参考实现 627 行 + 12 测试，照参数重写、不复制代码」。
 * **手册没有给任何正则与阈值**——所以本插件里所有阈值都是自定的，
 * 逐条登记在 README「待裁决」，改一处即换口径。
 *
 * ## 六件必须先说清的事
 *
 * 1. **只在句边界动手，绝不切字。** 一个被切掉半句的「不行」会变成「不」，
 *    一个被截断的「我有点难过」会变成「我有点难」。所以本插件的每个步骤
 *    要么删整句、要么整段拒收，**没有 `slice(0, n)` 那种中间态**
 *    （唯一例外是长度兜底的极端情况，见 `hardCut`）。
 *
 * 2. **越线不靠删词修。** 关系越线 / 阶段越线的句子删掉半截会变病句，
 *    所以这两步只做「整句摘除」；摘完一句不剩就整段拒收（`needsRegenerate`），
 *    由 O-033 决定重生成还是换一句。
 *
 * 3. **数据驱动，不内置「什么关系不能说什么」的表。** 关系分寸在
 *    O-021 的 `cautions` 里，本插件只从里面抽**引号里的字面**与
 *    「不得/不许/不要」后面的短语——抽不出就这一步不命中。
 *    替人设作者决定分寸，比漏拦更危险。
 *
 * 4. **阶段越线用一张小表，且只拦表内句式。** 表是产品判断（手册没给），
 *    共 7 条，登记待裁决。表外一律放行——**漏拦只是语气偏，误杀是「她不像她」**。
 *
 * 5. **评审失败不算失败。** 独立模型超时、返回乱码、网关缺席，一律
 *    `verdict: 'degraded'` 放行。评审是增强，不是闸门；让它能把一句话拦死，
 *    等于把可用性押在第二个模型上。
 *
 * 6. **不产出正文。** 本插件只改/拒收已有正文，**从不生成一句话**。
 *    生成归 O-033，语气归 O-032，本插件是「最后一双手」。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 全部用结构对位镜像。
 */

/** 本插件注册的服务键（连字符，非 `ondra:filter-chain`）。全仓唯一归属。 */
export const FILTER_SERVICE_KEY = 'ondra-filter-chain'

/** 命名硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/* ------------------------------------------------------------------ *
 * 一、九步
 * ------------------------------------------------------------------ */

/**
 * 九步的 id，**数组顺序即执行顺序**（手册 §4.1 逐字）。
 *
 * 用连字符而不是手册里的下划线：`strip-draft` 与 `strip_draft` 指同一件事，
 * 但全仓的标识符（服务键 / 工具名 / 配置键）只认 `^[a-z][a-z0-9_-]{1,63}$`，
 * 一套连字符能省掉「这里要不要转换」的反复判断。对照表见 README。
 */
export const STEP_IDS = [
  'strip-draft',
  'ai-self-expose',
  'hard-redline',
  'relation-redline',
  'stage-redline',
  'narration-trim',
  'repeat-4gram',
  'service-tone',
  'length-fallback',
] as const

/** 步 id。 */
export type StepId = (typeof STEP_IDS)[number]

/** 一步的动作种类。 */
export type StepAction =
  /** 删整句。 */
  | 'strip'
  /** 改写（只做字符级替换，如「您」→「你」）。 */
  | 'rewrite'
  /** 只判定不改写（越线类，判到就整句摘）。 */
  | 'gate'
  /** 长度兜底（删尾部整句，极端时硬切）。 */
  | 'trim'

/** 一步的声明。 */
export interface StepSpec {
  /** 步 id。 */
  readonly id: StepId
  /** 执行序号 0–8。 */
  readonly order: number
  /** 手册里的原名（逐字，便于对拍）。 */
  readonly handbook: string
  /** 中文名（日志与面板用）。 */
  readonly label: string
  /** 动作。 */
  readonly action: StepAction
  /** 这一步靠什么数据（没有数据时它不命中）。 */
  readonly needs: string
  /** 一句话说明。 */
  readonly doc: string
}

/** 九步声明表 —— **顺序的唯一真源**。 */
const STEP_TMP: readonly StepSpec[] = [
  {
    id: 'strip-draft',
    order: 0,
    handbook: 'strip_draft',
    label: '草稿腔',
    action: 'strip',
    needs: '内置句式表',
    doc: '「好的，以下是…」「希望对你有所帮助」这类没说完的稿子腔，整句摘。',
  },
  {
    id: 'ai-self-expose',
    order: 1,
    handbook: 'ai_self_expose',
    label: 'AI 自我暴露',
    action: 'strip',
    needs: '内置句式表',
    doc: '「作为一个语言模型」「我没有真实情感」整句摘。**不碰**「我不会声称我有意识」这种诚实边界。',
  },
  {
    id: 'hard-redline',
    order: 2,
    handbook: 'hard_redline',
    label: '硬红线',
    action: 'gate',
    needs: 'O-021 boundaries(hard)',
    doc: '从硬约束里抽引号字面与「不得…」短语，命中就摘整句。',
  },
  {
    id: 'relation-redline',
    order: 3,
    handbook: 'relation_redline',
    label: '关系越线',
    action: 'gate',
    needs: 'O-021 variant(cautions)',
    doc: '从当前关系的 `cautions` 抽字面，命中就摘整句。关系缺席时这一步不命中。',
  },
  {
    id: 'stage-redline',
    order: 4,
    handbook: 'stage_redline',
    label: '阶段越线',
    action: 'gate',
    needs: 'O-028 阶序 + 内置 7 条表',
    doc: '低阶说高阶的话（占有 / 病态 / 献祭）整句摘。表是产品判断，登记待裁决。',
  },
  {
    id: 'narration-trim',
    order: 5,
    handbook: 'narration_trim',
    label: '旁白叙述',
    action: 'strip',
    needs: '内置句式表',
    doc: '整句括起来的第三人称叙述、`*动作*` 摘掉。**短的第一人称动作保留**（呼吸感，归 O-041）。',
  },
  {
    id: 'repeat-4gram',
    order: 6,
    handbook: 'repeat_4gram',
    label: '4-gram 复读',
    action: 'strip',
    needs: '本轮前文 + 最近几条她说的话',
    doc: '同一段里重复的、或与最近几条高度重合的句子摘掉。',
  },
  {
    id: 'service-tone',
    order: 7,
    handbook: 'service_tone',
    label: '客服腔',
    action: 'rewrite',
    needs: '内置句式表',
    doc: '「很高兴为您服务」整句摘；「您」→「你」（可关）。',
  },
  {
    id: 'length-fallback',
    order: 8,
    handbook: 'length_fallback',
    label: '长度兜底',
    action: 'trim',
    needs: '配置上限',
    doc: '超长从尾部整句删；只剩一句还超长才硬切。删空 / 过短则整段拒收。',
  },
]

/** 九步声明表（冻结）。 */
export const STEP_SPECS: readonly StepSpec[] = Object.freeze(STEP_TMP)

/* ------------------------------------------------------------------ *
 * 二、入参与结果
 * ------------------------------------------------------------------ */

/** 一次命中的记录。 */
export interface PassHit {
  /** 哪一步。 */
  readonly step: StepId
  /** 命中种类（`draft` / `ai` / `boundary` / `caution` / `stage` / `narration` / `repeat` / `service` / `length`）。 */
  readonly kind: string
  /** 命中片段（截到 40 字，只为看，不为改）。 */
  readonly sample: string
  /** 做了什么。 */
  readonly action: StepAction
}

/** 一步的结果。 */
export interface StepResult {
  /** 哪一步。 */
  readonly step: StepId
  /** 进来多少字。 */
  readonly beforeChars: number
  /** 出去多少字。 */
  readonly afterChars: number
  /** 是否改动了。 */
  readonly changed: boolean
  /** 摘掉了几句。 */
  readonly removed: number
  /** 这一步的命中。 */
  readonly hits: readonly PassHit[]
}

/** 过滤入参。 */
export interface FilterInput {
  /** 待过滤的正文（模型刚吐出来的那段）。 */
  readonly text: string
  /** 用户这一轮说的话（判复读与锚点用）。省略按空串。 */
  readonly userText?: string
  /** 当前关系 id（取 `cautions` 用）。省略则关系越线不生效。 */
  readonly relation?: string
  /** 当前阶序 0–6（O-028 的 `view().spec.order`）。省略则阶段越线不生效。 */
  readonly stageOrder?: number
  /** 最近几条她说的话（判跨轮复读）。省略则只判段内复读。 */
  readonly recent?: readonly string[]
  /** 时刻。 */
  readonly at?: number
  /** 临时覆盖长度上限。 */
  readonly maxChars?: number
}

/** 一次过滤的结果。 */
export interface ChainResult {
  /** 能不能发。`false` 时 `text` 必为空串。 */
  readonly ok: boolean
  /** 过滤后的正文。 */
  readonly text: string
  /** 原文多少字。 */
  readonly originalChars: number
  /** 结果多少字。 */
  readonly finalChars: number
  /** 九步逐步结果（**空步也在**，便于面板显示「哪一步动过手」）。 */
  readonly steps: readonly StepResult[]
  /** 全部命中。 */
  readonly hits: readonly PassHit[]
  /** 被哪一步整段拒收。 */
  readonly blockedBy?: StepId
  /** 是否需要重新生成（删空 / 过短）。 */
  readonly needsRegenerate: boolean
  /** 长度兜底是否硬切过（极端情况，会切在句中）。 */
  readonly hardCut: boolean
  /** 生效的长度上限（含情绪收紧后的值）。 */
  readonly maxChars: number
  /** 耗时（毫秒）。 */
  readonly elapsedMs: number
}

/* ------------------------------------------------------------------ *
 * 三、锚点检测（手册 §4.6）
 * ------------------------------------------------------------------ */

/** 锚点种类。 */
export type AnchorKind =
  /** 词汇锚点：用户说了激烈词，她立刻用同一个词进入最激烈语域。 */
  | 'vocabulary'
  /** 策略锚点：连续多轮附和（手册：连续 3 轮附和 → 注入纠偏）。 */
  | 'strategy'

/** 一次锚点命中。 */
export interface AnchorHit {
  /** 种类。 */
  readonly kind: AnchorKind
  /** 命中片段。 */
  readonly sample: string
  /** 一句人话。 */
  readonly note: string
}

/** 锚点检测入参。 */
export interface AnchorInput {
  /** 用户这一轮说的话。 */
  readonly userText: string
  /** 她这一轮的回复。 */
  readonly reply: string
  /** 最近几轮（`user` 与她的 `reply`），按时间升序。 */
  readonly recent?: readonly { readonly user: string; readonly reply: string }[]
}

/** 锚点检测结果。 */
export interface AnchorReport {
  /** 命中。 */
  readonly hits: readonly AnchorHit[]
  /**
   * 纠偏建议（给下一轮的提示词用）。
   *
   * 手册 §4.6 的原话是「连续 3 轮附和 → 注入纠偏」。**注入不是本插件的活**
   * （提示词拼装归 O-033 / O-036），这里只出那句话，谁拼谁取。
   */
  readonly correction?: string
  /** 连续附和的轮数（`0` 表示没在附和）。 */
  readonly agreementStreak: number
}

/* ------------------------------------------------------------------ *
 * 四、事后评审回环（手册 §1.7）
 * ------------------------------------------------------------------ */

/** 评审入参。 */
export interface ReviewInput {
  /** 这一轮的 id（**每轮最多 2 次评审**的计数键）。省略按 `'default'`。 */
  readonly turnId?: string
  /** 待评的正文。 */
  readonly text: string
  /** 用户这一轮说的话。 */
  readonly userText?: string
}

/** 评审结论。 */
export type ReviewVerdict =
  /** 分数达标。 */
  | 'pass'
  /** 分数不达标，带反馈回去重写。 */
  | 'steer'
  /** 评审不可用（网关缺席 / 超时 / 返回不可解析），**放行**。 */
  | 'degraded'
  /** 这一轮已经评过 2 次，不再评。 */
  | 'round-limit'

/** 评审结果。 */
export interface ReviewOutcome {
  /** 是否真的拿到了一次有效评分。 */
  readonly ok: boolean
  /** 分数 1–100；没评出来时省略。 */
  readonly score?: number
  /** 结论。 */
  readonly verdict: ReviewVerdict
  /** 给模型看的反馈（`steer` 时必有；其它情况为空串）。 */
  readonly feedback: string
  /** 这一轮第几次评审（从 1 起；`round-limit` 时是 3）。 */
  readonly round: number
  /** 结论原因（`degraded` 时是机器码）。 */
  readonly reason?: string
}

/* ------------------------------------------------------------------ *
 * 五、统计与服务
 * ------------------------------------------------------------------ */

/** 统计快照。 */
export interface FilterStats {
  /** 是否可用（只受总开关影响）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: FilterReason
  /** 过滤次数。 */
  readonly runs: number
  /** 上一次摘掉几句。 */
  readonly lastRemoved: number
  /** 上一次是否需重生成。 */
  readonly lastNeedsRegenerate: boolean
  /** 评审次数。 */
  readonly reviews: number
  /** 判为 `steer` 的次数。 */
  readonly steers: number
  /** 因「本轮已评 2 次」被拒的次数。 */
  readonly roundLimited: number
  /** 各上游在位情况。 */
  readonly sources: {
    readonly persona: boolean
    readonly stage: boolean
    readonly express: boolean
    readonly gateway: boolean
  }
}

/** 不可用原因。**只有配置关掉**才算不可用（降级 ≠ 不可用）。 */
export type FilterReason = 'disabled'

/** 过滤服务。 */
export interface FilterService {
  /** 是否可用（只受总开关影响）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: FilterReason

  /** 九步声明（顺序固定）。 */
  steps(): readonly StepSpec[]

  /**
   * 跑九步。
   * @param input 入参。
   */
  run(input: FilterInput): ChainResult

  /**
   * 锚点检测（手册 §4.6）。**只出结论，不改正文。**
   * @param input 入参。
   */
  anchors(input: AnchorInput): AnchorReport

  /**
   * 事后评审（独立模型 1–100 分，每轮最多 2 轮）。
   * @param input 入参。
   */
  review(input: ReviewInput): Promise<ReviewOutcome>

  /**
   * 重置某一轮的评审计数（新一轮开始时调）。
   * @param turnId 轮次 id。
   */
  resetTurn(turnId: string): void

  /** 统计快照。 */
  stats(): FilterStats
}

/* ------------------------------------------------------------------ *
 * 六、上游镜像（不 import，结构对位）
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状（Cordis Logger 的结构对位子集）。 */
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

/** 一条边界（镜像 O-021 的 `BoundaryItem`）。 */
export interface BoundaryLike {
  readonly id: string
  readonly text: string
  readonly hard: boolean
  readonly source: string
}

/** 关系变体（镜像 O-021 的 `RelationVariant`，只取分寸）。 */
export interface VariantLike {
  readonly id: string
  readonly label: string
  readonly cautions: readonly string[]
}

/** O-021 人格内核的结构对位子集。 */
export interface PersonaLike {
  readonly available: boolean
  boundaries(personaId?: string): readonly BoundaryLike[]
  variant(id: string): VariantLike | undefined
}

/** 阶段快照（镜像 O-028 的 `StageView`，只取阶序）。 */
export interface StageViewLike {
  readonly base: string
  readonly effective: string
  readonly spec: { readonly id: string; readonly order: number; readonly zh: string }
}

/** O-028 阶段的结构对位子集。 */
export interface StageLike {
  readonly available: boolean
  view(at?: number, locked?: boolean): StageViewLike
}

/** 表达档（镜像 O-031 的 `ExpressProfile`，只取状态与静默倾向）。 */
export interface ExpressProfileLike {
  readonly view: { readonly state: string; readonly zh: string; readonly matched: boolean }
  readonly rhythm: { readonly silenceBias: boolean; readonly proactivePaused: boolean }
}

/** O-031 表达的结构对位子集。 */
export interface ExpressLike {
  readonly available: boolean
  profileOf(at?: number): ExpressProfileLike
}

/** 一条消息（网关只认结构，不认具体类）。 */
export interface ChatMessageLike {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

/** 网关的非流式结果（镜像 O-035 的 `GatewayCompletion`）。 */
export interface GatewayCompletionLike {
  readonly text: string
  readonly finishKind: string
}

/** 网关请求（只用到这几个字段）。 */
export interface GatewayRequestLike {
  readonly messages: readonly ChatMessageLike[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly source?: string
  readonly purpose?: string
}

/** O-035 网关的结构对位子集。 */
export interface GatewayLike {
  readonly available: boolean
  complete(request: GatewayRequestLike): Promise<GatewayCompletionLike>
}
