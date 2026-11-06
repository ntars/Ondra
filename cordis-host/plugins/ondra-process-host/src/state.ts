/**
 * 状态落盘：一个托管项一个 JSON，**原子写、0600**。
 *
 * ## 为什么状态文件与 pidfile 分开
 *
 * 两者读者不同、生命周期也不同：
 *
 * - `<name>.json`：给**本插件自己**下次启动看（上次怎么退的、重启过几次）。它一定写。
 * - `<name>.pid`：给**外部工具**看（脚本、监控、`cat`）。它只在拿得到真 pid 时写。
 *
 * 合成一个文件的坏处很具体：外部脚本 `cat x.pid` 会读到一整段 JSON，或者反过来，
 * 本插件去解析一段只有数字的文本——两种都迟早出错。
 *
 * ## 为什么必须原子写
 *
 * 进程被杀时正好在写状态文件，非原子写会留下半个 JSON。下一次读它解析失败，
 * 于是「上次明明崩了」变成「没有记录」，重启预算被清零 —— 崩溃循环就此绕过限制。
 * 做法：同目录临时文件 → `rename`。同目录保证同一文件系统，`rename` 才是原子的。
 *
 * ## 为什么只在内存时 `pathOf` 返回空串
 *
 * 空串是明确的「没有落盘」，调用方一眼能判；返回一个不存在的路径则会让
 * 「文件读不到」与「根本没打算写」混成同一件事。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileNameOf } from './scope.js'
import type { HostStateRecord, LogLike, PathLayoutLike, StatePort } from './types.js'

/** 状态文件权限：只给当前用户。 */
const FILE_MODE = 0o600

/** 状态目录权限：0700（目录里是进程清单，不该被别人读）。 */
const DIR_MODE = 0o700

/**
 * 本地文件状态库。
 *
 * 所有方法**永不抛**：落盘失败只影响「下次启动能否看到上次的结局」，
 * 不该让一次 `start()` 因此失败。
 */
export class FileStateStore implements StatePort {
  readonly #dir: string | null
  readonly #log: LogLike
  #warned = false

  /**
   * @param layout O-002 路径服务；缺席且没配 `stateDir` 时退化为纯内存。
   * @param stateDir 配置的状态目录（空 = 走 `user/process-host`）。
   * @param log 日志。
   */
  constructor(layout: PathLayoutLike | null, stateDir: string, log: LogLike) {
    this.#log = log
    if (stateDir !== '') {
      this.#dir = stateDir
      return
    }
    if (layout === null) {
      this.#dir = null
      return
    }
    try {
      this.#dir = layout.ensure('user', 'process-host')
    } catch {
      this.#dir = null
    }
  }

  /** 是否真的会落盘。 */
  get persistent(): boolean {
    return this.#dir !== null
  }

  /**
   * 状态文件绝对路径；只在内存时为空串。
   * @param name 托管项名。
   */
  pathOf(name: string): string {
    return this.#dir === null ? '' : join(this.#dir, fileNameOf(name, '.json'))
  }

  /**
   * pid 文件绝对路径；只在内存时为空串。
   * @param name 托管项名。
   */
  pidPathOf(name: string): string {
    return this.#dir === null ? '' : join(this.#dir, fileNameOf(name, '.pid'))
  }

  /**
   * 读一条状态。
   * @param name 托管项名。
   */
  read(name: string): HostStateRecord | null {
    const path = this.pathOf(name)
    if (path === '' || !existsSync(path)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return asRecord(parsed)
    } catch (error) {
      this.#warnOnce(`状态文件读不懂，按「没有记录」处理：${textOf(error)}`)
      return null
    }
  }

  /**
   * 写一条状态（原子）。
   * @param record 状态。
   */
  write(record: HostStateRecord): void {
    const path = this.pathOf(record.name)
    if (path === '') return
    try {
      mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
      const temp = `${path}.tmp`
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE })
      renameSync(temp, path)
    } catch (error) {
      this.#warnOnce(`状态写不进去（不影响运行）：${textOf(error)}`)
    }
  }

  /**
   * 删一条状态。
   * @param name 托管项名。
   */
  remove(name: string): void {
    const path = this.pathOf(name)
    if (path === '') return
    try {
      rmSync(path, { force: true })
    } catch (error) {
      this.#warnOnce(`状态删不掉：${textOf(error)}`)
    }
  }

  /**
   * 写 pid 文件。
   *
   * **只在拿到真 pid 时调用**。写之前先确认目录可建；内容只有一行数字 + 换行，
   * 这样 `cat x.pid` 的输出可以直接 `kill $(cat x.pid)`。
   * @param name 托管项名。
   * @param pid 子进程 pid。
   */
  writePid(name: string, pid: number): boolean {
    const path = this.pidPathOf(name)
    if (path === '') return false
    try {
      mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
      const temp = `${path}.tmp`
      writeFileSync(temp, `${pid}\n`, { encoding: 'utf8', mode: FILE_MODE })
      renameSync(temp, path)
      return true
    } catch (error) {
      this.#warnOnce(`pid 文件写不进去：${textOf(error)}`)
      return false
    }
  }

  /**
   * 删 pid 文件（进程没了就该消失，留着会误导 `kill $(cat)`）。
   * @param name 托管项名。
   */
  removePid(name: string): void {
    const path = this.pidPathOf(name)
    if (path === '') return
    try {
      rmSync(path, { force: true })
    } catch {
      // 删不掉不算错：下次写会覆盖，读的人也能看出 pid 过期。
    }
  }

  /**
   * 同一类警告只打一次。
   * @param message 文本。
   */
  #warnOnce(message: string): void {
    if (this.#warned) return
    this.#warned = true
    this.#log.warn(message)
  }
}

/**
 * 把未知值收成状态记录；形状不对就当没有。
 * @param value 解析结果。
 */
function asRecord(value: unknown): HostStateRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const name = raw['name']
  const phase = raw['phase']
  const startedAt = raw['startedAt']
  if (typeof name !== 'string' || typeof phase !== 'string') return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  const argv = Array.isArray(raw['argv']) ? raw['argv'].filter((item): item is string => typeof item === 'string') : []
  const restarts = typeof raw['restarts'] === 'number' ? raw['restarts'] : 0
  const pid = typeof raw['pid'] === 'number' ? raw['pid'] : null
  const cwd = typeof raw['cwd'] === 'string' ? raw['cwd'] : ''
  const exitedAt = typeof raw['exitedAt'] === 'number' ? raw['exitedAt'] : undefined
  const record: HostStateRecord = {
    name,
    phase: phaseOf(phase),
    argv,
    cwd,
    startedAt,
    restarts,
    pid,
    ...(exitedAt === undefined ? {} : { exitedAt }),
  }
  return record
}

/**
 * 阶段字符串收窄（认不出的按 `failed`，宁可说「不会自动重启」也不说「在跑」）。
 * @param value 原始字符串。
 */
function phaseOf(value: string): HostStateRecord['phase'] {
  if (value === 'idle' || value === 'running' || value === 'restarting' || value === 'stopped') return value
  return 'failed'
}

/**
 * 异常折成一句。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
