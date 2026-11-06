/**
 * O-062 `ondra-adapter-wechat-personal` 的对外契约。**档位〔复〕·高危。**
 *
 * ## 手册对这条路的原话只有两句，但两句都重
 *
 * ```
 * wxauto 有成熟实现，但风险更高（§1.7）
 * 入站 3457 + 出站用户 webhook · 无（仅回环）+ confirmed===true 硬闸门 · 1000 · 无去重（§9.11）
 * ```
 *
 * 加上 §6.2 的操作口径：**白名单外不发信息**、刚注册的小号基本秒风控、只能用养过一段时间的号。
 *
 * ## 所以这个插件「不做」的部分比「做」的部分更重要
 *
 * - **不操作微信**。wxauto 是 Windows 上的客户端 UI 自动化，本机是 macOS；
 *   插件只在「桥接端 ↔ 她」之间接线，并在契约里写清桥接端该发什么。
 * - **不做加密、不做协议**。没有 OCR、没有注入、没有 DLL。
 * - **不做二次确认以外的开关**：`confirmed` 只认字面量 `true`，且必须有一份
 *   带说明的确认档案（`user/channels/wechat-personal.confirm.json`），
 *   记录「什么时候、谁、确认了什么」。事后能追，才叫确认。
 *
 * ## 仅回环不是一个默认值，是一条硬规则
 *
 * 宿主的 `webServer` 可以绑到具体网卡地址（`desktop/docs/subsystems/web-server.zh.md`
 * 明确写了 host 只能是本机某个具体字面量，且未指定地址会被拒绝）。也就是说：
 * **端口是不是只在本机，不由本插件决定**。
 *
 * 所以「仅回环」必须在请求层判定：`req.socket.remoteAddress` 不是回环就直接 403。
 * 把这个做成配置项，等于把唯一的边界交给一个可能被误点的开关。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const PERSONAL_SERVICE_KEY = 'ondra-adapter-wechat-personal'

/** 通道 id。日志命名空间 `channel.wechat-personal`。 */
export const CHANNEL_ID = 'wechat-personal'

/** 中文名。 */
export const CHANNEL_LABEL = '微信（个人号）'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单条上限（字符）。手册 §9.11 实测值：`wechat-personal 1000`。 */
export const CHUNK_MAX = 1_000

/** 单条上限的配置下界：100。再低会把一句话拆成四条。 */
export const CHUNK_MIN = 100

/** 默认入站路径。挂在宿主 webServer 上的绝对 pathname（无尾斜杠）。 */
export const DEFAULT_ROUTE_PATH = '/ondra/wechat-personal'

/** 手册 §9.11 记的入站端口。**端口归宿主**，这里只用来在日志与 README 里指路。 */
export const CALLBACK_PORT_HINT = 3457

/** 回环地址白名单（IPv4 / IPv6 / IPv4-mapped，以及 IPv6 的完整写法）。 */
export const LOOPBACK_ADDRESSES: readonly string[] = Object.freeze([
  '127.0.0.1',
  '::1',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
])

/** 默认冷却（毫秒）。**推断值**：手册没给个人号的频控数字，见 README 已知限制。 */
export const COOLDOWN_MS = 1_200

/** 冷却下界：0（关闭）。 */
export const COOLDOWN_MIN = 0

/** 冷却上界：60 秒。再长会让人觉得「她不理我」。 */
export const COOLDOWN_MAX = 60_000

/** 冷却表容量上限（记住最近说过话的人）。 */
export const COOLDOWN_LIMIT = 200

/** 回复预算的默认值（毫秒）：4000。**不是平台硬限**，只是不让桥接端干等。 */
export const DEFAULT_REPLY_BUDGET_MS = 4_000

/** 预算的兜底下界：800ms。再低连一次本地调用都跑不完。 */
export const REPLY_BUDGET_MIN = 800

/** 预算的上界：30 秒。再长桥接端会先超时断开。 */
export const REPLY_BUDGET_MAX = 30_000

/** 请求体上限（字节）。个人号报文不会超过这个数量级。 */
export const MAX_BODY_BYTES = 64 * 1024

/** 确认档案文件名后缀。 */
export const CONFIRM_FILE_SUFFIX = '.confirm.json'

/** 状态文件名后缀（冷却表）。 */
export const STATE_FILE_SUFFIX = '.state.json'

/** 确认说明的最短长度：4 个字。逼着人写清「确认了什么」，而不是点一下。 */
export const CONFIRM_NOTE_MIN = 4

/** 心跳间隔（毫秒）。 */
export const HEARTBEAT_MS = 30_000

/* ------------------------------------------------------------------ *
 * 桥接端来的消息
 * ------------------------------------------------------------------ */

/**
 * 桥接端推来的一条消息。**这个形状是本插件的契约**，因为桥接端由用户自备。
 *
 * ```json
 * {"contact": "张三", "text": "在吗", "messageId": "可选", "at": 1730000000000,
 *  "group": false, "self": false}
 * ```
 *
 * 字段命名用英文而非中文，是为了让写桥接脚本的人能一眼对照。
 * 未知字段一律忽略（向前兼容），`contact` 与 `text` 缺失即 `bad-body`。
 */
export interface BridgeInbound {
  /** 会话对象（联系人名 / 群名）。wxauto 侧给的就是显示名。 */
  readonly contact: string
  /** 正文。 */
  readonly text: string
  /** 平台消息 id（可选；本插件**不做去重**，只用于日志对号）。 */
  readonly messageId: string
  /** 消息时刻（毫秒；缺省用收到时刻）。 */
  readonly at: number
  /** 是不是群消息。 */
  readonly group: boolean
  /** 是不是自己发的（桥接端应置 true，本插件据此跳过）。 */
  readonly self: boolean
}

/** 受理结果的处置方式。 */
export type Disposition = 'reply' | 'deferred' | 'reject' | 'silent'

/** 一次入站的处理结果。路由层照它写响应。 */
export interface IngestOutcome {
  /** HTTP 状态码。 */
  readonly http: number
  /** 响应体（给桥接端的 JSON）。 */
  readonly body: string
  /** 响应类型。 */
  readonly contentType: string
  /** 处置方式。 */
  readonly disposition: Disposition
  /** 原因（闭集）。 */
  readonly reason: IngestReason
  /** 会话 id。 */
  readonly conversationId?: string
  /** 切成几段。 */
  readonly pieces: number
  /** 一句中文说明（不含正文）。 */
  readonly detail?: string
}

/** 受理原因（闭集）。 */
export type IngestReason =
  | 'ok'
  | 'deferred'
  | 'disabled'
  | 'not-confirmed'
  | 'no-confirm-record'
  | 'group-blocked'
  | 'not-whitelisted'
  | 'blocked'
  | 'unsupported'
  | 'cooldown'
  | 'busy'
  | 'bad-body'
  | 'loopback-only'
  | 'no-kit'
  | 'ignored'

/** 发送结果原因（闭集）。 */
export type SendReason =
  | 'ok'
  | 'disabled'
  | 'not-confirmed'
  | 'no-webhook'
  | 'empty'
  | 'http'
  | 'timeout'
  | 'no-fetch'
  | 'no-kit'
  | 'blocked'
  | 'not-whitelisted'

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
  /** 桥接端回的说明（只进日志）。 */
  readonly detail?: string
}

/* ------------------------------------------------------------------ *
 * 闸门
 * ------------------------------------------------------------------ */

/** 闸门判定结果。 */
export interface GateVerdict {
  /** 是否放行。 */
  readonly ok: boolean
  /** 拒绝原因。 */
  readonly reason?: GateReason
}

/** 闸门拒绝原因（闭集）。 */
export type GateReason =
  | 'disabled'
  | 'not-confirmed'
  | 'no-confirm-record'
  | 'group-blocked'
  | 'blocked'
  | 'not-whitelisted'
  | 'cooldown'

/** 二次确认档案。 */
export interface ConfirmRecord {
  /** 是否已确认（只认字面量 `true`）。 */
  readonly confirmed: boolean
  /** 确认/撤销时刻（毫秒）。 */
  readonly at: number
  /** 说明（≥ 4 字）。 */
  readonly note: string
}

/** 确认档案读取结果。 */
export interface ConfirmLoad {
  /** 档案内容（不存在时是「未确认」）。 */
  readonly record: ConfirmRecord
  /** 文件是否存在。 */
  readonly exists: boolean
  /** 一句中文说明。 */
  readonly detail: string
}

/** 闸门输入（纯计算，不读盘）。 */
export interface GateInput {
  /** 总开关。 */
  readonly enable: boolean
  /** 配置里的确认位（只认字面量 `true`）。 */
  readonly confirmed: boolean
  /** 确认档案。 */
  readonly record: ConfirmRecord
  /** 档案文件是否存在。 */
  readonly recordExists: boolean
  /** 会话对象（微信显示名）。 */
  readonly contact: string
  /** 白名单（空 = 全拒）。 */
  readonly allow: readonly string[]
  /** 黑名单（优先于白名单）。 */
  readonly block: readonly string[]
  /** 是否允许群消息。 */
  readonly allowGroups: boolean
  /** 这一条是不是群消息。 */
  readonly isGroup: boolean
  /** 冷却（毫秒，0 = 关闭）。 */
  readonly cooldownMs: number
  /** 这个会话最后一次被回答的时刻（毫秒；0 = 从未）。 */
  readonly lastAnsweredAt: number
  /** 当前时刻（毫秒）。 */
  readonly now: number
}

/* ------------------------------------------------------------------ *
 * 现状与计数
 * ------------------------------------------------------------------ */

/** 通道现状。 */
export interface PersonalStatus {
  /** 路由是否已挂上。 */
  readonly mounted: boolean
  /** 通道 id。 */
  readonly channelId: string
  /** 路由路径。 */
  readonly routePath: string
  /** 双闸门现状。 */
  readonly gate: {
    /** 总开关。 */
    readonly enable: boolean
    /** 配置里的确认位。 */
    readonly confirmed: boolean
    /** 档案是否有效。 */
    readonly record: boolean
  }
  /** 白名单人数（0 = 全拒）。 */
  readonly allowlist: number
  /** 冷却表人数。 */
  readonly cooldownEntries: number
  /** 出站 webhook 是否配了。 */
  readonly webhook: boolean
  /** 最近一次错误（中文，不含正文）。 */
  readonly lastError: string | null
}

/** 计数。 */
export interface PersonalStats {
  /** 收到的请求数。 */
  readonly inbound: number
  /** 回答了条数。 */
  readonly answered: number
  /** 推迟到 webhook 的条数。 */
  readonly deferred: number
  /** webhook 发出的段数。 */
  readonly pushed: number
  /** 按原因分桶的拒绝数。 */
  readonly rejected: Readonly<Record<string, number>>
}

/* ------------------------------------------------------------------ *
 * 出站（用户 webhook）
 * ------------------------------------------------------------------ */

/** 一次出站请求。 */
export interface PushRequest {
  /** 发给谁（联系人名）。 */
  readonly contact: string
  /** 正文（已切好，不超过 `chunkMax`）。 */
  readonly text: string
  /** 原消息 id（桥接端可用来做引用回复；可缺省）。 */
  readonly messageId: string
}

/** 一次出站响应。 */
export interface PushResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** 失败归类。 */
  readonly reason?: SendReason
  /** 桥接端给的一句话。 */
  readonly detail?: string
}

/**
 * 出站端口。
 *
 * 默认实现是 `src/transport.ts` 的 `HttpWebhookPush`（POST JSON 到用户配置的地址）。
 * 需要走别的投递方式（消息队列、本地 socket）时注入一个实现即可，适配器一行不改。
 */
export interface PersonalPush {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 发一条文本。 */
  push(request: PushRequest): Promise<PushResult>
}

/** 最小 fetch 响应的形状（不引 `lib.dom`，也不写 `any`）。 */
export interface FetchResponseLike {
  /** 状态码。 */
  readonly status: number
  /** 读文本；失败由调用方吞掉。 */
  text(): Promise<string>
}

/** 最小 fetch 形状。 */
export type FetchLike = (
  url: string,
  init?: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
    readonly signal?: AbortSignal
  },
) => Promise<FetchResponseLike>

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

/**
 * 宿主的 HTTP 请求（结构对位：不把 node:http 拉进公开契约）。
 *
 * `socket.remoteAddress` 是**仅回环**判定的唯一依据。它不是可选的装饰：
 * 宿主的 listen 地址由配置决定（可以是具体网卡地址），所以「只在本机」
 * 这件事只能在请求层确认。
 */
export interface HttpRequestLike {
  /** 方法。 */
  readonly method?: string
  /** 请求 URL（含 query）。 */
  readonly url?: string
  /** 请求头。 */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  /** 连接本身（取对端地址用）。 */
  readonly socket?: { readonly remoteAddress?: string }
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
export interface PersonalService {
  /** 现在能不能收（双闸门都过 + 有 webServer 才谈得上收）。 */
  readonly available: boolean
  /** 不能收的原因。 */
  readonly reason?: IngestReason
  /** 处理一条桥接端推来的消息（路由层照 `IngestOutcome` 写响应）。 */
  ingest(payload: unknown, at?: number): Promise<IngestOutcome>
  /** 回环判定失败时的统一响应（403 的形状只在一处定义）。 */
  loopbackReject(): IngestOutcome
  /** 主动发一条（恒走出站 webhook：入站通道只用来接）。 */
  reply(contact: string, text: string, at?: number): Promise<SendOutcome>
  /** 写确认档案（**唯一的确认入口**）。说明至少 4 个字。 */
  confirm(note: string, at?: number): { readonly ok: boolean; readonly detail: string }
  /** 撤销确认（写 `confirmed:false` 并留痕，不删文件）。 */
  revoke(note: string, at?: number): { readonly ok: boolean; readonly detail: string }
  /** 双闸门现状（供面板渲染）。 */
  gate(): GateVerdict
  /** 通道现状。 */
  status(): PersonalStatus
  /** 计数。 */
  stats(): PersonalStats
  /** 心跳：清过期冷却 + 按节流落盘。 */
  tick(at?: number): void
  /** 立刻落盘。 */
  flush(): void
  /** 路由挂上/撤掉时由 `index.ts` 调用。 */
  markMounted(mounted: boolean): void
}
