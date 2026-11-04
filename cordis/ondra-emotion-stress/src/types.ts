/**
 * O-029 `ondra-emotion-stress` 的对外契约。
 *
 * 定位：**只改权重，不改内容。**
 *
 * 手册 §3.8 原话：`weight = 原始相关度 × 注意力倍率 × 情绪共鸣微调`——
 * 「只改顺序不改内容」。这句话决定了本插件的三条边界：
 *
 * 1. **不砍任何一条**。倍率乘积再小也只是把某条排到最后，
 *    `dropped` 的类型写成字面量 `0`，接口上就写不出「丢掉几条」。
 *    这条与 O-014「召回不按条数砍」是同一条铁律的两次落地：
 *    「顾不上，不等于忘了」。
 * 2. **不判「哪条是危机类」**。危机 / 日常是条目自身的属性，
 *    由产出方（O-010 的类别、O-014 的检索结果）带着走。
 *    在本插件里再判一次，就会出现两套分类互相打架，
 *    而表现只是「排序怪怪的」，没有任何报错。
 * 3. **不编「情绪共鸣微调」的曲线**。手册只给了个乘法位，没给公式。
 *    所以 `resonance` 是**调用方传进来的系数**（默认 1），
 *    原样相乘，连 0 都照乘——不静默纠正调用方的数。
 *
 * ## 两套尺度照旧并存
 *
 * 皮质醇是 **0–100**（O-026 的化学池口径，基线 20、半衰期 30min）；
 * 倍率是**无量纲因子**（≥1 放大，≤1 缩小）。
 * 两者不换算：`cortisol / 100` 只出现在「阈值比较」一处，且当场说明。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。全仓唯一归属。 */
export const STRESS_SERVICE_KEY = 'ondra-emotion-stress'

/* ------------------------------------------------------------------ *
 * 三个锚点（手册 §3.8 的全部数值）
 * ------------------------------------------------------------------ */

/**
 * 三个锚点之间**线性插值**（手册 §3.8 表格第 2 行原话就是「线性插值」）。
 *
 * 一个实测得来的事实值得写在这里：三点**共线**。
 * 危机类 `(1 → 2 → 3)` 在 `40 → 60 → 80` 上的两段斜率都是 `0.05`；
 * 日常类 `(1 → 0.55 → 0.1)` 的两段斜率都是 `-0.0225`。
 * 所以「分段线性」与「一条直线夹紧」给出**完全相同**的结果，
 * 不存在「拐点处取哪一段」的歧义——这也是本插件敢把插值写死的理由。
 * 斜率不手写，全部由下面四个常量推导（改锚点即改斜率）。
 */

/** 平静上界：`≤ 40` 时两类倍率都是 ×1。 */
export const CALM_CEILING = 40

/** 危机下界：`≥ 80` 时危机类 ×3、日常类 ×0.1。 */
export const CRISIS_FLOOR = 80

/** 危机类在 `CRISIS_FLOOR` 处的倍率。 */
export const CRISIS_PEAK = 3

/** 日常类在 `CRISIS_FLOOR` 处的倍率。 */
export const DAILY_TROUGH = 0.1

/**
 * 皮质醇的缺省值：**取 O-026 的出厂基线 20，不取 0**。
 *
 * 取 0 会让「没读到情绪」看起来像「她极度平静」，也等于凭空调低日常类权重；
 * 取基线则两类倍率恰好都是 ×1（`1 + 0.05×(20−40)` 被夹到 1），
 * 即**不改变任何排序**——这是「读不到就什么都不做」的唯一正确写法。
 */
export const DEFAULT_CORTISOL = 20

/** 皮质醇的取值区间（0–100，O-026 口径）。 */
export const CORTISOL_MIN = 0
export const CORTISOL_MAX = 100

/* ------------------------------------------------------------------ *
 * 倍率与分档
 * ------------------------------------------------------------------ */

/** 条目类别。**由产出方带进来**，本插件不猜。 */
export type StressClass = 'crisis' | 'daily'

/**
 * 皮质醇分档，只用于面板与日志的可读性。
 *
 * 区间是**半开**的：`calm` 闭到 40、`mild` 到 60 之前、`alert` 到 80 之前、
 * `crisis` 从 80 起。正好落在 60 上时算 `alert`——那一格倍率恰好是
 * 手册表里「60 → ×2 / ×0.55」的数，档名与数值不矛盾。
 */
export type StressBand = 'calm' | 'mild' | 'alert' | 'crisis'

/** 分档中文名。只给面板与日志，**不进提示词**（内感受铁律：禁报数、禁命名）。 */
export const BAND_ZH: Readonly<Record<StressBand, string>> = Object.freeze({
  calm: '平静',
  mild: '微紧',
  alert: '警觉',
  crisis: '危机',
})

/** 倍率快照。 */
export interface StressMultiplier {
  /** 参与计算的皮质醇值（0–100，已夹紧）。 */
  readonly cortisol: number
  /** 分档。 */
  readonly band: StressBand
  /** 危机类倍率（≥1）。 */
  readonly crisis: number
  /** 日常类倍率（≤1）。 */
  readonly daily: number
  /** 皮质醇从哪来：情绪服务读数 / 调用方给值 / 出厂基线。 */
  readonly source: 'emotion' | 'caller' | 'baseline'
}

/** 一条待重排的条目。**只要求这三个字段**，其余字段原样透传。 */
export interface StressItem {
  /** 条目标识（只用于稳定排序与日志）。 */
  readonly id: string
  /** 原始相关度。**尺度归产出方**（BM25 分、余弦、权重都行），本插件只做乘法。 */
  readonly relevance: number
  /** 类别。 */
  readonly class: StressClass
  /**
   * 情绪共鸣微调系数，默认 1。
   *
   * 手册 §3.8 只给了「× 情绪共鸣微调」这五个字，没有曲线。
   * 曲线归情绪侧（O-026 / O-031），本插件只留乘法位。
   */
  readonly resonance?: number
}

/** 重排后的一条：原对象 + 两个派生字段。 */
export type StressRanked<T extends StressItem> = T & {
  /** 最终权重 = 相关度 × 类别倍率 × 共鸣系数。 */
  readonly weight: number
  /** 本次用的类别倍率（便于面板逐条解释）。 */
  readonly multiplier: number
}

/** 重排结果。 */
export interface StressRanking<T extends StressItem> {
  /** 已按 `weight` 降序、并列时保持原相对顺序的条目。 */
  readonly items: readonly StressRanked<T>[]
  /** 本次用的倍率快照。 */
  readonly multipliers: StressMultiplier
  /**
   * 被丢掉的条数，**恒为 0**（字面量类型）。
   *
   * 写成 `0` 而不是 `number`：这样「丢掉几条」在类型层面就说不出非零值，
   * 也就不可能有人顺手写一行 `slice(0, 10)` 再自圆其说。
   */
  readonly dropped: 0
}

/* ------------------------------------------------------------------ *
 * 提示词片段（器官 ABI §8.1）
 * ------------------------------------------------------------------ */

/**
 * 一条提示词片段（器官 ABI §8.1 的 `order / ttl / confidence` 三件套）。
 *
 * 字段名带单位（`ttlMinutes`）而不是裸 `ttl`：全仓的时间量一律带单位，
 * 否则「ttl: 30」是 30 秒还是 30 分钟要靠猜。**O-036（段装箱）接这段时按本形状取。**
 */
export interface PromptFragment {
  /** 排序键，**越小越靠前**。疤痕恒为 `-1e4`；器官不得低于 `-1000`。 */
  readonly order: number
  /** 存活时长（分钟）。到期由拼装方丢弃（本插件不装定时器）。 */
  readonly ttlMinutes: number
  /** 置信度 0–1。低置信片段由拼装方过滤。 */
  readonly confidence: number
  /** 片段正文。**不含任何数字**（内感受铁律 §4.3）。 */
  readonly text: string
  /** 片段种类，便于拼装方去重与调试。 */
  readonly kind: 'stress' | 'conflict'
}

/** 排序键的硬下限：`-1e4` 是疤痕专用，器官不许抢。 */
export const MIN_FRAGMENT_ORDER = -1000

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/** 不可用原因。**只有配置关掉**才算不可用（「没有情绪服务」是降级，不是没装）。 */
export type StressUnavailableReason = 'disabled'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface StressCounters {
  /** 取倍率次数。 */
  readonly multiplies: number
  /** 重排次数。 */
  readonly reweights: number
  /** 产出行为指令的次数（皮质醇越危机线时）。 */
  readonly directives: number
  /** 命中危机档的次数。 */
  readonly crisisSamples: number
}

/** 统计快照，供自检与成长面板（O-124）读取。 */
export interface StressStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: StressUnavailableReason
  /** 皮质醇来源：有情绪服务为 `emotion`，否则 `baseline`。 */
  readonly cortisolSource: 'emotion' | 'baseline'
  /** 最近一次读到的皮质醇（没读过为 -1）。 */
  readonly lastCortisol: number
  /** 最近一次的分档（没读过为 `undefined`）。 */
  readonly lastBand: StressBand | undefined
  /** 累计计数。 */
  readonly counters: StressCounters
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 应激倍率服务。 */
export interface StressService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: StressUnavailableReason

  /**
   * 取当前倍率。
   * @param cortisol 显式给的皮质醇；省略则读情绪服务，再不行取基线 20。
   * @param at 时刻，省略用系统时间。
   */
  multiplierOf(cortisol?: number, at?: number): StressMultiplier

  /**
   * 单条权重：`relevance × 类别倍率 × 共鸣系数`。
   * @param item 条目。
   * @param at 时刻。
   */
  weightOf(item: StressItem, at?: number): number

  /**
   * 重排：**只改顺序，不改内容**。
   * @param items 条目列表。
   * @param at 时刻。
   */
  reweight<T extends StressItem>(items: readonly T[], at?: number): StressRanking<T>

  /**
   * 皮质醇越过危机线时的行为指令（器官 ABI 片段）。
   * @param at 时刻。
   * @returns 未进危机档时为 `undefined`（**不返回空片段**：空片段会占掉一个拼装位）。
   */
  directive(at?: number): PromptFragment | undefined

  /**
   * 一句话解释当前倍率（面板用，**允许出现数字**）。
   * @param cortisol 显式给的皮质醇。
   */
  explain(cortisol?: number): string

  /** 统计快照。 */
  stats(): StressStats
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
 * **刻意只取 `state()`**：本插件是纯读方。把 `feel` / `setAxis` 也镜像进来，
 * 就等于给「顺手改一下情绪」留了门（C1：器官只提议，不落笔）。
 * 手册 §3.8 的「皮质醇 ≥80 时注入指令」也只需要读数。
 */
export interface EmotionLike {
  state(at?: number): { readonly hormones: Readonly<Record<string, number>> }
}
