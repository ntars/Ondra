/**
 * O-061 `ondra-adapter-wechat-kf` 的对外契约。**档位〔复〕。**
 *
 * ## 手册给的四个数
 *
 * ```
 * 拉取式 sync_msg 每 5s + cursor · sha1 验签 · 单条 800 · 游标去重
 * ```
 *
 * ## 这条路和公众号那条（O-060）不是同一件事
 *
 * 公众号是「微信打过来」：不给它一条公网路由，这个通道就等于不存在；
 * 于是它必须把 5 秒的账平掉（先回降级话术、真回复走客服消息）。
 * 客服是「我过去拿」：**不需要公网、不需要 5 秒硬限、不需要降级话术**——
 * 每 5 秒自己拉一次，拉到了就回，回复晚 20 秒也没人掐断我。
 *
 * 所以本插件**刻意不抄 O-060 的三样东西**（交棒、降级话术、去重窗口），
 * 只保留它那条链路里真正的教训：切条只认 O-056、回复必须落在窗口内、
 * 同会话必须串行（两段并发会让用户看到「她同时在说两件不相干的事」）。
 *
 * ## 拉取式真正的风险是「重放」不是「超时」
 *
 * - 游标（`next_cursor`）是**唯一主去重**：只处理游标之后的消息；
 * - 但平台可能重放同一批（游标丢失、回退、我们中途崩了但游标已推进），
 *   所以另存一张 `seen` 表按 `msgid` 兜底——它是**兜底不是主逻辑**，
 *   容量有上限、按时间淘汰，绝不无限长。
 * - **游标只在整批处理完之后才推进**：先推进再处理，崩一次就永远丢那几条。
 *
 * ## origin 过滤：别回答自己
 *
 * 客服会话里同时存在三种来源：微信客户（3）、系统事件（4）、接待人员（5）。
 * 不过滤就会「她回复了自己接待人员的回复」，两个人格在同一侧对话，越说越乱。
 * 所以默认只回 origin=3，并且把它做成配置（`respondOrigins`），
 * 因为平台多加了来源码时，改配置比等我发版快。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const KF_SERVICE_KEY = 'ondra-adapter-wechat-kf'

/** 通道 id。日志命名空间 `channel.wechat-kf`，凭据 `user/channels/wechat-kf.json`。 */
export const CHANNEL_ID = 'wechat-kf'

/** 中文名。 */
export const CHANNEL_LABEL = '微信客服'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单条上限（字符）。手册 §9.11 实测值：`wechat-kf 800`。 */
export const CHUNK_MAX = 800

/** 单条上限的配置下界：100。再低会把一句话拆成四条。 */
export const CHUNK_MIN = 100

/** 拉取间隔（毫秒，手册 §9.11：每 5 秒）。 */
export const POLL_MS = 5_000

/** 拉取间隔下界：1 秒。再快就是在刷平台接口。 */
export const POLL_MIN = 1_000

/** 拉取间隔上界：60 秒。再慢会让人等得以为她不在。 */
export const POLL_MAX = 60_000

/** 一轮最多连拉几批（`has_more` 连续为真时）。 */
export const MAX_ROUNDS = 5

/** 单批条数的默认值。 */
export const PAGE_LIMIT = 100

/** 单批条数的上界（平台给的是 1000，这里不越过去）。 */
export const PAGE_LIMIT_MAX = 1_000

/** 人格调用预算的默认值（毫秒）：30 秒。手册没给这个数，是本项目的判断值。 */
export const PERSONA_TIMEOUT_MS = 30_000

/** 人格调用预算的下界：5 秒。再短会把正常的慢回答也取消掉。 */
export const PERSONA_TIMEOUT_MIN = 5_000

/** 人格调用预算的上界：3 分钟。再长等于放任一轮卡死整条拉取链路。 */
export const PERSONA_TIMEOUT_MAX = 180_000

/** 会话窗口（小时，手册 §9.11 的 48 小时窗口口径）。 */
export const WINDOW_HOURS = 48/** 会话窗口小时数的下界。 */
export const WINDOW_MIN = 1

/** 会话窗口小时数的上界。 */
export const WINDOW_MAX = 72

/** `seen` 表容量上限。超了裁到一半：它是兜底，不是账本。 */
export const SEEN_LIMIT = 500

/** 窗口表的容量上限（记住最近说过话的人）。 */
export const WINDOW_LIMIT = 200

/** 凭据文件名后缀。 */
export const CREDENTIAL_FILE_SUFFIX = '.json'

/** 状态文件名后缀（游标 + seen + 窗口）。 */
export const STATE_FILE_SUFFIX = '.state.json'

/** 默认回调路径（**留空即不挂**：拉取式不需要公网）。 */
export const DEFAULT_ROUTE_PATH = ''

/** 拉取式默认的绝对路径（只有显式填了才挂）。 */
export const CALLBACK_ROUTE_HINT = '/ondra/wechat-kf'

/** 默认接口基址（企业微信 / 微信客服公开文档；仓内无副本，见 README 已知限制）。 */
export const DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com'

/** 回调请求体上限（字节）。 */
export const MAX_BODY_BYTES = 64 * 1024

/** access_token 提前续期的安全余量（毫秒）：5 分钟。 */
export const TOKEN_SAFETY_MS = 300_000

/** 来源码：微信客户发来的消息。**只有这一种要回。** */
export const ORIGIN_CUSTOMER = 3

/** 来源码：系统推送的事件。 */
export const ORIGIN_SYSTEM = 4

/** 来源码：接待人员（企业微信侧的人）回复的消息。 */
export const ORIGIN_STAFF = 5

/** 来源码的合法区间（`respondOrigins` 的过滤范围）。 */
export const ORIGIN_MIN = 1

/** 来源码的上界。 */
export const ORIGIN_MAX = 9

/** 回调验签允许的时间偏差（毫秒）：5 分钟。 */
export const MAX_SKEW_MS = 300_000

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/**
 * 凭据。**五样都只在文件里，不进 `Config`。**
 *
 * - `corpId` / `secret`：换 access_token（拉消息、发消息都要它）；
 * - `openKfId`：客服号 id（`wk...` 开头），拉取与发送都必须带；
 * - `token` / `encodingAesKey`：**只有挂回调时才用**，拉取式用不上。
 *
 * 前两样被拿走后可以以这个企业的身份调接口，所以一律 0600、
 * 永不进日志。后两样只在回调模式需要，缺失不算凭据不全。
 */
export interface KfCredentials {
  /** 企业 id。 */
  readonly corpId: string
  /** 应用的 Secret。 */
  readonly secret: string
  /** 客服号 id（`wk...`）。 */
  readonly openKfId: string
  /** 回调 Token（仅回调模式）。 */
  readonly token: string
  /** 回调 EncodingAESKey（仅回调模式；本版不解密，见 README）。 */
  readonly encodingAesKey: string
}

/** 凭据缺失的字段名（用来提示「还差哪一样」，而不是笼统说「配置不对」）。 */
export type CredentialMissing = 'file' | 'corpId' | 'secret' | 'openKfId' | 'json' | 'shape'

/** 凭据读取结果。 */
export interface CredentialLoad {
  /** 拉取与发送所需的三样是否齐全。 */
  readonly ok: boolean
  /** 读到时的值。 */
  readonly value?: KfCredentials
  /** 缺什么。 */
  readonly missing?: CredentialMissing
  /** 一句中文说明（含它在找哪个路径）。 */
  readonly detail: string
  /** 权限是否被就地收紧过。 */
  readonly tightened: boolean
}

/* ------------------------------------------------------------------ *
 * 消息
 * ------------------------------------------------------------------ */

/** 一条客服消息（已归一化。字段名用本项目的命名，不沿用报文里的写法）。 */
export interface KfMessage {
  /** 消息 id。**去重靠它**（游标之外的第二道）。 */
  readonly messageId: string
  /** 客服号 id。 */
  readonly openKfId: string
  /** 外部联系人 id（微信客户的唯一标识）。 */
  readonly externalUserId: string
  /** 来源：3 客户 / 4 系统 / 5 接待人员。 */
  readonly origin: number
  /** 消息类型（`text` / `event` / …）。 */
  readonly msgType: string
  /** 正文（非文本为空串）。 */
  readonly text: string
  /** 平台给的时间（**秒**，与项目内的毫秒不同，转换在 transport 里做）。 */
  readonly sendTime: number
  /** 事件名（`msgType === 'event'` 时才有）。 */
  readonly eventName: string
  /** 事件类型（`enter_session` 等）。 */
  readonly eventType: string
}

/** 一批拉取结果。 */
export interface SyncResult {
  /** 是否成功（平台 `errcode !== 0` 时也返回 `false`，并把码带回来）。 */
  readonly ok: boolean
  /** 这一批的消息（已归一化）。 */
  readonly messages: readonly KfMessage[]
  /** 下一页游标（空串 = 平台没给，本轮到此为止）。 */
  readonly nextCursor: string
  /** 还有没有下一页。 */
  readonly hasMore: boolean
  /** 平台错误码。 */
  readonly errcode?: number
  /** 平台错误说明。 */
  readonly errmsg?: string
  /** 非平台码的失败归类（超时、网络、没 fetch）。 */
  readonly reason?: SyncFailure
}

/** 拉取失败归类（闭集）。 */
export type SyncFailure = 'no-fetch' | 'timeout' | 'http' | 'token' | 'bad-body'

/** 一次发送结果。 */
export interface SendResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** 平台错误码。 */
  readonly errcode?: number
  /** 平台错误说明。 */
  readonly errmsg?: string
  /** 非平台码的失败归类。 */
  readonly reason?: SyncFailure
}

/** 最小 fetch 响应的形状（不引 `lib.dom`，也不写 `any`）。 */
export interface FetchResponseLike {
  /** 状态码。 */
  readonly status: number
  /** 解析 JSON；解析失败由调用方吞掉。 */
  json(): Promise<unknown>
}

/** 最小 fetch 形状。注入实现即可换代理/网关/测试桩。 */
export type FetchLike = (
  url: string,
  init?: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
    readonly signal?: AbortSignal
  },
) => Promise<FetchResponseLike>

/** 拉取端口。默认实现是 `src/transport.ts` 的 `HttpKfTransport`。 */
export interface KfTransport {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 拉一批。 */
  sync(request: {
    readonly cursor: string
    readonly limit: number
    readonly openKfId: string
  }): Promise<SyncResult>
  /** 发一条文本（已切好，不超上限）。 */
  send(request: {
    readonly openKfId: string
    readonly externalUserId: string
    readonly text: string
  }): Promise<SendResult>
  /** 丢掉缓存的 access_token（换凭据后调用）。 */
  invalidate(): void
}

/* ------------------------------------------------------------------ *
 * 结果与现状
 * ------------------------------------------------------------------ */

/** 一轮拉取的结果。 */
export interface PollOutcome {
  /** 这一轮是否跑完（`false` 时 `reason` 说清为什么）。 */
  readonly ok: boolean
  /** 原因（闭集）。 */
  readonly reason: PollReason
  /** 连拉了几批。 */
  readonly rounds: number
  /** 拉到几条。 */
  readonly fetched: number
  /** 回答了几条。 */
  readonly answered: number
  /** 这一轮结束后的游标。 */
  readonly cursor: string
  /** 一句中文说明（不含正文）。 */
  readonly detail?: string
}

/** 拉取原因（闭集）。 */
export type PollReason =
  | 'ok'
  | 'disabled'
  | 'busy'
  | 'no-credentials'
  | 'no-transport'
  | 'no-kit'
  | 'http'
  | 'timeout'
  | 'token'
  | 'bad-body'
  | 'no-fetch'

/** 单条消息的处置结果（`pollOnce` 内部用，也回灌到统计桶）。 */
export type HandleReason =
  | 'answered'
  | 'queued'
  | 'ignored-origin'
  | 'unsupported'
  | 'duplicate'
  | 'not-whitelisted'
  | 'blocked'
  | 'denied'
  | 'send-failed'

/** 发送结果原因（闭集）。 */
export type SendReason =
  | 'ok'
  | 'disabled'
  | 'no-credentials'
  | 'no-transport'
  | 'window-expired'
  | 'empty'
  | 'http'
  | 'token'
  | 'timeout'
  | 'no-fetch'
  | 'no-kit'

/** 一次回复的结果。 */
export interface SendOutcome {
  /** 是否全部发出。 */
  readonly ok: boolean
  /** 原因。 */
  readonly reason: SendReason
  /** 切成几段。 */
  readonly pieces: number
  /** 成功几段。 */
  readonly sent: number
  /** 平台错误码。 */
  readonly errcode?: number
  /** 平台错误说明（只进日志）。 */
  readonly errmsg?: string
}

/** 回调验签结果（只有挂了回调才会用到）。 */
export interface VerifyOutcome {
  /** 是否通过。 */
  readonly ok: boolean
  /** HTTP 状态码。 */
  readonly http: number
  /** 响应体（通过时是 `echostr` 原文）。 */
  readonly body: string
  /** 响应类型。 */
  readonly contentType: string
  /** 失败原因。 */
  readonly reason?: VerifyReason
  /** 一句中文说明。 */
  readonly detail?: string
}

/** 验签失败原因（闭集）。 */
export type VerifyReason = 'callback-off' | 'no-token' | 'missing-params' | 'bad-signature' | 'stale'

/** 通道现状。 */
export interface KfStatus {
  /** 拉取循环是否在跑。 */
  readonly polling: boolean
  /** 通道 id。 */
  readonly channelId: string
  /** 拉取间隔（毫秒）。 */
  readonly pollMs: number
  /** 凭据是否齐（拉取与发送所需的三样）。 */
  readonly credential: { readonly ok: boolean; readonly missing?: CredentialMissing }
  /** 当前游标（空串 = 还没拉过）。 */
  readonly cursor: string
  /** 窗口内有记录的人数。 */
  readonly windowEntries: number
  /** 白名单人数（0 = 不限）。 */
  readonly allowlist: number
  /** 回调是否挂上（拉取式为 `false` 是正常的）。 */
  readonly callbackMounted: boolean
  /** 最近一次错误（中文，不含正文）。 */
  readonly lastError: string | null
}

/** 计数。 */
export interface KfStats {
  /** 拉取轮数。 */
  readonly polls: number
  /** 拉到条数。 */
  readonly fetched: number
  /** 回答了条数。 */
  readonly answered: number
  /** 发出去的段数。 */
  readonly sent: number
  /** 按原因分桶的拒绝数。 */
  readonly skipped: Readonly<Record<string, number>>
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
}

/** O-055 的能力声明子集。 */
export interface ChannelCapsLike {
  /** 单条上限。 */
  readonly maxChars: number
  /** 支持私聊。 */
  readonly privateChat: boolean
  /** 支持群聊（客服是一对一，恒 false）。 */
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

/** O-055 交出的一条积压（结构对位）。 */
export interface QueueItemLike {
  /** 正文。 */
  readonly text: string
  /** 平台消息 id。 */
  readonly messageId?: string
  /** 触发方式。 */
  readonly trigger: string
  /** 私聊还是群。 */
  readonly kind: 'private' | 'group'
  /** 通道 id。 */
  readonly channelId: string
  /** 发信人。 */
  readonly senderId?: string
}

/** O-055 路由服务子集。 */
export interface RouterLike {
  admit(input: RouteInputLike): AdmissionLike
  release(conversationId: string): readonly QueueItemLike[]
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

/** 请求 query。 */
export type QueryLike = Readonly<Record<string, string | undefined>>

/** 本插件对外提供的服务。 */
export interface KfService {
  /** 现在能不能收（凭据齐 + 有传输）。 */
  readonly available: boolean
  /** 不能收的原因。 */
  readonly reason?: PollReason
  /** 立刻拉一轮（`pollMs` 定时器调的也是它）。 */
  pollOnce(at?: number): Promise<PollOutcome>
  /** 开始周期性拉取。重复调用无副作用。 */
  start(): void
  /** 停止周期性拉取（在飞的这一轮会跑完）。 */
  stop(): void
  /** 主动发一条（窗口外直接拒，理由 `window-expired`）。 */
  reply(conversationId: string, text: string, at?: number): Promise<SendOutcome>
  /** 回调验签（只有挂了回调才会被调用）。 */
  verify(query: QueryLike): VerifyOutcome
  /** 通道现状。 */
  status(): KfStatus
  /** 计数。 */
  stats(): KfStats
  /** 心跳：清过期记录 + 按节流落盘。 */
  tick(at?: number): void
  /** 立刻落盘。 */
  flush(): void
  /** 回调路由是否已挂上（index.ts 在注册成功/撤销时调）。 */
  markCallbackMounted(mounted: boolean): void
}
