/**
 * O-127 `ondra-asr` 的对外契约（手册 §1.5 / 语料·第一编 2.3，〔复〕复用档）。
 *
 * ## 手册给的原话
 *
 * ```
 * | O-127 | `ondra-asr` | 语音转写（时间戳 + 说话人分离），本地 whisper 优先云端兜底 |
 * 关键参数：失败静默；转写文本按普通记忆入库
 * ```
 *
 * 三件事，三种落实：
 * 1. **时间戳** —— 做，而且换成一个统一单位（毫秒整数）；
 * 2. **说话人分离** —— **做不了，也不假装做**（见下）；
 * 3. **本地优先、云端兜底** —— 做，且兜底要能关。
 *
 * ## 说话人分离这一条，必须说清楚
 *
 * whisper.cpp 与 OpenAI 的 `whisper-1` **都不做说话人分离**（diarization）。
 * 真正做的是 pyannote / NeMo 那一类，要额外的模型与流水线，本轮既不能装依赖，
 * 也不属于「接线」范畴。
 *
 * 所以本包的处理是：`TranscriptSpan.speaker` 字段**留着**（契约需要一个位置），
 * 但**没有就不填**，`diarized` 恒为 `false`。绝不写 `speaker-1` / `speaker-2`——
 * 那是编的，而「谁说的」在陪伴场景里比「说了什么」更容易伤人：把用户的话记成
 * 她说的话，是归属错误（手册 §2.2「归属错误比记不住更伤信任」）。
 *
 * 也**不做 `diarize` 开关**：一个拨了没用的开关就是 §17-6 说的假开关。
 *
 * ## 多模态契约的归属（§15.3）
 *
 * `MultimodalDraft` / `Modality` / `TranscriptSpan` 的**真源在 O-126
 * `ondra-vision/src/types.ts`**（本轮它是先做方）。本文件是**结构对位镜像**：
 * 字段名、类型、语义必须逐字一致，但**不 import**（§15.5：同轮两个插件不许互相
 * import，任一单独卸载都不该让另一个编译失败）。
 *
 * 一旦 O-126 改了字段，这里必须跟着改——这是镜像的代价，写在这里以免下一个人
 * 以为是两套契约。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。全仓唯一归属。 */
export const ASR_SERVICE_KEY = 'ondra-asr'

/** 服务键 / 工具名 / 配置键的硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 两种来源。手册：「本地 whisper 优先云端兜底」。 */
export type AsrProvider = 'local' | 'cloud'

/** 两种来源的固定顺序（界面按此渲染，不许各插件自己排）。 */
export const ASR_PROVIDERS: readonly AsrProvider[] = Object.freeze(['local', 'cloud'])

/**
 * 结果码。**一个码只对应一种处境**（同一纪律见 O-076 的 `DeclareCode`）。
 *
 * 把 `no-binary` 与 `no-model` 分开，是因为修法不同：前者是「装个 whisper」，
 * 后者是「告诉我模型文件在哪」。合成一个 `local-unavailable`，用户只能猜。
 */
export type AsrReason =
  /** 转写成功。 */
  | 'ok'
  /** 配置里关着。 */
  | 'disabled'
  /** 调用方没给文件路径。 */
  | 'no-file'
  /** 路径给了，文件不在（或不是普通文件）。 */
  | 'missing'
  /** 超过 `max-audio-bytes`。 */
  | 'too-large'
  /** 不是本包认识的音频（按**魔数**判，不按扩展名）。 */
  | 'bad-audio'
  /** 找不到 whisper 可执行文件（按 PATH 找）。 */
  | 'no-binary'
  /** 没配模型文件路径（whisper 必须有 `-m`）。 */
  | 'no-model'
  /** 云端接入点地址写坏。 */
  | 'bad-base'
  /** 运行时没有 `fetch`，或没有 `FormData` / `Blob`。 */
  | 'no-transport'
  /** 云端要密钥，但解析不到。 */
  | 'no-credential'
  /** O-076 判了 `deny`。 */
  | 'egress-denied'
  /** O-076 判了 `ask`：这一次不发，等用户点头。 */
  | 'egress-consent'
  /** 连不上 / DNS / 证书。 */
  | 'network'
  /** 超时。 */
  | 'timeout'
  /** HTTP 非 2xx。 */
  | 'http'
  /** 响应不是预期形状，或 whisper 写的 JSON 读不出来。 */
  | 'payload'
  /** 跑通了但一个字都没有（静音、纯噪音、模型认为没人说话）。 */
  | 'empty'
  /** 服务已经卸载（调用方还握着旧引用）。 */
  | 'disposed'

/** 全部结果码（枚举闭合自检用：本表与联合类型必须逐项对应）。 */
export const ASR_REASONS: readonly AsrReason[] = Object.freeze([
  'ok',
  'disabled',
  'no-file',
  'missing',
  'too-large',
  'bad-audio',
  'no-binary',
  'no-model',
  'bad-base',
  'no-transport',
  'no-credential',
  'egress-denied',
  'egress-consent',
  'network',
  'timeout',
  'http',
  'payload',
  'empty',
  'disposed',
])

/** 多模态种类（镜像 O-126；本包只会产出 `audio`）。 */
export type Modality = 'image' | 'audio' | 'video'

/** 全部种类（镜像 O-126，枚举闭合自检用）。 */
export const MODALITIES: readonly Modality[] = Object.freeze(['image', 'audio', 'video'])

/**
 * 一段带时间戳的文本（镜像 O-126，字段名与语义逐字一致）。
 *
 * 时间单位是**毫秒整数**：whisper.cpp 的 `offsets` 是毫秒，OpenAI 的
 * `verbose_json` 给的是秒（浮点）。两者都换算成毫秒再进来。
 */
export interface TranscriptSpan {
  /** 起点，毫秒。 */
  readonly startMs: number
  /** 终点，毫秒。 */
  readonly endMs: number
  /** 这段的字。 */
  readonly text: string
  /** 说话人标签；模型不给就缺省（**绝不编 `speaker-1`**）。 */
  readonly speaker?: string
}

/** 检测框（镜像 O-126；本包不产出，只为让镜像完整、让 O-128 能写一份类型）。 */
export interface DetectionBox {
  readonly label: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly confidence?: number
}

/**
 * 交给 O-128 `ondra-multimodal-memory` 的**入库草稿**（镜像 O-126，真源在那边）。
 *
 * 本包产出的 `modality` 恒为 `audio`；`boxes` 恒缺省；`frames` 恒缺省。
 */
export interface MultimodalDraft {
  readonly modality: Modality
  readonly sourcePath: string
  readonly text: string
  readonly title: string
  readonly at: number
  readonly provider: string
  readonly model?: string
  readonly chars: number
  readonly truncated: boolean
  /** 指纹：`fnv1a64(modality + '\0' + sourcePath + '\0' + text)`，16 位十六进制。 */
  readonly fingerprint: string
  readonly spans?: readonly TranscriptSpan[]
  readonly boxes?: readonly DetectionBox[]
  readonly frames?: readonly string[]
  readonly degraded?: string
}

/** 一次转写请求。 */
export interface TranscribeInput {
  /** 音频文件绝对路径。本包只读，不搬、不改、不删。 */
  readonly path: string
  /** 语言提示（ISO-639-1，例如 `zh`）；省略用配置，配置也空就是自动检测。 */
  readonly language?: string
  /** 取消信号（可选）。 */
  readonly signal?: AbortSignal
}

/** 一次转写的结果。**永不抛错**。 */
export interface TranscribeResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 结果码。成功为 `ok`。 */
  readonly reason: AsrReason
  /** 正文；失败为空串（**绝不填占位**，占位会被当成用户说的话入库）。 */
  readonly text: string
  /** 时间戳；模型不给时间就空数组。 */
  readonly spans: readonly TranscriptSpan[]
  /** 检测到的语言（模型报的）。 */
  readonly language?: string
  /** 实际服务的来源。 */
  readonly provider: AsrProvider
  /** 实际用的模型（本地是模型文件名，云端是模型 id）。 */
  readonly model?: string
  /** 正文字数。 */
  readonly chars: number
  /** 有没有被 `max-chars` 截断。 */
  readonly truncated: boolean
  /**
   * 有没有说话人标签。
   *
   * **本仓当前恒为 `false`**：whisper.cpp 与 `whisper-1` 都不做说话人分离。
   * 字段留着，是为了让下游不必在「将来支持了」时改判断；而不是为了让谁把它读成 `true`。
   */
  readonly diarized: boolean
  /** 试过哪几条路（`local:no-binary` / `cloud:http`），失败时给排查用。 */
  readonly tried: readonly string[]
  readonly elapsedMs: number
  /** 一句补充说明。 */
  readonly detail?: string
  /** 入库草稿；`ok=false` 时缺省。 */
  readonly draft?: MultimodalDraft
}

/** 运行计数（**只在内存**，进程重启归零）。 */
export interface AsrStats {
  /** 转写请求次数（含兜底那一次，一次请求可能记两条 `tried`）。 */
  readonly requests: number
  readonly ok: number
  readonly failures: number
  /** 走了云端兜底的次数。 */
  readonly fallbacks: number
  /** 被出站裁决拦下的次数。 */
  readonly egressBlocked: number
  /** 最后一次成功时刻，0 表示从未成功。 */
  readonly lastOkAt: number
  /** 最后一次失败的原因码。 */
  readonly lastError?: AsrReason
  /** 按原因码分类的计数（只统计出现过的）。 */
  readonly byReason: Readonly<Record<string, number>>
}

/** 语音转写服务。 */
export interface AsrService {
  /** 服务本身能不能工作：开关 + 至少一条可用来源。 */
  readonly available: boolean
  /** 不能工作的原因（`available=true` 时缺省）。 */
  readonly reason?: AsrReason
  /** 当前首选的来源（面板要能读到，不许黑箱切换）。 */
  readonly provider: AsrProvider
  /** 本地 whisper 是否就绪（二进制与模型文件都在）。 */
  readonly localReady: boolean
  /** 云端是否配置齐全（地址 + 模型 + 凭据）。 */
  readonly cloudReady: boolean

  /** 转写一段音频。 */
  transcribe(input: TranscribeInput): Promise<TranscribeResult>
  /** 运行计数。 */
  stats(): AsrStats
  /** 清掉本包起过的子进程（幂等）。 */
  dispose(): void
}

/** 一次 HTTP 响应的结构对位子集（`fetch` 的返回满足它）。 */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/**
 * 网络出口。**唯一替换点**。
 *
 * `body` 是 `unknown` 而不是 `string`：云端转写要发 `multipart/form-data`，
 * 那是 `FormData` 对象，不是字符串。用 `string` 会逼调用方自己拼 multipart
 * （手工拼二进制边界是另一类容易错且难查的活）。
 */
export type FetchLike = (
  url: string,
  init: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: unknown
    readonly signal?: AbortSignal
  },
) => Promise<FetchResponseLike>

/** 时间服务的结构对位子集。 */
export interface ClockLike {
  now(): number
}

/** 日志器的结构对位子集。 */
export interface LogLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** 字段声明（与 O-005 对位）。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-001 身份服务的结构对位子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-002 路径服务的结构对位子集（只用到临时目录）。 */
export interface PathLayoutLike {
  area(area: 'tmp'): string
  ensure(area: 'tmp', ...segments: string[]): string
}

/** O-076 的一条出站声明（结构对位）。 */
export interface EgressSpecLike {
  readonly id: string
  readonly owner: string
  readonly title: string
  readonly hosts: readonly string[]
  readonly payload: 'text' | 'image' | 'audio' | 'file' | 'metadata'
  readonly credentialRef?: string
  readonly localOnly: boolean
  readonly reason: string
  readonly source: string
}

/** O-076 的一次出站裁决结果（结构对位）。 */
export interface EgressVerdictLike {
  readonly ok: boolean
  readonly decision: 'allow' | 'ask' | 'deny'
  readonly tier: string
  readonly code: string
  readonly detail: string
  readonly hint?: string
  readonly consentKey: string
}

/** O-076 服务的结构对位子集。 */
export interface PrivacyLike {
  declare(spec: EgressSpecLike): { readonly ok: boolean; readonly code: string; readonly detail: string }
  undeclare(id: string): boolean
  evaluate(request: {
    readonly id: string
    readonly host: string
    readonly payload?: 'text' | 'image' | 'audio' | 'file' | 'metadata'
    readonly identity?: boolean
    readonly irreversible?: boolean
  }): EgressVerdictLike
}

/** 解析后的云端接入点。 */
export interface ResolvedEndpoint {
  /** 基础地址，**不含**末尾斜杠。 */
  readonly base: string
  /** 主机（含端口）。 */
  readonly host: string
}
