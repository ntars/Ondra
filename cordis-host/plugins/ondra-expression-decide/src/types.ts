/**
 * O-052 `ondra-expression-decide` 的对外契约。
 *
 * 定位：**「这句话说出口时，脸上该是什么」的唯一判定处**。规则版，不调模型。
 *
 * ## 为什么方向是「正文 → 表情」，不是「情绪 → 表情」
 *
 * 「情绪 → 表情」已经有人做了：O-031 `ondra-emotion-express` 把六维数值
 * 判成六态，给 prompt / rhythm / tts 三处取用。若本插件再来一次，
 * 同一张脸就有两个来源，而两处都不报错。
 *
 * 手册第 1965 行把这条链写成「情绪 → 表情/动作，Ondra 的 `expression-decide`
 * + `avatar` 正是这个」——但那句话讲的是**生态里缺什么**（B 站的
 * SoullinkEmotion3D 做的是 VAD → FACS 连续演绎），不是说本插件要把六态再判一遍。
 *
 * 正文才是"她真的说了什么"。她可以在心里平静、嘴上阴阳，反过来也成立
 * （紧张但硬撑着说漂亮话）。脸上跟**说出口的话**走，才不会出现
 * 「嘴上在笑、脸上在哭」——那是比"表情不跟情绪"更伤的一类出戏。
 * 所以：
 *
 * - **正文有线索** → 按线索出标记，`source: 'text'`，可以驱动换脸；
 * - **正文没线索** → 回落到当前六态，`source: 'state'`，脸上**不该动**；
 * - **两者都没有** → `source: 'default'`，给一个最不容易出错的表情，
 *   并且让调用方看得见「这次没有依据」。
 *
 * ## 「标记」是结构化数据，不是字符串
 *
 * 手册 §4.3 内感受铁律：**禁止命名、禁止报数**，提示词里不许出现
 * 「雀跃 / 蔫」这些词，也不许出现 0–1 的数字。
 * 所以本插件**不往正文里插任何标记，也不往提示词写任何状态名**——
 * 那两件事一旦做了，就是把"六态"这个内部词汇泄进她要说的话里。
 * `ExpressionMark` 只交给显示层（O-054 立绘）与面板。
 *
 * ## 六态是闭集，但真源不在本文件
 *
 * `EXPRESS_STATES` 是 O-031 那六个名字的**结构对位**（§18.5 不许 import 源码）。
 * 上游若加第七态，本插件不猜、不硬映射，直接把 `degraded` 标成
 * `unknown-state` 并退回默认表情——静默映射到「平静」才是最坏的结果，
 * 因为面板上一切正常，只有她的脸不对。
 */

/** 本插件注册的服务键（连字符，非 `ondra:expression-decide`）。全仓唯一归属。 */
export const DECIDE_SERVICE_KEY = 'ondra-expression-decide'

/** 服务键 / 工具名 / 配置键的硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 六态（闭合集合）—— O-031 `STATES` 的结构对位，**顺序也照抄**。
 *
 * 手册 §3.2：六态与官方宣传片 05 章的六个标签完全一致，是公开承诺口径，
 * 不得增删改名。本文件这一行是"契约的影子"，不是第二真源：
 * 真源在 O-031，任何增删都必须先改手册与宣传片。
 */
export const EXPRESS_STATES = ['joyful', 'soft', 'calm', 'wilted', 'bristled', 'sleepy'] as const

/** 一个状态的名字。 */
export type ExpressionState = (typeof EXPRESS_STATES)[number]

/**
 * 判一个名字是不是六态之一。
 *
 * 用途只有一个：上游（O-031）回了一个名字时，先在这里验一遍。
 * **不能省这一步**——上游若加了第七态，本插件会拿到一个不认识的字符串，
 * 若直接透传给显示层，症状是「立绘找不到了」，而日志里一切正常。
 * @param value 待验的值。
 */
export function isExpressionState(value: unknown): value is ExpressionState {
  return typeof value === 'string' && (EXPRESS_STATES as readonly string[]).includes(value)
}

/** 六态中文名。**只给面板与日志，绝不进正文也绝不进提示词**（§4.3）。 */
export const STATE_ZH: Readonly<Record<ExpressionState, string>> = Object.freeze({
  joyful: '雀跃',
  soft: '软和',
  calm: '平静',
  wilted: '蔫',
  bristled: '炸毛',
  sleepy: '困',
})

/**
 * 判定用的优先级（与 O-031 `STATE_SPECS.priority` 同序）。
 *
 * 手册没写「同时满足两条时算哪个」，但这件事一定会发生
 * （「太好了，不过算了……」同时有雀跃词与蔫词）。
 * 沿用 O-031 的顺序，是为了让"同一组读数"在两处得到同一个答案：
 * 炸毛压过一切（冲突语境下表情是硬约束）、困次之（生理性）、蔫再次。
 */
export const STATE_PRIORITY: readonly ExpressionState[] = Object.freeze([
  'bristled',
  'sleepy',
  'wilted',
  'joyful',
  'soft',
  'calm',
])

/** 标记的来源。**消费方靠它决定要不要换脸**。 */
export type MarkSource =
  /** 正文里有线索，可以驱动换脸。 */
  | 'text'
  /** 正文无线索，跟当前六态走 —— 脸上不该动。 */
  | 'state'
  /** 既无线索也拿不到六态，退回配置里的默认表情。 */
  | 'default'

/** 线索的种类。 */
export type CueKind =
  /** 词（强 / 中两档）。 */
  | 'word'
  /** 标点。 */
  | 'punct'
  /** 句形（长度、有没有标点）。 */
  | 'shape'

/** 一条线索。**给人看的**：面板要能回答「为什么判成炸毛」。 */
export interface ExpressionCue {
  /** 种类。 */
  readonly kind: CueKind
  /** 指向哪个态。 */
  readonly state: ExpressionState
  /** 权重（强词 3 / 中词 2 / 标点 1–3 / 句形 1）。 */
  readonly weight: number
  /** 命中的原文片段（词本身，或标点本身）。句形线索用一句说明。 */
  readonly cue: string
}

/** 一条正文的表情标记。**不可变**。 */
export interface ExpressionMark {
  /** 这一条在整轮里的序号（从 0 起）。 */
  readonly index: number
  /** 判出来的表情。 */
  readonly state: ExpressionState
  /** 来源。`text` 才建议换脸。 */
  readonly source: MarkSource
  /** 文本线索总分（0 表示一条都没命中）。 */
  readonly score: number
  /** 第二名的态与分数。并列时用来说明「为什么不是它」。 */
  readonly runnerUp?: { readonly state: ExpressionState; readonly score: number }
  /** 命中的全部线索（按权重降序）。 */
  readonly cues: readonly ExpressionCue[]
  /** 去空白后的字数（句形线索的依据，也是面板要显示的那个数）。 */
  readonly chars: number
}

/** 整轮的降级说明。 */
export type DegradedCode =
  /** O-031 本体缺席。 */
  | 'no-express'
  /** O-031 在位，但给了一个本插件不认识的态名（上游加了第七态）。 */
  | 'unknown-state'
  /** 整轮一条线索都没命中，所有标记都来自 `state` / `default`。 */
  | 'no-cues'

/** 整轮的表情结论。 */
export interface TurnExpression {
  /** 逐条标记，与入参一一对应（顺序一致）。 */
  readonly marks: readonly ExpressionMark[]
  /**
   * 这一轮脸上最后该是哪个态。
   *
   * 规则：**累计文本分最高**的那个；并列时取**最后一条**的态
   * （一轮说完，脸上停住的是最后那个表情）。
   * 整轮都没有文本线索时，等于最后一条的 `state`。
   */
  readonly dominant: ExpressionState
  /** 本轮降级情况。空数组表示全部按正文线索判出。 */
  readonly degraded: readonly DegradedCode[]
  /** 判定时刻。 */
  readonly at: number
}

/** 不可用原因。**只有开关关掉**才算不可用（读不到六态是降级，不是没装）。 */
export type DecideUnavailableReason = 'disabled'

/** 判定入参。 */
export interface DecideOptions {
  /** 这一条在整轮里的序号。省略按 0。 */
  readonly index?: number
  /** 时刻，省略用 `clock.now()`。 */
  readonly at?: number
  /**
   * 直接给当前六态（跳过读 O-031）。
   *
   * 给整轮用：`decideTurn(texts, { state })` 只读一次六态，
   * 而不是每条都去问一遍——一轮里她的状态不会变三次。
   */
  readonly state?: ExpressionState
}

/** 统计快照（**只在内存**，进程重启归零）。 */
export interface ExpressionStats {
  /** 判定过的条数。 */
  readonly reads: number
  /** 判定过的轮数。 */
  readonly turns: number
  /** 按来源分桶。 */
  readonly bySource: Readonly<Record<MarkSource, number>>
  /** 命中的线索总条数。 */
  readonly cues: number
  /** 按态分桶（`text` 来源的才计）。 */
  readonly byState: Readonly<Partial<Record<ExpressionState, number>>>
  /** 最近一次的态。 */
  readonly lastState?: ExpressionState
  /** 最近一次的来源。 */
  readonly lastSource?: MarkSource
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 表情判定服务。 */
export interface ExpressionService {
  /** 是否可用：开关打开即可用（缺六态只是降级，不是不可用）。 */
  readonly available: boolean
  /** 不可用的唯一原因。 */
  readonly reason?: DecideUnavailableReason

  /**
   * 判一条正文。**不读也不写任何人的状态**（纯函数 + 一次可选的六态读取）。
   * @param text 这一条的正文。
   * @param options 入参。
   */
  decide(text: string, options?: DecideOptions): ExpressionMark

  /**
   * 判一整轮（分条后的正文数组）。**推荐入口**：只读一次六态，顺带给出 `dominant`。
   * @param texts 每一句正文。
   * @param options 入参。
   */
  decideTurn(texts: readonly string[], options?: DecideOptions): TurnExpression

  /** 读数。 */
  stats(): ExpressionStats
}

/* ------------------------------------------------------------------ *
 * 相邻服务的结构对位（§18.5：不 import 源码，只按形状取）
 * ------------------------------------------------------------------ */

/** 日志器。 */
export interface LogLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** O-003 时间服务的子集。 */
export interface ClockLike {
  now(): number
}

/** O-001 身份服务的子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/**
 * O-031 六态判定的子集。
 *
 * 只取 `stateOf()` 的 `state`：本插件不需要 `prompt` / `rhythm` / `tts`
 * 三处参数（那是 O-031 的出口），只要那一个名字。
 * 也**不用 `profileOf()`**：它会顺手把三份参数都算出来，
 * 而这里一个字都用不上——叫一次 `stateOf()` 就够。
 */
export interface ExpressLike {
  stateOf?(at?: number): { readonly state: string } | undefined
}

/** 字段声明（与 O-005 对位）。 */
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

/** O-005 段声明。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}
