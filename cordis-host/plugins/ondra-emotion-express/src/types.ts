/**
 * O-031 `ondra-emotion-express` 的对外契约。
 *
 * 定位：**情绪的六态 → 三处表达参数**。
 *
 * 手册 §3.2 原话：「状态→表达映射表（六态，**同接 prompt / rhythm / tts 三处**）」。
 * 这句话决定了本插件的三条边界：
 *
 * 1. **六态不许增删改名**。雀跃 / 软和 / 平静 / 蔫 / 炸毛 / 困 —— 这六个名字
 *    与官方宣传片 05 章展示的六个标签完全一致，是**公开承诺的口径**。
 *    所以 `ExpressState` 是一个闭合联合类型，`STATES` 是一个长度恒为 6 的元组，
 *    想加第七态必须先改手册与宣传片，而不是在这里 `| string`。
 *
 * 2. **只出参数，不出文本**。本插件**不产出任何提示词正文**。
 *    投影文本（「行为指令句 + 一条暗示」）唯一归 O-032 `ondra-emotion-project`。
 *    理由很硬：两段行为指令同时进提示词，模型会收到两组互相打架的说话要求，
 *    而它们都「看起来对」。一个文本出口，是这条链上唯一不会自相矛盾的形状。
 *
 * 3. **系数只在这里出现一次**。语速 ±10% / −15%、主动额度 ±1、不朗读、贴纸概率……
 *    全部集中在 `specs.ts` 的 `RHYTHM_SPECS` 一张表里。O-029（应激）与
 *    O-030（冲突）都刻意不写这些系数（它们的 README 里有明确的不做声明）。
 *    谁再抄一份，改参数时就会有一半地方不生效。
 *
 * ## 两套尺度的换算，只出现一次
 *
 * 手册 §3.2 的判据是混着写的：
 * - `mood > 0.7` —— mood 是 **0–1**（O-026 的 `axes.mood`）；
 * - `energy > 0.6` —— 但 energy 在 O-026 里是 **0–100**（§3.10 的 `energy > 80`）；
 * - `tension > 0.5` —— tension 是 **0–1**（O-026 的 `axes.tension`）。
 *
 * 所以 `energy > 0.6` 必须读成 **`energy > 60`**（把阈值乘 100，**不是把读数除以 100**）。
 * 这个换算只在 `specs.ts` 的 `energyRangeOf()` 旁边写一次，且当场注释。
 * 在别处再除一次 100，就会得到「她永远是困的」——因为 `60 / 100 = 0.6` 不满足 `> 0.6`。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。全仓唯一归属。 */
export const EXPRESS_SERVICE_KEY = 'ondra-emotion-express'

/* ------------------------------------------------------------------ *
 * 六态（闭合集合，不许增删改名）
 * ------------------------------------------------------------------ */

/**
 * 六态的顺序。
 *
 * 刻意取**手册 §3.2 的叙述顺序**（雀跃 → 软和 → 平静 → 蔫 → 炸毛 → 困），
 * 而不是宣传片里的展示顺序（平静 / 雀跃 / 困 / 蔫 / 软和 / 炸毛）。
 * 两者集合完全相同（手册已声明「完全一致」），只是排列不同；
 * 取手册顺序是因为判据表就在那一段，逐条对读时不容易串行。
 */
export const STATES = ['joyful', 'soft', 'calm', 'wilted', 'bristled', 'sleepy'] as const

/** 一个状态的名字。 */
export type ExpressState = (typeof STATES)[number]

/** 六态中文名。**只给面板与日志，绝不进提示词**（内感受铁律：禁命名，§4.3）。 */
export const STATE_ZH: Readonly<Record<ExpressState, string>> = Object.freeze({
  joyful: '雀跃',
  soft: '软和',
  calm: '平静',
  wilted: '蔫',
  bristled: '炸毛',
  sleepy: '困',
})

/* ------------------------------------------------------------------ *
 * 判据（数据化，改口径只改这张表）
 * ------------------------------------------------------------------ */

/**
 * 一个数值区间。
 *
 * 用四向开闭而不是 `[min, max]` 两个数：手册的边界是**混着开闭的**——
 * 「`mood > 0.7`」是开的，「`0.55 - 0.7`」是闭的。压成两个闭区间数，
 * 0.7 会同时命中「雀跃」与「软和」，两条判据打架而不报错。
 */
export interface NumericRange {
  /** 严格大于。 */
  readonly gt?: number
  /** 大于等于。 */
  readonly gte?: number
  /** 严格小于。 */
  readonly lt?: number
  /** 小于等于。 */
  readonly lte?: number
}

/** 一个状态的判据。三个维度都是可选的：只写手册给了的那几个。 */
export interface StateSpec {
  /** 状态名。 */
  readonly id: ExpressState
  /** 中文名（面板用）。 */
  readonly zh: string
  /**
   * 优先级，**越小越先判**。
   *
   * 手册没给优先级——它只列了六行判据，没说「同时满足两条时算哪个」。
   * 而这件事一定会发生：`tension > 0.5` 与 `mood < 0.35` 完全可能同时成立。
   * 本实现的排序与理由是：
   *   1. 炸毛（冲突语境下「不朗读 / 停主动」是硬约束，压过心情）
   *   2. 困（生理性，压过心情：再开心也打哈欠）
   *   3. 蔫（心情低）
   *   4. 雀跃（心情高且有劲）
   *   5. 软和（中间偏上）
   *   6. 平静（中性）
   */
  readonly priority: number
  /** 心情区间（0–1）。 */
  readonly mood?: NumericRange
  /** 能量区间（**0–100**）。 */
  readonly energy?: NumericRange
  /** 张力区间（0–1）。 */
  readonly tension?: NumericRange
}

/**
 * 六态判据表 —— **手册 §3.2 的逐字落地**。
 *
 * | 状态 | 手册原文判据 | 本表 |
 * |---|---|---|
 * | 雀跃 | `mood>0.7 且 energy>0.6` | mood>0.7 且 energy>60 |
 * | 软和 | `0.55-0.7` | 0.55 ≤ mood ≤ 0.7 |
 * | 平静 | `0.45-0.55` | 0.45 ≤ mood < 0.55 |
 * | 蔫 | `mood<0.35` | mood < 0.35 |
 * | 炸毛 | `tension>0.5` | tension > 0.5 |
 * | 困 | `energy<0.3` | energy < 30 |
 *
 * **0.35–0.45 是手册没给的空档**。本实现按「兜底取副作用最小的一档」处理：
 * mood ≥ 0.55 兜到软和，否则兜到平静；**绝不兜到蔫**——
 * 蔫会同时触发「语速 −15% / 音量低 / 额度 −1 / 长句一条说完」四项重副作用，
 * 把它给一段只是「略微偏低」的心情，用户看到的是「她忽然没精神了」。
 */
export const STATE_SPECS: Readonly<Record<ExpressState, StateSpec>> = Object.freeze({
  joyful: Object.freeze({
    id: 'joyful',
    zh: '雀跃',
    priority: 4,
    mood: Object.freeze({ gt: 0.7 }),
    energy: Object.freeze({ gt: 60 }),
  }),
  soft: Object.freeze({
    id: 'soft',
    zh: '软和',
    priority: 5,
    mood: Object.freeze({ gte: 0.55, lte: 0.7 }),
  }),
  calm: Object.freeze({
    id: 'calm',
    zh: '平静',
    priority: 6,
    // 上界写成 `< 0.55` 而不是 `<= 0.55`：0.55 归软和（软和的下界是闭的），
    // 两段不能同时含 0.55，否则又是「一格两判」。
    mood: Object.freeze({ gte: 0.45, lt: 0.55 }),
  }),
  wilted: Object.freeze({
    id: 'wilted',
    zh: '蔫',
    priority: 3,
    mood: Object.freeze({ lt: 0.35 }),
  }),
  bristled: Object.freeze({
    id: 'bristled',
    zh: '炸毛',
    priority: 1,
    tension: Object.freeze({ gt: 0.5 }),
  }),
  sleepy: Object.freeze({
    id: 'sleepy',
    zh: '困',
    priority: 2,
    // 手册 `energy < 0.3`，而 energy 是 0–100 → `< 30`。换算在 `specs.ts` 里只有一处。
    energy: Object.freeze({ lt: 30 }),
  }),
})

/* ------------------------------------------------------------------ *
 * 三处表达参数
 * ------------------------------------------------------------------ */

/** 语速档。手册给了数字的两档另有 `speechRateDelta`。 */
export type Tempo = 'brisk' | 'normal' | 'slow'

/** 音量档。手册写「音量低」，没给数字 → 只出档位，不出系数。 */
export type Volume = 'normal' | 'low'

/** 句形。 */
export type SentenceShape =
  /** 短句多 2–3 条。 */
  | 'burst'
  /** 中句。 */
  | 'medium'
  /** 平常。 */
  | 'plain'
  /** 长句一条说完。 */
  | 'long-single'
  /** 极短，常单字。 */
  | 'clipped'
  /** 短句含省略。 */
  | 'ellipsis'

/** 标点倾向。 */
export type Punctuation =
  /** ！～ 多。 */
  | 'exclaim'
  /** ？！ 多。 */
  | 'interrobang'
  /** 平常。 */
  | 'normal'
  /** 几乎不用强标点。 */
  | 'plain'

/** 语气词档。 */
export type ParticleLevel =
  /** 多（但**不扩库**，只用内核里已有的那几个）。 */
  | 'rich'
  /** 正常（呢、吧这类）。 */
  | 'normal'
  /** 稀疏（嗯、哦）。 */
  | 'sparse'
  /** 不用。 */
  | 'none'

/** 贴纸概率档。 */
export type StickerChance = 'high' | 'normal' | 'none'

/**
 * 一张**唯一**的表达系数表。
 *
 * `RhythmProfile` / `TtsProfile` / `PromptStyle` 全部由它 `Pick` 派生，
 * 不各存一份。这样「她说话快一点」这件事全仓只有一处数字。
 */
export interface RhythmSpec {
  /**
   * 语速增量（相对值，如 `+0.10` = 快一成）。
   *
   * **手册只给了两档数字**：雀跃 `+10%`、蔫 `−15%`。
   * 其余四档为 `undefined`——`undefined` 的意思是「手册没给数」，
   * 消费方应当**沿用引擎默认**，而不是理解成「不变」。
   * 困那一档手册只写了一个「慢」字，故走 `tempo: 'slow'`，不编百分比。
   */
  readonly speechRateDelta?: number
  /** 语速档。 */
  readonly tempo: Tempo
  /** 音量档。 */
  readonly volume: Volume
  /** 句形。 */
  readonly sentenceShape: SentenceShape
  /** 标点倾向。 */
  readonly punctuation: Punctuation
  /** 语气词档。 */
  readonly particles: ParticleLevel
  /** 贴纸概率档。 */
  readonly stickerChance: StickerChance
  /** 主动发言额度增量（±1）。 */
  readonly proactiveQuotaDelta: number
  /** 主动发言是否暂停（炸毛档）。 */
  readonly proactivePaused: boolean
  /** 是否朗读（炸毛档不朗读）。 */
  readonly readAloud: boolean
  /** 是否倾向静默（困档）。与 `readAloud` 不是一回事：静默是少说，不朗读是不出声。 */
  readonly silenceBias: boolean
}

/** 节奏侧参数（语音与文字节奏都用这一组）。 */
export type RhythmProfile = Pick<
  RhythmSpec,
  | 'speechRateDelta'
  | 'tempo'
  | 'volume'
  | 'sentenceShape'
  | 'punctuation'
  | 'particles'
  | 'stickerChance'
  | 'proactiveQuotaDelta'
  | 'proactivePaused'
  | 'silenceBias'
>

/** 语音合成侧参数。 */
export type TtsProfile = Pick<RhythmSpec, 'speechRateDelta' | 'tempo' | 'volume' | 'readAloud'>

/**
 * 提示词侧参数。
 *
 * **这里没有文本**。给的是「提示词该按哪种句形/语气词档/贴纸概率去写」，
 * 由 O-036（段装箱）或 O-032（投影文本）取用。
 */
export type PromptStyle = Pick<RhythmSpec, 'sentenceShape' | 'punctuation' | 'particles' | 'stickerChance'>

/* ------------------------------------------------------------------ *
 * 读数与结果
 * ------------------------------------------------------------------ */

/** 三个判据维度的输入。 */
export interface ExpressInput {
  /** 心情，0–1。 */
  readonly mood?: number
  /** 情绪能量，**0–100**。 */
  readonly energy?: number
  /** 张力，0–1。 */
  readonly tension?: number
}

/** 一个判定结果。 */
export interface ExpressView {
  /** 判定出的状态。 */
  readonly state: ExpressState
  /** 中文名（面板与日志用）。 */
  readonly zh: string
  /** 参与判定的心情（0–1）。 */
  readonly mood: number
  /** 参与判定的能量（0–100）。 */
  readonly energy: number
  /** 参与判定的张力（0–1）。 */
  readonly tension: number
  /** 数值从哪来。 */
  readonly source: 'emotion' | 'caller' | 'baseline'
  /**
   * 是否**命中显式判据**。
   *
   * `false` 表示落在手册没定义的 0.35–0.45 空档（或 mood>0.7 但能量不足的空档），
   * 由兜底规则落到了软和 / 平静。面板与日志要能看见这个区别——
   * 否则「我以为她平静，其实是被兜底了」永远查不出来。
   */
  readonly matched: boolean
}

/** 六态的完整表达档：一次判定，三处取用。 */
export interface ExpressProfile {
  /** 判定结果。 */
  readonly view: ExpressView
  /** 提示词侧参数。 */
  readonly prompt: PromptStyle
  /** 节奏侧参数。 */
  readonly rhythm: RhythmProfile
  /** 语音侧参数。 */
  readonly tts: TtsProfile
}

/** 不可用原因。**只有配置关掉**才算不可用（读不到情绪是降级，不是没装）。 */
export type ExpressUnavailableReason = 'disabled'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface ExpressCounters {
  /** 判定次数。 */
  readonly reads: number
  /** 取完整档次数。 */
  readonly profiles: number
  /** 读情绪服务时抛错的次数（已被护栏吞掉，不外抛）。 */
  readonly emotionErrors: number
}

/** 统计快照。 */
export interface ExpressStats {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ExpressUnavailableReason
  /** 数值来源：有情绪服务为 `emotion`，否则 `baseline`。 */
  readonly source: 'emotion' | 'baseline'
  /** 最近一次判定的状态（没判过为 `undefined`）。 */
  readonly lastState: ExpressState | undefined
  /** 最近一次是否命中显式判据。 */
  readonly lastMatched: boolean
  /** 累计计数。 */
  readonly counters: ExpressCounters
  /**
   * 最近一次判定**实际用了哪个阈值表**。
   *
   * 这一格补的是「装上不等于生效」：`ondra-persona-evolve` 算得出系数，
   * 而判定侧原先只读常量表。三件事必须并排看得见：
   *
   * | 读到什么 | 结论 |
   * | --- | --- |
   * | `asked: 0` | 漂移没接上（或人格演化未装）→ 判定用出厂值 |
   * | `applied` 有值 | 真的按相处时长换了判据 |
   * | `rejected` 有值 | 撞量程被挡回出厂值（**不是成功**，要看得见） |
   *
   * 只说 `available: true` 证明不了任何一条。
   */
  readonly drift: {
    /** 问过几条阈值。 */
    readonly asked: number
    /** 真的换掉的键（`state.dim`）。 */
    readonly applied: readonly string[]
    /** 被可达性护栏挡回的键与原因。 */
    readonly rejected: readonly { readonly key: string; readonly why: string }[]
    /** 一句人话（面板用）。 */
    readonly sentence: string
  }
  /**
   * **最近一次判定实际用了哪张表**。
   *
   * 与 `drift` 一起看才完整：
   * - `drift` 现算「这套系数会把判据漂到哪」；
   * - `lastDrift` 是判定路径**真的用上了**的证据。
   *
   * 只留前者时，把 `resolveState(axes, drifted.specs)` 改回
   * `resolveState(axes)`（判定退回常量表）它照样显示「已漂」——
   * 本仓第五次同族假绿，反向验证当场抓到。
   */
  readonly lastDrift: {
    readonly asked: number
    readonly applied: readonly string[]
    readonly rejected: readonly { readonly key: string; readonly why: string }[]
    readonly sentence: string
  }
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 六态表达服务。 */
export interface ExpressService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ExpressUnavailableReason

  /**
   * 判定当前状态。
   * @param at 时刻，省略用系统时间。
   */
  stateOf(at?: number): ExpressView

  /**
   * 纯判定：给三个数，出状态。**不读情绪服务**（面板/测试用）。
   * @param input 三个维度。
   */
  classify(input: ExpressInput): ExpressView

  /**
   * 取完整表达档（**推荐入口**：一次判定，三处取用，不会三段不一致）。
   * @param at 时刻。
   */
  profileOf(at?: number): ExpressProfile

  /** 提示词侧参数。 */
  prompt(at?: number): PromptStyle

  /** 节奏侧参数。 */
  rhythm(at?: number): RhythmProfile

  /** 语音侧参数。 */
  tts(at?: number): TtsProfile

  /**
   * 一句话解释（面板用，**允许出现数字**）。
   * @param at 时刻。
   */
  describe(at?: number): string

  /** 统计快照。 */
  stats(): ExpressStats
}

/* ------------------------------------------------------------------ *
 * 宿主相邻服务的结构对位（§18.5：不 import 源码）
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

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layer?: { readonly user?: Readonly<Record<string, unknown>> }):
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
}

/**
 * O-026 `ondra-emotion-core` 的结构对位子集。
 *
 * **刻意只取 `state()` 的 `axes`**：本插件是纯读方。
 * 把 `feel` / `setAxis` 也镜像进来，就等于给「顺手改一下情绪」留了门（C1）。
 */
export interface EmotionLike {
  state(at?: number): { readonly axes: Readonly<Record<string, number>> }
}

/**
 * O-130 `ondra-persona-evolve` 的结构对位子集（**只取一个方法**）。
 *
 * 只声明 `thresholdOf` 与 `available`：
 * - 不要 `interactions()`：那是关系域的计数，本插件不该有「顺便读一下次数」的能力，
 *   否则「阈值按几次算」会出现第二个来源；
 * - 不要 `explainThreshold()`：解释文案归它自己，这里只要那个数。
 *
 * 这正是 §18.5「不 import 邻居源码，只用结构对位」的用法。
 */
export interface EvolveLike {
  /** 是否可用（配置关掉时为 false，此时不漂）。 */
  readonly available: boolean
  /** 阈值漂移：`base × (1 + 0.6 × min(1, n/5000))`。 */
  thresholdOf(key: string, base: number): number
}
