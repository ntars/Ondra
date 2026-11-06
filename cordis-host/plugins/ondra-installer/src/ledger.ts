/**
 * 记账文件（`.ondra-bootstrap.json`，0600）。
 *
 * ## 它存在的唯一理由
 *
 * 手册 §4.6 的原话：旧项目「只有哈希、无记账本、无自检命令」。**只有哈希**的意思是：
 * 每次启动都得把 100 MB 的组件重算一遍才知道装没装；而**人看到的**是启动时长达数秒的卡顿。
 * 有了账本，「装过什么、什么版本、什么时候、多少字节」一次读出来，哈希只在
 * `verify()` 里按需重算。
 *
 * ## 为什么先记 `pending` 再记 `installed`
 *
 * 只记 `installed` 时，进程在「写文件」与「写账」之间被杀，账本就永远不知道这个组件
 * 装到一半。`pending` 是明确的「需要重装」信号——若只有「没有记录」这一种状态，
 * 下次启动就会把它当成「从没装过」，而目标目录里可能躺着一个写了一半的文件。
 *
 * ## 为什么整份按空处理而不部分采纳
 *
 * 账本坏了，最安全的动作是「当成没装过，重装一遍」。部分采纳（比如读到三条就用三条）
 * 会让「第四、五个组件」既不在账上、又被误认为装过——那是**最坏**的一种状态：
 * 文件在、账不在、自检说没问题。
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BootstrapLedger, LedgerComponent, LedgerStatus, LogLike, PathLayoutLike } from './types.js'
import { LEDGER_FILE } from './settings.js'

/** 账本格式版本。读到的版本不认识就按「没有账本」处理。 */
export const LEDGER_VERSION = 1

/** 读取结果。 */
export interface LedgerRead {
  readonly ledger?: BootstrapLedger
  /** 文件在但读不懂（按「没有账本」处理）。 */
  readonly corrupt: boolean
  /** 文件不在（第一次装，属正常）。 */
  readonly missing: boolean
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 空账本。 */
export function emptyLedger(): BootstrapLedger {
  return Object.freeze({ version: LEDGER_VERSION, components: Object.freeze([]) })
}

/**
 * 插入或替换一条记账。
 *
 * 返回**新对象**而不是就地改：账本会被并发读（`verify()` 与面板），
 * 就地改会让读方看到「一半新一半旧」的状态。
 * @param ledger 原账本。
 * @param entry 新条目。
 */
export function upsert(ledger: BootstrapLedger, entry: LedgerComponent): BootstrapLedger {
  const rest = ledger.components.filter(item => item.path !== entry.path)
  return Object.freeze({
    ...ledger,
    components: Object.freeze([...rest, entry]),
  })
}

/** 按路径取一条。 */
export function findComponent(ledger: BootstrapLedger | undefined, path: string): LedgerComponent | undefined {
  if (ledger === undefined) return undefined
  return ledger.components.find(item => item.path === path)
}

/** 账本里的组件路径集合。 */
export function ledgerPaths(ledger: BootstrapLedger | undefined): ReadonlySet<string> {
  return new Set((ledger?.components ?? []).map(item => item.path))
}

/** 记账存储。 */
export class LedgerStore {
  readonly #layout: PathLayoutLike | null
  readonly #explicit: string
  readonly #log: LogLike
  #lastPath: string | undefined

  /**
   * @param layout 路径端口（`null` = 拼不出默认路径）。
   * @param explicit 显式路径（空 = 用默认）。
   * @param log 日志。
   */
  constructor(layout: PathLayoutLike | null, explicit: string, log: LogLike) {
    this.#layout = layout
    this.#explicit = explicit
    this.#log = log
  }

  /** 账本文件路径；拼不出时 undefined。 */
  get path(): string | undefined {
    if (this.#explicit !== '') return this.#explicit
    if (this.#lastPath !== undefined) return this.#lastPath
    if (this.#layout === null) return undefined
    try {
      this.#lastPath = this.#layout.fileIn('user', LEDGER_FILE)
      return this.#lastPath
    } catch (error) {
      this.#log.warn('账本路径拼不出来：%s', textOf(error))
      return undefined
    }
  }

  /** 读一次。 */
  read(): LedgerRead {
    const file = this.path
    if (file === undefined) return Object.freeze({ corrupt: false, missing: true })

    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (code === 'ENOENT') return Object.freeze({ corrupt: false, missing: true })
      this.#log.warn('账本读不出来：%s', textOf(error))
      return Object.freeze({ corrupt: true, missing: false })
    }

    return this.#parse(text)
  }

  /**
   * 写一次（原子）。
   * @param ledger 账本。
   */
  write(ledger: BootstrapLedger): boolean {
    const file = this.path
    if (file === undefined) {
      this.#log.warn('没有账本路径（缺 O-002 且未配 `ledgerPath`）：记账只在内存里')
      return false
    }

    const body = `${JSON.stringify(ledger, null, 2)}\n`
    const temp = `${file}.tmp-${String(process.pid)}`
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, file)
      chmodSync(file, 0o600)
      return true
    } catch (error) {
      this.#log.warn('账本写不进去：%s', textOf(error))
      try {
        rmSync(temp, { force: true })
      } catch {
        // 临时文件删不掉不影响正确性。
      }
      return false
    }
  }

  /**
   * 解析账本文本。
   * @param text 文件文本。
   */
  #parse(text: string): LedgerRead {
    if (text.trim() === '') return Object.freeze({ corrupt: true, missing: false })

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.#log.warn('账本不是合法 JSON（按没有账本处理）：%s', textOf(error))
      return Object.freeze({ corrupt: true, missing: false })
    }

    if (!isRecord(parsed) || parsed['version'] !== LEDGER_VERSION) {
      this.#log.warn('账本版本不认识（按没有账本处理）：期望 %d', LEDGER_VERSION)
      return Object.freeze({ corrupt: true, missing: false })
    }

    const raw = parsed['components']
    if (!Array.isArray(raw)) return Object.freeze({ corrupt: true, missing: false })

    const components: LedgerComponent[] = []
    for (const item of raw) {
      const entry = this.#entryOf(item)
      if (entry === undefined) continue
      if (components.some(existing => existing.path === entry.path)) continue
      components.push(entry)
    }
    if (components.length !== raw.length) {
      this.#log.warn('账本里有 %d 条不合规，已丢弃', raw.length - components.length)
    }

    const manifestSha256 = parsed['manifestSha256']
    const bootstrapAt = parsed['bootstrapAt']
    return Object.freeze({
      corrupt: false,
      missing: false,
      ledger: Object.freeze({
        version: LEDGER_VERSION,
        ...(typeof manifestSha256 === 'string' && manifestSha256 !== '' ? { manifestSha256 } : {}),
        ...(typeof bootstrapAt === 'number' && Number.isFinite(bootstrapAt) ? { bootstrapAt } : {}),
        components: Object.freeze(components),
      }),
    })
  }

  /**
   * 一条记录的形状校验。
   * @param raw 原始值。
   */
  #entryOf(raw: unknown): LedgerComponent | undefined {
    if (!isRecord(raw)) return undefined
    const path = raw['path']
    const sha256 = raw['sha256']
    const file = raw['file']
    const status = raw['status']
    const at = raw['at']
    if (typeof path !== 'string' || path === '') return undefined
    if (typeof sha256 !== 'string' || sha256 === '') return undefined
    if (typeof file !== 'string' || file === '') return undefined
    if (status !== 'pending' && status !== 'installed' && status !== 'failed') return undefined
    if (typeof at !== 'number' || !Number.isFinite(at)) return undefined

    const version = raw['version']
    const bytes = raw['bytes']
    const error = raw['error']
    return Object.freeze({
      path,
      ...(typeof version === 'string' && version !== '' ? { version } : {}),
      sha256,
      file,
      status: status as LedgerStatus,
      at,
      ...(typeof bytes === 'number' && Number.isFinite(bytes) ? { bytes } : {}),
      ...(typeof error === 'string' && error !== '' ? { error } : {}),
    })
  }
}
