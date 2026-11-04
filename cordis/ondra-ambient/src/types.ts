/**
 * O-111 `ondra-ambient` 的对外契约（〔薄〕薄封装，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「主人此刻在不在？手是不是在动？现在适合不适合出现？」**
 *
 * 只回答到这一级，且只回三态：`quiet`（别打扰）/ `near`（在，但不用说话）/
 * `ready`（可以接一句）。**它不认识你在敲什么、在哪个窗口、在开什么会**——
 * 那三个问题本插件连字段都没有。
 *
 * ## 为什么是「薄封装」而不是自研输入监听
 *
 * 真实键鼠监听需要 macOS 辅助功能授权，一旦给出就再也收不回来；而且它是**常驻监听**，
 * 属应用外壳的活（`desktop/`）。本插件从头到尾**不认识硬件**，只接外壳喂进来的三类事件：
 *
 * - `key`：有键盘动作（**不含键值、不含内容、不含输入法候选**）；
 * - `mouse`：有鼠标动作（不含坐标、不含点击目标）；
 * - `idle`：外壳判定「一段时间没有输入了」。
 *
 * 所以它是一个接线 + 护栏 + 降级层：事件由外壳采（外壳才有授权，也才该承担授权说明义务），
 * 本插件负责密度判定、静默判定、三态裁决与「什么不能说」。
 *
 * ## 四条硬裁决（写进类型，不是写进文档）
 *
 * 1. **反应态里一个数字都不给。** `Reaction` 里没有任何数值字段，连 `confidence` 都是
 *    枚举而不是概率。「你已连续敲了三千多次」不是关心，是把陪伴变成仪表盘；而且一旦
 *    有数字，它迟早会被某句台词直接念出来。计数只出现在 `stats()`，那个方法的文档
 *    第一句就是「诊断用，禁止进台词」。
 * 2. **高频输入 → 更安静，不是更热闹。** 手在飞快动的时候，是这个人最专注的时候，
 *    也是任何插话最刺人的时候。故密度越高，状态只会往 `quiet` 走，永远走不到 `ready`。
 * 3. **空闲很久 → `near`，不是 `ready`。** 久不说话的人回来，第一句话该由「他回来了」
 *    决定，不该由「检测到空闲」决定。所以静默只让状态停在 `near`，绝不会自己升到
 *    `ready`；`ready` 的唯一来路是「密集输入刚刚停下来」这个**行为变化本身**。
 * 4. **存档里没有按键明细。** 只有三个计数（`beats` / `bursts` / `ignored`）与两个时刻
 *    （最近一次输入、最近一次空闲声明）。没有键值、没有间隔序列、没有窗口名。
 *    一旦存下间隔序列，它就是一份可以还原打字节奏的日志，而打字节奏能反推内容。
 *
 * ## 与 O-105 / O-042 的边界（§15.3 / §15.5）
 *
 * - **不读健康统计**：连续使用时长、健康四档属 O-105 `ondra-digital-health`。
 *   本插件不 import 它，也不复制它的阈值——两处各算一份就一定会给出两个不同的答案。
 * - **不主动发消息**：`nudge()` 只回「要不要冒个泡」，**不产生台词、不发送**。
 *   开口一律走 O-042 的六道闸。
 *
 * ## 明确不做
 *
 * 不做界面（L8 已整批下线，渲染归应用外壳）、不装定时器（时间推进由外部 `tick` /
 * 事件驱动）、不监听真实键鼠、不做内容与语义识别、不做时间统计、不做主动发送。
 */

/** 本插件注册的服务键（连字符，非 `ondra:ambient`）。全仓唯一归属。 */
export const AMBIENT_SERVICE_KEY = 'ondra-ambient'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法会在**运行期**被模型侧直接拒绝。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（落在 `user/` 区域）。 */
export const STATE_FILE_NAME = 'ambient.json'

/** 存档版本。改了结构必须加一。 */
export const STATE_VERSION = 1

/**
 * 事件类型（闭集）。
 *
 * 只有三类，**刻意没有 `focus` / `clipboard` / `window`**：那三个都需要比「手在不在动」
 * 多一个数量级的信息，而多出来的每一个字段都会变成一条能被滥用的路径。
 */
export type AmbientEventType = 'key' | 'mouse' | 'idle'

const EVENT_TYPE_LIST: readonly AmbientEventType[] = ['key', 'mouse', 'idle']

/** 三类事件（只读，供外壳与自检枚举）。 */
export const AMBIENT_EVENT_TYPES: readonly AmbientEventType[] = Object.freeze(EVENT_TYPE_LIST)

/**
 * 反应态（闭集）。
 *
 * 三态是**刻意**的：多一档就一定会有「稍等」「也许」这类需要解释的值，
 * 而需要解释的状态，外壳最后都会统一当成 `near` 用，于是这一档等于不存在。
 */
export type AmbientState = 'quiet' | 'near' | 'ready'

const STATE_LIST: readonly AmbientState[] = ['quiet', 'near', 'ready']

/** 三种反应态（只读）。 */
export const AMBIENT_STATES: readonly AmbientState[] = Object.freeze(STATE_LIST)

/** 三态的中文标签。**只给日志与调试看，不是台词。** */
export const STATE_ZH: Readonly<Record<AmbientState, string>> = Object.freeze({
  quiet: '别打扰',
  near: '在，但不用说话',
  ready: '可以接一句',
})

/**
 * 判定来源（闭集）。用来回答「为什么现在是这一档」，**不含任何数量**。
 *
 * 单独留一个字段而不是折进 `state`：`quiet` 既可能是「正忙着」也可能是「什么都不知道」，
 * 这两件事的处理方式完全相反（前者是尊重，后者是降级），折起来就查不出来了。
 */
export type DecisionSource =
  /** 从没观测到任何事件，什么都不知道。 */
  | 'none'
  /** 输入密度高，正忙着。 */
  | 'busy'
  /** 密集输入刚停下来，落在可接话的窗口里。 */
  | 'settle'
  /** 静默很久。 */
  | 'idle'
  /** 有动静，但既不密也没停够，属于「在，但没什么好接的」。 */
  | 'steady'

/** 判定口径。由配置换算成毫秒后交给纯函数，纯函数不读配置也不读表。 */
export interface AmbientPolicy {
  /** 判「密集」的每分钟事件数。密度越高越安静。 */
  readonly busyPerMin: number
  /** 密集输入停下后，需要静默多久才算「停稳」（毫秒）。 */
  readonly settleMs: number
  /** 「停稳」之后可接话的窗口长度（毫秒）。窗口一过退回 `near`。 */
  readonly readyWindowMs: number
  /** 多久没有输入就算「静默很久」（毫秒）。只会得到 `near`。 */
  readonly idleMs: number
  /** 一段输入要连续密集多久才算「真的在做一件事」（毫秒）。 */
  readonly burstMinMs: number
  /** 两条事件之间的最小间隔（毫秒）。更密的重复事件一律丢弃并计数。 */
  readonly minGapMs: number
}

/**
 * 一次事件。
 *
 * **只带类型与时刻。** 没有键值、没有坐标、没有窗口、没有应用名、没有内容。
 * 这个接口的形状本身就是那条纪律：想加一个字段，就得先改这里，而改这里要过评审。
 */
export interface AmbientEvent {
  /** 事件类型。 */
  readonly type: AmbientEventType
  /** 事件时刻，省略用系统时间。 */
  readonly at?: number
}

/** 只读快照。**没有一个数值字段**——数量只在 `stats()` 里，且禁止进台词。 */
export interface Snapshot {
  /** 反应态。 */
  readonly state: AmbientState
  /** 反应态中文标签。 */
  readonly stateZh: string
  /**
   * 能不能确信。
   *
   * `read` = 至少观测到过事件；`none` = 什么都没观测到，**不许假装知道**。
   * 刻意没有「猜的」这一档：一旦允许猜，就一定会有一次猜错被当成知道。
   */
  readonly confidence: 'read' | 'none'
  /** 判定来源。 */
  readonly source: DecisionSource
  /** 状态是否已经稳定（刚翻状态的一小段时间内为 `false`，防外壳在临界点反复闪）。 */
  readonly settled: boolean
  /** 是否**真的**观测到过输入。`false` 时 `state` 只代表「不知道」。 */
  readonly measured: boolean
  /** 状态是否真的落盘。`false` = 重启后当成从没观测过。 */
  readonly stored: boolean
}

/**
 * 一句「现在该怎么对待我」的裁决。**没有任何数字、没有任何台词。**
 *
 * 本插件**不产出话语**：`maySpeak` 只说明「这一刻适合不适合出现」，
 * 说什么、什么语气、要不要说，全部在 O-020 与 O-042 那边决定。
 */
export interface Reaction {
  /** 反应态。 */
  readonly state: AmbientState
  /** 反应态中文标签。 */
  readonly stateZh: string
  /** 能不能确信。 */
  readonly confidence: 'read' | 'none'
  /** 是否允许接一句（**只有 `ready` 为真**）。 */
  readonly maySpeak: boolean
  /** 一句中文，说明为什么是这一档。不含数字、不含事件计数。 */
  readonly reason: string
  /** 绝对不许做的事。**恒定五条，每一档都在。** */
  readonly mustNot: readonly string[]
}

/** 要不要冒个泡的判断。**同样不含台词，也不发送任何东西。** */
export interface Nudge {
  /** 值不值得冒个泡。 */
  readonly worth: boolean
  /** 当前反应态。 */
  readonly state: AmbientState
  /** 一句中文，说明为什么值得 / 为什么不值得。不含数字。 */
  readonly reason: string
  /** 绝对不许做的事。与 `Reaction.mustNot` 同一份。 */
  readonly mustNot: readonly string[]
}

/**
 * 累计统计。**只在内存，不落盘，且仅供诊断与自检——禁止进任何台词。**
 *
 * 单列这个方法而不是把它塞进 `Snapshot`：只要数量和视图在同一个对象里，
 * 迟早会有人写 `${snapshot.beats}` 拼一句话。
 */
export interface AmbientStats {
  /** 接受的事件数。 */
  readonly beats: number
  /** 成立的密集段次数（一段连续高密度输入算一次）。 */
  readonly bursts: number
  /** 被丢弃的事件数（太密 / 乱序）。 */
  readonly ignored: number
  /** `nudge()` 判定为「值得」的次数。 */
  readonly nudges: number
  /** 成功写盘次数。 */
  readonly writes: number
  /** 写盘失败次数。**不为 0 就说明重启后当成从没观测过。** */
  readonly writeFailures: number
  /** 状态是否真的落盘。 */
  readonly stored: boolean
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type AmbientErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（事件类型不在闭集、时刻不是有限正数）。 */
  | 'bad-request'

/** 键鼠反应错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class AmbientError extends Error {
  /** 错误码。 */
  readonly code: AmbientErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: AmbientErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'AmbientError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface AmbientService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: AmbientErrorCode
  /** 状态是否真的落盘。 */
  readonly stored: boolean

  /**
   * 记一次事件。**唯一会写盘的方法。**
   *
   * 由外壳驱动，本插件**不装定时器**：采样的节奏属于外壳，不属于护栏。
   * @param event 事件类型与时刻。
   * @param at 时刻，省略用系统时间。
   */
  observe(event: AmbientEvent, at?: number): Snapshot

  /** 只读裁决。**不写盘、不推进。** */
  decide(at?: number): Reaction

  /** 只读快照。**不写盘、不推进。** */
  snapshot(at?: number): Snapshot

  /** 要不要冒个泡。**不写盘、不产生台词、不发送。** */
  nudge(at?: number): Nudge

  /** 累计统计（诊断用，禁止进台词）。 */
  stats(): AmbientStats
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

/**
 * O-003 时钟服务的结构对位子集。**不重写日历**，只取这两项。
 *
 * 取 `dayKey` 是为了「一天最多冒几次泡」的日界：自己用毫秒除一天算日界，
 * 会在夏令时切换日跳号或重复，那正是 O-003 专门用日历三元组解决掉的问题。
 */
export interface ClockLike {
  now(): number
  dayKey(epoch?: number): string
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
