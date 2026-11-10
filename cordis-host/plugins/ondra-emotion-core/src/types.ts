/**
 * O-026 `ondra-emotion-core` 的对外契约。
 *
 * 定位：**情绪的持有者，不是情绪的表达者**。
 *
 * 四件必须先说清的事：
 *
 * 1. **本插件只管「她此刻是什么状态」，不管「这个状态该怎么说」。**
 *    六态映射（雀跃/软和/平静/蔫/炸毛/困）归 O-031，应激注意力倍率归 O-029，
 *    冲突锁的行为后果归 O-030。下游一律经服务键取快照，本插件不 import 任何下游。
 *
 * 2. **两套尺度并存，是手册原口径，不是笔误。**
 *    PAD 轴与 10 个标签用 **0–1**（手册 §3.2：单条上限 0.12、标签上限 0.6）；
 *    激素与能量用 **0–100**（手册 §3.9/§3.10：dopamine 基线 50、cortisol ≥70、
 *    energy >80、serotonin ceiling 100）。
 *    两套数值**不互相换算**——一换算就会出现「0.5 到底是中性还是半满」这种歧义。
 *    想拿 0–1 的读法，用 `snapshot.normalized`，那是**派生视图**，不存第二份。
 *
 * 3. **「六维」= PAD 三轴 + 心情 + 能量 + 张力。**
 *    台账只写了「六维指数回归」，没逐项列名。本实现按手册全文出现过的、
 *    属于情绪域的六个状态量取定（P/A/D 见 §3.2，mood 见 §3.2 心情半衰期 6h，
 *    energy 见 §3.10「emotion-core 的 energy 是情绪维度，不是体力」，
 *    tension 见 §3.2 冲突锁与 §3.8）。若口径有变，只改 `AXES` 一处。
 *
 * 4. **存档缺字段按基线补，不按 0 补。**
 *    手册 §3.2 原话：「0 在界面上等于'极度烦躁'，那是伪造情绪」。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const EMOTION_SERVICE_KEY = 'ondra-emotion-core'

/* ------------------------------------------------------------------ *
 * 六个维度
 * ------------------------------------------------------------------ */

/** 六维。顺序即结算顺序，也是快照里的字段顺序。 */
export const AXES = ['pleasure', 'arousal', 'dominance', 'mood', 'energy', 'tension'] as const

/** 一个维度的名字。 */
export type Axis = (typeof AXES)[number]

/**
 * 各维度的取值范围与基线。
 *
 * `energy` 是 0–100 而其余是 0–1，看着别扭，但这是手册的口径：
 * §3.10 的血清素 recover 规则写的是 `energy > 80`，若内部改成 0–1，
 * 这条规则就变成 `> 0.8`，日后对拍手册时每次都要心算一次除法。
 */
export const AXIS_SPEC: Readonly<Record<Axis, { readonly min: number; readonly max: number; readonly baseline: number }>> =
  Object.freeze({
    /** 愉悦度。0 极不悦 / 0.5 中性 / 1 极愉悦。 */
    pleasure: Object.freeze({ min: 0, max: 1, baseline: 0.5 }),
    /** 唤醒度。0 昏昏欲睡 / 1 紧绷。 */
    arousal: Object.freeze({ min: 0, max: 1, baseline: 0.45 }),
    /** 支配感。0 全然无力 / 1 游刃有余。 */
    dominance: Object.freeze({ min: 0, max: 1, baseline: 0.5 }),
    /** 心情：比 PAD 慢得多的底色，半衰期 6 小时（§3.2）。 */
    mood: Object.freeze({ min: 0, max: 1, baseline: 0.5 }),
    /** 情绪能量：不是体力，是「还提不提得起劲」（§3.10 末句）。0–100。 */
    energy: Object.freeze({ min: 0, max: 100, baseline: 60 }),
    /** 张力：冲突锁的燃料（§3.2 冲突锁定）。0–1。 */
    tension: Object.freeze({ min: 0, max: 1, baseline: 0 }),
  })

/* ------------------------------------------------------------------ *
 * 10 个固定标签
 * ------------------------------------------------------------------ */

/**
 * 10 个固定标签（手册 §3.2 / §3.12）。
 *
 * **不许增删改名**：这十个是产品口径，宣传片 05 章的六态是从它们映射来的。
 * 想加情绪，走动态激素（`inflict`）或者等人改手册，不要在标签表上开口子。
 */
export const LABELS = ['joy', 'anger', 'sadness', 'fear', 'hurt', 'shy', 'proud', 'moved', 'anxiety', 'bored'] as const

/** 一个标签的名字。 */
export type Label = (typeof LABELS)[number]

/** 标签中文名。只给日志与面板用，**不进提示词**（提示词归 O-031/O-032）。 */
export const LABEL_ZH: Readonly<Record<Label, string>> = Object.freeze({
  joy: '开心',
  anger: '生气',
  sadness: '难过',
  fear: '害怕',
  hurt: '委屈',
  shy: '害羞',
  proud: '得意',
  moved: '感动',
  anxiety: '焦虑',
  bored: '无聊',
})

/** 标签值上限（§3.2）。超过这个值，情绪就不再是「一点」，而是「整个人被占满」。 */
export const LABEL_MAX = 0.6

/** 标签半衰期（分钟，§3.2）。 */
export const LABEL_HALF_LIFE_MINUTES = 45

/* ------------------------------------------------------------------ *
 * 化学池
 * ------------------------------------------------------------------ */

/** 三种出厂激素（§3.9 实读 `genome.json`）。 */
export const CORE_HORMONES = ['dopamine', 'cortisol', 'serotonin'] as const

/** 一种出厂激素的名字。 */
export type CoreHormone = (typeof CORE_HORMONES)[number]

/** 激素参数：基线、半衰期。 */
export interface HormoneSpec {
  /** 静息水平，0–100。 */
  readonly baseline: number
  /** 半衰期（分钟）。回到「离基线一半」所需的时间。 */
  readonly halfLifeMinutes: number
}

/**
 * 出厂激素参数表 —— **三种激素的唯一真源**。
 *
 * 手册 §3.9 是实读别的项目的 `genome.json` 得到的，不是估算值：
 * dopamine 50/45min、cortisol 20/30min、serotonin 50/120min。
 */
export const CORE_HORMONE_SPEC: Readonly<Record<CoreHormone, HormoneSpec>> = Object.freeze({
  dopamine: Object.freeze({ baseline: 50, halfLifeMinutes: 45 }),
  cortisol: Object.freeze({ baseline: 20, halfLifeMinutes: 30 }),
  serotonin: Object.freeze({ baseline: 50, halfLifeMinutes: 120 }),
})

/** 动态激素的通用参数（§3.9）。 */
export const DYNAMIC_HORMONE_SPEC: HormoneSpec = Object.freeze({ baseline: 50, halfLifeMinutes: 30 })

/** 动态激素种数上限（§3.9：「不是怕她造，是不接受每有一点心事就发明一种情绪」）。 */
export const MAX_DYNAMIC_HORMONES = 12

/** 血清素慢变量的阈值（§3.9）。 */
export const SEROTONIN_STRESS_THRESHOLD = 70
/** 应激时血清素每分钟的抽水量（§3.9）。 */
export const SEROTONIN_STRESS_RATE = -1.5
/** 恢复时血清素每分钟的补充量（§3.9）。 */
export const SEROTONIN_RECOVER_RATE = 0.8
/** 恢复的必要条件之一：能量高于此值（§3.9）。 */
export const SEROTONIN_RECOVER_ENERGY = 80
/** 恢复的必要条件之二：没有张力达到此值的执念（§3.9）。 */
export const SEROTONIN_RECOVER_TENSION = 0.7

/* ------------------------------------------------------------------ *
 * 气质四旋钮
 * ------------------------------------------------------------------ */

/**
 * 气质四旋钮（§3.9）。
 *
 * 这是「出厂基线 + 表达倾向」里属于情绪的那一半（§3.1 人格生成论）。
 * 它**不是**人设正文，人设包换人时这四个数可以跟着换，但本插件不认识人设包——
 * 谁写进来就是谁的，本插件只负责按它算。
 */
export interface Temperament {
  /** 敏感度 0.5–2.0：受刺激时皮质醇的飙升乘数。越大越容易上头。 */
  readonly sensitivity: number
  /** 恢复力 0.5–2.0：半衰期乘数，**越大恢复越快**（内部按 `halfLife / resilience` 算）。 */
  readonly resilience: number
  /** 热情 20–80：多巴胺的出厂基线。越大越容易开心。 */
  readonly enthusiasm: number
  /** 代谢 0.5–2.0：慢变量（血清素抽水/回充）的速率乘数。越大情绪转得越快。 */
  readonly metabolism: number
}

/** 出厂气质。四个 1.0 / 50 就是「不偏不倚」，与手册的出厂基线一一对应。 */
export const DEFAULT_TEMPERAMENT: Temperament = Object.freeze({
  sensitivity: 1,
  resilience: 1,
  enthusiasm: 50,
  metabolism: 1,
})

/* ------------------------------------------------------------------ *
 * 输入与快照
 * ------------------------------------------------------------------ */

/**
 * 一次「情绪事件」：一句话、一件事、一个动作，让她产生反应。
 *
 * 每个字段都是**增量**，不是绝对值。绝对值只走 `setAxis()`——
 * 那是给剧本/调试用的，日常不该用它。
 */
export interface FeelingInput {
  /** 愉悦度增量，-1–1 的意图值，实际会先乘 0.12 上限再夹紧。 */
  readonly pleasure?: number
  /** 唤醒度增量。 */
  readonly arousal?: number
  /** 支配感增量。 */
  readonly dominance?: number
  /** 心情增量。同样的意图值，落到 mood 上会被压得更小（心情比心情绪慢）。 */
  readonly mood?: number
  /** 能量增量（0–100 绝对值写法，正负皆可）。 */
  readonly energy?: number
  /** 张力增量。 */
  readonly tension?: number
  /** 标签增量，意图值 0–1，实际乘 0.12 上限后夹到 0.6。 */
  readonly labels?: Partial<Record<Label, number>>
  /** 激素增量，0–100 绝对值写法（如被骂 → `cortisol: +20`）。 */
  readonly hormones?: Partial<Record<string, number>>
  /** 事件来源，只用于记账与排查，不参与计算。 */
  readonly source?: string
}

/**
 * 一次结算后的情绪快照。
 *
 * **不可变**：下游要改状态必须回调 `feel()` / `setAxis()`，
 * 不能拿着快照改字段——那会让「谁改的」在排查时彻底断线。
 */
export interface EmotionSnapshot {
  /** 结算时刻。 */
  readonly at: number
  /** 六维当前值。 */
  readonly axes: Readonly<Record<Axis, number>>
  /** 10 个标签当前值（0–0.6）。 */
  readonly labels: Readonly<Record<Label, number>>
  /** 全部激素当前值（含动态，0–100）。 */
  readonly hormones: Readonly<Record<string, number>>
  /** 当前气质。 */
  readonly temperament: Temperament
  /**
   * 派生视图：把 0–100 的量除以 100，凑成清一色 0–1。
   *
   * 刻意**只做除法**，不做任何重标定——`energy: 60` → `0.6` 是给人看的，
   * 不是另一套语义。
   */
  readonly normalized: Readonly<Record<Axis, number>>
  /** 当前最强的那一个标签（全为 0 时为 `undefined`）。面板与调试用。 */
  readonly dominant: Label | undefined
  /**
   * 张力是否偏高（`tension > tensionHighThreshold`，默认 0.5）。
   *
   * **这不是冲突锁**。锁的建立、维持与解除归 O-030；本插件只回答手册 §3.2
   * 六态映射里「炸毛」的判据过没过线。把它当锁用，就会出现
   * 「两个插件各锁各的、谁也不解」的死结。
   */
  readonly tensionHigh: boolean
}

/** 不可用原因。 */
export type EmotionUnavailableReason =
  /** 存储端口缺席（能算，但存档不落地，重启归零）。 */
  | 'no-store'
  /** 建表失败。 */
  | 'schema-failed'
  /** 配置里关掉了。 */
  | 'disabled'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface EmotionCounters {
  /** 结算次数。 */
  readonly settles: number
  /** 收到的事件次数。 */
  readonly feelings: number
  /** 被安慰次数。 */
  readonly comforts: number
  /** 动态激素创建次数。 */
  readonly inflicted: number
  /** 存档次数。 */
  readonly saves: number
  /** 皮质醇越过应激阈值的次数（每次跨越会让血清素一次性多扣一点）。 */
  readonly crossings: number
}

/** 统计快照，供自检与成长面板读取。 */
export interface EmotionStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: EmotionUnavailableReason
  /** 存储后端标识（无存储时为 `none`）。 */
  readonly storeProvider: string
  /** 当前动态激素种数。 */
  readonly dynamicHormones: number
  /** 最近一次结算的时刻（0 表示还没结算过）。 */
  readonly lastSettleAt: number
  /** 最近一次存档的时刻（0 表示还没存过）。 */
  readonly lastSaveAt: number
  /** 累计计数。 */
  readonly counters: EmotionCounters
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 情绪服务。 */
export interface EmotionService {
  /** 是否可用。没有存储时仍然可用（内存态），只是重启会丢。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: EmotionUnavailableReason

  /**
   * 取当前状态（内部先做一次惰性结算）。
   * @param at 时刻，省略用系统时间。
   */
  state(at?: number): EmotionSnapshot

  /**
   * 收到一次情绪事件。
   * @param input 增量。
   * @param at 时刻。
   */
  feel(input: FeelingInput, at?: number): EmotionSnapshot

  /**
   * 被安慰：道歉、抱歉、哄。
   *
   * **只降 0.08**（§3.2），刻意保留一点「嘴硬」——
   * 一句「对不起」就把情绪清零，那不是人，那是开关。
   * @param at 时刻。
   */
  comfort(at?: number): EmotionSnapshot

  /**
   * 直接设定某一维（剧本/调试/迁移用，**日常不该用**）。
   * @param axis 维度。
   * @param value 目标值。
   * @param at 时刻。
   */
  setAxis(axis: Axis, value: number, at?: number): EmotionSnapshot

  /**
   * 现场造一种激素（§3.9 `ctx.inflict('ao', +5)`）。
   *
   * 超过 12 种时**拒绝新增**（但已有激素的增减照常生效）。
   * @param name 激素名，须匹配 `^[a-z][a-z0-9_-]{1,23}$`。
   * @param delta 增量。
   * @param at 时刻。
   * @returns 是否成功增量（被上限拒绝且是新名字时为 false）。
   */
  inflict(name: string, delta: number, at?: number): boolean

  /**
   * 改气质四旋钮（越界值会被夹紧，不报错）。
   * @param patch 要改的旋钮。
   * @param at 时刻。
   */
  setTemperament(patch: Partial<Temperament>, at?: number): Temperament

  /** 取当前气质。 */
  temperament(): Temperament

  /**
   * 落盘。
   *
   * **不自动触发**：存档时机由回合边界/夜巡决定（与 O-013 同一条纪律：
   * 写操作不交给「不知道第几个装载」的定时器）。
   * @param at 时刻。
   */
  save(at?: number): boolean

  /**
   * 从存档恢复。
   *
   * 缺字段**按基线补，不按 0 补**（§3.2）。
   * @param at 时刻。
   */
  load(at?: number): EmotionSnapshot

  /** 统计快照。 */
  stats(): EmotionStats
}

/** 错误码。 */
export type EmotionErrorCode = 'bad-request' | 'too-many-hormones' | 'write-failed' | 'read-failed'

/** 情绪内核错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class EmotionError extends Error {
  /** 错误码。 */
  readonly code: EmotionErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: EmotionErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'EmotionError'
    this.code = code
    this.detail = detail
  }
}

/* ------------------------------------------------------------------ *
 * 宿主相邻服务的结构对位（§18.5：不 import 源码）
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

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
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

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位（只够建一张状态表）
 * ------------------------------------------------------------------ */

/** 列类型。 */
export type ColumnTypeLike = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'

/** 列声明。 */
export interface ColumnSpecLike {
  readonly name: string
  readonly type: ColumnTypeLike
  readonly notNull?: boolean
  readonly primaryKey?: boolean
  readonly default?: string
}

/** 索引声明。 */
export interface IndexSpecLike {
  readonly name: string
  readonly columns: readonly string[]
  readonly unique?: boolean
}

/** 表声明。 */
export interface TableSpecLike {
  readonly name: string
  readonly columns: readonly ColumnSpecLike[]
  readonly indexes?: readonly IndexSpecLike[]
  readonly strict?: boolean
}

/** 一行数据。 */
export type RowLike = Record<string, unknown>

/** 过滤算子。 */
export type FilterOpLike = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'is-null' | 'not-null'

/** 过滤条件。 */
export interface FilterLike {
  readonly column: string
  readonly op: FilterOpLike
  readonly value?: unknown
}

/** 查询条件。 */
export interface SelectQueryLike {
  readonly where?: readonly FilterLike[]
  readonly orderBy?: readonly { readonly column: string; readonly direction?: 'asc' | 'desc' }[]
  readonly limit?: number
  readonly offset?: number
}

/** 存储端口的结构对位子集。 */
export interface StoreLike {
  readonly provider: string
  readonly state: string
  readonly caps: {
    readonly sql: boolean
    readonly fts: boolean
    readonly persist: boolean
    readonly transaction: boolean
  }
  ensureTable(spec: TableSpecLike): {
    readonly table: string
    readonly created: boolean
    readonly issues: readonly { readonly code: string; readonly detail: string }[]
  }
  tableExists(table: string): boolean
  insert(table: string, row: RowLike): void
  upsert(table: string, row: RowLike): void
  select(table: string, query?: SelectQueryLike): RowLike[]
  count(table: string, where?: readonly FilterLike[]): number
  update(table: string, key: RowLike, patch: RowLike): number
  delete(table: string, key: RowLike): number
}
