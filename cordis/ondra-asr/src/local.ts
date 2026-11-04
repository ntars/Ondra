/**
 * 本地 whisper：**本包唯一**起子进程的地方。
 *
 * ## 为什么是 whisper.cpp 的命令行，而不是绑一个 Node 包
 *
 * 手册要求「本地 whisper 优先」，而 whisper.cpp 是这台机器上最可能已经装好的
 * 那一份（Homebrew 一条命令）。绑 `nodejs-whisper` 之类的包要装依赖、要编译、
 * 还要跟着 Node 版本走；本轮禁止装依赖，而「起一个已有的可执行文件」属于接线。
 *
 * ## 为什么先转成 16 kHz 单声道 WAV
 *
 * whisper.cpp 的命令行只吃这种规格（除非编译时带了 FFmpeg 支持，而那是发行版
 * 差异，不能假设）。QQ / 微信的语音是 amr / silk / mp3，直接喂进去会得到
 * 「failed to read audio file」——用户看到的是「转写坏了」，实际是格式不对。
 *
 * 所以：**不是合规 WAV 就先用 ffmpeg 转一份**。没有 ffmpeg 时仍然直接试一次
 * （有些构建支持），失败再如实报错，而不是提前放弃。
 *
 * ## 为什么临时目录要自己记着
 *
 * 转出来的 wav 与 whisper 写的 json 都是**一次性产物**：不进库、不进记忆。
 * 不记就会在临时目录里越堆越多。这里集中成一个集合，`dispose()` 一次清掉，
 * **只清自己建的那些**。
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { AsrReason, LogLike, TranscriptSpan } from './types.js'
import { isWhisperWav, wavInfo } from './audio.js'
import { numberOr, stringOr } from './text.js'

/** 子进程输出保留的字符数（报错通常在最后一行）。 */
const OUTPUT_LIMIT = 4096

/** 一次子进程运行的结果。 */
interface RunResult {
  readonly ok: boolean
  readonly code: number
  readonly stderr: string
  readonly timedOut: boolean
}

/** 本地转写的结果。 */
export type LocalResult =
  | {
    readonly ok: true
    readonly text: string
    readonly spans: readonly TranscriptSpan[]
    readonly language?: string
    readonly model: string
    /** 降级说明（例如「没有 ffmpeg，直接喂了原文件」）。 */
    readonly degraded?: string
  }
  | { readonly ok: false; readonly reason: AsrReason; readonly detail: string }

/** 本地转写依赖。 */
export interface LocalDeps {
  readonly binary: string
  readonly modelPath: string
  readonly threads: number
  readonly timeoutMs: number
  readonly ffmpegPath: string
  readonly log: LogLike
  /** 临时目录根（由 service 解析：O-002 的 tmp 区，或系统临时目录）。 */
  readonly tmpRoot: () => string
}

/**
 * 按 PATH 找一个可执行文件。**只查文件是否存在，不执行**。
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
      // 不存在就继续找：PATH 里同一个名字可能出现在多处。
    }
  }
  return undefined
}

/** whisper 写的 JSON 的解析结果。 */
export interface WhisperJson {
  readonly text: string
  readonly spans: readonly TranscriptSpan[]
  readonly language?: string
}

/**
 * 解析 whisper.cpp 的 `-oj` 输出。
 *
 * 两个版本细节必须容错，否则「本地转写永远返回空」：
 * 1. 段列表在 `transcription`（新版）或 `segments`（部分构建）；
 * 2. 时间在 `offsets.from/to`（毫秒）或 `timestamps.from_us/to_us`（微秒）。
 *
 * 解析不出段就退回顶层 `text`（有些构建只写这一项），并把 `spans` 留空——
 * **不编时间戳**：编出来的时间会让下游以为「这句话在第 3 秒」。
 * @param raw JSON 文本。
 */
export function parseWhisperJson(raw: string): WhisperJson | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const root = parsed as Record<string, unknown>

  const language = languageOf(root)
  const list = Array.isArray(root['transcription'])
    ? (root['transcription'] as unknown[])
    : Array.isArray(root['segments'])
      ? (root['segments'] as unknown[])
      : []

  const spans: TranscriptSpan[] = []
  const pieces: string[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const text = stringOr(record['text']) ?? ''
    if (text !== '') pieces.push(text)

    const span = spanOf(record, text)
    if (span !== undefined) spans.push(span)
  }

  const joined = normalize(pieces.join(''))
  const top = normalize(stringOr(root['text']) ?? '')
  const text = joined !== '' ? joined : top
  if (text === '' && spans.length === 0) return { text: '', spans: [], language }
  return { text, spans, language }
}

/** 取语言：新版在 `result.language`，旧版在顶层 `language`。 */
function languageOf(root: Record<string, unknown>): string | undefined {
  const direct = stringOr(root['language'])
  if (direct !== undefined && direct !== '') return direct
  const result = root['result']
  if (typeof result === 'object' && result !== null) {
    const nested = stringOr((result as Record<string, unknown>)['language'])
    if (nested !== undefined && nested !== '') return nested
  }
  return undefined
}

/** 取一段的时间；两种单位都换算成毫秒。 */
function spanOf(record: Record<string, unknown>, text: string): TranscriptSpan | undefined {
  const offsets = record['offsets']
  if (typeof offsets === 'object' && offsets !== null) {
    const from = numberOr((offsets as Record<string, unknown>)['from'])
    const to = numberOr((offsets as Record<string, unknown>)['to'])
    if (from !== undefined && to !== undefined) {
      return { startMs: Math.max(0, Math.round(from)), endMs: Math.max(0, Math.round(to)), text: text.trim() }
    }
  }
  const stamps = record['timestamps']
  if (typeof stamps === 'object' && stamps !== null) {
    const fromUs = numberOr((stamps as Record<string, unknown>)['from_us'])
    const toUs = numberOr((stamps as Record<string, unknown>)['to_us'])
    if (fromUs !== undefined && toUs !== undefined) {
      return {
        startMs: Math.max(0, Math.round(fromUs / 1000)),
        endMs: Math.max(0, Math.round(toUs / 1000)),
        text: text.trim(),
      }
    }
  }
  return undefined
}

/** 归一化转写正文：段与段之间原本靠前导空格分隔，压掉多余空白但保留单词间隔。 */
function normalize(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim()
}

/** 本地 whisper 转写器。 */
export class LocalWhisper {
  private readonly deps: LocalDeps
  private readonly children = new Set<ChildProcess>()
  private readonly dirs = new Set<string>()
  private disposed = false
  private sequence = 0

  constructor(deps: LocalDeps) {
    this.deps = deps
  }

  /** whisper 二进制在不在。 */
  get binaryPath(): string | undefined {
    return whichSync(this.deps.binary)
  }

  /** 模型文件在不在。 */
  get modelPath(): string | undefined {
    const path = this.deps.modelPath.trim()
    if (path === '') return undefined
    return existsSync(path) ? path : undefined
  }

  /** 本地这条路能不能走。 */
  get ready(): boolean {
    return this.binaryPath !== undefined && this.modelPath !== undefined
  }

  /** 不能走的原因（能走则为 `undefined`）。 */
  get reason(): AsrReason | undefined {
    if (this.binaryPath === undefined) return 'no-binary'
    if (this.modelPath === undefined) return 'no-model'
    return undefined
  }

  /**
   * 转写一段音频。**永不抛错**。
   * @param source 源文件绝对路径。
   * @param bytes 源文件内容（用来判 WAV 规格）。
   * @param mime 源文件 MIME。
   * @param language 语言提示（已归一化，空串即自动）。
   * @param signal 取消信号。
   */
  async transcribe(
    source: string,
    bytes: Uint8Array,
    mime: string,
    language: string,
    signal?: AbortSignal,
  ): Promise<LocalResult> {
    if (this.disposed) return { ok: false, reason: 'disposed', detail: '本地转写器已卸载' }

    const binary = this.binaryPath
    if (binary === undefined) {
      return {
        ok: false,
        reason: 'no-binary',
        detail: `找不到 ${this.deps.binary}（按 PATH 找）。whisper.cpp 新版叫 whisper-cli，旧版叫 main`,
      }
    }
    const model = this.modelPath
    if (model === undefined) {
      return {
        ok: false,
        reason: 'no-model',
        detail:
          this.deps.modelPath.trim() === ''
            ? '没有配模型文件路径（whisper 的 -m 没有默认值）'
            : `模型文件不存在：${this.deps.modelPath}`,
      }
    }

    let dir: string
    try {
      dir = this.makeDir()
    } catch (error) {
      return { ok: false, reason: 'payload', detail: `建临时目录失败：${textOf(error)}` }
    }

    // 已经是合规 WAV 就直接用源文件：不复制、不转码，省一次 IO。
    let audioPath = source
    let degraded: string | undefined
    const compliant = mime === 'audio/wav' && isWhisperWav(wavInfo(bytes))
    if (!compliant) {
      const converted = await this.convert(source, dir, signal)
      if (converted.ok) {
        audioPath = converted.path
      } else {
        // 没有 ffmpeg（或转码失败）：仍然直接试一次原文件。
        // 有些 whisper.cpp 构建带 FFmpeg 支持，能直接读 mp3 / m4a。
        degraded = `没有转码（${converted.detail}），直接喂了原文件`
        this.deps.log.debug('转码未成功，改为直接尝试原文件：%s', converted.detail)
      }
    }

    const outBase = join(dir, 'out')
    const args = [
      '-m',
      model,
      '-f',
      audioPath,
      '-oj',
      '-of',
      outBase,
      '-t',
      String(this.deps.threads),
      '-l',
      language === '' ? 'auto' : language,
    ]

    const run = await this.run(binary, args, this.deps.timeoutMs, signal)
    const jsonPath = `${outBase}.json`
    if (!run.ok) {
      const reason: AsrReason = run.timedOut ? 'timeout' : 'payload'
      this.removeDir(dir)
      return {
        ok: false,
        reason,
        detail: run.timedOut
          ? `whisper 超过 ${this.deps.timeoutMs} 毫秒没结束`
          : `whisper 退出码 ${run.code}：${run.stderr.slice(-240)}`,
      }
    }

    if (!existsSync(jsonPath)) {
      this.removeDir(dir)
      return {
        ok: false,
        reason: 'payload',
        detail: `whisper 正常退出但没有写出 ${jsonPath}（这个版本可能不支持 -oj）`,
      }
    }

    let raw: string
    try {
      raw = readFileSync(jsonPath, 'utf8')
    } catch (error) {
      this.removeDir(dir)
      return { ok: false, reason: 'payload', detail: `读转写结果失败：${textOf(error)}` }
    }
    this.removeDir(dir)

    const parsed = parseWhisperJson(raw)
    if (parsed === undefined) {
      return { ok: false, reason: 'payload', detail: 'whisper 写的 JSON 解析不出来' }
    }
    return {
      ok: true,
      text: parsed.text,
      spans: parsed.spans,
      language: parsed.language,
      model: baseName(model),
      degraded,
    }
  }

  /** 清掉本实例建过的目录与进程。**幂等**。 */
  dispose(): void {
    this.disposed = true
    for (const child of this.children) {
      try {
        child.kill('SIGKILL')
      } catch {
        // 已结束的进程 kill 会抛 ESRCH，忽略。
      }
    }
    this.children.clear()
    for (const dir of [...this.dirs]) this.removeDir(dir)
  }

  /** 用 ffmpeg 转成 16 kHz 单声道 16 位 WAV。 */
  private async convert(
    source: string,
    dir: string,
    signal?: AbortSignal,
  ): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly detail: string }> {
    const ffmpeg = whichSync(this.deps.ffmpegPath)
    if (ffmpeg === undefined) {
      return { ok: false, detail: `找不到 ${this.deps.ffmpegPath}` }
    }
    const target = join(dir, 'audio.wav')
    const run = await this.run(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        source,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        target,
      ],
      this.deps.timeoutMs,
      signal,
    )
    if (!run.ok) {
      return { ok: false, detail: `ffmpeg 退出码 ${run.code}：${run.stderr.slice(-160)}` }
    }
    if (!existsSync(target)) return { ok: false, detail: 'ffmpeg 正常退出但没有写出 wav' }
    return { ok: true, path: target }
  }

  /** 建一个本次调用独占的子目录（0700）。 */
  private makeDir(): string {
    const root = this.deps.tmpRoot()
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.sequence += 1
    const dir = join(root, `a-${this.sequence}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.dirs.add(dir)
    return dir
  }

  /** 删自己建的目录。失败不报错。 */
  private removeDir(dir: string): void {
    this.dirs.delete(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      this.deps.log.debug('清理转写临时目录失败（忽略）：%s', textOf(error))
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
          // 已结束。
        }
        finish({ ok: false, code: -1, stderr: '调用方取消', timedOut: false })
      }

      let spawned: ChildProcess
      try {
        spawned = spawn(command, [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
      } catch (error) {
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

/** 取路径里的文件名（模型名给面板看，别把整条路径抖出来）。 */
function baseName(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0 ? path : path.slice(index + 1)
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
