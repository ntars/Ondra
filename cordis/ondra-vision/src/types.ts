/**
 * O-126 `ondra-vision` 的对外契约（手册 §9.4 / 语料·第一编 2.3，〔复〕复用档）。
 *
 * ## 手册给的原话只有一句半
 *
 * ```
 * | O-126 | `ondra-vision` | 图片理解 / OCR / 物体定位 / 视频抽帧，provider 可插拔，默认关 |
 * ```
 *
 * 语料里补了落点：「走『可插拔 provider』（云端 OpenAI 兼容 / 本地 Ollama / 通义千问），
 * **默认关闭**，与 `ondra-privacy` 联动（出站前提示）」。
 *
 * 除此之外，手册**没有**给：模型名、图片尺寸上限、超时、提示词、方框坐标格式。
 * 这些本文件一律标成「工程取值」，并在 README 的「待裁决」里逐条列出来——
 * 把工程取值写成「手册规定」，下一个人就不敢改了。
 *
 * ## 为什么默认关
 *
 * 手册 §9.4 逐字要求：「vision 默认关闭，出站前提示」。理由不是保守，是**一张图
 * 出站就等于把用户的屏幕发给别人**：截图里可能有聊天记录、身份证、工资条。
 * 所以 `enable` 默认 `false`，且即便打开，每次出站仍要过 O-076 的裁决。
 *
 * ## 为什么这个包定义「多模态记忆条目」
 *
 * §15.3（契约先行）：本轮两个插件里 O-126 是**先做方**，而 O-128
 * `ondra-multimodal-memory` 要消费两者的产物。若让 O-128 自己发明字段，
 * 「图片→描述」与「语音→转写」会得到两张对不上的表。所以完整的
 * `MultimodalDraft` 在这里定义一次，O-127 结构对位消费（不 import，§15.5），
 * O-128 只按契约入库。
 *
 * ## 为什么不发工具，只发服务
 *
 * 上游工具面要求完整 schema 与执行契约，而手册没给这四个动作的参数
 * （手册只给了「图片理解 / OCR / 物体定位 / 视频抽帧」四个词组，不是四个函数签名）。
 * 凭空定一套参数，就是让模型照一份编出来的说明书调用，出错表现是「视觉不好用」。
 * 真正的调用方是代码：通道适配器收到一张图，先存盘、再问本包「这是什么」。
 * 这条推理与 O-143 同一套（见该包 README 第六节）。
 */

/** 本插件注册的服务键（连字符，符合手册 §8.4）。全仓唯一归属。 */
export const VISION_SERVICE_KEY = 'ondra-vision'

/** 服务键 / 工具名 / 配置键的硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 三家 provider（手册点名的三种，不多不少）。
 *
 * 三者在**协议层**只有两处差别：请求体的图片字段怎么放、以及默认地址。
 * 其余（超时、重试、结果整形、出站裁决）全部共用一份实现——按 §12.1
 * 「能融就融：把多种口径抽象成一个实现，参数化差异」。
 */
export type VisionProvider = 'ollama' | 'openai' | 'qwen'

/** 三家的固定顺序（界面按此渲染，不许各插件自己排）。 */
export const VISION_PROVIDERS: readonly VisionProvider[] = Object.freeze([
  'ollama',
  'openai',
  'qwen',
])

/** 一家的默认接入点。`host` 用于出站声明与日志，`base` 用于拼 URL。 */
export interface ProviderEndpoint {
  /** 主机（含端口）。出站白名单按它匹配。 */
  readonly host: string
  /** 基础地址，**不含**末尾斜杠。 */
  readonly base: string
  /** 是否本机（本机 = 不出站，可以不要 privacy 点头）。 */
  readonly local: boolean
  /** 默认凭据环境变量名；空串 = 这家不需要密钥。 */
  readonly credentialRef: string
}

/**
 * 三家默认接入点。**全部是真实存在的公开地址**，不是编的：
 * - Ollama 默认监听 `127.0.0.1:11434`（官方默认端口）；
 * - OpenAI 的 `api.openai.com/v1`；
 * - 通义千问的 OpenAI 兼容端点 `dashscope.aliyuncs.com/compatible-mode/v1`。
 *
 * 地址可被配置覆盖（自建网关、内网 Ollama），覆盖后出站白名单按覆盖后的主机算。
 */
export const PROVIDER_ENDPOINTS: Readonly<Record<VisionProvider, ProviderEndpoint>> = Object.freeze({
  ollama: Object.freeze({
    host: '127.0.0.1:11434',
    base: 'http://127.0.0.1:11434',
    local: true,
    credentialRef: '',
  }),
  openai: Object.freeze({
    host: 'api.openai.com',
    base: 'https://api.openai.com/v1',
    local: false,
    credentialRef: 'OPENAI_API_KEY',
  }),
  qwen: Object.freeze({
    host: 'dashscope.aliyuncs.com',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    local: false,
    credentialRef: 'DASHSCOPE_API_KEY',
  }),
})

/**
 * 结果码。**一个码只对应一种处境**（同一纪律见 O-076 的 `DeclareCode`）。
 *
 * 把 `disabled` 与 `no-model` 分开，是因为它们的修法完全不同：前者是「你关着」，
 * 后者是「你开着但没告诉我看哪个模型」。合成一个 `unavailable`，用户只能猜。
 */
export type VisionReason =
  /** 取到了。 */
  | 'ok'
  /** 配置里关着（默认就是这一条，手册 §9.4）。 */
  | 'disabled'
  /** 开着但没配模型。手册没给模型名，本包拒绝猜一个可能不存在的名字。 */
  | 'no-model'
  /** 调用方没给文件路径。 */
  | 'no-file'
  /** 路径给了，文件不在（或不是普通文件）。 */
  | 'missing'
  /** 超过 `max-image-bytes`。 */
  | 'too-large'
  /** 不是本包认识的图片（按**魔数**判，不按扩展名）。 */
  | 'bad-image'
  /** 接入点地址写坏（不是合法 URL / 协议不是 http(s)）。 */
  | 'bad-base'
  /** 运行时没有 `fetch`（宿主裁剪过运行时）。 */
  | 'no-transport'
  /** 云端要密钥，但解析不到（只认环境变量名，不认密钥值）。 */
  | 'no-credential'
  /** 服务已经卸载（调用方还握着旧引用）。 */
  | 'disposed'
  /** O-076 判了 `deny`。 */
  | 'egress-denied'
  /** O-076 判了 `ask`：这一次不发，等用户点头。 */
  | 'egress-consent'
  /** 连不上 / DNS / 证书。 */
  | 'network'
  /** 超时（整次请求）。 */
  | 'timeout'
  /** HTTP 非 2xx。 */
  | 'http'
  /** 响应不是预期形状（缺字段、正文不是 JSON、被截断）。 */
  | 'payload'
  /** 请求成功但正文是空的（模型拒答 / 只回了空白）。 */
  | 'empty'
  /** 定位请求没有给出任何可用方框（含「模型说不存在」）。 */
  | 'no-boxes'
  /** 找不到 ffmpeg（视频抽帧要它）。 */
  | 'no-ffmpeg'
  /** 定位的目标描述为空。 */
  | 'bad-target'

/** 全部结果码（枚举闭合自检用：本表与联合类型必须逐项对应）。 */
export const VISION_REASONS: readonly VisionReason[] = Object.freeze([
  'ok',
  'disabled',
  'no-model',
  'no-file',
  'missing',
  'too-large',
  'bad-image',
  'bad-base',
  'no-transport',
  'no-credential',
  'disposed',
  'egress-denied',
  'egress-consent',
  'network',
  'timeout',
  'http',
  'payload',
  'empty',
  'no-boxes',
  'no-ffmpeg',
  'bad-target',
])

/** 三个动作。`frames` 不在这张表里：它不调模型，只起 ffmpeg。 */
export type VisionAction = 'describe' | 'ocr' | 'locate'

/** 一次视觉请求的入参。 */
export interface VisionInput {
  /** 图片的绝对路径。本包只读文件，不搬、不改、不删。 */
  readonly path: string
  /** 取消信号（可选）。 */
  readonly signal?: AbortSignal
}

/** 定位请求的入参。 */
export interface LocateInput extends VisionInput {
  /** 要找什么，例如「红色的按钮」「猫」。必填，空串直接 `bad-target`。 */
  readonly target: string
}

/** 视频抽帧的入参。 */
export interface FramesInput {
  /** 视频文件的绝对路径。 */
  readonly path: string
  /** 要几帧；省略用配置里的 `videoFrames`（手册写的是 4）。 */
  readonly count?: number
  /** 取消信号（可选）。 */
  readonly signal?: AbortSignal
}

/** 图片尺寸。解析不出来时两个字段都缺省。 */
export interface ImageSize {
  readonly width: number
  readonly height: number
}

/**
 * 一个检测框。**坐标归一化到 0–1**，原点左上。
 *
 * 为什么不用像素：像素坐标离不开图片尺寸，而尺寸一旦被上层缩放过就对不上；
 * 归一化坐标是唯一一种「换了分辨率仍然成立」的写法。模型若回了像素值，
 * 本包会用真实尺寸换算；换算不了就整批拒收，**不猜**。
 */
export interface DetectionBox {
  /** 模型给的标签（原样保留，不翻译）。 */
  readonly label: string
  /** 左上角 x，0–1。 */
  readonly x: number
  /** 左上角 y，0–1。 */
  readonly y: number
  /** 宽，0–1。 */
  readonly w: number
  /** 高，0–1。 */
  readonly h: number
  /** 模型自报的置信度（0–1）。多数视觉模型不给，给了才带。 */
  readonly confidence?: number
}

/**
 * 一段带时间戳的文本（转写与字幕共用）。
 *
 * 时间单位是**毫秒整数**：whisper 的原生单位是 10ms 一格的 token 时间，
 * OpenAI 的 `verbose_json` 给的是秒（浮点）。两者都换算成毫秒再进来，
 * 免得下游每一处都要问「你这个 3.5 是秒还是 3.5 秒 = 3500 毫秒」。
 */
export interface TranscriptSpan {
  /** 起点，毫秒。 */
  readonly startMs: number
  /** 终点，毫秒。 */
  readonly endMs: number
  /** 这段的字。 */
  readonly text: string
  /** 说话人标签；模型不给就缺省（**不编 `speaker-1`**）。 */
  readonly speaker?: string
}

/** 多模态种类。手册：图片→描述；语音→转写；视频→4 帧 + 音轨。 */
export type Modality = 'image' | 'audio' | 'video'

/** 全部种类（枚举闭合自检用）。 */
export const MODALITIES: readonly Modality[] = Object.freeze(['image', 'audio', 'video'])

/**
 * 交给 O-128 `ondra-multimodal-memory` 的**入库草稿**。
 *
 * 这是本轮两个插件的**共享数据结构**，真源在这里（§15.3 契约先行）：
 * - O-127 在自己的 `types.ts` 里做**结构对位镜像**（不 import，§15.5）；
 * - O-128 只按这些字段名消费，不得另立一套。
 *
 * 刻意**不含** `importance` / `kind` / `pool`：那是记忆域自己的判断（O-010 / O-131），
 * 一个视觉插件没有资格替记忆域定「这条重不重要」。
 */
export interface MultimodalDraft {
  /** 种类。 */
  readonly modality: Modality
  /** 原始文件路径（谁给的、存在哪，原样带过去）。 */
  readonly sourcePath: string
  /** 正文：图片是描述，语音是转写。**这一条是入库的主体**。 */
  readonly text: string
  /** 一句话标题（≤40 字），给记忆列表用。 */
  readonly title: string
  /** 产出时刻。 */
  readonly at: number
  /** 谁产出的（provider id 或本地二进制名）。 */
  readonly provider: string
  /** 用的哪个模型；本地 whisper 这类没有模型名就缺省。 */
  readonly model?: string
  /** 正文字数（码位，不是字节）。 */
  readonly chars: number
  /** 正文有没有被 `max-output-chars` 截断。 */
  readonly truncated: boolean
  /**
   * 内容指纹：`fnv1a64(modality + '\0' + sourcePath + '\0' + text)` 的 16 位十六进制。
   *
   * 用途只有一个：O-128 去重。**不含时间**——同一张图描述两次得到同一个指纹，
   * 否则每描述一次就多一条记忆，而它们说的是同一件事。
   */
  readonly fingerprint: string
  /** 时间戳（语音/视频才有）。 */
  readonly spans?: readonly TranscriptSpan[]
  /** 检测框（定位才有）。 */
  readonly boxes?: readonly DetectionBox[]
  /** 抽出来的帧（视频才有），绝对路径。 */
  readonly frames?: readonly string[]
  /** 降级说明：有值就表示「这条能用，但比正常路径少点什么」。 */
  readonly degraded?: string
}

/** 一次文本类动作（describe / ocr）的结果。**永不抛错**。 */
export interface VisionTextResult {
  /** 成功没有。 */
  readonly ok: boolean
  /** 结果码。成功为 `ok`。 */
  readonly reason: VisionReason
  /** 正文；失败为空串（**绝不填占位文案**，占位会被当成描述入库）。 */
  readonly text: string
  /** 正文字数。 */
  readonly chars: number
  /** 有没有被截断。 */
  readonly truncated: boolean
  /** 实际服务的 provider。 */
  readonly provider: VisionProvider
  /** 实际用的模型（配置里有才有）。 */
  readonly model?: string
  /** 耗时（毫秒）。失败也算。 */
  readonly elapsedMs: number
  /** 一句补充说明（HTTP 码、解析失败位置等）。 */
  readonly detail?: string
  /** 入库草稿；`ok=false` 时缺省。 */
  readonly draft?: MultimodalDraft
}

/** 一次定位的结果。 */
export interface LocateResult {
  readonly ok: boolean
  readonly reason: VisionReason
  /** 方框；`ok=false` 时是空数组。 */
  readonly boxes: readonly DetectionBox[]
  readonly provider: VisionProvider
  readonly model?: string
  readonly elapsedMs: number
  readonly detail?: string
}

/** 一次抽帧的结果。 */
export interface FramesResult {
  readonly ok: boolean
  readonly reason: VisionReason
  /** 帧文件绝对路径（按时间顺序）。 */
  readonly frames: readonly string[]
  /** 帧所在目录（调用方用完可以整目录清掉）。 */
  readonly dir?: string
  readonly elapsedMs: number
  readonly detail?: string
}

/** 一次可达性探测的结果。**探通了不代表这家会看图**，只代表地址与凭据没错到连不上。 */
export interface ProbeResult {
  readonly ok: boolean
  readonly reason: VisionReason
  /** HTTP 状态码（有响应时）。 */
  readonly status?: number
  readonly elapsedMs: number
  readonly detail?: string
}

/** 运行计数（**只在内存**，进程重启归零）。 */
export interface VisionStats {
  /** 真正发出请求的次数（含抽帧，抽帧不发请求但记在这里会串味，故单列）。 */
  readonly calls: number
  /** 成功次数。 */
  readonly ok: number
  /** 失败次数。 */
  readonly failures: number
  /** 被出站裁决拦下的次数（`deny` + `ask`）。 */
  readonly egressBlocked: number
  /** 抽帧次数。 */
  readonly framesRuns: number
  /** 最后一次成功时刻，0 表示从未成功。 */
  readonly lastOkAt: number
  /** 最后一次失败的原因码。 */
  readonly lastError?: VisionReason
  /** 按原因码分类的计数（**只统计出现过的**，不预置 19 个 0）。 */
  readonly byReason: Readonly<Record<string, number>>
}

/** 视觉服务。 */
export interface VisionService {
  /** 服务本身能不能工作：开关 + 模型 + 运行时出口。 */
  readonly available: boolean
  /** 不能工作的原因（`available=true` 时缺省）。 */
  readonly reason?: VisionReason
  /** 当前生效的 provider（面板要能读到，不许黑箱）。 */
  readonly provider: VisionProvider

  /** 图片 → 中文描述。 */
  describe(input: VisionInput): Promise<VisionTextResult>
  /** 图片 → 字。 */
  ocr(input: VisionInput): Promise<VisionTextResult>
  /** 图片 → 方框。 */
  locate(input: LocateInput): Promise<LocateResult>
  /** 视频 → N 帧（默认 4）。不调模型。 */
  frames(input: FramesInput): Promise<FramesResult>
  /** 地址与凭据可达性（只发一次不带图的轻请求）。 */
  probe(): Promise<ProbeResult>
  /** 运行计数。 */
  stats(): VisionStats
  /** 清掉本包建过的帧目录（幂等）。 */
  dispose(): void
}

/** 一次 HTTP 响应的结构对位子集（`fetch` 的返回满足它）。 */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/**
 * 网络出口。**唯一替换点**：日后宿主给出 transport 服务，只改 `transport.ts`。
 *
 * 与 O-047 的 `FetchLike` 差一个 `body` 与 `method`：视觉要 POST JSON。
 */
export type FetchLike = (
  url: string,
  init: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
    readonly signal?: AbortSignal
  },
) => Promise<FetchResponseLike>

/** 时间服务的结构对位子集（只用到 `now()`）。 */
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

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** O-002 路径服务的结构对位子集（只用到临时目录）。 */
export interface PathLayoutLike {
  area(area: 'tmp'): string
  ensure(area: 'tmp', ...segments: string[]): string
}

/** O-076 的一条出站声明（结构对位，字段与 `EgressSpec` 一致）。 */
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

/** O-076 的一次出站裁决结果（结构对位，只读这几个字段）。 */
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

/** 解析后的接入点。 */
export interface ResolvedEndpoint {
  /** 基础地址，**不含**末尾斜杠。 */
  readonly base: string
  /** 主机（含端口）。 */
  readonly host: string
  /** 是不是本机。 */
  readonly local: boolean
}
