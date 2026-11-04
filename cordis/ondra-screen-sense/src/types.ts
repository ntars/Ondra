/**
 * O-109 `ondra-screen-sense` 的对外契约（〔薄〕薄封装，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「她大概知道主人正在跟什么东西打交道吗？」**
 *
 * 只到**类目**这一级，且只在能把类目说准的时候才说。
 *
 * ## 为什么是「薄封装」而不是自研视觉
 *
 * 截屏要系统权限与原生模块，OCR 与画面理解归 O-126 `ondra-vision`。
 * 本插件**两者都不做**：
 *
 * - **不截屏。** 一个「陪伴」插件没有任何理由拥有读屏权限。权限一旦被给出，
 *   就再也收不回来，而它换来的只是「她大概知道你在写东西」。
 * - **不调 `ondra-vision` 认屏幕。** 那条路的输入是图片地址，意味着画面要先落成文件、
 *   再发出去。它的注释写得很清楚：「出站就等于把用户的屏幕发给别人」。
 *   本插件只接**已经被归好类的类目枚举**，从头到尾不碰一个像素。
 *
 * 所以它是一个接线 + 护栏 + 降级层：类目由外壳给出（外壳才有取窗口信息的权限，
 * 也才应该承担那个权限的说明义务），本插件负责节流、抖动吸收、在场判定与「什么不能说」。
 *
 * ## 五条硬纪律
 *
 * 1. **`unknown` 不是 `idle`。** 读不到 ≠ 人不在。把没权限当成「她离开了」，
 *    会让外壳显示一份看起来正常的「她不在」，而这正是最难被发现的那类错误。
 *    故两者是**两个不同的状态**，且 `unknown` 时 `dwellMs` 为 `null` 而不是 `0`。
 * 2. **不存标题、应用名、文件路径、网址、截图。** 存档里只有时刻与计数。
 *    一个「在场感」如果记得你在看哪个文件，它就已经是监视器了。
 * 3. **`say` 里一个数字都没有。** 不报「用了两小时」，不报「切了 9 次窗口」。
 *    时长归 O-105 的健康护栏，报数归 O-032 的禁报数铁律。
 * 4. **只有五个类目里三个会出声，且只在 `focused` 时出声。** 会议中、看片时、
 *    切换中、人不在、读不到——一律 `say: null`。她安静不代表她不在，乱说才代表。
 * 5. **抖动不切段。** 一段类目存活不满 `stabilityMs` 时被换掉，算「抖了一下」，
 *    不结束当前段。否则每次切窗口都换一次判断，她的观察永远慢一拍。
 *
 * ## 与 O-110 的共享形状（§15.3）
 *
 * 本文件是 `ScreenView` / `PresenceState` / `ScreenCategory` 的**唯一真源**。
 * O-110 `ondra-dev-companion` 只做结构对位（字段同名、闭集同值），**按 §15.5 不 import 本文件**：
 * 任一方单独卸载，另一方都不该编译失败。改一处要两边一起改——写在这里是为了下次改字段时能看见。
 *
 * ## 明确不做
 *
 * 不做界面（L8 已整批下线，渲染归应用外壳）、不装定时器（采样节奏由外壳驱动）、
 * 不做屏幕录制、不做键鼠监听（归 O-111）、不认识画面内容、不做时间统计（归 O-105）、
 * 不主动发消息（归 O-042 的六道闸）。
 */

/** 本插件注册的服务键（连字符，非 `ondra:screen-sense`）。全仓唯一归属。 */
export const SCREEN_SENSE_SERVICE_KEY = 'ondra-screen-sense'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法会在**运行期**被模型侧直接拒绝。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（落在 `user/` 区域）。 */
export const STATE_FILE_NAME = 'screen-sense.json'

/** 存档版本。改了结构必须加一。 */
export const STATE_VERSION = 1

/**
 * 在场类目（闭集）。
 *
 * 只有九个值，且刻意**没有**「其他」这种兜底项：认不出来就是 `unknown`。
 * 一个「其他」会让统计永远闭合，也会让外壳把所有不认识的东西倒进同一个桶，
 * 于是「她在干什么」这个问题永远有个假的答案。
 */
export type ScreenCategory =
  | 'coding'
  | 'writing'
  | 'reading'
  | 'meeting'
  | 'media'
  | 'browsing'
  | 'gaming'
  | 'idle'
  | 'unknown'

const CATEGORY_LIST: readonly ScreenCategory[] = [
  'coding',
  'writing',
  'reading',
  'meeting',
  'media',
  'browsing',
  'gaming',
  'idle',
  'unknown',
]

/** 九个类目（只读，供外壳与自检枚举）。 */
export const SCREEN_CATEGORIES: readonly ScreenCategory[] = Object.freeze(CATEGORY_LIST)

/** 类目的中文标签。**只给日志与调试看，不是台词。** */
export const CATEGORY_ZH: Readonly<Record<ScreenCategory, string>> = Object.freeze({
  coding: '写代码',
  writing: '写东西',
  reading: '看东西',
  meeting: '开会',
  media: '看片听歌',
  browsing: '翻网页',
  gaming: '玩游戏',
  idle: '没在动',
  unknown: '读不到',
})

/**
 * 在场状态（闭集），按优先级从高到低排列。
 *
 * `unknown` 与 `idle` **必须是两个值**：前者是「不知道」，后者是「知道，人不在」。
 * 合成一个之后，没给权限的机器上她会永远以为自己被丢下了。
 */
export type PresenceState = 'unknown' | 'idle' | 'scattered' | 'focused' | 'wandering'

const PRESENCE_LIST: readonly PresenceState[] = [
  'unknown',
  'idle',
  'scattered',
  'focused',
  'wandering',
]

/** 五种在场状态（只读）。 */
export const PRESENCE_STATES: readonly PresenceState[] = Object.freeze(PRESENCE_LIST)

/** 判定口径。由配置换算成毫秒后交给纯函数，纯函数不读配置也不读表。 */
export interface SensePolicy {
  /** 两次采样之间的最小间隔（毫秒）。更快的采样没有意义，只是更贵。 */
  readonly minIntervalMs: number
  /** 一段类目最短存活时长（毫秒）。短于它就被换掉算抖动，不切段。 */
  readonly stabilityMs: number
  /** 达到「在做一件事」所需的持续时长（毫秒）。 */
  readonly focusMs: number
  /** 超过这个时长没有读数就判 `idle`（毫秒）。 */
  readonly idleMs: number
  /** 判定「散着」所需的换手次数。 */
  readonly scatterSwitches: number
  /** 换手次数的统计窗口（毫秒）。 */
  readonly scatterWindowMs: number
  /** 是否读 O-105 的时长（`false` 则 `sessionMinutes` 恒为 `null`）。 */
  readonly followSession: boolean
}

/**
 * 一次采样。
 *
 * `category` 由外壳给：外壳才有取窗口信息的权限，也才该承担那个权限的说明义务。
 * 本插件不认识窗口，只认识这个枚举。
 */
export interface ScreenSignal {
  /** 类目。 */
  readonly category: ScreenCategory
  /** 采样时刻，省略用系统时间。 */
  readonly at?: number
}

/** 只读视图。 */
export interface ScreenView {
  /** 当前类目。从没读到过为 `unknown`。 */
  readonly category: ScreenCategory
  /** 当前类目的中文标签。 */
  readonly categoryZh: string
  /** 在场状态。 */
  readonly state: PresenceState
  /** 当前段的起点时刻；没有段时为 `null`。 */
  readonly since: number | null
  /** 当前段已持续毫秒数。**没读到过就是 `null`，不是 0**（0 会被读成「刚切过来」）。 */
  readonly dwellMs: number | null
  /** 窗口内换手次数（真切换 + 被吸收的抖动）。 */
  readonly handovers: number
  /** 累计被吸收的抖动次数。**不为 0 说明外壳给的类目在反复横跳。** */
  readonly glitches: number
  /** 累计接受的采样数。 */
  readonly notes: number
  /** 累计因节流被丢弃的采样数。 */
  readonly dropped: number
  /** O-105 的当前连续使用分钟数。**读它，不自己算**——自己算就是第二个真源。 */
  readonly sessionMinutes: number | null
  /** 是否**真的读到过**读数。`false` 时上面所有时长类字段都没有意义。 */
  readonly measured: boolean
  /** 状态是否真的落盘。`false` = 重启后当成从没读到过。 */
  readonly stored: boolean
}

/** 一句可说的观察。**`say` 里没有数字，`confidence==='none'` 时必为 `null`。** */
export interface SenseHint {
  /** 类目。 */
  readonly category: ScreenCategory
  /** 在场状态。 */
  readonly state: PresenceState
  /**
   * 能不能说。
   *
   * `read` = 有真实读数；`none` = 读不到，**不许假装知道**。
   * 刻意没有「猜的」这一档：一旦允许猜，就一定会有一次猜错被当成知道。
   */
  readonly confidence: 'read' | 'none'
  /** 一句中文；不该说话时为 `null`。 */
  readonly say: string | null
  /** 绝对不许做的事。**恒定四条，每一档都在。** */
  readonly mustNot: readonly string[]
  /** 一句中文，说明「为什么说 / 为什么不说」。不含数字。 */
  readonly note: string
}

/** 累计统计。**只在内存**，不落盘。 */
export interface ScreenStats {
  /** 接受的采样数。 */
  readonly notes: number
  /** 因节流丢弃的采样数。 */
  readonly dropped: number
  /** 被吸收的抖动次数。 */
  readonly glitches: number
  /** 真实换手次数。 */
  readonly switches: number
  /** 读不到（`unknown` 类目）的采样次数。 */
  readonly misses: number
  /** 重来次数。 */
  readonly restarts: number
  /** 成功写盘次数。 */
  readonly writes: number
  /** 写盘失败次数。**不为 0 就说明重启后当成从没读到过。** */
  readonly writeFailures: number
  /** 状态是否真的落盘。 */
  readonly stored: boolean
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type ScreenErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（类目不在闭集、时刻不是有限正数）。 */
  | 'bad-request'

/** 屏幕感知错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class ScreenError extends Error {
  /** 错误码。 */
  readonly code: ScreenErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: ScreenErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'ScreenError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface ScreenSenseService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ScreenErrorCode
  /** 状态是否真的落盘。 */
  readonly stored: boolean

  /**
   * 记一次采样。**唯一会写盘的方法。**
   *
   * 由外壳驱动，本插件**不装定时器**：采样节奏属于外壳，不属于护栏。
   * @param signal 类目与时刻。
   * @param at 时刻，省略用系统时间。
   */
  note(signal: ScreenSignal, at?: number): ScreenView

  /** 只读视图。**不写盘、不推进。** */
  view(at?: number): ScreenView

  /** 只读观察。**不写盘、不推进。** */
  hint(at?: number): SenseHint

  /** 重来一遍（换人）。清空全部记录，`restarts` 加一。 */
  reset(at?: number): ScreenView

  /** 累计统计快照。 */
  stats(): ScreenStats
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

/** O-105 快照的结构对位子集。**只读时长，不读健康档**——健康是它的活。 */
export interface HealthLike {
  snapshot(at?: number): { readonly sessionMinutes: number; readonly dayMinutes: number }
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
