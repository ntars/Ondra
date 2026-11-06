/**
 * 认可清单的落盘（`user/market/approved.json`，0600）。
 *
 * ## 为什么必须落盘
 *
 * 「用户上传自定义」如果只在内存，重启就没了。而人的记忆里那条「我明明加过」
 * 会变成「这软件有 bug」——一次就够让人不再用它。
 *
 * ## 为什么解析失败按空，而不是按「全部认可」
 *
 * 按「全部认可」会让一次文件损坏变成**忽然开放整个市场**，那是安全方向的错误。
 * 按空是保守方向的错误：少了几个自定义项，人能再加。
 *
 * ## 为什么用「临时文件 + rename」
 *
 * 直接写目标文件时，进程在写一半被杀，留下的是**半截 JSON**；
 * 下一次启动解析失败 → 清单归零。`rename` 在同一文件系统内是原子的，
 * 要么是旧内容，要么是新内容，不存在半截。
 *
 * 文件名带 pid：两个实例同时写时，各写各的临时文件，不会互相截断。
 */

import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { LogLike, PathLayoutLike } from './types.js'
import { APPROVED_FILE, isPackageName } from './settings.js'

/** 文件格式版本。读到的版本不认识就按空处理，**不猜字段**。 */
const FILE_VERSION = 1

/** 一条落盘的认可记录。 */
export interface StoredApproval {
  readonly name: string
  readonly note?: string
  /** Unix 毫秒。 */
  readonly addedAt: number
}

/** 读取结果。 */
export interface LoadResult {
  readonly entries: readonly StoredApproval[]
  /** 文件在但读不懂（按空处理）。 */
  readonly corrupt: boolean
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把异常折成一句文本。 */
function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 认可清单存储。
 *
 * `layout` 为 `null`（没装 O-002）或 `persist=false` 时退化为**仅在内存**，
 * 并在 `status().store` 里如实报 `memory`——不假装落过盘。
 */
export class ApprovalStore {
  readonly #layout: PathLayoutLike | null
  readonly #log: LogLike
  readonly #persist: boolean
  #entries: readonly StoredApproval[] = Object.freeze([])
  #corrupt = false
  #loaded = false

  /**
   * @param layout 路径端口（`null` = 只在内存）。
   * @param log 日志。
   * @param persist 落盘开关（`false` = 只在内存，即使有路径端口）。
   */
  constructor(layout: PathLayoutLike | null, log: LogLike, persist = true) {
    this.#layout = layout
    this.#log = log
    this.#persist = persist
  }

  /** 存哪：`file` / `memory`。 */
  get kind(): 'file' | 'memory' {
    return this.#layout === null || !this.#persist ? 'memory' : 'file'
  }

  /** 文件绝对路径；仅在内存时为 undefined。 */
  get path(): string | undefined {
    if (this.#layout === null || !this.#persist) return undefined
    try {
      return this.#layout.fileIn('user', ...APPROVED_FILE)
    } catch (error) {
      this.#log.warn('认可清单路径拼不出来（退回内存）：%s', textOf(error))
      return undefined
    }
  }

  /** 上次读取有没有遇到坏文件。 */
  get corrupt(): boolean {
    return this.#corrupt
  }

  /** 当前记录（只读快照）。 */
  get entries(): readonly StoredApproval[] {
    return this.#entries
  }

  /**
   * 读一次。文件不在 = 空清单（不是错）。
   */
  load(): readonly StoredApproval[] {
    this.#loaded = true
    const file = this.path
    if (file === undefined) {
      this.#entries = Object.freeze([])
      this.#corrupt = false
      return this.#entries
    }

    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      // ENOENT 是正常情况：第一次装还没有这个文件。
      const code = (error as { code?: unknown }).code
      if (code !== 'ENOENT') {
        this.#log.warn('认可清单读不出来（按空处理）：%s', textOf(error))
        this.#corrupt = true
      }
      this.#entries = Object.freeze([])
      return this.#entries
    }

    this.#entries = Object.freeze(this.#parse(text))
    return this.#entries
  }

  /**
   * 写一次（原子）。失败只记日志，不影响内存里的那一条。
   * @param entries 要写的记录。
   */
  save(entries: readonly StoredApproval[]): boolean {
    this.#entries = Object.freeze([...entries])
    const file = this.path
    if (file === undefined) return false

    const body = `${JSON.stringify(
      { version: FILE_VERSION, entries: this.#entries.map(item => ({ ...item })) },
      null,
      2,
    )}\n`
    const temp = `${file}.tmp-${String(process.pid)}`
    try {
      const dir = this.#layout?.ensure('user', ...APPROVED_FILE.slice(0, -1))
      if (dir === undefined) return false
      writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(temp, file)
      // rename 保留 mode，但仍显式收紧一次：目标已存在且原本是 0644 时，rename 会把 0600 盖上去，
      // 这一步是为了让「文件本来就在」的那条路径也变成 0600，而不是只靠 writeFileSync 的 mode。
      chmodSync(file, 0o600)
      return true
    } catch (error) {
      this.#log.warn('认可清单写不进去（只在内存里）：%s', textOf(error))
      try {
        rmSync(temp, { force: true })
      } catch {
        // 临时文件删不掉也不影响正确性，下次 rename 会覆盖。
      }
      return false
    }
  }

  /** 已经读过没有。 */
  get loaded(): boolean {
    return this.#loaded
  }

  /**
   * 解析文件内容。**任何形状异常都整份按空**，不部分采纳。
   * @param text 文件文本。
   */
  #parse(text: string): readonly StoredApproval[] {
    if (text.trim() === '') {
      // 空文件 = 还没有记录。这不是损坏（可能是别的工具刚 touch 出来的）。
      this.#corrupt = false
      return Object.freeze([])
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.#log.warn('认可清单不是合法 JSON（按空处理）：%s', textOf(error))
      this.#corrupt = true
      return Object.freeze([])
    }

    if (!isRecord(parsed) || parsed['version'] !== FILE_VERSION) {
      this.#log.warn('认可清单版本不认识（按空处理）：期望 %d', FILE_VERSION)
      this.#corrupt = true
      return Object.freeze([])
    }

    const raw = parsed['entries']
    if (!Array.isArray(raw)) {
      this.#corrupt = true
      return Object.freeze([])
    }

    const out: StoredApproval[] = []
    let dropped = 0
    for (const item of raw) {
      if (!isRecord(item) || !isPackageName(item['name'])) {
        dropped += 1
        continue
      }
      const candidate = item['name'].trim()
      if (out.some(existing => existing.name === candidate)) continue
      const note = typeof item['note'] === 'string' && item['note'].trim() !== '' ? item['note'].trim() : undefined
      const addedAt = typeof item['addedAt'] === 'number' && Number.isFinite(item['addedAt']) ? item['addedAt'] : 0
      out.push({ name: candidate, ...(note === undefined ? {} : { note }), addedAt })
    }
    if (dropped > 0) this.#log.warn('认可清单里有 %d 条不合规，已丢弃', dropped)
    this.#corrupt = false
    return Object.freeze(out)
  }
}
