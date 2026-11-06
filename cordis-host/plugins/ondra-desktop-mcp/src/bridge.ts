/**
 * 数据来源端口与两个**只用标准库**的现成实现。
 *
 * ## 为什么是端口，而不是「本包自己调 `ps` / `pbcopy`」
 *
 * 手册 §9.11 只给了五个能力名与 5 秒超时，**没给命令、没给参数、没给输出格式**；
 * 本仓也没有可复用的系统信息服务键。硬凑一版 `ps aux` 解析的坏形态是
 * 「工具能用、但字段随系统版本变化」——那种错在界面上与「没接」完全同形。
 *
 * 所以：**能确定的部分自己实现，不能确定的部分留口**。
 *
 * - `NodeSysBridge`：只用 `node:os`（内存 / 核数 / 负载 / 开机时长）。这是标准库，行为确定。
 * - `FsFindBridge`：只用 `node:fs/promises`（列目录、看大小）。同样是标准库。
 * - 进程 / 前台窗口 / 剪贴板：**没有实现**。它们各自需要 `ps` / 平台 API / `pbpaste`，
 *   而这三样的输出格式本仓没有依据。如实报 `unsupported`，并在 `hint` 里指路。
 *
 * ## 为什么电池是 `null` 而不是 0
 *
 * `node:os` 没有电池读数。填 0 会让「拿不到」看起来像「没电了」，
 * 那条链（低电量 → 她该有反应）会变成「每次读都慌」。
 */

import { readdir, stat } from 'node:fs/promises'
import { homedir, arch, cpus, freemem, loadavg, platform, totalmem, uptime } from 'node:os'
import { join } from 'node:path'
import type {
  BridgeResult,
  ClipboardMeta,
  DesktopBridge,
  FileHit,
  FindOutcome,
  ForegroundInfo,
  ProcessItem,
  SortKey,
  SysInfo,
  ToolKey,
} from './types.js'
import { FILE_SCAN_ENTRY_CEIL } from './types.js'

/** 失败返回的便捷构造。 */
function fail<T>(reason: 'unsupported' | 'denied' | 'error' | 'timeout', detail: string): BridgeResult<T> {
  return Object.freeze({ ok: false as const, reason, detail })
}

/** 成功返回的便捷构造。 */
function pass<T>(value: T): BridgeResult<T> {
  return Object.freeze({ ok: true as const, value })
}

/**
 * 从异常里取 `code`（`ENOENT` / `EACCES` 之类）。
 *
 * 写成独立的取值函数而不是就地 `(error as {code}).code === 'ENOENT'`：
 * 后者的左操作数是 `unknown`，比较既不可靠也不可读。
 * @param error 异常。
 */
function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  if (!('code' in error)) return ''
  const value = (error as { code?: unknown }).code
  return typeof value === 'string' ? value : ''
}

/** 检索时跳过的目录名（隐藏目录另行按点号跳过）。 */
const SKIP_DIRS: readonly string[] = Object.freeze(['node_modules', '.git', 'Library', 'Applications'])

/**
 * 系统状态来源：`node:os`。
 *
 * 负责 `sysinfo` 一个能力。其余四个一律 `unsupported`——
 * **不是「这台机器不支持」，而是「这个来源不管」**，两者在 hint 里分开说。
 */
export class NodeSysBridge implements DesktopBridge {
  /** 实现标识。 */
  readonly id = 'node-sys'

  /** 只负责系统状态。 */
  readonly supports: readonly ToolKey[] = Object.freeze(['sysinfo'])

  /**
   * 读系统状态。
   * @param _timeoutMs 超时（本实现是同步读数，用不到）。
   */
  async sysinfo(_timeoutMs: number): Promise<BridgeResult<SysInfo>> {
    try {
      const cores = cpus().length
      const value: SysInfo = {
        platform: platform(),
        arch: arch(),
        cores,
        totalMb: Math.round(totalmem() / 1_048_576),
        freeMb: Math.round(freemem() / 1_048_576),
        loadAvg: Object.freeze(loadavg().map(item => Math.round(item * 100) / 100)),
        uptimeSec: Math.round(uptime()),
        // `node:os` 没有电池读数：拿不到就是拿不到，不填 0。
        battery: null,
      }
      return pass(value)
    } catch (error) {
      return fail('error', error instanceof Error ? error.message : String(error))
    }
  }

  /** 进程：本来源不管。 */
  async processes(
    _input: { readonly limit: number; readonly sort: SortKey },
    _timeoutMs: number,
  ): Promise<BridgeResult<readonly ProcessItem[]>> {
    return fail('unsupported', 'node-sys 不读进程：需要平台桥接提供 ps 类读数')
  }

  /** 前台窗口：本来源不管。 */
  async foreground(_timeoutMs: number): Promise<BridgeResult<ForegroundInfo>> {
    return fail('unsupported', 'node-sys 不读前台窗口：需要平台桥接（macOS 走 NSWorkspace / Windows 走 GetForegroundWindow）')
  }

  /** 剪贴板：本来源不管。 */
  async clipboardMeta(_timeoutMs: number): Promise<BridgeResult<ClipboardMeta>> {
    return fail('unsupported', 'node-sys 不读剪贴板：读长度也要先读内容，本包不碰剪贴板内容')
  }

  /** 文件检索：本来源不管（归 `FsFindBridge`）。 */
  async findFiles(
    _input: { readonly root: string; readonly keyword: string; readonly depth: number; readonly limit: number },
    _timeoutMs: number,
  ): Promise<BridgeResult<FindOutcome>> {
    return fail('unsupported', 'node-sys 不做文件检索：请用 FsFindBridge')
  }
}

/**
 * 文件检索来源：`node:fs/promises`。
 *
 * 三条硬边界，全部写死在代码里而不是靠配置：
 *
 * 1. **只在用户主目录下**：根目录是相对名，`..` 与绝对路径在配置层已被拒；
 * 2. **跳过隐藏项与符号链接**：隐藏目录里是 `.ssh`、`.config` 这类东西，
 *    符号链接会让遍历跑出主目录（也容易成环）；
 * 3. **条目预算 2000**：超了就带结果收手并标 `partial`，不让一次只读把磁盘扫穿。
 */
export class FsFindBridge implements DesktopBridge {
  /** 实现标识。 */
  readonly id = 'node-fs'

  /** 只负责文件检索。 */
  readonly supports: readonly ToolKey[] = Object.freeze(['findFiles'])

  /**
   * 在单个根目录下按文件名关键词检索。
   * @param input 根目录（相对主目录）、关键词、深度、条数。
   * @param timeoutMs 超时（毫秒）。
   */
  async findFiles(
    input: { readonly root: string; readonly keyword: string; readonly depth: number; readonly limit: number },
    timeoutMs: number,
  ): Promise<BridgeResult<FindOutcome>> {
    const base = join(homedir(), input.root)
    const needle = input.keyword.toLowerCase()
    const deadline = Date.now() + timeoutMs
    const hits: FileHit[] = []
    let scanned = 0
    let partial = false

    // 广度优先：先看浅层，这样「条数满了」时拿到的是更靠近根的那些。
    const queue: { readonly dir: string; readonly rel: string; readonly level: number }[] = [
      { dir: base, rel: '', level: 0 },
    ]

    try {
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        if (hits.length >= input.limit) break
        if (Date.now() > deadline) {
          partial = true
          break
        }
        const current = queue.at(cursor)
        if (current === undefined) break

        const entries = await readdir(current.dir, { withFileTypes: true })
        for (const entry of entries) {
          if (hits.length >= input.limit) break
          if (Date.now() > deadline) {
            partial = true
            break
          }
          if (scanned >= FILE_SCAN_ENTRY_CEIL) {
            partial = true
            break
          }
          scanned += 1

          const name = entry.name
          if (name.startsWith('.')) continue
          if (entry.isSymbolicLink()) continue

          const rel = current.rel === '' ? name : `${current.rel}/${name}`
          if (entry.isDirectory()) {
            if (SKIP_DIRS.includes(name)) continue
            // depth=1 只看根；depth=2 再看一层。换算在 `planDepth()` 里做过，这里只比层号。
            if (current.level + 1 < input.depth) queue.push({ dir: join(current.dir, name), rel, level: current.level + 1 })
            continue
          }
          if (!entry.isFile()) continue
          if (!name.toLowerCase().includes(needle)) continue
          // 只给命中项 stat 一次：命中数受 limit（≤30）约束，代价可控；
          // 全量 stat 会把「列目录」变成「摸一遍磁盘」。
          const info = await stat(join(current.dir, name))
          hits.push({ name, path: rel, kind: 'file', size: info.size, mtime: Math.round(info.mtimeMs) })
        }
      }

      return pass({ hits: Object.freeze(hits), scanned, partial })
    } catch (error) {
      const code = codeOf(error)
      if (code === 'ENOENT') return fail('unsupported', `目录不存在：${input.root}`)
      if (code === 'EACCES' || code === 'EPERM') return fail('denied', `没有权限读：${input.root}`)
      return fail('error', error instanceof Error ? error.message : String(error))
    }
  }

  /** 系统状态：本来源不管。 */
  async sysinfo(_timeoutMs: number): Promise<BridgeResult<SysInfo>> {
    return fail('unsupported', 'node-fs 不读系统状态：请用 NodeSysBridge')
  }

  /** 进程：本来源不管。 */
  async processes(
    _input: { readonly limit: number; readonly sort: SortKey },
    _timeoutMs: number,
  ): Promise<BridgeResult<readonly ProcessItem[]>> {
    return fail('unsupported', 'node-fs 不读进程')
  }

  /** 前台窗口：本来源不管。 */
  async foreground(_timeoutMs: number): Promise<BridgeResult<ForegroundInfo>> {
    return fail('unsupported', 'node-fs 不读前台窗口')
  }

  /** 剪贴板：本来源不管。 */
  async clipboardMeta(_timeoutMs: number): Promise<BridgeResult<ClipboardMeta>> {
    return fail('unsupported', 'node-fs 不读剪贴板')
  }
}

/**
 * 按能力分派的组合来源。
 *
 * **不做合并**：两个来源都报 `sysinfo` 时只取先声明的那一个。
 * 合并（例如内存取平均）会造出一份谁也没测过的读数，比缺失更糟。
 */
export class CompositeBridge implements DesktopBridge {
  /** 实现标识：各段拼起来，日志里能看出是谁在答。 */
  readonly id: string

  /** 负责的能力（各段并集）。 */
  readonly supports: readonly ToolKey[]

  /** 各段（顺序即优先级）。 */
  private readonly parts: readonly DesktopBridge[]

  /**
   * @param parts 来源列表（顺序即优先级）。
   */
  constructor(parts: readonly DesktopBridge[]) {
    this.parts = parts
    this.id = parts.map(part => part.id).join('+')
    const union: ToolKey[] = []
    for (const part of parts) {
      for (const key of part.supports) if (!union.includes(key)) union.push(key)
    }
    this.supports = Object.freeze(union)
  }

  /**
   * 找出负责某个能力的第一个来源。
   * @param key 能力键。
   */
  private pick(key: ToolKey): DesktopBridge | null {
    for (const part of this.parts) {
      if (part.supports.includes(key)) return part
    }
    return null
  }

  /** 进程。 */
  async processes(
    input: { readonly limit: number; readonly sort: SortKey },
    timeoutMs: number,
  ): Promise<BridgeResult<readonly ProcessItem[]>> {
    const part = this.pick('processes')
    if (part === null) return fail('unsupported', '没有来源负责进程')
    return part.processes(input, timeoutMs)
  }

  /** 前台窗口。 */
  async foreground(timeoutMs: number): Promise<BridgeResult<ForegroundInfo>> {
    const part = this.pick('foreground')
    if (part === null) return fail('unsupported', '没有来源负责前台窗口')
    return part.foreground(timeoutMs)
  }

  /** 剪贴板。 */
  async clipboardMeta(timeoutMs: number): Promise<BridgeResult<ClipboardMeta>> {
    const part = this.pick('clipboard')
    if (part === null) return fail('unsupported', '没有来源负责剪贴板')
    return part.clipboardMeta(timeoutMs)
  }

  /** 文件检索。 */
  async findFiles(
    input: { readonly root: string; readonly keyword: string; readonly depth: number; readonly limit: number },
    timeoutMs: number,
  ): Promise<BridgeResult<FindOutcome>> {
    const part = this.pick('findFiles')
    if (part === null) return fail('unsupported', '没有来源负责文件检索')
    return part.findFiles(input, timeoutMs)
  }

  /** 系统状态。 */
  async sysinfo(timeoutMs: number): Promise<BridgeResult<SysInfo>> {
    const part = this.pick('sysinfo')
    if (part === null) return fail('unsupported', '没有来源负责系统状态')
    return part.sysinfo(timeoutMs)
  }
}
