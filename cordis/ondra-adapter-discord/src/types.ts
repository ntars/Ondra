/**
 * O-067 `ondra-adapter-discord` 的对外契约。**档位〔复〕**（通道复用：只做接线、配置与降级）。
 *
 * ## 手册给出的全部依据（逐字，别处没有第二份）
 *
 * master-plan §9.11 那一行是**唯一**可核对证据：
 *
 * ```
 * discord | Gateway WS v10 自实现 IDENTIFY+心跳 | Bot <token> | 1900 | 4004 停止重连，其余 5s；无去重
 * ```
 *
 * `Ondra-dev-handbook.md` 检索「discord」只有 2 处社群邀请链接，
 * **没有 Discord 专章**；台账第 11 组只写「Gateway WS v10」。
 * 所以本包只承诺那一行能推出的五件事：
 *
 * 1. 传输是 **Gateway WebSocket v10**（本包不做握手，见下条）；
 * 2. 鉴权头是 **`Bot <token>`**（不是 `Bearer`，不带 `Bot` 前缀平台直接 401）；
 * 3. 单条上限 **1900** 字符（平台真实上限 2000，手册取保守值）；
 * 4. **关闭码 4004 = 鉴权失败 → 停止重连**；**其余关闭码 → 等 5 秒重连**；
 * 5. **没有去重**——Discord 不重投已 ACK 的事件。
 *
 * 其余（帧 op 码、IDENTIFY 载荷、HELLO/心跳 ACK、RESUME 序列号、intents 位、
 * REST 路径与报文形状）**按公开文档写、仓内无副本、未实跑**，一律记进 README
 * 「已知限制」。已 grep 确认：`MESSAGE_CREATE` / `HELLO` / `RESUME` / `op_code` /
 * `intents` / `gateway.discord` 在本仓 **0 命中**。
 *
 * ## 为什么帧层是端口而不是实现
 *
 * 手册写的是「**自实现** IDENTIFY+心跳」——那是**旧项目**做过的事，
 * 不是本轮的施工许可：仓内没有 op 码表、没有心跳应答规则、没有 zlib 分片约定，
 * 且本轮禁装依赖（宿主 `desktop/packages` 里 `ws` 只出现在 `api/gateway` 等
 * 三个包的私有依赖里，不是可供插件调用的服务键）。
 *
 * 自己拼一版的风险形状很坏：**连接成功、收到 READY、然后一条消息都收不到**
 * （intents 位算错或帧名猜错）——这与「根本没接」在日志上完全同形。
 * 所以帧层做成 `DiscordSocket` 端口，`start()` 在端口为空时明确回 `no-socket`。
 *
 * ## 「无去重」不是省略，是事实；但它不等于「不做并发占位」
 *
 * 手册这一条的意思是：**不要建跨时间的消息去重表**。
 * 两条理由都很硬：
 *
 * 1. Discord 的可靠性靠 `RESUME` + 序列号，重连后由**端口实现方**把漏掉的补上，
 *    已 ACK 过的不会重投——所以去重表本来就无事可做；
 * 2. 用户**真的会**连发两遍同一句话。用文本做键的去重表会把它当成重复而吞掉，
 *    症状是「她漏看了我说的那句」——比重复回答更难解释。
 *
 * 但是：同一个 `message.id` **不可能**是两条不同的用户消息。
 * 所以本包做「**同 id 在飞行中即丢弃**」的幂等占位（`ignore.inflight`），
 * 这不是去重表——它不跨时间、不落盘、容量等于并发数，只防「端口实现方重放
 * 已 ACK 事件」这一种坏情况。两者区别写在 `adapter.ts` 文件头。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const DISCORD_SERVICE_KEY = 'ondra-adapter-discord'

/** 通道 id。日志命名空间 `channel.discord`，凭据 `user/channels/discord.json`。 */
export const CHANNEL_ID = 'discord'

/** 中文名。 */
export const CHANNEL_LABEL = 'Discord'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单条上限（字符）。master-plan §9.11 实测值：`discord 1900`。 */
export const CHUNK_MAX = 1_900

/** 单条上限的配置下界：100。再低会把一句话拆成四条。 */
export const CHUNK_MIN = 100

/**
 * 重连固定间隔（毫秒）。master-plan §9.11 原话「其余 5s」。
 *
 * **固定值，不做指数退避**：手册把这条写成定值，做成指数会让一次网络抖动
 * 之后通道安静几分钟，而用户看到的是「她突然不理我了」。
 * 代价是「平台持续拒绝」时会 5 秒一次无限重连——这条**刻意接受**：
 * 一次 WS 握手 5 秒一次不构成风暴，而「连不上就悄悄停下」反而更难查。
 * 面板上 `stats().reconnects` 与 `status().lastCloseCode` 能直接看出这件事。
 */
export const RECONNECT_MS = 5_000

/** 重连间隔的配置下界（毫秒）：1 秒。低于它就是自打限流。 */
export const RECONNECT_FLOOR = 1_000

/** 重连间隔的配置上界（毫秒）：60 秒。 */
export const RECONNECT_CEIL = 60_000

/**
 * 鉴权失败的关闭码：4004。**唯一一个手册点名的「停止重连」码。**
 *
 * 平台还有 4010/4011/4012/4013/4014 一类「参数错」的不可重连码，
 * 但**仓内无依据**，不写死。要加请改 `stopOnCodes` 配置——加错的表现是
 * 「本该重连的停了」，比「本该停的重连」更容易被发现。
 */
export const AUTH_CLOSE_CODE = 4004

/** 默认 REST 基址（Discord API v10；仓内无副本，见 README）。 */
export const DEFAULT_API_BASE = 'https://discord.com/api/v10'

/** 凭据文件名后缀。 */
export const CREDENTIAL_FILE_SUFFIX = '.json'

/**
 * REST 请求超时（毫秒）：15 秒。
 *
 * **与 O-066 的结论相反，理由是同一件事**：Telegram 是长轮询，请求本身会
 * 故意挂住 50 秒，所以那里超时必须由轮询超时派生（否则每轮都被自己掐断）；
 * Discord 的 REST 是一次普通 HTTP，独立给值才对。凡「超时该不该派生」的问题，
 * 先问「这个请求会不会故意挂住」。
 */
export const REQUEST_TIMEOUT_MS = 15_000

/** REST 超时的下界（毫秒）：3 秒。 */
export const REQUEST_FLOOR = 3_000

/** REST 超时的上界（毫秒）：120 秒。 */
export const REQUEST_CEIL = 120_000

/** 并发上限上界：16。再多只是把模型打成 429。 */
export const CONCURRENCY_CEIL = 16

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/**
 * 凭据。**只有 token 一样东西，且只在文件里**（master-plan §6 禁令 6：密钥不写配置）。
 *
 * 与 Telegram 的区别值得记一笔：Telegram 的 token 拼在 **URL 路径**里，
 * 所以脱敏对象是「地址」；Discord 的 token 在 **`Authorization` 头**里
 * （`Bot <token>`），URL 干净。所以本包的脱敏对象是「**任何可能出现
 * `Bot <token>` 的字符串**」——头被打印、`fetch` 的 init 被序列化进日志、
 * 平台回显 header，这三种都能漏。
 */
export interface DiscordCredentials {
  /** Bot token。 */
  readonly token: string
  /** 机器人用户名（可空，仅用于日志；`me()` 会补上）。 */
  readonly username: string
}

/** 凭据缺失的原因。 */
export type CredentialMissing = 'file' | 'json' | 'shape' | 'token'

/** 凭据读取结果。 */
export interface CredentialLoad {
  /** token 是否到位。 */
  readonly ok: boolean
  /** 读到时的值。 */
  readonly value?: DiscordCredentials
  /** 缺什么。 */
  readonly missing?: CredentialMissing
  /** 一句中文说明（含它在找哪个路径，但**不含 token**）。 */
  readonly detail: string
  /** 权限是否被就地收紧过。 */
  readonly permissionTightened: boolean
}

/* ------------------------------------------------------------------ *
 * 收信
 * ------------------------------------------------------------------ */

/** 会话类型。`guild_id` 在 → 群；不在 → 私聊（DM）。 */
export type ConversationKind = 'private' | 'group'

/** 一条来信（已解析，字段名按本项目的命名）。 */
export interface InboundMessage {
  /** 平台消息 id（**幂等占位的键**；不是去重键，见 `adapter.ts`）。 */
  readonly messageId: string
  /** 消息所在的频道 id（回复地址；私聊时是 DM 频道 id）。 */
  readonly channelId: string
  /** 所在服务器 id（私聊为空串）。 */
  readonly guildId: string
  /** 私聊还是群。 */
  readonly kind: ConversationKind
  /** 发信人 id。 */
  readonly senderId: string
  /** 发信人用户名（可空；只进日志）。 */
  readonly senderUsername: string
  /** 正文。 */
  readonly text: string
  /** 是否 @ 了机器人（`mentions` 里有它，或正文里 `<@id>` / `<@!id>`）。 */
  readonly mentioned: boolean
  /** 消息时刻（毫秒；0 = 平台没给）。 */
  readonly createdAt: number
}

/**
 * 事件受理的原因码（闭集）。**每个码对应一个不同的排查动作**，
 * 合并码会让面板上的计数表变成噪声。
 */
export type IngestReason =
  /** 接住了，正在答。 */
  | 'accepted'
  /** 通道关着。 */
  | 'disabled'
  /** 凭据不齐。 */
  | 'no-credential'
  /** 没有帧层实现（`DiscordSocket` 未注入）。**与 `disabled` 分开**：一个是用户关的，一个是缺施工件。 */
  | 'no-socket'
  /** 不是 `MESSAGE_CREATE`（编辑、表情回应、心跳应答…）。 */
  | 'not-message'
  /** 机器人自己（或别的 bot）发的。少了这条两个 bot 会互相刷。 */
  | 'self'
  /** 正文为空（只有附件/贴纸）。本包只做文字，所以不答。 */
  | 'empty'
  /** 白名单外的发信人。 */
  | 'not-allowed'
  /** 缺 `id` / `channel_id` 或发信人 id 认不出（端口实现方没透传全）。 */
  | 'bad-id'
  /** 同一 `message.id` 正在答：端口重放，丢弃。 */
  | 'replayed'
  /** 连接还没 ready（`connecting` / `closed` / `stopped`）。 */
  | 'not-ready'
  /** 已进本地队列（会话忙或全局并发满）。 */
  | 'queued'
  /** 路由判「不回」。 */
  | 'ignored'

/** 一次事件受理的结果。 */
export interface IngestOutcome {
  /** 是否交给了回答流程。 */
  readonly ok: boolean
  /** 原因。 */
  readonly reason: IngestReason
  /** 会话 id（认出来才有）。 */
  readonly conversationId?: string
}

/** 发送结果原因（闭集）。 */
export type SendReason =
  | 'ok'
  | 'disabled'
  | 'no-credentials'
  | 'no-kit'
  | 'no-push'
  | 'empty'
  | 'http'
  | 'timeout'
  | 'no-fetch'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'rate-limited'

/** 一次发送的结果。 */
export interface SendOutcome {
  /** 是否全部发出。 */
  readonly ok: boolean
  /** 原因。 */
  readonly reason: SendReason
  /** 切成几段。 */
  readonly pieces: number
  /** 成功几段。 */
  readonly sent: number
  /** 平台错误码（HTTP 状态）。 */
  readonly errcode?: number
  /** 平台错误说明（**已脱敏**，只进日志）。 */
  readonly errmsg?: string
}

/* ------------------------------------------------------------------ *
 * 传输：帧层端口（实现方提供）+ REST（本插件提供）
 * ------------------------------------------------------------------ */

/**
 * 端口回调。**实现方只允许调这四个**，且**不得自行重连**。
 *
 * 「不得自行重连」是本契约里最要紧的一条：若端口自己重连、本插件也重连，
 * 会同时存在两条 WS 连在收同一批事件 → 同一条消息答两遍。而 Discord
 * **没有去重**（手册 §9.11），重复回答不可逆。断开只能 `onClosed(code)` 上报，
 * 由本插件决定下次什么时候 `open()`，一个决定点。
 */
export interface DiscordSocketHandlers {
  /** 握手完成（READY）。`botUserId` 用来剔自己的消息。 */
  onReady(info: { readonly sessionId?: string; readonly botUserId?: string }): void
  /** 一条原始事件（`t` + `d`；本插件只认 `MESSAGE_CREATE`）。 */
  onEvent(raw: Record<string, unknown>): void
  /** 连接关闭。实现方**不得**在这里重连。 */
  onClosed(closeCode: number, reason?: string): void
  /** 非致命的传输错误（已脱敏；本插件只记日志，不改变连接状态）。 */
  onError(detail: string): void
}

/** 打开结果。失败一律带原因码，不抛错。 */
export type DiscordOpenResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'no-token' | 'closed' | 'unauthorized' | 'error'
      readonly detail?: string
    }

/** 帧层端口。实现方负责：**帧 op 码、IDENTIFY 载荷、心跳与 ACK、RESUME、zlib 分片**。 */
export interface DiscordSocket {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 打开连接。**永不抛错**。 */
  open(handlers: DiscordSocketHandlers): Promise<DiscordOpenResult>
  /** 关闭连接。**幂等**，且不得再回调 `onClosed`（避免「手动停止」被当成「异常断开」）。 */
  close(): void
}

/** 一条待发文本。 */
export interface PushRequest {
  /** 发到哪个频道。 */
  readonly channelId: string
  /** 正文（已切好，不超过 `chunkMax`）。 */
  readonly text: string
}

/** 一次发送的响应。 */
export interface PushResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** HTTP 状态（有就带）。 */
  readonly errcode?: number
  /** 平台错误说明（**已脱敏**）。 */
  readonly errmsg?: string
  /** 失败归类（非 HTTP 码的那一类）。 */
  readonly reason?: SendReason
}

/** `GET /users/@me` 的结果：确认 token 到底有效没效。 */
export interface MeResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** 机器人 id。 */
  readonly id?: string
  /** 机器人用户名。 */
  readonly username?: string
  /** 失败原因。 */
  readonly reason?: SendReason
  /** HTTP 状态。 */
  readonly errcode?: number
  /** 一句中文说明（**已脱敏**）。 */
  readonly errmsg?: string
}

/**
 * REST 端口。**两个方法，都在 `transport.ts` 里拼地址与鉴权头**，
 * 这样「`Bot <token>` 只在一处进字符串」这件事只有一个发生点。
 */
export interface DiscordPush {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 发一条文本。 */
  sendMessage(request: PushRequest): Promise<PushResult>
  /** 确认 token。 */
  me(): Promise<MeResult>
}

/** fetch 的最小面（Node 18+ 的全局 fetch 结构上满足）。 */
export interface FetchLike {
  (url: string, init?: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
    readonly signal?: AbortSignal
  }): Promise<FetchResponseLike>
}

/** fetch 的响应最小面。 */
export interface FetchResponseLike {
  readonly status: number
  json(): Promise<unknown>
}

/* ------------------------------------------------------------------ *
 * 连接状态机（纯逻辑，见 `link.ts`）
 * ------------------------------------------------------------------ */

/** 连接状态，**四值闭集**。 */
export const LINK_STATES = ['closed', 'connecting', 'ready', 'stopped'] as const

/** 一种连接状态。 */
export type LinkState = (typeof LINK_STATES)[number]

/** 断开后的处置。 */
export type LinkAction =
  /** 不再重连（鉴权失败 / 被显式停止 / 通道关闭）。 */
  | 'stop'
  /** 等 `delayMs` 再连。 */
  | 'retry'

/** 断开原因（闭集）。 */
export type CloseReason =
  /** 4004：token 不对。重连一万次也一样。 */
  | 'auth-failed'
  /** 配置里追加的其它「不重连」码。 */
  | 'stop-code'
  /** 其余一律重连。 */
  | 'reconnect'

/** 断开后的计划。 */
export interface LinkPlan {
  /** 处置。 */
  readonly action: LinkAction
  /** 等多久再连（`stop` 时为 0）。 */
  readonly delayMs: number
  /** 原因。 */
  readonly reason: CloseReason
  /** 一句中文说明（给人看的）。 */
  readonly detail: string
}

/* ------------------------------------------------------------------ *
 * 现状与计数
 * ------------------------------------------------------------------ */

/** 通道现状。 */
export interface AdapterStatus {
  /** 连接状态。 */
  readonly link: LinkState
  /** 通道 id。 */
  readonly channelId: string
  /** 凭据是否齐。 */
  readonly credential: { readonly ok: boolean; readonly missing?: CredentialMissing }
  /** 机器人用户名（`me()` 探过一次才有）。 */
  readonly botUsername: string | null
  /** 白名单人数（0 = 不限）。 */
  readonly allowlist: number
  /** 正在回答的会话数。 */
  readonly inflight: number
  /** 排队中的条数。 */
  readonly queued: number
  /** 最后一次断开码（`null` = 还没断过）。 */
  readonly lastCloseCode: number | null
  /** 下一次重连的时刻（毫秒；`null` = 没有排重连）。 */
  readonly nextRetryAt: number | null
  /** 最后一次成功收到事件的时刻（毫秒；0 = 还没收到过）。 */
  readonly lastEventAt: number
  /** 最近一次错误（中文，**不含正文与 token**）。 */
  readonly lastError: string | null
}

/** 计数。 */
export interface AdapterStats {
  /** 收到多少原始事件。 */
  readonly events: number
  /** 其中认出是消息的条数。 */
  readonly messages: number
  /** 答了几条。 */
  readonly answered: number
  /** 已发出的段数。 */
  readonly sent: number
  /** 连上过几次（含首次）。 */
  readonly connects: number
  /** 重连过几次。 */
  readonly reconnects: number
  /** 按原因分桶的忽略数。 */
  readonly rejected: Readonly<Record<string, number>>
  /** 最慢一次「从收到到回答完成」的耗时（毫秒）。 */
  readonly worstAnswerMs: number
}

/* ------------------------------------------------------------------ *
 * 依赖服务的结构对位（不 import 任何 ondra-* 包，master-plan §18.5）
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
  /** 必须被点名才回。 */
  readonly mentionRequired: boolean
  /** 除文字外还能发什么（本插件只做文字）。 */
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
  readonly channelId: string
  readonly conversationId: string
  readonly kind: ConversationKind
  readonly trigger: 'message' | 'mention' | 'keyword' | 'active'
  readonly text?: string
  readonly hasAttachment?: boolean
  readonly messageId?: string
  readonly senderId?: string
  readonly self?: boolean
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
    readonly kind: ConversationKind
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
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly advancedOnly?: boolean
  readonly sensitive?: boolean
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

/** 本插件对外提供的服务。 */
export interface DiscordService {
  /** 现在能不能收（开关开着 + 凭据齐 + 连接 ready + 端口在）。 */
  readonly available: boolean
  /** 不能收的原因。 */
  readonly reason?: IngestReason
  /** 注入帧层实现（同一时刻一个）。已在跑时返回 `false`。 */
  useSocket(socket: DiscordSocket | null): boolean
  /** 换 REST 实现（注入测试桩时用）。 */
  setPush(push: DiscordPush | null): void
  /** 开始连接（重复调用无副作用）。 */
  start(): void
  /** 停止连接（立旗 → 关端口 → 清定时器；幂等）。 */
  stop(): void
  /** 传输把一条原始事件喂进来。 */
  ingest(raw: Record<string, unknown>, at?: number): IngestOutcome
  /** 主动发一条。 */
  reply(conversationId: string, text: string): Promise<SendOutcome>
  /** 确认 token（调 `GET /users/@me`；只读）。 */
  probe(): Promise<MeResult>
  /** 通道现状。 */
  status(): AdapterStatus
  /** 计数。 */
  stats(): AdapterStats
  /** 心跳（上报探针 + 清理本地队列超时项）。**与 WS 心跳无关**。 */
  tick(at?: number): void
  /** 重读凭据（换文件后调用；会先停一次连接）。 */
  reload(): CredentialLoad
}
