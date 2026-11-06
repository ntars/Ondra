/**
 * O-105 `ondra-digital-health` 的对外契约（〔薄〕薄封装，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「这个人已经连着用了多久？此刻该不该劝一句？」**
 *
 * 只回答这一个问题。劝什么、用什么语气、投递到哪个通道，全部不归这里。
 *
 * ## 为什么是〔薄〕而不是〔研〕
 *
 * 计时、日历、跨天、时区这四件事**一件都不重写**，全走 O-003 `ondra-clock`。
 * 本插件只贡献一层「阈值判定 + 提醒水位」——这正是 §3.8 对薄封装的定义：
 * 保留外部实现，插件负责契约转换与护栏。生态里成熟的同类（Screen Time、
 * 番茄钟、Stretchly 这类休息提醒器）都是**桌面端独立进程 + 系统托盘**，
 * 与本项目「只能做 app 插件、禁止常驻后台服务」的成品形态直接冲突，
 * 故只借它们的阈值思路，不引入代码。
 *
 * ## 五条硬纪律（每一条都能单独否掉一种「更顺手」的做法）
 *
 * 1. **不自己发消息。** 本插件只产出 `advise()` 结论；把话真正说出来归
 *    O-042 `ondra-proactive-gate` 与 O-047。自己发就绕过了静默时段、
 *    日额度、去重、风控退避这一整套节制闸——那套闸正是防「鱼灾」的。
 * 2. **没打点就说没打点。** `state` 分 `measured` 与 `never-pulsed` 两档。
 *    把「从来没收到过活动」报成 `ok`，等于告诉她「我看着你，你没事」，
 *    而其实一眼都没看。这跟 O-104 的 `skip` 不许算 `pass` 是同一条道理。
 * 3. **读数与「该不该说」分开。** `advise()` 永远给真实档位；能不能开口
 *    由 `nudgeDue` 单独回答。把冷却压进档位里，会让外壳在冷却期读到一个
 *    假的 `ok`——那时界面会显示一切正常，而人已经连坐三小时了。
 * 4. **只存时间戳与分钟数。** 不存正文、不存窗口标题、不存应用名、不截屏。
 *    一个「健康护栏」如果需要知道你刚才在写什么，它就已经越界了。
 * 5. **不出健康分。** 禁报数铁律的同族：一旦有「今日健康分 62」，
 *    第二天就有人为了这个数去关掉护栏。`note` 里只出现「该歇了」这类人话。
 *
 * ## 明确不做
 *
 * 不做锁屏、不强制中断、不统计应用使用时长、不读系统活动日志、
 * 不装定时器（判定是拉取式的，谁问谁得）、不做界面。
 */

/** 本插件注册的服务键（连字符，非 `ondra:digital-health`）。全仓唯一归属。 */
export const DIGITAL_HEALTH_SERVICE_KEY = 'ondra-digital-health'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法会被模型侧直接拒绝，
 * 而且是在**运行期**才拒绝——写的时候一切正常，跑起来才发现插件没加载。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（落在 `user/` 区域）。 */
export const STATE_FILE_NAME = 'digital-health.json'

/** 存档版本。改了结构必须加一，否则旧档会被当新档读。 */
export const STATE_VERSION = 1

/**
 * 四档护栏强度。
 *
 * 刻意**不用分数**、也不用百分比：档位是「该说什么话」的开关，不是测量值。
 * `ok` 之外三档分别对应三种话术：提一句、认真劝、直接收工。
 */
export type HealthLevel = 'ok' | 'gentle' | 'firm' | 'stop'

const HEALTH_LEVEL_LIST: readonly HealthLevel[] = ['ok', 'gentle', 'firm', 'stop']

/** 四档护栏强度（只读，供外壳与自检枚举）。 */
export const HEALTH_LEVELS: readonly HealthLevel[] = Object.freeze(HEALTH_LEVEL_LIST)

/**
 * 档位序：**取大**用。
 *
 * 单独导出而不是让消费方自己 `indexOf`，是因为消费方一旦自己排一遍，
 * 就会有一处把 `stop` 排到 `gentle` 前面——那种错只在深夜触发，很难复现。
 */
export const LEVEL_ORDER: Readonly<Record<HealthLevel, number>> = Object.freeze({
  ok: 0,
  gentle: 1,
  firm: 2,
  stop: 3,
})

/**
 * 四类信号。**互不重叠**，这是本插件最容易写错的地方。
 *
 * 「连续太久」与「今天太久」是两件事：断续用满八小时的人需要的是「今天够了」，
 * 而连坐三小时的人需要的是「先站起来」。压成一个数就只能说一句含糊的话。
 */
export type HealthSignalCode = 'session-long' | 'session-too-long' | 'daily-long' | 'late-night'

const HEALTH_SIGNAL_LIST: readonly HealthSignalCode[] = [
  'session-long',
  'session-too-long',
  'daily-long',
  'late-night',
]

/** 四类信号（只读）。 */
export const HEALTH_SIGNALS: readonly HealthSignalCode[] = Object.freeze(HEALTH_SIGNAL_LIST)

/** 一条信号。 */
export interface HealthReason {
  /** 信号码。消费方可按码分支，不必匹配中文文案。 */
  readonly code: HealthSignalCode
  /**
   * 相关分钟数。
   *
   * `late-night` 恒为 0——它不是时长信号，而是时段信号。
   * 用 0 而不是 `null`，是为了让消费方不必为它单独写一个分支；
   * 但**不要把 0 渲染成「0 分钟」**，那是它唯一会误导人的地方。
   */
  readonly minutes: number
  /** 一句中文，可直接进日志。不含分数。 */
  readonly detail: string
}

/**
 * 数据状态。
 *
 * `never-pulsed` 的意思是「一次活动都没收到过」，不是「你没在用」。
 * 这两个意思混起来，护栏就会在她其实什么都没看到的时候报平安。
 */
export type HealthDataState = 'measured' | 'never-pulsed'

/** 只读快照。 */
export interface HealthSnapshot {
  /** 自然日键 `YYYY-MM-DD`（生效时区，来自 O-003；缺席时按本机时区）。 */
  readonly dayKey: string
  /** 当日累计分钟数（跨天归零）。 */
  readonly dayMinutes: number
  /** 当前连续使用段长度（分钟）。休息够久就归零。 */
  readonly sessionMinutes: number
  /** 当前连续使用段的起点时刻；没有活动段时为 `null`。 */
  readonly sessionStart: number | null
  /** 最近一次打点时刻；从未打点为 `null`。 */
  readonly lastPulseAt: number | null
  /** 距最近一次打点的分钟数；从未打点为 `null`。 */
  readonly idleMinutes: number | null
  /** 已经提醒到的档位（由 `ack()` 推进，**读一次不会推进**）。 */
  readonly acknowledged: HealthLevel
  /** 今日已提醒次数。 */
  readonly nudges: number
  /** 累计打点次数。 */
  readonly pulses: number
  /** 状态是否真的落盘。`false` = 重启后当日累计清零。 */
  readonly stored: boolean
}

/** 一次判定结论。 */
export interface HealthAdvice {
  /** 真实档位。**不受冷却影响**（冷却只影响 `nudgeDue`）。 */
  readonly level: HealthLevel
  /** 数据状态。`never-pulsed` 时 `level` 恒为 `ok`，但**不代表人没事**。 */
  readonly state: HealthDataState
  /** 判定时刻。 */
  readonly at: number
  /** 命中的信号，按档位从高到低。 */
  readonly reasons: readonly HealthReason[]
  /** 当前连续段起点；没有活动段为 `null`。 */
  readonly sessionStart: number | null
  /** 当前连续段分钟数。 */
  readonly sessionMinutes: number
  /** 当日累计分钟数。 */
  readonly dayMinutes: number
  /**
   * 此刻该不该真的开口。
   *
   * 三个条件同时成立才为 `true`：档位高于 `ok`、档位高于已提醒水位、冷却已过。
   * 交给 O-042 之前**还要再过一遍那六道闸**——本插件只回答「该说」，
   * 不回答「能发」。
   */
  readonly nudgeDue: boolean
  /** 建议后续主动消息降频（`firm` / `stop` 时为 `true`）。 */
  readonly suggestQuiet: boolean
  /** 一句中文。**不含分数、不含百分比。** */
  readonly note: string
}

/** 累计统计。**只在内存**，不落盘（落盘的是当日计数，不是统计）。 */
export interface HealthStats {
  /** 累计打点次数。 */
  readonly pulses: number
  /** 累计提醒次数。 */
  readonly nudges: number
  /** 跨天归零次数。 */
  readonly rollovers: number
  /** 成功写盘次数。 */
  readonly writes: number
  /** 写盘失败次数。**不为 0 就说明重启会丢当日累计。** */
  readonly writeFailures: number
  /** 状态是否真的落盘。 */
  readonly stored: boolean
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type HealthErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（时刻不是有限正数、档位不在闭集里）。 */
  | 'bad-request'

/** 数字健康护栏错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class DigitalHealthError extends Error {
  /** 错误码。 */
  readonly code: HealthErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: HealthErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'DigitalHealthError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface DigitalHealthService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: HealthErrorCode
  /** 状态是否真的落盘。`false` = 重启会清零。 */
  readonly stored: boolean

  /**
   * 记一次活动打点。**唯一会写盘的方法。**
   *
   * 谁打点：用户每说一句话、每次点开对话，由外壳或 O-033 调一次。
   * 本插件**不监听键盘鼠标**——那是 O-111 `ondra-ambient` 的活，
   * 而且全局键鼠监听在 macOS 上需要辅助功能授权，不该由一个护栏插件顺带索取。
   * @param at 时刻，省略用系统时间。
   */
  pulse(at?: number): HealthSnapshot

  /** 只读快照。**不写盘、不推进水位。** */
  snapshot(at?: number): HealthSnapshot

  /** 只读判定。**不写盘、不推进水位。** */
  advise(at?: number): HealthAdvice

  /**
   * 记一次「已经提醒过了」，推进水位并起冷却。
   *
   * 必须由**真正把话说出去的那一方**调用。外壳若在轮询时顺手调它，
   * 提醒就会在没人看见的地方被吃掉。
   * @param level 提醒到的档位。
   * @param at 时刻。
   */
  ack(level: HealthLevel, at?: number): HealthSnapshot

  /**
   * 强制落盘。**卸载前必须调一次**，否则最近 60 秒的计数会跟着进程一起消失。
   * @returns 是否写成功。
   */
  flush(): boolean

  /** 累计统计快照。 */
  stats(): HealthStats
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
  /** 一天中的第几分钟（0–1439）。 */
  minuteOfDay(at?: number): number
  /** 判断某时刻是否落在时间窗内，支持跨零点，左闭右开。 */
  withinWindow(start: string, end: string, at?: number): boolean
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
