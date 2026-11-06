/**
 * 判重决策日志：**回答「我的记忆怎么少了一条」**。
 *
 * 为什么需要它：`merge` / `drop` 都是**不新增条目**的裁决。用户看到的是
 * 「我明明说过这件事，怎么没记住」，而库里没有任何痕迹——没有日志，
 * 这个疑问永远查不出来。日志不是为了调试，是为了**可解释**。
 *
 * 三条设计取舍：
 *
 * 1. **表归本插件所有，不写进 O-010 的表。** 判重日志是 O-012 的私有审计面，
 *    塞进 `memory_fact` 会让「记忆条数」这个数字被日志污染。
 * 2. **只留残文（默认 200 字），不留全文。** 日志是旁证，不是第二份记忆库；
 *    存全文等于在用户要求合并/丢弃之后又留了一份可读副本。
 * 3. **日志缺席不影响判重。** 没有存储端口时 `logging=false`，判定照常——
 *    审计能力缺失是降级，不是故障。
 */

import type { Config } from './settings.js'
import type { DedupeAction, LogLike, RowLike, StoreLike, TableSpecLike } from './types.js'

/** 日志表名。 */
export const TABLE_DEDUPE_LOG = 'memory_dedupe_log'

/** 一条日志。 */
export interface DedupeLogEntry {
  /** 裁决时刻。 */
  readonly at: number
  /** 五分类之一。 */
  readonly action: DedupeAction
  /** 目标记忆 id（`add` 时为空）。 */
  readonly targetId: string | null
  /** 待写入正文的残文。 */
  readonly text: string
  /** 与目标条的包含度。 */
  readonly containment: number
  /** 判定理由（已拼成一行）。 */
  readonly reason: string
  /** 是否真的写入了新条。 */
  readonly written: boolean
}

/** 日志表结构。时间一律存毫秒整数（与 O-010 同口径）。 */
const LOG_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_DEDUPE_LOG,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'at', type: 'INTEGER', notNull: true },
    { name: 'action', type: 'TEXT', notNull: true },
    { name: 'target_id', type: 'TEXT' },
    { name: 'text', type: 'TEXT' },
    { name: 'containment', type: 'REAL', notNull: true, default: '0' },
    { name: 'reason', type: 'TEXT' },
    { name: 'written', type: 'INTEGER', notNull: true, default: '0' },
  ]),
  indexes: Object.freeze([
    { name: 'idx_memory_dedupe_log_at', columns: Object.freeze(['at']) },
    { name: 'idx_memory_dedupe_log_target', columns: Object.freeze(['target_id']) },
  ]),
  strict: true,
} satisfies TableSpecLike)

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 读字符串字段。 */
function strOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 判重日志。 */
export class DedupeLog {
  private readonly store: StoreLike
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number

  private ready = false
  private seq = 0

  /**
   * @param store 存储端口。
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   */
  constructor(store: StoreLike, settings: Config, log: LogLike, now: () => number) {
    this.store = store
    this.settings = settings
    this.log = log
    this.now = now
  }

  /** 日志是否可用。 */
  get available(): boolean {
    return this.ready
  }

  /**
   * 建表（幂等）。由 `apply()` 调一次，不装定时器。
   * @returns 是否可用。
   */
  ensure(): boolean {
    try {
      const result = this.store.ensureTable(LOG_TABLE)
      for (const issue of result.issues) {
        this.log.warn('判重日志建表问题（%s）：%s', issue.code, issue.detail)
      }
      this.ready = true
    } catch (error) {
      // 日志建不起来不是致命：判重照常，只是事后查不到「为什么合并了」。
      this.ready = false
      this.log.warn('判重日志建表失败（判重照常，只是事后查不到裁决记录）：%s', messageOf(error))
    }
    return this.ready
  }

  /**
   * 追加一条。
   * @param entry 日志内容。
   * @returns 是否写进去了。
   */
  append(entry: DedupeLogEntry): boolean {
    if (!this.ready) return false
    try {
      this.seq += 1
      const row: RowLike = {
        id: `d-${entry.at.toString(36)}-${this.seq.toString(36)}`,
        at: entry.at,
        action: entry.action,
        target_id: entry.targetId,
        text: [...entry.text].slice(0, this.settings.maxLogTextChars).join(''),
        containment: entry.containment,
        reason: entry.reason,
        written: entry.written ? 1 : 0,
      }
      this.store.insert(TABLE_DEDUPE_LOG, row)
      this.prune()
      return true
    } catch (error) {
      // 日志写失败绝不冒泡：判重已经做完，日志只是旁证。
      this.log.warn('写判重日志失败（判定结果不受影响）：%s', messageOf(error))
      return false
    }
  }

  /** 行数。 */
  count(): number {
    if (!this.ready) return 0
    try {
      return this.store.count(TABLE_DEDUPE_LOG)
    } catch {
      return 0
    }
  }

  /**
   * 最近若干条（给审计面读）。
   * @param limit 条数。
   */
  recent(limit: number): readonly DedupeLogEntry[] {
    if (!this.ready) return []
    try {
      const rows = this.store.select(TABLE_DEDUPE_LOG, {
        orderBy: [{ column: 'at', direction: 'desc' }],
        limit: Math.max(1, Math.trunc(limit)),
      })
      return rows.map(row => this.toEntry(row))
    } catch (error) {
      this.log.warn('读判重日志失败：%s', messageOf(error))
      return []
    }
  }

  /**
   * 清理旧行（**分批删**，不一次删光）。
   *
   * 为什么分批：一次删几千行会在 SQLite 上产生一个长事务，写入路径上卡住的
   * 是「她正在记住一句话」这件事。每轮只删 `logPruneBatch` 行，下一轮接着删。
   * @returns 本次删掉的行数。
   */
  prune(): number {
    if (!this.ready) return 0
    const limit = this.settings.logLimit
    if (limit <= 0) return 0
    try {
      const total = this.store.count(TABLE_DEDUPE_LOG)
      if (total <= limit) return 0
      const excess = Math.min(total - limit, this.settings.logPruneBatch)
      const rows = this.store.select(TABLE_DEDUPE_LOG, {
        orderBy: [{ column: 'at', direction: 'asc' }],
        limit: excess,
      })
      let removed = 0
      for (const row of rows) {
        const id = strOf(row['id'])
        if (id === null) continue
        removed += this.store.delete(TABLE_DEDUPE_LOG, { id })
      }
      return removed
    } catch (error) {
      this.log.warn('清理判重日志失败（下次再试）：%s', messageOf(error))
      return 0
    }
  }

  /** 行 → 视图。 */
  private toEntry(row: RowLike): DedupeLogEntry {
    const action = strOf(row['action']) ?? 'add'
    return Object.freeze({
      at: typeof row['at'] === 'number' ? row['at'] : this.now(),
      action: action as DedupeAction,
      targetId: strOf(row['target_id']),
      text: strOf(row['text']) ?? '',
      containment: typeof row['containment'] === 'number' ? row['containment'] : 0,
      reason: strOf(row['reason']) ?? '',
      written: row['written'] === 1,
    })
  }
}
