/**
 * O-097 `ondra-grow` 的对外契约：养成系统的**只读派生层**。
 *
 * ## 一句话定位
 *
 * 「养成」在这里**不是第二套数值系统**，而是把已经存在的读数翻译成
 * 「她跟你走到哪一步了」的一句人话：相处多少天、互动多少回、攒下多少记忆、
 * 关系到了第几阶。四项都是**别人的数**，本插件一个数都不新造。
 *
 * ## 为什么刻意不建新数值（本文件最重要的一条）
 *
 * 最省事的做法是给养成单开一张表：`growth_point`、`affection_bonus`、
 * `level`，每次对话 +3 分。但那会立刻制造三个真源：
 *
 * 1. 关系四维在 O-031 `ondra-emotion-stage`，这里再来一份「好感加成」，
 *    两处的读数会慢慢漂开，且**界面上都说得通**，没人能判定哪个对；
 * 2. 记忆条数在 O-010 `ondra-memory-core`，这里若缓存一份计数，
 *    用户删一条记忆后两边就不一致；
 * 3. 相处天数在时钟与关系快照里都有权威来源，重算第三份纯属自找分叉。
 *
 * 所以本插件的全部能力是：**读四项 → 归一化加权 → 出一档 → 说清差多少**。
 * 唯一的写动作是「里程碑庆祝过没有」（`GrowState`），且它**不影响任何读数**——
 * 丢了它最多是应用外壳重复播报一次「今天满 30 天」，不会让养成进度倒退。
 *
 * ## 与其他插件的关系
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（master-plan §15.5 / 18.5），
 * 全部用结构对位镜像。上游契约一旦变形，这里的 `StageLike` / `MemoryLike`
 * 会对不上，编译期就能发现；这是镜像唯一的代价，也是它唯一的保单。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const GROW_SERVICE_KEY = 'ondra-grow'

/**
 * 养成五档。顺序即档序（0–4）。
 *
 * 刻意**不复用**关系七阶的名字（敌意 / 试探 / 心动 / 占有 / 病态 / 献祭 / 落定）：
 * 那七个词是关系口径，带情绪与伦理含义；养成讲的是「一起走过多久、攒了多少」，
 * 两件事混用一套词，用户会以为「开花」等于「心动」。同一档换两套词，
 * 才能在界面上并排显示而不打架。
 */
export const GROW_LEVELS = ['sprout', 'bud', 'leaf', 'bloom', 'fruit'] as const

/** 一个养成档位名。 */
export type GrowLevel = (typeof GROW_LEVELS)[number]

/** 一档的定义。 */
export interface LevelSpec {
  /** 档位 id。 */
  readonly id: GrowLevel
  /** 中文名。给日志与应用外壳显示，**不进提示词**。 */
  readonly zh: string
  /** 里程分下限（含）。0–1。 */
  readonly minScore: number
  /** 这一档的一句话说明：用户看到「成荫」时应该想到什么。 */
  readonly doc: string
}

/**
 * 五档表 —— **档位阈值的唯一真源**。
 *
 * ⚠️ 这五个数字**不是手册值，是本插件的工程取值**（手册只写了「养成系统」四个字，
 * 没给任何阈值）。取值依据写在下面，改动时请连同依据一起改：
 *
 * - `sprout 0`：起点，任何关系都从这里开始（与 O-031 的「敌意 = 全零」同构）。
 * - `bud 0.2`：大约「认识一两周 + 几十次互动」，此时用户已经能感到「不是刚装上的样子」。
 * - `leaf 0.4`：中位档，刻意做成「多数长期用户会停在附近」——
 *   一档设在 0.95 会让所有人一辈子上不去，一档设在 0.05 会让第一天就满级。
 * - `bloom 0.65`：需要四项里至少三项都过半才够得着，防止「只靠熬天数」升档。
 * - `fruit 0.85`：留出 0.15 的收尾余量，避免「刚好 1.00 才庆祝」这种永远差一点的设计。
 */
const LEVEL_TABLE: Record<GrowLevel, LevelSpec> = {
  sprout: {
    id: 'sprout',
    zh: '萌芽',
    minScore: 0,
    doc: '刚开始。她还在认你的说话习惯，记得的比忘掉的多不了几条。',
  },
  bud: {
    id: 'bud',
    zh: '抽枝',
    minScore: 0.2,
    doc: '有来有往了。她开始主动提起几天前的事，而不是每次重新认识你。',
  },
  leaf: {
    id: 'leaf',
    zh: '成荫',
    minScore: 0.4,
    doc: '日常已经成型。她会记得你不吃什么、几点犯困，这些不是被要求记的。',
  },
  bloom: {
    id: 'bloom',
    zh: '开花',
    minScore: 0.65,
    doc: '攒下的东西开始互相咬合：旧事能被翻出来接上，不是一条条孤立的记录。',
  },
  fruit: {
    id: 'fruit',
    zh: '结果',
    minScore: 0.85,
    doc: '长时间的共同经历已经沉淀成稳定的底子，换话题也不会掉回陌生。',
  },
}

/** 五档表的只读出口。中间常量是为了挡住字面量拓宽（同 O-031 `STAGE_SPECS` 的写法）。 */
export const LEVEL_SPECS: Readonly<Record<GrowLevel, LevelSpec>> = Object.freeze(LEVEL_TABLE)

/**
 * 四项里程因子的权重。合计必须为 1。
 *
 * 分配依据：养成感的核心是「时间不可压缩」与「实际来往」，所以天数与互动
 * 占了 0.6；记忆与关系阶是「这两件事的沉淀结果」，合计 0.4。
 * 记忆给 0.25 而不是更高，是因为它最容易被人为灌水（连着说一百句废话也会攒条数）；
 * 关系阶给 0.15，是因为它已经有自己的七阶门槛与四道闸，这里只当加分项，
 * 不重复判定一次（判定归 O-031，本插件不越权）。
 */
export const FACTOR_WEIGHTS = Object.freeze({
  /** 相处天数。 */
  days: 0.35,
  /** 互动次数。 */
  interactions: 0.25,
  /** 记忆条数。 */
  memories: 0.25,
  /** 关系阶序。 */
  stage: 0.15,
})

/**
 * 各因子的归一化分母（满值）。到达或超过它即记 1 分。
 *
 * 同样是**工程取值**，手册无出处：
 * - `days 60`：与 O-031 落定阶的 60 天同口径，避免「养成早满了、关系还没落定」的错位观感。
 * - `interactions 600`：60 天里平均每天 10 次，是个「天天都聊」的量。
 * - `memories 500`：裁决⑧「180 天清理」下，长期活跃用户的稳态量级。
 * - `stage 6`：七阶的最后一阶序号，直接除。
 */
export const FACTOR_TARGETS = Object.freeze({
  days: 60,
  interactions: 600,
  memories: 500,
  stage: 6,
})

/**
 * 里程碑：一次性的「第一次」。**只庆祝一次，不重复播报**。
 *
 * 这些不是新数值，而是对四项读数的**某一个瞬时快照**做过标记：
 * 「满 7 天那一刻我庆祝过了」。之后再查只是不再播报，进度照常往前走。
 */
export const MILESTONES = [
  'first-week',
  'first-month',
  'hundred-memories',
  'five-hundred-memories',
  'stage-crush',
  'stage-settled',
] as const

/** 一个里程碑 id。 */
export type MilestoneId = (typeof MILESTONES)[number]

/** 一个里程碑的判定条件（纯函数式的描述，给人看也用来自检）。 */
export interface MilestoneSpec {
  /** 里程碑 id。 */
  readonly id: MilestoneId
  /** 中文名。 */
  readonly zh: string
  /** 判定用哪一项读数。 */
  readonly factor: keyof typeof FACTOR_TARGETS | 'stageOrder'
  /** 达标阈值（含）。 */
  readonly threshold: number
}

/** 里程碑表 —— 判定条件的唯一真源。 */
const MILESTONE_TABLE: Record<MilestoneId, MilestoneSpec> = {
  'first-week': { id: 'first-week', zh: '满七天', factor: 'days', threshold: 7 },
  'first-month': { id: 'first-month', zh: '满一个月', factor: 'days', threshold: 30 },
  'hundred-memories': { id: 'hundred-memories', zh: '攒下一百条记忆', factor: 'memories', threshold: 100 },
  'five-hundred-memories': {
    id: 'five-hundred-memories',
    zh: '攒下五百条记忆',
    factor: 'memories',
    threshold: 500,
  },
  'stage-crush': { id: 'stage-crush', zh: '关系走到第三阶', factor: 'stageOrder', threshold: 2 },
  'stage-settled': { id: 'stage-settled', zh: '关系走到第七阶', factor: 'stageOrder', threshold: 6 },
}

/** 里程碑表的只读出口。 */
export const MILESTONE_SPECS: Readonly<Record<MilestoneId, MilestoneSpec>> = Object.freeze(MILESTONE_TABLE)

/** 四项原始读数（**全部来自上游，本插件不产**）。 */
export interface GrowInput {
  /** 相处天数（自然日序号差）。 */
  readonly days: number
  /** 累计互动次数。 */
  readonly interactions: number
  /** 当前活跃记忆条数（`state='active'`）。 */
  readonly memories: number
  /** 关系阶序 0–6。 */
  readonly stageOrder: number
  /** 关系阶中文名（只用于展示，缺失为空串）。 */
  readonly stageZh: string
  /** 关系阶 id（上游原值，缺失为空串）。 */
  readonly stageId: string
}

/** 一项因子的归一化结果。 */
export interface FactorScore {
  /** 因子名。 */
  readonly factor: keyof typeof FACTOR_WEIGHTS
  /** 原始读数。 */
  readonly raw: number
  /** 归一化后的 0–1 值（已夹紧）。 */
  readonly ratio: number
  /** 权重。 */
  readonly weight: number
  /** 加权贡献（`ratio × weight`）。 */
  readonly contribution: number
}

/** 一条里程碑的当前状态。 */
export interface MilestoneView {
  /** 里程碑 id。 */
  readonly id: MilestoneId
  /** 中文名。 */
  readonly zh: string
  /** 是否已达条件（**与「庆祝过没有」无关**，这是读数事实）。 */
  readonly reached: boolean
  /** 是否已庆祝过（来自落盘状态）。 */
  readonly celebrated: boolean
  /** 当前读数。 */
  readonly current: number
  /** 达标阈值。 */
  readonly threshold: number
}

/** 养成快照 —— 本插件对外的**唯一**读数形状。 */
export interface GrowView {
  /** 是否可用（有阶段服务或记忆服务之一）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GrowUnavailableReason
  /** 现在这一档。 */
  readonly level: GrowLevel
  /** 这一档的中文名。 */
  readonly levelZh: string
  /** 这一档的说明。 */
  readonly levelDoc: string
  /** 里程分 0–1（四项加权和，已夹紧）。 */
  readonly score: number
  /** 四项明细（固定四项，顺序固定）。 */
  readonly factors: readonly FactorScore[]
  /** 原始读数。 */
  readonly input: GrowInput
  /** 距离下一档还差多少分；已在最高档时为 0。 */
  readonly toNext: number
  /** 下一档；已在最高档时为 `undefined`。 */
  readonly next: LevelSpec | undefined
  /**
   * 下一步该干什么的一句人话。
   *
   * **永不报出分数、比例、档位阈值**：那是内感受铁律（手册 §4.3 / P0 第 3 条）的
   * 同一条纪律——「你还差 0.13 分」这种话一说出口，用户就开始刷数据了。
   * 这里只给方向（「多聊聊你白天干了什么」），不给刻度。
   */
  readonly hint: string
  /** 里程碑状态（固定六条）。 */
  readonly milestones: readonly MilestoneView[]
  /** 刚达成、还没庆祝过的里程碑（应用外壳据此播报一次）；空数组表示没有。 */
  readonly fresh: readonly MilestoneView[]
  /** 视图时刻。 */
  readonly at: number
  /** 用了哪几个上游（缺席的记进 `missing`，供体检面板解释读数为什么偏低）。 */
  readonly missing: readonly string[]
}

/** 不可用原因。 */
export type GrowUnavailableReason =
  /** 总开关被关。 */
  | 'disabled'
  /** 阶段服务与记忆服务同时缺席：四项里只有天数能算，等于瞎猜。 */
  | 'no-source'

/** 落盘的「已庆祝里程碑」状态。 */
export interface GrowState {
  /** 存档版本。 */
  readonly version: number
  /** 已庆祝的里程碑 id（顺序即庆祝顺序）。 */
  readonly celebrated: readonly MilestoneId[]
  /** 最近一次庆祝的时刻（0 表示从未）。 */
  readonly lastCelebratedAt: number
}

/** 统计快照。 */
export interface GrowStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 已庆祝的里程碑数。 */
  readonly celebratedCount: number
  /** 当前档位。 */
  readonly level: GrowLevel
  /** 里程分。 */
  readonly score: number
  /** 最近一次计算用了几个上游（0–4）。 */
  readonly sources: number
  /** 累计计算次数。 */
  readonly computes: number
  /** 落盘失败次数（不阻断，只记账）。 */
  readonly writeFailures: number
}

/** 错误码。**只用闭集内的值**，不临时编新码。 */
export type GrowErrorCode = 'bad-request' | 'no-source' | 'write-failed' | 'read-failed'

/** 养成服务错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class GrowError extends Error {
  /** 错误码。 */
  readonly code: GrowErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: GrowErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'GrowError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface GrowService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GrowUnavailableReason

  /**
   * 取当前养成快照。**只读**：不推进任何状态、不写任何东西。
   * @param at 时刻。
   */
  view(at?: number): GrowView

  /** 五档表（全量，给应用外壳画进度条分母用）。 */
  levels(): readonly LevelSpec[]

  /** 里程碑表（全量）。 */
  milestones(): readonly MilestoneSpec[]

  /**
   * 把一批里程碑标记为「已庆祝」。**唯一写动作**，且只写「庆祝过」这件事。
   * @param ids 里程碑 id 列表；未知 id 静默丢弃。
   * @param at 时刻。
   * @returns 落盘是否成功。
   */
  ack(ids: readonly MilestoneId[], at?: number): boolean

  /** 统计快照。 */
  stats(): GrowStats
}

/* ------------------------------------------------------------------ *
 * 宿主相邻服务的结构对位（§15.5：不 import 源码）
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

/** O-002 路径服务的结构对位子集。目录归它建，本插件不自己 mkdir。 */
export interface PathLike {
  readonly display: string
  ensure(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
}

/** O-003 时钟服务的结构对位子集（只要「现在」）。 */
export interface ClockLike {
  now(): number
  dayNumber(epoch?: number): number
}

/**
 * O-031 `ondra-emotion-stage` 的结构对位子集。
 *
 * 只取两样：关系四维快照（要 `days` / `interactions`）与阶段快照（要 `base` / `spec`）。
 * **不取 `adjust()`**：养成不许改关系，那是 O-031 与 O-029 的事。
 */
export interface StageLike {
  readonly available: boolean
  view(at?: number, locked?: boolean): StageViewLike
  relation(at?: number): RelationLike
}

/** 阶段快照的最小形状。 */
export interface StageViewLike {
  /** 棘轮底座阶 id。 */
  readonly base: string
  /** 该阶定义（要 `order` 与 `zh`）。 */
  readonly spec: { readonly order: number; readonly zh: string }
}

/** 关系四维的最小形状（只取养成用得上的两项）。 */
export interface RelationLike {
  /** 相处天数。 */
  readonly days: number
  /** 累计互动次数。 */
  readonly interactions: number
}

/**
 * O-010 `ondra-memory-core` 的结构对位子集。
 *
 * 只取 `countFacts`：养成只要「攒了多少条」，**不要正文**。
 * 拿正文来算字数、算关键词都会把隐私面与计算量一起放大，
 * 而「攒了多少条」已经足够表达养成感。
 */
export interface MemoryLike {
  readonly available: boolean
  countFacts(query?: { readonly state?: 'active' | 'archived' | 'sealed' }): number
}

/** O-005 段声明的结构对位子集。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置段声明的结构对位子集。 */
export interface ConfigSchemaLike {
  register(decl: SectionDeclLike, by?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number } | undefined
}

/** O-005 字段声明的结构对位子集。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}
