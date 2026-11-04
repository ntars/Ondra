/**
 * O-058 `ondra-adapter-qq-official` 的对外契约。
 *
 * 定位：QQ 开放平台（官方机器人）通道适配器。**档位〔复〕——传输不自己写。**
 *
 * ## 为什么传输是一个端口，而不是直接 `new WebSocket()`
 *
 * 手册 §9.11 只给了四条可核对的事实：WS 长连、`/app/getAppAccessToken`、
 * 请求头 `QQBot <t>`、被动回复必须带原 `msg_id`、单条上限 1200。
 * **它没有给 WS 的帧格式**（op 码、identify 载荷、心跳应答、resume 序列号），
 * 而 `desktop/docs` 与 `desktop/packages` 全文检索 `getAppAccessToken` / `QQBot` /
 * `msg_id` **零命中**，本仓也不允许装依赖。
 *
 * 在这种前提下自己拼一版握手，写出来的东西会「看起来能跑」：连上了但收不到
 * 事件，或者收到事件但字段名猜错——而这两种都会表现为「她不回话」，
 * 与「传输根本没接」完全同形。所以这里把传输做成 `QqTransport` 端口：
 * 谁有真实实现（官方 SDK / 已验证的客户端 / 后续轮次补的依据）谁注入，
 * 本插件负责它上面那一层——分条、被动回复的 `msg_id`、六道闸、隔离、日志。
 *
 * ## 为什么 `reply()` 必须显式带 `msgId`
 *
 * 手册 §9.11：「被动回复须带原 `msg_id`」。不带就被平台拒收，
 * 而且拒收理由通常只说「参数错误」。让调用方显式给出 `msgId`，
 * 比在内部猜「最近那条是不是我要回的那条」安全——猜错就是把 A 的回复发进 B 的会话。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const QQ_SERVICE_KEY = 'ondra-adapter-qq-official'

/** 通道 id。日志命名空间为 `channel.qq-official`，凭据为 `user/channels/qq-official.json`。 */
export const CHANNEL_ID = 'qq-official'

/** 中文名，日志与面板用。 */
export const CHANNEL_LABEL = 'QQ（官方机器人）'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 单条正文上限（字符）。手册 §9.11 的实测值：`qq-official 1200`。
 *
 * 这是平台的硬上限，不是「建议值」：超过会被拒收或截断，
 * 所以 `chunkMax` 只能往下调，不能往上调（配置校验会夹紧）。
 */
export const CHUNK_MAX = 1200

/** 内容闸长度（手册 §5.3-1：`maxLen 1800`，超长触发内容扫描）。 */
export const CONTENT_MAX_LEN = 1800

/**
 * 风控错误码（手册 §5.3-6：`[100,1200,1201,1202,1500]`）。
 *
 * 命中这些码说明**已经被盯上**，唯一正确的做法是停嘴，不是重试。
 */
export const RISK_CODES: readonly string[] = Object.freeze(['100', '1200', '1201', '1202', '1500'])

/** 风控退避阶梯（秒）。手册 §5.3-6：指数退避，线性退避等于持续挑衅。 */
export const BACKOFF_SECONDS: readonly number[] = Object.freeze([30, 60, 120, 300, 600, 1800])

/** 深夜静默起止（手册 §5.3-2：`00:30–07:30`，Asia/Shanghai）。 */
export const QUIET_START = '00:30'

/** 深夜静默结束。 */
export const QUIET_END = '07:30'

/** 东八区偏移（分钟）。国内无夏令时，故用固定偏移而不是 Intl 时区库。 */
export const TZ_OFFSET_MIN = 480

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/** 凭据。**只从 `user/channels/qq-official.json` 读，不从配置读。** */
export interface QqCredentials {
  /** 机器人 AppID。 */
  readonly appId: string
  /** 机器人 ClientSecret（等价于密码，永不进日志）。 */
  readonly clientSecret: string
}

/** 凭据读取失败原因。 */
export type CredentialFailure = 'missing' | 'bad-json' | 'bad-shape' | 'bad-perm'

/** 凭据读取结果。 */
export interface CredentialLoad {
  /** 是否读到可用凭据。 */
  readonly ok: boolean
  /** 读到时的值。 */
  readonly value?: QqCredentials
  /** 失败原因。 */
  readonly reason?: CredentialFailure
  /** 一句中文说明（含它到底在找哪个路径）。 */
  readonly detail: string
  /** 文件权限是否被收紧过（过宽时本插件会 chmod 0600）。 */
  readonly permissionTightened: boolean
}

/* ------------------------------------------------------------------ *
 * 传输端口
 * ------------------------------------------------------------------ */

/** 发送目标。 */
export interface QqTarget {
  /** 私聊还是群。 */
  readonly kind: 'private' | 'group'
  /** 对方 openid / 群 openid。 */
  readonly peerId: string
}

/** 一次发送请求。 */
export interface QqSendRequest {
  /** 发给谁。 */
  readonly target: QqTarget
  /** 正文（已切好，**不超过 `CHUNK_MAX`**）。 */
  readonly text: string
  /**
   * 被动回复要带的原消息 id。
   *
   * `active=true`（主动发言）时可以不带——但主动发言本来受 §5.3 六道闸的
   * 深夜静默与额度双重限制，本插件默认不让它走这条路径。
   */
  readonly msgId?: string
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/** 一次发送结果。 */
export interface QqSendResult {
  /** 平台收下了没有。 */
  readonly ok: boolean
  /** 平台错误码（`ok=false` 时尽量给）。 */
  readonly code?: string
  /** 平台原话（只进日志，不进正文）。 */
  readonly message?: string
}

/** 传输交给适配器的事件回调。 */
export interface QqTransportHandlers {
  /** 长连就绪（可发消息）。 */
  readonly onReady: () => void
  /** 收到一条已经解析好的来信。 */
  readonly onInbound: (event: QqInbound) => void
  /** 传输自己的一次心跳（用于向探针证明「还活着」）。 */
  readonly onHeartbeat: () => void
  /** 传输层错误（断线、鉴权失败、限流）。 */
  readonly onError: (code: string, detail?: string) => void
  /** 连接关闭。 */
  readonly onClosed: (reason: string) => void
}

/**
 * 传输端口。
 *
 * 实现方要负责：WS 帧协议、token 刷新、重连、事件解析。
 * **本插件不实现它**，理由见文件头。
 */
export interface QqTransport {
  /** 实现名（日志与面板显示，例如 `official-sdk`）。 */
  readonly name: string
  /** 建立连接。失败请走 `handlers.onError` / `onClosed`，不要抛。 */
  open(handlers: QqTransportHandlers): Promise<void>
  /** 关闭连接。必须幂等。 */
  close(): void
  /** 发一条。**永不抛错**，失败折成 `{ok:false}`。 */
  send(request: QqSendRequest): Promise<QqSendResult>
}

/** 传输工厂。拿到凭据后造一个传输实例。 */
export type QqTransportFactory = (credentials: QqCredentials) => QqTransport

/* ------------------------------------------------------------------ *
 * 来信
 * ------------------------------------------------------------------ */

/** 一条已经解析好的来信。 */
export interface QqInbound {
  /** 平台消息 id。**被动回复要用它**，也是去重键。 */
  readonly messageId: string
  /** 私聊还是群。 */
  readonly kind: 'private' | 'group'
  /** 对方 openid / 群 openid。 */
  readonly peerId: string
  /** 发送者 openid（群里与 `peerId` 不同）。 */
  readonly senderId?: string
  /** 正文。空串合法（只发了图）。 */
  readonly text: string
  /** 发生时刻（毫秒），省略取时钟。 */
  readonly at?: number
  /** 是不是她自己发的（防回声）。 */
  readonly self?: boolean
  /** 是否带附件。正文为空时靠它区分「只发了图」与「空消息」。 */
  readonly hasAttachment?: boolean
}

/* ------------------------------------------------------------------ *
 * 启停
 * ------------------------------------------------------------------ */

/**
 * 启动失败原因，**五值闭集**。
 *
 * `no-transport` 是今天最常见的一个：凭据配好了、开关打开了，
 * 但没有人注入传输实现。必须明确说出来，不能表现成「连了一会儿没反应」。
 */
export const START_FAILURES = [
  'disabled',
  'already-started',
  'no-credential',
  'no-transport',
  'bad-id',
] as const

/** 一种启动失败原因。 */
export type StartFailure = (typeof START_FAILURES)[number]

/** 启动失败的中文说法。 */
export const START_FAILURE_ZH: Readonly<Record<StartFailure, string>> = Object.freeze({
  disabled: '通道开关是关的（默认关：一装就连是事故，不是功能）',
  'already-started': '已经在跑了',
  'no-credential': '没有可用的凭据',
  'no-transport': '没有传输实现（WS 帧协议本仓无依据，见 README 已知限制）',
  'bad-id': '通道 id 不合规',
})

/** 启动结果。 */
export interface StartOutcome {
  /** 是否成功交给传输去连。 */
  readonly ok: boolean
  /** 失败原因。 */
  readonly reason?: StartFailure
  /** 一句中文说明。 */
  readonly detail: string
}

/* ------------------------------------------------------------------ *
 * 闸门
 * ------------------------------------------------------------------ */

/**
 * 闸门拒绝原因，**九值闭集**（含放行）。
 *
 * 每个码对应一个不同的动作：`too-long` 要去看看是不是没切条；
 * `quiet-hours` 是设计如此；`circuit-open` 是被盯上了；
 * `rate-limited` 是配额到了。合成一个 `blocked` 就只能靠猜。
 */
export const GATE_REASONS = [
  'allow',
  'empty',
  'too-long',
  'blocked-content',
  'quiet-hours',
  'duplicate',
  'circuit-open',
  'backing-off',
  'rate-limited',
  'cooling',
] as const

/** 一种闸门结论。 */
export type GateReason = (typeof GATE_REASONS)[number]

/** 闸门结论的中文说法。**只给日志与面板**。 */
export const GATE_REASON_ZH: Readonly<Record<GateReason, string>> = Object.freeze({
  allow: '放行',
  empty: '没有正文',
  'too-long': '正文过长',
  'blocked-content': '命中内容闸',
  'quiet-hours': '深夜静默（只拦主动发言）',
  duplicate: '同一句话刚发过',
  'circuit-open': '熔断中：被盯上时唯一正确的做法是完全闭嘴',
  'backing-off': '风控退避中',
  'rate-limited': '超出令牌桶',
  cooling: '会话冷却中',
})

/** 一次闸门判定。 */
export interface GateVerdict {
  /** 是否放行。 */
  readonly allow: boolean
  /** 结论。 */
  readonly reason: GateReason
  /** 放行时还需要等多久（抖动 / 退避剩余，毫秒）。 */
  readonly delayMs: number
  /** 一句中文说明。 */
  readonly detail: string
}

/* ------------------------------------------------------------------ *
 * 发送结果
 * ------------------------------------------------------------------ */

/**
 * 一次回复的结论，**八值闭集**。
 *
 * `partial` 是刻意单列的：三段发出去两段就被风控打断，
 * 与「一段都没发出去」必须能区分——前者用户会看到半句话，后者什么都没看到。
 */
export const REPLY_REASONS = [
  'sent',
  'partial',
  'empty',
  'blocked',
  'no-transport',
  'no-kit',
  'send-failed',
  'disabled',
] as const

/** 一种回复结论。 */
export type ReplyReason = (typeof REPLY_REASONS)[number]

/** 一次回复的结果。 */
export interface ReplyOutcome {
  /** 是否全部发出。 */
  readonly ok: boolean
  /** 成功发出的条数。 */
  readonly sent: number
  /** 应发条数（切条后）。 */
  readonly total: number
  /** 实际发出去的正文（按序）。 */
  readonly pieces: readonly string[]
  /** 结论。 */
  readonly reason: ReplyReason
  /** 闸门结论（放行时也带，便于日志对时序）。 */
  readonly gate: GateReason
  /** 一句中文说明。 */
  readonly detail: string
  /** 本次被要求等待的毫秒数（抖动 / 退避）。 */
  readonly delayMs: number
}

/* ------------------------------------------------------------------ *
 * 受理
 * ------------------------------------------------------------------ */

/** 受理结论，**六值闭集**。只回答「接住了没有」，不回答「回不回」。 */
export const INGEST_REASONS = [
  'accepted',
  'duplicate',
  'self',
  'empty',
  'disabled',
  'bad-id',
] as const

/** 一种受理结论。 */
export type IngestReason = (typeof INGEST_REASONS)[number]

/** 一次受理结果。 */
export interface IngestOutcome {
  /** 是否接住（接住不代表会回）。 */
  readonly accepted: boolean
  /** 结论。 */
  readonly reason: IngestReason
  /** 归一化后的会话 id（`qq-official:private:<openid>`）。 */
  readonly conversationId: string
  /** 路由给了什么处置（没有 router 时为空串）。 */
  readonly action: string
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

/** 通道状态。 */
export interface AdapterStatus {
  /** 通道 id。 */
  readonly channelId: string
  /** 中文名。 */
  readonly label: string
  /** 配置开关。 */
  readonly enable: boolean
  /** 传输是否已就绪。 */
  readonly connected: boolean
  /** 传输实现名；没有则为 `null`。 */
  readonly transport: string | null
  /** 当前状态码。 */
  readonly state: 'ready' | 'connecting' | 'disabled' | 'no-credential' | 'no-transport' | 'closed'
  /** 一句中文说明。 */
  readonly detail: string
  /** 启动时刻。 */
  readonly startedAt: number | null
  /** 最后收信时刻。 */
  readonly lastInboundAt: number | null
  /** 最后发信时刻。 */
  readonly lastOutboundAt: number | null
  /** 是否处于熔断。 */
  readonly circuitOpen: boolean
}

/** 运行统计。 */
export interface AdapterStats {
  /** 收到的来信（含被拒）。 */
  readonly inbound: number
  /** 接住的来信。 */
  readonly accepted: number
  /** 重复投递被吃掉的条数。 */
  readonly duplicates: number
  /** 成功发出的分条数。 */
  readonly sent: number
  /** 被闸门拦下的次数。 */
  readonly blocked: number
  /** 发送失败次数。 */
  readonly failures: number
  /** 风控命中次数。 */
  readonly riskHits: number
}

/** 对外服务。**所有方法都不抛出**。 */
export interface QqOfficialService {
  /** 通道 id（恒为 `qq-official`）。 */
  readonly channelId: string
  /** 配置开关。 */
  readonly available: boolean

  /**
   * 注入一个传输实现并开始连接。
   * @param transport 传输。
   */
  useTransport(transport: QqTransport): StartOutcome

  /**
   * 启动。`enable=false` / 没凭据 / 没传输都会返回带原因码的失败。
   * **不抛错。**
   */
  start(): StartOutcome

  /** 停止。幂等；关闭后不残留定时器与 socket。 */
  stop(): void

  /** 当前状态快照。 */
  status(): AdapterStatus

  /** 传输把一条已解析来信喂进来。 */
  ingest(event: QqInbound): IngestOutcome

  /** 发一条（会过闸、切条、逐段发）。 */
  reply(input: ReplyInput): Promise<ReplyOutcome>

  /** 心跳节拍：由宿主定时器调，向探针证明「还活着」。 */
  tick(): void

  /** 把闸门状态落盘。 */
  flush(): void

  /** 统计快照。 */
  stats(): AdapterStats
}

/** 一次回复的入参。 */
export interface ReplyInput {
  /** 发给谁。 */
  readonly target: QqTarget
  /** 正文。 */
  readonly text: string
  /** 被动回复要带的原消息 id。主动发言可省略（但默认不允许主动发言）。 */
  readonly msgId?: string
  /** 会话 id（冷却按它计）。省略用 `qq-official:<kind>:<peerId>`。 */
  readonly conversationId?: string
  /** 是否主动发言（`true` 时会受深夜静默约束）。默认 `false`。 */
  readonly active?: boolean
}

/* ------------------------------------------------------------------ *
 * 外部形状的结构对位（不 import 别人的源码，见 master-plan §18.5）
 * ------------------------------------------------------------------ */

/** 日志门面。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-001 身份服务子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-003 时钟子集。 */
export interface ClockLike {
  now(): number
}

/** O-002 路径服务子集。 */
export interface PathLayoutLike {
  fileIn(area: 'user', ...segments: string[]): string
  prepareFile(filePath: string): string
  ensure(area: 'user', ...segments: string[]): string
}

/** O-055 的能力声明子集。 */
export interface ChannelCapsLike {
  /** 单条上限。 */
  readonly maxChars: number
  /** 支持私聊。 */
  readonly privateChat: boolean
  /** 支持群聊。 */
  readonly groupChat: boolean
  /** 群里必须被点名才回。 */
  readonly mentionRequired: boolean
  /** 除文字外还能发什么。QQ 官方机器人本插件只做文字，故为空。 */
  readonly features: readonly ('image' | 'voice' | 'sticker' | 'file')[]
}

/** O-055 的通道注册声明子集。 */
export interface ChannelSpecLike {
  /** 通道 id。 */
  readonly id: string
  /** 中文名。 */
  readonly label: string
  /** 能力。 */
  readonly caps: ChannelCapsLike
}

/** O-055 的注册结果子集。 */
export interface RegisterResultLike {
  /** 是否成功。 */
  readonly ok: boolean
  /** 失败原因。 */
  readonly reason?: string
  /** 成功时的撤除函数。 */
  readonly dispose?: () => void
}

/** O-055 路由服务子集。 */
export interface RouterLike {
  admit(input: {
    readonly channelId: string
    readonly conversationId: string
    readonly kind: 'private' | 'group'
    readonly trigger: 'message' | 'mention' | 'keyword' | 'active'
    readonly text?: string
    readonly hasAttachment?: boolean
    readonly messageId?: string
    readonly senderId?: string
    readonly self?: boolean
    readonly at?: number
  }): {
    readonly action: string
    readonly reason: string
    readonly reserved: boolean
    readonly queueDepth: number
    readonly position: number
  }
  release(conversationId: string): readonly {
    readonly text: string
    readonly messageId?: string
    readonly trigger: string
    readonly kind: 'private' | 'group'
    readonly channelId: string
    readonly senderId?: string
  }[]
  /** 登记本通道的能力（能力表归适配器，公共层不内置）。 */
  registerChannel(spec: ChannelSpecLike): RegisterResultLike
}

/** O-056 公共段服务子集。 */
export interface KitLike {
  chunk(text: string, max: number): { readonly pieces: readonly string[] }
  callPersona(input: {
    readonly conversationId: string
    readonly text: string
    readonly maxChars?: number
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  }): Promise<{
    readonly ok: boolean
    readonly text: string
    readonly pieces: readonly string[]
    readonly partial: boolean
    readonly failure?: string
    readonly reason?: string
  }>
}

/** O-057 探针服务子集（只声明本插件会用的两个方法）。 */
export interface HealthLike {
  report(
    event:
      | {
          readonly channelId: string
          readonly kind: 'connected' | 'disconnected' | 'heartbeat' | 'inbound' | 'outbound' | 'error'
          readonly at?: number
          readonly code?: string
          readonly detail?: string
        }
      | readonly {
          readonly channelId: string
          readonly kind: 'connected' | 'disconnected' | 'heartbeat' | 'inbound' | 'outbound' | 'error'
          readonly at?: number
          readonly code?: string
          readonly detail?: string
        }[],
  ): number
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
