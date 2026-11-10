/**
 * 语音转写服务：本地优先、云端兜底、失败静默。
 *
 * ## 兜底顺序写死在这里
 *
 * ```
 * 读音频 → 本地（若能走）→ 失败且允许兜底 → 出站裁决 → 云端
 * ```
 *
 * 三个「不」：
 * - **不因为本地没装就报错**：`allowCloudFallback` 开着就去云端，这是手册
 *   「云端兜底」那半句的落实；
 * - **不因为云端被拒就静默**：`egress-consent` 与 `egress-denied` 分开报，
 *   因为前者是「去点个头就行」，后者是「这条路走不通」；
 * - **不把两条路的失败揉成一个原因**：`tried` 里逐条列出
 *   （`local:no-binary` / `cloud:no-credential`），否则用户只会看到「转写失败」。
 *
 * ## 失败静默的准确含义
 *
 * 手册说「失败静默」。本包的理解是：**不打断用户、不弹错误、不编内容**，
 * 不是「什么都不记」。所以：
 * - `quiet: true`（默认）时不打 warn，只打 debug；
 * - `stats().byReason` / `lastError` 一直在；
 * - 返回值照常带 `reason` 与 `detail`，调用方能决定是「装作没听见」还是「问一句」。
 *
 * ## 为什么不编说话人
 *
 * whisper.cpp 与 `whisper-1` 都不做说话人分离。`diarized` 恒为 `false`，
 * `spans[].speaker` 没有就缺省。把用户的话记成她说的话，是归属错误——
 * 手册 §2.2：「归属错误比记不住更伤信任」。
 */

import type { Config } from './settings.js'
import { resolveCloudEndpoint } from './settings.js'
import type {
  AsrReason,
  AsrService,
  AsrStats,
  EgressVerdictLike,
  FetchLike,
  LogLike,
  Modality,
  MultimodalDraft,
  PathLayoutLike,
  PrivacyLike,
  ResolvedEndpoint,
  TranscriptSpan,
  TranscribeInput,
  TranscribeResult,
} from './types.js'
import { loadAudio } from './audio.js'
import { CloudAsr } from './cloud.js'
import { LocalWhisper } from './local.js'
import { charsOf, clip, fnv1a64, titleOf } from './text.js'

/** O-076 里本包的能力 id（kebab，符合 §8.4）。 */
export const EGRESS_ID = 'asr'

/** 服务依赖（全部惰性取值）。 */
export interface AsrDeps {
  readonly settings: () => Config
  readonly log: LogLike
  readonly now: () => number
  readonly fetch: () => FetchLike | undefined
  readonly privacy: () => PrivacyLike | undefined
  readonly pathLayout: () => PathLayoutLike | undefined
  /** 解析凭据值。**只回值，不打印**。 */
  readonly credential: (ref: string) => Promise<string | undefined>
}

/** 出站裁决的结论。 */
type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: AsrReason; readonly detail: string }

/** 一条路的结果（本地与云端各自归一到这里）。 */
type RoadResult =
  | {
    readonly ok: true
    readonly text: string
    readonly spans: readonly TranscriptSpan[]
    readonly language?: string
    readonly model: string
    readonly degraded?: string
  }
  | { readonly ok: false; readonly reason: AsrReason; readonly detail: string }

/** 语音转写服务实现。 */
export class Asr implements AsrService {
  readonly provider: Config['provider']
  readonly available: boolean
  readonly reason?: AsrReason
  readonly localReady: boolean
  readonly cloudReady: boolean

  private readonly deps: AsrDeps
  private readonly local: LocalWhisper
  private readonly cloud: CloudAsr
  private readonly cloudEndpoint: ResolvedEndpoint | undefined
  private requests = 0
  private okCount = 0
  private failures = 0
  private fallbacks = 0
  private egressBlocked = 0
  private lastOkAt = 0
  private lastError: AsrReason | undefined
  private readonly byReason: Record<string, number> = {}
  private disposed = false

  constructor(deps: AsrDeps) {
    this.deps = deps
    const config = deps.settings()
    this.provider = config.provider

    this.local = new LocalWhisper({
      binary: config.binary,
      modelPath: config.modelPath,
      threads: config.threads,
      // 本地转写比图片慢得多：配置给的就是本地超时，这里只兜一个下限。
      timeoutMs: Math.max(config.timeoutMs, 5000),
      ffmpegPath: config.ffmpegPath,
      log: deps.log,
      tmpRoot: () => tmpRootOf(deps.pathLayout()),
    })

    const resolved = resolveCloudEndpoint(config)
    this.cloudEndpoint = resolved.ok ? resolved.endpoint : undefined
    this.cloud = new CloudAsr({
      base: resolved.ok ? resolved.endpoint.base : '',
      model: config.cloudModel,
      timeoutMs: config.timeoutMs,
      fetch: deps.fetch,
      secret: () => this.secret(),
    })

    this.localReady = this.local.ready
    this.cloudReady = this.cloud.ready && config.credentialRef !== ''

    const usable =
      config.provider === 'local'
        ? this.localReady || (config.allowCloudFallback && this.cloudReady)
        : this.cloudReady

    if (!config.enable) {
      this.available = false
      this.reason = 'disabled'
    } else if (usable) {
      this.available = true
      this.reason = undefined
    } else {
      this.available = false
      this.reason =
        config.provider === 'local'
          ? (this.local.reason ?? 'no-model')
          : (this.cloud.reason ?? 'no-credential')
    }
  }

  /** 转写一段音频。**永不抛错**。 */
  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const startedAt = this.deps.now()
    const config = this.deps.settings()
    const tried: string[] = []
    this.requests += 1

    if (!config.enable) return this.fail('disabled', '转写关着', startedAt, tried)
    if (this.disposed) return this.fail('disposed', '服务已卸载', startedAt, tried)

    const audio = loadAudio(input.path, config.maxAudioBytes)
    if (!audio.ok) {
      return this.fail(audio.reason, audio.detail, startedAt, tried)
    }

    const language = (input.language ?? config.language).trim()

    // 第一条路：本地。
    if (config.provider === 'local') {
      if (this.local.ready) {
        const local = await this.local.transcribe(
          audio.path,
          audio.bytes,
          audio.mime,
          language,
          input.signal,
        )
        tried.push(local.ok ? 'local:ok' : `local:${local.reason}`)
        if (local.ok) return this.success(local, 'local', audio.path, startedAt, tried)
        if (!config.allowCloudFallback || !this.cloudReady) {
          return this.fail(local.reason, local.detail, startedAt, tried)
        }
        this.fallbacks += 1
        this.logFailure(`本地转写失败（${local.reason}），改走云端兜底`, local.detail)
      } else {
        const reason = this.local.reason ?? 'no-model'
        tried.push(`local:${reason}`)
        if (!config.allowCloudFallback || !this.cloudReady) {
          return this.fail(
            reason,
            this.local.reason === 'no-binary'
              ? `找不到 whisper 可执行文件（${config.binary}），且没有可用的云端兜底`
              : '没有可用的本地模型，且没有可用的云端兜底',
            startedAt,
            tried,
          )
        }
        this.fallbacks += 1
      }
    }

    // 第二条路：云端（出站，必须先过裁决）。
    const endpoint = this.cloudEndpoint
    if (endpoint === undefined) {
      return this.fail('bad-base', '云端接入点地址不合法', startedAt, tried)
    }
    const gate = await this.gate(endpoint)
    if (!gate.ok) return this.fail(gate.reason, gate.detail, startedAt, tried)

    const cloud = await this.cloud.transcribe(
      audio.path,
      audio.bytes,
      audio.mime,
      language,
      input.signal,
    )
    tried.push(cloud.ok ? 'cloud:ok' : `cloud:${cloud.reason}`)
    if (!cloud.ok) return this.fail(cloud.reason, cloud.detail, startedAt, tried)
    return this.success(cloud, 'cloud', audio.path, startedAt, tried)
  }

  /** 运行计数。 */
  stats(): AsrStats {
    return {
      requests: this.requests,
      ok: this.okCount,
      failures: this.failures,
      fallbacks: this.fallbacks,
      egressBlocked: this.egressBlocked,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      byReason: { ...this.byReason },
    }
  }

  /** 清掉本包起过的子进程与临时目录（幂等）。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.local.dispose()
  }

  /** 一次成功的结果。 */
  private success(
    road: Extract<RoadResult, { ok: true }>,
    provider: Config['provider'],
    sourcePath: string,
    startedAt: number,
    tried: readonly string[],
  ): TranscribeResult {
    const config = this.deps.settings()
    const clipped = clip(road.text, config.maxChars)
    const text = clipped.text
    const at = this.deps.now()

    if (text.trim() === '') {
      // 跑通了但一个字都没有：静音、纯噪音，或模型认为没人说话。
      // 这不是故障，但也不是可入库的内容——`empty` 而不是「成功但空串」。
      // 传 `provider` 是为了让「云端跑通了但没字」也如实写 cloud，而不是写成首选来源。
      return this.fail(
        'empty',
        '转写结果为空（静音、纯噪音，或模型认为没人说话）',
        startedAt,
        tried,
        provider,
      )
    }

    this.okCount += 1
    this.lastOkAt = at
    this.byReason['ok'] = (this.byReason['ok'] ?? 0) + 1

    const diarized = road.spans.some(span => span.speaker !== undefined)
    if (config.verbose) {
      this.deps.log.info(
        '转写完成（%s）：%d 字，%d 段，耗时 %d 毫秒',
        provider,
        charsOf(text),
        road.spans.length,
        at - startedAt,
      )
    }

    return {
      ok: true,
      reason: 'ok',
      text,
      spans: road.spans,
      language: road.language,
      provider,
      model: road.model,
      chars: charsOf(text),
      truncated: clipped.truncated,
      diarized,
      tried: [...tried],
      elapsedMs: at - startedAt,
      detail: road.degraded,
      draft: draftOf({
        modality: 'audio',
        sourcePath,
        text,
        at,
        provider,
        model: road.model,
        truncated: clipped.truncated,
        spans: road.spans,
        degraded: road.degraded,
      }),
    }
  }

  /** 一次失败的结果（同时记计数）。 */
  private fail(
    reason: AsrReason,
    detail: string,
    startedAt: number,
    tried: readonly string[],
    provider: Config['provider'] = this.provider,
  ): TranscribeResult {
    this.failures += 1
    this.lastError = reason
    this.byReason[reason] = (this.byReason[reason] ?? 0) + 1
    this.logFailure(`转写失败（${reason}）`, detail)
    return {
      ok: false,
      reason,
      text: '',
      spans: [],
      provider,
      chars: 0,
      truncated: false,
      diarized: false,
      tried: [...tried],
      elapsedMs: this.deps.now() - startedAt,
      detail,
    }
  }

  /** 记一行失败日志：`quiet` 时降到 debug（手册「失败静默」）。 */
  private logFailure(what: string, detail: string): void {
    const config = this.deps.settings()
    if (config.quiet) this.deps.log.debug('%s：%s', what, detail)
    else this.deps.log.warn('%s：%s', what, detail)
  }

  /**
   * 出站裁决（与 O-126 同一套语义：本机放行、云端要人点头）。
   * @param endpoint 云端接入点。
   */
  private async gate(endpoint: ResolvedEndpoint): Promise<GateResult> {
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
        payload: 'audio',
        identity: false,
        irreversible: false,
      })
    } catch (error) {
      // 裁决器自己崩了：不放行。放行等于用一次崩溃换一次泄漏。
      this.egressBlocked += 1
      return { ok: false, reason: 'egress-denied', detail: `出站裁决出错，按拒绝处理：${textOf(error)}` }
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

  /** 解析云端凭据。**只回值，不打印、不进日志、不进返回值**。 */
  private async secret(): Promise<string | undefined> {
    const ref = this.deps.settings().credentialRef
    if (ref === '') return undefined
    const value = await this.deps.credential(ref)
    if (value === undefined || value === '') return undefined
    return value
  }
}

/**
 * 临时目录根。
 *
 * 有 O-002 就用它的 tmp 区（权限已收紧）；没有就退回系统临时目录——
 * 这里不自己拼 `~/.ondra`，那是 O-001/O-002 的事（§13 单一真源）。
 * @param layout 路径服务。
 */
function tmpRootOf(layout: PathLayoutLike | undefined): string {
  if (layout !== undefined) return layout.ensure('tmp', 'asr-work')
  return `${process.env['TMPDIR'] ?? '/tmp'}/ondra-asr`
}

/**
 * 组装入库草稿（镜像 O-126 的 `draftOf`，字段与指纹算法逐字一致）。
 *
 * 指纹**不含时间**：同一段音频转写两次必须得到同一个指纹，否则 O-128 会
 * 把它当成两条新记忆。
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
    degraded: input.degraded,
  }
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
