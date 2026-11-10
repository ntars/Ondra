/**
 * O-107 `ondra-first-meet` 的对外契约（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「第一次见面，按什么顺序让她把话说清楚、把边界立住？」**
 *
 * 只回答「节拍」。每一拍只给**目的、必须做到的事、绝对不许做的事、句数上限**，
 * 一个字的话术都不给——话术归人格（O-020）与表达（O-047）。
 *
 * ## 和 O-045 `ondra-onboarding` 的区别（最容易撞车的地方）
 *
 * | | O-045 onboarding | 本插件 |
 * |---|---|---|
 * | 管什么 | **装得上**：安装段、证据门控、端口、首条消息规格 | **认得下**：认识的顺序与边界 |
 * | 生命周期 | 一次性（`begin` / `advance` / 验收五条） | 可重来（换人时 `reset`） |
 * | 产出 | 步骤结果、首条消息**规格** | 五拍节拍表 + 禁令 |
 * | 失败形态 | 装不上 = 产品跑不起来 | 认不下 = 她像客服 |
 *
 * **首条消息文本刻意不在这里**：`firstMessage()` 在 O-045 里，本插件若也吐一份，
 * 就有了两个真源，而她到底说哪一句取决于谁先被调用。
 *
 * ## 共享结构的归属（§15.3 契约先行）
 *
 * `ScriptBeat` 是本轮**先做方**定义的共享形状：节拍 id、目的、必须做、
 * 不许做、句数上限、可跳性。O-108 `ondra-absence` 的回归节拍与此**同形**，
 * 但它按 §15.5 只做结构对位、**不 import 本包源码**——任一方单独卸载，
 * 另一方都不该编译失败。
 *
 * ## 六条硬纪律（每条都能单独否掉一种「更顺手」的做法）
 *
 * 1. **不出台词。** 一旦这里开始写句子，人格就有第二份声音来源，
 *    而那份声音不经过冻结前缀与九步过滤。
 * 2. **读一次不推进。** `plan()` 只读，只有 `advance()` 才推进水位。
 *    外壳若在渲染时顺手推进，节拍会在没人看见的地方被吃掉——
 *    O-102 的 `ack()` 是同一条道理。
 * 3. **允许被打断。** 用户自己先开口就是最真实的信号：`interrupt()` 直接跳
 *    到收束拍。硬按剧本走完五拍，等于让人听一段没人在听的播报。
 * 4. **边界必须先说。** `boundary` 拍排在 `invite` 之前：先讲清「我不会做什么」，
 *    再问第一个问题。反过来做，第一句就成了索取。
 * 5. **只存进度，不存内容。** 存档里只有节拍水位与时刻，**不存用户说的话**。
 *    初见那天人往往会说真名、说处境——把那些存进一个「流程存档」是越界。
 * 6. **不做界面、不装定时器、不主动发消息。** 谁来调用、什么时候说话，
 *    归 O-042 与外壳；本插件只回答「下一拍该做什么」。
 *
 * ## 明确不做
 *
 * 不做性格测试、不做问卷、不记用户回答的内容、不做多人分档
 * （一人一档，见 README §8 已知限制 2）、不做界面。
 */

/** 本插件注册的服务键（连字符，非 `ondra:first-meet`）。全仓唯一归属。 */
export const FIRST_MEET_SERVICE_KEY = 'ondra-first-meet'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法会被模型侧直接拒绝，
 * 而且是在**运行期**才拒绝——写的时候一切正常，跑起来才发现插件没加载。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（落在 `user/` 区域）。 */
export const STATE_FILE_NAME = 'first-meet.json'

/** 存档版本。改了结构必须加一，否则旧档会被当新档读。 */
export const STATE_VERSION = 1

/**
 * 五个节拍的 id（闭集）。
 *
 * 顺序即语义：到场 → 自我介绍 → 立边界 → 邀请 → 收束。
 * **顺序不做成配置**——把「立边界」调到「邀请」之后，第一句就变成索取。
 */
export type BeatId = 'arrival' | 'introduce' | 'boundary' | 'invite' | 'settle'

const BEAT_ID_LIST: readonly BeatId[] = ['arrival', 'introduce', 'boundary', 'invite', 'settle']

/** 五拍 id（只读，供外壳与自检枚举）。 */
export const BEAT_IDS: readonly BeatId[] = Object.freeze(BEAT_ID_LIST)

/**
 * 一拍。
 *
 * `mustDo` / `mustNot` 是**给调用方的约束**，不是台词。
 * 例如 `mustNot` 里那条「不许先要名字」——它约束的是那一拍该不该问，
 * 至于怎么问，归人格。
 */
export interface ScriptBeat {
  /** 节拍 id。 */
  readonly id: BeatId
  /** 中文名（可进日志与调试面板，不是话术）。 */
  readonly title: string
  /** 这一拍要解决什么（一句中文）。 */
  readonly intent: string
  /** 必须做到的事。空数组表示这一拍没有硬要求。 */
  readonly mustDo: readonly string[]
  /** 绝对不许做的事。**比 mustDo 更重要**：禁令漏一条，整拍就走偏。 */
  readonly mustNot: readonly string[]
  /** 句数上限。**不是字数**——字数上限会让人把三句话塞进一句长句。 */
  readonly maxSentences: number
  /** 是否允许整拍跳过（只有收束拍可跳：对方已经在说话了就不必再走流程）。 */
  readonly skippable: boolean
}

/** 初见进度快照。**不含用户说过的任何一句话。** */
export interface MeetSnapshot {
  /** 是否已经见过（`met` 为假时下面三项没有意义）。 */
  readonly met: boolean
  /** 初见时刻；没见过为 `null`。 */
  readonly metAt: number | null
  /** 已走完的拍数（0–5）。 */
  readonly position: number
  /** 已兑现的节拍 id，按顺序。 */
  readonly delivered: readonly BeatId[]
  /** 仪式是否已经走完。 */
  readonly done: boolean
  /** 是否被用户抢话打断过。 */
  readonly interrupted: boolean
  /** 重来次数（换人 `reset()` 会加一）。 */
  readonly restarts: number
  /** 状态是否真的落盘。`false` = 重启后从头开始。 */
  readonly stored: boolean
}

/** 一份可执行的初见脚本。 */
export interface MeetScript {
  /** 进度快照。 */
  readonly snapshot: MeetSnapshot
  /** 全部五拍（供外壳一次取全，便于排版）。 */
  readonly beats: readonly ScriptBeat[]
  /** 当前该做的那一拍；已走完为 `null`。 */
  readonly current: ScriptBeat | null
  /** 下一拍（提前准备用）；没有为 `null`。 */
  readonly next: ScriptBeat | null
  /** 一句中文。**不含台词、不含分数。** */
  readonly note: string
}

/** 累计统计。**只在内存**，不落盘。 */
export interface MeetStats {
  /** 兑现过的节拍总次数。 */
  readonly delivered: number
  /** 被打断次数。 */
  readonly interrupts: number
  /** 重来次数。 */
  readonly restarts: number
  /** 成功写盘次数。 */
  readonly writes: number
  /** 写盘失败次数。**不为 0 就说明重启会从头再来一遍。** */
  readonly writeFailures: number
  /** 状态是否真的落盘。 */
  readonly stored: boolean
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type MeetErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（节拍 id 不在闭集、时刻非法、跳到了还没到的拍）。 */
  | 'bad-request'
  /** 已经走完了，仍要推进。 */
  | 'already-done'

/** 初见剧本错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class FirstMeetError extends Error {
  /** 错误码。 */
  readonly code: MeetErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: MeetErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'FirstMeetError'
    this.code = code
    this.detail = detail
  }
}

/** 对外服务。 */
export interface FirstMeetService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: MeetErrorCode
  /** 状态是否真的落盘。 */
  readonly stored: boolean

  /** 全部节拍（只读，顺序即执行顺序）。 */
  beats(): readonly ScriptBeat[];

  /** 进度快照。**只读，不推进水位。** */
  snapshot(): MeetSnapshot

  /**
   * 当前脚本。**只读，不推进水位。**
   *
   * 外壳可以随便轮询：这一条永远不改变进度。
   */
  plan(): MeetScript;

  /**
   * 兑现**当前**这一拍，推进水位，返回推进后的脚本。
   *
   * 必须由**真正把这一拍说出来**的那一方调用。参数是"我以为现在是哪拍"，
   * 与真实水位不一致时抛 `bad-request`——这样两个调用方同时推进时，
   * 后到的那个会当场报错，而不是把下一拍悄悄吃掉。
   * @param expected 调用方认为当前是哪一拍；省略则不校验。
   */
  advance(expected?: BeatId): MeetScript;

  /**
   * 被打断：直接跳到收束拍，并把「被打断过」记进档。
   *
   * 用户自己先开口是最真实的信号。此时继续按剧本自我介绍，
   * 等于让人听一段没人在听的播报。
   */
  interrupt(): MeetScript;

  /** 整段跳过（对方明确说「不用介绍了」）。跳过后 `done` 为真。 */
  skipAll(): MeetScript;

  /**
   * 重来一遍（换人 / 用户要求从头）。`restarts` 加一，其余清零。
   * @param at 时刻。
   */
  reset(at?: number): MeetSnapshot

  /** 累计统计快照。 */
  stats(): MeetStats
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
