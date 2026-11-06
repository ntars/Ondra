/**
 * O-050 `ondra-tts` 的对外契约。
 *
 * 定位：**声音的唯一出口**。谁想把一段文字变成声音，一律经
 * `ctx.get('ondra-tts')` 取，**不得自己 spawn 一个合成器**。
 *
 * ## 三条通道是「分支」，不是「三套逻辑」
 *
 * 手册 §1.7 给了两条（GPT-SoVITS / Edge TTS），master-plan §14.3 又登记了
 * macOS `say` 作为最稳的一条。三者能力相同（文字进、音频出），差异全在
 * 传输与参数：一个走本地 HTTP、一个走外部 CLI、一个走系统命令。
 * 按 §14.2 的处理方式——**一个接口、每分支一个文件、默认选最稳、各自独立降级**。
 *
 * ## 为什么本插件不读情绪
 *
 * 六态语速（雀跃 +10%、蔫 −15%）归 O-031 `ondra-emotion-express`，
 * 「要不要读」的四道闸门归 O-051 `ondra-tts-gate`。本插件只负责
 * 「怎么说」：拿到 `rate` / `volume` 就照做，拿不到就用引擎默认。
 *
 * 如果这里也去读一次情绪，同一句话在 O-051 与本插件各被判定一次，
 * 一旦其中一处漏了 `speechRateDelta`，症状是「偶尔语速不对」，而两边日志全绿。
 *
 * ## 失败一律 `ok=false`，永不抛出
 *
 * 手册 §9.4：「任何失败返回 `speak:false`，绝不抛错」。朗读是增强能力，
 * 它挂了主对话必须还能进行（master-plan §3.3-3）。因此本模块所有入口
 * 都是「返回一个带原因码的结果对象」，而不是 `throw`。
 *
 * ## 音频落在 `cache/`，不落 `user/`
 *
 * 合成结果是可再生的（同一段文字再合一次就有），按 O-002 的区域划分属缓存区：
 * 可清、不作真源。`user/` 只放不可再生的东西（凭据、记忆库、日记）。
 */

/** 本插件注册的服务键（连字符，非 `ondra:tts`）。全仓唯一归属。 */
export const TTS_SERVICE_KEY = 'ondra-tts'

/** 服务键 / 工具名 / 配置键的硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 合成通道名。
 *
 * 顺序即手册 §9.4 的优先级叙述顺序（local > macos-say > 云端），
 * `auto` 选路时按这个数组逐个试。
 */
export const ENGINE_NAMES = ['gpt-sovits', 'macos-say', 'edge-tts'] as const

/** 一条通道的名字。 */
export type EngineName = (typeof ENGINE_NAMES)[number]

/** 当前生效的通道；`none` 表示一条都没就绪。 */
export type EngineChoice = EngineName | 'none'

/** 八套语音包预设的 id（手册 §1.7）。 */
export const PRESET_IDS = [
  'soft',
  'lively',
  'broadcast',
  'dongbei',
  'shaanxi',
  'cantonese',
  'taiwan',
  'english',
] as const

/** 一套预设的名字。 */
export type PresetId = (typeof PRESET_IDS)[number]

/**
 * 结果码。
 *
 * 每一个都必须**有分支真的发出**：留一个永远发不出的码，读代码的人会以为
 * 存在一条兜底路径（同一类问题的复查清单见 README「原因码」一节）。
 */
export type TtsReason =
  /** 成功。 */
  | 'ok'
  /** 配置里关掉了。 */
  | 'disabled'
  /** 三条通道都没就绪（没装 CLI、不是 macOS、也没配 GPT-SoVITS 参考音频）。 */
  | 'no-engine'
  /** 原文净化后为空（整段是代码块、表格或纯标点）。 */
  | 'empty'
  /** 超过 `maxChars`。**拒绝而不截断**：截断会把一句话切成半句。 */
  | 'too-long'
  /** 指定的预设或音色不认识。 */
  | 'voice-unknown'
  /** 选了 GPT-SoVITS 但没填参考音频（它必须有音色样本才能合成）。 */
  | 'not-configured'
  /** 超时（默认 15000ms，手册 §9.4）。 */
  | 'timeout'
  /** 连不上 / DNS / 证书。 */
  | 'network'
  /** HTTP 非 2xx。 */
  | 'http'
  /** 返回的不是音频（GPT-SoVITS 出错时回的是 JSON 错误体）。 */
  | 'payload'
  /** 进程起不来或非零退出（`say` / `edge-tts`）。 */
  | 'spawn'
  /** 音频合成了但播不出来（`afplay` 失败）。**不是合成失败**，音频仍在缓存里。 */
  | 'playback'

/** 一个可选音色。 */
export interface VoiceView {
  /** 通道侧的标识（Edge 分支直接用，其它分支忽略）。 */
  readonly id: string
  /** 中文名。只给面板与日志。 */
  readonly zh: string
  /** 语言地区，例如 `zh-CN`。 */
  readonly locale: string
  /** 性别。只给面板做分组，不参与合成。 */
  readonly gender: 'female' | 'male'
}

/**
 * 一套预设。
 *
 * **预设只换音色，不换语速**：手册给过的语速数字（+10% / −15%）只属于六态，
 * 归 O-031 与 O-051。把语速也塞进预设，同一句话就会有两个语速来源，
 * 而两处都不报错——只会在某一天听起来「有点怪」。
 */
export interface PresetView {
  readonly id: PresetId
  /** 中文名（温柔 / 活泼 / …）。 */
  readonly zh: string
  /** 首选音色 id。 */
  readonly voice: string
  /** 备选音色 id（首选被通道拒绝时换它）。 */
  readonly alt: string
  /** 该预设的主语言地区，例如 `zh-CN`。 */
  readonly locale: string
}

/** 一次合成的入参。 */
export interface SpeakOptions {
  /** 预设 id。省略则用配置里的默认预设。 */
  readonly preset?: string
  /** 指定音色 id（优先于预设）。 */
  readonly voice?: string
  /** 语速增量，`0.1` = 快一成。省略则用预设自带的值。 */
  readonly rate?: number
  /** 音量档。省略则用配置值。 */
  readonly volume?: 'normal' | 'low'
  /** 是否播放。`false` 时只合成（预览、导出、通道发语音条都用这个）。 */
  readonly play?: boolean
  /** 时刻，省略用 `clock.now()`。 */
  readonly at?: number
}

/** 一次合成的结果。失败时只有 `ok` / `reason` / `text` / `at` 有意义。 */
export interface Utterance {
  /** 拿到了一段可播放的音频。 */
  readonly ok: boolean
  /** 结果码。 */
  readonly reason: TtsReason
  /** **净化后**真正送进引擎的文本（原文可能含代码块）。 */
  readonly text: string
  /** 实际使用的通道。 */
  readonly engine: EngineChoice
  /** 实际使用的音色 id。 */
  readonly voice?: string
  /** 实际使用的预设 id（显式指定音色时为 `undefined`）。 */
  readonly preset?: PresetId
  /** 音频文件绝对路径（在 `cache/tts/` 下）。 */
  readonly audioPath?: string
  /** 音频字节数。 */
  readonly bytes?: number
  /** 实际使用的语速增量。 */
  readonly rate: number
  /**
   * 引擎是否真的吃这个语速值。
   *
   * GPT-SoVITS 的 `api_v2` 只有 `speed_factor`，本插件**不猜**它的取值口径，
   * 因此该分支恒为 `false`——面板要能看见「设了语速但这次没生效」，
   * 而不是以为调了就有用。
   */
  readonly rateApplied: boolean
  /** 是否命中缓存（同一段文字第二次合成不会重跑引擎）。 */
  readonly cached: boolean
  /** 是否真的播出来了。 */
  readonly played: boolean
  /** 本次耗时（毫秒）。 */
  readonly elapsedMs: number
  /** 时刻。 */
  readonly at: number
}

/** 单条通道的探测结果。 */
export interface EngineCheck {
  readonly engine: EngineName
  /** 现在能不能用它合成。 */
  readonly ready: boolean
  /** 为什么能 / 不能，一句话（面板与日志直接显示）。 */
  readonly detail: string
}

/** 一次探测的完整报告。 */
export interface ProbeReport {
  readonly at: number
  /** 按优先级选出的通道。 */
  readonly chosen: EngineChoice
  readonly checks: readonly EngineCheck[]
}

/** 运行计数（**只在内存**，进程重启归零）。 */
export interface TtsStats {
  /** 真正调用 `synth()` / `speak()` 的次数。 */
  readonly calls: number
  /** 成功合成次数（含命中缓存）。 */
  readonly ok: number
  /** 失败次数。 */
  readonly failures: number
  /** 命中缓存的次数。 */
  readonly cachedHits: number
  /** 真的播出来的次数。 */
  readonly played: number
  /** 最后一次成功的时刻，0 表示从未成功。 */
  readonly lastOkAt: number
  /** 最后一次失败的原因码。 */
  readonly lastError?: TtsReason
  /** 当前生效通道。 */
  readonly engine: EngineChoice
  /** 缓存目录里的音频文件数。 */
  readonly cacheFiles: number
}

/** 语音合成服务。 */
export interface TtsService {
  /** 现在能不能合成：开关 + 至少一条通道就绪。 */
  readonly available: boolean
  /** 不能合成的原因（`available=true` 时为 `undefined`）。 */
  readonly reason?: TtsReason
  /** 当前生效通道。 */
  readonly engine: EngineChoice

  /** 19 个可选音色。 */
  voices(): readonly VoiceView[]
  /** 8 套预设。 */
  presets(): readonly PresetView[]
  /** 按 id 取预设（不认识返回 `undefined`，不抛）。 */
  presetOf(id: string): PresetView | undefined

  /**
   * 可朗读净化（**与 `speak()` 内部用的是同一份实现**）。
   *
   * 单独暴露出来是为了让闸门按「真正会念的字数」判 6–30 字：
   * 一段 40 字的代码块净化后只剩 3 个字，闸门若按原文计数会放行，
   * 然后合成器返回 `empty`——两处各数一次，症状是「闸门说该念、引擎说没东西念」。
   * @param text 原文。
   */
  speakable(text: string): string

  /**
   * 合成并播放。**永不抛出**。
   * @param text 原文（内部会做可朗读净化）。
   * @param options 入参。
   */
  speak(text: string, options?: SpeakOptions): Promise<Utterance>

  /**
   * 只合成不播放。**永不抛出**。
   * @param text 原文。
   * @param options 入参（`play` 被忽略）。
   */
  synth(text: string, options?: SpeakOptions): Promise<Utterance>

  /**
   * 重新探测三条通道（改了配置、装完 CLI 后调用）。
   * @param at 时刻。
   */
  probe(at?: number): Promise<ProbeReport>

  /** 清空音频缓存（改音色后调用，避免旧音色的文件被复用）。 */
  clear(): void

  /** 运行计数。 */
  stats(): TtsStats
}

/* ------------------------------------------------------------------ *
 * 分支实现接口（§14.2：接口唯一，每分支一个文件）
 * ------------------------------------------------------------------ */

/** 一次合成的请求。 */
export interface SynthRequest {
  /** 已净化的文本。 */
  readonly text: string
  /** 目标文件绝对路径（分支自己决定后缀，但必须写这个路径）。 */
  readonly outPath: string
  /** 音色 id。`macos-say` 分支会把它当「系统音色名」用，取不到就回退配置值。 */
  readonly voice: string
  /** 语速增量（相对值，0 表示原速）。 */
  readonly rate: number
  /** 音量档。 */
  readonly volume: 'normal' | 'low'
}

/** 一次合成（单条通道视角）的结果。 */
export interface SynthResult {
  readonly ok: boolean
  readonly reason: TtsReason
  /** 写出的字节数（成功时必填）。 */
  readonly bytes?: number
  /** 文件后缀，用于缓存命名。 */
  readonly ext: 'wav' | 'mp3'
  /**
   * 分支**实际**用的音色。
   *
   * `macos-say` 分支不认 Edge 的音色 id（`say -v` 只吃系统音色名），
   * 它必须在这里报出真正用的那个名字。否则面板显示「晓晓」、
   * 耳朵听到的是婷婷，而两边都不报错。
   */
  readonly voice?: string
  /** 这条分支是否真的吃到了语速值（GPT-SoVITS 恒为 `false`）。 */
  readonly rateApplied: boolean
}

/** 一条合成通道。 */
export interface SpeechEngine {
  readonly name: EngineName
  /**
   * 这条分支**固定使用的音色名**（`undefined` = 用请求里的音色）。
   *
   * 只有 `macos-say` 会给值：它只认系统音色名，传进去的 Edge 音色 id 一律无效。
   * 暴露在这里，是为了让**缓存命中**时也能报出真正用的那个名字——
   * 否则第一次合成报「婷婷」、第二次命中缓存报「晓晓」，而两次听到的声音一样。
   */
  readonly voice?: string
  /**
   * **同步存在性**：这台机器上有没有跑它的条件（不看远端是否活着）。
   *
   * 同步是刻意的：`available` 是同步 getter，面板首屏就要读数；
   * 真正的「远端活不活」只能靠 `probe()` 的异步探测。
   */
  readonly present: boolean
  /** 配置是否够用（GPT-SoVITS 需要参考音频）。 */
  readonly configured: boolean
  /** 同步不可用的原因，一句话。 */
  readonly detail: string
  /**
   * 合成到 `outPath`。**永不抛出**：失败以 `ok=false` + 原因码表达。
   * @param request 请求。
   */
  synth(request: SynthRequest): Promise<SynthResult>
}

/* ------------------------------------------------------------------ *
 * 出口（唯一替换点）
 * ------------------------------------------------------------------ */

/** 一次进程调用的结果。 */
export interface ExecResult {
  readonly ok: boolean
  /** 退出码；被信号杀掉时为 -1。 */
  readonly code: number
  /** 标准输出（截断到 4 KiB）。 */
  readonly stdout: string
  /** 标准错误（截断到 4 KiB）。 */
  readonly stderr: string
  /** 是否超时被杀。 */
  readonly timedOut: boolean
}

/** 进程出口。日后宿主若提供 exec 服务，只替换 `src/exec.ts`。 */
export type ExecLike = (
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<ExecResult>

/** 一次 HTTP 响应的结构对位子集。 */
export interface HttpResponseLike {
  readonly ok: boolean
  readonly status: number
  arrayBuffer(): Promise<ArrayBuffer>
  text(): Promise<string>
}

/** 网络出口。唯一替换点：日后宿主给出 transport 服务，只改 `src/http.ts`。 */
export type FetchLike = (
  url: string,
  init: {
    readonly method?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
    readonly signal?: AbortSignal
  },
) => Promise<HttpResponseLike>

/* ------------------------------------------------------------------ *
 * 相邻服务的结构对位（§18.5：不 import 源码，只按形状取）
 * ------------------------------------------------------------------ */

/** 日志器的结构对位子集。 */
export interface LogLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** O-002 路径服务的结构对位子集（只用到缓存区）。 */
export interface PathLayoutLike {
  area(area: 'cache'): string
  ensure(area: 'cache', ...segments: string[]): string
  fileIn(area: 'cache', ...segments: string[]): string
}

/** O-003 时间服务的结构对位子集。 */
export interface ClockLike {
  now(): number
}

/** O-001 身份服务的结构对位子集。 */
export interface IdentityLike {
  loggerName(feature: string): string
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
