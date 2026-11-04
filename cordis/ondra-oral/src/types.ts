/**
 * O-040 `ondra-oral` 的对外契约：**口语化塑形**。
 *
 * 手册 §4.2 给了六条硬参数，一条都不是「机制」：
 *
 * | 手册原文 | 本契约 |
 * |---|---|
 * | 口头禅池每人格 12–20 条、按情绪分档、单场最多 2 次 | `HabitPoolView` + `habitMaxPerSession` |
 * | 不完整句 8%（省略主语或结尾） | `incompleteP` + `apply()` 的 `incomplete-*` |
 * | 标点习惯（不用句号结尾 / 连续问号表疑惑 / 省略号表犹豫） | `punct-*` 三种标记 |
 * | 单条中位 8–12 字 | `measure()` 只报告，不截断 |
 * | 贴纸触发最小间隔 3 条 | `stickerGate()` 只做闸门 |
 * | 零错别字（拟人≠装笨） | `typosIntroduced: 0` 字面量 |
 *
 * ## 四条边界（都由「谁改正文」这条线切出来）
 *
 * 1. **只加不删**。删句、去客服腔、红线拦截归 O-037 `ondra-filter-chain`；
 *    本插件只做「加口癖、改标点、省主语、减语气词」这四类表层动作。
 *    唯一涉及「减」的是语气词与收尾词——它们不是内容，去掉不丢信息。
 *
 * 2. **不造词**。语气词档为 `rich` 时本插件**一个词都不加**：加词等于扩库，
 *    而人设包里有「4.3 语气词只有这些」与「4.7 黑白名单」，
 *    自造一个语气词会当场破坏人设约束。加词归模型（提示词带档位）。
 *
 * 3. **不改语义**。「省略结尾」只省**收尾语气词**（了/啦/呀…），
 *    不砍最后一个短句——砍短句会丢内容，那是删，不是省。
 *
 * 4. **零错别字是类型级承诺**。`OralResult.typosIntroduced` 的类型是字面量 `0`，
 *    想「装笨写错字」必须先把类型改掉——改类型这件事在评审里藏不住。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * O-031 的六态与表达档用结构对位镜像。
 */

/** 本插件注册的服务键（连字符，非 `ondra:oral`）。全仓唯一归属。 */
export const ORAL_SERVICE_KEY = 'ondra-oral'

/** 命名硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单场口头禅硬上限。手册原文「单场最多 2 次」，配置的 `max` 也锁 2。 */
export const HARD_MAX_HABIT_PER_SESSION = 2

/** 口头禅池下限。手册原文「每人格 12–20 条」。 */
export const HARD_MIN_POOL_SIZE = 12

/** 口头禅池上限。手册原文「每人格 12–20 条」。 */
export const HARD_MAX_POOL_SIZE = 20

/** 贴纸最小间隔（条）。手册原文「贴纸触发最小间隔 3 条」。 */
export const HARD_MIN_STICKER_GAP = 3

/**
 * 一条口头禅的字数上限。
 *
 * **手册没给**。自定 8 字：口头禅是插话（「诶」「对吧」「说真的」），
 * 超过 8 字就成了一句台词，插在哪儿都会抢正文。登记待裁决。
 */
export const MAX_HABIT_CHARS = 8

/* ------------------------------------------------------------------ *
 * 一、六态（镜像 O-031 的闭合集合，不 import）
 * ------------------------------------------------------------------ */

/** 六态。与 O-031 `ExpressState` **逐字一致**，增删改名都要先改手册。 */
export const ORAL_STATES = ['joyful', 'soft', 'calm', 'wilted', 'bristled', 'sleepy'] as const

/** 一个状态名。 */
export type ExpressStateLike = (typeof ORAL_STATES)[number]

/** 判一个值是不是六态之一。 */
export function isStateLike(value: unknown): value is ExpressStateLike {
  return typeof value === 'string' && (ORAL_STATES as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ *
 * 二、口头禅池
 * ------------------------------------------------------------------ */

/** 插在句首还是句尾。 */
export type HabitPlacement = 'prefix' | 'suffix' | 'any'

/** 一条口头禅。 */
export interface HabitEntry {
  /** 稳定 id（同一池内唯一）。 */
  readonly id: string
  /** 口头禅正文（≤ `MAX_HABIT_CHARS` 字，不含标点）。 */
  readonly text: string
  /**
   * 适用的六态。**缺省 = 通用**。
   *
   * 手册只说「按情绪分档」，没给档名。这里直接借用 O-031 的六态，
   * 不另造一套「高/中/低」——两套情绪词并存会让同一句话被两处判定。
   */
  readonly states?: readonly ExpressStateLike[]
  /** 插在句首/句尾；`any` 时用配置的默认位。 */
  readonly placement: HabitPlacement
}

/** 注册时接受的最小形状（id 可省，由插件生成）。 */
export interface HabitEntryInput {
  readonly id?: string
  readonly text: string
  readonly states?: readonly string[]
  readonly placement?: string
}

/** 一个口头禅池的只读视图。 */
export interface HabitPoolView {
  readonly personaId: string
  /** 条目数。 */
  readonly size: number
  /**
   * 是否够用（`size >= habitMinPoolSize`）。
   *
   * 不够时 `apply()` **不插口头禅**——3 条池子会让同一句话每轮出现，
   * 那正是手册说的「静态池让人设僵化」。宁可不插。
   */
  readonly ready: boolean
  /** 每档条数（键为六态或 `any`）。 */
  readonly byState: Readonly<Record<string, number>>
  readonly entries: readonly HabitEntry[]
}

/** 注册结果。**永不抛错**：坏条目逐条丢弃并说明原因。 */
export interface PoolRegistration {
  readonly ok: boolean
  readonly size: number
  readonly dropped: number
  readonly issues: readonly string[]
}

/* ------------------------------------------------------------------ *
 * 三、塑形请求与结果
 * ------------------------------------------------------------------ */

/** 语气词档（镜像 O-031 的 `ParticleLevel`）。 */
export type ParticleLevelLike = 'rich' | 'normal' | 'sparse' | 'none'

/** 标点倾向（镜像 O-031 的 `Punctuation`）。 */
export type PunctuationLike = 'exclaim' | 'interrobang' | 'normal' | 'plain'

/** 句形（镜像 O-031 的 `SentenceShape`）。 */
export type SentenceShapeLike = 'burst' | 'medium' | 'plain' | 'long-single' | 'clipped' | 'ellipsis'

/** 本插件消费的表达档子集（**只有四个字段**，不复制 O-031 的整张表）。 */
export interface OralStyle {
  readonly state?: ExpressStateLike
  readonly particles?: ParticleLevelLike
  readonly punctuation?: PunctuationLike
  readonly sentenceShape?: SentenceShapeLike
}

/** 一次单条塑形请求。 */
export interface OralRequest {
  readonly text: string
  /** 会话 id（口头禅「单场」按它计数）。省略用 `default`。 */
  readonly sessionId?: string
  /** 人格 id（口头禅池按它取）。省略用 `default`。 */
  readonly personaId?: string
  /** 时刻（问 O-031 用）。省略用系统时间。 */
  readonly at?: number
  /** 随机源（测试可注入）。 */
  readonly rng?: () => number
  /** 显式表达档（给了就不再问 O-031）。 */
  readonly style?: OralStyle
  /** 是否允许这一条变成不完整句。默认 `true`；整轮塑形请用 `applyTurn()`。 */
  readonly allowIncomplete?: boolean
}

/** 塑形动作的种类。 */
export type OralMarkKind = 'habit' | 'particle' | 'incomplete' | 'punct' | 'skip'

/** 一条塑形记录（**每一项改动都要能说出来**）。 */
export interface OralMark {
  readonly kind: OralMarkKind
  /** 机器码，见 README「标记表」。 */
  readonly code: string
  /** 人话补充（例如插进去的那句口头禅）。 */
  readonly detail?: string
}

/** 单条塑形结果。 */
export interface OralResult {
  readonly text: string
  readonly changed: boolean
  readonly marks: readonly OralMark[]
  /** 塑形后的字数（去空白）。 */
  readonly chars: number
  /** 本条插入的口头禅（没有则缺省）。 */
  readonly habit?: string
  /**
   * 本插件制造了几个错别字。**恒为 0**。
   *
   * 写成字面量而不是 `number`：手册 §4.2「零错别字（拟人≠装笨）」。
   * 有了这个字段，「装笨」就不可能被悄悄实现——必须改类型。
   */
  readonly typosIntroduced: 0
}

/** 一次整轮塑形请求。 */
export interface OralTurnRequest {
  /** 一轮的若干条消息（通常是 O-038 分条**之前**的整段，或 O-037 之后的成品分条）。 */
  readonly texts: readonly string[]
  readonly sessionId?: string
  readonly personaId?: string
  readonly at?: number
  readonly rng?: () => number
  readonly style?: OralStyle
}

/** 一次整轮塑形结果。 */
export interface OralTurnResult {
  readonly messages: readonly OralResult[]
  readonly sessionId: string
  /** 本场已用口头禅次数（含本轮）。 */
  readonly habitUsed: number
  /** 第几条被省成了不完整句（`-1` 表示没有）。 */
  readonly incompleteAt: number
  /** 塑形后中位字数。 */
  readonly median: number
  /** 中位字数是否落在 8–12 区间。 */
  readonly inBand: boolean
  readonly notes: readonly string[]
}

/* ------------------------------------------------------------------ *
 * 四、字数与贴纸闸门
 * ------------------------------------------------------------------ */

/** 字数报告。 */
export interface LengthReport {
  readonly count: number
  readonly median: number
  readonly min: number
  readonly max: number
  readonly inBand: boolean
  readonly band: { readonly min: number; readonly max: number }
}

/** 贴纸闸门判定。 */
export interface StickerGate {
  readonly allowed: boolean
  /** 距上一次贴纸已过几条。 */
  readonly sinceLast: number
  /** 配置的最小间隔。 */
  readonly gap: number
  readonly reason: 'ok' | 'gap' | 'disabled'
}

/* ------------------------------------------------------------------ *
 * 五、服务
 * ------------------------------------------------------------------ */

/** 统计快照。 */
export interface OralStats {
  readonly turns: number
  readonly messages: number
  readonly habits: number
  readonly incompletes: number
  readonly particles: number
  readonly puncts: number
  readonly skipped: number
  readonly pools: number
  readonly sessions: number
  /** 问 O-031 时抛错的次数（已吞掉，不外抛）。 */
  readonly expressErrors: number
}

/** 口语化塑形服务。 */
export interface OralService {
  /** 是否启用（只看配置开关）。 */
  readonly available: boolean
  /** 不可用原因（**只有配置关掉**才算不可用）。 */
  readonly reason?: 'disabled'
  /**
   * 六态语域此刻是否在位。
   *
   * 与 `available` 分开：只看前者会让面板显示「口语化已启用」，
   * 而实际每一轮都在用默认标点——那种「一切正常但没效果」最难查。
   */
  readonly expressReady: boolean

  /** 全部池的视图。 */
  pools(): readonly HabitPoolView[]
  /** 取一个人格的池（没有则返回空池，不抛）。 */
  poolOf(personaId: string): HabitPoolView
  /** 注册/覆盖一个池。**永不抛错**。 */
  registerPool(personaId: string, entries: readonly HabitEntryInput[]): PoolRegistration
  /** 删一个池。返回是否真的删掉了。 */
  dropPool(personaId: string): boolean

  /** 当前表达档（问 O-031，缺席时返回空对象）。 */
  styleOf(at?: number): OralStyle

  /** 单条塑形。 */
  apply(request: OralRequest): OralResult

  /**
   * 整轮塑形。
   *
   * 与 `apply()` 的差别只有一处：**不完整句与口头禅都是「整轮最多一次」**。
   * 逐条调用 `apply()` 会让 8% 变成「每条 8%」（4 条一轮约 28%），
   * 而她不该每轮都有一句话说一半。
   */
  applyTurn(request: OralTurnRequest): OralTurnResult

  /** 只量字数，不改文本。 */
  measure(texts: readonly string[]): LengthReport

  /** 贴纸闸门（**不发贴纸**，发归 O-052）。 */
  stickerGate(sessionId: string): StickerGate
  /** 记「又发了几条」，供闸门计距。 */
  noteMessages(sessionId: string, count: number): void
  /** 记一次贴纸（闸门重置）。 */
  markSticker(sessionId: string): void

  /** 开一场（口头禅次数归零）。不调用则同一会话 id 一直累计。 */
  beginSession(sessionId: string): void

  stats(): OralStats
}

/* ------------------------------------------------------------------ *
 * 六、上游与宿主的结构对位（§18.5：不 import 源码）
 * ------------------------------------------------------------------ */

/** O-031 的表达档子集。 */
export interface ExpressPromptLike {
  readonly particles?: ParticleLevelLike
  readonly punctuation?: PunctuationLike
  readonly sentenceShape?: SentenceShapeLike
}

/** O-031 的判定结果子集。 */
export interface ExpressViewLike {
  readonly state: ExpressStateLike
}

/** O-031 的完整档子集。 */
export interface ExpressProfileLike {
  readonly view: ExpressViewLike
  readonly prompt: ExpressPromptLike
}

/** O-031 服务的结构对位子集。 */
export interface ExpressLike {
  readonly available: boolean
  profileOf(at?: number): ExpressProfileLike
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
