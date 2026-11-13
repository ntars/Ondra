/**
 * O-027 `ondra-emotion-diffuse` 的对外契约。
 *
 * 定位：**跨会话的情绪残留计算器**，不是情绪的持有者，也不是情绪的表达者。
 *
 * 三件必须先说清的事：
 *
 * 1. **公式只有一个，来自手册 §9.1 的参数速查表**：
 *    `(mood − baseline) × 0.4 × (1 − familiarity × 0.5)`。
 *    本插件把它读成「上一次会话结束时的心情，有多少比例会带进这一次会话」：
 *    `残留 = (mood − baseline) × 保留比例`，
 *    `保留比例 = 0.4 × (1 − familiarity × 0.5)`。
 *    `familiarity = 0`（陌生人）时保留 0.4，`familiarity = 1`（极熟）时保留 0.2。
 *
 *    **为什么不写成「心情 = 基线 + 残差」以外的读法**：如果读成 `mood += 残差`，
 *    那么 mood 已经是 1 的时候会算出 1.08 再被夹回 1——同一次弥散，离基线近的人几乎不动，
 *    顶到天花板的人一点没降。那个形态不是「弥散」，是「涨潮」。
 *
 * 2. **本插件绝不写情绪状态**（器官 ABI 的 C1：只提议，不落笔）。
 *    `claim()` 只交出「应该把 mood 设成多少」，`applied` 的类型写成字面量 `false`——
 *    想改成 `true` 必须先改类型，改不动就说明这活不该本插件干。
 *    落笔是调用方的事（会话边界那一层），它拿到 `target` 调 O-026 的 `setAxis('mood', target)`。
 *
 *    **为什么不用 `feel({ mood: delta })`**：O-026 的 `feel()` 会把增量按
 *    「心情比心情绪慢」的耦合系数压小，还会吃 0.12 的单条上限。
 *    弥散不是「发生了一件事」，是「换了一场对话」的结算，
 *    走事件通道就永远算不出公式给的那个数。故 `applyPath` 固定为 `'set-axis'`。
 *
 * 3. **只作用于心情一维**。公式里只有 mood。张力有它自己的生命周期（O-030 的锁、
 *    O-026 的 24 小时半衰），能量归 O-048。往这儿多塞一维，
 *    就会有两个地方各自决定「她一觉醒来还剩多少脾气」。
 */

/** 本插件注册的服务键（连字符，符合 §8.4）。全仓唯一归属。 */
export const DIFFUSE_SERVICE_KEY = 'ondra-emotion-diffuse'

/** 弥散系数（手册 §9.1 原式里的 0.4）。产品口径，不做成配置项。 */
export const DIFFUSE_COEFF = 0.4

/** 熟悉度对残留的抑制系数（原式里的 0.5）。产品口径，不做成配置项。 */
export const FAMILIARITY_DAMP = 0.5

/**
 * 心情基线，0–1。
 *
 * **镜像** O-026 `AXIS_SPEC.mood.baseline` 的取值（0.5），不是 import 来的——
 * §18.5 禁止插件间互相 import 源码。两处必须人工同步，改一处要同改另一处；
 * 若哪天 O-026 把基线做成可配，这里是第一个要跟着改的地方。
 */
export const MOOD_BASELINE = 0.5

/** 心情的取值范围。 */
export const MOOD_MIN = 0
/** 心情的取值范围。 */
export const MOOD_MAX = 1

/**
 * 一次弥散计算的结果（**纯算，不碰任何状态**）。
 *
 * `preview()` 返回它，用来在界面上回答「如果现在换会话，她的心情会落到哪」。
 */
export interface DiffusePreview {
  /** 计算时刻。 */
  readonly at: number
  /** 参与计算的熟悉度（已夹到 0–1）。 */
  readonly familiarity: number
  /** 保留比例：0.2–0.4。 */
  readonly retain: number
  /** 弥散前的心情。 */
  readonly moodBefore: number
  /** 心情基线。 */
  readonly baseline: number
  /** 弥散后的目标心情。 */
  readonly target: number
  /** 目标减现值。负数表示往回落，正数表示往上抬（mood 低于基线时会出现）。 */
  readonly delta: number
}

/** 一次弥散提领的状态码。 */
export type DiffuseStatus =
  /** 正常算出了结果，并且已记下这次边界。 */
  | 'diffused'
  /** 同一个边界已经提领过——重复调用不会二次衰减。 */
  | 'already'
  /** 距上次弥散不足 `minGapMinutes`，判定为同一场会话。 */
  | 'no-gap'
  /** 情绪内核缺席或不可用。 */
  | 'no-emotion'
  /** 配置关掉了。 */
  | 'disabled'
  /** 入参不合法（缺边界键、熟悉度不是有限数）。 */
  | 'bad-request'

/**
 * 一次弥散提领的完整结果。
 *
 * `applied` 是字面量 `false`：本插件不落笔。调用方读 `target` 自己去设。
 */
export interface DiffusePlan extends DiffusePreview {
  /** 状态码。 */
  readonly status: DiffuseStatus
  /** 边界键。幂等靠它。 */
  readonly boundaryKey: string
  /** 距上次弥散提领的分钟数（首次为 `Infinity` 之外的哨兵值，见下）。 */
  readonly gapMinutes: number
  /** 固定为 `false`——本插件永不写情绪。 */
  readonly applied: false
  /** 建议的落笔路径。固定 `set-axis`，理由见文件头第 2 条。 */
  readonly applyPath: 'set-axis'
  /** 人话说明，只给日志与面板，不进提示词。 */
  readonly note: string
}

/** 一次提领的入参。 */
export interface DiffuseRequest {
  /**
   * 会话边界键。幂等键，由调用方给（例如日期键、会话 id）。
   *
   * **为什么必须有**：没有它，同一场会话里调两次就会把残差乘两遍（0.4 → 0.16），
   * 越聊越接近基线，而现象是「她越聊越淡」——没人会想到是弥散算了两遍。
   */
  readonly boundaryKey: string
  /** 熟悉度 0–1。缺省 0（出厂值，见 master-plan §9.1）。越界自动夹紧。 */
  readonly familiarity?: number
  /** 计算时刻，省略用系统时间。 */
  readonly at?: number
}

/** 不可用原因。 */
export type DiffuseUnavailableReason =
  /** 配置关掉了。 */
  | 'disabled'
  /** 情绪内核缺席（没装 O-026）。 */
  | 'no-emotion'
  /** 情绪内核装了但自报不可用（多半是没存储）。 */
  | 'emotion-unavailable'
  /** 没有存储端口：标记只在内存，重启后可能重算一次。 */
  | 'no-store'
  /**
   * 建表失败：存储端口在位，但标记表没建出来。
   *
   * 第 16 轮补这一档。此前建表失败复用 `'no-store'`，于是「磁盘写满导致
   * `ensureTable` 抛错」与「压根没装存储插件」报同一个原因码——前者要清磁盘、
   * 后者要检查装载，处置方式完全不同，却压成一个词。
   *
   * 对照 O-028 `StageUnavailableReason` 一直有 `'schema-failed'`，
   * 本插件是唯一缺这一档的，属漏写而非取舍。
   */
  | 'schema-failed'

/** 累计计数（**只在内存**，进程重启归零）。 */
export interface DiffuseCounters {
  /** 成功提领次数。 */
  readonly claims: number
  /** 同边界重复提领次数。 */
  readonly duplicates: number
  /** 因间隔太短被跳过次数。 */
  readonly tooSoon: number
  /** 因没有情绪内核被跳过次数。 */
  readonly noEmotion: number
}

/** 统计快照，供自检与成长面板（O-124）读取。 */
export interface DiffuseStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DiffuseUnavailableReason
  /** 标记落在哪（`none` 表示只在内存）。 */
  readonly storeProvider: string
  /** 最近一次成功提领的时刻（0 表示还没有过）。 */
  readonly lastClaimAt: number
  /** 最近一次成功提领的边界键（空串表示还没有过）。 */
  readonly lastBoundaryKey: string
  /** 累计计数。 */
  readonly counters: DiffuseCounters
  /** 最近一次错误（成功一次就清空）。 */
  readonly lastError?: string
}

/** 弥散服务。 */
export interface DiffuseService {
  /** 是否可用（不可用时 `claim()` 返回带原因码的拒绝，不抛错）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DiffuseUnavailableReason

  /**
   * 纯计算：如果现在换会话，心情会落到哪。**不读也不写任何状态**。
   * @param familiarity 熟悉度 0–1。
   * @param at 计算时刻。
   */
  preview(familiarity?: number, at?: number): DiffusePreview

  /**
   * 提领一次弥散额度：算出结果、记下边界、返回建议。
   *
   * **不写情绪**。同一个 `boundaryKey` 第二次调用返回 `already`，
   * 距上次不足 `minGapMinutes` 返回 `no-gap`——两条闸都是防「越聊越淡」。
   * @param request 入参。
   */
  claim(request: DiffuseRequest): DiffusePlan

  /** 保留比例：`0.4 × (1 − familiarity × 0.5)`。纯函数，给面板算「她这次带多少过来」。 */
  retainOf(familiarity: number): number

  /** 统计快照。 */
  stats(): DiffuseStats
}

/** 错误码。 */
export type DiffuseErrorCode = 'bad-request' | 'write-failed'

/** 弥散错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class DiffuseError extends Error {
  /** 错误码。 */
  readonly code: DiffuseErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: DiffuseErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'DiffuseError'
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

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/**
 * O-026 情绪内核的结构对位子集。
 *
 * 只取两样：`state()` 拿心情现值、`available` 判能不能用。
 * **刻意不取 `setAxis()`**：本插件不写情绪，接口上先把它拿掉，
 * 以免日后有人「顺手」在这里落笔。
 */
export interface EmotionLike {
  readonly available: boolean
  state(at?: number): EmotionSnapshotLike
}

/** O-026 快照的结构对位子集（只取六维那张表）。 */
export interface EmotionSnapshotLike {
  readonly at: number
  readonly axes: Readonly<Record<string, number>>
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
  /** 数字读数的量纲（天 / 分钟 / 毫秒 / 字 / 轮）。空表示无量纲。 */
  readonly unit?: string
}

/* ------------------------------------------------------------------ *
 * 存储端口的结构对位（只够建一张单行标记表）
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
