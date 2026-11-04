/**
 * 分支 C：Edge TTS（19 音色的来源）。
 *
 * ## 为什么是「外部 CLI 对接」而不是「装一个包」
 *
 * 本仓禁装依赖（本轮纪律），而 Edge TTS 的服务端是微软的公开端点，
 * 生态里的成熟实现（`rany2/edge-tts`）已经把「取 token → WSS → 拼 mp3」
 * 这一套做完了。这里**不引入它的代码**，只以外部进程对接——与 §12.3
 * 对 NapCat 的处理同一条纪律：不复制、只调用。
 *
 * 代价写在 README「已知限制」：用户得自己装 `edge-tts`；没装就是
 * `no-engine`，不会有人替他偷偷装。
 *
 * ## 为什么这条排在 `auto` 的最后
 *
 * 它要两样东西：一个外部 CLI + 一条到微软端点的网络。前两条通道缺一样
 * 都还能出声，它缺任一样就整条不可用。作为「兜底之后的补充」才合理。
 *
 * ## 语速与音量的写法
 *
 * `edge-tts` 的参数是**带符号的百分比字符串**（`+10%` / `-15%`），
 * 不是分数。传 `0.1` 会被 CLI 当成非法值直接退出，而错误信息里只有
 * 「invalid rate」——所以换算必须在这一层做完。
 */

import type { ExecLike, SpeechEngine, SynthRequest, SynthResult } from '../types.js'

/** 构造参数。 */
export interface EdgeOptions {
  /** 配置里的可执行文件名（面板要显示用户填了什么）。 */
  readonly bin: string
  /** 按 PATH 解析出来的绝对路径（没找到为 `undefined`）。 */
  readonly resolved: string | undefined
  readonly exec: ExecLike
  readonly timeoutMs: number
}

/**
 * 相对语速 → CLI 的百分比字符串。
 * @param rate 相对增量（0.1 = 快一成）。
 */
export function rateArg(rate: number): string {
  const percent = Math.round(rate * 100)
  return (percent >= 0 ? '+' : '') + String(percent) + '%'
}

/**
 * 音量档 → CLI 的百分比字符串。
 *
 * 手册只说「音量低」，没给数字 → 取 −20%（听得出变小，但不至于听不见）。
 * @param volume 音量档。
 */
export function volumeArg(volume: 'normal' | 'low'): string {
  return volume === 'low' ? '-20%' : '+0%'
}

/** Edge TTS 分支。 */
export class EdgeTtsEngine implements SpeechEngine {
  readonly name = 'edge-tts' as const

  private readonly options: EdgeOptions

  constructor(options: EdgeOptions) {
    this.options = options
  }

  get present(): boolean {
    return this.options.resolved !== undefined
  }

  get configured(): boolean {
    return true
  }

  get detail(): string {
    if (this.options.resolved === undefined) {
      return '找不到 ' + this.options.bin + '（需自行安装 edge-tts）'
    }
    return '就绪（' + this.options.resolved + '）'
  }

  async synth(request: SynthRequest): Promise<SynthResult> {
    const command = this.options.resolved
    const base = { ext: 'mp3' as const, rateApplied: true, voice: request.voice }
    if (command === undefined) return { ok: false, reason: 'no-engine', ...base }

    const result = await this.options.exec(
      command,
      [
        '--voice',
        request.voice,
        '--rate',
        rateArg(request.rate),
        '--volume',
        volumeArg(request.volume),
        '--text',
        request.text,
        '--write-media',
        request.outPath,
      ],
      { timeoutMs: this.options.timeoutMs },
    )

    if (result.timedOut) return { ok: false, reason: 'timeout', ...base }
    if (!result.ok) {
      // 音色名被服务端拒绝（表过期、或这个音色已下线）与「网络挂了」
      // 都要给不同的码：前者换一个音色就好，后者换音色没用。
      if (/invalid voice|voice not found|no audio was received/i.test(result.stderr)) {
        return { ok: false, reason: 'voice-unknown', ...base }
      }
      return { ok: false, reason: 'spawn', ...base }
    }
    return { ok: true, reason: 'ok', ...base }
  }
}
