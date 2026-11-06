/**
 * 视觉服务：把「一张图」走完 出站裁决 → 请求整形 → 解析 → 入库草稿 这一条链。
 *
 * ## 三条纪律落在这里
 *
 * 1. **C3 同款：永不抛错。** 本包不是器官，但同一个理由成立——视觉失败
 *    不该让「用户发了一张图」变成一条崩掉的对话。所有路径都返回原因码。
 * 2. **失败不填占位文案。** 失败时 `text` 恒为空串。填「（图片看不清）」这种
 *    占位，会被下游当成描述入库，于是记忆里多一条「图片看不清」的事实。
 * 3. **出站前必须有人点头。** `gate()` 是唯一出口，任何发请求的路径都要过它。
 *    本机 provider 直接放行（没出站），云端要 O-076 的 `allow`。
 *
 * ## 为什么 `available` 在构造时算一次，之后不再变
 *
 * 配置在 `apply()` 里已经定型（O-005 的解析是一次性的）。运行期唯一会变的是
 * 「网通不通」，那不是 `available` 该管的事——把它算进去，面板会时亮时灭，
 * 用户以为插件在抽风。网络失败走 `reason` 返回，不进 `available`。
 *
 * ## 为什么不需要串行队列
 *
 * 一次调用要用到的全部信息（动作、目标、图、语言）都是**参数**，不是实例字段；
 * 计数器共享但没有读-改-写的依赖。所以并发两次调用不会互相串味——
 * 这一点是刻意保持的：把「这次是什么动作」存成字段，就迟早要加锁。
 */

import type { Config } from './settings.js'
import { credentialRefOf, resolveEndpoint } from './settings.js'
import type {
  DetectionBox,
  EgressVerdictLike,
  FetchLike,
  FramesInput,
  FramesResult,
  ImageSize,
  LocateInput,
  LocateResult,
  LogLike,
  Modality,
  MultimodalDraft,
  PathLayoutLike,
  PrivacyLike,
  ProbeResult,
  ResolvedEndpoint,
  TranscriptSpan,
  VisionInput,
  VisionReason,
  VisionService,
  VisionStats,
  VisionTextResult,
} from './types.js'
import { PROVIDER_ENDPOINTS } from './types.js'
import { loadImage, toBase64, toDataUrl } from './image.js'
import { buildRequest, parseBoxes, textOfResponse } from './providers.js'
import { charsOf, clip, fnv1a64, squeeze, titleOf } from './text.js'
import { requestJson } from './transport.js'
import { FrameGrabber } from './frames.js'

/** O-076 里本包的能力 id（kebab，符合 §8.4）。 */
export const EGRESS_ID = 'vision'

/** 服务依赖（全部惰性取值：装载顺序由用户配置决定，不由本包决定）。 */
export interface VisionDeps {
  readonly settings: () => Config
  readonly log: LogLike
  readonly now: () => number
  /** 运行时 `fetch`；缺席即 `no-transport`。 */
  readonly fetch: () => FetchLike | undefined
  /** O-076；缺席时按 `cloudWithoutPrivacy` 决定。 */
  readonly privacy: () => PrivacyLike | undefined
  /** O-002；只用来放帧目录。 */
  readonly pathLayout: () => PathLayoutLike | undefined
  /** 解析凭据值。**只回值，不打印**。 */
  readonly credential: (ref: string) => Promise<string | undefined>
}

/** 出站裁决的结论。 */
type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: VisionReason; readonly detail: string }

/** 一次模型调用的结论（内部用，不含动作语义）。 */
type CallOutcome =
  | {
    readonly ok: true
    readonly text: string
    readonly path: string
    readonly size: ImageSize | undefined
    readonly model?: string
  }
  | { readonly ok: false; readonly reason: VisionReason; readonly detail: string; readonly model?: string }

/** 视觉服务实现。 */
export class Vision implements VisionService {
  readonly provider: Config['provider']
  readonly available: boolean
  readonly reason?: VisionReason

  private readonly deps: VisionDeps
  private readonly grabber: FrameGrabber
  private readonly endpoint: ResolvedEndpoint | undefined
  private calls = 0
  private okCount = 0
  private failures = 0
  private egressBlocked = 0
  private framesRuns = 0
  private lastOkAt = 0
  private lastError: VisionReason | undefined
  private readonly byReason: Record<string, number> = {}
  private disposed = false

  constructor(deps: VisionDeps) {
    this.deps = deps
    const config = deps.settings()
    this.provider = config.provider

    const resolved = resolveEndpoint(config)
    this.endpoint = resolved.ok ? resolved.endpoint : undefined

    if (!config.enable) {
      this.available = false
      this.reason = 'disabled'
    } else if (config.model === '') {
      this.available = false
      this.reason = 'no-model'
    } else if (!resolved.ok) {
      this.available = false
      this.reason = resolved.reason
      deps.log.warn('接入点不可用：%s', resolved.detail)
    } else if (deps.fetch() === undefined) {
      this.available = false
      this.reason = 'no-transport'
    } else {
      this.available = true
      this.reason = undefined
    }

    this.grabber = new FrameGrabber({
      ffmpegPath: config.ffmpegPath,
      // 转码比推理慢：给两倍超时，但不低于 30 秒（4 秒的视频在慢盘上也要几秒）。
      timeoutMs: Math.max(30000, config.timeoutMs * 2),
      log: deps.log,
      pathLayout: deps.pathLayout,
    })
  }

  /** 图片 → 描述。 */
  describe(input: VisionInput): Promise<VisionTextResult> {
    return this.runText('describe', input)
  }

  /** 图片 → 字。 */
  ocr(input: VisionInput): Promise<VisionTextResult> {
    return this.runText('ocr', input)
  }

  /** 图片 → 方框。 */
  locate(input: LocateInput): Promise<LocateResult> {
    return this.runLocate(input)
  }

  /**
   * 视频 → N 帧。**不调模型**，所以不过出站裁决。
   * @param input 路径与张数。
   */
  async frames(input: FramesInput): Promise<FramesResult> {
    const config = this.deps.settings()
    const count = input.count ?? config.videoFrames
    this.framesRuns += 1
    const result = await this.grabber.grab(input.path, count, input.signal)
    if (!result.ok) {
      this.note(result.reason)
      if (config.verbose) {
        this.deps.log.warn('抽帧失败（%s）：%s', result.reason, result.detail ?? '')
      }
    }
    return result
  }

  /**
   * 可达性探测：只发一次不带图的轻请求。
   *
   * **探通了不代表这家会看图**：`/models` 只证明地址与凭据没错到连不上。
   * 这一点写在返回值说明里，也写在 README，免得面板把绿灯读成「视觉可用」。
   */
  async probe(): Promise<ProbeResult> {
    const startedAt = this.deps.now()
    const config = this.deps.settings()
    const endpoint = this.endpoint
    if (endpoint === undefined) {
      return {
        ok: false,
        reason: 'bad-base',
        elapsedMs: this.deps.now() - startedAt,
        detail: '接入点地址不合法',
      }
    }
    if (!config.enable) {
      return { ok: false, reason: 'disabled', elapsedMs: this.deps.now() - startedAt, detail: '开关关着（手册 §9.4）' }
    }
    if (config.model === '') {
      return { ok: false, reason: 'no-model', elapsedMs: this.deps.now() - startedAt, detail: '没有配模型名' }
    }

    const gate = await this.gate(endpoint)
    if (!gate.ok) {
      return {
        ok: false,
        reason: gate.reason,
        elapsedMs: this.deps.now() - startedAt,
        detail: gate.detail,
      }
    }

    const apiKey = await this.secret()
    const url = this.provider === 'ollama' ? `${endpoint.base}/api/tags` : `${endpoint.base}/models`
    const headers: Record<string, string> = {}
    if (apiKey !== undefined && apiKey !== '') headers['authorization'] = `Bearer ${apiKey}`

    this.calls += 1
    const result = await requestJson(
      { fetch: this.deps.fetch() },
      url,
      { method: 'GET', headers },
      Math.min(config.timeoutMs, 10000),
    )
    const elapsedMs = this.deps.now() - startedAt
    if (!result.ok) {
      this.note(result.reason)
      return { ok: false, reason: result.reason, status: result.status, elapsedMs, detail: result.detail }
    }
    this.noteOk()
    return { ok: true, reason: 'ok', status: result.status, elapsedMs }
  }

  /** 运行计数。 */
  stats(): VisionStats {
    return {
      calls: this.calls,
      ok: this.okCount,
      failures: this.failures,
      egressBlocked: this.egressBlocked,
      framesRuns: this.framesRuns,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      byReason: { ...this.byReason },
    }
  }

  /** 清掉本包建过的帧目录（幂等）。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.grabber.dispose()
  }

  /** 一次文本动作（describe / ocr）的完整链路。 */
  private async runText(
    action: 'describe' | 'ocr',
    input: VisionInput,
  ): Promise<VisionTextResult> {
    const startedAt = this.deps.now()
    const outcome = await this.call(action, input, '')
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason,
        text: '',
        chars: 0,
        truncated: false,
        provider: this.provider,
        model: outcome.model,
        elapsedMs: this.deps.now() - startedAt,
        detail: outcome.detail,
      }
    }

    const config = this.deps.settings()
    const clipped = clip(outcome.text, config.maxOutputChars)
    if (squeeze(clipped.text) === '') {
      // 模型回了空白：这不是「描述为空的图」，是这一趟没拿到东西。
      this.note('empty')
      return {
        ok: false,
        reason: 'empty',
        text: '',
        chars: 0,
        truncated: false,
        provider: this.provider,
        model: outcome.model,
        elapsedMs: this.deps.now() - startedAt,
        detail: '模型回了空白（拒答或只回了空白字符）',
      }
    }

    this.noteOk()
    const draft = draftOf({
      modality: 'image',
      sourcePath: outcome.path,
      text: clipped.text,
      at: this.deps.now(),
      provider: this.provider,
      model: outcome.model,
      truncated: clipped.truncated,
    })
    return {
      ok: true,
      reason: 'ok',
      text: clipped.text,
      chars: charsOf(clipped.text),
      truncated: clipped.truncated,
      provider: this.provider,
      model: outcome.model,
      elapsedMs: this.deps.now() - startedAt,
      draft,
    }
  }

  /** 定位的完整链路。 */
  private async runLocate(input: LocateInput): Promise<LocateResult> {
    const startedAt = this.deps.now()
    const target = squeeze(input.target)
    if (target === '') {
      return this.locateFail('bad-target', '定位必须给一个目标（例如「红色的按钮」）', startedAt)
    }

    const outcome = await this.call('locate', input, target)
    if (!outcome.ok) {
      return this.locateFail(outcome.reason, outcome.detail, startedAt, outcome.model)
    }

    const parsed = parseBoxes(outcome.text, outcome.size)
    const elapsedMs = this.deps.now() - startedAt
    if (parsed.boxes.length === 0) {
      // 「没找到」不是故障：模型说图里没有这个东西，是合法结论。
      // 但它也不是成功——`ok=false` + `no-boxes`，让调用方知道这一趟没拿到框。
      this.note('no-boxes')
      this.deps.log.debug('定位没给出可用方框：%s（拒收 %d 条）', parsed.detail ?? '', parsed.rejected)
      return {
        ok: false,
        reason: 'no-boxes',
        boxes: [],
        provider: this.provider,
        model: outcome.model,
        elapsedMs,
        detail: parsed.detail ?? '模型认为图里没有这个目标',
      }
    }

    this.noteOk()
    return {
      ok: true,
      reason: 'ok',
      boxes: parsed.boxes,
      provider: this.provider,
      model: outcome.model,
      elapsedMs,
      detail: parsed.detail,
    }
  }

  /**
   * 一次模型调用：开关 → 读图 → 出站裁决 → 凭据 → 请求 → 取正文。
   *
   * 顺序不能换：**读图放在裁决之前**是刻意的——图不合格（太大、格式不认识）
   * 就不该去问「能不能发」，否则用户会被问一次「要不要把这张图发出去」，
   * 而这张图根本发不出去。
   * @param action 动作。
   * @param input 入参。
   * @param target 定位目标（其它动作为空串）。
   */
  private async call(
    action: 'describe' | 'ocr' | 'locate',
    input: VisionInput,
    target: string,
  ): Promise<CallOutcome> {
    const config = this.deps.settings()
    const model = config.model === '' ? undefined : config.model

    if (!config.enable) {
      return { ok: false, reason: 'disabled', detail: '视觉关着（手册 §9.4 默认关闭）', model }
    }
    if (config.model === '') {
      return { ok: false, reason: 'no-model', detail: '没有配模型名（本包不猜模型）', model }
    }
    const endpoint = this.endpoint
    if (endpoint === undefined) {
      return { ok: false, reason: 'bad-base', detail: '接入点地址不合法', model }
    }
    if (this.deps.fetch() === undefined) {
      return { ok: false, reason: 'no-transport', detail: '运行时没有 fetch', model }
    }
    if (this.disposed) {
      return { ok: false, reason: 'disposed', detail: '服务已卸载', model }
    }

    const image = loadImage(input.path, config.maxImageBytes)
    if (!image.ok) {
      this.note(image.reason)
      if (config.verbose) this.deps.log.warn('读图失败（%s）：%s', image.reason, image.detail)
      return { ok: false, reason: image.reason, detail: image.detail, model }
    }

    const gate = await this.gate(endpoint)
    if (!gate.ok) return { ok: false, reason: gate.reason, detail: gate.detail, model }

    const ref = credentialRefOf(config)
    const apiKey = await this.secret()
    if (!endpoint.local && ref !== '' && apiKey === undefined) {
      // 云端要密钥却解析不到：直接说清楚，别发一个必然 401 的请求（那次请求也是出站）。
      this.note('no-credential')
      return {
        ok: false,
        reason: 'no-credential',
        detail: `解析不到凭据 ${ref}（本包只认环境变量名，不认密钥值）`,
        model,
      }
    }

    const wire = buildRequest(
      this.provider,
      endpoint,
      config,
      action,
      {
        base64: toBase64(image.bytes),
        mime: image.mime,
        dataUrl: toDataUrl(image.mime, image.bytes),
      },
      apiKey,
      target,
    )

    this.calls += 1
    const result = await requestJson(
      { fetch: this.deps.fetch() },
      wire.url,
      { method: 'POST', headers: wire.headers, body: wire.body },
      config.timeoutMs,
    )
    if (!result.ok) {
      this.note(result.reason)
      if (config.verbose) this.deps.log.warn('视觉请求失败（%s）：%s', result.reason, result.detail)
      return { ok: false, reason: result.reason, detail: result.detail, model }
    }

    const raw = textOfResponse(result.json)
    if (raw === undefined) {
      this.note('payload')
      return {
        ok: false,
        reason: 'payload',
        detail: '响应里没有 message.content / choices[0].message.content',
        model,
      }
    }
    return { ok: true, text: raw, path: image.path, size: image.size, model }
  }

  /**
   * 出站裁决。
   *
   * 本机直接放行：手册 §9.4 要求的是「**出站**前提示」，而 127.0.0.1 没有出站。
   * 云端必须有人点头——有 O-076 就听它的，没有就按 `cloudWithoutPrivacy`。
   */
  private async gate(endpoint: ResolvedEndpoint): Promise<GateResult> {
    if (endpoint.local) return { ok: true }

    const privacy = this.deps.privacy()
    if (privacy === undefined) {
      if (this.deps.settings().cloudWithoutPrivacy) return { ok: true }
      this.egressBlocked += 1
      return {
        ok: false,
        reason: 'egress-denied',
        detail:
          '没有 ondra-privacy，云端出站默认不允许（cloud-without-privacy=false）：'
          + '出站必须有人替我说能不能发',
      }
    }

    let verdict: EgressVerdictLike
    try {
      verdict = privacy.evaluate({
        id: EGRESS_ID,
        host: endpoint.host,
        payload: 'image',
        identity: false,
        irreversible: false,
      })
    } catch (error) {
      // 裁决器自己崩了：**不放行**。放行等于用一次崩溃换一次泄漏。
      this.egressBlocked += 1
      return {
        ok: false,
        reason: 'egress-denied',
        detail: `出站裁决出错，按拒绝处理：${textOf(error)}`,
      }
    }

    if (verdict.decision === 'allow') return { ok: true }
    this.egressBlocked += 1
    if (verdict.decision === 'ask') {
      return {
        ok: false,
        reason: 'egress-consent',
        detail: `这次不发：${verdict.detail}${verdict.hint === undefined ? '' : `（${verdict.hint}）`}`,
      }
    }
    return { ok: false, reason: 'egress-denied', detail: `被拒绝：${verdict.detail}` }
  }

  /** 解析凭据值。**只回值，不打印、不进日志、不进返回值**。 */
  private async secret(): Promise<string | undefined> {
    const ref = credentialRefOf(this.deps.settings())
    if (ref === '') return undefined
    const value = await this.deps.credential(ref)
    if (value === undefined || value === '') return undefined
    return value
  }

  /** 记一次失败。 */
  private note(reason: VisionReason): void {
    this.failures += 1
    this.lastError = reason
    this.byReason[reason] = (this.byReason[reason] ?? 0) + 1
  }

  /** 记一次成功。 */
  private noteOk(): void {
    this.okCount += 1
    this.lastOkAt = this.deps.now()
    this.byReason['ok'] = (this.byReason['ok'] ?? 0) + 1
  }

  /** 定位失败的结果形状（三处复用）。 */
  private locateFail(
    reason: VisionReason,
    detail: string,
    startedAt: number,
    model?: string,
  ): LocateResult {
    this.note(reason)
    if (this.deps.settings().verbose) this.deps.log.warn('定位失败（%s）：%s', reason, detail)
    return {
      ok: false,
      reason,
      boxes: [],
      provider: this.provider,
      model,
      elapsedMs: this.deps.now() - startedAt,
      detail,
    }
  }

}

/**
 * 组装入库草稿（O-128 的契约）。
 *
 * 指纹**不含时间**：同一张图描述两次必须得到同一个指纹，否则 O-128 会把它
 * 当成两条新记忆，而它们说的是同一件事。
 * @param input 草稿字段。
 */
export function draftOf(input: {
  readonly modality: Modality
  readonly sourcePath: string
  readonly text: string
  readonly at: number
  readonly provider: string
  readonly model?: string
  readonly truncated: boolean
  readonly spans?: readonly TranscriptSpan[]
  readonly boxes?: readonly DetectionBox[]
  readonly frames?: readonly string[]
  readonly degraded?: string
}): MultimodalDraft {
  const text = input.text
  return {
    modality: input.modality,
    sourcePath: input.sourcePath,
    text,
    title: titleOf(text, 40),
    at: input.at,
    provider: input.provider,
    model: input.model,
    chars: charsOf(text),
    truncated: input.truncated,
    fingerprint: fnv1a64(`${input.modality}\u0000${input.sourcePath}\u0000${text}`),
    spans: input.spans,
    boxes: input.boxes,
    frames: input.frames,
    degraded: input.degraded,
  }
}

/** 默认 provider 的默认接入点（面板显示「将发往」时用）。 */
export function defaultBaseOf(provider: Config['provider']): string {
  return PROVIDER_ENDPOINTS[provider].base
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
