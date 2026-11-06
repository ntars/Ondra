/**
 * O-056 `ondra-channel-kit` 的对外契约。
 *
 * 定位：**通道公共段的三件纯函数级能力**——
 * 问人格（`callPersona`）、按平台上限切条（`chunk`）、每通道一份对端历史（`history`）。
 *
 * ## 四条边界，写在这里是因为它们决定了整个形状
 *
 * 1. **不落盘。** 通道消息**不进主会话**（master-plan §16.2-4：
 *    「跨渠道串味会毁人格连续性」）。所以对端历史是内存缓冲，
 *    上限 12 条，实例归适配器；本插件**本体一个实例都不持有**。
 *
 * 2. **不限流、不重试。** 各平台语义不同（手册 §9.11：telegram 4000 字一条、
 *    discord 停重连码 4004、dingtalk 要先回 empty 再异步）。公共段一旦限流，
 *    就会出现「Telegram 被 QQ 的阈值卡住」这种没法解释的现象。
 *
 * 3. **不自己拼提示词。** 人格四段由对话链在 `begin()` 时拼进**冻结前缀**
 *    （手册 §8.5）。本插件再拼一次，就会有两个人格通路，且第二遍还会
 *    把冻结前缀挤动一位——命中率在一个没人注意的路径上掉下去。
 *
 * 4. **不持状态。** 队列、历史、游标全在调用方。`history()` 每次都造新的，
 *    刻意**不按通道 id 缓存**：缓存会让「关掉通道」不释放内存，
 *    也会让两个适配器不小心共用一份历史——那正是串味的来源。
 *
 * ## 为什么 `chunk` 的 `max` 必须由调用方给
 *
 * 手册 §9.11 的九个上限（4000/1900/4000/4000/2000/800/800/1200/1000）
 * 是各通道的属性，真源在适配器自己的 `Config`。这里给个「默认 4000」
 * 看着方便，实际是把微信的 800 撑到 4000，症状是消息被平台静默截断。
 * 所以：**没有默认值**，不给上限就不切。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4 的 `^[a-z][a-z0-9_-]{1,63}$`）。 */
export const CHANNEL_KIT_SERVICE_KEY = 'ondra-channel-kit'

/** 名字合规正则：服务键、工具名、配置键共用。**带冒号会被模型侧直接拒绝**。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 对端历史上限，**12 条**（手册 §9.11 / master-plan §16.2-4）。
 *
 * 是**总条数**，不是「两边各 12」。按角色分就变成 24 条，与手册写的 12 不符，
 * 而且「刚才在聊什么」只需要最近十几条，多留只会让上下文变脏。
 */
export const PEER_HISTORY_LIMIT = 12

/**
 * 单条对端消息的最大长度。
 *
 * 手册没给。取 4000 的理由：qq-official 单条上限 1200、telegram 4000，
 * 再长就已经不是「刚才那句话」而是「一整篇」，留在历史里只会挤掉别的。
 * 超了**截断并计数**，不静默吞掉整条。
 */
export const PEER_TEXT_MAX = 4000

/* ------------------------------------------------------------------ *
 * 会话 id 归一化
 * ------------------------------------------------------------------ */

/**
 * 算一个 8 位十六进制的短指纹（djb2）。
 *
 * 用途只有一个：当会话 id 被「洗净」得看不出原样时，用它保住**区分度**。
 * 不这样做的话，`中文群` 与空串会双双变成 `chat`，两个互不相干的会话
 * 就共用了一份历史——而症状是「她在 A 群说的话，在 B 群接得上」。
 * @param text 原文。
 */
function tagOf(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0').slice(0, 8)
}

/**
 * 把任意字符串压成合法的会话 id。
 *
 * 为什么要这一步：对话链要求会话 id 匹配 `NAME_RE`
 * （`begin({id})` 的注释原话）。而通道 id 常带 `:` `.` `@`
 * （`tg:123456`、`group@chat`）。直接塞进去的后果不是报错，是
 * **那条消息没有会话可用**——表现为「用户发了消息，她永远不回」。
 *
 * 规则：小写 → 非法字符换 `-` → 合并连续 `-` → 去首尾 `-`。
 *
 * - 本来就是干净的（只差大小写）→ 原样用，可读；
 * - 被洗过（含非法字符、空、太短）→ 加 `ch-` 前缀并**附一个指纹**。
 *
 * 指纹不是装饰：没有它，`tg:1` 与 `tg.1` 会双双变成 `tg-1`，
 * 两个会话共用一份历史。宁可 id 难看一点，也不能让两个人串味。
 * @param raw 原始标识（通道 id 与对端 id 拼起来也行）。
 */
export function toConversationId(raw: string): string {
  const text = String(raw)
  const lowered = text.toLowerCase()
  const cleaned = lowered
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  if (cleaned === lowered && NAME_RE.test(cleaned)) return cleaned

  const base = cleaned === '' ? '' : `-${cleaned}`
  return `ch${base}-${tagOf(text)}`.slice(0, 64)
}

/* ------------------------------------------------------------------ *
 * 对端历史
 * ------------------------------------------------------------------ */

/** 一条消息是谁说的。 */
export type PeerRole =
  /** 对端（用户在通道里说的话）。 */
  | 'peer'
  /** 她自己（已经发出去的那句）。 */
  | 'self'

/** 一条对端历史。 */
export interface PeerEntry {
  readonly role: PeerRole
  /** 正文。 */
  readonly text: string
  /** 时刻（毫秒）。 */
  readonly at: number
}

/** 入队结果。 */
export interface PushOutcome {
  /** 是否收下了。空正文会被拒（`false`）。 */
  readonly accepted: boolean
  /** 收下之后的条数。 */
  readonly size: number
  /** 是否挤掉了最旧的那条。 */
  readonly evicted: boolean
  /** 正文是否被截断（超过 `PEER_TEXT_MAX`）。 */
  readonly truncated: boolean
}

/** 对端历史统计。 */
export interface PeerHistoryStats {
  /** 上限。 */
  readonly capacity: number
  /** 当前条数。 */
  readonly size: number
  /** 累计收下条数。 */
  readonly pushed: number
  /** 累计挤掉条数。 */
  readonly evicted: number
  /** 累计拒收条数（空正文）。 */
  readonly rejected: number
}

/** 一份对端历史。**实例归调用方**，本插件不持有。 */
export interface PeerHistory {
  /** 上限。 */
  readonly capacity: number
  /** 当前条数。 */
  readonly size: number
  /**
   * 收一条。满了挤掉最旧的（**不拒绝新的**）。
   * 理由：通道场景里「最新那句话」永远比「十二条之前那句」重要。
   */
  push(entry: PeerEntry): PushOutcome
  /** 只读全部（从旧到新）。 */
  all(): readonly PeerEntry[]
  /** 清空。 */
  clear(): void
  /** 统计快照。 */
  stats(): PeerHistoryStats
  /**
   * 转成对话链能吃的历史形状（`{role:'user'|'assistant', content}`）。
   *
   * 给的是**拷贝**，改它不影响缓冲。`peer → user`、`self → assistant`，
   * 因为对话链只认这两个角色；要不要把自己说过的话也带上由 `includeSelf` 决定
   * （默认带：不带的话，她会以为上一句不是自己说的）。
   */
  messages(options?: {
    readonly includeSelf?: boolean
  }): readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
}

/* ------------------------------------------------------------------ *
 * 切条
 * ------------------------------------------------------------------ */

/** 一次切条的结果。 */
export interface ChunkResult {
  /** 切出来的片，**按序拼回等于原文**。 */
  readonly pieces: readonly string[]
  /** 原文长度。 */
  readonly chars: number
  /** 本次用的上限。 */
  readonly max: number
  /** 硬切次数（找不到任何标点/空格才硬切）。 */
  readonly hardBreaks: number
  /** 最长那一片的长度。 */
  readonly longest: number
}

/* ------------------------------------------------------------------ *
 * 问人格
 * ------------------------------------------------------------------ */

/**
 * 失败原因，**六值闭集**。
 *
 * 每个码对应一个不同的处置：`no-dialogue` 要去装对话链；
 * `timeout` 要看看模型是不是卡住；`empty` 要看看是不是被过滤器清空了。
 */
export const CALL_FAILURES = ['disabled', 'no-dialogue', 'timeout', 'aborted', 'empty', 'error'] as const

/** 一种失败原因。 */
export type CallFailure = (typeof CALL_FAILURES)[number]

/** 失败原因的中文说法。**只给日志与面板**。 */
export const FAILURE_ZH: Readonly<Record<CallFailure, string>> = Object.freeze({
  disabled: '公共段已关闭',
  'no-dialogue': '没有对话链：这一条没法变成回复',
  timeout: '等太久了，这一轮已中止',
  aborted: '被取消',
  empty: '她这一轮没说出话（被过滤或模型返回空）',
  error: '对话链报错',
})

/** 问一次人格的入参。 */
export interface CallInput {
  /** 会话 id（同一个对端稳定同一个）。**会经 `toConversationId` 归一化**。 */
  readonly conversationId: string
  /** 用户这一轮的正文。空串合法（只发了一张图）。 */
  readonly text: string
  /** 平台单条上限。给了才切条；不给就整段返回。 */
  readonly maxChars?: number
  /** 超时（毫秒）。省略用配置值。 */
  readonly timeoutMs?: number
  /** 取消信号。 */
  readonly signal?: AbortSignal
}

/** 问一次的结果。 */
export interface CallResult {
  /** 这一轮是否拿到了可以发出去的正文。 */
  readonly ok: boolean
  /**
   * 正文。
   *
   * `ok=false` 时**也可能非空**（超时前已经吐了半句）。刻意保留：
   * 调用方要日志、要对拍、要在某些通道说「我刚才说到一半」都用得上。
   * **但默认不要发半句**——半句话比没话更糟。
   */
  readonly text: string
  /** 正文长度。 */
  readonly chars: number
  /** 切好的片（没给 `maxChars` 时是整段一片；空正文时是空数组）。 */
  readonly pieces: readonly string[]
  /** 失败原因；成功时不带。 */
  readonly failure?: CallFailure
  /** 正文是否不完整（超时/取消/触到输出上限）。 */
  readonly partial: boolean
  /** 一句中文说明。 */
  readonly reason?: string
}

/** 服务不可用的原因。 */
export type KitUnavailableReason = 'disabled'

/** 对外服务。 */
export interface ChannelKitService {
  /** 是否启用（配置开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: KitUnavailableReason
  /** 对端历史上限（恒为 12，供面板展示）。 */
  readonly peerHistoryLimit: number

  /** 造一份对端历史。**每次都造新的**（见文件头的「不持状态」）。 */
  history(options?: { readonly capacity?: number }): PeerHistory

  /** 按平台上限切条。**纯函数**，不改任何状态。 */
  chunk(text: string, max: number): ChunkResult

  /** 问一次人格（走对话链）。**永不抛出**——失败都折成 `CallResult`。 */
  callPersona(input: CallInput): Promise<CallResult>
}

/* ------------------------------------------------------------------ *
 * 以下是外部形状的结构对位。只声明本插件用到的成员。
 * ------------------------------------------------------------------ */

/** 日志门面的最小形状（Cordis Logger 的结构对位子集）。 */
export interface LogLike {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  debug?(message: string, ...args: unknown[]): void
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/**
 * 对话帧的结构对位。
 *
 * 刻意写成**一个宽接口**而不是判别联合：上游五帧，这里只用三种。
 * 写成联合就必须把五种全抄一遍，而抄的那两种一旦上游改字段，
 * 本插件会在一个跟自己无关的地方编译报错。
 * 代价是失去类型收窄，所以取值处必须 `typeof === 'string'` 显式判定。
 */
export interface DialogueFrameLike {
  readonly type: string
  readonly delta?: string
  readonly text?: string
  readonly stopReason?: string
}

/** O-033 对话链的结构对位（只用到开会话、跑一轮、取消）。 */
export interface DialogueLike {
  readonly available: boolean
  begin(input?: { readonly id?: string }): { readonly id: string }
  turn(input: {
    readonly text: string
    readonly conversationId?: string
    readonly signal?: AbortSignal
  }): AsyncIterable<DialogueFrameLike>
  abort(conversationId?: string): boolean
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

/** O-005 配置真源的结构对位（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    id: string,
    layers: { readonly user?: Readonly<Record<string, unknown>> },
  ): ResolvedSectionLike | undefined
}
