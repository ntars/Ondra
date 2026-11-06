/**
 * O-065 `ondra-adapter-dingtalk` 的对外契约。**档位〔复〕**（通道复用：只做接线、配置与降级）。
 *
 * ## 手册与 master-plan 给出的全部依据（逐字）
 *
 * master-plan §9.11 那一行是**唯一**的可核对证据：
 *
 * ```
 * dingtalk | Webhook 3454（需公网） | HmacSHA256 验签 | 4000 | 先回 empty 再异步
 * ```
 *
 * 加上 §9.12 的一条字段修正：
 *
 * ```
 * dingtalk | `appKey` | 只有 `appSecret`+`port` | 多余字段
 * ```
 *
 * 手册 `Ondra-dev-handbook.md` 检索「钉钉」只命中一处（设置页通道清单），
 * **没有钉钉专章**。所以这里只承诺 §9.11 那一行能推出的四件事：
 * 验签、单条 4000、先回 empty 再异步、回调走 webhook。其余（`sessionWebhook`
 * 的 JSON 形状、主动接口路径、`conversationType` 取值）按钉钉开放平台公开文档写，
 * **仓内无副本、未实跑**，一律记进 README 的「已知限制」。
 *
 * ## §9.12 那条「`appKey` 是多余字段」怎么落地
 *
 * 旧项目的表单让人填了 `appKey`，而源码只读 `appSecret`——于是「填了也不生效」。
 * 新体系里 `appKey` **不是多余字段，而是「主动接口」这一条出口的必需项**：
 * 换 `accessToken` 要 `appKey`。所以它留在凭据里、标成可选，
 * 缺了它只关掉第二条出口（`no-app-key`），不关整条通道。这比"删掉这个字段"
 * 和"留着让人白填"都诚实。
 *
 * ## 三个必须在这里说清的判断
 *
 * 1. **先回空体，再异步发话。** 钉钉等的是响应，不是答案。在响应里塞正文意味着
 *    回答必须在那一次 HTTP 里跑完（要等模型、要切 4000 字），超时它就会重投。
 *    所以 `ingest()` 立刻回 200 空体，回答走 `sessionWebhook` 在后台发。
 * 2. **出口有两个，不是二选一写死。** 每条来信自带 `sessionWebhook` 与它的过期时刻；
 *    过期了就只能走机器人主动接口。两案各有各的失败原因码，绝不"以为发了"。
 * 3. **验签不过回 401。** 配置错（密钥填错、时钟偏了）必须在钉钉后台看得见；
 *    回 200 会变成「回调永远成功、她永远不回话、日志全绿」。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const DINGTALK_SERVICE_KEY = 'ondra-adapter-dingtalk'

/** 通道 id。日志命名空间 `channel.dingtalk`，凭据 `user/channels/dingtalk.json`。 */
export const CHANNEL_ID = 'dingtalk'

/** 中文名。 */
export const CHANNEL_LABEL = '钉钉'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单条上限（字符）。master-plan §9.11 实测值：`dingtalk 4000`。 */
export const CHUNK_MAX = 4_000

/** 单条上限的配置下界：100。再低会把一句话拆成四条。 */
export const CHUNK_MIN = 100

/** 默认路由路径。挂在宿主 webServer 上的绝对 pathname。 */
export const DEFAULT_ROUTE_PATH = '/ondra/dingtalk'

/** 默认接口基址（钉钉开放平台公开文档；仓内无副本，见 README）。 */
export const DEFAULT_API_BASE = 'https://api.dingtalk.com'

/** 凭据文件名后缀。 */
export const CREDENTIAL_FILE_SUFFIX = '.json'

/** 状态文件名后缀。 */
export const STATE_FILE_SUFFIX = '.state.json'

/**
 * 请求体上限（字节）：256KB。
 *
 * 钉钉的 Outgoing 报文很小（一两个 KB），64KB 都够；给 256KB 是为了不因为
 * 平台将来加了字段就把正常消息挡掉，同时仍能挡住「打错端口」。
 */
export const MAX_BODY_BYTES = 256 * 1024

/** 收到回调后的应答正文：**空串**（master-plan §9.11 原话「先回 empty」）。 */
export const ACK_BODY = ''

/** 回调的 content-type（空体也给，免得中间件猜）。 */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/** 验签用的两个请求头名字（小写；读头时按小写归一）。 */
export const SIGN_HEADER_TIMESTAMP = 'timestamp'

/** 验签用的签名头。 */
export const SIGN_HEADER_SIGN = 'sign'

/**
 * 时间戳容差（毫秒）：1 小时。
 *
 * 钉钉加签的时间戳容差在公开文档里是 1 小时；给更小的窗口会把「对方服务器慢几分钟」
 * 判成伪造，给更大的窗口等于放弃防重放。仓内无副本，故做成可配（`signSkewMs`）。
 */
export const SIGN_SKEW_MS = 3_600_000

/**
 * sessionWebhook 的发送安全余量（毫秒）：5 秒。
 *
 * 过期时刻是「到点就失效」，而一次 HTTP 往返要几百毫秒。掐着点发的结果是
 * 一半成功一半 `expired-session`，且看起来像随机故障。留 5 秒让它干脆利落地
 * 走第二条出口。
 */
export const SESSION_MARGIN_MS = 5_000

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/**
 * 凭据。**三样都只在文件里，不进 `Config`**（master-plan §6 禁令 6：密钥不写配置）。
 *
 * - `appSecret`：**唯一必需项**。验签要用它；缺了整条通道不可用。
 * - `appKey`：换 `accessToken` 用（只有主动接口要）。缺了只关第二条出口。
 * - `robotCode`：主动接口的机器人标识。缺了同样只关第二条出口。
 */
export interface DingTalkCredentials {
  /** 应用 AppKey（旧文档也叫 `AppKey` / `appKey`）。可空。 */
  readonly appKey: string
  /** 应用 AppSecret（**永不进日志**）。必需。 */
  readonly appSecret: string
  /** 机器人 robotCode。可空。 */
  readonly robotCode: string
}

/** 凭据缺失的原因（用来提示「还差哪一样」）。 */
export type CredentialMissing = 'file' | 'json' | 'shape' | 'appSecret'

/** 凭据读取结果。 */
export interface CredentialLoad {
  /** `appSecret` 是否到位（到位即可收信）。 */
  readonly ok: boolean
  /** 读到时的值。 */
  readonly value?: DingTalkCredentials
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

/** 会话类型。钉钉 `conversationType` 是 `'1'`（单聊）/ `'2'`（群聊）。 */
export type ConversationKind = 'private' | 'group'

/** 一条来信（已解析，字段名按本项目的命名）。 */
export interface InboundMessage {
  /** 会话 id（与 `conversationId` 同值；回复也用它）。 */
  readonly conversationId: string
  /** 私聊还是群。 */
  readonly kind: ConversationKind
  /** 发信人 staffId（主动接口要它；可能为空——外部联系人没有 staffId）。 */
  readonly senderStaffId: string
  /** 发信人 userId（`senderId`，形如 `$:LWCP_v1:$…`）。只进日志与白名单。 */
  readonly senderId: string
  /** 发信人昵称（只进日志）。 */
  readonly senderNick: string
  /** 正文（已剥掉开头的 @ 前缀）。 */
  readonly text: string
  /** 是否在 @ 名单里（群聊里通常为真）。 */
  readonly inAtList: boolean
  /** 平台消息 id。 */
  readonly messageId: string
  /** 这条消息自带的回信地址（可能为空）。 */
  readonly sessionWebhook: string
  /** 回信地址的过期时刻（毫秒；0 表示平台没给）。 */
  readonly sessionExpiredAt: number
  /** 平台给的创建时刻（毫秒；缺省取收到时刻）。 */
  readonly createdAt: number
}

/** 验签输入（从请求头里取）。 */
export interface SignInput {
  /** `timestamp` 头。 */
  readonly timestamp: string
  /** `sign` 头。 */
  readonly sign: string
}

/** 验签结论的原因码。 */
export type SignReason = 'ok' | 'missing-header' | 'bad-timestamp' | 'skew' | 'bad-sign'

/** 验签结论。 */
export interface SignVerdict {
  /** 是否通过。 */
  readonly ok: boolean
  /** 原因。 */
  readonly reason: SignReason
  /** 一句中文说明（不含任何密钥）。 */
  readonly detail: string
}

/** 受理结果的处置方式（**响应怎么写，由它决定**）。 */
export type Disposition = 'accept' | 'ignore' | 'reject'

/** 一次回调的处理结果。路由层照着它写响应。 */
export interface IngestOutcome {
  /** HTTP 状态码。 */
  readonly http: number
  /** 响应体：受理与忽略都是空串，拒绝也是空串（理由进日志）。 */
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
  /** 一句中文说明（不含正文、不含密钥）。 */
  readonly detail?: string
}

/** 受理原因（闭集）。 */
export type IngestReason =
  | 'ok'
  | 'disabled'
  | 'no-credentials'
  | 'bad-sign'
  | 'bad-body'
  | 'not-allowed'
  | 'unsupported'
  | 'duplicate'
  | 'busy'
  | 'queued'
  | 'ignored'

/* ------------------------------------------------------------------ *
 * 发信
 * ------------------------------------------------------------------ */

/** 发送结果原因（闭集）。**每一码对应一个不同的处置**，不许合并。 */
export type SendReason =
  | 'ok'
  | 'disabled'
  | 'no-credentials'
  | 'no-kit'
  | 'no-transport'
  | 'empty'
  | 'http'
  | 'timeout'
  | 'no-fetch'
  | 'expired-session'
  | 'no-app-key'
  | 'no-robot-code'
  | 'no-sender'

/** 一次消息发送的结果。 */
export interface SendOutcome {
  /** 是否全部发出。 */
  readonly ok: boolean
  /** 原因。 */
  readonly reason: SendReason
  /** 走的是哪条出口（`none` = 没发出去）。 */
  readonly via: ReplyVia | 'none'
  /** 切成几段。 */
  readonly pieces: number
  /** 成功几段。 */
  readonly sent: number
  /** 平台错误码（`errcode`）。 */
  readonly errcode?: number
  /** 钉钉给的错误说明（只进日志，不回给用户）。 */
  readonly errmsg?: string
}

/** 回信走哪条出口。`auto` = 先试 sessionWebhook，过期再走主动接口。 */
export type ReplyVia = 'auto' | 'session' | 'active'

/* ------------------------------------------------------------------ *
 * 传输
 * ------------------------------------------------------------------ */

/** 走 sessionWebhook 发一条。 */
export interface SessionPushRequest {
  /** 这条消息自带的回信地址。 */
  readonly webhook: string
  /** 正文（已切好，不超过 `chunkMax`）。 */
  readonly text: string
  /** 要 @ 的人（群聊里 @ 提问者）。可为空。 */
  readonly atUserIds?: readonly string[]
}

/** 走机器人主动接口发一条。 */
export interface ActivePushRequest {
  /** 私聊还是群（决定调哪个接口）。 */
  readonly kind: ConversationKind
  /** 会话 id：群里是 `openConversationId`，私聊忽略。 */
  readonly conversationId: string
  /** 私聊必填：收信人 staffId。 */
  readonly userId: string
  /** 正文。 */
  readonly text: string
}

/** 一次发送的响应。 */
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
 * 发信端口。**两条出口各一个方法**，不合成一个带 mode 的方法。
 *
 * 合成一个的代价：调用方要在一个函数里铺两套逻辑，而两套的失败含义完全不同
 * （`expired-session` 该换出口，`no-app-key` 换了也没用）。分开之后
 * `adapter.ts` 的选路是一段可读的 if，而不是一个 300 行的 switch。
 *
 * 默认实现是 `src/transport.ts` 的 `HttpDingTalkPush`；换成企业内网关或测试桩时注入即可。
 */
export interface DingTalkPush {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 走 sessionWebhook。 */
  pushSession(request: SessionPushRequest): Promise<PushResult>
  /** 走机器人主动接口。 */
  pushActive(request: ActivePushRequest): Promise<PushResult>
  /** 丢掉缓存的 accessToken（换凭据后调用）。 */
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
  /** 凭据是否齐（只判 `appSecret`）。 */
  readonly credential: { readonly ok: boolean; readonly missing?: CredentialMissing }
  /** 主动接口这条出口是否就绪（`appKey` 与 `robotCode` 都在）。 */
  readonly activeReady: boolean
  /** 白名单人数（0 = 不限）。 */
  readonly allowlist: number
  /** 正在回答的会话数。 */
  readonly inflight: number
  /** 排队中的条数。 */
  readonly queued: number
  /** 学过身份的会话数（主动发言要用）。 */
  readonly contacts: number
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
  /** 按出口分桶的发信数。 */
  readonly byExit: { readonly session: number; readonly active: number }
  /** 最慢一次「从收到到回答完成」的耗时（毫秒）。 */
  readonly worstAnswerMs: number
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
  readonly kind: ConversationKind
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
export interface DingtalkService {
  /** 现在能不能收（路由挂了 + 凭据齐 + 开关开着）。 */
  readonly available: boolean
  /** 不能收的原因。 */
  readonly reason?: IngestReason
  /** 处理一次回调（路由层照 `IngestOutcome` 写响应）。 */
  ingest(rawBody: string, headers: Readonly<Record<string, string>>, at?: number): Promise<IngestOutcome>
  /** 主动发一条（这条会话必须学过身份）。 */
  reply(conversationId: string, text: string, at?: number): Promise<SendOutcome>
  /** 通道现状。 */
  status(): AdapterStatus
  /** 计数。 */
  stats(): AdapterStats
  /** 心跳（清理过期记录 + 按节流落盘 + 上报探针）。 */
  tick(at?: number): void
  /** 立刻落盘。 */
  flush(): void
  /** 标记路由已挂上（由入口在注册成功后调用）。 */
  markRegistered(value: boolean): void
  /** 重读凭据（换文件后调用，不必重启）。 */
  reload(): CredentialLoad
  /** 换发信实现（注入测试桩或企业内网关时用）。 */
  setPush(push: DingTalkPush | null): void
}
