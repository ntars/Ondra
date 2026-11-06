/**
 * 分支 B：本地 GPT-SoVITS（`api_v2` 的 `/tts`）。
 *
 * ## 为什么这条是第一顺位
 *
 * 手册 §9.4 的优先级原话是 `local(GPT-SoVITS) > macos-say > none`：
 * 本机神经网络音色（自己的角色音）明显好过系统合成音，代价是要用户自己起服务。
 * `auto` 只在它**配置齐了**（有参考音频 + 本机地址）时才选它，否则落到 `say`。
 *
 * ## 只允许本机地址
 *
 * `endpoint` 必须解析到 `127.0.0.1` / `localhost` / `::1`。理由不是洁癖：
 * 一个能被配置改成任意地址的「朗读」接口，等于给配置面板开了一个
 * 可以往任意主机 POST 文本的通道。写死回环，这一路就没有第二种用法。
 *
 * ## 语速：**不传**
 *
 * `api_v2` 里有 `speed_factor`，但它与「参考音频的音色」耦合，
 * 各版本取值口径不一致（有人 1.0 是原速，有人 0–1 是比例）。
 * 猜一个值传进去，可能出现「语速变了、音色也飘了」。因此本分支
 * 恒报 `rateApplied: false`，面板要能看见「这次设的语速没生效」。
 *
 * ## 参考文本可空
 *
 * `prompt_text` 是参考音频对应的文字。空串在多数版本可用（音色会更飘），
 * 少数版本会 400。**不猜**：空就传空串，真 400 就如实报 `http` 并把
 * 服务端的错误体带回来（`src/http.ts` 已经把 JSON 错误体识别出来）。
 */

import { postJsonForAudio } from '../http.js'
import type { HttpDeps } from '../http.js'
import { writeBinary } from '../cache.js'
import type { SpeechEngine, SynthRequest, SynthResult } from '../types.js'

/** 构造参数。 */
export interface GsvOptions {
  /** 服务根地址，例如 `http://127.0.0.1:9880`。 */
  readonly endpoint: string
  /** 参考音频绝对路径。空串表示未配置。 */
  readonly refAudio: string
  /** 参考音频对应的文字。可空。 */
  readonly promptText: string
  /** 合成语种。 */
  readonly lang: 'zh' | 'en' | 'ja' | 'ko' | 'auto'
  /** 网络出口。 */
  readonly http: HttpDeps
}

/** 回环地址集。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'])

/**
 * 判一个地址是不是本机回环。
 * @param endpoint 服务根地址。
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
  return LOOPBACK_HOSTS.has(host)
}

/**
 * 拼 `/tts` 地址（容忍结尾多一个斜杠）。
 * @param endpoint 服务根地址。
 */
export function ttsUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, '') + '/tts'
}

/** GPT-SoVITS 分支。 */
export class GptSovitsEngine implements SpeechEngine {
  readonly name = 'gpt-sovits' as const

  private readonly options: GsvOptions

  constructor(options: GsvOptions) {
    this.options = options
  }

  get present(): boolean {
    // 服务活不活只能合成时才知道；这里只回答「有没有条件去试」。
    return this.configured && this.options.http.fetch !== undefined
  }

  get configured(): boolean {
    return this.options.refAudio !== '' && isLoopbackEndpoint(this.options.endpoint)
  }

  get detail(): string {
    if (this.options.refAudio === '') return '未配置参考音频（它必须有音色样本）'
    if (!isLoopbackEndpoint(this.options.endpoint)) return '地址不是本机回环，已拒绝'
    if (this.options.http.fetch === undefined) return '运行时没有 fetch'
    return '已配置（服务是否在跑需合成时才知道）'
  }

  async synth(request: SynthRequest): Promise<SynthResult> {
    const base = { ext: 'wav' as const, rateApplied: false, voice: request.voice }
    if (!this.configured) return { ok: false, reason: 'not-configured', ...base }

    const outcome = await postJsonForAudio(
      ttsUrl(this.options.endpoint),
      {
        text: request.text,
        text_lang: this.options.lang,
        ref_audio_path: this.options.refAudio,
        prompt_text: this.options.promptText,
        prompt_lang: this.options.lang,
        text_split_method: 'cut5',
        media_type: 'wav',
        streaming_mode: false,
      },
      this.options.http,
    )

    if (!outcome.ok) {
      // `HttpFailure` 的四个码是 `TtsReason` 的子集，直接透传，不再映射一遍。
      return { ok: false, reason: outcome.reason, ...base }
    }

    try {
      await writeBinary(request.outPath, outcome.bytes)
    } catch {
      // 拿到了音频但写不下（磁盘满、权限）——合成是成功的，落盘失败。
      return { ok: false, reason: 'spawn', ...base }
    }

    return { ok: true, reason: 'ok', bytes: outcome.bytes.byteLength, ...base }
  }
}
