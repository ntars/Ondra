/**
 * O-123 `ondra-emotion-hormone` 的对外契约（〔研〕自研，默认关闭）。
 *
 * ## 一句话
 *
 * **把激素层读出来，叠成一份「只读解释」，一个字节都不写回情绪。**
 *
 * ## 为什么这一项必须自研
 *
 * 手册 §14.3 把情绪维度写成一排多方案：核心三维为底座，激素做可选插件，
 * 效价-唤醒二维做展示层派生。三套东西同时存在，最容易出的事故是
 * **「第二套情绪模型」**——每个插件都自己算一遍 mood，界面上出现两个心情值，
 * 谁也说不清哪个是真的。本插件存在的全部意义就是：**只读、只解释、不产数值真源**。
 *
 * ## 与 O-026 的边界（三条，全部可验证）
 *
 * 1. **不持有任何激素状态**。`cortisol` / `dopamine` / `serotonin` 归 O-026 的化学池；
 *    `oxytocin`（台账 §16 组点名的那一个）O-026 出厂没有——
 *    本插件**不新建表、不新建池**，走 O-026 自己的动态激素通道
 *    `inflict('oxytocin', 0)`（手册 §3.2：通用基线 50 / 半衰期 30min，上限 12 种）。
 *    这正是「动态激素」这个设计存在的理由，用它是复用，不是绕过。
 * 2. **不写 PAD、不算 mood**。`overlay()` 里没有 `setAxis`、没有 `feel`——
 *    接口上先拿掉，比注释里写「请不要写」有效（C1 的同一条思路）。
 * 3. **不出提示词片段**。文本出口唯一归 O-032；O-029 已经在皮质醇 ≥80 时
 *    输出「你在应激」的行为指令。激素再出一段就是两段行为指令互相打架，
 *    而两边都「看起来对」。
 *
 * ## 两套尺度并存，是手册原口径，不是笔误
 *
 * 激素与能量用 **0–100**（§3.2：dopamine 基线 50、cortisol ≥70 抽血清素、ceiling 100）；
 * PAD 与标签用 **0–1**。本插件只碰 0–100 那一套，**不做任何换算**。
 *
 * ## 档位边界从哪里来（只有 cortisol 两处有出处）
 *
 * `above` / `high` 用「可偏离空间的比例」表达，避免为每个维度各写一套绝对值：
 * `ratio = (value − baseline) / (value ≥ baseline ? 100 − baseline : baseline)`。
 * - cortisol 的 `above = 0.5` → 值 60（手册 §3.8「60 → ×2」）；
 *   `high = 0.75` → 值 80（手册 §3.8「≥80 → ×3」）。这两个是抄来的。
 * - dopamine `0.5 / 0.8`（值 75 / 90）、oxytocin `0.4 / 0.7`（值 70 / 85）
 *   **手册没给**，是工程取值，已登记待裁决。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const HORMONE_SERVICE_KEY = 'ondra-emotion-hormone'

/* ------------------------------------------------------------------ *
 * 维度集合
 * ------------------------------------------------------------------ */

/**
 * 三个**主维度**：参与叠加、参与权重。
 *
 * 这三个名字来自台账第 16 组「激素维度扩展，与核心三维并存只读叠加」，
 * 与手册 §14.3 的「加激素（cortisol/oxytocin/dopamine）」逐字一致。
 *
 * 注意**不是** O-026 化学池的三种（dopamine/cortisol/serotonin）——
 * 台账用的是 oxytocin，不是 serotonin。两处名字不同是事实，不是笔误；
 * 本插件按台账取 oxytocin，另把 serotonin 作为**只读参考维度**单列
 * （见 `REFERENCE_HORMONES`），既不删掉 O-026 已有的数据，也不把它混进主判定。
 */
export const PRIMARY_HORMONES = ['cortisol', 'dopamine', 'oxytocin'] as const

/** 一个主维度的名字。 */
export type PrimaryHormone = (typeof PRIMARY_HORMONES)[number]

/**
 * 参考维度：不参与叠加权重，只给面板与解释用。
 *
 * 为什么单列 serotonin：它是 O-026 慢变量的执行者（皮质醇 ≥70 时按 −1.5/min 被抽走，
 * energy > 80 且无高张力执念时按 +0.8/min 回充）。不读它，
 * 「为什么她压着一股气时整个人的底色也沉下去」就解释不出来；
 * 把它算进主叠加，又会与「台账三激素」的口径打架。故只读、只参考。
 */
export const REFERENCE_HORMONES = ['serotonin'] as const

/** 一个参考维度的名字。 */
export type ReferenceHormone = (typeof REFERENCE_HORMONES)[number]

/** 任意一个可读维度。 */
export type HormoneDim = PrimaryHormone | ReferenceHormone

/* ------------------------------------------------------------------ *
 * 维度表
 * ------------------------------------------------------------------ */

/**
 * 一个维度的静态说明。
 *
 * 这张表是**本插件唯一的维度真源**：档位边界、中文名、半衰期全从这里出，
 * 别处不再写第二份。`baseline` 对 dopamine 只是**缺省值**——
 * 真正的基线是气质里的 `enthusiasm`（手册 §3.2：「enthusiasm 是多巴胺出厂基线」），
 * 读的时候由 `baselineFromTemperament` 决定要不要覆盖。
 */
export interface HormoneDimSpec {
  /** 维度名，规格名用连字符小写。 */
  readonly name: HormoneDim
  /** 面板与日志用的中文名。**不得进提示词**。 */
  readonly zh: string
  /** 主维度还是参考维度。 */
  readonly role: 'primary' | 'reference'
  /**
   * 这个维度的值从哪来。
   * - `core-temperament`：O-026 出厂自带，且基线由气质覆盖（dopamine）。
   * - `core`：O-026 出厂自带，基线固定（cortisol / serotonin）。
   * - `dynamic`：O-026 出厂没有，靠动态激素通道造（oxytocin）。
   */
  readonly source: 'core-temperament' | 'core' | 'dynamic'
  /** 缺省基线，0–100。 */
  readonly baseline: number
  /** 半衰期（分钟）。来自手册 §3.2；动态激素统一 30。 */
  readonly halfLifeMinutes: number
  /** 高于基线多少（占可用上行空间的比例）算「偏高」。 */
  readonly aboveRatio: number
  /** 高于基线多少算「顶格」。 */
  readonly highRatio: number
  /** 设计说明，写进 README 与解释文本。 */
  readonly doc: string
}

/**
 * 维度表 —— **唯一真源**。
 *
 * 写法照纪律 48：先给带类型注解的中间常量（上下文类型生效、字面量不被拓宽），
 * 再 `Object.freeze`。直接 `freeze({...})` 会把 `name: 'cortisol'` 拓宽成 `string`。
 */
const SPECS_TMP: Readonly<Record<HormoneDim, HormoneDimSpec>> = {
  cortisol: {
    name: 'cortisol',
    zh: '皮质醇',
    role: 'primary',
    source: 'core',
    baseline: 20,
    halfLifeMinutes: 30,
    // 0.5 → 60（手册 §3.8「60 → 危机 ×2 / 日常 ×0.55」）
    aboveRatio: 0.5,
    // 0.75 → 80（手册 §3.8「≥80 → 危机 ×3 / 日常 ×0.1」）
    highRatio: 0.75,
    doc: '压力激素。基线 20，半衰期 30 分钟；越高越「压着一股气」。',
  },
  dopamine: {
    name: 'dopamine',
    zh: '多巴胺',
    role: 'primary',
    source: 'core-temperament',
    baseline: 50,
    halfLifeMinutes: 45,
    // 手册未给档位边界，工程取值（值 75）
    aboveRatio: 0.5,
    highRatio: 0.8,
    doc: '奖赏激素。基线由气质 enthusiasm 决定（手册 §3.2），出厂 50；半衰期 45 分钟。',
  },
  oxytocin: {
    name: 'oxytocin',
    zh: '催产素',
    role: 'primary',
    source: 'dynamic',
    baseline: 50,
    halfLifeMinutes: 30,
    // 手册未给档位边界，工程取值（值 70）
    aboveRatio: 0.4,
    highRatio: 0.7,
    doc: '联结激素。O-026 出厂没有，走动态激素通道（通用基线 50 / 半衰期 30 分钟）。',
  },
  serotonin: {
    name: 'serotonin',
    zh: '血清素',
    role: 'reference',
    source: 'core',
    baseline: 50,
    halfLifeMinutes: 120,
    // 参考维度不参与叠加，边界只给面板显示，取与 dopamine 同口径
    aboveRatio: 0.5,
    highRatio: 0.8,
    doc: '底色激素。基线 50，半衰期 120 分钟；被皮质醇按分钟抽走，被「有劲且没事」回充。',
  },
}

/** 维度表（冻结）。 */
export const HORMONE_SPECS: Readonly<Record<HormoneDim, HormoneDimSpec>> = Object.freeze(SPECS_TMP)

/**
 * 低于基线的两条边界。
 *
 * 下行空间与上行空间不对称是刻意的：皮质醇从 20 掉到 0 是「彻底放松」，
 * 从 20 涨到 100 是「顶格」，两者都是满量程。用同一个比例尺，
 * 语义才不会一边松一边紧。
 */
export const LOW_RATIO = -0.5
export const BELOW_RATIO = -0.12

/* ------------------------------------------------------------------ *
 * 档位
 * ------------------------------------------------------------------ */

/** 一个维度的档位。五档，闭合。 */
export type HormoneBand = 'low' | 'below' | 'normal' | 'above' | 'high'

/** 档位中文名。**只给面板与日志，不得进提示词**（守内感受铁律 §4.3 的同一条思路）。 */
export const BAND_ZH: Readonly<Record<HormoneBand, string>> = Object.freeze({
  low: '偏低',
  below: '略低',
  normal: '平常',
  above: '偏高',
  high: '顶格',
})

/* ------------------------------------------------------------------ *
 * 读数
 * ------------------------------------------------------------------ */

/** 一个维度的读数（全部是派生值，不存第二份）。 */
export interface HormoneReading {
  /** 维度名。 */
  readonly name: string
  /** 中文名。 */
  readonly zh: string
  /** 主维度还是参考维度。参考维度不进 `notes`，也不进叠加权重。 */
  readonly role: 'primary' | 'reference'
  /** 当前值，0–100。 */
  readonly value: number
  /** 当前基线，0–100。 */
  readonly baseline: number
  /** 相对基线的差值，−100–100。 */
  readonly deviation: number
  /**
   * 相对「可偏离空间」的比例，−1–1。
   *
   * 分母分两段：高于基线时除以 `100 − baseline`，低于基线时除以 `baseline`。
   * 这样 `ratio = 0.5` 在任何维度上都是「走了一半的上行空间」，
   * 档位边界才能跨维度共用。
   */
  readonly ratio: number
  /** 档位。 */
  readonly band: HormoneBand
  /**
   * 这个值是否**不是**读到的，而是按基线代入的。
   *
   * 只有 oxytocin 会为 true：它要靠 `ensure()` 显式造出来，
   * `read()` 本身绝不写。标出来是为了让面板能说「这一维还没建」，
   * 而不是把 50 当成真实读数。
   */
  readonly missing: boolean
}

/** 一次只读的结果。 */
export interface HormoneRead {
  /** 读数时刻。 */
  readonly at: number
  /** 数据来自真实情绪服务，还是出厂基线。 */
  readonly source: 'emotion' | 'baseline'
  /** 各维度读数，键是维度名（含参考维度，若开启）。 */
  readonly readings: Readonly<Record<string, HormoneReading>>
  /** 按基线代入的维度名。 */
  readonly missing: readonly string[]
}

/* ------------------------------------------------------------------ *
 * 叠加
 * ------------------------------------------------------------------ */

/**
 * 叠加后的倾向，五档。
 *
 * 判定顺序（写在 `overlay.ts` 的 `tiltOf`，只有那一处）：
 * `strained > loaded > buoyant > bright > steady`。
 */
export type HormoneTilt = 'strained' | 'loaded' | 'steady' | 'bright' | 'buoyant'

/** 倾向中文名。只给面板与日志。 */
export const TILT_ZH: Readonly<Record<HormoneTilt, string>> = Object.freeze({
  strained: '绷着',
  loaded: '压着事',
  steady: '平稳',
  bright: '舒展',
  buoyant: '轻快',
})

/** 三个主维度归一化后的影响力权重，和为 1（全部无偏离时均分）。 */
export type HormoneWeights = Readonly<Record<PrimaryHormone, number>>

/**
 * 只读叠加结果。
 *
 * **没有 `applied` 以外的写入口，而 `applied` 的类型是字面量 `false`**——
 * 这张卡永远只是「解释」，不是「状态」。
 */
export interface HormoneOverlay {
  /** 叠加时刻。 */
  readonly at: number
  /** 数据来源。 */
  readonly source: 'emotion' | 'baseline'
  /** 应激负荷 0–1（皮质醇上行比例，只取正向）。 */
  readonly load: number
  /** 奖赏驱动 0–1（多巴胺上行比例，只取正向）。 */
  readonly drive: number
  /** 联结 0–1（催产素上行比例，只取正向）。 */
  readonly bond: number
  /** 综合倾向。 */
  readonly tilt: HormoneTilt
  /** 三主维度的影响力权重。 */
  readonly weights: HormoneWeights
  /** **恒为 false**。字面量类型让「顺手写回去」编译期就写不出来。 */
  readonly applied: false
  /** 中文解释，最多 3 条。给面板与日志，**不得进提示词**，且刻意不含数字。 */
  readonly notes: readonly string[]
}

/* ------------------------------------------------------------------ *
 * 显式补造
 * ------------------------------------------------------------------ */

/** `ensure()` 的结果。 */
export interface EnsureResult {
  /** 时刻。 */
  readonly at: number
  /** 请求补造的维度名（去重后）。 */
  readonly requested: readonly string[]
  /** 真的造出来的。 */
  readonly created: readonly string[]
  /** 本来就有、无需补的。 */
  readonly existing: readonly string[]
  /**
   * 被拒的。
   *
   * 两种原因都进这里：名字非法，或 O-026 的动态激素已到 12 种上限。
   * 后者是手册的硬口径（「不是怕她造，是不接受每有一点心事就发明一种情绪」），
   * 到顶就拒绝，不淘汰旧的。
   */
  readonly refused: readonly string[]
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/**
 * 不可用原因。
 *
 * **只可能是 `disabled`**（纪律 55）：没有情绪服务是「降级」，不是「不可用」。
 * 把它混进来会让下游以为「激素插件没装」而启用另一套兜底，
 * 两套兜底一撞，面板值来回跳（O-028 踩过的同一个坑）。
 */
export type HormoneUnavailableReason = 'disabled'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface HormoneCounters {
  /** `read()` 次数。 */
  readonly reads: number
  /** `overlay()` 次数。 */
  readonly overlays: number
  /** `ensure()` 次数。 */
  readonly ensures: number
  /** 情绪服务读数抛错的次数（错误不传播，只记一笔）。 */
  readonly emotionErrors: number
}

/** 统计快照，供自检与成长面板（O-124）读取。 */
export interface HormoneStats {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: HormoneUnavailableReason
  /** 当前数据来源。 */
  readonly source: 'emotion' | 'baseline'
  /** 累计计数。 */
  readonly counters: HormoneCounters
  /** 已由本插件补造过的动态维度。 */
  readonly seeded: readonly string[]
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

/** 激素维度服务（只读叠加）。 */
export interface HormoneService {
  /** 是否可用。关掉总开关时为 false，服务仍注册。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: HormoneUnavailableReason

  /** 维度表（含参考维度，顺序固定）。 */
  specs(): readonly HormoneDimSpec[]

  /**
   * 只读一次。
   *
   * **不写任何东西**，包括不造 oxytocin：缺失的维度按基线代入并标 `missing`。
   * @param at 时刻，省略用系统时间。
   */
  read(at?: number): HormoneRead

  /**
   * 只读叠加。
   *
   * 关掉总开关时返回「全零 + 平稳」，不改任何表达。
   * @param at 时刻。
   */
  overlay(at?: number): HormoneOverlay

  /**
   * 判一个维度的档位。
   * @param name 维度名。
   * @param value 值，省略则现读一次。
   */
  bandOf(name: string, value?: number): HormoneBand

  /**
   * 可解释文本：为什么是这一档。
   * @param at 时刻。
   */
  explain(at?: number): readonly string[]

  /**
   * 显式补造缺失维度（**本插件唯一的写动作，且不写情绪值**）。
   *
   * 只调 O-026 的 `inflict(name, 0)`：造出一个「停在基线」的维度，
   * 不改变任何一维的现有读数。默认补 oxytocin。
   * @param names 要补的维度名，省略则补 `oxytocin`。
   * @param at 时刻。
   */
  ensure(names?: readonly string[], at?: number): EnsureResult

  /** 统计快照。 */
  stats(): HormoneStats
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
 * O-026 气质的结构对位子集（只取多巴胺基线那一个旋钮）。
 *
 * 为什么要读它而不是写死 50：手册 §3.2 明写 `enthusiasm` 是
 * 「多巴胺出厂基线」。写死 50 会让「热情的人天生更容易开心」这条设计
 * 在本插件里彻底失效——她的多巴胺明明回到 62 了，本插件还报「偏高」。
 */
export interface TemperamentLike {
  readonly enthusiasm: number
}

/** O-026 情绪快照的结构对位子集。 */
export interface EmotionSnapshotLike {
  readonly at: number
  readonly axes: Readonly<Record<string, number>>
  readonly hormones: Readonly<Record<string, number>>
  readonly temperament: TemperamentLike
}

/** O-026 情绪服务的结构对位子集（只读 + 一个造维度的入口）。 */
export interface EmotionLike {
  readonly available: boolean
  state(at?: number): EmotionSnapshotLike
  inflict(name: string, delta: number, at?: number): boolean
  temperament(): TemperamentLike
}
