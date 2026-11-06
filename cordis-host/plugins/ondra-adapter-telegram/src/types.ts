/**
 * O-066 `ondra-adapter-telegram` 的对外契约。**档位〔复〕**（通道复用：只做接线、配置与降级）。
 *
 * ## 手册与 master-plan 给出的全部依据（逐字）
 *
 * master-plan §9.11 那一行是**唯一**的可核对证据：
 *
 * ```
 * telegram | getUpdates 长轮询 timeout 50 | token 在 URL | 4000 | offset 去重；失败 3s 退避
 * ```
 *
 * 手册 `Ondra-dev-handbook.md` 检索「telegram」零命中（**没有 Telegram 专章**）。
 * 所以这里只承诺那一行能推出的五件事：长轮询、`timeout 50`、token 在 URL、
 * 单条 4000、`offset` 去重 + 失败 3 秒退避。其余（`Update` 的字段形状、
 * `sendMessage` 的请求体、`getMe`）按 Telegram Bot API 公开文档写，
 * **仓内无副本、未实跑**，一律记进 README 的「已知限制」。
 *
 * ## 「token 在 URL」是本包最危险的一条，不是最方便的一条
 *
 * Telegram 的鉴权方式是把 token 拼在路径里：`/bot<token>/getUpdates`。
 * 这意味着**任何一次把 URL 打进日志的行为都等于泄漏凭据**：
 * `fetch` 抛的错常常带着完整 URL、`HTTP 401` 的诊断也常带着它。
 * 所以本包有一条硬纪律：
 *
 * > **凡是 URL 出现在字符串里的地方，先过 `redactToken()`。**
 *
 * `redactToken()` 不做「按固定前缀切」的猜测，而是用正则把
 * `bot<数字>:<字母数字_-串>` 整段换成 `bot***`——两条路径都要盖住：
 * 请求路径与会话里的 URL 并存时，漏一条就等于泄漏。
 *
 * ## 「offset 去重」与「seen 表」不是一件事
 *
 * `offset` 是**结构性**去重：告诉 Telegram「这条以前的我都收过了」，
 * 所以它天然不会重复投递，且重启也不丢。`seen` 表只是兜底——
 * 游标回退、状态文件被删、或崩在「已推进 offset」之后才会用到。
 * 把 `seen` 当主去重就是走上「表越用越大、最后开始误判」的老路。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const TELEGRAM_SERVICE_KEY = 'ondra-adapter-telegram'

/** 通道 id。日志命名空间 `channel.telegram`，凭据 `user/channels/telegram.json`。 */
export const CHANNEL_ID = 'telegram'

/** 中文名。 */
export const CHANNEL_LABEL = 'Telegram'

/** 名字合规正则（服务键 / 通道 id / 配置键共用）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 单条上限（字符）。master-plan §9.11 实测值：`telegram 4000`。 */
export const CHUNK_MAX = 4_000

/** 单条上限的配置下界：100。再低会把一句话拆成四条。 */
export const CHUNK_MIN = 100

/** 长轮询超时（秒）。master-plan §9.11 原话 `timeout 50`。 */
export const POLL_TIMEOUT_SEC = 50

/** 长轮询超时的配置下界（秒）：1。 */
export const POLL_TIMEOUT_FLOOR = 1

/** 长轮询超时的配置上界（秒）：50。Telegram 官方上限就是 50，往上调没有意义。 */
export const POLL_TIMEOUT_CEIL = 50

/**
 * 失败退避（毫秒）。master-plan §9.11 原话「失败 3s 退避」——**固定值，不做指数**。
 *
 * 理由：长轮询本身已经是一个 50 秒的「慢循环」，失败时的 3 秒只是
 * 「别把对方打爆」的礼貌间隔。做成指数退避会让一次网络抖动之后
 * 通道安静几分钟，而用户看到的是「她突然不理我了」。
 */
export const BACKOFF_MS = 3_000

/** 退避的配置下界（毫秒）：1 秒。 */
export const BACKOFF_FLOOR = 1_000

/** 退避的配置上界（毫秒）：60 秒。 */
export const BACKOFF_CEIL = 60_000

/** 默认接口基址（Bot API 公开文档；仓内无副本，见 README）。 */
export const DEFAULT_API_BASE = 'https://api.telegram.org'

/** 凭据文件名后缀。 */
export const CREDENTIAL_FILE_SUFFIX = '.json'

/** 状态文件名后缀。 */
export const STATE_FILE_SUFFIX = '.state.json'

/** 一次 `getUpdates` 最多要几条（Bot API 上限 100）。 */
export const UPDATE_LIMIT = 100

/**
 * 请求超时的「附加余量」（毫秒）：15 秒。
 *
 * 长轮询的请求会**故意挂住 `pollTimeoutSec` 秒**。若 HTTP 超时小于它，
 * 每一轮都会以 `timeout` 结束——面板上看到的是「通道一直失败」，
 * 而真实原因是「我们比他先放弃」。所以实际请求超时 = 轮询超时 + 这个余量，
 * 由 `requestTimeoutOf()` 一处算出，**不许两处各算一次**。
 */
export const REQUEST_PADDING_MS = 15_000

/** 空转护栏（毫秒）：1 秒。
 *
 * 正常的长轮询「空批」也要挂住几十秒才回来。如果它 200ms 就返回空数组，
 * 说明服务端没遵守 `timeout`（或中间有代理提前收尾），此时立刻再发一轮
 * 就是**每秒几次的空转**——会把自己打成 429。所以「空批且耗时不正常」时
 * 强制等这个时长。
 */
export const SPIN_GUARD_MS = 1_000

/** `seen` 表容量上限（兜底用，不是账本）。 */
export const SEEN_LIMIT = 500

/** `seen` 条目存活时长（毫秒）：24 小时。游标早飞过去了，留更久没有意义。 */
export const SEEN_TTL_MS = 86_400_000

/* ------------------------------------------------------------------ *
 * 凭据
 * ------------------------------------------------------------------ */

/**
 * 凭据。**只有 token 一样东西，且只在文件里**（master-plan §6 禁令 6：密钥不写配置）。
 *
 * 形如 `123456789:AAH…`（`<bot_id>:<35 字符>`）。它既能收也能发，
 * 拿到就等于拿到这个机器人，所以一律 0600、永不进日志、永不进错误信息。
 */
export interface TelegramCredentials {
  /** Bot API token。 */
  readonly token: string
  /** 机器人用户名（可空，仅用于日志；`getMe` 会补上）。 */
  readonly username: string
}

/** 凭据缺失的原因。 */
export type CredentialMissing = 'file' | 'json' | 'shape' | 'token'

/** 凭据读取结果。 */
export interface CredentialLoad {
  /** token 是否到位。 */
  readonly ok: boolean
  /** 读到时的值。 */
  readonly value?: TelegramCredentials
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

/** 会话类型。Telegram 把群都归成 `group` / `supergroup`，本项目只分私聊与群。 */
export type ConversationKind = 'private' | 'group'

/** 一条来信（已解析，字段名按本项目的命名）。 */
export interface InboundMessage {
  /** Telegram 的 `update_id`（去重与 offset 的依据）。 */
  readonly updateId: number
  /** 会话 id（`chat.id`，可能是负数：群 id 是负的）。 */
  readonly chatId: number
  /** 私聊还是群。 */
  readonly kind: ConversationKind
  /** 发信人 id。 */
  readonly senderId: string
  /** 发信人用户名（可空；只进日志）。 */
  readonly senderUsername: string
  /** 正文。 */
  readonly text: string
  /** 是否 @ 了机器人（群里看 `entities` 里的 `mention` / `bot_command`）。 */
  readonly mentioned: boolean
  /** 平台消息 id。 */
  readonly messageId: number
  /** 消息时刻（毫秒）。 */
  readonly createdAt: number
}

/** 拉一轮的原因码（闭集）。 */
export type PollReason =
  | 'ok'
  | 'disabled'
  | 'no-credentials'
  | 'no-transport'
  | 'busy'
  | 'timeout'
  | 'aborted'
  | 'unauthorized'
  | 'conflict'
  | 'http'

/** 拉一轮的结果。 */
export interface PollOutcome {
  /** 是否成功（空批也算成功）。 */
  readonly ok: boolean
  /** 原因。 */
  readonly reason: PollReason
  /** 这一批拿到几条。 */
  readonly fetched: number
  /** 这一批答了几条。 */
  readonly answered: number
  /** 推进后的 offset（没推进就是原值）。 */
  readonly offset: number
  /** 这一轮耗时（毫秒）：防空转护栏要用。 */
  readonly elapsedMs: number
  /** 一句中文说明（不含 token）。 */
  readonly detail?: string
}

/** 发送结果原因（闭集）。 */
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
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'

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
  /** 平台错误码（`error_code`）。 */
  readonly errcode?: number
  /** 平台错误说明（只进日志，不回给用户）。 */
  readonly errmsg?: string
}

/* ------------------------------------------------------------------ *
 * 传输
 * ------------------------------------------------------------------ */

/** `getUpdates` 请求。 */
export interface UpdatesRequest {
  /** 从这里开始取（`update_id`，即 `上次最大 + 1`）。 */
  readonly offset: number
  /** 长轮询超时（秒）。 */
  readonly timeoutSec: number
  /** 一次最多几条。 */
  readonly limit: number
  /** 取消信号（卸载时中止在飞的长轮询）。 */
  readonly signal?: AbortSignal
}

/** `getUpdates` 的一条（只声明本项目用到的字段）。 */
export interface UpdateView {
  /** `update_id`。 */
  readonly updateId: number
  /** 原始 JSON（解析交给 `wire.ts`）。 */
  readonly raw: Record<string, unknown>
}

/** `getUpdates` 结果。 */
export interface UpdatesResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** 这一批。 */
  readonly updates: readonly UpdateView[]
  /** 失败原因。 */
  readonly reason?: SendReason
  /** 平台错误码。 */
  readonly errcode?: number
  /** 平台错误说明（**已脱敏**）。 */
  readonly errmsg?: string
}

/** 一条文本消息。 */
export interface PushRequest {
  /** 发到哪个会话（`chat.id`）。 */
  readonly chatId: number
  /** 正文（已切好，不超过 `chunkMax`）。 */
  readonly text: string
}

/** 一次发送的响应。 */
export interface PushResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** 平台错误码。 */
  readonly errcode?: number
  /** 平台错误说明（**已脱敏**）。 */
  readonly errmsg?: string
  /** 失败归类（非平台码的那一类）。 */
  readonly reason?: SendReason
}

/** `getMe` 结果：用来确认 token 到底有效没效。 */
export interface MeResult {
  /** 是否成功。 */
  readonly ok: boolean
  /** 机器人 id。 */
  readonly id?: number
  /** 机器人用户名（不带 `@`）。 */
  readonly username?: string
  /** 失败原因。 */
  readonly reason?: SendReason
  /** 平台错误码。 */
  readonly errcode?: number
  /** 一句中文说明（**已脱敏**）。 */
  readonly errmsg?: string
}

/**
 * 网络端口。**三个方法各一个用途**，都在 `transport.ts` 里统一拼 URL，
 * 这样「token 只在 URL 里」这件事只在一处发生、也只在一处被脱敏。
 */
export interface TelegramPush {
  /** 实现标识（日志用）。 */
  readonly id: string
  /** 拉一批。 */
  getUpdates(request: UpdatesRequest): Promise<UpdatesResult>
  /** 发一条文本。 */
  sendMessage(request: PushRequest): Promise<PushResult>
  /** 确认 token。 */
  getMe(): Promise<MeResult>
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
  /** 轮询循环是否在跑。 */
  readonly running: boolean
  /** 通道 id。 */
  readonly channelId: string
  /** 凭据是否齐。 */
  readonly credential: { readonly ok: boolean; readonly missing?: CredentialMissing }
  /** 机器人用户名（`getMe` 探过一次才有）。 */
  readonly botUsername: string | null
  /** 当前 offset（下一条要取的 `update_id`）。 */
  readonly offset: number
  /** 白名单人数（0 = 不限）。 */
  readonly allowlist: number
  /** 正在回答的会话数。 */
  readonly inflight: number
  /** 排队中的条数。 */
  readonly queued: number
  /** 最后一次成功拉取的时刻（毫秒；0 = 还没成功过）。 */
  readonly lastPollAt: number
  /** 最近一次错误（中文，不含正文与 token）。 */
  readonly lastError: string | null
}

/** 计数。 */
export interface AdapterStats {
  /** 拉了几轮。 */
  readonly polls: number
  /** 收到几条更新。 */
  readonly updates: number
  /** 答了几条。 */
  readonly answered: number
  /** 已发出的段数。 */
  readonly sent: number
  /** 按原因分桶的忽略/拒绝数。 */
  readonly rejected: Readonly<Record<string, number>>
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

/** 本插件对外提供的服务。 */
export interface TelegramService {
  /** 现在能不能收（开关开着 + 凭据齐 + 循环在跑）。 */
  readonly available: boolean
  /** 不能收的原因。 */
  readonly reason?: PollReason
  /** 开始长轮询（重复调用无副作用）。 */
  start(): void
  /** 停止长轮询（中止在飞的那一轮，不留定时器）。 */
  stop(): void
  /** 手动拉一轮（排查用；与循环共用同一把「正在拉」的锁）。 */
  pollOnce(at?: number): Promise<PollOutcome>
  /** 主动发一条。 */
  reply(conversationId: string, text: string): Promise<SendOutcome>
  /** 确认 token（调 `getMe`；只读，不改状态）。 */
  probe(): Promise<MeResult>
  /** 通道现状。 */
  status(): AdapterStatus
  /** 计数。 */
  stats(): AdapterStats
  /** 心跳（清理过期兜底记录 + 按节流落盘 + 上报探针）。 */
  tick(at?: number): void
  /** 立刻落盘。 */
  flush(): void
  /** 重读凭据（换文件后调用；会顺带停一次循环，由调用方决定要不要再 `start()`）。 */
  reload(): CredentialLoad
  /** 换网络实现（注入测试桩或企业内网关时用）。 */
  setPush(push: TelegramPush | null): void
}
