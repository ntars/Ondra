/**
 * 锁状态的持久化面：一张单行表。
 *
 * ## 为什么单行
 *
 * 一段关系只有一个冲突锁。存成「一次吵架一行」会带来两个问题：
 * ①「现在锁着没有」要 `ORDER BY since DESC LIMIT 1`，而漏了 `WHERE` 就查到历史；
 * ②解锁要写一行 *结束时间*，于是「锁」变成一个区间表，
 * 而手册根本没要求「吵过几次架」这种统计（`releases` 一个计数就够）。
 *
 * ## 为什么只存锁，不存情绪
 *
 * 张力与心情在 O-026 的单行表里。本表**再存一份当前值**就是双真源：
 * 两边各自衰减、各自被写，谁对谁错没有答案。
 * 本表只存「进锁那一刻的心情」（`mood_at_lock`）——它是**事件快照**，
 * 不是当前值，用来判「回升」时才不会随 O-026 一起漂。
 *
 * ## 读失败按「没锁」处理
 *
 * 读不出来时若当成「锁着」，她会一直冷着脸且无人知道为什么；
 * 当成「没锁」最坏是漏掉一次冷淡。两害相权取后者。
 */

import type { ColumnSpecLike, ConflictLock, LogLike, RowLike, StoreLike, TableSpecLike } from './types.js'

/** 状态表名。 */
export const TABLE_CONFLICT = 'emotion_conflict_lock'

/** 单行表的主键。永远只有这一行。 */
const SINGLETON_ID = 'singleton'

/** 列声明。显式标类型，避免 `type` 被拓宽成 `string`。 */
const CONFLICT_COLUMNS: readonly ColumnSpecLike[] = Object.freeze([
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'locked', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'reason', type: 'TEXT', notNull: true, default: "''" },
  { name: 'since', type: 'INTEGER', notNull: true, default: '0' },
  // 可空：阈值派生的锁没有「进锁那一刻的心情」。
  { name: 'mood_at_lock', type: 'REAL' },
  { name: 'tension_at_lock', type: 'REAL' },
  { name: 'positive_streak', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'releases', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'updated_at', type: 'INTEGER', notNull: true, default: '0' },
])

/** 表结构。 */
const CONFLICT_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_CONFLICT,
  columns: CONFLICT_COLUMNS,
  strict: true,
})

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 一行的原始形态。 */
export interface RawConflictRow {
  /** 是否锁着。 */
  readonly locked: boolean
  /** 原因原文（可能是脏数据）。 */
  readonly reason: string
  /** 进锁时刻。 */
  readonly since: number
  /** 进锁那一刻的心情；缺失为 `undefined`。 */
  readonly moodAtLock: number | undefined
  /** 进锁那一刻的张力；缺失为 `undefined`。 */
  readonly tensionAtLock: number | undefined
  /** 连续正向信号。 */
  readonly positiveStreak: number
  /** 历史解锁次数。 */
  readonly releases: number
  /** 上次写入时刻。 */
  readonly updatedAt: number
}

/** 冲突锁仓库。 */
export class ConflictStore {
  private readonly store: StoreLike
  private readonly log: LogLike

  /**
   * @param store 存储端口。
   * @param log 日志。
   */
  constructor(store: StoreLike, log: LogLike) {
    this.store = store
    this.log = log
  }

  /** 后端标识，给 `stats()` 用。 */
  get provider(): string {
    return this.store.provider
  }

  /**
   * 建表。失败**不抛**：锁只活在内存里，重启等于「刚和好」。
   * @returns 是否可用。
   */
  ensure(): boolean {
    try {
      const result = this.store.ensureTable(CONFLICT_TABLE)
      for (const issue of result.issues) {
        this.log.warn('冲突锁状态表有问题（%s）：%s', issue.code, issue.detail)
      }
      return true
    } catch (error) {
      this.log.warn('建冲突锁状态表失败，本次运行不落盘：%s', messageOf(error))
      return false
    }
  }

  /**
   * 读存档。
   * @returns 原始行；没有存档或读失败时为 `undefined`。
   */
  load(): RawConflictRow | undefined {
    try {
      const rows: RowLike[] = this.store.select(TABLE_CONFLICT, {
        where: [{ column: 'id', op: 'eq', value: SINGLETON_ID }],
        limit: 1,
      })
      const row: RowLike | undefined = rows[0]
      if (row === undefined) return undefined
      return {
        locked: Number(row['locked'] ?? 0) === 1,
        reason: String(row['reason'] ?? ''),
        since: Number(row['since'] ?? 0),
        moodAtLock: nullableNumber(row['mood_at_lock']),
        tensionAtLock: nullableNumber(row['tension_at_lock']),
        positiveStreak: Number(row['positive_streak'] ?? 0),
        releases: Number(row['releases'] ?? 0),
        updatedAt: Number(row['updated_at'] ?? 0),
      }
    } catch (error) {
      this.log.warn('读冲突锁存档失败，按「没锁」处理：%s', messageOf(error))
      return undefined
    }
  }

  /**
   * 写存档。
   * @param lock 当前锁。
   * @param at 时刻。
   * @returns 是否成功。
   */
  save(lock: ConflictLock, at: number): boolean {
    const row: RowLike = {
      id: SINGLETON_ID,
      locked: lock.locked ? 1 : 0,
      reason: lock.reason ?? '',
      since: Math.trunc(lock.since),
      // 用 null 而不是 -1 当哨兵：-1 是一个合法的心情值域外的数，
      // 但「缺失」与「-1」在 JSON 里长得一样，日后一定会有人读错。
      mood_at_lock: lock.moodAtLock === undefined ? null : lock.moodAtLock,
      tension_at_lock: lock.tensionAtLock === undefined ? null : lock.tensionAtLock,
      positive_streak: Math.trunc(lock.positiveStreak),
      releases: Math.trunc(lock.releases),
      updated_at: Math.trunc(at),
    }
    try {
      // upsert：单行表第二次保存时主键已存在。
      this.store.upsert(TABLE_CONFLICT, row)
      return true
    } catch (error) {
      this.log.warn('写冲突锁存档失败（下次再试）：%s', messageOf(error))
      return false
    }
  }
}

/** 可空数字列 → `number | undefined`。 */
function nullableNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}
