/**
 * O-055 `ondra-router` 的对外契约。
 *
 * 定位：**通道公共层的「判定 + 排队 + 能力查询」三件套**，外加一条 P0 纪律
 * （手册 §5.4「唤醒身份纪律」）的落点。
 *
 * ## 三条边界，写在这里是因为它们决定了整个形状
 *
 * 1. **不发消息、不碰协议。** 本插件只回答「这条该不该处置、该怎么处置、
 *    排在第几位」，以及「这个通道能发什么」。真正发出去的是各适配器
 *    （O-058 ~ O-067）。否则公共层会变成第 10 个适配器，且它是唯一
 *    一个不知道自己跑在哪条协议上的适配器。
 *
 * 2. **不判「此刻该不该主动说」。** 静默时段、日额度、放弃率归
 *    O-042 `ondra-proactive-gate`（服务端权威）。本插件判的是**入站消息**
 *    的处置——两者看着都叫「该不该说话」，但一个看时间，一个看来信。
 *    两处都做，就会出现「proactive 说该说、router 说不该唤醒」，
 *    而用户只会看到「她有时听不见我」。
 *
 * 3. **不做频控、不做重试。** 各平台语义不同（手册 §6.1 与 §9.11 的
 *    分条上限、冷却、错误码全不一样），交给适配器自己。公共层一旦限流，
 *    就会出现「Telegram 被 QQ 的阈值卡住」这种没法解释的现象。
 *
 * ## 为什么「唤醒」与「回复」是两个动作
 *
 * 「唤醒」= 把她从闲置里叫起来处理，可能要提到前台、可能要 resume 冷会话；
 * 「回复」= 回一条，但不抢前台。差别来自 P0 纪律的反面：**主动叫醒只发生在私聊**
 * （手册 §5.4 / §5.6「唤醒只在私聊」），群里被 @ 只是回复，不是唤醒。
 * 压成一个布尔，适配器就只能靠猜「这次算不算把她叫起来了」。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const ROUTER_SERVICE_KEY = 'ondra-router'

/** 名字合规正则：服务键、工具名、配置键共用。**带冒号会被模型侧直接拒绝**。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/* ------------------------------------------------------------------ *
 * 会话与触发
 * ------------------------------------------------------------------ */

/** 会话形态。命名沿用上游会话列表的分区（手册 §7.1「按私聊/群聊两组分区」）。 */
export const CONVERSATION_KINDS = ['private', 'group'] as const

/** 一种会话形态。 */
export type ConversationKind = (typeof CONVERSATION_KINDS)[number]

/**
 * 这条消息是怎么来的。
 *
 * - `message`：普通来信（私聊里就是用户在说话）；
 * - `mention`：群里点名（@ 或回复她）；
 * - `keyword`：群里命中关键词（手册 §6.1「@ 机器人或关键词」）；
 * - `active`：**她自己想说话**（proactive 投递），不是用户发来的。
 *
 * `active` 必须与前三者分开：它是唯一一个「用户没开口」的触发，
 * 也是唯一一个该被「只在私聊唤醒」这条纪律管住的触发。
 */
export const TRIGGERS = ['message', 'mention', 'keyword', 'active'] as const

/** 一种触发。 */
export type Trigger = (typeof TRIGGERS)[number]

/** 判一个值是不是合法触发。上游填错枚举时按 `message` 处理，不拒收整条消息。 */
export function isTrigger(value: unknown): value is Trigger {
  return typeof value === 'string' && (TRIGGERS as readonly string[]).includes(value)
}

/** 判一个值是不是合法会话形态。 */
export function isConversationKind(value: unknown): value is ConversationKind {
  return typeof value === 'string' && (CONVERSATION_KINDS as readonly string[]).includes(value)
}

/* ------------------------------------------------------------------ *
 * 判定结果
 * ------------------------------------------------------------------ */

/**
 * 处置动作，**五值闭集**。
 *
 * - `wake`：叫醒她（私聊来信、私聊主动）；
 * - `reply`：回一条，但不叫醒（群里被点名/命中关键词）；
 * - `queue`：该处置，但目标会话正忙，已排队；
 * - `ignore`：不该处置（群聊没叫她、自己发的、重复投递、空消息、总开关关着）；
 * - `deny`：**拒绝**（白名单外、队列满）。
 *
 * `ignore` 与 `deny` 必须分开：前者是「本来就轮不到她」，
 * 后者是「本该轮到她但被挡住了」。合成一个，日志里就分不出
 * 「群里 200 条闲聊」和「三个人被白名单挡在外面」——后者是配置错误。
 */
export const ROUTE_ACTIONS = ['wake', 'reply', 'queue', 'ignore', 'deny'] as const

/** 一种处置动作。 */
export type RouteAction = (typeof ROUTE_ACTIONS)[number]

/**
 * 原因码，**十三值闭集**。每个码都对应一个不同的下一步动作，
 * 因此日志里出现任何一个都能直接照着办。
 */
export const ROUTE_REASONS = [
  /** 私聊来信（或私聊主动）→ 叫醒。 */
  'private-message',
  /** 群里点名 → 回复。 */
  'group-mentioned',
  /** 群里命中关键词 → 回复。 */
  'group-keyword',
  /** 群里没叫她 → 不处置。 */
  'group-not-addressed',
  /** 群里想主动说话 → 恒不处置（手册 §5.7 节制红线，无开关）。 */
  'group-active-ignored',
  /** 自己发的（防回声）。 */
  'self-echo',
  /** 同一条消息 1 秒内重复投递（手册 §5.4 四重锁第一重）。 */
  'duplicate',
  /** 没有正文也没有附件。 */
  'empty',
  /** 白名单外。 */
  'not-whitelisted',
  /** 总开关关着。 */
  'disabled',
  /** 私聊来信，但按 `wakeProbability` 这一次没叫醒她（拟人：有时不回）。 */
  'wake-skipped',
  /** 目标会话正忙，已排队。 */
  'busy-queued',
  /** 队列满，拒绝入队（**不是丢掉，是明确拒绝**）。 */
  'queue-full',
] as const

/** 一个原因码。 */
export type RouteReason = (typeof ROUTE_REASONS)[number]

/** 原因码的中文说法。**只给日志与面板**，不进正文（§4.3 禁命名）。 */
export const REASON_ZH: Readonly<Record<RouteReason, string>> = Object.freeze({
  'private-message': '私聊来信，叫醒她',
  'group-mentioned': '群里点名，回一条但不叫醒',
  'group-keyword': '群里命中关键词，回一条但不叫醒',
  'group-not-addressed': '群里没叫她，不处置',
  'group-active-ignored': '群聊永不主动（节制红线）',
  'self-echo': '自己发的，防回声',
  duplicate: '同一条消息重复投递，1 秒内已处置过',
  empty: '没有正文也没有附件',
  'not-whitelisted': '不在白名单里',
  disabled: '总开关关着',
  'wake-skipped': '私聊来信，但这次按概率没叫她（拟人不等于漏消息，见配置）',
  'busy-queued': '目标会话正忙，已排队',
  'queue-full': '队列已满，明确拒绝入队',
})

/* ------------------------------------------------------------------ *
 * 入参与受理结果
 * ------------------------------------------------------------------ */

/** 一条待判定的入站消息。 */
export interface RouteInput {
  /** 通道 id（如 `qq-official`）。只用来分组与查能力，**不参与放行判定**。 */
  readonly channelId: string
  /** 会话 id（同一对端在同通道内唯一）。占用与排队都按它计。 */
  readonly conversationId: string
  /** 私聊还是群聊。 */
  readonly kind: ConversationKind
  /** 怎么来的。 */
  readonly trigger: Trigger
  /** 正文。空串合法（只发了图），但此时 `hasAttachment` 必须为真。 */
  readonly text?: string
  /** 是否带附件（图/文件/贴纸）。正文为空时靠它区分「只发了图」与「空消息」。 */
  readonly hasAttachment?: boolean
  /** 平台消息 id。**有它才做 1 秒去重**——没有标识就只能每次当真。 */
  readonly messageId?: string
  /** 发送者 id。只进日志与队列记录，不参与判定。 */
  readonly senderId?: string
  /** 是不是她自己发的。缺省视为否（适配器应显式告诉）。 */
  readonly self?: boolean
  /**
   * 白名单结论。`false` 一律拒；`true` 放行；
   * **`undefined` 表示适配器没做白名单**，由 `strictWhitelist` 决定放不放。
   */
  readonly whitelisted?: boolean
  /** 这条消息产生的时刻（毫秒）。省略取时钟。 */
  readonly at?: number
}

/** 一次受理的结果。 */
export interface Admission {
  /** 处置动作。 */
  readonly action: RouteAction
  /** 原因码。 */
  readonly reason: RouteReason
  /**
   * 是否占用了这个会话。
   *
   * `true` 时调用方**必须**在处理完后调 `release(conversationId)`，
   * 否则该会话会一直显示「正忙」，后续消息全部进队列。
   * 这是本插件唯一一处「不 release 就会坏」的地方，故做成显式字段。
   */
  readonly reserved: boolean
  /** 该会话当前积压条数（含本次入队的那条）。 */
  readonly queueDepth: number
  /** 在队列里的位次（1 起）；未入队时为 0。 */
  readonly position: number
  /** 判定用的时刻（毫秒）。 */
  readonly at: number
}

/** 一条排队的消息。**只存内存**；正文超过 2000 字会被截断（排队不是归档）。 */
export interface QueueItem {
  /** 全局自增序号。队列跨会话共享一个计数器，便于日志对时序。 */
  readonly seq: number
  readonly channelId: string
  readonly conversationId: string
  readonly kind: ConversationKind
  readonly trigger: Trigger
  readonly text: string
  readonly at: number
  readonly messageId?: string
  readonly senderId?: string
}

/** 入队结果。 */
export interface EnqueueOutcome {
  /** 是否入队成功。 */
  readonly ok: boolean
  /** 入队后的积压条数。 */
  readonly depth: number
  /** 位次（1 起）；失败时为 0。 */
  readonly position: number
}

/* ------------------------------------------------------------------ *
 * 通道能力
 * ------------------------------------------------------------------ */

/**
 * 通道可选能力。
 *
 * **只列「能不能」，不列「怎么发」**：参数、鉴权、错误码全归适配器。
 * 能力表默认全空——`features: []` 的意思不是「未知」，是「只会发文字」。
 * 这个默认方向是刻意的（default-deny）：猜错「能发语音」的代价是
 * 消息被平台拒收，猜错「不能发」的代价只是少一种呈现。
 */
export const CHANNEL_FEATURES = ['image', 'voice', 'sticker', 'file'] as const

/** 一种可选能力。 */
export type ChannelFeature = (typeof CHANNEL_FEATURES)[number]

/** 判一个值是不是合法能力名。 */
export function isChannelFeature(value: unknown): value is ChannelFeature {
  return typeof value === 'string' && (CHANNEL_FEATURES as readonly string[]).includes(value)
}

/** 一个通道的能力声明。文字是基线，所以没有 `text` 这一项。 */
export interface ChannelCaps {
  /**
   * 单条正文上限（字符）。
   *
   * 手册 §9.11 的实测值：telegram 4000 / discord 1900 / dingtalk 4000 /
   * feishu 4000 / wecom 2000 / wechat-official 800 / wechat-kf 800 /
   * qq-official 1200 / wechat-personal 1000。
   * **本插件不内置这张表**：它是旧项目的实测值，各适配器的 Config 才是
   * 自己通道的真源；内置一份会与适配器打架，且新通道永远漏。
   */
  readonly maxChars: number
  /** 支持私聊。 */
  readonly privateChat: boolean
  /** 支持群聊。 */
  readonly groupChat: boolean
  /** 群里必须被点名才回（`true` 时关键词触发也不该回）。 */
  readonly mentionRequired: boolean
  /** 除文字外还能发什么。空数组 = 只会发文字。 */
  readonly features: readonly ChannelFeature[]
}

/** 一个通道的注册声明。 */
export interface ChannelSpec {
  /** 通道 id，匹配 `NAME_RE`。 */
  readonly id: string
  /** 中文名（日志与面板用）。 */
  readonly label: string
  /** 能力。 */
  readonly caps: ChannelCaps
}

/** 注册后读到的视图。 */
export interface ChannelView extends ChannelSpec {
  /** 注册时刻（毫秒）。 */
  readonly registeredAt: number
}

/** 注册失败原因。 */
export type RegisterFailure =
  /** id 不合规。 */
  | 'bad-id'
  /** 同一个 id 已被注册（先登记者为准，手册 §15.4）。 */
  | 'duplicate'
  /** 能力字段不合法（上限不是正整数之类）。 */
  | 'bad-caps'

/**
 * 注册结果。
 *
 * 刻意做成判别联合而不是「返回 disposer、失败返回空函数」：
 * 空函数会让「重复注册」表现为「注册成功但能力是旧的」，
 * 而这两件事的排查方向完全相反。
 */
export type RegisterResult =
  | { readonly ok: true; readonly dispose: () => void }
  | { readonly ok: false; readonly reason: RegisterFailure }

/** 判一个通道能不能发某类内容。 */
export function canSend(caps: ChannelCaps, feature: ChannelFeature): boolean {
  return caps.features.includes(feature)
}

/* ------------------------------------------------------------------ *
 * 唤醒身份纪律（P0，手册 §5.4）
 * ------------------------------------------------------------------ */

/**
 * 唤醒投递的正文，**恒为三个点**。
 *
 * 手册原话：「投递的正文只有三个点 `...`」——「既然每一条渲染路径都把
 * 正文留着，就让正文本身没有内容。」正文有内容，就等于她替主人说了句话；
 * 而 `SOUL.md` 明确禁止替主人说话，通道里又分不清「谁发的」。
 */
export const WAKE_BODY = '...'

/**
 * 唤醒说明段的段名。
 *
 * **注意**：段名不是服务键/工具名/配置键，不受 §8.4 正则约束（那三类必须
 * 是纯连字符）。提示词段名沿用上游的 `namespace:section` 惯例
 * （上游有 `plan:policy` 这类写法），故这里用冒号。
 */
export const WAKE_SECTION_NAME = 'ondra-router:wake'

/** 唤醒说明段。 */
export interface WakeSection {
  /** 段名（见 `WAKE_SECTION_NAME` 的说明）。 */
  readonly name: string
  /** 排序键。**排在最末**：它是解释，不是人格，压在稳定段之后才不会挤动前缀。 */
  readonly order: number
  /** 段正文。 */
  readonly text: string
  /** 字符数（给预算用）。 */
  readonly chars: number
}

/** 一次唤醒投递该长什么样。 */
export interface WakeDelivery {
  /** 投递的正文（恒为 `...`）。 */
  readonly body: string
  /**
   * 说明段。
   *
   * **本插件不自己去注册它**：段注册会动到会话前缀（手册 §8.5 冻结前缀），
   * 而前缀归组装方（O-023 / O-024 / O-036）。谁冻结前缀谁注册段，
   * 否则同一段会被两个地方按不同 order 拼进去。
   */
  readonly section: WakeSection
  /** 一句中文说明（日志与面板用）。 */
  readonly why: string
}

/* ------------------------------------------------------------------ *
 * 统计
 * ------------------------------------------------------------------ */

/** 累计统计。**只在内存**，不落盘（重启清零，见 README 已知限制）。 */
export interface RouterStats {
  /** 服务是否可用（只看配置开关）。 */
  readonly available: boolean
  /** 已注册通道数。 */
  readonly channels: number
  /** 当前占用的会话数。 */
  readonly busy: number
  /** 当前排队总条数。 */
  readonly queued: number
  /** 累计受理次数（含忽略与拒绝）。 */
  readonly admitted: number
  /** 累计叫醒次数。 */
  readonly woken: number
  /** 累计回复次数。 */
  readonly replied: number
  /** 累计忽略次数。 */
  readonly ignored: number
  /** 累计「按概率没叫醒」的次数（含在 `ignored` 里，单独列出便于判断概率是否调得过分）。 */
  readonly skipped: number
  /** 累计拒绝次数。 */
  readonly denied: number
  /** 累计入队条数。 */
  readonly queuedTotal: number
  /** 累计释放次数（占用结束）。 */
  readonly released: number
  /** 累计**没被处置**的条数（队列满 + 通道关闭清空）。 */
  readonly dropped: number
  /** 最近一次的原因码。 */
  readonly lastReason?: RouteReason
}

/** 服务不可用的原因。 */
export type RouterUnavailableReason = 'disabled'

/** 对外服务。 */
export interface RouterService {
  /** 是否启用（配置开关）。关掉后服务照常注册，一切判定给 `disabled`。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: RouterUnavailableReason

  /**
   * 受理一条入站消息：判定 + 占位（或排队）。**永不抛出。**
   *
   * 涉及状态（占用、队列、去重），所以不是纯函数——判定本身在 `decide.ts`
   * 里是纯的，状态只在 `service.ts` 的四个容器里。
   */
  admit(input: RouteInput): Admission

  /**
   * 释放占用，并**一次性交出**该会话积压的条目。
   *
   * 交出去之后这些条目就**离开队列**了：调用方按序处理，**不得再回 `admit`**。
   * 再做一次判定会让它们重新排队，形成「一释放就排回去」的死循环。
   */
  release(conversationId: string): readonly QueueItem[]

  /** 只读该会话的积压（不取出）。 */
  pending(conversationId: string): readonly QueueItem[]

  /** 当前所有会话的积压（按入队顺序）。 */
  queued(): readonly QueueItem[]

  /** 忘掉一个会话（通道关闭、会话销毁时调）。返回清掉的积压条数。 */
  forget(conversationId: string): number

  /** 注册一个通道的能力声明。 */
  registerChannel(spec: ChannelSpec): RegisterResult

  /** 读一个通道的能力；未注册时 `undefined`（**不是「零能力」**）。 */
  capabilities(channelId: string): ChannelView | undefined

  /** 已注册通道 id 列表（按注册顺序）。 */
  channelIds(): readonly string[]

  /** 唤醒投递该长什么样（正文 + 说明段）。 */
  wakeDelivery(): WakeDelivery

  /** 统计快照。 */
  stats(): RouterStats
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状（Cordis Logger 的结构对位子集）。 */
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
