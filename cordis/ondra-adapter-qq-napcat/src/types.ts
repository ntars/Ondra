/**
 * O-059 `ondra-adapter-qq-napcat` 的对外契约。**档位〔复〕——QQ 协议不自己写。**
 *
 * ## 这个插件到底是什么位置
 *
 * 手册 §6.1 的链路是：
 *
 * ```
 * QQ ←→ NapCat（OneBot v11，反向 WS，NapCat 主动连入）←→ 本插件 ←→ 路由 / 公共段
 * ```
 *
 * 注意方向：**反向 WS 意味着本端是服务端、NapCat 是客户端**。所以配置里
 * 是三样东西——`listHost` / `port` / `path`，而**不是**一个 `wsUrl`。
 * master-plan §9.12 记着旧项目正是把这两者写反了（表单填 `wsUrl`、源码读 `port`），
 * 症状是「界面填了、通道连不上」。本插件从字段命名上就不给写反的机会：
 * 填地址的那一端叫 `listHost`，填端口的那一端叫 `port`，`wsUrl` 是 **NapCat 侧**要填的值，
 * 只出现在 README 的部署说明里。
 *
 * ## 为什么传输仍然是端口
 *
 * NapCat 是外部进程（§12.3：协议端明确禁止衍生开发，本仓只做**外部进程对接**），
 * 这一层我们已经做到了：`ctx.webServer.registerUpgrade()` 是宿主确认存在的升级路由扩展点，
 * 本插件真的注册了它，也真的会把升级后的 socket 交给传输实现。
 *
 * 缺的是**最后一步**：OneBot v11 的事件字段、动作名与 WS 帧编解码。
 * 手册只写了「OneBot v11」这五个字，本仓 `desktop/docs`、`desktop/packages`
 * 检索 `onebot` / `OneBot` **零命中**，且本仓禁装依赖。
 * 自己补一版会「看起来能跑」：握手成功、事件收不到，或字段名猜错——
 * 两种都表现为「她不回话」，与「根本没接」同形。
 *
 * 所以：**接线做到最后一厘米，编解码留给端口**。`start()` 在端口为空时明确报 `no-transport`，
 * upgrade 路由对任何来信直接回 503 并写明原因，绝不挂着假监听。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const NAPCAT_SERVICE_KEY = 'ondra-adapter-qq-napcat'

/** 通道 id。日志命名空间 `channel.qq-napcat`，凭据 `user/channels/qq-napcat.json`。 */
export const CHANNEL_ID = 'qq-napcat'

/** 中文名，日志与面板用。 */
export const CHANNEL_LABEL = 'QQ（NapCat / OneBot v11）'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 单条正文上限（字符）。
 *
 * 手册 §9.11 的实测表里**没有 napcat 这一行**（它是协议端，不是官方 API），
 * 所以这里取 QQ 官方的 1200 作默认：同一个客户端、同一条消息渲染管线。
 * 登记为待裁决项（见 README 第九节）。
 */
export const CHUNK_MAX = 1200

/** 单条上限的配置上界：2000。再高客户端会把消息折叠成「展开」样式。 */
export const CHUNK_CEIL = 2000

/** 单条上限的配置下界：200。再低就成了「一句话拆五条」，本身就是机器人特征。 */
export const CHUNK_MIN = 200

/** 内容闸长度（手册 §5.3-1：`maxLen 1800`）。 */
export const CONTENT_MAX_LEN = 1800

/** 风控错误码（手册 §5.3-6）。命中说明已被盯上，唯一正确做法是停嘴。 */
export const RISK_CODES: readonly string[] = Object.freeze(['100', '1200', '1201', '1202', '1500'])

/** 风控退避阶梯（秒）。手册 §5.3-6：指数退避，线性退避等于持续挑衅。 */
export const BACKOFF_SECONDS: readonly number[] = Object.freeze([30, 60, 120, 300, 600, 1800])

/** 深夜静默起止（手册 §5.3-2：`00:30–07:30`，东八区）。 */
export const QUIET_START = '00:30'

/** 深夜静默结束。 */
export const QUIET_END = '07:30'

/** 东八区偏移（分钟）。国内无夏令时，用固定偏移而不是时区库。 */
export const TZ_OFFSET_MIN = 480

/** 监听地址默认值（手册 §6.1：Config 必须有 `listHost`，默认 `127.0.0.1`）。 */
export const DEFAULT_LIST_HOST = '127.0.0.1'

/**
 * 监听端口默认值：3001。
 *
 * 依据手册 §6.5/§6.1 的容器链路「HTTP 3000 / WS 3001」这一对常用端口，
 * 且 3001 不在 L7 的 9060–9079 回环端口池里，不会与宿主自选端口撞。
 */
export const DEFAULT_LIST_PORT = 3001

/** 升级路由路径默认值。NapCat 侧填 `ws://<listHost>:<port>/onebot/v11/ws`。 */
export const DEFAULT_LIST_PATH = '/onebot/v11/ws'

/** 凭据文件名后缀。 */
export const CREDENTIAL_FILE_SUFFIX = '.json'

/** 状态文件名后缀。 */
export const STATE_FILE_SUFFIX = '.state.json'

/** 二次确认档案后缀（§16.2-6：高危通道的确认独立存档）。 */
export const CONFIRM_FILE_SUFFIX = '.confirm.json'

/**
 * 高危通道说明（§16.2-6 要求单独成块、不与合规通道混排）。
 *
 * 文案写死在常量里而不是配置里：风控提示是**产品责任**，
 * 能被用户改掉的警告等于没有警告。
 */
export const RISK_NOTICE_ZH: string = Object.freeze(
  [
    '⚠️ 高危通道：NapCat 属非官方协议端，使用这一路等于用你的真实 QQ 号跑自动化。',
    '· 客户端特征识别挡不住：手册 §5.3-8 实测 4.18.18 约 2 小时被踢、4.18.41 撑 9.5 小时。',
    '· 群举报、新号养号期、一号多群都会加速封号；封的是你的号，不是这个插件。',
    '· 节制不是功能，是生存红线（§5.7）：群聊不主动、白名单外不发、一键静音必须可用。',
    '· NapCat 代码本仓不引入、不改写、不分发（§12.3），只以外部进程对接。',
    '打开本通道需要两项同时为真：`enable` 与 `confirmed`，并在确认档案里留下一条带说明的记录。',
  ].join('\n'),
)

/* ------------------------------------------------------------------ *
 * 凭据与二次确认
 * ------------------------------------------------------------------ */

/** 凭据。**只从 `user/channels/qq-napcat.json` 读，不从配置读。** */
export interface NapCatCredentials {
  /** NapCat 侧配置的 access token（两端必须一致）。 */
  readonly token: string
}

/** 凭据读取失败原因。 */
export type CredentialFailure = 'missing' | 'bad-json' | 'bad-shape' | 'bad-perm' | 'empty-token'

/** 凭据读取结果。 */
export interface CredentialLoad {
  /** 是否读到可用凭据。 */
  readonly ok: boolean
  /** 读到时的值（只在内存里活到 start 结束）。 */
  readonly value?: NapCatCredentials
  /** 失败原因。 */
  readonly reason?: CredentialFailure
  /** 一句中文说明（含它到底在找哪个路径）。 */
  readonly detail: string
  /** 文件权限是否被就地收紧过（过宽时 chmod 0600）。 */
  readonly permissionTightened: boolean
}

/** 二次确认档案（§16.2-6「二次确认独立存档」）。 */
export interface ConfirmRecord {
  /** 是否确认过。只认字面量 `true`。 */
  readonly confirmed: boolean
  /** 确认时刻（毫秒）。 */
  readonly at: number
  /** 确认人写的说明（≥4 字，逼着人写清楚确认了什么）。 */
  readonly note: string
}

/* ------------------------------------------------------------------ *
 * 传输端口（反向 WS：NapCat 连入本端）
 * ------------------------------------------------------------------ */

/** 升级请求（只声明实现方会用到的字段）。 */
export interface NapCatUpgradeRequestLike {
  /** 请求 URL（含 query，里面可能有 `access_token`）。 */
  readonly url?: string
  /** 请求头。 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

/** 已升级的 socket（Duplex 的结构对位，避免为了一个类型引入 node:net）。 */
export interface NapCatDuplexLike {
  /** 写一段数据。 */
  write(chunk: Uint8Array): boolean
  /** 优雅关闭。 */
  end(): void
  /** 立即销毁。 */
  destroy(error?: Error): void
}

/** 传输交给适配器的来信（**已归一化**，字段名不沿用 OneBot 的命名）。 */
export interface NapCatEvent {
  /** 私聊还是群。 */
  readonly kind: 'private' | 'group'
  /** 发信人 QQ 号（字符串，不转数字：QQ 号超过 2^32 会丢精度）。 */
  readonly userId: string
  /** 群号（`kind === 'group'` 时必有）。 */
  readonly groupId?: string
  /** 平台消息 id（去重与被动回复都要用）。 */
  readonly messageId: string
  /** 纯文本正文（图/语音等非文本已由传输折叠成占位或丢弃）。 */
  readonly text: string
  /** 事件时刻（毫秒）。 */
  readonly at: number
  /** 是否 @ 了本账号。 */
  readonly mentioned: boolean
  /** 触发方式（传输判定；缺省按普通来信处理）。 */
  readonly trigger?: 'message' | 'mention' | 'keyword' | 'active'
  /** 本账号 QQ 号（用于「自己发的消息」判定）。 */
  readonly selfId?: string
  /** 发信人昵称（只进日志，不进提示词）。 */
  readonly senderName?: string
  /** 原始事件（只用于排障日志的长度摘要，不参与判定）。 */
  readonly raw?: unknown
}

/** 一次发送请求。 */
export interface NapCatSendRequest {
  /** 发给谁。 */
  readonly kind: 'private' | 'group'
  /** 私聊为 QQ 号；群聊为群号。 */
  readonly peerId: string
  /** 正文（已切好，不超过 `chunkMax`）。 */
  readonly text: string
  /** 被动回复可带的消息 id（带不带由实现方按 OneBot 语义决定）。 */
  readonly messageId?: string
}

/** 一次发送结果。 */
export interface NapCatSendResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** 失败原因（传输自己的码，适配器只负责记录与退避）。 */
  readonly reason?: string
  /** 平台返回的错误码（命中 `RISK_CODES` 会触发退避与熔断）。 */
  readonly code?: string
  /** 平台返回的消息 id。 */
  readonly messageId?: string
  /** 是否确定没发出去（`false` 表示「不确定」，这种不该重试）。 */
  readonly retryable?: boolean
}

/** 传输端口。**实现方负责 WS 握手、帧编解码、心跳与重连。** */
export interface NapCatTransport {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 是否需要宿主提供升级路由（自带监听器的实现填 `false`）。 */
  readonly requiresUpgradeRoute: boolean
  /**
   * 装配回调：传输收到事件时调 `onEvent`，连接状态变化时调 `onConnection`。
   *
   * `accept()` 的实现方**必须自己校验 token**（query 里的 `access_token` 或 `Authorization` 头）——
   * 本插件把 socket 原样交出去，它不替实现方做握手层的鉴权。
   */
  attach(handlers: NapCatTransportHandlers): void
  /** 撤销装配（`stop()` 时调用）。 */
  detach(): void
  /** 接受一条已升级的入站连接（`requiresUpgradeRoute` 为真时由本插件的路由调用）。 */
  accept(request: NapCatUpgradeRequestLike, socket: NapCatDuplexLike, head: Uint8Array): void
  /**
   * 交接凭据（可选）。`start()` 读到 token 后调用一次。
   *
   * 没有这个口子的话，token 白读了：本插件读完只用来验存在性，而真正需要它的是
   * 握手/发消息那一层。实现方可以在这里拿走用，也可以自己读同一个凭据文件——
   * 两条路都允许，但**只允许一个真源**（同一个 `user/channels/qq-napcat.json`）。
   */
  configure?(options: { readonly token: string }): void
  /** 发一条消息。 */
  send(request: NapCatSendRequest): Promise<NapCatSendResult>
  /** 关闭所有连接。 */
  close(): void
}

/** 传输回调。 */
export interface NapCatTransportHandlers {
  /** 收到一条已归一化的来信。 */
  onEvent(event: NapCatEvent): void
  /** 连接状态变化（`connected=false` 时 `why` 写原因）。 */
  onConnection(connected: boolean, why?: string): void
}

/* ------------------------------------------------------------------ *
 * 判定与结果
 * ------------------------------------------------------------------ */

/** 启动失败原因（每一个都指向一个具体动作）。 */
export type StartFailure =
  | 'disabled'
  | 'unconfirmed'
  | 'no-confirm-record'
  | 'no-transport'
  | 'no-web-server'
  | 'no-credential'
  | 'bad-host'
  | 'bad-path'
  | 'already-running'

/** 启动失败的中文说明。 */
export const START_FAILURE_ZH: Readonly<Record<StartFailure, string>> = Object.freeze({
  disabled: '通道关着（enable=false）',
  unconfirmed: '缺第一次确认（confirmed 不是字面量 true）',
  'no-confirm-record': '缺二次确认档案：高危通道要在确认档案里留下一条带说明的记录',
  'no-transport': '没有传输实现：OneBot v11 的帧与字段没有仓内依据，端口为空时不写假握手',
  'no-web-server': '没有 webServer 服务：反向 WS 需要一个已升级的入站连接，宿主没给监听器',
  'no-credential': '没有 access token：凭据文件缺失或为空',
  'bad-host': 'listHost 不是具体地址（不许用通配地址，那会把端口暴露到所有网卡）',
  'bad-path': '升级路由路径不合法（必须以 / 开头、不含空格与查询串）',
  'already-running': '已经在跑了（重复 start 不会开第二份连接）',
})

/** 启动结果。 */
export interface StartOutcome {
  /** 是否真的开始监听。 */
  readonly ok: boolean
  /** 失败原因。 */
  readonly reason?: StartFailure
  /** 一句中文说明。 */
  readonly detail: string
}

/** 闸门结论。 */
export type GateDecision = 'allow' | 'reject'

/** 闸门原因（闭集，日志按它分流，不再靠猜字符串）。 */
export type GateReason =
  | 'ok'
  | 'empty'
  | 'too-long'
  | 'blocked-content'
  | 'quiet'
  | 'duplicate'
  | 'circuit'
  | 'failure-stop'
  | 'rate-minute'
  | 'rate-hour'
  | 'rate-day'
  | 'cooldown'

/** 闸门原因的中文说明。 */
export const GATE_REASON_ZH: Readonly<Record<GateReason, string>> = Object.freeze({
  ok: '放行',
  empty: '正文为空',
  'too-long': '正文超过内容闸长度',
  'blocked-content': '正文命中内容闸正则',
  quiet: '深夜静默（只拦主动发言）',
  duplicate: '窗口内重复',
  circuit: '熔断中（连中三次风控，全局停发）',
  'failure-stop': '连续失败后停发',
  'rate-minute': '每分钟令牌桶空',
  'rate-hour': '每小时令牌桶空',
  'rate-day': '每天令牌桶空',
  cooldown: '会话冷却中',
})

/** 闸门结论对象。 */
export interface GateVerdict {
  /** 放行还是拒绝。 */
  readonly decision: GateDecision
  /** 原因。 */
  readonly reason: GateReason
  /** 放行时的发送前抖动（毫秒）；拒绝时为 0。 */
  readonly delayMs: number
}

/** 受理原因（闭集）。 */
export type IngestReason =
  | 'ok'
  | 'disabled'
  | 'unconfirmed'
  | 'no-transport'
  | 'not-whitelisted'
  | 'not-triggered'
  | 'duplicate'
  | 'busy'
  | 'ignored'
  | 'denied'
  | 'bad-shape'

/** 一次来信的受理结果。 */
export interface IngestOutcome {
  /** 是否被受理（进入「要回」的流程）。 */
  readonly accepted: boolean
  /** 原因。 */
  readonly reason: IngestReason
  /** 会话 id（即使被拒也给，方便日志与面板对上号）。 */
  readonly conversationId: string
}

/** 发送结果原因（闭集）。 */
export type ReplyReason =
  | 'ok'
  | 'disabled'
  | 'no-transport'
  | 'rejected'
  | 'empty'
  | 'no-kit'
  | 'send-failed'
  | 'no-conversation'

/** 一次回复的结果。 */
export interface ReplyOutcome {
  /** 是否全部发出去。 */
  readonly ok: boolean
  /** 原因。 */
  readonly reason: ReplyReason
  /** 切成几段。 */
  readonly pieces: number
  /** 成功发出几段。 */
  readonly sent: number
  /** 第一段失败时的错误码。 */
  readonly code?: string
  /** 一句中文说明（不含正文，避免把私聊内容写进日志）。 */
  readonly detail?: string
}

/** 通道现状（面板与自检读它）。 */
export interface AdapterStatus {
  /** 是否在监听。 */
  readonly running: boolean
  /** 通道 id。 */
  readonly channelId: string
  /** 监听三要素；未运行时为 `null`。 */
  readonly endpoint: { readonly host: string; readonly port: number; readonly path: string } | null
  /** 白名单（空数组 = 全拒）。 */
  readonly whitelist: { readonly users: number; readonly groups: number }
  /** 闸门状态。 */
  readonly gate: {
    readonly strikes: number
    readonly circuitUntil: number
    readonly failureStopUntil: number
  }
  /** 传输实现标识；无实现为 `null`。 */
  readonly transport: string | null
  /** 最近一次错误（中文，不含正文）。 */
  readonly lastError: string | null
}

/** 计数（面板与自检读它）。 */
export interface AdapterStats {
  /** 收到的来信数。 */
  readonly inbound: number
  /** 受理数。 */
  readonly accepted: number
  /** 发出的段数。 */
  readonly sent: number
  /** 被闸门拒绝的次数（按原因分桶）。 */
  readonly rejected: Readonly<Record<string, number>>
  /** 启动失败次数（按原因分桶）。 */
  readonly startFailures: Readonly<Record<string, number>>
}

/**
 * 本插件对外提供的服务（`ctx.get('ondra-adapter-qq-napcat')`）。
 *
 * 注意 `useTransport()` 是**装载期之外**唯一允许注入实现的口子：
 * 宿主或后续轮次拿得到真实 OneBot 编解码时，注入即可，本插件其余部分一行不改。
 */
export interface NapCatService {
  /** 现在能不能收消息（`running` 的只读投影）。 */
  readonly available: boolean
  /** 不能收的原因；能收时为 `undefined`。 */
  readonly reason?: StartFailure
  /** 注入传输实现（`null` 表示撤掉）。运行中注入会立刻重新装配。 */
  useTransport(transport: NapCatTransport | null): void
  /** 开始监听（**不连网就不算跑**：缺任何一样都返回具体原因码）。 */
  start(): StartOutcome
  /** 停止监听并释放所有连接与占用。 */
  stop(): void
  /** 通道现状。 */
  status(): AdapterStatus
  /** 计数。 */
  stats(): AdapterStats
  /** 受理一条来信（由传输调用）。 */
  ingest(event: NapCatEvent): IngestOutcome
  /** 主动/被动发一条（`at` 只用于测试与回放）。 */
  reply(conversationId: string, text: string, at?: number): Promise<ReplyOutcome>
  /** 接受一条已升级的入站连接（由 `ctx.webServer.registerUpgrade` 的路由调用）。 */
  acceptUpgrade(request: NapCatUpgradeRequestLike, socket: NapCatDuplexLike, head: Uint8Array): void
  /** 写二次确认档案（高危通道的第二道闸）。 */
  confirm(note: string): { readonly ok: boolean; readonly detail: string }
  /** 心跳（探针 + 落盘节流）。 */
  tick(at?: number): void
  /** 立刻落盘（关停前调用）。 */
  flush(): void
}

/* ------------------------------------------------------------------ *
 * 依赖服务的结构对位（不 import 任何 ondra-* 包，§15.5）
 * ------------------------------------------------------------------ */

/** O-001 的日志名前缀子集。 */
export interface IdentityLike {
  loggerName(suffix: string): string
}

/** O-003 时钟子集。 */
export interface ClockLike {
  now(): number
}

/** O-002 路径服务子集。 */
export interface PathLayoutLike {
  fileIn(area: 'user', ...segments: string[]): string
  prepareFile(filePath: string): string
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
  /** 除文字外还能发什么。 */
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

/** O-055 的受理入参（结构对位）。 */
export interface RouteInputLike {
  /** 通道 id。 */
  readonly channelId: string
  /** 会话 id。 */
  readonly conversationId: string
  /** 私聊还是群。 */
  readonly kind: 'private' | 'group'
  /** 触发方式。 */
  readonly trigger: 'message' | 'mention' | 'keyword' | 'active'
  /** 正文。 */
  readonly text?: string
  /** 有无附件。 */
  readonly hasAttachment?: boolean
  /** 平台消息 id。 */
  readonly messageId?: string
  /** 发信人。 */
  readonly senderId?: string
  /** 是否自己发的。 */
  readonly self?: boolean
  /** 时刻。 */
  readonly at?: number
}

/** O-055 的受理结果子集。 */
export interface AdmissionLike {
  /** 动作：wake / reply / queue / ignore / deny。 */
  readonly action: string
  /** 原因码。 */
  readonly reason: string
  /** 是否占用了会话（必须 release）。 */
  readonly reserved: boolean
  /** 队列深度。 */
  readonly queueDepth: number
  /** 排队位置。 */
  readonly position: number
}

/** O-055 路由服务子集。 */
export interface RouterLike {
  admit(input: RouteInputLike): AdmissionLike
  release(conversationId: string): readonly {
    readonly text: string
    readonly messageId?: string
    readonly trigger: string
    readonly kind: 'private' | 'group'
    readonly channelId: string
    readonly senderId?: string
  }[]
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

/** O-057 探针服务子集。 */
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
  /** 值类型。 */
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  /** 默认值。 */
  readonly default: unknown
  /** 枚举取值。 */
  readonly values?: readonly string[]
  /** 数值下界。 */
  readonly min?: number
  /** 数值上界。 */
  readonly max?: number
  /** 字符串正则。 */
  readonly pattern?: string
  /** 是否只在高级模式露出。 */
  readonly advancedOnly?: boolean
  /** 是否敏感（界面打码）。 */
  readonly secret?: boolean
  /** 一句中文说明。 */
  readonly doc?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  /** 段 id（无冒号，符合 §8.4）。 */
  readonly id: string
  /** 中文标题。 */
  readonly title: string
  /** 字段表。 */
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  /** 归属插件。 */
  readonly owner?: string
}

/** O-005 的解析结果形状。 */
export interface ResolvedSectionLike {
  /** 段 id。 */
  readonly id: string
  /** 解析后的值（kebab 键）。 */
  readonly values: Readonly<Record<string, unknown>>
  /** 回退到默认值的字段数。 */
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

/** 宿主的 HTTP 响应（结构对位，避免为一个类型引入 node:http 到公开契约里）。 */
export interface HttpResponseLike {
  /** 状态码。 */
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** 宿主的 HTTP 请求。 */
export interface HttpRequestLike {
  /** 方法。 */
  readonly method?: string
  /** 请求 URL（含 query，里面可能有 `access_token`）。 */
  readonly url?: string
  /** 请求头。 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}
