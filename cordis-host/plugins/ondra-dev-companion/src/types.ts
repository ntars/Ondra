/**
 * O-110 `ondra-dev-companion` 的对外契约（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「主人正卡在一件事上，她该不该出声？出声说什么？」**
 *
 * 只回答这一句。发不发、发到哪、用什么语气，全部不归这里。
 *
 * ## 为什么这一块必须自研
 *
 * 「陪伴」的难点不是说什么，而是**什么时候不说**。这一块的判据没有现成的开源实现可抄：
 * 现有的开发陪伴工具（番茄钟、CI 通知、编辑器的鼓励插件）全是「事件到了就响」，
 * 而这里最要紧的恰恰相反——**事件到了先想该不该响**。
 *
 * ## 五条硬纪律
 *
 * 1. **不报任何数字。** 不报失败几次、跑了多久、改了几行。§12.1 的禁报数铁律：
 *    一旦有「今天失败 7 次」，就会有人为这个数字去调行为。
 * 2. **失败后的安静期里一个字都不说。** 人在改代码，任何一句都是干扰。
 *    这条不是礼貌，是判据：`quietAfterFailMs` 内 `cue()` 恒为 `quiet`。
 * 3. **同一条错误咬久了，不许催「再试一次」。** 催是索取，劝放下才是陪伴。
 *    故 `streak >= stuckFails` 且跨度够长时，唯一允许的调门是「先放下」。
 * 4. **不读代码、不读 diff、不点评实现。** 这不是代码审查插件；而且代码是雇主的资产，
 *    搬进记忆库是另一类问题。本插件只认外壳给的**事件枚举**与一个**不透明指纹**。
 * 5. **在场状态不明时不说话。** 开会、人不在、读不到——一律闭嘴。
 *    「不知道」不等于「可以随便说」。
 *
 * ## 只认枚举与不透明指纹
 *
 * `fingerprint` 由外壳给（短哈希即可）。本插件**不解释它、不落盘、不打日志**，
 * 只做一件事：判等。于是「同一个错」这个判断成立，而磁盘上不会留下任何代码痕迹。
 *
 * ## 与 O-109 的共享形状（§15.3 / §15.5）
 *
 * 本包**不 import** `ondra-screen-sense` 的源码：按 §15.5，任一包单独卸载，
 * 另一包都不该编译失败。故这里只做**结构对位**——字段名与取值闭集必须与
 * O-109 `src/types.ts` 一致，不新增、不改名。改一处要两边一起改。
 *
 * ## 明确不做
 *
 * 不做代码审查、不读稿件与日志正文、不做界面、不装定时器（安静期靠时刻比较，
 * 不靠 `setTimeout`）、不主动发消息（归 O-042 六道闸）、不做工时统计（归 O-105）。
 */

/** 本插件注册的服务键（连字符，非 `ondra:dev-companion`）。全仓唯一归属。 */
export const DEV_COMPANION_SERVICE_KEY = 'ondra-dev-companion'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号会在**运行期**被模型侧拒绝。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（落在 `user/` 区域）。 */
export const STATE_FILE_NAME = 'dev-companion.json'

/** 存档版本。改了结构必须加一。 */
export const STATE_VERSION = 1

/**
 * 事件类型（闭集）。
 *
 * 刻意只有六个，且全是「机器给出的确定事实」：编译开始 / 编译结束 / 测试结束 /
 * 长任务开始 / 长任务结束 / 提交。**没有 `error` 这种模糊事件**——
 * 一个叫 `error` 的类型最后一定会被塞进所有不舒服的东西。
 */
export type DevEventKind =
  | 'build-start'
  | 'build-end'
  | 'test-end'
  | 'run-start'
  | 'run-end'
  | 'commit'

const KIND_LIST: readonly DevEventKind[] = [
  'build-start',
  'build-end',
  'test-end',
  'run-start',
  'run-end',
  'commit',
]

/** 六个事件类型（只读，供外壳与自检枚举）。 */
export const DEV_EVENT_KINDS: readonly DevEventKind[] = Object.freeze(KIND_LIST)

/**
 * 结果（闭集）。
 *
 * `unknown` 是**必须存在的**：长任务结束、提交这些事件没有「成功 / 失败」可言，
 * 硬塞一个 `pass` 会让「绿了」这件事变得廉价。
 */
export type DevOutcome = 'pass' | 'fail' | 'unknown'

/**
 * 事件。
 *
 * `fingerprint` 是外壳给的**短哈希**，用来判「是不是同一个错」。
 * 本插件不解释它、不落盘、不打日志——只做判等。
 */
export interface DevEvent {
  /** 事件类型。 */
  readonly kind: DevEventKind
  /** 结果；`build-end` / `test-end` 之外可省（按 `unknown`）。 */
  readonly outcome?: DevOutcome
  /** 不透明指纹（判等用）。**不落盘、不解释。** */
  readonly fingerprint?: string
  /** 时刻，省略用系统时间。 */
  readonly at?: number
}

/** 调门（闭集）。`quiet` 是**正常结果**，不是失败。 */
export type DevTone = 'quiet' | 'companion' | 'release' | 'celebrate'

const TONE_LIST: readonly DevTone[] = ['quiet', 'companion', 'release', 'celebrate']

/** 四个调门（只读）。 */
export const DEV_TONES: readonly DevTone[] = Object.freeze(TONE_LIST)

/**
 * 不开口的原因（闭集）。
 *
 * 单独列出来是因为**「安静」有十几种含义**：人在改、会议中、人不在、读不到、
 * 刚说过、什么都没发生。折进一个 `quiet` 之后，外壳就再也查不出
 * 「为什么她今天一句话都没说」——而那是最常发生的投诉。
 */
export type DevReason =
  | 'disabled'
  | 'no-events'
  | 'meeting'
  | 'absent'
  | 'unreadable-presence'
  | 'just-failed'
  | 'cooling'
  | 'nothing-new'
  | 'stuck'
  | 'first-green'
  | 'run-done'

/** 判定口径（毫秒 / 次数）。由配置换算后交给纯函数。 */
export interface DevPolicy {
  /** 失败后的安静期（毫秒）。 */
  readonly quietAfterFailMs: number
  /** 判「咬住了」所需的连续失败次数。 */
  readonly stuckFails: number
  /** 判「咬久了」所需的最短跨度（毫秒）。 */
  readonly stuckSpanMs: number
  /** 「绿了」的冷却（毫秒）。 */
  readonly celebrateCooldownMs: number
  /** 两次非静默出声之间的最小间隔（毫秒）。 */
  readonly cueCooldownMs: number
  /** 是否参考 O-109 的在场状态。 */
  readonly respectPresence: boolean
}

/**
 * 一句该说 / 不该说的话。
 *
 * **`say` 里一个数字都没有，`tone==='quiet'` 时必为 `null`。**
 */
export interface DevCue {
  /** 调门。 */
  readonly tone: DevTone
  /** 一句中文；不该说话时为 `null`。 */
  readonly say: string | null
  /** 绝对不许做的事。**恒定五条，每一档都在。** */
  readonly mustNot: readonly string[]
  /** 是否建议先放下手里的活。只在 `release` 为真。 */
  readonly suggestBreak: boolean
  /** 为什么是这个调门。 */
  readonly reason: DevReason
  /** 一句中文，说明判据。不含数字。 */
  readonly note: string
}

/** 只读视图。**这里的数字只给外壳与调试，不许念出来。** */
export interface DevView {
  /** 最近一次结果。 */
  readonly lastOutcome: DevOutcome
  /** 当前连续失败次数（同一指纹）。**只在内存**，重启归零。 */
  readonly streak: number
  /** 累计失败次数（本次会话）。 */
  readonly fails: number
  /** 累计转绿次数（本次会话）。 */
  readonly passes: number
  /** 累计提交次数（本次会话）。 */
  readonly commits: number
  /** 距上次失败的毫秒数；没失败过为 `null`（**不是 0**）。 */
  readonly quietMs: number | null
  /** 是否判为「咬住了」。 */
  readonly stuck: boolean
  /** 被在场状态挡住的原因；没挡住为 `null`。取值与 `DevReason` 同一套词。 */
  readonly blockedByPresence: 'meeting' | 'absent' | 'unreadable-presence' | null
  /** 累计出声次数（不含静默）。 */
  readonly cues: number
  /** 台账是否真的落盘。`false` = 重启后「说过没」会重来。 */
  readonly stored: boolean
}

/** 累计统计。**只在内存**，不落盘。 */
export interface DevStats {
  /** 接受的事件数。 */
  readonly events: number
  /** 被拒绝的事件数（类型不在闭集 / 时刻不合法）。 */
  readonly rejected: number
  /** 各调门累计次数。 */
  readonly tones: Readonly<Record<DevTone, number>>
  /** 重来次数。 */
  readonly restarts: number
  /** 成功写盘次数。 */
  readonly writes: number
  /** 写盘失败次数。 */
  readonly writeFailures: number
  /** 台账是否真的落盘。 */
  readonly stored: boolean
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type DevErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（事件类型不在闭集、时刻不是有限正数）。 */
  | 'bad-request'

/** 开发者陪伴错误。带稳定错误码，消费方可按码分支。 */
export class DevError extends Error {
  /** 错误码。 */
  readonly code: DevErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: DevErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'DevError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface DevCompanionService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DevErrorCode
  /** 台账是否真的落盘。 */
  readonly stored: boolean

  /**
   * 记一个事件。**唯一会写盘的入口之一。**
   * @param event 事件。
   * @param at 时刻，省略用系统时间。
   */
  note(event: DevEvent, at?: number): DevView

  /** 只读判定。**不写盘、不推进。** */
  cue(at?: number): DevCue

  /**
   * 记一次「已经真的说出去了」。
   *
   * 必须由**把话交出去的那一方**调。外壳若在轮询时顺手调，冷却会被白白吃掉，
   * 于是下一句该说的话永远发不出来。
   * @param tone 说出去的调门。
   * @param at 时刻。
   */
  ack(tone: DevTone, at?: number): DevView

  /** 只读视图。**不写盘、不推进。** */
  view(at?: number): DevView

  /** 重来一遍（换人）。清空会话内判定，`restarts` 加一。 */
  reset(at?: number): DevView

  /** 累计统计快照。 */
  stats(): DevStats
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * §15.5：相邻服务一律经服务键调用，不 import 源码。
 * ------------------------------------------------------------------ */

/**
 * O-109 在场状态的结构对位。
 *
 * **取值闭集必须与 `ondra-screen-sense/src/types.ts` 的 `PresenceState` 完全一致。**
 * `category` 故意写成 `string`：本包只跟一个值 `'meeting'` 比较，
 * 不去枚举别人的类目——枚举一份就等于多一个会走样的真源。
 */
export interface ScreenPresenceLike {
  readonly state: 'unknown' | 'idle' | 'scattered' | 'focused' | 'wandering'
  readonly category: string
}

/** O-109 服务的结构对位子集（只读一次视图）。 */
export interface ScreenSenseLike {
  view(at?: number): ScreenPresenceLike
}

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

/** O-003 时钟服务的结构对位子集。 */
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
