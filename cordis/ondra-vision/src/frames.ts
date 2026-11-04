/**
 * 视频抽帧：**唯一**起子进程的地方。
 *
 * ## 为什么是 ffmpeg，而不是自己解容器
 *
 * 解 MP4 / MKV / MOV 的容器与编码是「难度极高、体量巨大」那一类（§11.3 允许引入
 * 的唯一情形），本轮又禁止装依赖。ffmpeg 是这台机器上最可能已经装好的东西，
 * 所以本包只做**接线**：拼一条命令、等它结束、把产物路径交出去。
 * 找不到就 `no-ffmpeg`——**不影响看图**，两个能力互不拖累。
 *
 * ## 为什么用 `thumbnail` 滤镜，而不是按时间戳 seek
 *
 * 按时间戳抽帧要先知道时长（要 `ffprobe`，多一个二进制），而且很容易抽到黑场
 * 与转场。`thumbnail` 滤镜在每批 100 帧里挑**最具代表性**的一帧（它算的是
 * 直方图距离），正好对上「视频→4 帧」这条要求里「帧」的含义：让人一眼看出
 * 这段视频大概在讲什么。
 *
 * ## 为什么帧目录要自己记着
 *
 * 帧是**临时产物**：不进库、不进记忆，调用方用完就该没。散着建目录、不记，
 * 后果是 `~/Library/Caches` 里一年后堆着几万个 jpg 而没人知道是谁建的。
 * 这里把建过的目录集中成一个集合，`dispose()` 一次清掉；**只清自己建的那些**。
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { FramesResult, LogLike, PathLayoutLike } from './types.js'
import { fnv1a64 } from './text.js'

/** 子进程输出保留的字符数（报错通常在最后一行）。 */
const OUTPUT_LIMIT = 4096

/** 一次 ffmpeg 运行的结果。 */
interface RunResult {
  readonly ok: boolean
  readonly code: number
  readonly stderr: string
  readonly timedOut: boolean
}

/** 抽帧依赖。 */
export interface FrameDeps {
  /** ffmpeg 可执行文件（名字或绝对路径）。 */
  readonly ffmpegPath: string
  /** 单次超时（毫秒）。转码比推理慢，调用方给的是两倍。 */
  readonly timeoutMs: number
  readonly log: LogLike
  /** 临时目录来源；缺席时退回系统临时目录。 */
  readonly pathLayout: () => PathLayoutLike | undefined
}

/**
 * 按 PATH 找一个可执行文件。**只查文件是否存在，不执行**。
 *
 * 不跑 `ffmpeg -version` 的原因：那是 30–200ms 的启动开销，而它只用来回答
 * 「在不在」。版本号对抽帧没有用（`thumbnail` 滤镜 2013 年就有了）。
 * @param name 名字或绝对路径。
 */
export function whichSync(name: string): string | undefined {
  if (name.trim() === '') return undefined
  if (isAbsolute(name)) return existsSync(name) ? name : undefined
  const path = process.env['PATH'] ?? ''
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 不存在就继续找。这里刻意不 break：PATH 里同一个名字可能出现在多处。
    }
  }
  return undefined
}

/** 抽帧器。一个实例 = 一批可被一次性收尾的子进程与临时目录。 */
export class FrameGrabber {
  private readonly children = new Set<ChildProcess>()
  private readonly dirs = new Set<string>()
  private readonly deps: FrameDeps
  private disposed = false
  private sequence = 0

  constructor(deps: FrameDeps) {
    this.deps = deps
  }

  /** 本机有没有 ffmpeg（面板读这个决定「抽帧」按钮亮不亮）。 */
  get available(): boolean {
    return whichSync(this.deps.ffmpegPath) !== undefined
  }

  /** 还没结束的子进程数。 */
  get pending(): number {
    return this.children.size
  }

  /**
   * 抽 N 帧。**永不抛错**。
   * @param source 视频绝对路径。
   * @param count 张数。
   * @param signal 取消信号。
   */
  async grab(source: string, count: number, signal?: AbortSignal): Promise<FramesResult> {
    const startedAt = Date.now()
    const binary = whichSync(this.deps.ffmpegPath)
    if (binary === undefined) {
      return {
        ok: false,
        reason: 'no-ffmpeg',
        frames: [],
        elapsedMs: Date.now() - startedAt,
        detail: `找不到 ${this.deps.ffmpegPath}（按 PATH 找）。装好 ffmpeg 后不用改配置`,
      }
    }
    if (!existsSync(source)) {
      return {
        ok: false,
        reason: 'missing',
        frames: [],
        elapsedMs: Date.now() - startedAt,
        detail: `视频不存在：${source}`,
      }
    }
    if (this.disposed) {
      return {
        ok: false,
        reason: 'no-ffmpeg',
        frames: [],
        elapsedMs: Date.now() - startedAt,
        detail: '抽帧器已卸载',
      }
    }

    let dir: string
    try {
      dir = this.makeDir(source)
    } catch (error) {
      return {
        ok: false,
        reason: 'missing',
        frames: [],
        elapsedMs: Date.now() - startedAt,
        detail: `建临时目录失败：${textOf(error)}`,
      }
    }

    const pattern = join(dir, 'frame-%02d.jpg')
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      source,
      '-vf',
      'thumbnail=100',
      '-frames:v',
      String(count),
      '-start_number',
      '1',
      pattern,
    ]

    const run = await this.run(binary, args, this.deps.timeoutMs, signal)
    if (!run.ok) {
      this.removeDir(dir)
      const reason = run.timedOut ? 'timeout' : 'payload'
      return {
        ok: false,
        reason,
        frames: [],
        elapsedMs: Date.now() - startedAt,
        detail: run.timedOut
          ? `ffmpeg 超过 ${this.deps.timeoutMs} 毫秒没结束`
          : `ffmpeg 退出码 ${run.code}：${run.stderr.slice(-240)}`,
      }
    }

    const frames = this.listFrames(dir)
    if (frames.length === 0) {
      this.removeDir(dir)
      return {
        ok: false,
        reason: 'payload',
        frames: [],
        elapsedMs: Date.now() - startedAt,
        detail: 'ffmpeg 正常退出但没有产出帧（可能不是视频文件）',
      }
    }
    return { ok: true, reason: 'ok', frames, dir, elapsedMs: Date.now() - startedAt }
  }

  /** 清掉本实例建过的所有目录。**幂等**。 */
  dispose(): void {
    this.disposed = true
    for (const child of this.children) {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已经结束的进程 kill 会抛 ESRCH，忽略。
      }
    }
    this.children.clear()
    for (const dir of [...this.dirs]) this.removeDir(dir)
  }

  /** 建一个本次调用独占的子目录（0700，只在自己名下）。 */
  private makeDir(source: string): string {
    const layout = this.deps.pathLayout()
    let root: string
    if (layout !== undefined) {
      root = layout.ensure('tmp', 'vision-frames')
    } else {
      root = join(tmpdir(), 'ondra-vision-frames')
      mkdirSync(root, { recursive: true, mode: 0o700 })
    }
    this.sequence += 1
    // 目录名带指纹与序号：同一段视频抽两次不会互相覆盖，也不会因为并发而混帧。
    const name = `f-${fnv1a64(source).slice(0, 8)}-${this.sequence}`
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.dirs.add(dir)
    return dir
  }

  /** 列出产物，按文件名排序（`frame-01` 到 `frame-04` 天然有序）。 */
  private listFrames(dir: string): readonly string[] {
    try {
      return readdirSync(dir)
        .filter(name => name.endsWith('.jpg'))
        .sort()
        .map(name => join(dir, name))
    } catch {
      return []
    }
  }

  /** 删自己建的目录。失败不报错（临时目录，删不掉也不影响正确性）。 */
  private removeDir(dir: string): void {
    this.dirs.delete(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      this.deps.log.debug('清理帧目录失败（忽略）：%s', textOf(error))
    }
  }

  /**
   * 起一个子进程并等它结束。**永不抛错**。
   * @param command 可执行文件。
   * @param args 参数。
   * @param timeoutMs 超时。
   * @param signal 取消信号。
   */
  private run(
    command: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return new Promise<RunResult>(resolve => {
      let settled = false
      let stderr = ''
      let timer: ReturnType<typeof setTimeout> | undefined
      let child: ChildProcess | undefined

      const finish = (result: RunResult): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        if (child !== undefined) this.children.delete(child)
        resolve(result)
      }

      const onAbort = (): void => {
        try {
          child?.kill('SIGKILL')
        } catch {
          // 进程可能已经结束。
        }
        finish({ ok: false, code: -1, stderr: '调用方取消', timedOut: false })
      }

      let spawned: ChildProcess
      try {
        spawned = spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
      } catch (error) {
        // spawn 同步抛错只发生在参数非法时；此时还没有子进程，直接回。
        settled = true
        resolve({ ok: false, code: -1, stderr: textOf(error), timedOut: false })
        return
      }

      child = spawned
      this.children.add(spawned)

      spawned.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (stderr.length > OUTPUT_LIMIT) stderr = stderr.slice(stderr.length - OUTPUT_LIMIT)
      })

      timer = setTimeout(() => {
        try {
          spawned.kill('SIGKILL')
        } catch {
          // 已结束。
        }
        finish({ ok: false, code: -1, stderr, timedOut: true })
      }, timeoutMs)
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        ;(timer as { unref(): void }).unref()
      }

      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      spawned.on('error', (error: Error) => {
        finish({ ok: false, code: -1, stderr: `${stderr}${textOf(error)}`, timedOut: false })
      })
      spawned.on('close', (code: number | null) => {
        finish({ ok: code === 0, code: code ?? -1, stderr, timedOut: false })
      })
    })
  }
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
