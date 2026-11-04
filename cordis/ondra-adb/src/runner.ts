/**
 * 执行器端口与它的默认实现。
 *
 * ## 为什么端口存在，而不是直接 `execFile`
 *
 * 台账与主人的口径都要求「先查仓内有无 adb 调用依据，没有就把命令执行做成端口」。
 * 本轮 grep 结果：`cordis/` 下 `adb` 只出现在台账与 master-plan 的说明行里，
 * **没有任何一处真的调用过 adb**；`desktop/packages` 里也没有可供插件复用的
 * 「命令执行服务键」。所以这里给的是**端口 + 一个默认实现**：
 *
 * - 端口（`AdbRunner`）：定义在 `types.ts`，收 `argv` 数组、永不抛错；
 * - 默认实现（`SpawnAdbRunner`）：用 `node:child_process` 的 `execFile`，
 *   不经过本机 shell，参数逐个传；`-s <serial>` 在**外层**拼。
 *
 * 默认实现留在本包，是为了「装好 platform-tools + 打开开关就能用」，
 * 而不是让使用者先写一个桥。想换实现（真机农场、云手机、测试桩）
 * 调 `useRunner()` 即可，本包其余代码不感知。
 *
 * ## 失败必须折成结果，不能抛
 *
 * 手册 §8.1-C3：器官/插件的错误不得传播。这里的实际后果很硬——
 * 一次 `ENOENT` 若抛出去，15 秒的定时器就会带着未捕获异常把宿主日志刷满，
 * 而用户看到的只是「手机短信那块一直是灰的」。所以三种失败各自折成码：
 *
 * - `no-adb`：可执行文件不在（去装 platform-tools，或改 `adbPath`）；
 * - `device-offline`：没设备 / 离线 / 未授权（插上、解锁、点「允许」）；
 * - `timeout`：命令跑太久（手机睡着了，或 USB 掉了）。
 *
 * 三个码的修法完全不同，所以不能合成一个「失败」。
 */

import { execFile } from 'node:child_process'
import type { AdbRunner, ExecReason, ExecResult } from './types.js'

/** 单次命令最多收多少 stdout（字节）。短信正文四列，1 MB 足够；再大就是异常输出。 */
const MAX_BUFFER = 1_048_576

/** 设备不可用的三种回显（adb 的措辞多年未变，但**不做唯一判据**，见 `classifyStderr`）。 */
const OFFLINE_HINTS: readonly string[] = [
  'no devices',
  'device offline',
  'device not found',
  'unauthorized',
  'more than one device',
]

/**
 * 从 stderr 判断是不是「设备不在」。
 *
 * `more than one device` 与「没设备」是同一类处置（去 `serial` 里指定一台），
 * 所以归到同一个码——同一个排查动作，就该是同一个码（纪律 143）。
 * @param stderr 标准错误。
 */
export function classifyStderr(stderr: string): ExecReason {
  const text = stderr.toLowerCase()
  for (const hint of OFFLINE_HINTS) {
    if (text.includes(hint)) return 'device-offline'
  }
  return 'exit'
}

/** 执行器依赖。 */
export interface SpawnAdbRunnerDeps {
  /** adb 可执行文件路径或命令名。 */
  readonly adbPath: string
  /** 设备序列号（空 = 不指定）。 */
  readonly serial?: string
}

/**
 * 默认执行器：`execFile` + 参数数组，**不经过本机 shell**。
 *
 * 不经过 shell 有两个好处：①参数里的空格与引号不会被本机解释；
 * ②`; rm -rf` 这类注入在本机这一层就已经是「一个普通参数」。
 * 但**这还不够**——`adb shell` 会在设备侧再拼一次命令行，
 * 所以设备侧的元字符必须由 `policy.ts` 在调用前拦掉。
 */
export class SpawnAdbRunner implements AdbRunner {
  readonly id = 'spawn'

  private readonly deps: SpawnAdbRunnerDeps

  constructor(deps: SpawnAdbRunnerDeps) {
    this.deps = deps
  }

  /**
   * 跑一条命令。**永不抛错**。
   * @param argv 参数数组（第一个是 `shell`）。
   * @param timeoutMs 超时（毫秒）。
   */
  exec(argv: readonly string[], timeoutMs: number): Promise<ExecResult> {
    const serial = (this.deps.serial ?? '').trim()
    const full: string[] = serial === '' ? [...argv] : ['-s', serial, ...argv]
    const startedAt = Date.now()

    return new Promise<ExecResult>(resolve => {
      try {
        execFile(
          this.deps.adbPath,
          full,
          // `unref` 不在这里给：execFile 的定时器由 timeout 选项管，不需要额外清理。
          { timeout: timeoutMs, maxBuffer: MAX_BUFFER, windowsHide: true },
          (error, stdout, stderr) => {
            const elapsedMs = Date.now() - startedAt
            if (error === null) {
              resolve({
                ok: true,
                stdout: String(stdout),
                stderr: String(stderr),
                code: 0,
                elapsedMs,
              })
              return
            }
            resolve({
              ok: false,
              reason: reasonOfError(error, String(stderr)),
              stdout: String(stdout),
              stderr: String(stderr),
              code: codeOfError(error),
              elapsedMs,
            })
          },
        )
      } catch (error) {
        // 同步抛错（路径是目录、权限不足、参数类型不对）——折成结果。
        resolve({
          ok: false,
          reason: 'spawn',
          stdout: '',
          stderr: textOf(error),
          code: -1,
          elapsedMs: Date.now() - startedAt,
        })
      }
    })
  }
}

/**
 * 把 `execFile` 的错误折成原因码。
 * @param error 错误对象。
 * @param stderr 标准错误。
 */
function reasonOfError(error: Error & { code?: unknown; killed?: boolean }, stderr: string): ExecReason {
  // 超时：execFile 会 kill 子进程并把 killed 置真。
  if (error.killed === true) return 'timeout'
  if (error.code === 'ENOENT') return 'no-adb'
  if (error.code === 'ETIMEDOUT') return 'timeout'
  if (typeof error.code === 'string') {
    // EACCES / EISDIR / EPERM：可执行文件在，但跑不起来。
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EISDIR') return 'spawn'
  }
  return classifyStderr(stderr)
}

/**
 * 取退出码。
 * @param error 错误对象。
 */
function codeOfError(error: Error & { code?: unknown }): number {
  return typeof error.code === 'number' ? error.code : -1
}

/**
 * 把任意异常折成一句文本（日志用）。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
