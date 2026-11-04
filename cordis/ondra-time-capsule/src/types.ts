/**
 * O-101 `ondra-time-capsule` 的对外契约：**写给未来某一天的信**。
 *
 * ## 与「待办 / 承诺」的界线（本文件第一条要划清的线）
 *
 * O-021 `ondra-memory-prospective` 已经管了「明天提醒我」。胶囊若也能写「明天」，
 * 就成了第四套提醒口径。故本插件设下限 `MIN_HOLD_DAYS = 7`：
 *
 * - 依据：master-plan §9.3 的承诺时间词闭集是
 *   `后天 / 明天 / 大后天 / 下周 / 周末 / 今晚 / 晚上 / 一会儿 / 下次`，
 *   其中**最远的「下周」约 7 天**。胶囊从 7 天起，两边时段不重叠、语义不打架。
 * - 少于 7 天的一律拒收并说清「这条该写进待办」，而不是悄悄按 7 天算——
 *   悄悄改日期比拒收更糟：用户会以为它按自己说的时间开。
 *
 * ## 封存期内为什么一个字都读不到（结构性不可读）
 *
 * `CapsuleView.text` 在未开启时**恒为 `null`**，且不是靠文档约定：
 * 取值走 `viewOf()` 一处投影，`list()` / `due()` 全部经它，没有第二条路能拿到正文。
 * 理由有两条，任何一条都足以否掉「先存着、只是不显示」的做法：
 *
 * 1. **正文一旦进了召回管线，胶囊就失效了。** 记忆库的东西会被 O-014 检索、
 *    被 O-036 注入，那么「到期才看见」的体验第一天就没了。
 * 2. **模型读得到的秘密不算秘密。** 只要正文在上下文里出现过，用户写给自己
 *    的那些话就随时可能被说漏。
 *
 * ## 开启那一刻真源搬家（不做第二份正文）
 *
 * 未开启时，正文的唯一副本在本插件的 `user/time-capsule.json`。
 * 开启时按「**先写记忆成功 → 再抹本地正文**」的顺序走：
 *
 * - 写成功：正文归 O-010 `memory_fact` 所有，本地只留 `factId` 与 `openedAt`，正文置空；
 * - 写失败：**什么都不抹**，胶囊仍是「到期待开」，下次可重试。
 *
 * 反过来（先抹再写）一旦写失败，用户写给自己的那封信就凭空消失了，
 * 而日志里只有一行「写记忆失败」——这是最不可接受的一种坏。
 *
 * ## 与其他插件的关系
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（master-plan §15.5 / 18.5），全部结构对位镜像。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。全仓唯一归属。 */
export const TIME_CAPSULE_SERVICE_KEY = 'ondra-time-capsule'

/** 胶囊状态。闭集，**只用这三个值**。 */
export const CAPSULE_STATES = ['locked', 'due', 'opened'] as const

/**
 * 一个胶囊的状态。
 *
 * - `locked`：未到那天，正文不可读；
 * - `due`：已到那天但还没开，正文仍不可读（**要人主动开**，不自动拆封）；
 * - `opened`：已开启，正文已转交 O-010，本地只剩 `factId`。
 */
export type CapsuleState = (typeof CAPSULE_STATES)[number]

/**
 * 胶囊最短封存天数。**不是配置项**（见文件头「与待办承诺的界线」）。
 *
 * 值 7 的依据是 master-plan §9.3 承诺时间词的最远跨度（「下周」≈7 天），
 * 目的是让两套机制时段不重叠，不是拍脑袋取个整数。
 */
export const MIN_HOLD_DAYS = 7

/** 胶囊最长封存天数（10 年）。超过这个数的多半是手滑写错年份。 */
export const MAX_HOLD_DAYS = 3650

/** 单个胶囊正文字数下限。一两个字构不成「信」。 */
export const MIN_TEXT_CHARS = 10

/** 单个胶囊正文字数**默认**上限（配置项 `maxTextChars` 可调，见 `settings.ts`）。 */
export const DEFAULT_MAX_TEXT_CHARS = 2000

/** 正文字数上限的硬顶。再长就该落成记忆文件，而不是一封信。 */
export const MAX_TEXT_CHARS_CEILING = 8000

/** 标题长度上限。标题只给清单用，不参与正文。 */
export const MAX_TITLE_CHARS = 40

/** 胶囊数量默认上限（配置项 `maxCapsules` 可调）。 */
export const DEFAULT_MAX_CAPSULES = 60

/** 胶囊数量硬顶。到了这个量，人该先开封一批。 */
export const MAX_CAPSULES_CEILING = 500

/** 存档版本。字段形状变了就 +1，读旧版按缺省补。 */
export const STATE_VERSION = 1

/** 状态文件名（落在 `user/` 区域下）。 */
export const STATE_FILE = 'time-capsule.json'

/** 胶囊 id 正则。与记忆 id 同一把尺子（手册 §8.4），因为 id 会被界面与工具参数看见。 */
export const CAPSULE_ID_RE = /^c-[0-9a-z]{4,20}-[0-9]{1,4}$/

/** 一件错误。**每一种都带中文 `detail`，直接给人看**。 */
export class CapsuleError extends Error {
  /** 错误码。闭集。 */
  readonly code: CapsuleErrorCode

  /**
   * @param code 错误码。
   * @param detail 中文说明。
   */
  constructor(code: CapsuleErrorCode, detail: string) {
    super(detail)
    this.name = 'CapsuleError'
    this.code = code
  }
}

/**
 * 错误码闭集。
 *
 * 刻意没有「未知错误」一档：任何走到未知分支的情况都说明本插件有 bug，
 * 那时应该让它抛出来被日志抓住，而不是包成一个看起来正常的码。
 */
export const CAPSULE_ERROR_CODES = [
  /** 配置关掉了。 */
  'disabled',
  /** 正文太短。 */
  'text-too-short',
  /** 正文太长。 */
  'text-too-long',
  /** 开封日期早于下限（该写待办）或晚于上限。 */
  'bad-date',
  /** `openAt` 与 `afterDays` 同时给了，或都没给。 */
  'bad-input',
  /** 未到那天，不许开。 */
  'not-due',
  /** 已经开过了。 */
  'already-opened',
  /** 找不到这颗胶囊。 */
  'not-found',
  /** 数量到上限。 */
  'too-many',
  /** 缺少确认令牌（删除不可逆）。 */
  'confirmation-required',
  /** 无法确定「今天是哪一天」（时钟与本地日历都不可用）。 */
  'no-calendar',
] as const

/** 错误码。 */
export type CapsuleErrorCode = (typeof CAPSULE_ERROR_CODES)[number]

/** 不可用原因（`available=false` 时必有一个）。 */
export type CapsuleUnavailableReason =
  /** 配置关掉了。 */
  | 'disabled'

/** 建一颗胶囊的入参。`openAt` 与 `afterDays` **二选一**。 */
export interface CapsuleInput {
  /** 正文。至少 `MIN_TEXT_CHARS` 字。 */
  readonly text: string
  /** 标题（清单里显示，不参与正文）。 */
  readonly title?: string
  /** 开封的自然日（该日 00:00 起可开）。与 `afterDays` 二选一。 */
  readonly openAt?: number
  /** 相对今天多少天后开封。与 `openAt` 二选一。 */
  readonly afterDays?: number
}

/** 一颗胶囊的对外视图。 */
export interface CapsuleView {
  /** id。 */
  readonly id: string
  /** 标题。没写则用正文首句截断（截断只在生成视图时发生，不改存档）。 */
  readonly title: string
  /** 状态。 */
  readonly state: CapsuleState
  /** 开封的自然日键 `YYYY-MM-DD`。 */
  readonly openDay: string
  /** 开封时刻（该自然日 00:00）。 */
  readonly openAt: number
  /** 距离可开还有几个自然日；`due` / `opened` 时为 0。 */
  readonly daysLeft: number
  /** 写入时刻。 */
  readonly createdAt: number
  /** 开启时刻；未开启为 0。 */
  readonly openedAt: number
  /** 开启后落在记忆库里的 id；未开启或写记忆失败为 `null`。 */
  readonly factId: string | null
  /**
   * 正文。**`locked` 与 `due` 时恒为 `null`**。
   *
   * 这不是「不返回」的省略，而是结构性不可读：未开启的正文根本不出现在任何视图里。
   */
  readonly text: string | null
}

/** 一次开启的结果。 */
export interface OpenOutcome {
  /** 胶囊 id。 */
  readonly id: string
  /** 取到的正文。 */
  readonly text: string
  /** 是否真的开了（写记忆成功才算开）。 */
  readonly opened: boolean
  /** 落在记忆库里的 id；写记忆失败为 `null`，此时胶囊仍是到期待开。 */
  readonly factId: string | null
  /** 开启时刻；未开成为 0。 */
  readonly openedAt: number
  /** 未开成的原因（中文，直接给人看）；开成为 `undefined`。 */
  readonly hint?: string
}

/** 统计快照。 */
export interface CapsuleStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: CapsuleUnavailableReason
  /** 状态是否真的落盘。`false` = 只在内存，重启全丢。 */
  readonly stored: boolean
  /** 存储后端标识：`json` / `memory`。 */
  readonly provider: string
  /** 各状态条数。 */
  readonly counts: {
    readonly locked: number
    readonly due: number
    readonly opened: number
    readonly total: number
  }
  /** 累计建了多少颗（含已删的）。 */
  readonly created: number
  /** 累计开成功多少颗。 */
  readonly openedCount: number
  /** 写记忆失败次数。**不为 0 说明有事没办成，必须让人看见**。 */
  readonly writeFailures: number
  /** 存档读写失败次数。 */
  readonly storeFailures: number
}

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

/**
 * O-003 时钟服务的结构对位子集。
 *
 * **全部按自然日算，不按毫秒算。** 胶囊写的是「某一天开」，不是「某毫秒开」；
 * 用毫秒比较会让「明天 00:00 写的、明天开」这种情形差一点开不了。
 */
export interface ClockLike {
  /** 当前毫秒时间戳。 */
  now(): number
  /** 自然日键 `YYYY-MM-DD`。 */
  dayKey(at?: number): string
  /** 自然日序号：同日恒定、跨日 +1（夏令时安全）。 */
  dayNumber(at?: number): number
  /** 两个时刻相差几个自然日（`b - a`）。 */
  daysBetween(a: number, b: number): number
  /** 某时刻所在自然日的 00:00。 */
  startOfDay(at?: number): number
}

/**
 * O-010 `ondra-memory-core` 的结构对位子集。
 *
 * **只取 `addFact()`**：胶囊只负责「把信交进记忆库」，之后这条记忆怎么衰减、
 * 怎么召回、怎么被删，全归 O-010 与 O-017。本插件不镜像 `revise()` / `forget()`——
 * 镜像一个写方法，就一定会有人从胶囊这边去改记忆正文。
 */
export interface MemoryCoreLike {
  readonly available: boolean
  /**
   * 写入一条事实。
   * @param input 入参。
   */
  addFact(input: {
    readonly kind: string
    readonly category: string
    readonly text: string
    readonly summary?: string
    readonly subject?: string
    readonly at?: number
  }): { readonly id: string }
}

/** O-002 路径服务的结构对位子集。目录归它建，本插件不自己 mkdir。 */
export interface PathLike {
  /** 数据根的**用户可见**写法（不暴露机器绝对路径）。 */
  readonly display: string
  /** 在某个区域下拼文件路径（不创建）。 */
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
}

/** O-005 字段声明的结构对位子集。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'json' | 'enum'
  readonly default: unknown
  readonly min?: number
  readonly max?: number
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/** O-005 段声明的结构对位子集。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(sectionId: string, layers?: { readonly user?: Readonly<Record<string, unknown>> }):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** 存档里的一颗胶囊（**内部形状，不外露**）。 */
export interface CapsuleRecord {
  /** id。 */
  readonly id: string
  /** 标题（可能为空串）。 */
  readonly title: string
  /** 正文。**开启成功后置为空串**（真源已搬到 O-010）。 */
  readonly text: string
  /** 开封时刻（自然日 00:00）。 */
  readonly openAt: number
  /** 写入时刻。 */
  readonly createdAt: number
  /** 开启时刻；0 = 未开启。 */
  readonly openedAt: number
  /** 记忆 id；`null` = 未开启。 */
  readonly factId: string | null
}

/** 存档整体。 */
export interface CapsuleArchive {
  /** 版本。 */
  readonly version: number
  /** 全部胶囊。 */
  readonly capsules: readonly CapsuleRecord[]
}

/** 时间胶囊服务。 */
export interface TimeCapsuleService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: CapsuleUnavailableReason

  /**
   * 封一颗胶囊。
   * @param input 入参（`openAt` / `afterDays` 二选一）。
   * @param at 参照时刻，省略取现在。
   */
  create(input: CapsuleInput, at?: number): CapsuleView

  /** 全部胶囊（未开启的正文恒为 `null`）。按开封日升序。 */
  list(at?: number): readonly CapsuleView[]

  /** 今天（及更早）可以开的胶囊。正文仍为 `null`——要人主动调 `open()`。 */
  due(at?: number): readonly CapsuleView[]

  /**
   * 拆开一颗胶囊：把正文交进记忆库，成功后本地正文置空。
   *
   * 未到那天抛 `not-due`（**不提供「现在就开」的口子**，否则胶囊就变成了便签）；
   * 已开过抛 `already-opened`。
   * @param id 胶囊 id。
   * @param at 时刻。
   */
  open(id: string, at?: number): OpenOutcome

  /**
   * 删掉一颗**未开启**的胶囊。**不可逆**（正文只有一个副本），必须给确认令牌。
   *
   * 已开启的胶囊调它只清清单记录，正文早已在记忆库，不受影响。
   * @param id 胶囊 id。
   * @param confirmation 必须为 `{ confirm: 'drop' }`。
   */
  drop(id: string, confirmation: { readonly confirm: 'drop' }): boolean

  /** 统计快照。 */
  stats(): CapsuleStats
}
