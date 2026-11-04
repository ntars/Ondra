/**
 * O-134 `ondra-climb` 的对外契约。
 *
 * 定位：**把群里的未读积压压成一份「谁在什么时候说了什么」的清单**，
 * 并且只在私聊这一侧交出去。
 *
 * ## 三条边界，决定了整个形状
 *
 * 1. **不调模型。** 「摘要」在这里是**确定性截取**：去链接、并空白、取首句、
 *    截到上限。真概括归对话链（O-033 手里的模型）或记忆提炼（O-011）。
 *    在插件里调模型，会把「延迟与费用」绑到每一次爬楼，而且失败时
 *    用户看到的是一段半截的、像是她自己编的群聊内容——比不补读更糟。
 *
 * 2. **不往群里贴。** 积压是主人没看见的话，不是群里该被复读的话。
 *    `plan({chatKind:'group'})` 一律返回空计划（`reason: 'group-only'`），
 *    等下一次私聊再把清单交出去。这条是「唤醒只在私聊」的**执行方式**：
 *    不是靠调用方记得，而是群里根本拿不到东西。
 *
 * 3. **不落盘积压正文。** 群聊原文是别人的话，落在磁盘上就是一份没人同意的
 *    语料。本包只落**游标**（每个群读到哪一刻、哪些指纹已经读过），
 *    重启后靠通道重推补齐。丢一次补读，好过留一份不该留的原文。
 *
 * ## 为什么摘要里不写「还有 N 条」
 *
 * 手册 §12.1 的「禁止报数铁律」管的是**她对主人说话时不许报内部计数**。
 * 「还有 12 条没看」正是那种话：听起来像面板，不像人。所以折叠数只进
 * `plan.folded`（日志与面板读），**不进 `plan.text`**。清单末尾不加任何统计句。
 */

/** 本插件注册的服务键（连字符，符合 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const CLIMB_SERVICE_KEY = 'ondra-climb'

/** 名字合规正则：服务键、工具名、配置键共用。**带冒号会被模型侧直接拒绝**。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 会话种类，二值闭集。 */
export const CHAT_KINDS = ['group', 'private'] as const

/** 一种会话种类。 */
export type ChatKind = (typeof CHAT_KINDS)[number]

/**
 * 计划结果的原因，六值闭集。
 *
 * 每个值对应一个不同的处置：`group-only` 要等私聊；`no-backlog` 什么都不用做；
 * `all-seen` 说明游标没推进（多半是 `commit()` 没被调用）。
 */
export const CLIMB_REASONS = [
  'ok',
  'disabled',
  'group-only',
  'no-backlog',
  'all-seen',
  'too-long',
  'empty-input',
] as const

/** 一种计划原因。 */
export type ClimbReason = (typeof CLIMB_REASONS)[number]

/** 原因的中文说法。**只给日志与面板**，不进提示词。 */
export const REASON_ZH: Readonly<Record<ClimbReason, string>> = Object.freeze({
  ok: '有积压，已排好这一轮的清单',
  disabled: '爬楼已关闭',
  'group-only': '当前在群里：清单只在私聊交出去',
  'no-backlog': '没有待补读的积压',
  'all-seen': '积压都读过了（游标已覆盖）',
  'too-long': '有积压，但单条就超过了整块上限，一条也装不下',
  'empty-input': '入参不是数组或为空',
})

/** 一条待补读的群消息。**调用方交进来的原始形状**。 */
export interface BacklogItem {
  /** 群号（或会话标识）。1–64 字，必填。 */
  readonly groupId: string
  /** 群名。可缺，缺了就用群号当标题。 */
  readonly groupName?: string
  /** 会话种类。缺省按 `group` 处理（爬楼只关心群）。 */
  readonly chatKind: ChatKind
  /** 平台消息 id。有它就用它去重，比时间+正文可靠。 */
  readonly messageId?: string
  /** 说话人 id。可缺。 */
  readonly senderId?: string
  /** 说话人显示名。可缺，缺了写「某人」。 */
  readonly senderName?: string
  /** 发送时刻（毫秒）。必填且必须是个真时刻。 */
  readonly at: number
  /** 正文（已洗净、已截断）。 */
  readonly text: string
  /** 正文是否在入库时被截断。 */
  readonly truncated: boolean
}

/** 一次入库的结果。 */
export interface IngestOutcome {
  /** 收下几条。 */
  readonly accepted: number
  /** 判重跳过几条（同一条被通道重推）。 */
  readonly duplicate: number
  /** 拒收几条（结构不合法、正文为空、时刻不合理，或私聊积压且开关关闭）。 */
  readonly rejected: number
  /** 当前待补读总条数。 */
  readonly pending: number
}

/** 清单里的一行。 */
export interface DigestLine {
  /** 内部键（`种类:群号`）。**只给 commit 与审计用，不进正文**。 */
  readonly key: string
  /** 判重指纹。**只给 commit 与审计用，不进正文**。 */
  readonly fingerprint: string
  /** 群号。 */
  readonly groupId: string
  /** 群名（可能等于群号）。 */
  readonly groupName: string
  /** 发送时刻（毫秒）。 */
  readonly at: number
  /** 时刻的 `HH:mm` 写法（按 O-003 的时区）。 */
  readonly clock: string
  /** 说话人显示名。 */
  readonly sender: string
  /** 正文（已截断）。 */
  readonly text: string
  /** 拼好的整行：`[群名 群号] 14:05 阿岚：正文`。 */
  readonly line: string
  /** 正文是否被截断。 */
  readonly truncated: boolean
  /** 平台消息 id（有就带上，供审计对账）。 */
  readonly messageId?: string
}

/** `plan()` 的入参。 */
export interface PlanInput {
  /** 当前在哪种会话里。缺省 `private`。 */
  readonly chatKind?: ChatKind
  /** 当前会话 id。只用于日志，不参与筛选。 */
  readonly conversationId?: string
  /** 这一轮最多几条。省略用配置值，且不得超过配置值。 */
  readonly maxItems?: number
}

/** 一份补读计划。 */
export interface DigestPlan {
  /** 计划 id。`commit()` 要用它。 */
  readonly id: string
  /** 生成时刻（毫秒）。 */
  readonly at: number
  /** 清单行，**按时间升序**。 */
  readonly lines: readonly DigestLine[]
  /** 涉及哪几个群（去重、保序）。 */
  readonly groups: readonly string[]
  /** 清单正文长度（码位数）。 */
  readonly chars: number
  /**
   * 本轮没装下的条数。
   *
   * **只给日志与面板**。刻意不写进 `text`：那是报数，不是人话。
   * 而且它们**没有被丢弃**——还留在待补读里，下一轮继续。
   */
  readonly folded: number
  /** 本轮因过期被清掉的条数（这些是真丢了，只有它们会丢）。 */
  readonly expired: number
  /** 是否允许在这一轮提起。群里恒 `false`。 */
  readonly wake: boolean
  /** 结果原因。 */
  readonly reason: ClimbReason
  /** 可直接拼进提示词的块。**空计划时是空串**。 */
  readonly text: string
}

/** 一个群的积压视图（给面板）。 */
export interface PendingGroup {
  /** 群号。 */
  readonly groupId: string
  /** 群名。 */
  readonly groupName: string
  /** 会话种类。 */
  readonly chatKind: ChatKind
  /** 待补读条数。 */
  readonly count: number
  /** 最旧一条的时刻。 */
  readonly oldestAt: number
  /** 最新一条的时刻。 */
  readonly newestAt: number
}

/** 累计计数（只在内存）。 */
export interface ClimbCounters {
  /** 收下的总条数。 */
  readonly ingested: number
  /** 判重跳过的总条数。 */
  readonly duplicate: number
  /** 拒收的总条数。 */
  readonly rejected: number
  /** 过期清掉的总条数。 */
  readonly expired: number
  /** 生成的计划数。 */
  readonly planned: number
  /** 被确认的计划数。 */
  readonly committed: number
  /** 因超上限挤掉最旧的总条数。 */
  readonly overflowed: number
  /** 游标写盘失败次数。 */
  readonly writeFailed: number
}

/** 现状快照。 */
export interface ClimbStats {
  /** 服务是否可用（未卸载）。 */
  readonly available: boolean
  /** 游标是否落盘。 */
  readonly stored: boolean
  /** 待补读总条数。 */
  readonly pending: number
  /** 有积压的群数。 */
  readonly groups: number
  /** 最近一次计划的时刻。 */
  readonly lastPlanAt: number
  /** 累计计数。 */
  readonly counters: ClimbCounters
}

/** 对外服务。 */
export interface ClimbService {
  /** 是否可用（未卸载）。 */
  readonly available: boolean
  /** 游标是否真的落在磁盘上（`false` 时重启会重读一遍积压）。 */
  readonly stored: boolean

  /**
   * 交进一批积压。**永不抛错**。
   *
   * 判重口径：`messageId` 优先；没有就按「群号 + 时刻 + 正文」算指纹。
   * 同一批里重复、与已读重复、与待补读重复，都记 `duplicate`。
   */
  ingest(items: readonly unknown[]): IngestOutcome

  /**
   * 排一份补读清单。**纯读，不改游标**。
   *
   * 不改游标是为了「发失败不丢消息」：只有 `commit()` 才推进。
   */
  plan(input?: PlanInput): DigestPlan

  /**
   * 确认这份清单已经交出去了，推进游标。
   *
   * 为什么必须显式确认：`plan()` 之后发送可能失败（通道断、被门控拦）。
   * 自动推进的后果是「那 12 条永远没人再提」，而且不报错。
   * @param planId 计划 id。
   */
  commit(planId: string): boolean

  /** 各群积压视图，按最旧一条升序。**只出计数与时刻，不出正文**。 */
  pending(): readonly PendingGroup[]

  /** 现状快照。 */
  stats(): ClimbStats

  /**
   * 清掉积压与游标。
   * @param groupId 只清这个群；省略则全清。
   */
  reset(groupId?: string): void

  /** 卸载（幂等）。 */
  dispose(): void
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
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

/** O-002 路径服务的结构对位子集。 */
export interface PathLike {
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  ensure(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  prepareFile(filePath: string): string
  exists(filePath: string): boolean
}

/** O-003 日历切片的对位子集。 */
export interface ClockPartsLike {
  readonly hour: number
  readonly minute: number
}

/** O-003 时间服务的结构对位子集。 */
export interface ClockLike {
  now(): number
  dayKey(epoch?: number): string
  parts(epoch?: number): ClockPartsLike
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

/** O-005 配置真源的结构对位（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
