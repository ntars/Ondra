/**
 * O-063 `ondra-adapter-wecom` 的对外契约。**档位〔复〕**（通道复用：只做接线、配置与降级）。
 *
 * ## 手册与 master-plan 给出的全部依据（逐字）
 *
 * master-plan §9.11 那一行是**唯一**的可核对证据：
 *
 * ```
 * wecom | Webhook 3455（需公网） | 自实现 WXBizMsgCrypt（AES-256-CBC） | 2000 | 先回 success
 * ```
 *
 * 手册 `Ondra-dev-handbook.md` 里「企业微信」**零命中**（本轮已 grep 确认），
 * 所以这里只承诺那一行能推出的四件事：加密回调、AES-256-CBC 解包、单条 2000、先回 `success`。
 * 其余（接口路径、`agentid` 字段、错误码）按企业微信公开文档写，**仓内无副本、未实跑**，
 * 一律记进 README 的「已知限制」。
 *
 * ## 为什么这一路**没有**「降级话术」与「5 秒交棒」
 *
 * O-060（公众号）必须交棒，是因为微信要求**在收到请求的同一个响应里**把话说完，
 * 5 秒没说完就重试三次，用户只看到「她一直不回」。
 *
 * 企业微信的 `success` 语义完全不同：它的意思是「**我收到了，不需要被动回复**」。
 * 真正的回答走**应用消息**（`message/send`）——那条通道和回调请求没有关系，
 * 想什么时候发就什么时候发。所以这里的最优解是**永远回 `success`，回答异步发**：
 *
 * ```
 * t=0      收到 POST
 * t≈5ms    验签 + 解密 + 解析 + 去重（纯计算）→ 立刻回 "success"
 * t=5ms+   问人格 → 走应用消息发出去
 * ```
 *
 * 搬 O-060 的降级话术过来，只会多出一句「我在呢」然后紧跟着一句真话，两句都到，
 * 用户看到的是一个在原地重复自己的人。
 *
 * ## 为什么只解包、不打包
 *
 * 被动回复（加密 XML）需要 `encrypt()`。本插件**永远回 `success`**，那条路径不存在，
 * 写了就是死代码——而死代码最坏的地方不是占地方，是让人以为「被动回复这条路已经支持了」。
 * 故 `crypt.ts` 只有 `decryptFrame()`，没有 `encrypt()`。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const WECOM_SERVICE_KEY = 'ondra-adapter-wecom'

/** 通道 id。日志命名空间 `channel.wecom`，凭据 `user/channels/wecom.json`。 */
export const CHANNEL_ID = 'wecom'

/** 中文名。 */
export const CHANNEL_LABEL = '企业微信'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单条上限（字符）。master-plan §9.11 实测值：`wecom 2000`。 */
export const CHUNK_MAX = 2_000

/** 单条上限的配置下界：100。再低会把一句话拆成四条。 */
export const CHUNK_MIN = 100

/** 默认路由路径。挂在宿主 webServer 上的绝对 pathname。 */
export const DEFAULT_ROUTE_PATH = '/ondra/wecom'

/** 默认接口基址（企业微信公开文档；仓内无副本，见 README）。 */
export const DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com'

/** 凭据文件名后缀。 */
export const CREDENTIAL_FILE_SUFFIX = '.json'

/** 状态文件名后缀。 */
export const STATE_FILE_SUFFIX = '.state.json'

/** 请求体上限（字节）。回调报文是几百字节量级，超了就是打错端口了。 */
export const MAX_BODY_BYTES = 64 * 1024

/** access_token 提前续期的安全余量（毫秒）：5 分钟。 */
export const TOKEN_SAFETY_MS = 300_000

/** EncodingAESKey 的字符数（43）。少一个字符解不出 32 字节密钥。 */
export const AES_KEY_CHARS = 43

/** AES-256 的密钥字节数。 */
export const AES_KEY_BYTES = 32

/** AES 分组字节数（CBC 的块长）。 */
export const AES_BLOCK_BYTES = 16

/** 企业微信的 PKCS#7 填充块长：**32**，不是 AES 的 16。 */
export const PKCS7_BLOCK_BYTES = 32

/** 明文帧的固定前缀长度：16 字节随机数 + 4 字节大端长度。 */
export const FRAME_PREFIX_BYTES = 20

/** 回调固定应答：`success`。它不是 XML，就是这七个字母。 */
export const ACK_TEXT = 'success'

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/**
 * 凭据。**五样都只在文件里，不进 `Config`。**
 *
 * - `corpId` / `secret`：换 access_token；
 * - `agentId`：自建应用的 AgentId，发应用消息时必须带，**缺了消息发不出去**；
 * - `token` / `encodingAESKey`：回调验签与解包。
 *
 * 这五样凑齐足以冒充这个应用发消息，所以一律 0600，且永不进日志。
 */
export interface WecomCredentials {
  /** 企业 ID。 */
  readonly corpId: string
  /** 自建应用 AgentId（正整数）。 */
  readonly agentId: number
  /** 应用 Secret。 */
  readonly secret: string
  /** 回调配置里的 Token（验签用）。 */
  readonly token: string
  /** 回调配置里的 EncodingAESKey（43 字符）。 */
  readonly encodingAESKey: string
}

/** 凭据缺失的字段名（用来提示「还差哪一样」）。 */
export type CredentialMissing =
  | 'file'
  | 'json'
  | 'shape'
  | 'corpId'
  | 'agentId'
  | 'secret'
  | 'token'
  | 'encodingAESKey'

/** 凭据读取结果。 */
export interface CredentialLoad {
  /** 是否五样齐全。 */
  readonly ok: boolean
  /** 读到时的值。 */
  readonly value?: WecomCredentials
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

/** 请求 query（`msg_signature/timestamp/nonce/echostr`）。 */
export type QueryLike = Readonly<Record<string, string | undefined>>

/** GET 验证 / 解密失败的原因（闭集）。 */
export type VerifyReason =
  | 'disabled'
  | 'no-credentials'
  | 'missing-params'
  | 'bad-signature'
  | 'bad-crypt'
  | 'corp-mismatch'
  | 'no-ack'

/** GET 验证结果。 */
export interface VerifyOutcome {
  /** 是否通过。 */
  readonly ok: boolean
  /** HTTP 状态码。 */
  readonly http: number
  /** 响应体（通过时是 `echostr` 的**明文**原文，企业微信要求原样回）。 */
  readonly body: string
  /** 响应类型。 */
  readonly contentType: string
  /** 失败原因。 */
  readonly reason?: VerifyReason
  /** 一句中文说明。 */
  readonly detail?: string
}

/** 一条来信（已解密、已解析，字段名按本项目的命名）。 */
export interface InboundMessage {
  /** 发信成员 UserID（企业微信里是成员账号，不是 openid）。 */
  readonly userId: string
  /** 企业 ID（应答里要原样填）。 */
  readonly corpId: string
  /** 消息类型（`text` / `event` / `image` / …）。 */
  readonly msgType: string
  /** 正文（非文本消息为空串）。 */
  readonly text: string
  /** 平台消息 id（事件消息没有，可能为空）。 */
  readonly msgId: string
  /** 事件名（`MsgType === 'event'` 时才有）。 */
  readonly event: string
  /** 事件 key。 */
  readonly eventKey: string
  /** 平台给的秒级时间戳。 */
  readonly createdAt: number
}

/** 受理结果的处置方式（**响应体怎么写，由它决定**）。 */
export type Disposition = 'accept' | 'ignore' | 'reject'

/** 一次 POST 的处理结果。路由层照着它写响应。 */
export interface IngestOutcome {
  /** HTTP 状态码。 */
  readonly http: number
  /** 响应体：受理与忽略都是 `success`，拒绝是空串。 */
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
  | 'bad-signature'
  | 'bad-crypt'
  | 'bad-body'
  | 'not-allowed'
  | 'unsupported'
  | 'duplicate'
  | 'busy'
  | 'queued'
  | 'ignored'
  | 'no-kit'

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

/** 一次应用消息发送的结果。 */
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
  /** 企业微信给的错误说明（只进日志，不回给用户）。 */
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
  /** 凭据是否齐（`token`+`encodingAESKey` 收信，`corpId`+`secret`+`agentId` 发信）。 */
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
  /** 收到的 POST 数。 */
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
 * 传输（应用消息）
 * ------------------------------------------------------------------ */

/** 一次应用消息请求。 */
export interface PushRequest {
  /** 发给谁（成员 UserID）。 */
  readonly userId: string
  /** 正文（已切好，不超过 `chunkMax`）。 */
  readonly text: string
}

/** 一次应用消息响应。 */
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
 * 应用消息端口。
 *
 * 默认实现是 `src/transport.ts` 的 `HttpWecomPush`；换成企业内网关或测试桩时注入一个实现即可，
 * 适配器一行不改。
 */
export interface WecomPush {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 发一条文本。 */
  push(request: PushRequest): Promise<PushResult>
  /** 丢掉缓存的 access_token（换凭据后调用）。 */
  invalidate(): void
}

/** 取全局 fetch（Node 18+）。 */
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
  /** 支持群聊（自建应用回调没有群消息，恒 false）。 */
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
export interface WecomService {
  /** 现在能不能收（路由挂了 + 凭据齐 + 开关开着）。 */
  readonly available: boolean
  /** 不能收的原因。 */
  readonly reason?: VerifyReason
  /** GET 验证（企业微信后台「保存」时打过来的那一次）。 */
  verify(query: QueryLike): VerifyOutcome
  /** POST 处理一条来信（路由层照 `IngestOutcome` 写响应）。 */
  ingest(rawBody: string, query: QueryLike, at?: number): Promise<IngestOutcome>
  /** 主动发一条应用消息。 */
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
