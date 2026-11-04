/**
 * O-114 `ondra-webhook-inbox` 的对外契约（〔复〕复用档，L9 扩展池）。
 *
 * ## 它到底回答哪一个问题
 *
 * > **「外面刚发生了一件事——要不要说、什么时候说、说哪一类？」**
 *
 * 三个问题，只有三个答案：去重后入箱（不说第二遍）、静默时段先压住（现在不说）、
 * 按三档优先级排队（先说重要的）。**说完之后怎么发出去，不归这里。**
 *
 * ## 为什么是「收件箱」而不是「通知器」
 *
 * 一个通知器迟早会自己开口，而自己开口的路径不经过 O-042 的六道闸。
 * 收件箱不主动做任何事：事件进来、按指纹去重、压进队列、安静等人来取。
 * 谁来取、取走之后发到哪个通道、发不发得出去，全部在外面。这样最坏的情况是
 * 「箱子里堆了几条没人取」，而不是「半夜三点她自己决定播报一条 CI 失败」。
 *
 * ## 六条硬纪律
 *
 * 1. **同一件事不许播两遍。** 去重靠指纹：事件源 + 类型 + 关键字段排序后的哈希。
 *    指纹只存摘要（16 位十六进制），**原文一个字都不存**——哈希不可逆，
 *    于是「按指纹去重」这件事本身就不可能被用来还原事件内容。
 * 2. **只存摘要与指纹。** 摘要由调用方给，本插件只做压缩与截断；`body` / `raw` /
 *    `payload` 三个字段的类型是 `never`——不是「忽略」，是**编译期拒绝**。
 *    想让这个插件保存请求体，得先把它自己的类型改掉，那是一次看得见的改动。
 * 3. **静默时段只入箱不投递。** 23:00–08:00 之间进来的一切都进队列、但不进可投递批次。
 *    判断只在本层做软的（读 O-003 的小时数），**本插件不提供「静默时段」这项能力**——
 *    真正的静默归 O-042，两处都判是刻意的冗余，不是第二个真源。
 * 4. **高优先级只是排队靠前，不是后门。** 三档优先级只影响顺序与截断时的取舍，
 *    既不能绕过 `enable`，也不能穿过静默时段。给高优先级留一条「紧急所以可以半夜说」
 *    的路，等于把静默时段变成建议。
 * 5. **队列有上限，满了丢最旧的，并且说出来。** 静默截断会让「为什么这条没播」
 *    永远查不出来；丢弃必须同时去掉它的指纹（否则「没播过的事件」会被当成播过了）。
 * 6. **不自己发消息、不起服务器、不装定时器。** 监听归宿主（它接 webhook、验签、解析），
 *    发送归 O-042，本插件只有 `ingest()` 一个入口，而且这个入口是**宿主调它**，不是它去连谁。
 *
 * ## 明确不做
 *
 * 不做 HTTP 服务器或端口监听、不做 webhook 验签、不做重试与投递确认之外的持久化、
 * 不渲染界面（L8 已整批下线）、不装任何定时器、不做消息模板与话术、不做多用户分箱。
 */

/** 本插件注册的服务键（连字符，非 `ondra:webhook-inbox`）。全仓唯一归属。 */
export const WEBHOOK_INBOX_SERVICE_KEY = 'ondra-webhook-inbox'

/**
 * 命名硬约束正则（手册 §8.4）。
 *
 * 服务键 / 工具名 / 配置键都必须匹配它。带冒号的写法会在**运行期**才被模型侧拒绝——
 * 写的时候一切正常，跑起来才发现插件没加载。
 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 状态文件名（落在 `user/` 区域）。 */
export const STATE_FILE_NAME = 'webhook-inbox.json'

/** 存档版本。改了结构必须加一，否则旧档会被当新档读。 */
export const STATE_VERSION = 1

/**
 * 优先级（闭集，只有三档）。
 *
 * 刻意**只有三档**：五档以上就一定会出现「紧急」与「非常重要」这种需要解释的区分，
 * 而需要解释的优先级在实际使用中等价于没有优先级。
 */
export type Priority = 'high' | 'normal' | 'low'

const PRIORITY_LIST: readonly Priority[] = ['high', 'normal', 'low']

/** 三档优先级（只读，供外壳与自检枚举）。 */
export const PRIORITIES: readonly Priority[] = Object.freeze(PRIORITY_LIST)

/** 优先级的中文标签。**只给日志与调试看，不是消息模板。** */
export const PRIORITY_ZH: Readonly<Record<Priority, string>> = Object.freeze({
  high: '高',
  normal: '普通',
  low: '低',
})

/**
 * 一条外部事件。**由宿主构造并交给 `ingest()`。**
 *
 * 宿主负责接 webhook、验签、解析出「谁、什么事、哪一件」，本插件只认识这张表。
 * 三个 `never` 字段是本契约最有用的部分：它们的**存在**就是禁令。
 */
export interface InboxEvent {
  /** 事件源，例如 `github` / `order` / `mail`。必填，最长 64 字符。 */
  readonly source: string
  /** 事件类型，例如 `ci-failed` / `order-paid` / `mail-received`。必填，最长 64 字符。 */
  readonly type: string
  /**
   * 关键字段（用来认定「这是同一件事」），例如订单号、工单号、分支名 + 提交号。
   *
   * **只用于算指纹，算完即丢。** 值会被打进哈希，但本身不落盘、不进视图。
   * 顺序无关（算之前先排序），大小写敏感（`A1` 与 `a1` 视为两件事，宁可重播不可漏播）。
   */
  readonly key?: readonly string[]
  /**
   * 一句话摘要（例如「main 分支 CI 挂了」）。
   *
   * 落盘前会折掉空白并按 `summaryMaxChars` 截断；**本插件不判断摘要里有没有敏感信息**，
   * 所以调用方只应传一句话，不要把正文片段塞进来。
   */
  readonly summary?: string
  /** 优先级；省略或不在闭集里一律按 `normal`。 */
  readonly priority?: Priority
  /** 事件发生时刻；省略用系统时间。 */
  readonly at?: number
  /** **禁止字段**：正文。传进来是类型错误，不是被忽略。 */
  readonly body?: never
  /** **禁止字段**：原始请求。 */
  readonly raw?: never
  /** **禁止字段**：完整载荷。 */
  readonly payload?: never
}

/** 箱子里的一条。**字段全部可落盘，且没有一个能还原原文。** */
export interface InboxItem {
  /** 条目 id，等于指纹（16 位十六进制）。同一件事只可能有一条。 */
  readonly id: string
  /** 事件源。 */
  readonly source: string
  /** 事件类型。 */
  readonly type: string
  /** 优先级。 */
  readonly priority: Priority
  /** 摘要（已压缩、已截断；可能为空串）。 */
  readonly summary: string
  /** 事件时刻。 */
  readonly at: number
  /** 入箱序号（递增，只用于同刻事件的稳定排序）。 */
  readonly seq: number
}

/** 入箱结果。 */
export interface IngestResult {
  /** 是否入箱。 */
  readonly accepted: boolean
  /** `accepted` = 新入箱；`duplicate` = 去重窗内已见过；`evicted` = 比箱内最旧的还旧，直接丢弃。 */
  readonly reason: 'accepted' | 'duplicate' | 'evicted'
  /** 入箱条目的 id；被去重时为命中的那一条 id。 */
  readonly id: string
  /** 入箱后队列总条数。 */
  readonly queued: number
  /** 是否因静默时段被压住（入箱了，但现在不投递）。 */
  readonly held: boolean
}

/** 一次可投递的批次。**`items` 是要说的，不是已说的。** */
export interface PendingBatch {
  /** 本批候选（已按优先级排序并截断）。 */
  readonly items: readonly InboxItem[]
  /** 为什么是这个结果。**空批次必须能解释自己**，否则调用方无从判断是没货还是被闸住了。 */
  readonly reason: 'ok' | 'queue-empty' | 'quiet-hours' | 'rate-limited' | 'stale'
  /** 现在是否处在静默时段。 */
  readonly quiet: boolean
  /** 本小时剩余投递额度（按 `ack()` 的时刻算）。 */
  readonly quota: number
  /** 队列总条数（含被压住的）。 */
  readonly queued: number
  /** 被超龄过滤掉的条数（`reason === 'stale'` 时它们就是全部）。 */
  readonly stale: number
}

/** 确认结果。 */
export interface AckResult {
  /** 真的移除的条数。 */
  readonly removed: number
  /** 没找到的 id（已 ack 过、已过期丢弃、或根本没进过箱）。 */
  readonly unknown: readonly string[]
  /** 移除后队列总条数。 */
  readonly queued: number
}

/** 全量只读视图。**给外壳画收件箱与自检用，不推进任何状态。** */
export interface InboxSnapshot {
  /** 队列（按优先级排序后的顺序）。 */
  readonly items: readonly InboxItem[]
  /** 队列条数。 */
  readonly queued: number
  /** 现在是否处在静默时段。 */
  readonly quiet: boolean
  /** 本小时剩余额度。 */
  readonly quota: number
  /** 去重表里还有多少条指纹（仍在有效期内的）。 */
  readonly fingerprints: number
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 状态是否真的落盘。`false` = 重启后收件箱是空的。 */
  readonly stored: boolean
}

/** 累计统计。**只在内存**，不落盘。 */
export interface InboxStats {
  /** 收到的次数（含被去重的）。 */
  readonly ingested: number
  /** 真正入箱的条数。 */
  readonly accepted: number
  /** 被指纹去重挡下的次数。 */
  readonly duplicates: number
  /** 因队列满丢弃的最旧条数。**不为 0 说明上限设小了。** */
  readonly evicted: number
  /** 因超龄（`maxAgeHours`）清理掉的条数。 */
  readonly expired: number
  /** 因静默时段只入箱的次数。 */
  readonly quietHeld: number
  /** 被 `ack()` 确认掉的条数。 */
  readonly delivered: number
  /** 因额度不足被挡下的 `pending()` 次数。 */
  readonly rateLimited: number
  /** 去重表超出上限被挤掉的指纹数。**不为 0 说明有事件可能被重播。** */
  readonly fingerprintEvicted: number
  /** 成功写盘次数。 */
  readonly writes: number
  /** 写盘失败次数。**不为 0 就说明重启会丢收件箱。** */
  readonly writeFailures: number
  /** 状态是否真的落盘。 */
  readonly stored: boolean
  /** 最近一次失败原因（一句中文）。 */
  readonly lastIssue?: string
}

/** 错误码。 */
export type WebhookInboxErrorCode =
  /** 总开关关掉了。 */
  | 'disabled'
  /** 参数不合法（事件源为空、时间戳不是正的有限数、`key` 不是字符串数组）。 */
  | 'bad-request'

/** 收件箱错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class WebhookInboxError extends Error {
  /** 错误码。 */
  readonly code: WebhookInboxErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: WebhookInboxErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'WebhookInboxError'
    this.code = code
    this.detail = detail
  }
}

/** 配置换算出来的判定口径。纯函数拿到的一律是数值，不读配置。 */
export interface InboxPolicy {
  /** 队列上限（条）。 */
  readonly queueCap: number
  /** 一批最多投递几条。 */
  readonly maxBatch: number
  /** 每小时最多投递几条（按 `ack()` 计数）。 */
  readonly maxPerHour: number
  /** 去重窗（毫秒）。同一指纹在此期间只入箱一次。 */
  readonly fingerprintTtlMs: number
  /** 去重表上限（条）。由队列上限推导，不做成配置。 */
  readonly fingerprintCap: number
  /** 条目最长存活时长（毫秒）。超龄的直接清掉：上周的 CI 失败现在播报毫无意义。 */
  readonly maxAgeMs: number
  /** 摘要字符上限。 */
  readonly summaryMaxChars: number
  /** 静默时段是否启用。 */
  readonly quietEnabled: boolean
  /** 静默起点（时，0–23，含）。 */
  readonly quietStartHour: number
  /** 静默终点（时，0–23，不含）。与起点相同视为不设静默。 */
  readonly quietEndHour: number
}

/** 对外服务。 */
export interface InboxService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: WebhookInboxErrorCode
  /** 状态是否真的落盘。 */
  readonly stored: boolean

  /**
   * 交一条事件进来。**唯一入箱入口**（会写盘）。
   * @param event 宿主解析好的事件。
   * @param at 时刻，省略用事件自带的 `at`，再省略用系统时间。
   */
  ingest(event: InboxEvent, at?: number): IngestResult

  /**
   * 取一批可投递的条目。**只读，不推进**：不 ack 就会一直取到同一批。
   * @param at 时刻，省略用系统时间。
   */
  pending(at?: number): PendingBatch

  /**
   * 确认这些条目已经投递出去。**必须由真正发消息的那一方调**（会写盘）。
   * @param ids 条目 id 列表。
   * @param at 时刻，省略用系统时间。
   */
  ack(ids: readonly string[], at?: number): AckResult

  /**
   * 全量只读视图。
   * @param at 时刻，省略用系统时间。
   */
  snapshot(at?: number): InboxSnapshot

  /** 累计统计快照。 */
  stats(): InboxStats
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

/** O-003 日历字段的结构对位子集。静默时段只需要「几点」。 */
export interface ClockPartsLike {
  /** 时，0–23。 */
  readonly hour: number
}

/** O-003 时钟服务的结构对位子集。**不重写日历**，只取这两项。 */
export interface ClockLike {
  now(): number
  parts(epoch?: number): ClockPartsLike
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
