/**
 * 播放：把一段音频放出来。
 *
 * ## 为什么播放要和合成分开
 *
 * 通道发语音条（`play: false`）、面板上的「试听」、导出音频都要「只要文件」；
 * 而主对话要「直接出声」。把播放钉死在合成里，前两种场景就得再写一条绕路。
 * 所以 `speak()` = `synth()` + `play()`，`synth()` 单独可用。
 *
 * ## 为什么 `afplay` 不自己写解码
 *
 * 平台自带、零依赖、wav/mp3 都吃。反过来，用 Node 解音频再推给系统输出，
 * 是给自己造一个「音频线程 + 缓冲 + 设备选择」的坑，且在无音频设备的
 * 机器上表现极不稳定。§1.8 的口径就是「能复用别自研」。
 *
 * ## 播放失败不等于合成失败
 *
 * `afplay` 挂掉（没有输出设备、被系统静音策略拦住）时，音频文件还在缓存里，
 * 面板可以「重播」。因此这一层只返回布尔，原因码由服务层记成 `playback`，
 * **不覆盖**已经拿到的音频路径。
 */

import { fileExists } from './exec.js'
import type { ExecLike } from './types.js'

/** 系统播放器的固定路径。 */
export const AFPLAY_PATH = '/usr/bin/afplay'

/**
 * 播放超时。
 *
 * 与合成超时分开：合成是「等一段算力」，播完是「等一段声音」。
 * 15 秒的合成超时套在一段 40 秒的语音上，会把她说到一半掐掉。
 */
export const PLAY_TIMEOUT_MS = 60000

/** 构造参数。 */
export interface PlayerOptions {
  readonly platform: string
  readonly exists: (path: string) => boolean
  readonly exec: ExecLike
}

/** 系统播放器。 */
export class Player {
  private readonly options: PlayerOptions

  constructor(options: PlayerOptions) {
    this.options = options
  }

  /** 现在能不能出声。 */
  get available(): boolean {
    return this.options.platform === 'darwin' && this.options.exists(AFPLAY_PATH)
  }

  /**
   * 播一个文件，等它播完。**永不抛错**。
   * @param path 音频绝对路径。
   * @returns 是否播完（失败为 `false`）。
   */
  async play(path: string): Promise<boolean> {
    if (!this.available) return false
    if (!fileExists(path)) return false
    const result = await this.options.exec(AFPLAY_PATH, [path], { timeoutMs: PLAY_TIMEOUT_MS })
    return result.ok
  }
}
