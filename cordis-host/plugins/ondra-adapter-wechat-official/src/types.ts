/**
 * O-060 `ondra-adapter-wechat-official` 的对外契约。**档位〔复〕。**
 *
 * ## 公众号这条路的三个硬事实（手册 §9.11 实测）
 *
 * ```
 * Webhook 3456（需公网） · sha1 验签 · 单条 800
 *   5 秒硬限 → 先回降级话术，真回复走客服消息 48h
 * ```
 *
 * 三件事决定了整个插件的形状：
 *
 * 1. **5 秒是硬限**，不是「最好快一点」。超了微信会重试三次，用户看到的是
 *    「她一直不回」，而日志里可能有三条一模一样的请求。
 * 2. **超时之后不能就这么算了**：真正的回答还有一次机会——客服消息（48 小时内）。
 *    所以本插件先回一句降级话术把 5 秒的账平掉，再让那一轮继续跑完走客服消息发出去。
 * 3. **48 小时是窗口**，不是「建议」。窗口外调用客服消息会被平台拒绝，
 *    而拒绝理由通常是「参数错误」——所以窗口判定必须在本端先做，并留下独立的原因码。
 *
 * ## 为什么这里不像 QQ 那样有六道防封闸
 *
 * 手册 §5.3 的六道闸是 **QQ 专属**（标题写的就是「QQ 防封控」）：令牌桶、会话冷却、
 * 深夜静默都是为了压住「主动发言的频率」。公众号**没有主动发言能力**——
 * 48 小时窗口之外根本发不出去，窗口内也只能对刚刚说过话的人回。
 * 把 QQ 的 20/200/1500 搬过来，只会得到「微信这边莫名其妙被限流」这一种无法解释的现象。
 * 这里改用两条与平台语义对齐的闸：**5 秒预算** 与 **48 小时窗口**，另加并发上限（防一次涌进 100 条时开 100 个模型请求）。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const WECHAT_SERVICE_KEY = 'ondra-adapter-wechat-official'

/** 通道 id。日志命名空间 `channel.wechat-official`，凭据 `user/channels/wechat-official.json`。 */
export const CHANNEL_ID = 'wechat-official'

/** 中文名。 */
export const CHANNEL_LABEL = '微信公众号'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单条上限（字符）。手册 §9.11 实测值：`wechat-official 800`。 */
export const CHUNK_MAX = 800

/** 单条上限的配置下界：100。再低会把一句话拆成四条。 */
export const CHUNK_MIN = 100

/** 5 秒硬限（毫秒，手册 §9.11）。 */
export const HARD_LIMIT_MS = 5_000

/**
 * 回复预算的默认值（毫秒）：4400。
 *
 * 留 600ms 给「构建 XML + 写响应头 + 网络」这三步。把预算设成 5000 是不负责任的：
 * 代码里的 5 秒是从收到请求开始算，而我们在第 4999 毫秒才开始写响应。
 */
export const DEFAULT_REPLY_BUDGET_MS = 4_400

/** 预算的兜底下界：800ms。再低连一次本地调用都跑不完，等于永远走降级。 */
export const REPLY_BUDGET_MIN = 800

/** 预算的上界：4900ms（永不超过硬限）。 */
export const REPLY_BUDGET_MAX = 4_900

/** 客服消息窗口（小时，手册 §9.11）。 */
export const MESSAGE_WINDOW_HOURS = 48

/** 公众号服务器配置只接受 80/443，这一点写进 README 而不是代码（端口归宿主）。 */
export const CALLBACK_PORTS_ZH = '80 / 443'

/** 默认路由路径。挂在宿主 webServer 上的绝对 pathname。 */
export const DEFAULT_ROUTE_PATH = '/ondra/wechat-official'

/** 默认微信接口基址（公众号公开文档；仓内无副本，见 README 已知限制）。 */
export const DEFAULT_API_BASE = 'https://api.weixin.qq.com'

/** 凭据文件名后缀。 */
export const CREDENTIAL_FILE_SUFFIX = '.json'

/** 状态文件名后缀。 */
export const STATE_FILE_SUFFIX = '.state.json'

/** 请求体上限（字节）。公众号报文不会超过这个数量级，超了就是打错端口了。 */
export const MAX_BODY_BYTES = 64 * 1024

/** access_token 提前续期的安全余量（毫秒）：5 分钟。 */
export const TOKEN_SAFETY_MS = 300_000

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/**
 * 凭据。**三样都只在文件里，不进 `Config`。**
 *
 * - `token`：公众号后台「服务器配置」里填的那个 Token，用于 sha1 验签；
 * - `appId` / `appSecret`：用于换 access_token（客服消息）。
 *
 * 三者都被拿走后可以冒充这个公众号发消息，所以一律 0600，且永不进日志。
 */
export interface WechatCredentials {
  /** 公众号 AppID。 */
  readonly appId: string
  /** 公众号 AppSecret。 */
  readonly appSecret: string
  /** 服务器配置的 Token（验签用）。 */
  readonly token: string
}

/** 凭据缺失的字段名（用来提示「还差哪一样」，而不是笼统说「配置不对」）。 */
export type CredentialMissing = 'file' | 'appId' | 'appSecret' | 'token' | 'json' | 'shape'

/** 凭据读取结果。 */
export interface CredentialLoad {
  /** 是否三样齐全。 */
  readonly ok: boolean
  /** 读到时的值。 */
  readonly value?: WechatCredentials
  /** 缺什么。 */
  readonly missing?: CredentialMissing
  /** 一句中文说明（含它在找哪个路径）。 */
  readonly detail: string
  /** 权限是否被就地收紧过。 */
  readonly permissionTightened: boolean
}

/* ------------------------------------------------------------------ *
 * 收信
 * ------------------------------------------------------------------ */

/** 请求 query（`signature/timestamp/nonce/echostr` 与 `openid` 等）。 */
export type QueryLike = Readonly<Record<string, string | undefined>>

/** GET 验证结果。 */
export interface VerifyOutcome {
  /** 是否通过。 */
  readonly ok: boolean
  /** HTTP 状态码。 */
  readonly http: number
  /** 响应体（通过时是 `echostr` 原文，微信要求原样回）。 */
  readonly body: string
  /** 响应类型。 */
  readonly contentType: string
  /** 失败原因。 */
  readonly reason?: VerifyReason
  /** 一句中文说明。 */
  readonly detail?: string
}

/** 验证失败原因（闭集）。 */
export type VerifyReason = 'disabled' | 'no-credentials' | 'missing-params' | 'bad-signature' | 'stale'

/** 一条来信（已解析，字段名按本项目的命名，不沿用报文里的驼峰）。 */
export interface InboundMessage {
  /** 发信人 openid（公众号里就是「关注者」的唯一标识）。 */
  readonly openId: string
  /** 公众号自己的原始 id（回包时要原样填 `FromUserName`）。 */
  readonly accountId: string
  /** 消息类型（`text` / `event` / `image` / …）。 */
  readonly msgType: string
  /** 正文（非文本消息为空串）。 */
  readonly text: string
  /** 平台消息 id（事件消息没有，可能为空）。 */
  readonly msgId: string
  /** 事件名（`MsgType === 'event'` 时才有）。 */
  readonly event: string
  /** 事件 key（扫码、菜单点击用）。 */
  readonly eventKey: string
  /** 平台给的秒级时间戳。 */
  readonly createdAt: number
}

/** 受理结果的处置方式（**响应体怎么写，由它决定**）。 */
export type Disposition = 'reply' | 'degrade' | 'silent' | 'reject'

/** 一次 POST 的处理结果。路由层照着它写响应。 */
export interface IngestOutcome {
  /** HTTP 状态码。 */
  readonly http: number
  /** 响应体（`silent` 时为空串：微信接受空 body，且**不会再重试**）。 */
  readonly body: string
  /** 响应类型。 */
  readonly contentType: string
  /** 处置方式。 */
  readonly disposition: Disposition
  /** 会话 id（能解析出来就给，方便日志对上号）。 */
  readonly conversationId?: string
  /** 原因（闭集）。 */
  readonly reason: IngestReason
  /** 是否已把真回复推迟到客服消息（5 秒超时的那条路）。 */
  readonly deferred: boolean
  /** 一句中文说明（不含正文）。 */
  readonly detail?: string
}

/** 受理原因（闭集）。 */
export type IngestReason =
  | 'ok'
  | 'deferred'
  | 'partial'
  | 'disabled'
  | 'not-whitelisted'
  | 'duplicate'
  | 'unsupported'
  | 'bad-signature'
  | 'bad-body'
  | 'busy'
  | 'no-kit'
  | 'ignored'

/** 发送结果原因（闭集）。 */
export type SendReason =
  | 'ok'
  | 'disabled'
  | 'no-credentials'
  | 'window-expired'
  | 'empty'
  | 'http'
  | 'token'
  | 'timeout'
  | 'no-fetch'

/** 一次客服消息发送的结果。 */
export interface SendOutcome {
  /** 是否全部发出。 */
  readonly ok: boolean
  /** 原因。 */
  readonly reason: SendReason
  /** 切成几段。 */
  readonly pieces: number
  /** 成功几段。 */
  readonly sent: number
  /** 平台错误码（`errcode`）。 */
  readonly errcode?: number
  /** 微信给的错误说明（只进日志，不回给用户）。 */
  readonly errmsg?: string
}

/* ------------------------------------------------------------------ *
 * 现状与计数
 * ------------------------------------------------------------------ */

/** 通道现状。 */
export interface AdapterStatus {
  /** 路由是否已挂上（`webServer` 存在且注册成功）。 */
  readonly registered: boolean
  /** 通道 id。 */
  readonly channelId: string
  /** 路由路径。 */
  readonly routePath: string
  /** 凭据是否齐（`token` 用于验签，`appId`+`appSecret` 用于发消息）。 */
  readonly credential: { readonly ok: boolean; readonly missing?: CredentialMissing }
  /** 白名单人数（0 = 不限）。 */
  readonly allowlist: number
  /** 48 小时窗口内的会话数。 */
  readonly windowOpen: number
  /** 最近一次错误（中文，不含正文）。 */
  readonly lastError: string | null
}

/** 计数。 */
export interface AdapterStats {
  /** 收到的 POST 数。 */
  readonly inbound: number
  /** 回应了的（含降级话术）。 */
  readonly replied: number
  /** 推迟到客服消息的。 */
  readonly deferred: number
  /** 客服消息发出的段数。 */
  readonly pushed: number
  /** 按原因分桶的拒绝数。 */
  readonly rejected: Readonly<Record<string, number>>
  /** 最慢一次「从收到到写响应」的耗时（毫秒），用来验证 5 秒预算是否真的守住了。 */
  readonly worstLatencyMs: number
}

/* ------------------------------------------------------------------ *
 * 传输（客服消息）
 * ------------------------------------------------------------------ */

/** 一次客服消息请求。 */
export interface PushRequest {
  /** 发给谁（openid）。 */
  readonly openId: string
  /** 正文（已切好，不超过 `chunkMax`）。 */
  readonly text: string
}

/** 一次客服消息响应。 */
export interface PushResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** 平台错误码。 */
  readonly errcode?: number
  /** 平台错误说明。 */
  readonly errmsg?: string
  /** 失败归类（非平台码的那一类：超时、网络、没 fetch）。 */
  readonly reason?: SendReason
}

/**
 * 消息推送端口。
 *
 * 默认实现是 `src/transport.ts` 的 `HttpWechatPush`（公众号公开文档的 HTTP 接口）；
 * 需要换成企业内网关或测试桩时，注入一个实现即可，适配器一行不改。
 */
export interface WechatPush {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 发一条文本。 */
  push(request: PushRequest): Promise<PushResult>
  /** 丢掉缓存的 access_token（换凭据后调用）。 */
  invalidate(): void
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
  /** 支持群聊（公众号没有群，恒 false）。 */
  readonly groupChat: boolean
  /** 必须被点名才回（私聊恒 true）。 */
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

/** 宿主的 HTTP 请求（结构对位：不把 node:http 拉进公开契约）。 */
export interface HttpRequestLike {
  /** 方法。 */
  readonly method?: string
  /** 请求 URL（含 query）。 */
  readonly url?: string
  /** 请求头。 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** 宿主的 HTTP 响应。 */
export interface HttpResponseLike {
  /** 状态码。 */
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** 宿主的 webServer 服务（只声明本插件会用的一条）。 */
export interface WebServerLike {
  register(route: {
    readonly kind: 'exact' | 'prefix'
    readonly path: string
    readonly handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>
  }): () => void
}

/** 本插件对外提供的服务。 */
export interface WechatOfficialService {
  /** 现在能不能收（路由挂了 + 凭据齐）。 */
  readonly available: boolean
  /** 不能收的原因。 */
  readonly reason?: VerifyReason
  /** GET 验证（微信后台「提交」时打过来的那一次）。 */
  verify(query: QueryLike): VerifyOutcome
  /** POST 处理一条来信（路由层照 `IngestOutcome` 写响应）。 */
  ingest(rawBody: string, query: QueryLike, at?: number): Promise<IngestOutcome>
  /** 主动发一条客服消息（窗口外会被拒，理由是 `window-expired`）。 */
  reply(conversationId: string, text: string, at?: number): Promise<SendOutcome>
  /** 通道现状。 */
  status(): AdapterStatus
  /** 计数。 */
  stats(): AdapterStats
  /** 心跳（清理过期的去重与窗口记录）。 */
  tick(at?: number): void
  /** 立刻落盘。 */
  flush(): void
}
