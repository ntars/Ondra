/**
 * 云端转写：OpenAI 兼容的 `POST {base}/audio/transcriptions`，`multipart/form-data`。
 *
 * ## 为什么请求 `verbose_json`
 *
 * 默认的 `json` 只回一段 `text`，**没有时间戳**。而手册要求「语音转写（时间戳 +
 * 说话人分离）」——时间戳这一半只有 `verbose_json` 才给。所以宁可多传一个字段，
 * 也不要拿到一段没法对时的文本。
 *
 * ## 为什么文件名要按 MIME 补扩展名
 *
 * 部分兼容端点（尤其是自建网关）按**扩展名**决定解码器，不看 `Content-Type`。
 * 通道适配器落地时常常没有扩展名（`voice_8891`），那种请求会得到 400
 * 「unsupported file format」，而文件本身完全正常。
 *
 * ## 说话人这一栏
 *
 * OpenAI 的 `whisper-1` 不做说话人分离，`verbose_json` 也没有 `speaker` 字段。
 * 本包仍然读它（有的兼容端点会加），**读不到就不填**——绝不生成 `speaker-1`。
 */

import type { AsrReason, FetchLike, TranscriptSpan } from './types.js'
import { hasFormData, sendForm } from './transport.js'
import { numberOr, stringOr } from './text.js'

/** 云端转写的结果。 */
export type CloudResult =
  | {
    readonly ok: true
    readonly text: string
    readonly spans: readonly TranscriptSpan[]
    readonly language?: string
    readonly model: string
  }
  | { readonly ok: false; readonly reason: AsrReason; readonly detail: string }

/** 云端依赖。 */
export interface CloudDeps {
  /** 基础地址（不含末尾斜杠）。 */
  readonly base: string
  readonly model: string
  readonly timeoutMs: number
  readonly fetch: () => FetchLike | undefined
  /** 解析凭据值。**只回值，不打印**。 */
  readonly secret: () => Promise<string | undefined>
}

/** MIME → 扩展名。端点按扩展名挑解码器时靠它。 */
const EXT_BY_MIME: Readonly<Record<string, string>> = Object.freeze({
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/aiff': 'aiff',
  'audio/amr': 'amr',
})

/** 云端转写器。 */
export class CloudAsr {
  private readonly deps: CloudDeps

  constructor(deps: CloudDeps) {
    this.deps = deps
  }

  /** 云端这条路能不能走（不含凭据：凭据是运行期才解析的）。 */
  get ready(): boolean {
    return this.deps.model !== '' && this.deps.fetch() !== undefined && hasFormData()
  }

  /** 不能走的原因。 */
  get reason(): AsrReason | undefined {
    if (this.deps.fetch() === undefined || !hasFormData()) return 'no-transport'
    if (this.deps.model === '') return 'no-model'
    return undefined
  }

  /**
   * 转写一段音频。**永不抛错**。
   * @param source 源文件绝对路径（只用来取文件名）。
   * @param bytes 文件内容。
   * @param mime 文件 MIME。
   * @param language 语言提示（空串即不传，让服务自己判）。
   * @param signal 取消信号。
   */
  async transcribe(
    source: string,
    bytes: Uint8Array,
    mime: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<CloudResult> {
    if (this.deps.fetch() === undefined || !hasFormData()) {
      return {
        ok: false,
        reason: 'no-transport',
        detail: '运行时没有 fetch / FormData / Blob（发不了 multipart）',
      }
    }
    if (this.deps.model === '') {
      return { ok: false, reason: 'no-model', detail: '没有配云端模型 id' }
    }

    const apiKey = await this.deps.secret()
    if (apiKey === undefined) {
      return {
        ok: false,
        reason: 'no-credential',
        detail: '解析不到云端凭据（本包只认环境变量名，不认密钥值）',
      }
    }

    let form: FormData
    try {
      form = new FormData()
      const name = uploadNameOf(source, mime)
      // 复制一份定长视图：`bytes` 可能带着更大的 buffer 偏移，直接塞进去会多传垃圾。
      const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime })
      form.append('file', blob, name)
      form.append('model', this.deps.model)
      form.append('response_format', 'verbose_json')
      if (language !== '' && language !== 'auto') form.append('language', language)
    } catch (error) {
      return { ok: false, reason: 'payload', detail: `组装 multipart 失败：${textOf(error)}` }
    }

    const result = await sendForm(
      { fetch: this.deps.fetch() },
      `${this.deps.base}/audio/transcriptions`,
      form,
      { authorization: `Bearer ${apiKey}` },
      this.deps.timeoutMs,
      signal,
    )
    if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail }

    return parseCloudBody(result.body, this.deps.model)
  }
}

/**
 * 解析云端响应。**只认 `text` 与 `segments`**，多一个字都不猜。
 * @param body 响应体。
 * @param model 模型 id（回填到结果里）。
 */
export function parseCloudBody(body: string, model: string): CloudResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      ok: false,
      reason: 'payload',
      detail: `响应不是 JSON：${body.slice(0, 160).replace(/\s+/g, ' ')}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'payload', detail: '响应是 JSON 但不是对象' }
  }
  const root = parsed as Record<string, unknown>
  const text = (stringOr(root['text']) ?? '').replace(/[ \t]+/g, ' ').trim()

  const spans: TranscriptSpan[] = []
  const list = root['segments']
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const start = numberOr(record['start'])
      const end = numberOr(record['end'])
      if (start === undefined || end === undefined) continue
      const piece = stringOr(record['text']) ?? ''
      const speaker = stringOr(record['speaker'])
      spans.push({
        startMs: Math.max(0, Math.round(start * 1000)),
        endMs: Math.max(0, Math.round(end * 1000)),
        text: piece,
        speaker: speaker === '' ? undefined : speaker,
      })
    }
  }

  if (text === '' && spans.length === 0) {
    return { ok: false, reason: 'empty', detail: '云端回了空文本（静音、纯噪音，或服务拒答）' }
  }
  return {
    ok: true,
    text: text === '' ? spans.map(span => span.text).join('').trim() : text,
    spans,
    language: stringOr(root['language']) ?? undefined,
    model,
  }
}

/**
 * 上传用的文件名：保留原主名，扩展名按 MIME 补。
 * @param source 源路径。
 * @param mime MIME。
 */
export function uploadNameOf(source: string, mime: string): string {
  const base = source.slice(Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = EXT_BY_MIME[mime] ?? 'bin'
  return `${stem === '' ? 'audio' : stem}.${ext}`
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
