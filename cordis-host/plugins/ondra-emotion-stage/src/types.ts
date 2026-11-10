/**
 * O-028 `ondra-emotion-stage` 的对外契约。
 *
 * 定位：**关系阶段的棘轮 + 关系四维的底座**。
 *
 * 五件必须先说清的事：
 *
 * 1. **七阶是底座，五阶段与六段是两条只读派生，三者互不推导。**
 *    手册 §3.4 / §9.3 的裁决是「七阶为底座、五阶段只读映射、六段 0–1000 对外展示」。
 *    本插件额外明确一条：**六段刻度由「好感」推出，不由阶段推出**。
 *    理由：阶段是棘轮（只升不降），好感是会衰减的读数。拿阶段去算刻度，
 *    会出现「两个月没联系，阶段还是落定，刻度却显示交心」——那不是展示，那是撒谎。
 *
 * 2. **阶段是棘轮，不是当前亲密的读数。**
 *    手册 §9.1「防跃迁四闸」里的「只升不降」是硬约束：一旦走到落定，
 *    再久不联系也不会退回敌意。所以 `StageView` 同时给 `base`（棘轮底座，只升）
 *    与 `effective`（对外语域，可被冲突锁临时压低），
 *    **两个字段由同一次计算得出**，不是两处各判一次。
 *
 * 3. **关系四维（affection / trust / intimacy）落在本插件，是补一个真实空档。**
 *    台账里 O-026 被写成「关系域归它」，但 O-026 的契约只有 PAD 六维 + 标签 + 激素，
 *    没有这四维；全仓 grep `affection` 零命中。而七阶判定需要「相处天数 + 好感 + 信任」，
 *    没有底座它就是一组没人喂得进的纯函数。
 *    故本插件承接三维的存储、衰减与单次步长闸；**熟悉度（familiarity）改为推导**，
 *    理由见 `relation.ts` 文件头。
 *
 * 4. **冲突锁的真源不在本插件。**
 *    锁的建立、维持、解除归 O-030。本插件只接受一个 `locked` 布尔入参：
 *    锁定时**不升阶**、且 `effective` 覆盖为敌意；`base` 一动不动。
 *    把锁存进本插件，就会有两个地方各自记「现在吵没吵架」。
 *
 * 5. **病态 / 献祭不进默认 UI**（裁决③）。它们有 `uiVisible: false`，
 *    但**仍在 `stages()` 里全量返回**——删掉它们，读回旧数据时 `stage='sacrifice'`
 *    就无从判定，只能当脏数据丢弃。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const STAGE_SERVICE_KEY = 'ondra-emotion-stage'

/** 七阶，顺序即阶序（0–6）。手册 §9.1 / §3.4。 */
export const STAGES = ['hostile', 'probing', 'crush', 'possessive', 'pathological', 'sacrifice', 'settled'] as const

/** 一个阶段的名字。 */
export type StageId = (typeof STAGES)[number]

/**
 * 单次关系变化的上限（§3.4「单次变化 cap 0.06」，也是 §9.1 防跃迁四闸里的「步长闸 0.06」）。
 *
 * 两处说的是同一个数，所以只有这一个常量。**不做成配置项**：
 * 它是「一次互动最多能把关系推多远」的产品口径，调大就等于允许一夜之间走完六十天。
 */
export const MAX_STEP = 0.06

/** 一天的毫秒数。相处天数按自然日序号算，不按 24 小时滑窗。 */
export const MS_PER_DAY = 86_400_000

/** 一分钟的毫秒数。 */
export const MS_PER_MINUTE = 60_000

/** 熟悉度的饱和分母。 */
export const FAMILIARITY_SATURATION = 5000

/** 一阶的定义。 */
export interface StageSpec {
  /** 阶名。 */
  readonly id: StageId
  /** 中文名。只给日志与面板，**不进提示词**。 */
  readonly zh: string
  /** 阶序 0–6。只升不降比的就是它。 */
  readonly order: number
  /** 时间闸：相处天数下限。 */
  readonly days: number
  /** 好感下限。 */
  readonly affection: number
  /** 信任下限。 */
  readonly trust: number
  /** 信任上限。只有病态有（`trust ≤ 0.55`），其余为 `undefined`。 */
  readonly maxTrust?: number
  /** 累计互动次数下限。 */
  readonly minInteractions: number
  /** 是否必须有 `sacrifice` 标记。 */
  readonly requiresSacrifice: boolean
  /** 是否允许出现在默认 UI（病态 / 献祭为 false，裁决③）。 */
  readonly uiVisible: boolean
}

/**
 * 七阶表 —— **阶段参数的唯一真源**。
 *
 * 后五阶的数字逐字来自手册 §9.1：`心动(3天,.18,.15)` / `占有(14,.38,.32)` /
 * `病态(30,.62,.30且trust≤.55)` / `献祭(45,.70,.45且需sacrifice标记)` / `落定(60,.75,.70)`。
 *
 * **前两阶手册没给数字**（敌意是起点、试探是「开始有来往」），这里取定：
 * 敌意 = 全零；试探 = 至少一次互动。这是反推，不是抄来的，理由与待裁决登记见 README。
 */
const STAGE_TABLE: Record<StageId, StageSpec> = {
  hostile: {
    id: 'hostile',
    zh: '敌意',
    order: 0,
    days: 0,
    affection: 0,
    trust: 0,
    minInteractions: 0,
    requiresSacrifice: false,
    uiVisible: true,
  },
  probing: {
    id: 'probing',
    zh: '试探',
    order: 1,
    days: 0,
    affection: 0,
    trust: 0,
    minInteractions: 1,
    requiresSacrifice: false,
    uiVisible: true,
  },
  crush: {
    id: 'crush',
    zh: '心动',
    order: 2,
    days: 3,
    affection: 0.18,
    trust: 0.15,
    minInteractions: 1,
    requiresSacrifice: false,
    uiVisible: true,
  },
  possessive: {
    id: 'possessive',
    zh: '占有',
    order: 3,
    days: 14,
    affection: 0.38,
    trust: 0.32,
    minInteractions: 1,
    requiresSacrifice: false,
    uiVisible: true,
  },
  pathological: {
    id: 'pathological',
    zh: '病态',
    order: 4,
    days: 30,
    affection: 0.62,
    trust: 0.3,
    maxTrust: 0.55,
    minInteractions: 1,
    requiresSacrifice: false,
    uiVisible: false,
  },
  sacrifice: {
    id: 'sacrifice',
    zh: '献祭',
    order: 5,
    days: 45,
    affection: 0.7,
    trust: 0.45,
    minInteractions: 1,
    requiresSacrifice: true,
    uiVisible: false,
  },
  settled: {
    id: 'settled',
    zh: '落定',
    order: 6,
    days: 60,
    affection: 0.75,
    trust: 0.7,
    minInteractions: 1,
    requiresSacrifice: false,
    uiVisible: true,
  },
}

/**
 * 七阶表的**只读出口**。
 *
 * 中间多一层 `STAGE_TABLE` 不是啰嗦：直接写
 * `const X: Readonly<Record<StageId, StageSpec>> = Object.freeze({...})` 时，
 * 对象字面量的 `id: 'hostile'` 会**拓宽成 `string`**，而 `StageSpec.id` 是
 * `StageId` 字面量联合——那一层拓宽只在「先给中间常量加类型注解」时才会被挡住。
 * 这类错误的表现是 `TS2322: Type 'string' is not assignable to type 'StageId'`，
 * 而纯文本检查完全看不出来。
 */
export const STAGE_SPECS: Readonly<Record<StageId, StageSpec>> = Object.freeze(STAGE_TABLE)

/* ------------------------------------------------------------------ *
 * 关系四维
 * ------------------------------------------------------------------ */

/** 可写的关系维度（熟悉度是推导值，不在此列，理由见 `relation.ts`）。 */
export const RELATION_DIMS = ['affection', 'trust', 'intimacy'] as const

/** 一个可写的关系维度。 */
export type RelationDim = (typeof RELATION_DIMS)[number]

/** 一个维度的取值范围、基线与半衰期。 */
export interface RelationSpec {
  /** 下限。 */
  readonly min: number
  /** 上限。 */
  readonly max: number
  /** 静息水平。衰减朝它走。 */
  readonly baseline: number
  /** 衰减半衰期（小时）。`0` 表示不衰减。 */
  readonly halfLifeHours: number
}

/**
 * 关系四维参数 —— **唯一真源**。
 *
 * 半衰期逐字来自手册 §3.4：`{affection 240h, trust 720h, intimacy 8760h, tension 24h}`。
 * 张力不在这里：它归 O-026 的六维与 O-030 的锁。
 * 基线来自 master-plan §9.1「按人维度 affection 0.1 / trust 0.1 / intimacy 0」。
 *
 * **熟悉度刻意没有条目**：手册给了初值 0，没给衰减与更新规则。
 * 给它编一条曲线，就是编第二个真源；改成从互动次数推导，反而只借了一个已有分母（见 `relation.ts`）。
 */
export const RELATION_SPEC: Readonly<Record<RelationDim, RelationSpec>> = Object.freeze({
  affection: Object.freeze({ min: 0, max: 1, baseline: 0.1, halfLifeHours: 240 }),
  trust: Object.freeze({ min: 0, max: 1, baseline: 0.1, halfLifeHours: 720 }),
  intimacy: Object.freeze({ min: 0, max: 1, baseline: 0, halfLifeHours: 8760 }),
})

/** 一次关系快照（`relation()` 的返回，也是 `adjust()` 的入参基础）。 */
export interface RelationState {
  /** 好感 0–1。 */
  readonly affection: number
  /** 信任 0–1。 */
  readonly trust: number
  /** 亲密 0–1。 */
  readonly intimacy: number
  /** 熟悉度 0–1，由累计互动次数推导。 */
  readonly familiarity: number
  /** 首次相遇时刻（毫秒）。相处天数的锚点。 */
  readonly firstMetAt: number
  /** 累计互动次数（每次 `adjust()` 且带实际变化才 +1）。 */
  readonly interactions: number
  /** `sacrifice` 标记（献祭阶的专属条件）。 */
  readonly sacrifice: boolean
  /** 相处天数（自然日序号差）。 */
  readonly days: number
  /** 这份快照对应的时刻。 */
  readonly at: number
}

/** 一次关系调整。每个字段都是增量，会被 `MAX_STEP` 夹紧。 */
export interface RelationPatch {
  /** 好感增量。 */
  readonly affection?: number
  /** 信任增量。 */
  readonly trust?: number
  /** 亲密增量。 */
  readonly intimacy?: number
}

/* ------------------------------------------------------------------ *
 * 阶段视图与四闸
 * ------------------------------------------------------------------ */

/** 防跃迁四闸的判定结果。 */
export interface StageGates {
  /** 时间闸：相处天数是否够。 */
  readonly time: boolean
  /** 步长闸：本次调整是否被 `MAX_STEP` 截断过。 */
  readonly step: boolean
  /** 只升不降：本次是否有阶被棘轮挡住。 */
  readonly monotonic: boolean
  /** 冲突锁：本次是否因锁而不许升阶。 */
  readonly lock: boolean
  /** 本次判定被卡在哪个阶（没有则为 `undefined`）。 */
  readonly denied?: StageId
  /** 卡住的原因（人话，只给面板与日志）。 */
  readonly missing: readonly string[]
}

/** 五阶段（历史只读映射，手册 §3.4）。 */
export type LegacyStage = 'cold' | 'thawing' | 'attached' | 'possessive' | 'yandere'

/** 六段刻度里的一段。 */
export interface ScaleBandSpec {
  /** 段名。 */
  readonly id: string
  /** 中文段名。 */
  readonly zh: string
  /** 分数下限（含）。 */
  readonly from: number
  /** 分数上限（不含，最后一段含）。 */
  readonly to: number
}

/** 六段刻度视图。 */
export interface ScaleView {
  /** 0–1000 的对外刻度。由好感推出，与阶段无关。 */
  readonly score: number
  /** 当前段。 */
  readonly band: ScaleBandSpec
  /** 段内进度 0–1，给进度条用。 */
  readonly progress: number
  /** 全部六段（界面画刻度尺用）。 */
  readonly bands: readonly ScaleBandSpec[]
}

/** 一次阶段快照。 */
export interface StageView {
  /** 时刻。 */
  readonly at: number
  /** 棘轮底座：只升不降的那个阶。 */
  readonly base: StageId
  /** 对外语域：锁定时被覆盖为敌意，其余时候等于 `base`。 */
  readonly effective: StageId
  /** 是否被覆盖。 */
  readonly overridden: boolean
  /** 覆盖原因（只有冲突锁一种）。 */
  readonly overrideReason?: 'conflict-lock'
  /** 底座的阶定义。 */
  readonly spec: StageSpec
  /** 进入该阶的时刻（棘轮底座的）。 */
  readonly enteredAt: number
  /** 相处天数。 */
  readonly days: number
  /** 关系四维快照。 */
  readonly relation: RelationState
  /** 四闸判定。 */
  readonly gates: StageGates
  /** 五阶段只读映射。 */
  readonly legacy: LegacyStage
  /** 六段刻度。 */
  readonly scale: ScaleView
  /** 该阶是否允许进默认 UI。 */
  readonly uiVisible: boolean
}

/** 一阶的可达性判定（`explain()` 用）。 */
export interface StageProbe {
  /** 阶名。 */
  readonly id: StageId
  /** 中文名。 */
  readonly zh: string
  /** 当前是否满足全部条件。 */
  readonly ok: boolean
  /** 不满足的条件（人话）。 */
  readonly missing: readonly string[]
}

/** 可解释性快照：回答「为什么现在是这一阶」。 */
export interface StageExplanation {
  /** 时刻。 */
  readonly at: number
  /** 棘轮底座。 */
  readonly base: StageId
  /** 对外语域。 */
  readonly effective: StageId
  /** 是否被锁覆盖。 */
  readonly overridden: boolean
  /** 相处天数。 */
  readonly days: number
  /** 关系四维。 */
  readonly relation: RelationState
  /** 七阶逐条判定。 */
  readonly probes: readonly StageProbe[]
  /** 下一次能升到哪阶（没有则为 `undefined`）。 */
  readonly next?: StageId
  /** 一句话结论。 */
  readonly note: string
}

/**
 * 降级原因。
 *
 * 注意 `no-store` / `schema-failed` **不影响 `available`**：没有存档时本插件
 * 照样能读能判（内存态），只是重启回到敌意。把它们报成「不可用」，
 * 下游就会以为「关系阶段没装」而走另一套兜底，两套兜底一撞，
 * 界面上的阶段会在两轮之间来回跳。
 */
export type StageUnavailableReason =
  /** 配置关掉了（这一条才是真的不可用）。 */
  | 'disabled'
  /** 没有存储端口：只在内存里跑，重启回到敌意。 */
  | 'no-store'
  /** 建表失败：同上，只在内存里跑。 */
  | 'schema-failed'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface StageCounters {
  /** 关系调整次数。 */
  readonly adjusts: number
  /** 互动计数次数（`touch()` 被调到的次数）。 */
  readonly touches: number
  /** 被步长闸截断的次数。 */
  readonly stepClamped: number
  /** 升阶次数。 */
  readonly upgrades: number
  /** 因冲突锁被挡住升阶的次数。 */
  readonly lockBlocked: number
  /** 落盘次数。 */
  readonly saves: number
}

/** 统计快照。 */
export interface StageStats {
  /** 是否可用（无存储时仍可用，只是重启归零）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: StageUnavailableReason
  /** 存储后端标识（无存储时为 `none`）。 */
  readonly storeProvider: string
  /** 当前底座阶。 */
  readonly base: StageId
  /** 相处天数。 */
  readonly days: number
  /** 累计互动。 */
  readonly interactions: number
  /** 最近一次升阶时刻（0 表示还没升过）。 */
  readonly lastUpgradeAt: number
  /** 累计计数。 */
  readonly counters: StageCounters
  /**
   * 最近一次判定**实际用了哪张判据表**。
   *
   * 补的是「算得出但没生效」：`ondra-persona-evolve` 一直算得出系数，
   * 而七阶表原先只读常量。三件事必须并排看得见：
   *
   * | 读到什么 | 结论 |
   * | --- | --- |
   * | `asked: 0` | 漂移没接上（或人格演化未装）→ 判定用出厂门槛 |
   * | `applied` 有值 | 门槛真的按相处时长上移了 |
   * | `rejected` 有值 | 撞量程或乱序被挡回出厂值（**不是成功**） |
   */
  readonly drift?: {
    /** 问过几条门槛。 */
    readonly asked: number
    /** 真的换掉了的键（`stage.dim`）。 */
    readonly applied: readonly string[]
    /** 被护栏挡回的键与原因。 */
    readonly rejected: readonly { readonly key: string; readonly why: string }[]
    /** 一句人话（面板用）。 */
    readonly sentence: string
  }
  /**
   * **最近一次判定实际用了哪张表**。
   *
   * 与 `drift`（现算）并排才能分辨两件事：判定路径真的用了漂移表，
   * 还是只有诊断在算。只留一个时，「把判定改回常量表」这种回退不会报红。
   */
  readonly lastDrift?: {
    readonly asked: number
    readonly applied: readonly string[]
    readonly rejected: readonly { readonly key: string; readonly why: string }[]
    readonly sentence: string
  }
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 关系阶段服务。 */
export interface StageService {
  /** 是否可用。没有存储时仍可用（内存态），只是重启回到敌意。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: StageUnavailableReason

  /** 七阶表（全量，含病态与献祭）。 */
  stages(): readonly StageSpec[]

  /**
   * 取当前阶段快照。**只读，不落盘**。
   * @param at 时刻。
   * @param locked 冲突锁状态（真源在 O-030，这里只是入参）。
   */
  view(at?: number, locked?: boolean): StageView

  /**
   * 取关系四维快照（**已按闭式衰减投影到 `at`，但不落盘**）。
   * @param at 时刻。
   */
  relation(at?: number): RelationState

  /**
   * 记一次互动（**唯一的互动计数入口**）。
   *
   * 与 `adjust()` 分开是刻意的：`adjust()` 记的是「关系被推动过几次」，
   * 而 `familiarity = min(1, interactions / 5000)` 要的是「相处了多少轮」。
   * 合成一个数会让「吵五百次架就算很熟」成立，也会让一轮平常问候不计数。
   *
   * @param at 时刻。
   */
  touch(at?: number): RelationState

  /**
   * 调整关系四维（**唯一的关系写入口**）。单维增量会被 `MAX_STEP` 夹紧。
   * **不计数**——计数归 `touch()`，两处都计会让一轮 +2。
   * @param patch 增量。
   * @param at 时刻。
   */
  adjust(patch: RelationPatch, at?: number): RelationState

  /**
   * 结算：把闭式衰减的结果固化下来。
   *
   * 距上次结算不足 `idleSettleMinutes` 时**什么都不做**（§3.4「idle 15min 结算」）。
   * @param idleMinutes 空闲门槛，省略用配置值。
   * @param at 时刻。
   */
  settle(idleMinutes?: number, at?: number): RelationState

  /**
   * 置 `sacrifice` 标记（献祭阶的专属条件）。
   * @param value 真/假。
   * @param at 时刻。
   */
  markSacrifice(value: boolean, at?: number): StageView

  /**
   * 判定一次升阶（**唯一的阶段写入口**）。
   *
   * 四闸：时间闸 / 步长闸（由 `adjust()` 承担）/ 只升不降 / 冲突锁。
   * 锁定时不升阶，且 `effective` 覆盖为敌意。
   * @param input 锁状态。
   * @param at 时刻。
   */
  observe(input?: { readonly locked?: boolean }, at?: number): StageView

  /**
   * 为什么现在是这一阶。逐阶给出满足与缺失的条件。
   * @param at 时刻。
   * @param locked 锁状态。
   */
  explain(at?: number, locked?: boolean): StageExplanation

  /** 统计快照。 */
  stats(): StageStats
}

/** 错误码。 */
export type StageErrorCode = 'bad-request' | 'write-failed' | 'read-failed'

/** 关系阶段错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class StageError extends Error {
  /** 错误码。 */
  readonly code: StageErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: StageErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'StageError'
    this.code = code
    this.detail = detail
  }
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

/** O-001 身份服务的结构对位子集。 */
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

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位（只够建一张单行状态表）
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
