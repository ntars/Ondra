/**
 * 分支 A：macOS `say`（零依赖、最稳）。
 *
 * ## 为什么它排在 `auto` 的第二顺位
 *
 * 手册 §9.4 的优先级是 `local(GPT-SoVITS) > macos-say > none`：
 * 本地神经网络音色更好，`say` 是「一定在那儿」的兜底。master-plan §14.3
 * 把 `say` 写成「默认最稳」，指的是**失败率**，不是排位——干净机器上没有
 * GPT-SoVITS，`auto` 自然会落到这里，两者并不冲突（见 README 「口径」一节）。
 *
 * ## 三个必须踩准的系统细节
 *
 * 1. **文本走文件（`-f`），不走参数。** `say "…"` 遇到以 `-` 开头的文本会被
 *    当成选项；回复里偶尔就有「——算了」。写进临时文件再 `-f`，一条歧义都不剩。
 * 2. **必须显式给 `--file-format=WAVE`。** 输出路径是 `xxx.wav.part`，
 *    扩展名不是 `.wav`，`say` 靠扩展名猜格式会猜错（默认 AIFF），
 *    于是「合成了但播不出来」。
 * 3. **没有音量参数。** `say` 只有 `-v` / `-r` / `-o` / `-f` 这一套，
 *    强行传一个不存在的东西会直接失败。所以 `volume` 在这一支被忽略，
 *    且要在结果里说清（`rateApplied` 为真、音量不适用）。
 */

import { unlink, writeFile } from 'node:fs/promises'
import type { ExecLike, SpeechEngine, SynthRequest, SynthResult } from '../types.js'

/** 系统 `say` 的固定路径。用绝对路径而不是依赖 PATH：PATH 被裁剪过的 App 里 `say` 找不到。 */
export const SAY_PATH = '/usr/bin/say'

/** 构造参数。 */
export interface MacSayOptions {
  /** `process.platform`。 */
  readonly platform: string
  /** 文件存在性判定（注入以便自检，不实装运行）。 */
  readonly exists: (path: string) => boolean
  readonly exec: ExecLike
  readonly timeoutMs: number
  /** 系统音色名（`say -v` 那一列，例如 `Tingting`）。 */
  readonly voice: string
  /** 基准语速（词/分钟）。 */
  readonly wpm: number
}

/** `say -r` 的取值范围（低到听不清 / 高到像快进）。 */
export const WPM_FLOOR = 60
export const WPM_CEIL = 600

/**
 * 把相对语速增量换算成 `say` 的「词/分钟」。
 * @param wpm 基准语速。
 * @param rate 相对增量（0.1 = 快一成）。
 */
export function wpmOf(wpm: number, rate: number): number {
  const scaled = Math.round(wpm * (1 + rate))
  return Math.min(WPM_CEIL, Math.max(WPM_FLOOR, scaled))
}

/** macOS 系统语音分支。 */
export class MacSayEngine implements SpeechEngine {
  readonly name = 'macos-say' as const

  private readonly options: MacSayOptions

  constructor(options: MacSayOptions) {
    this.options = options
  }

  /** 这一支只用系统音色名：请求里带的 Edge 音色 id 在这里没有意义。 */
  get voice(): string {
    return this.options.voice
  }

  get present(): boolean {
    return this.options.platform === 'darwin' && this.options.exists(SAY_PATH)
  }

  get configured(): boolean {
    return this.options.voice !== ''
  }

  get detail(): string {
    if (this.options.platform !== 'darwin') return '不是 macOS'
    if (!this.options.exists(SAY_PATH)) return '找不到 /usr/bin/say'
    if (this.options.voice === '') return '没配系统音色名'
    return '就绪（系统音色 ' + this.options.voice + '）'
  }

  async synth(request: SynthRequest): Promise<SynthResult> {
    const textPath = request.outPath + '.txt'
    try {
      await writeFile(textPath, request.text, 'utf8')
    } catch {
      // 写不了临时文本就等于起不来：原因码归 `spawn`（同一类失败，同一类排查）。
      return { ok: false, reason: 'spawn', ext: 'wav', rateApplied: true, voice: this.options.voice }
    }

    const result = await this.options.exec(
      SAY_PATH,
      [
        '-f',
        textPath,
        '-o',
        request.outPath,
        '-v',
        this.options.voice,
        '-r',
        String(wpmOf(this.options.wpm, request.rate)),
        '--file-format=WAVE',
        '--data-format=LEI16@22050',
      ],
      { timeoutMs: this.options.timeoutMs },
    )

    // 临时文本必须删：它含完整原文，留着就是在缓存目录里堆一份可读的对话记录。
    try {
      await unlink(textPath)
    } catch {
      // 删不掉不影响结果（缓存淘汰只看音频文件）。
    }

    const base = { ext: 'wav' as const, rateApplied: true, voice: this.options.voice }
    if (result.timedOut) return { ok: false, reason: 'timeout', ...base }
    if (!result.ok) return { ok: false, reason: 'spawn', ...base }
    return { ok: true, reason: 'ok', ...base }
  }
}
