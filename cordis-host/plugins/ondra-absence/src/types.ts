/**
 * O-108 `ondra-absence` 的对外契约（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「隔了很久回来，第一句该怎么接？」**
 *
 * 只回答这一句。接什么话、用什么语气、发到哪个通道，全部不归这里。
 *
 * ## 为什么不是「欢迎回来」插件
 *
 * 空窗期是**最容易把关系做坏的一刻**。一个人三天没来，回来时最怕听到三句话：
 * 「你去哪了」（清算）、「你都不理我」（索取）、「我一直等着你」（施压）。
 * 三句都出自同一个念头——把缺席当成对自己的评价。所以本插件的主要产出
 * 不是「说什么」，而是**恒定的一组禁令**：不许问去哪了、不许报精确间隔、
 * 不许替空窗期编造情节、不许把缺席解读成被丢下。
 *
 * ## 五档分级的依据
 *
 * 依据是「对方还记不记得上次说了什么」，不是「我有多想你」：
 *
 * | 档 | 空窗 | 对方的状态 | 该怎么接 |
 * |---|---|---|---|
 * | `brief` | 几小时 | 上下文还在 | 直接接上，不提隔了多久 |
 * | `noticed` | 半天到一天 | 记得，但话头断了 | 可以轻提一句，不检讨 |
 * | `long` | 一到三天 | 记得人，忘了细节 | 承认隔了一段，给台阶 |
 * | `distant` | 三天到两周 | 记得有这么个人 | 先打招呼，把「还在」说清 |
 * | `stranger` | 两周以上 | 可能已经忘了 | 当重新认识的前半段，先报自己是谁 |
 *
 * ## 六条硬纪律
 *
 * 1. **不报精确间隔。** `greet()` 里**一个数字都没有**，只有 `coarse` 五个粗粒度词。
 *    `view()` 才有 `gapDays`，那是给外壳画时间轴与调试用的。精确到「我们 17 天没说话了」
 *    会把重逢变成审讯。
 * 2. **`askAboutGap` 的类型是字面量 `false`。** 不是 boolean——做成 boolean 就一定会有
 *    `true` 分支，而那个分支一定会在某次「关心一下」的改动里被打开。
 * 3. **不许假装没隔。** `long` 以上必须承认隔了一段（`mustAcknowledgeGap=true`）。
 *    假装没隔是撒谎，而人对「她假装没发现我消失了」格外敏感。
 * 4. **读一次不推进。** `greet()` 只读；`mention()` 才记「真的提过了」。
 *    外壳轮询时顺手记，会让「提过一次就不再提」这条规则永远不成立。
 * 5. **只存时刻与计数。** 不存上次聊了什么、不存离开原因、不存通道。
 * 6. **不做界面、不装定时器、不主动发消息。** 要不要在她回来之前主动找她，
 *    归 O-042 的静默与额度；本插件只管「她已经回来了」那一刻。
 *
 * ## 与 O-107 的共享形状（§15.3 / §15.5）
 *
 * `mustDo` / `mustNot` / `maxSentences` 这三项与 O-107 `ondra-first-meet` 的
 * `ScriptBeat` **同形**，但按 §15.5 **不 import 对方源码**：任一方单独卸载，
 * 另一方都不该编译失败。字段名与语义必须一致，改一处要两边一起改——
 * 这条写在这里，是为了下次改字段时能看见。
 *
 * ## 明确不做
 *
 * 不做「欢迎回来」动画或界面、不做考勤统计（连续打卡天数这类）、
 * 不评价用户离开得对不对劲、不在空窗期替她补写日记（O-049 的活）、不做多人分档。
 */

/** 本插件注册的服务键（连字符，非 `ondra:absence`）。全仓唯一归属。 */
export const ABSENCE_SERVICE_KEY = 'ondra-absence'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法会被模型侧直接拒绝，
 * 而且是在**运行期**才拒绝——写的时候一切正常，跑起来才发现插件没加载。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（落在 `user/` 区域）。 */
export const STATE_FILE_NAME = 'absence.json'

/** 存档版本。改了结构必须加一，否则旧档会被当新档读。 */
export const STATE_VERSION = 1

/**
 * 五档空窗（闭集）。
 *
 * 顺序即「越来越远」：`brief` 最近、`stranger` 最远。序在 `TIER_ORDER` 里，
 * 不让消费方自己排——自己排就一定有一处把 `distant` 写在 `long` 前面，
 * 而那种错只在某次长途旅行回来时触发，很难复现。
 */
export type AbsenceTier = 'brief' | 'noticed' | 'long' | 'distant' | 'stranger'

const TIER_LIST: readonly AbsenceTier[] = ['brief', 'noticed', 'long', 'distant', 'stranger']

/** 五档（只读，供外壳与自检枚举）。 */
export const ABSENCE_TIERS: readonly AbsenceTier[] = Object.freeze(TIER_LIST)

/** 档位序（取大与比较用）。 */
export const TIER_ORDER: Readonly<Record<AbsenceTier, number>> = Object.freeze({
  brief: 0,
  noticed: 1,
  long: 2,
  distant: 3,
  stranger: 4,
})

/**
 * 粗粒度间隔词（闭集）。
 *
 * **故意只到「一阵子」这一级。** 五个词覆盖全部五档，且都不含数字：
 * `greet()` 交出去的只有这五个之一，于是「报出精确天数」在类型层面就不可能。
 */
export type CoarseGap = 'today' | 'yesterday' | 'few-days' | 'a-while' | 'very-long'

const COARSE_LIST: readonly CoarseGap[] = ['today', 'yesterday', 'few-days', 'a-while', 'very-long']

/** 五个粗粒度词（只读）。 */
export const COARSE_GAPS: readonly CoarseGap[] = Object.freeze(COARSE_LIST)

/** 档位 → 粗粒度词。**一一对应，不做成可配**：多一个映射就多一处能报出天数的口子。 */
export const COARSE_OF: Readonly<Record<AbsenceTier, CoarseGap>> = Object.freeze({
  brief: 'today',
  noticed: 'yesterday',
  long: 'few-days',
  distant: 'a-while',
  stranger: 'very-long',
})

/** 只读视图。**这里的数字只给外壳与调试，不许念出来。** */
export interface AbsenceView {
  /** 第一次被看到活动的时刻；从没有过为 `null`。 */
  readonly firstSeenAt: number | null
  /** 最近一次活动时刻；从没有过为 `null`。 */
  readonly lastSeenAt: number | null
  /** 空窗毫秒数；从没有过为 `null`（**不是 0**：0 会被读成「刚刚才见过」）。 */
  readonly gapMs: number | null
  /** 空窗天数（向下取整）。从没有过为 `0`，配 `lastSeenAt === null` 一起看。 */
  readonly gapDays: number
  /** 档位；从没有过为 `null`。 */
  readonly tier: AbsenceTier | null
  /** 粗粒度词；从没有过为 `null`。 */
  readonly coarse: CoarseGap | null
  /** 累计记录活动次数。 */
  readonly touches: number
  /** 累计「真的提过一句」的次数。 */
  readonly mentions: number
  /** 状态是否真的落盘。`false` = 重启后当成第一次。 */
  readonly stored: boolean
}

/** 回归礼节课表。**没有任何数字，`askAboutGap` 的类型就是 `false`。** */
export interface RegreetPlan {
  /** 档位。 */
  readonly tier: AbsenceTier
  /** 粗粒度词（闭集之一）。 */
  readonly coarse: CoarseGap
  /** 中文标签（给日志与调试看，不是台词）。 */
  readonly coarseZh: string
  /** 必须做到的事。 */
  readonly mustDo: readonly string[]
  /** 绝对不许做的事。**恒定包含那四条通用禁令。** */
  readonly mustNot: readonly string[]
  /** 句数上限（1–3）。 */
  readonly maxSentences: number
  /** 是否允许一点撒娇式的温度（只有最近两档为真：远隔时撒娇就是索取）。 */
  readonly allowWarmth: boolean
  /** 是否必须承认「隔了一段」（`long` 以上恒为真）。 */
  readonly mustAcknowledgeGap: boolean
  /** **恒为 `false`**：不许追问对方去哪了。类型是字面量，没有打开它的口子。 */
  readonly askAboutGap: false
  /** 一句中文。**不含数字、不含台词。** */
  readonly note: string
}

/** 累计统计。**只在内存**，不落盘。 */
export interface AbsenceStats {
  /** 记录活动次数。 */
  readonly touches: number
  /** 真的提过的次数。 */
  readonly mentions: number
  /** 重来次数（换人 `reset()` 会加一）。 */
  readonly restarts: number
  /** 成功写盘次数。 */
  readonly writes: number
  /** 写盘失败次数。**不为 0 就说明重启会当成第一次见面。** */
  readonly writeFailures: number
  /** 状态是否真的落盘。 */
  readonly stored: boolean
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type AbsenceErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（时刻不是有限正数、档位不在闭集里）。 */
  | 'bad-request'

/** 空窗期礼仪错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class AbsenceError extends Error {
  /** 错误码。 */
  readonly code: AbsenceErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: AbsenceErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'AbsenceError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface AbsenceService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: AbsenceErrorCode
  /** 状态是否真的落盘。 */
  readonly stored: boolean

  /**
   * 记一次活动（用户说了话 / 打开对话）。**唯一会写盘的方法之一。**
   * @param at 时刻，省略用系统时间。
   */
  touch(at?: number): AbsenceView

  /** 只读视图。**不写盘、不推进。** */
  view(at?: number): AbsenceView

  /**
   * 只读课表。**不写盘、不推进。**
   *
   * 从没记录过任何活动时返回 `null`——那时「隔了多久」这个问题根本不成立，
   * 给一份 `brief` 的课表等于凭空断言「刚见过」。
   */
  greet(at?: number): RegreetPlan | null

  /**
   * 记一次「已经真的提了一句」。**必须由把话说出去的那一方调。**
   * @param tier 提到的是哪一档。
   * @param at 时刻。
   */
  mention(tier: AbsenceTier, at?: number): AbsenceView

  /** 重来一遍（换人）。清空全部记录，`restarts` 加一。 */
  reset(at?: number): AbsenceView

  /** 累计统计快照。 */
  stats(): AbsenceStats
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * §15.5：相邻服务一律经服务键调用，不 import 源码。
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

/** O-003 时钟服务的结构对位子集。**不重写日历**，只取这几项。 */
export interface ClockLike {
  now(): number
  dayKey(at?: number): string
}

/** O-002 路径服务的结构对位子集。 */
export interface PathLike {
  /** 数据根的用户可见写法（不暴露机器绝对路径）。 */
  readonly display: string
  /** 在某个区域下拼文件路径（不创建）。 */
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
}

/** O-005 字段声明的结构对位子集。 */
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

/** O-005 段声明的结构对位。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 解析结果的结构对位。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 配置真源服务的结构对位。 */
export interface ConfigSchemaLike {
  register(decl: SectionDeclLike, by?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
