/**
 * 同意账本（`id@host` → 一次点头）。
 *
 * ## 为什么必须落盘
 *
 * 只放内存的话，每次启动都会把「这台机器能不能把截图发到某个服务」重新问一遍。
 * 问三遍之后用户就会去找「怎么关掉这个烦人的东西」——而关掉它，整套告知就没了。
 * 所以落盘不是优化，是**让告知能长期存在**的前提。
 *
 * ## 纪律 142：谁加、谁删、哪条路径会绕过删除
 *
 * - 谁加：`grant()`。**只有它**。
 * - 谁删：`revoke()`（用户撤回）、`sweep()`（过期清理）、`load()`（整表替换）。
 * - 绕过删除的路径：**没有**。本包不提供「清空全部同意」的批量接口——那一条
 *   被误触之后，用户不会知道自己的数据又开始往外走了。
 *
 * ## 解析失败 = 空，不是「全部同意」
 *
 * 账本文件坏掉（断电写了半个 JSON、手改坏）时按**空**处理：宁可多问一遍，
 * 不能因为读不出来就默认放行。版本号不认识时同样按空处理，**不猜字段**。
 *
 * ## 原子写不在本文件
 *
 * 本文件只负责格式（单一真源）；「临时文件 + rename」这种落盘细节归端口实现
 * （`index.ts` 的 `FileLedger`）。这样换存储（文件 / SQLite / 测试内存）不用改格式。
 */

import type { Consent, ConsentBy, ConsentLedger } from './types.js'

/** 落盘格式版本。改结构就加一；老版本一律当空处理（**不猜**）。 */
export const FORMAT_VERSION = 1

/** 日志子集。 */
export interface ConsentLogLike {
  info(message: string, ...args: readonly unknown[]): void
  warn(message: string, ...args: readonly unknown[]): void
}

/** 构造依赖。 */
export interface ConsentStoreDeps {
  /** 落盘端口（`null` = 只放内存）。 */
  readonly ledger: ConsentLedger | null
  /** 取当前时刻。 */
  readonly now: () => number
  /** 日志。 */
  readonly log: ConsentLogLike
}

/** 给一次同意的结果。 */
export interface GrantOutcome {
  /** 新同意。 */
  readonly row: Consent
  /** 落盘了没有。 */
  readonly persisted: boolean
}

/**
 * 拼同意键（**全包唯一一份**，`egress.ts` 也从这里取）。
 * @param id 能力 id。
 * @param host 归一后的主机。
 */
export function consentKeyOf(id: string, host: string): string {
  return `${id}@${host}`
}

/**
 * 拆同意键。**拆不出来就返回 `null`**，不猜。
 * @param key 同意键。
 */
export function splitKey(key: string): { readonly id: string; readonly host: string } | null {
  const at = key.indexOf('@')
  if (at <= 0 || at === key.length - 1) return null
  const id = key.slice(0, at)
  const host = key.slice(at + 1)
  // id 与 host 都不许再含 `@`：`a@b@c` 这种键一定不是本包生成的。
  if (host.includes('@')) return null
  return { id, host }
}

/**
 * 序列化账本。
 * @param rows 全部同意。
 */
export function serialize(rows: readonly Consent[]): string {
  const payload = {
    version: FORMAT_VERSION,
    consents: rows.map(row => ({
      key: row.key,
      id: row.id,
      host: row.host,
      at: row.at,
      by: row.by,
      expiresAt: row.expiresAt,
    })),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/**
 * 解析账本。
 *
 * 任何一处不合规就**整份丢弃**并给出原因：半份账本比没有账本更危险，
 * 因为它看起来是「有记录」。
 * @param text 文件全文。
 * @returns 解析结果。
 */
export function parse(text: string): { readonly ok: true; readonly rows: readonly Consent[] } | { readonly ok: false; readonly reason: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: '顶层不是对象' }
  }
  const record = raw as Record<string, unknown>
  const version = record['version']
  if (version !== FORMAT_VERSION) {
    return { ok: false, reason: `版本不认识（文件 ${String(version)}，本版 ${FORMAT_VERSION}）` }
  }
  const list = record['consents']
  if (!Array.isArray(list)) return { ok: false, reason: '`consents` 不是数组' }

  const rows: Consent[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, reason: '有非对象的同意条目' }
    }
    const row = item as Record<string, unknown>
    const key = row['key']
    const id = row['id']
    const host = row['host']
    const at = row['at']
    const by = row['by']
    const expiresAt = row['expiresAt']
    if (typeof key !== 'string' || typeof id !== 'string' || typeof host !== 'string') {
      return { ok: false, reason: '有缺 key / id / host 的条目' }
    }
    if (typeof at !== 'number' || !Number.isFinite(at)) return { ok: false, reason: '有非法 `at`' }
    if (by !== 'user' && by !== 'policy') return { ok: false, reason: '有非法 `by`' }
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      return { ok: false, reason: '有非法 `expiresAt`' }
    }
    if (key !== consentKeyOf(id, host)) return { ok: false, reason: '`key` 与 `id@host` 不一致' }
    rows.push({ key, id, host, at, by, expiresAt })
  }
  return { ok: true, rows: Object.freeze(rows) }
}

/** 同意账本。 */
export class ConsentStore {
  readonly #rows = new Map<string, Consent>()
  readonly #now: () => number
  readonly #log: ConsentLogLike
  #ledger: ConsentLedger | null
  #writeFailed = 0

  /**
   * @param deps 依赖。
   */
  constructor(deps: ConsentStoreDeps) {
    this.#ledger = deps.ledger
    this.#now = deps.now
    this.#log = deps.log
    this.reload()
  }

  /** 换账本（`null` = 只放内存）。换完立刻按新账本重读。 */
  setLedger(ledger: ConsentLedger | null): void {
    this.#ledger = ledger
    this.#rows.clear()
    this.reload()
  }

  /** 落盘失败次数。 */
  get writeFailed(): number {
    return this.#writeFailed
  }

  /** 从账本重读（解析失败 = 空）。 */
  reload(): void {
    this.#rows.clear()
    if (this.#ledger === null) return
    const text = this.#ledger.read()
    if (text === null || text.trim() === '') return
    const parsed = parse(text)
    if (!parsed.ok) {
      this.#log.warn('同意账本读不出来，按空处理（宁可多问一遍）：%s', parsed.reason)
      return
    }
    for (const row of parsed.rows) this.#rows.set(row.key, row)
  }

  /**
   * 给一次同意。
   *
   * 有效期由调用方传（不是构造时存一份）：配置改了有效期，**下一次**点头立刻用新值，
   * 已存在的同意不重算到期时刻——重算会让「我明明点过」变成「又要问一遍」。
   * @param key 同意键（必须能拆成 `id@host`）。
   * @param by 谁给的。
   * @param ttlMs 有效期（毫秒）；`0` = 永不过期。
   * @returns 新同意与是否落盘；键不合规返回 `null`。
   */
  grant(key: string, by: ConsentBy, ttlMs: number): GrantOutcome | null {
    const parts = splitKey(key)
    if (parts === null) return null
    const at = this.#now()
    const row: Consent = {
      key,
      id: parts.id,
      host: parts.host,
      at,
      by,
      // `ttlMs === 0` 表示「永不过期」：用 `0` 作哨兵，而不是 `Infinity`
      // （`Infinity` 进 JSON 会变成 `null`，再读回来就崩）。
      expiresAt: ttlMs === 0 ? 0 : at + ttlMs,
    }
    this.#rows.set(key, row)
    return { row, persisted: this.persist() }
  }

  /**
   * 撤回一条。
   * @param key 同意键。
   */
  revoke(key: string): boolean {
    const removed = this.#rows.delete(key)
    if (removed) this.persist()
    return removed
  }

  /**
   * 查一条。
   * @param key 同意键。
   */
  get(key: string): Consent | undefined {
    return this.#rows.get(key)
  }

  /** 全部（含过期的）。 */
  all(): readonly Consent[] {
    return Object.freeze([...this.#rows.values()])
  }

  /** 有效条数。 */
  validCount(): number {
    const now = this.#now()
    let count = 0
    for (const row of this.#rows.values()) {
      if (row.expiresAt === 0 || row.expiresAt > now) count += 1
    }
    return count
  }

  /** 过期未清的条数。 */
  expiredCount(): number {
    const now = this.#now()
    let count = 0
    for (const row of this.#rows.values()) {
      if (row.expiresAt !== 0 && row.expiresAt <= now) count += 1
    }
    return count
  }

  /**
   * 清掉过期的。
   * @returns 清掉几条。
   */
  sweep(): number {
    const now = this.#now()
    let removed = 0
    for (const [key, row] of [...this.#rows.entries()]) {
      if (row.expiresAt !== 0 && row.expiresAt <= now) {
        this.#rows.delete(key)
        removed += 1
      }
    }
    if (removed > 0) this.persist()
    return removed
  }

  /**
   * 落盘。
   * @returns 成功没有（没有账本端口时返回 `false`，但**不算失败**）。
   */
  persist(): boolean {
    if (this.#ledger === null) return false
    const ok = this.#ledger.write(serialize(this.all()))
    if (!ok) {
      this.#writeFailed += 1
      this.#log.warn('同意账本写不进去（重启后会重新问一遍）：%s', this.#ledger.display)
    }
    return ok
  }

  /** 清空内存（`dispose()` 用）。**刻意不落盘**：卸载不等于撤回，账本留在磁盘上给下次启动用。 */
  clear(): void {
    this.#rows.clear()
  }
}
