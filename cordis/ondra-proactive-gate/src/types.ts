/**
 * O-042 `ondra-proactive-gate` 的对外契约。
 *
 * 定位：**一条待投递的消息，此刻能不能发出去**。只回答这一件事，不生成内容、
 * 不排闹钟、不发送。
 *
 * ## 为什么是〔薄〕而不是〔研〕
 *
 * 手册 §1.8 把「心跳引擎」列在薄封装档：`dsh-proactive 改造 + 墓碑折叠`。
 * 本仓里**没有** `dsh-proactive`（已 grep，`packages/` 下零命中），可复用的等价物是
 * `@ntars/ondra-schedule`——宿主级持久提醒、once/interval/daily/weekly/cron 五种选择器、
 * 到期恢复冷会话、投递历史。所以本插件**不重写定时机制**，只做它做不了的那半件事：
 * 投递前的门控与状态持久化。
 *
 * ```
 * dsh-schedule（上游）        本插件
 * ├─ 到点了吗？               ├─ 到点了也不一定该说 → 六道闸
 * ├─ 唤醒冷会话               ├─ 说了几句？今天还剩几句？
 * ├─ 投递到原会话             ├─ 刚说过一样的话吗？
 * └─ 投递历史（30 天/200 条）  └─ 被风控盯上了吗？
 * ```
 *
 * ## 三件必须先说清的事
 *
 * 1. **「拦下」分三种后果，不是一种。**
 *    `drop`（今天说完了 / 内容是红线）不可挽回；`defer`（静默时段 / 冷却 / 速率）
 *    给一个 `deferMs` 让调用方重排；`send` 才真的发。把三者压成一个布尔，
 *    调用方就只能「要么发要么丢」——静默时段里她会把攒了一晚的话全丢掉。
 *
 * 2. **状态必须落盘（§5.3-7）。** 「进程重启若清零 = 重启绕过防封」。
 *    故本插件把令牌桶、冷却、熔断、当日计数全写进 `user/proactive-state.json`
 *    （0600、临时文件 + rename 原子写）。没有 `ondra-path-layout` 时退化成纯内存，
 *    但 `stats().stored` 会如实报 `false`，日志也会告警——**降级必须看得见**（§8.2）。
 *
 * 3. **两个「日」不是同一个日。**
 *    每日投递预算是**产品语义**的「今天说了几句」（自然日，跨零点归零）；
 *    令牌桶的日层是**防封语义**的「一天别超过 1500 条」。前者归 `dailyQuota`，
 *    后者归 `perDay`。混成一个数会让「今天已经说了 3 句」把防封闸也一起关掉。
 *
 * 本文件**不 import** 任何 `ondra-*` 源码（§18.5），相邻服务一律结构对位。
 */

/** 本插件注册的服务键（连字符，非 `ondra:proactive-gate`）。全仓唯一归属。 */
export const GATE_SERVICE_KEY = 'ondra-proactive-gate'

/** 服务键 / 工具名 / 配置键的形状（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（手册 §9.3 原文的落点）。 */
export const STATE_FILE_NAME = 'proactive-state.json'

/* ------------------------------------------------------------------ *
 * 手册给定的硬参数（§5.3 / §9.3）
 * ------------------------------------------------------------------ */

/** 令牌桶：每分钟 20（§5.3-4）。配置只能调小，不能调大。 */
export const HARD_PER_MINUTE = 20

/** 令牌桶：每小时 200（§5.3-4）。 */
export const HARD_PER_HOUR = 200

/** 令牌桶：每日 1500（§5.3-4）。腾讯看长期曲线，只做时上限是踩过的坑。 */
export const HARD_PER_DAY = 1500

/**
 * 每日投递预算的上界（§9.3 原值 3）。
 *
 * 锁 20 而不是锁 3：3 是出厂值，主人可能有自己的用法；
 * 但「一天几十条主动消息」不是节制，是鱼灾（§5.7）。
 */
export const HARD_DAILY_QUOTA = 20

/** 发送前抖动上限（§5.3-6：`jitterMs 400`）。固定节奏本身就是自动化特征。 */
export const JITTER_MS = 400

/** 连续多少次风控命中 → 全局停发（§5.3-6）。 */
export const CIRCUIT_HITS = 3

/** 熔断时长：30 分钟（§5.3-6）。被盯上时唯一正确的做法是完全闭嘴。 */
export const CIRCUIT_MS = 30 * 60_000

/** 连续失败多少次 → 停 5 分钟（§5.3-6）。 */
export const FAIL_HITS = 3

/** 失败停发时长。 */
export const FAIL_MS = 5 * 60_000

/** 风控退避阶梯（秒）。线性退避 = 持续挑衅。 */
export const BACKOFF_SECONDS: readonly number[] = Object.freeze([30, 60, 120, 300, 600, 1800])

/** 风控错误码（§5.3-6 原文）。 */
export const RISK_CODES: readonly number[] = Object.freeze([100, 1200, 1201, 1202, 1500])

/** 去重窗口：30 分钟（§5.3-3）。 */
export const DEDUPE_WINDOW_MS = 30 * 60_000

/** 去重最短长度：4（§5.3-3）。放过「嗯」「好」「?」这类人类会重复的短回复。 */
export const DEDUPE_MIN_LEN = 4

/** 会话冷却：群 5 秒（§5.3-5）。 */
export const GROUP_COOLDOWN_MS = 5000

/** 会话冷却：私聊 3 秒（§5.3-5）。 */
export const PRIVATE_COOLDOWN_MS = 3000

/** 令牌桶窗口。 */
export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * 60_000

/** 记录只保留最近一小时：一小时桶封顶 200 条，再多也进不来。 */
export const RECORD_WINDOW_MS = HOUR_MS

/* ------------------------------------------------------------------ *
 * 判定形状
 * ------------------------------------------------------------------ */

/**
 * 这次投递是**谁发起的**。
 *
 * 手册 §5.3-2 只给了两个词（`reason=active` 主动发言 / `mention` 被叫照回）。
 * 这里多一个 `reply`：**用户刚说完话、她回一句**。它既不是「主动发起」，
 * 也不是「被 @」，但手册那条闸的立意是「凌晨三点主动说话是极强机器人特征」——
 * 人凌晨回消息是正常的，把她回话也拦掉就变成「她不理人」。
 * 三值化把这个区分写成类型，登记为待裁决（见 README）。
 */
export type WakeReason = 'active' | 'mention' | 'reply'

/** 会话种类。冷却时长按它分档。 */
export type ChatKind = 'private' | 'group'

/** 判定结果的动作。 */
export type GateAction = 'send' | 'defer' | 'drop'

/**
 * 闸名。`pass` 表示放行；`policy` 是总开关/静音/群聊红线这一类前置拒绝。
 *
 * 顺序即**执行顺序**（不是 §5.3 的编号顺序）——手册给的原则是
 * 「最便宜/最可能拒绝的放最前」，所以布尔判断在前、需要遍历窗口的在后。
 */
export type GateName =
  | 'pass'
  | 'policy'
  | 'circuit'
  | 'content'
  | 'quiet'
  | 'budget'
  | 'idle'
  | 'cooldown'
  | 'duplicate'
  | 'bucket'

/** 全部闸名（计数表按它建，固定键）。 */
export const GATE_NAMES: readonly GateName[] = Object.freeze([
  'pass',
  'policy',
  'circuit',
  'content',
  'quiet',
  'budget',
  'idle',
  'cooldown',
  'duplicate',
  'bucket',
])

/** 稳定原因码。消费方可按码分支，不必匹配中文文案。 */
export type GateCode =
  /** 放行。 */
  | 'ok'
  /** 总开关关掉了。 */
  | 'disabled'
  /** 一键静音中（§5.7 红线）。 */
  | 'muted'
  /** 群里不主动说话（§5.7 红线，无开关）。 */
  | 'group-silent'
  /** 熔断中：全局停发。 */
  | 'circuit-open'
  /** 风控退避中：还没到重试时刻。 */
  | 'backoff'
  /** 连续发送失败后的暂停中。 */
  | 'fail-pause'
  /** 内容命中红线（赌博/诈骗代办/色情）。 */
  | 'content-blocked'
  /** 正文为空。 */
  | 'content-empty'
  /** 正文超过硬上限。 */
  | 'content-too-long'
  /** 产品静默时段（只拦主动）。 */
  | 'quiet-hours'
  /** 防封深夜静默（拦主动与回话，不拦被叫）。 */
  | 'anti-ban-quiet'
  /** 今日主动预算用完了。 */
  | 'budget-exhausted'
  /** 目标会话还没安静够。 */
  | 'session-busy'
  /** 同会话冷却中。 */
  | 'cooldown'
  /** 刚说过一样的话。 */
  | 'duplicate'
  /** 每分钟速率到顶。 */
  | 'bucket-minute'
  /** 每小时速率到顶。 */
  | 'bucket-hour'
  /** 每日速率到顶。 */
  | 'bucket-day'
  /** 判定本身抛错（本插件内部错误）。 */
  | 'internal-error'

/** 一条发送记录。只留最近一小时。 */
export interface SentRecord {
  /** 时刻。 */
  readonly at: number
  /** 正文（用于去重）。 */
  readonly text: string
}

/**
 * 落盘状态。
 *
 * **全部 readonly**：实现里每次变更都构造新对象，不原地改。
 * 这样「存档形状」与「运行期状态」是同一份类型，少一套转换就少一处漂移。
 */
export interface GateState {
  /** 存档版本。读到不认识的版本按空状态处理（不猜迁移）。 */
  readonly version: number
  /** 当日键（`YYYY-MM-DD`）。与 `dayCount` 一起表示「今天说了几句」。 */
  readonly dayKey: string
  /** 当日已投递的**主动**条数（产品额度用）。回话不计入。 */
  readonly dayCount: number
  /** 当日已投递的**全部**条数（防封日层用，含回话）。 */
  readonly daySent: number
  /** 最近一小时的发送记录（去重与速率都读它）。 */
  readonly sent: readonly SentRecord[]
  /** 每个会话最后一次发送时刻。 */
  readonly lastByConversation: Readonly<Record<string, number>>
  /** 连续风控命中次数。 */
  readonly riskHits: number
  /** 风控退避截止时刻（`0` = 无）。 */
  readonly retryUntil: number
  /** 熔断截止时刻（`0` = 无）。 */
  readonly openUntil: number
  /** 连续发送失败次数。 */
  readonly failHits: number
  /** 失败停发截止时刻（`0` = 无）。 */
  readonly failUntil: number
  /** 最近一次用户开口的时刻（`0` = 不知道）。「连续几天没说话」靠它推。 */
  readonly lastUserAt: number
  /** 一键静音截止时刻（`0` = 没静音）。 */
  readonly mutedUntil: number
}

/** 一次门控请求。 */
export interface GateRequest {
  /** 谁发起的。 */
  readonly reason: WakeReason
  /** 准备发出去的正文。内容闸、去重、速率都看它。 */
  readonly text: string
  /** 目标会话。冷却按它记。 */
  readonly conversationId?: string
  /** 会话种类，默认私聊。群聊 + 主动 = 恒不发。 */
  readonly kind?: ChatKind
  /**
   * 目标会话已经闲置多少分钟（§5.5 `min_idle_seconds`）。
   *
   * **省略表示调用方不知道**，此时空闲闸放行并在 `detail` 里写明 `unknown`。
   * 刻意不按「不知道就拦」处理：那样一次字段漏传就会让她永远不说话，
   * 而症状是「一切正常、就是不主动」。
   */
  readonly idleMinutes?: number
  /** 连续多少天用户没说话。省略则按 `lastUserAt` 推。 */
  readonly silentDays?: number
  /**
   * 今日主动预算的覆盖值。省略则用本地配置。
   *
   * 这是留给 O-044 `ondra-proactive-quota` 的接线口：它上线后由它算，
   * 本插件只消费。**不为未建的插件编服务键**，故走入参而不是 `ctx.get`。
   */
  readonly dailyQuota?: number
  /** 判定时刻，省略用系统时间。 */
  readonly at?: number
}

/** 今日预算视图。 */
export interface BudgetView {
  /** 自然日键。 */
  readonly dayKey: string
  /** 今日生效额度（已按连续沉默天数衰减）。 */
  readonly quota: number
  /** 今日已用。 */
  readonly used: number
  /** 还剩几次（不小于 0）。 */
  readonly remaining: number
  /** 连续沉默天数（`0` = 今天说过话或不知道）。 */
  readonly silentDays: number
  /** 额度数值的来源：本地配置 / 调用方覆盖。 */
  readonly source: 'config' | 'caller'
}

/** 一层令牌桶的视图。 */
export interface BucketView {
  /** 本窗口内已发条数。 */
  readonly used: number
  /** 上限。 */
  readonly cap: number
}

/** 判定结论。 */
export interface GateVerdict {
  /** 能不能发。等价于 `action === 'send'`，给调用方一个布尔短路用。 */
  readonly allowed: boolean
  /** 该做什么。 */
  readonly action: GateAction
  /** 被哪道闸拦下（放行时是 `pass`）。 */
  readonly gate: GateName
  /** 稳定原因码。 */
  readonly code: GateCode
  /** 一句中文说明（可直接进日志与面板）。 */
  readonly detail: string
  /** 需要等多久再试（`0` = 不用等）。`defer` 时必然大于 0。 */
  readonly deferMs: number
  /**
   * 发送前的随机等待**上限**（§5.3-6 抖动）。
   *
   * 本插件不睡——零常驻，不装定时器。调用方应在 `[0, jitterMs]` 内随机取一个值再发。
   */
  readonly jitterMs: number
  /** 熔断截止时刻（`0` = 未熔断）。 */
  readonly stopUntil: number
  /** 今日预算视图。 */
  readonly budget: BudgetView
  /** 判定时刻。 */
  readonly at: number
}

/** 只读快照（面板/自检用，**不消耗任何额度**）。 */
export interface GateSnapshot {
  /** 时刻。 */
  readonly at: number
  /** 今日预算。 */
  readonly budget: BudgetView
  /** 三层令牌桶。 */
  readonly buckets: Readonly<Record<'minute' | 'hour' | 'day', BucketView>>
  /** 熔断是否打开。 */
  readonly circuitOpen: boolean
  /** 熔断截止。 */
  readonly openUntil: number
  /** 退避截止。 */
  readonly retryUntil: number
  /** 静音截止。 */
  readonly mutedUntil: number
  /** 是否真的落盘了。 */
  readonly stored: boolean
  /** 记录条数（一小时窗口内）。 */
  readonly tracked: number
  /** 是否落在产品静默时段内。 */
  readonly quietNow: boolean
  /** 是否落在防封深夜窗口内。 */
  readonly antiBanQuietNow: boolean
}

/** 风控回报。调用方拿到风控错误码或疑似风控文案时调。 */
export interface RiskInput {
  /** 平台错误码（`100 / 1200 / 1201 / 1202 / 1500` 之一）。 */
  readonly code?: number
  /** 错误文案。按关键词兜底。 */
  readonly text?: string
  /** 时刻。 */
  readonly at?: number
}

/** 风控回报的结论。 */
export interface RiskOutcome {
  /** 是否被认作风控。 */
  readonly recognized: boolean
  /** 认出来的原因。 */
  readonly reason: 'code' | 'text' | 'none'
  /** 累计连续命中次数。 */
  readonly hits: number
  /** 是否触发了熔断。 */
  readonly tripped: boolean
  /** 熔断截止（`0` = 未熔断）。 */
  readonly openUntil: number
  /** 建议多久后重试（指数退避）。 */
  readonly retryAfterMs: number
}

/** 不可用原因。只有「配置关掉」才算真的不可用（§15-49）。 */
export type GateUnavailableReason = 'disabled'

/** 统计快照。 */
export interface GateStats {
  /** 判定次数。 */
  readonly calls: number
  /** 放行次数。 */
  readonly allowed: number
  /** 延后次数。 */
  readonly deferred: number
  /** 丢弃次数。 */
  readonly dropped: number
  /** 每道闸的命中次数（含 `pass`）。 */
  readonly byGate: Readonly<Record<GateName, number>>
  /** 风控回报次数。 */
  readonly riskReports: number
  /** 熔断触发次数。 */
  readonly circuitOpens: number
  /** 退避次数。 */
  readonly backoffs: number
  /** 落盘成功次数。 */
  readonly writes: number
  /** 落盘失败次数。 */
  readonly writeFailures: number
  /** 状态是否真的落盘。 */
  readonly stored: boolean
  /** 记录条数。 */
  readonly tracked: number
  /** 今日预算。 */
  readonly budget: BudgetView
}

/** 门控服务。 */
export interface GateService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: GateUnavailableReason
  /** 状态是否真的落盘了。`false` = 重启会清零（= 重启绕过防封）。 */
  readonly stored: boolean

  /**
   * 判定一次投递。**放行时会记账**（写记录、计数、更新冷却）。
   * @param request 请求。
   * @param at 时刻，省略用 `request.at` 或系统时间。
   */
  gate(request: GateRequest, at?: number): GateVerdict

  /**
   * 只读快照。**不消耗、不记账、不改 LRU**（§15-73）。
   * @param at 时刻。
   */
  peek(at?: number): GateSnapshot

  /** 风控回报：命中即计一次，连续 3 次熔断 30 分钟。 */
  reportRisk(input: RiskInput): RiskOutcome

  /** 发送成功：清零连续命中与连续失败。 */
  reportSuccess(at?: number): void

  /** 发送失败（非风控）：连续 3 次停 5 分钟。 */
  reportFailure(at?: number): RiskOutcome

  /** 一键静音（§5.7）。`ms` 为时长，返回静音截止时刻。 */
  mute(ms: number, at?: number): number

  /** 取消静音。 */
  unmute(): void

  /** 人工复位：清熔断、退避、失败计数。**不清当日已用**（那是事实）。 */
  reset(at?: number): void

  /** 强制落盘。返回是否成功。 */
  flush(): boolean

  /** 统计快照。 */
  stats(): GateStats
}

/* ------------------------------------------------------------------ *
 * 相邻服务的结构对位（§18.5：不 import 源码）
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

/** O-005 的字段声明形状。 */
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

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-003 时钟的结构对位子集（只用到两个纯读数）。 */
export interface ClockLike {
  /** 自然日键 `YYYY-MM-DD`（生效时区）。 */
  dayKey(epoch?: number): string
  /** 一天中的第几分钟（0–1439，生效时区）。 */
  minuteOfDay(epoch?: number): number
}

/** O-002 路径服务的结构对位子集。 */
export interface PathLike {
  /** 在某个区域下拼文件路径（不创建）。 */
  fileIn(area: 'user', ...segments: string[]): string
  /** 确保私有文件可用：父目录 0700、文件 0600。 */
  prepareFile(filePath: string): string
}
