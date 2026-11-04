/**
 * 进程出口：本插件**唯一**能起子进程的地方。
 *
 * ## 为什么单独一个文件
 *
 * `say` / `edge-tts` / `afplay` 三条都要起进程。散在三个分支里各写一遍
 * `spawn` 的后果不是代码丑，而是**卸载时杀不干净**：谁起的谁负责杀，
 * 一旦有一处没记下来，插件被关掉以后还在出声。
 * 这里把「起过哪些子进程」集中成一个集合，`killAll()` 一次收尾。
 *
 * ## 为什么同步探测不调 `run()`
 *
 * 面板首屏要读 `available`，那是同步 getter。`edge-tts` 在不在，
 * 用「按 PATH 找一遍文件」就够了，不必真的执行一次（执行会慢 100ms 以上，
 * 而且 `--version` 在没有 node 的机器上本来就是错的判据）。
 * `whichSync()` 只查文件是否存在，不读内容、不执行。
 *
 * ## 输出为什么要截断
 *
 * 子进程的 stderr 在有 bug 时可能刷出几十 KB（一个失败的重试循环）。
 * 全量拼进内存再把日志撑爆，比失败本身更难查。4 KiB 足够装下一条真实报错。
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ExecResult } from './types.js'

/** 单路输出保留的字符数。 */
export const OUTPUT_LIMIT = 4096

/** 拼接子进程输出并截断（保留**尾部**，报错通常在最后一行）。 */
function tail(text: string): string {
  if (text.length <= OUTPUT_LIMIT) return text
  return text.slice(text.length - OUTPUT_LIMIT)
}

/** 进程出口。一个实例 = 一批可被一次性收尾的子进程。 */
export class Exec {
  private readonly children = new Set<ChildProcess>()
  private disposed = false

  /** 起过的、还没结束的子进程数（面板与自检读）。 */
  get pending(): number {
    return this.children.size
  }

  /**
   * 起一个子进程并等它结束。**永不抛错**：起不来也给一份结果。
   * @param command 可执行文件。
   * @param args 参数。
   * @param options 超时。
   */
  run(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number },
  ): Promise<ExecResult> {
    if (this.disposed) {
      return Promise.resolve({ ok: false, code: -1, stdout: '', stderr: '出口已关闭', timedOut: false })
    }

    return new Promise<ExecResult>(resolve => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (result: ExecResult): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve(result)
      }

      let child: ChildProcess
      try {
        child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        // `spawn` 在参数非法时会同步抛（EACCES 之类则走 error 事件）。
        finish({ ok: false, code: -1, stdout: '', stderr: String(error), timedOut: false })
        return
      }

      this.children.add(child)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = tail(stdout + chunk.toString('utf8'))
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = tail(stderr + chunk.toString('utf8'))
      })

      timer = setTimeout(() => {
        stderr = tail(stderr + '\n[超时被杀]')
        try {
          child.kill('SIGKILL')
        } catch {
          // 已经退出：kill 抛错没有信息量，忽略。
        }
        finish({ ok: false, code: -1, stdout, stderr, timedOut: true })
        this.children.delete(child)
      }, options.timeoutMs)

      child.on('error', (error: Error) => {
        this.children.delete(child)
        finish({ ok: false, code: -1, stdout, stderr: stderr === '' ? error.message : stderr, timedOut: false })
      })

      child.on('close', (code: number | null, signal: string | null) => {
        this.children.delete(child)
        const exitCode = code === null ? -1 : code
        const note = signal === null ? '' : '\n[信号 ' + signal + ']'
        finish({
          ok: exitCode === 0 && signal === null,
          code: exitCode,
          stdout,
          stderr: stderr + note,
          timedOut: false,
        })
      })
    })
  }

  /** 杀掉全部在跑的子进程（插件卸载时调用）。 */
  killAll(): void {
    this.disposed = true
    for (const child of this.children) {
      try {
        child.kill('SIGKILL')
      } catch {
        // 同上：已经退出就算了。
      }
    }
    this.children.clear()
  }
}

/**
 * 在 PATH 里找一个可执行文件（**只查文件存在，不执行**）。
 * @param command 文件名或绝对路径。
 * @param pathValue `process.env.PATH`。
 * @param platform `process.platform`。
 * @returns 找到的绝对路径，找不到为 `undefined`。
 */
export function whichSync(
  command: string,
  pathValue: string | undefined,
  platform: string,
): string | undefined {
  if (command === '') return undefined
  if (command.includes('/') || command.includes('\\')) {
    return isExecutableFile(command) ? command : undefined
  }
  const separator = platform === 'win32' ? ';' : delimiter
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = (pathValue ?? '').split(separator).filter(dir => dir !== '')
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}

/** 是不是一个存在且非目录的文件。 */
function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path)
    return stat.isFile()
  } catch {
    return false
  }
}

/** 文件存在与否（不抛）。 */
export function fileExists(path: string): boolean {
  return existsSync(path)
}

/**
 * 一句话说明为什么起不来（给 `detail` 与日志用）。
 * @param result 进程结果。
 */
export function describeExec(result: ExecResult): string {
  if (result.timedOut) return '超时'
  const line = result.stderr.trim().split('\n').pop() ?? ''
  if (line !== '') return '退出码 ' + String(result.code) + '：' + line
  return '退出码 ' + String(result.code)
}
