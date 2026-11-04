/**
 * O-064 `ondra-adapter-feishu` 的对外契约。**档位〔复〕**（通道复用：只做接线、配置与降级）。
 *
 * ## 手册与 master-plan 给出的全部依据（逐字）
 *
 * master-plan §9.11 那一行是**唯一**的可核对证据：
 *
 * ```
 * feishu | Webhook 3453（需公网） | verificationToken | 4000 | 先 200 再异步；encryptKey 不支持加密体
 * ```
 *
 * 手册 `Ondra-dev-handbook.md` 检索「飞书」只有两处提到「通道全部复用」，
 * **没有飞书专章**（本轮已 grep 确认）。所以这里只承诺那一行能推出的四件事：
 * `verificationToken` 校验、单条 4000、先 200 再异步、**不支持加密体**。
 * 其余（接口路径、`tenant_access_token`、`header.event_type`）按飞书开放平台公开文档写，
 * **仓内无副本、未实跑**，一律记进 README 的「已知限制」。
 *
 * ## 为什么这一路是「先 200 再异步」
 *
 * 飞书等的是响应，不是答案：超过时限没响应它会重投同一个事件（15 秒 / 5 分钟 / 1 小时三档）。
 * 同一条消息被答三遍，比答得慢糟得多。所以 `ingest()` 立刻回 `{"code":0}`，
 * 回答走 `im/v1/messages` 在后台发。
 *
 * 与 O-060（公众号）的区别：那边「先回」是被 5 秒硬限逼出来的**交棒**（先回降级话术，
 * 那一轮继续跑）；这边没有降级话术——因为飞书允许你在响应之后再发消息，
 * 不需要在响应体里塞一句话来「垫住」。
 *
 * ## 为什么回复用 `chat_id` 而不是 `open_id`
 *
 * 群里被 @ 时，`sender.open_id` 是那个人，`message.chat_id` 是那个群。
 * 用 `open_id` 回复 = 给那个人发**私聊**——他会在另一个会话里看到回复，
 * 群里的人什么也看不到，而日志全绿。所以会话键与收信人都取 **`chat_id`**。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const FEISHU_SERVICE_KEY = 'ondra-adapter-feishu'

/** 通道 id。日志命名空间 `channel.feishu`，凭据 `user/channels/feishu.json`。 */
export const CHANNEL_ID = 'feishu'

/** 中文名。 */
export const CHANNEL_LABEL = '飞书'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单条上限（字符）。master-plan §9.11 实测值：`feishu 4000`。 */
export const CHUNK_MAX = 4_000

/** 单条上限的配置下界：100。再低会把一句话拆成四条。 */
export const CHUNK_MIN = 100

/** 默认路由路径。挂在宿主 webServer 上的绝对 pathname。 */
export const DEFAULT_ROUTE_PATH = '/ondra/feishu'

/** 默认接口基址（飞书开放平台公开文档；仓内无副本，见 README）。 */
export const DEFAULT_API_BASE = 'https://open.feishu.cn'

/** 凭据文件名后缀。 */
export const CREDENTIAL_FILE_SUFFIX = '.json'

/** 状态文件名后缀。 */
export const STATE_FILE_SUFFIX = '.state.json'

/**
 * 请求体上限（字节）：256KB。
 *
 * 飞书的事件体比微信大得多（带完整消息体与发送者资料），64KB 会把正常事件挡掉；
 * 而事件体不会到 MB 级，所以 256KB 足够，也仍然能挡住「打错端口」。
 */
export const MAX_BODY_BYTES = 256 * 1024

/** tenant_access_token 提前续期的安全余量（毫秒）：5 分钟。 */
export const TOKEN_SAFETY_MS = 300_000

/** 收到事件后的固定应答（飞书只要求 2xx，body 里给个 0 更好读）。 */
export const ACK_BODY = '{"code":0}'

/** 飞书事件回调的 content-type。 */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/**
 * 凭据。**三样都只在文件里，不进 `Config`。**
 *
 * - `appId` / `appSecret`：换 `tenant_access_token`（发消息要用）；
 * - `verificationToken`：事件订阅的「Verification Token」，用来证明这条回调是飞书发的。
 *
 * `appSecret` 被拿走后可以冒充这个应用，所以一律 0600，且永不进日志。
 */
export interface FeishuCredentials {
  /** 应用 App ID（`cli_` 开头）。 */
  readonly appId: string
  /** 应用 App Secret。 */
  readonly appSecret: string
  /** 事件订阅的 Verification Token。 */
  readonly verificationToken: string
}

/** 凭据缺失的字段名（用来提示「还差哪一样」）。 */
export type CredentialMissing = 'file' | 'json' | 'shape' | 'appId' | 'appSecret' | 'verificationToken'

/** 凭据读取结果。 */
export interface CredentialLoad {
  /** 是否三样齐全。 */
  readonly ok: boolean
  /** 读到时的值。 */
  readonly value?: FeishuCredentials
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

/** 会话类型。`p2p` 是单聊，`group` 是群聊。 */
export type ChatType = 'p2p' | 'group'

/** 一条来信（已解析，字段名按本项目的命名）。 */
export interface InboundMessage {
  /** 会话 id（单聊与群聊都有；回复也发到这个 id）。 */
  readonly chatId: string
  /** 会话类型。 */
  readonly chatType: ChatType
  /** 发信人的 open_id（只用来做白名单与日志，不用来回复）。 */
  readonly senderId: string
  /** 发信人的 user_id（可能为空：取决于应用权限）。 */
  readonly senderUserId: string
  /** 消息类型（`text` / `image` / `post` / …）。 */
  readonly msgType: string
  /** 正文（已剥掉 `@_user_N` 占位符）。 */
  readonly text: string
  /** 被 @ 的占位符个数（群聊里通常 ≥1）。 */
  readonly mentions: number
  /** 平台消息 id。 */
  readonly messageId: string
  /** 平台事件 id（**去重主键**：飞书重投时它不变）。 */
  readonly eventId: string
  /** 平台给的事件创建时间（毫秒）。 */
  readonly createdAt: number
}

/** 受理结果的处置方式（**响应体怎么写，由它决定**）。 */
export type Disposition = 'accept' | 'ignore' | 'reject'

/** 一次回调的处理结果。路由层照着它写响应。 */
export interface IngestOutcome {
  /** HTTP 状态码。 */
  readonly http: number
  /** 响应体：受理与忽略都是 `{"code":0}`，拒绝是空串。 */
  readonly body: string
  /** 响应类型。 */
  readonly contentType: string
  /** 处置方式。 */
  readonly disposition: Disposition
  /** 会话 id（能解析出来就给，方便日志对上号）。 */
  readonly conversationId?: string
  /** 原因（闭集）。 */
  readonly reason: IngestReason
  /** 是否已交给后台异步回答。 */
  readonly answering: boolean
  /** 一句中文说明（不含正文）。 */
  readonly detail?: string
}

/** 受理原因（闭集）。 */
export type IngestReason =
  | 'ok'
  | 'disabled'
  | 'no-credentials'
  | 'bad-token'
  | 'app-mismatch'
  | 'encrypted'
  | 'bad-body'
  | 'not-allowed'
  | 'unsupported'
  | 'duplicate'
  | 'busy'
  | 'queued'
  | 'ignored'
  | 'no-kit'

/** GET / 非 POST 的拒绝原因，与验证共用一套闭集。 */
export type VerifyReason =
  | 'disabled'
  | 'no-credentials'
  | 'bad-token'
  | 'app-mismatch'
  | 'encrypted'
  | 'bad-body'
  | 'no-challenge'
  | 'no-ack'

/** 验证（`url_verification`）结果。 */
export interface VerifyOutcome {
  /** 是否通过。 */
  readonly ok: boolean
  /** HTTP 状态码。 */
  readonly http: number
  /** 响应体：通过时是 `{"challenge":"…"}`。 */
  readonly body: string
  /** 响应类型。 */
  readonly contentType: string
  /** 失败原因。 */
  readonly reason?: VerifyReason
  /** 一句中文说明。 */
  readonly detail?: string
}

/** 发送结果原因（闭集）。 */
export type SendReason =
  | 'ok'
  | 'disabled'
  | 'no-credentials'
  | 'no-kit'
  | 'empty'
  | 'http'
  | 'token'
  | 'timeout'
  | 'no-fetch'

/** 一次消息发送的结果。 */
export interface SendOutcome {
  /** 是否全部发出。 */
  readonly ok: boolean
  /** 原因。 */
  readonly reason: SendReason
  /** 切成几段。 */
  readonly pieces: number
  /** 成功几段。 */
  readonly sent: number
  /** 平台错误码（`code`）。 */
  readonly errcode?: number
  /** 飞书给的错误说明（只进日志，不回给用户）。 */
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
  /** 凭据是否齐。 */
  readonly credential: { readonly ok: boolean; readonly missing?: CredentialMissing }
  /** 白名单人数（0 = 不限）。 */
  readonly allowlist: number
  /** 正在回答的会话数。 */
  readonly inflight: number
  /** 排队中的条数。 */
  readonly queued: number
  /** 最近一次错误（中文，不含正文）。 */
  readonly lastError: string | null
}

/** 计数。 */
export interface AdapterStats {
  /** 收到的回调数。 */
  readonly inbound: number
  /** 已交给后台回答的条数。 */
  readonly answering: number
  /** 已发出的段数。 */
  readonly sent: number
  /** 按原因分桶的忽略/拒绝数。 */
  readonly rejected: Readonly<Record<string, number>>
  /** 最慢一次「从收到到回答完成」的耗时（毫秒）。 */
  readonly worstAnswerMs: number
}

/* ------------------------------------------------------------------ *
 * 传输
 * ------------------------------------------------------------------ */

/** 一次消息请求。 */
export interface PushRequest {
  /** 发到哪个会话（chat_id）。 */
  readonly chatId: string
  /** 正文（已切好，不超过 `chunkMax`）。 */
  readonly text: string
}

/** 一次消息响应。 */
export interface PushResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** 平台错误码。 */
  readonly errcode?: number
  /** 平台错误说明。 */
  readonly errmsg?: string
  /** 失败归类（非平台码的那一类）。 */
  readonly reason?: SendReason
}

/**
 * 消息发送端口。
 *
 * 默认实现是 `src/transport.ts` 的 `HttpFeishuPush`；换成企业内网关或测试桩时注入即可。
 */
export interface FeishuPush {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 发一条文本。 */
  push(request: PushRequest): Promise<PushResult>
  /** 丢掉缓存的 tenant_access_token（换凭据后调用）。 */
  invalidate(): void
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
  /** 必须被点名才回（群里飞书只在被 @ 时才投递事件）。 */
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
  readonly sensitive?: boolean
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
export interface FeishuService {
  /** 现在能不能收（路由挂了 + 凭据齐 + 开关开着）。 */
  readonly available: boolean
  /** 不能收的原因。 */
  readonly reason?: VerifyReason
  /** `url_verification`：回 `{"challenge":"…"}`。 */
  verify(payload: unknown): VerifyOutcome
  /** 处理一次回调（路由层照 `IngestOutcome` 写响应）。 */
  ingest(rawBody: string, at?: number): Promise<IngestOutcome>
  /** 主动发一条消息。 */
  reply(conversationId: string, text: string): Promise<SendOutcome>
  /** 通道现状。 */
  status(): AdapterStatus
  /** 计数。 */
  stats(): AdapterStats
  /** 心跳（清理过期去重记录 + 按节流落盘 + 上报探针）。 */
  tick(at?: number): void
  /** 立刻落盘。 */
  flush(): void
  /** 标记路由已挂上（由入口在注册成功后调用）。 */
  markRegistered(value: boolean): void
}
