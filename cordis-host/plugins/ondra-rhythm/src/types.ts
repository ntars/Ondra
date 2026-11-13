/**
 * O-038 `ondra-rhythm` 的对外契约：**分条与停顿的纯计算**。
 *
 * 手册里关于节奏的规范只有两处，且都是参数而非算法：
 *
 * - 手册 §3.3（第 396 行）：「节奏参数（已实现 272 行纯函数）：`long_pause_p 0.20` /
 *   停顿 [3000,9000]ms / 首字延迟 [800,2000]ms / `self_correct_p 0.05` / **深夜系数 1.6**」。
 * - master-plan §9.2（源码实读）：「`maxMessages=4`（官方 QQ 5 次留 1 次余量）/
 *   `maxCharsPerMessage=40` / `charsPerSecond=6` / 标点附加 。！？ 300ms、……—— 500ms、
 *   ，； 150ms / `minDelayMs=300`、`maxDelayMs=6000`；**先卡限→乘深夜 1.6（23:00–06:00）→
 *   再卡限** / 长停顿概率 0.2、时长 3000–9000ms、**整轮最多一次** / 自我修正概率 0.05、
 *   3 句模板、**默认不自动插入** / 超限「保留前 3 条，其余**从尾部合并**成第 4 条」」。
 *
 * **算法一个字都没给。** 所以本插件里所有「怎么切、切在哪、哪一条停顿」都是自定的，
 * 逐条登记在 README「待裁决」，改配置即改口径。
 *
 * ## 六件必须先说清的事
 *
 * 1. **`maxMessages = 4` 是防封余量，不是产品偏好。** 手册写明「官方 QQ 5 次留 1 次余量」。
 *    配置项的 `max` 也锁在 4——把它调大等于把余量吃掉，而症状是「号被封了」，
 *    没人会往「分条参数」上想。
 *
 * 2. **深夜系数乘在卡限之后，再卡一次限。** 顺序写反（先乘再卡一次）会让
 *    6000ms 的长消息在深夜**完全没有变化**——系数形同虚设，且日志里看不出。
 *
 * 3. **长停顿是独立分量，不并进 `delayMs`。** 3000–9000ms 的停顿大于
 *    `maxDelayMs=6000`，并进 `delayMs` 就会被上限压成 6000，长停顿永远发不出来。
 *
 * 4. **超限走「尾部合并」，不丢内容。** 合并后的第 4 条可能超过 40 字，
 *    此时标 `overflow` 而不是截断——**丢一句话比多发几个字严重得多**。
 *
 * 5. **自我修正默认关闭。** 手册原文「默认不自动插入」。它只能做**形态**上的
 *    自我修正（把一句话在逗号处断开、补一个「不对，」再说完），
 *    **不能真的改内容**——改内容需要知道「错在哪」，那是模型的事。
 *
 * 6. **本插件是纯函数。** 不注册定时器、不发消息、不读数据库、不写文件。
 *    计时执行归 O-039 `ondra-rhythm-typing`，呼吸感归 O-041 `ondra-breath`。
 *
 * 与其他插件的关系：本文件**不 import** 任何 `ondra-*` 源码（§18.5），
 * 上游形状全部用结构对位镜像。
 */

/** 本插件注册的服务键（连字符，非 `ondra:rhythm`）。全仓唯一归属。 */
export const RHYTHM_SERVICE_KEY = 'ondra-rhythm'

/** 命名硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 分条硬上限。手册 §9.2：「官方 QQ 5 次留 1 次余量」。**不许超过它**。 */
export const HARD_MAX_MESSAGES = 4

/* ------------------------------------------------------------------ *
 * 一、标点附加（手册给定值，不是自定值）
 * ------------------------------------------------------------------ */

/** 一类标点的附加停顿。 */
export interface PunctSpec {
  /** 类 id。 */
  readonly id: string
  /** 中文名（日志与面板用）。 */
  readonly label: string
  /** 属于这一类的字符。 */
  readonly chars: readonly string[]
  /** 每次出现附加多少毫秒。 */
  readonly ms: number
  /** 一句话说明。 */
  readonly doc: string
  /** 数字读数的量纲（天 / 分钟 / 毫秒 / 字 / 轮）。空表示无量纲。 */
  readonly unit?: string
}

/**
 * 标点附加表 —— **手册 §9.2 逐字**：
 * 「。！？ 各 300ms；……/—— 各 500ms；，； 各 150ms」。
 *
 * 只列手册点名的三个字符集，**不擅自把 `、` `：` 也加进来**：
 * 它们确实也该有停顿，但手册没给数，加进去就成了「本插件自定的第四类」。
 * 登记在 README「待裁决」，等主人一句话。
 */
export const PUNCT_SPECS: readonly PunctSpec[] = Object.freeze([
  Object.freeze({
    id: 'period',
    label: '句末',
    chars: Object.freeze(['。', '！', '？', '!', '?']),
    ms: 300,
    doc: '句末停顿。每出现一次算一次（「！？」算两次，那是两个语气）。',
  }),
  Object.freeze({
    id: 'ellipsis',
    label: '省略与破折',
    chars: Object.freeze(['…', '—']),
    ms: 500,
    doc: '「……」与「——」按**一串算一次**：连写四点是犹豫，不是两倍的犹豫。',
  }),
  Object.freeze({
    id: 'comma',
    label: '句中',
    chars: Object.freeze(['，', '；', ',', ';']),
    ms: 150,
    doc: '句中停顿。手册原文只有「，；」，顿号与冒号未列。',
  }),
])

/* ------------------------------------------------------------------ *
 * 二、分条
 * ------------------------------------------------------------------ */

/** 一条待发的消息。 */
export interface RhythmMessage {
  /** 序号，从 0 起。 */
  readonly index: number
  /** 正文（可能含尾部合并来的多句）。 */
  readonly text: string
  /** 去空白后的字数（字速按它算）。 */
  readonly chars: number
  /**
   * 发出这条之前的等待（毫秒）。
   *
   * 首条 = 首字延迟（800–2000，**不乘深夜系数**：那是「看到消息到开始打字」，
   * 不是「打字速度」）。其余 = 打字时间 + 标点附加，已卡限并乘过深夜系数。
   */
  readonly delayMs: number
  /** 长停顿（额外分量，0 = 没有）。整轮最多一条非零。 */
  readonly pauseMs: number
  /** 这条之前是否有长停顿。 */
  readonly longPause: boolean
  /** 这条是尾部合并来的（原条数超过上限）。 */
  readonly merged: boolean
  /** 这条超过单条上限。**只可能出现在尾部合并**，且绝不截断。 */
  readonly overflow: boolean
}

/** 一次分条的原始结果（未套条数上限）。 */
export interface SplitResult {
  /** 按单条上限装箱后的消息。 */
  readonly messages: readonly string[]
  /**
   * 句内切分次数：句子长到一条装不下时被拆开的次数。
   *
   * 含两种：在 `，、；：` 处拆（可读），与完全没标点时的**硬切**（会切在词中间）。
   * 原字段名 `hardCuts` 只说了后一种，会把「在逗号处拆」也算成硬切——
   * 那会让「硬切了多少次」这个指标永远偏高，看的人反而不再看它。
   */
  readonly innerSplits: number
}

/** 套条数上限的结果。 */
export interface CapResult {
  /** 最终消息。 */
  readonly messages: readonly string[]
  /** 被合并掉的条数（原条数 − 最终条数）。 */
  readonly mergedCount: number
  /** 超过单条上限的条数（0 或 1）。 */
  readonly overflowCount: number
}

/* ------------------------------------------------------------------ *
 * 三、自我修正
 * ------------------------------------------------------------------ */

/** 一次自我修正的形态描述。 */
export interface SelfCorrection {
  /** 被修正的那条在原数组里的下标。 */
  readonly index: number
  /** 原条被断开后的前半句（含断点标点）。 */
  readonly head: string
  /** 后半句（已去掉开头的标点）。 */
  readonly tail: string
  /** 用的哪个模板（三个之一）。 */
  readonly template: string
}

/* ------------------------------------------------------------------ *
 * 四、计划
 * ------------------------------------------------------------------ */

/** 计划的说明码。 */
export type RhythmNoteCode =
  /** 没有正文，不出计划。 */
  | 'no-text'
  /** 触发了尾部合并。 */
  | 'tail-merge'
  /** 合并后的第 4 条超过单条上限。 */
  | 'overflow'
  /** 处于深夜时段，停顿被放大。 */
  | 'night'
  /** 句形档调整了单条上限或条数。 */
  | 'shape'
  /** 语速被情绪增量调整。 */
  | 'rate'
  /** 做了一次自我修正。 */
  | 'self-correct'
  /** 插件被关闭，退回一次性整段发出。 */
  | 'disabled'

/** 一条说明。 */
export interface RhythmNote {
  readonly code: RhythmNoteCode
  readonly detail: string
}

/** 一次分条 + 停顿时序的完整计划。 */
export interface RhythmPlan {
  readonly messages: readonly RhythmMessage[]
  /** 整轮总时长（各条 `delayMs + pauseMs` 之和）。 */
  readonly totalMs: number
  /** 正文总字数。 */
  readonly chars: number
  /** 本次实际用的字速（字/秒）。 */
  readonly cps: number
  /** 本次实际生效的分条上限（≤ 4）。 */
  readonly maxMessages: number
  /** 本次实际生效的单条上限。 */
  readonly maxCharsPerMessage: number
  /** 是否处于深夜时段。 */
  readonly night: boolean
  /** 长停顿次数（0 或 1）。 */
  readonly longPauses: number
  /** 是否做了自我修正。 */
  readonly selfCorrected: boolean
  /** 被合并掉的条数。 */
  readonly mergedCount: number
  /** 超过单条上限的条数。 */
  readonly overflowCount: number
  readonly notes: readonly RhythmNote[]
}

/* ------------------------------------------------------------------ *
 * 五、入参
 * ------------------------------------------------------------------ */

/**
 * 情绪侧的表达档（镜像 O-031 `RhythmProfile` 的三项）。
 *
 * 刻意只取这三项：`volume` 是语音音量，`stickerChance` 是贴纸，
 * `proactiveQuotaDelta` 是主动额度——它们都不改变「分几条、每条多久」。
 */
export interface RhythmStyle {
  /** 语速增量（相对值，`+0.1` = 快一成）。 */
  readonly speechRateDelta?: number
  /** 语速档：`brisk` / `normal` / `slow`。 */
  readonly tempo?: string
  /** 句形档：`burst` / `medium` / `plain` / `long-single` / `clipped`。 */
  readonly sentenceShape?: string
}

/** 分条请求。 */
export interface RhythmRequest {
  /** 正文。 */
  readonly text: string
  /** 时刻（判深夜用），省略用系统时间。 */
  readonly at?: number
  /** 表达档；省略时自己问 O-031。 */
  readonly style?: RhythmStyle
  /** 随机源，注入以便复现。默认 `Math.random`。 */
  readonly rng?: () => number
}

/* ------------------------------------------------------------------ *
 * 六、服务
 * ------------------------------------------------------------------ */

/** 不可用原因（只有配置关闭这一种：本插件不依赖任何上游）。 */
export type RhythmUnavailableReason = 'disabled'

/** 统计快照。 */
export interface RhythmStats {
  /** 出过多少次计划。 */
  readonly turns: number
  /** 累计发出的条数。 */
  readonly messages: number
  /** 有多少轮触发过尾部合并。 */
  readonly cappedTurns: number
  /** 有多少轮的第 4 条超过单条上限。 */
  readonly overflowTurns: number
  /** 累计长停顿次数。 */
  readonly longPauses: number
  /** 累计自我修正次数。 */
  readonly selfCorrections: number
  /** 平均每轮条数（保留两位）。 */
  readonly avgMessages: number
  /** 平均每轮字数（保留两位）。 */
  readonly avgChars: number
}

/** 节奏服务。 */
export interface RhythmService {
  /** 是否启用（只看配置开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: RhythmUnavailableReason

  /** 分条硬上限（恒为 4，供调用方展示用）。 */
  readonly maxMessages: number

  /**
   * 出一次计划：分条 + 每条等待 + 长停顿 + （可选）自我修正。
   *
   * **永不抛出**：任何异常都退回「一次性整段发出」。
   */
  plan(request: RhythmRequest): RhythmPlan

  /** 只分条（不套条数上限、不算延迟）。面板与调试用。 */
  split(text: string, cap?: number): SplitResult

  /** 单条的打字时长（已卡限并乘深夜系数）。 */
  delayOf(text: string, at?: number): number

  /** 首字延迟（800–2000ms）。 */
  firstDelay(rng?: () => number): number

  /** 长停顿时长（3000–9000ms）。 */
  longPause(rng?: () => number): number

  /** 抽一次自我修正（不修改入参）。 */
  selfCorrect(text: string, rng?: () => number): SelfCorrection | undefined

  /** 统计快照。 */
  stats(): RhythmStats
}

/* ------------------------------------------------------------------ *
 * 七、上游与宿主的结构对位（§18.5：不 import 源码）
 * ------------------------------------------------------------------ */

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

/** O-031 的节奏档（只取影响分条与打字速度的三项）。 */
export interface RhythmProfileLike {
  readonly speechRateDelta?: number
  readonly tempo?: string
  readonly sentenceShape?: string
}

/** O-031 表达服务的结构对位子集。 */
export interface ExpressLike {
  readonly available: boolean
  rhythm(at?: number): RhythmProfileLike
}

/** O-003 时间服务的结构对位子集（判深夜用）。 */
export interface ClockLike {
  minuteOfDay(epoch?: number): number
  withinWindow(start: string, end: string, epoch?: number): boolean
}
