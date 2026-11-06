/**
 * O-116 `ondra-study` 的对外契约（〔薄〕薄封装，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「这一段专注还在不在？要不要歇一下？」**
 *
 * 只回答这一个问题。学什么、怎么学、学得好不好，全部不归这里。
 *
 * ## 为什么是〔薄〕而不是〔研〕
 *
 * 「现在几点」「今天是哪一天」两件事**一件都不重写**，全走 O-003 `ondra-clock`。
 * 本插件只贡献一层「专注段状态机 + 休息水位」——这正是 §3.8 对薄封装的定义。
 * 生态里的同类（番茄钟、Forest、Session）全部是**独立前台应用 + 常驻定时器**，
 * 与本项目「只能是 app 插件、禁止常驻定时器、禁止渲染界面」的成品形态直接冲突，
 * 故只借它们的「一段一段推进」思路，不引入任何代码。
 *
 * ## 六条硬纪律（每一条都能单独否掉一种「更顺手」的做法）
 *
 * 1. **时间只认外部喂进来的时刻。** 本插件里没有一处「过了多久」是自己数的：
 *    `tick(at)` 传什么时刻就是什么时刻，`checkpoint()` 才问时钟。装一个
 *    `setInterval` 每 30 秒加 30 秒，看起来最省事，也最容易做出一个
 *    「关掉窗口八小时，回来读数是今天学了八小时」的假学伴——没人看着的时候
 *    照样累计时长，那不叫陪伴，那叫计时器。
 * 2. **两次打点间隔过大就当断了。** 默认超过 15 分钟的那一段一秒都不计入，
 *    记「被打断」而不是「完成了这一段」。上面那条假时长的唯一来源就是
 *    把「她合上电脑的三小时」当成专注。
 * 3. **没开始过就说没开始过。** `dataState` 分 `measured` 与 `never-started`。
 *    把「一次都没开始」报成「专注 0 分钟」或「今天已达标」，等于替她宣布一个
 *    她没做过的状态（与 O-105 的 `never-pulsed` 不许报平安同一条道理）。
 * 4. **休息提示必须能被拒绝。** `declinable` 的类型是字面量 `true`，
 *    `mandatory` 的类型是字面量 `false`。做成 boolean 就一定会有 `false` 分支，
 *    而那个分支会以「为你好」的名义某天被打开：锁屏、强制中断、五分钟后弹回来。
 *    学伴第一个不许做的事，是把「陪」变成「管」。
 * 5. **不测评、不打分、不存学了什么。** 落盘只有时刻与毫秒数。没有正确率、
 *    没有连续打卡天数、没有「今日健康分」式的数字，也没有笔记正文与科目之外的
 *    任何内容。
 * 6. **跨天清今天的累计，但保住「曾经开始过」。** 两个都是必须的：
 *    不清，「今天学了多久」会从昨天的基数上继续加；清掉标记，第二天第一次读取
 *    会报「从来没开始过」——对一个昨天学了两小时的人来说，那是假平安。
 *
 * ## 明确不做
 *
 * 不做番茄钟定时器、不测评打分、不存笔记正文与学习内容、不做界面、
 * 不主动发消息、不锁屏不强制休息、不做打卡日历与连续天数。
 */

/** 本插件注册的服务键（连字符，非 `ondra:study`）。全仓唯一归属。 */
export const STUDY_SERVICE_KEY = 'ondra-study'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法会被模型侧直接拒绝，
 * 而且是在**运行期**才拒绝——写的时候一切正常，跑起来才发现插件没加载。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（落在 `user/` 区域）。 */
export const STATE_FILE_NAME = 'study.json'

/** 存档版本。改了结构必须加一，否则旧档会被当新档读。 */
export const STATE_VERSION = 1

/**
 * 三种相位。**闭集**，顺序即「推进方向」，但不让消费方自己排。
 *
 * - `idle`：没在专注，也没有休息段；
 * - `focus`：专注段进行中，靠外部 `tick()` 推进；
 * - `rest`：休息段进行中。**它是提示被采纳后的结果，不是被强制的状态。**
 */
export type StudyPhase = 'idle' | 'focus' | 'rest'

const PHASE_LIST: readonly StudyPhase[] = ['idle', 'focus', 'rest']

/** 三种相位（只读，供外壳与自检枚举）。 */
export const STUDY_PHASES: readonly StudyPhase[] = Object.freeze(PHASE_LIST)

/** 相位序（比较与「还在不在学」判断用）。 */
export const PHASE_ORDER: Readonly<Record<StudyPhase, number>> = Object.freeze({
  idle: 0,
  focus: 1,
  rest: 2,
})

/**
 * 推进事件（闭集）。**返回值里必须有它**，否则外壳无从解释「为什么时长没涨」。
 *
 * | 事件 | 含义 |
 * |---|---|
 * | `accumulated` | 正常累计了一段，时长增加了 |
 * | `gap-broken` | 两次打点隔太久，这一段判为**被打断**，一秒都没计入 |
 * | `clock-back` | 时刻倒退（改系统时间 / 夏令时回拨），这一段不计入，重新校准 |
 * | `rest-ended` | 休息段够了，回到 `idle` |
 * | `resting` | 还在休息段里 |
 * | `idle` | 本来就没在学，什么也没发生 |
 * | `reanchored` | 段还在但缺了打点锚点，重新锚到此刻（不计入空缺的那段） |
 */
export type StudyEvent =
  | 'accumulated'
  | 'gap-broken'
  | 'clock-back'
  | 'rest-ended'
  | 'resting'
  | 'idle'
  | 'reanchored'

const EVENT_LIST: readonly StudyEvent[] = [
  'accumulated',
  'gap-broken',
  'clock-back',
  'rest-ended',
  'resting',
  'idle',
  'reanchored',
]

/** 七种推进事件（只读）。 */
export const STUDY_EVENTS: readonly StudyEvent[] = Object.freeze(EVENT_LIST)

/**
 * 数据状态。
 *
 * `never-started` 的意思是「从来没有开始过一段专注」，不是「今天学了 0 分钟」。
 * 这两个意思混起来，学伴就会在她其实什么都没做的时候报一个干净漂亮的零。
 */
export type StudyDataState = 'measured' | 'never-started'

/** 休息提示的触发原因（闭集）。**目前只有一个**，留成闭集是为了将来加原因时消费方能按码分支。 */
export type RestReason = 'continuous-too-long'

/** 只读快照。**这里没有「正确率」「得分」「连续天数」这类字段，也不许加。** */
export interface StudySnapshot {
  /** 自然日键 `YYYY-MM-DD`（生效时区，来自 O-003；缺席时按本机时区）。 */
  readonly dayKey: string
  /** 当前相位。**已按「事实」修正**：段其实早断了就不报 `focus`。 */
  readonly phase: StudyPhase
  /** 数据状态。`never-started` 时其余读数一律为 0 / `null`。 */
  readonly dataState: StudyDataState
  /** 是否**曾经**开始过（跨天不清）。用来区分「昨天学过」与「从来没开始」。 */
  readonly everStarted: boolean
  /** 当前专注段起点；没有进行中的段为 `null`。 */
  readonly focusStartAt: number | null
  /** 当前专注段已持续毫秒数；**间隔过大一律算 0**（那一段已经不算数了）。 */
  readonly focusMsCurrent: number
  /** 今日累计专注毫秒数（跨天归零；**只累加间隔在门槛以内的部分**）。 */
  readonly focusMsToday: number
  /** 最近一次被接受的打点时刻；从未打点为 `null`。 */
  readonly lastTickAt: number | null
  /** 距最近一次打点的毫秒数；从未打点为 `null`。 */
  readonly idleMs: number | null
  /** 今日完成的专注段数（`stop()` 或采纳休息时 +1）。 */
  readonly segmentsDoneToday: number
  /** 今日被打断的段数（间隔过大 / 时钟倒退时 +1）。 */
  readonly segmentsBrokenToday: number
  /** 今日采纳休息的次数。 */
  readonly breaksToday: number
  /** 今日拒绝休息提示的次数。**这个数存在，是为了让「不强制」可被观测。** */
  readonly breaksDeclinedToday: number
  /** 状态是否真的落盘。`false` = 重启后今日累计清零。 */
  readonly stored: boolean
}

/**
 * 一次推进的结果。
 *
 * 返回值里既有读数也有 `event`：只说「现在专注 0 分钟」而不说「因为隔了三小时
 * 判为中断」，外壳就只能猜，而它猜的方向通常是「插件坏了」。
 */
export interface StudyTickResult {
  /** 推进事件。 */
  readonly event: StudyEvent
  /** 推进后的读数。 */
  readonly snapshot: StudySnapshot
  /** 本次推进实际计入的毫秒数（`gap-broken` / `clock-back` / `idle` 恒为 0）。 */
  readonly addedMs: number
}

/**
 * 休息提示。**可拒绝、不强制，两个字段都是字面量类型。**
 *
 * `declinable: true` 与 `mandatory: false` 不是装饰：它们是这条纪律在类型层面的
 * 唯一落点。写成 boolean 之后，「为你好」的改动就能合法地把 `mandatory` 置真。
 */
export interface RestPrompt {
  /** 触发原因。 */
  readonly reason: RestReason
  /** 当前专注段分钟数（向下取整）。**只给外壳判断用，不是「你该歇了」的证据链**。 */
  readonly focusMinutes: number
  /** **恒为 `true`**：这条提示永远可以被拒绝。 */
  readonly declinable: true
  /** **恒为 `false`**：不许强制。类型是字面量，没有打开它的口子。 */
  readonly mandatory: false
  /** 一句中文。**不含分数、不含评判、不含命令。** */
  readonly note: string
}

/** `checkpoint()` 的结果：读数 + 此刻该不该提一句休息。 */
export interface StudyCheckpoint {
  /** 读数。 */
  readonly snapshot: StudySnapshot
  /** 休息提示；此刻不该提就是 `null`。 */
  readonly rest: RestPrompt | null
}

/** 累计统计。**只在内存**，不落盘（落盘的是今日计数，不是统计）。 */
export interface StudyStats {
  /** 被接受的打点次数。 */
  readonly ticks: number
  /** 判为被打断的次数（间隔过大 + 时钟倒退）。 */
  readonly broken: number
  /** 完成段数（本次进程内）。 */
  readonly completed: number
  /** 采纳休息次数（本次进程内）。 */
  readonly breaksTaken: number
  /** 拒绝休息次数（本次进程内）。 */
  readonly breaksDeclined: number
  /** 跨天归零次数。 */
  readonly rollovers: number
  /** 成功写盘次数。 */
  readonly writes: number
  /** 写盘失败次数。**不为 0 就说明重启会丢今日累计。** */
  readonly writeFailures: number
  /** 状态是否真的落盘。 */
  readonly stored: boolean
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type StudyErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（时刻不是有限正数、动作不在闭集里、已经在学还去 start）。 */
  | 'bad-request'
  /** 当前没有进行中的专注段（没在学却调 `stop()` / 采纳休息）。 */
  | 'not-focusing'

/** 学伴错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class StudyError extends Error {
  /** 错误码。 */
  readonly code: StudyErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: StudyErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'StudyError'
    this.code = code
    this.detail = detail
  }
}

/** 休息动作（闭集）。**只有两个**：采纳、拒绝。没有「稍后再说」——那就是拒绝。 */
export type RestAction = 'taken' | 'declined'

const REST_ACTION_LIST: readonly RestAction[] = ['taken', 'declined']

/** 两个休息动作（只读）。 */
export const REST_ACTIONS: readonly RestAction[] = Object.freeze(REST_ACTION_LIST)

/** 对外服务。 */
export interface StudyService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: StudyErrorCode
  /** 状态是否真的落盘。 */
  readonly stored: boolean

  /**
   * 开始一段专注。已经在学则抛 `bad-request`（不静默重开，否则段落会被无声切断）。
   * @param subject 学的是什么。**收下但不落盘、不回传**——存它就等于存学习内容。
   * @param at 时刻，省略用时钟。
   */
  start(subject?: string, at?: number): StudySnapshot

  /**
   * 推进一步。**时长只在这里涨**，且只涨「与上次打点之间的那一小段」。
   * @param at 时刻，省略用时钟。
   */
  tick(at?: number): StudyTickResult

  /**
   * 结算并落盘，同时回答「此刻该不该提一句休息」。**低频调用**（每轮对话 / 每分钟）。
   * @param at 时刻，省略用时钟。
   */
  checkpoint(at?: number): StudyCheckpoint

  /**
   * 主动收工。**会先做一次与 `tick()` 完全相同的间隔判定**：隔了三小时再点停止，
   * 记的是「被打断」而不是「完成了这一段」。
   * @param at 时刻，省略用时钟。
   */
  stop(at?: number): StudyTickResult

  /**
   * 回应休息提示。`taken` 关掉这一段并进入休息段，`declined` 只记一笔、继续专注。
   * @param action `taken` 或 `declined`。
   * @param at 时刻，省略用时钟。
   */
  rest(action: RestAction, at?: number): StudySnapshot

  /** 只读快照。**不写盘、不推进。** */
  snapshot(at?: number): StudySnapshot

  /** 累计统计快照。 */
  stats(): StudyStats
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

/** O-003 时钟服务的结构对位子集。**不重写日历**，只取这两项。 */
export interface ClockLike {
  /** 当前毫秒时间戳。 */
  now(): number
  /** 自然日键，格式 `YYYY-MM-DD`（生效时区）。 */
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
