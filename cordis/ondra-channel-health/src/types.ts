/**
 * O-057 `ondra-channel-health` 的对外契约。
 *
 * 定位：**每个通道一个独立探针，只读「已经落地的痕迹」，从不向被观测方发问。**
 *
 * ## 三条边界，写在这里是因为它们决定了整个形状
 *
 * 1. **不调适配器的任何方法。** 探针一旦 `adapter.ping()`，它就和被观测进程同生共死：
 *    适配器崩了、事件循环卡住、还在重连中——这三种情况下 ping 全都超时，
 *    探针于是把「卡住」和「死了」报成同一件事。而面板要回答的恰恰是
 *    「它是几时几分最后一次有动静的」。所以探针只吃**已经写下来的证据**
 *    （`report()` 推来的事件、上次退出前落盘的记录、将来日志端口交来的条目）。
 *
 * 2. **不把「安静」当「死了」。** 业务消息少是正常的（夜里没人说话），
 *    所以只有 `heartbeat` 能证明「还活着」。适配器必须周期性上报心跳，
 *    否则一律按「没有活着的新证据」处理——安静既不是活，也不是死。
 *
 * 3. **不读日志文件的字节。** 手册 §8.3 要求日志命名空间为 `channel.<id>`，
 *    但「读命名空间」需要一个按命名空间取条目的接口，而 O-004 `ondra-log-zh`
 *    的契约里只有 `tailHuman(limit)`（读单份中文日志的最后若干行，纯文本、无时间戳）。
 *    直接 `readFileSync` 会把这个探针绑死在日志的**行格式**上：哪天日志加了字段、
 *    改了分隔符，探针就会静默地全部报 `unknown`，而且报得毫无线索。
 *    故本插件把「日志」做成一个可选端口（`LogFeedLike`），今天没有生产方，
 *    `logPort` 恒为 `false`，并把缺口写进 README 与台账。
 *
 * ## 为什么「状态」与「原因」是两个字段
 *
 * `stale` 与 `down` 都是「现在不好使」，但处置完全不同：
 * `down` 是它自己说了断开（等它重连或查凭据），`stale` 是它连话都不说了
 * （进程可能还活着，只是卡住/被风控/事件循环饿死）。合成一个布尔，
 * 排查时只能从头再猜一遍。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const HEALTH_SERVICE_KEY = 'ondra-channel-health'

/** 名字合规正则：服务键、通道 id、工具名、配置键共用。**带冒号会被模型侧直接拒绝**。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 日志命名空间前缀（手册 §16.2-3：一通道一命名空间 `channel.<id>`）。
 *
 * 本插件**定义**这个约定并对外导出，让所有适配器写同一处；
 * 但它自己不负责写日志（写日志归 O-004），也不负责读日志文件。
 * @param channelId 通道 id，例如 `qq-official`。
 */
export function channelNamespace(channelId: string): string {
  return 'channel.' + channelId
}

/* ------------------------------------------------------------------ *
 * 证据
 * ------------------------------------------------------------------ */

/**
 * 一条证据的种类，**六值闭集**。
 *
 * - `connected`：连上了（含重连成功）；
 * - `disconnected`：它自己说的断开（不是超时推断）；
 * - `heartbeat`：**唯一能证明「此刻还活着」的证据**；
 * - `inbound` / `outbound`：有真实业务流量（顺带也是活着的证据）；
 * - `error`：出错（`code` 带平台错误码，便于对表 §5.3 的退避表）。
 */
export const EVIDENCE_KINDS = [
  'connected',
  'disconnected',
  'heartbeat',
  'inbound',
  'outbound',
  'error',
] as const

/** 一种证据。 */
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

/** 判一个值是不是合法证据种类。上游填错时按非法丢弃并计数，不猜。 */
export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === 'string' && (EVIDENCE_KINDS as readonly string[]).includes(value)
}

/** 一条上报上来的证据。 */
export interface ChannelEvent {
  /** 通道 id，必须匹配 `NAME_RE`；不合规的整条丢弃（它会被当成目录名）。 */
  readonly channelId: string
  /** 证据种类。 */
  readonly kind: EvidenceKind
  /** 发生时刻（毫秒）。省略取时钟。 */
  readonly at?: number
  /** 平台/适配器错误码，例如 `100`、`no-credential`。只在 `error` 时有意义。 */
  readonly code?: string
  /** 一句话说明，只进日志与面板。 */
  readonly detail?: string
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

/**
 * 探针状态，**五值闭集**。
 *
 * `unknown` 不是「没问题」，是「一条证据都没有」——这两件事在面板上必须分开，
 * 否则新装的通道会显示成健康，而她其实一条消息都没收到过。
 */
export const HEALTH_STATES = ['ok', 'degraded', 'stale', 'down', 'unknown'] as const

/** 一种状态。 */
export type HealthState = (typeof HEALTH_STATES)[number]

/**
 * 判定原因，**八值闭集**。每个码对应一种不同的排查动作。
 *
 * - `ok`：有活着的新证据，且窗口内无错；
 * - `recent-error`：窗口内有错但还在上报（多半是单条失败/被限流）；
 * - `reconnect-loop`：窗口内重连次数过密（多半是 token 过期或网络抖动）；
 * - `stale`：太久没有任何证据（进程可能卡住，也可能根本没启动）；
 * - `closed`：它自己说断开，此后没再连上；
 * - `never-seen`：从插件装载到现在，一条证据都没有；
 * - `clock-skew`：上报的时间戳在未来（谁的钟不准，一目了然）；
 * - `disabled`：探针自己关着（`enable=false`）。
 */
export const HEALTH_REASONS = [
  'ok',
  'recent-error',
  'reconnect-loop',
  'stale',
  'closed',
  'never-seen',
  'clock-skew',
  'disabled',
] as const

/** 一种原因。 */
export type HealthReason = (typeof HEALTH_REASONS)[number]

/** 原因的中文说法。**只给日志与面板**，不进提示词。 */
export const HEALTH_REASON_ZH: Readonly<Record<HealthReason, string>> = Object.freeze({
  ok: '正常',
  'recent-error': '最近出过错',
  'reconnect-loop': '一直在重连',
  stale: '很久没有动静',
  closed: '已经断开',
  'never-seen': '从没上报过',
  'clock-skew': '上报时间在未来',
  disabled: '探针已关闭',
})

/**
 * 证据来源，**四值闭集**。这是一个一等公民字段，不是装饰。
 *
 * 同一个 `ok`，来自「刚上报的心跳」与「三天前落盘的记录」时，
 * 面板该显示的颜色和该说的话完全不同。
 */
export const EVIDENCE_SOURCES = ['live', 'restored', 'log-port', 'none'] as const

/** 一种证据来源。 */
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

/** 计数。只增不减，重启后从落盘记录恢复。 */
export interface EventCounters {
  /** 收到几条来信。 */
  readonly inbound: number
  /** 发出去几条。 */
  readonly outbound: number
  /** 出过几次错（含被平台拒绝）。 */
  readonly errors: number
  /** 重连过几次（收到 `connected` 时累加，首次连接不算）。 */
  readonly reconnects: number
}

/** 一个通道的探针结果（对外只读视图）。 */
export interface ChannelHealth {
  /** 通道 id。 */
  readonly channelId: string
  /** 中文名；没登记过就是 id 本身。 */
  readonly label: string
  /** 状态。 */
  readonly state: HealthState
  /** 原因。 */
  readonly reason: HealthReason
  /** 一句中文补充（通常是最近一条 `detail` 或错误码）。 */
  readonly detail: string
  /** 最后一条证据的时刻；从没有过则为 `null`。 */
  readonly lastEventAt: number | null
  /** 最后一条证据的种类。 */
  readonly lastEventKind: EvidenceKind | null
  /** 最后一次出错的时刻。 */
  readonly lastErrorAt: number | null
  /** 最后一个错误码。 */
  readonly lastErrorCode: string | null
  /**
   * 距最后一条证据过了多久（毫秒）。
   *
   * **负数一律夹成 0**：上报方的钟比我们快时，`-300000` 既不好看也没意义，
   * 真相由 `reason='clock-skew'` 说明。
   */
  readonly ageMs: number | null
  /** 该通道的心跳期望间隔（毫秒）。 */
  readonly expectMs: number
  /** 判 `stale` 的阈值 = `expectMs × staleFactor`。 */
  readonly staleAfterMs: number
  /** 计数。 */
  readonly counts: EventCounters
  /** 证据来源（可能同时有 `restored` 与 `live`）。 */
  readonly sources: readonly EvidenceSource[]
  /** 判定的时刻（毫秒）。 */
  readonly at: number
}

/** 全局概况，给面板一句话用。 */
export interface HealthSummary {
  /** 统计时刻（毫秒）。 */
  readonly at: number
  /** 被盯的通道数量。 */
  readonly total: number
  /** 各状态的条数（五个键恒在，缺的填 0）。 */
  readonly byState: Readonly<Record<HealthState, number>>
  /**
   * 最糟的那个状态。
   *
   * 顺序 `down > stale > degraded > unknown > ok`：面板要能在一屏里
   * 说清「有没有事」，就必须有一个可排序的总量，而不是让用户自己数。
   */
  readonly worst: HealthState
  /** 是否接上了日志端口（今天恒 `false`，见文件头第 3 条）。 */
  readonly logPort: boolean
  /** 通道 id 列表（按最后活动时间从新到旧）。 */
  readonly channels: readonly string[]
}

/** 运行统计，供自检与面板。 */
export interface HealthStats {
  /** 收到的上报条数（含被拒的）。 */
  readonly reported: number
  /** 被采纳的条数。 */
  readonly accepted: number
  /** 被拒的条数（id 不合规 / 种类非法 / 没有 `at` 且时钟不可用）。 */
  readonly rejected: number
  /** 因为超出 `maxChannels` 被淘汰的通道数。 */
  readonly evicted: number
  /** 从磁盘恢复的通道数。 */
  readonly restored: number
  /** 成功落盘的次数。 */
  readonly persisted: number
  /** 落盘失败的次数（失败后转仅内存，不阻断）。 */
  readonly writeFailures: number
  /** 当前被盯的通道数。 */
  readonly channels: number
}

/* ------------------------------------------------------------------ *
 * 日志端口（今天的生产方不存在，见文件头第 3 条）
 * ------------------------------------------------------------------ */

/**
 * 日志端口条目。**结构化**，不是一行文本。
 *
 * 端口契约要求条目自带时刻：探针判 `stale` 全靠时间差，
 * 拿不到时刻的日志行对本插件没有价值（也就没必要为此解析文本）。
 */
export interface LogFeedEntry {
  /** 该条日志的产生时刻（毫秒）。 */
  readonly at: number
  /** 原文，只进 `detail`。 */
  readonly text?: string
}

/** 可选日志端口。由将来的「按命名空间读取」实现提供。 */
export interface LogFeedLike {
  /**
   * 取某命名空间最近的条目（从旧到新）。
   * @param namespace 命名空间，见 `channelNamespace()`。
   * @param limit 条数上限。
   */
  tailNamespace(namespace: string, limit?: number): readonly LogFeedEntry[]
}

/* ------------------------------------------------------------------ *
 * 服务
 * ------------------------------------------------------------------ */

/** 对外服务。**所有方法都不抛出**：探针自己坏掉不能连累面板。 */
export interface ChannelHealthService {
  /** 是否启用（配置开关）。关掉后服务照常注册，`probe()` 一律 `disabled`。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: 'disabled'
  /** 是否接上了日志端口。今天恒 `false`。 */
  readonly logPort: boolean

  /**
   * 登记一个「应该被盯」的通道（面板列出用）。
   *
   * **登记不参与判定**：没登记的通道只要上报过，照常出现在 `probeAll()` 里。
   * 反过来，登记了却没上报的通道会以 `unknown` 出现——这正是新装通道该有的样子。
   * @returns 是否新增（已存在返回 `false`）。
   */
  register(channelId: string, label?: string): boolean

  /**
   * 上报证据。适配器在每次连上/断开/收发/心跳/出错时调。
   * @returns 采纳的条数（非法条目被丢弃并计入 `stats().rejected`）。
   */
  report(event: ChannelEvent | readonly ChannelEvent[]): number

  /** 读一个通道的健康状况。**未上报过返回 `unknown`，不抛错**。 */
  probe(channelId: string): ChannelHealth

  /** 读全部（按最后活动时间从新到旧；从没活动的排最后）。 */
  probeAll(): readonly ChannelHealth[]

  /** 全局概况。 */
  summary(): HealthSummary

  /** 被盯的通道 id 列表。 */
  channels(): readonly string[]

  /** 忘掉一个通道（通道被删除时调）。 */
  forget(channelId: string): boolean

  /**
   * 接一个日志端口（可选增强）。
   *
   * 今天没有生产方：O-004 没有按命名空间读取的接口。
   * 接上之后，`logPort` 变 `true`，且**只**在没有任何上报证据时
   * 用命名空间里最新一条的時刻补一条 `heartbeat` 级别的「活着」。
   * @returns 摘下该端口的 disposer。
   */
  attachLogFeed(feed: LogFeedLike): () => void

  /** 立刻落盘（卸载前、面板打开时调）。 */
  flush(): void

  /** 统计快照。 */
  stats(): HealthStats

  /** 卸载：停定时器、落盘、清状态。 */
  dispose(): void
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * 不 `import` 别人的源码：那会让两个插件在编译期互相绑定，
 * 任一单独卸载都会让另一个编译失败（master-plan §18.5）。
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

/** O-003 时钟的结构对位子集。 */
export interface ClockLike {
  now(): number
}

/** O-002 路径服务的结构对位子集（只要「确保目录存在」与「拼文件路径」）。 */
export interface PathLayoutLike {
  ensure(area: 'user', ...segments: string[]): string
  fileIn(area: 'user', ...segments: string[]): string
}

/** O-005 的字段声明形状。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly advancedOnly?: boolean
  readonly secret?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 的解析结果形状。 */
export interface ResolvedSectionLike {
  readonly id: string
  readonly values: Readonly<Record<string, unknown>>
  readonly fallbackCount: number
}

/** O-005 的服务形状。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
