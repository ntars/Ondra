/**
 * 复习计划表：SM-2 的持久化面。
 *
 * 为什么自己建表，而不是往 O-010 的 `memory_fact` 上加列：
 *
 * 1. **`memory_fact` 是「记忆是什么」，本表是「什么时候该复习」**——两件不同生命周期的事。
 *    往事实表加四列，会让 O-010 的 `toRecord()` 多出四个与本插件绑定的字段，
 *    等于把 O-013 的私有状态塞进全仓共用的契约里。
 * 2. **本表可整张丢弃**。删掉 `memory_review` 只会让复习计划归零（下次扫描重建），
 *    一条记忆都不会丢。反过来，把计划混进事实表，清理计划就等于碰事实。
 *
 * 三条列设计取舍：
 *
 * - **时间存毫秒整数**（与 O-010 同口径），跨时区比较不会退化成字典序。
 * - **`interval_hours` 必须存**：`reps > 8` 之后间隔是 `上一档 × EF`，
 *   没有上一档就每次都要重算整条链——而重算链在 EF 被改过之后必然算错。
 * - **`grade` 存最近一次评分（-1 表示还没复习过）**：`-1` 而不是 `0`，
 *   因为 `0` 是一个合法的评分（完全没想起来），两者必须能区分。
 */

import type { Config } from './settings.js'
import type { LogLike, RowLike, StoreLike, TableSpecLike } from './types.js'

/** 复习表名。 */
export const TABLE_REVIEW = 'memory_review'

/** 一行复习计划。 */
export interface ReviewRow {
  /** 记忆 id（与 O-010 的事实 id 一一对应）。 */
  readonly id: string
  /** 难度系数。 */
  readonly ef: number
  /** 连续成功复习次数。 */
  readonly reps: number
  /** 遗忘次数。 */
  readonly lapses: number
  /** 上一次的间隔（小时）。 */
  readonly intervalHours: number
  /** 最近一次复习时刻。 */
  readonly lastReviewAt: number
  /** 下次该复习的时刻。 */
  readonly dueAt: number
  /** 最近一次评分；-1 表示还没复习过。 */
  readonly grade: number
  /** 计划创建时刻。 */
  readonly createdAt: number
}

/** 表结构。 */
const REVIEW_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_REVIEW,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'ef', type: 'REAL', notNull: true, default: '2.5' },
    { name: 'reps', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'lapses', type: 'INTEGER', notNull: true, default: '0' },
    { name: 'interval_hours', type: 'REAL', notNull: true, default: '0' },
    { name: 'last_review_at', type: 'INTEGER', notNull: true },
    { name: 'due_at', type: 'INTEGER', notNull: true },
    { name: 'grade', type: 'INTEGER', notNull: true, default: '-1' },
    { name: 'created_at', type: 'INTEGER', notNull: true },
  ]),
  indexes: Object.freeze([
    { name: 'idx_memory_review_due', columns: Object.freeze(['due_at']) },
  ]),
  strict: true,
} satisfies TableSpecLike)

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 读数字。 */
function numOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 读整数。 */
function intOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

/** 读字符串。 */
function strOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 复习计划仓库。 */
export class ReviewStore {
  private readonly store: StoreLike
  private readonly settings: Config
  private readonly log: LogLike

  private ready = false

  /**
   * @param store 存储端口。
   * @param settings 已补全的配置。
   * @param log 日志。
   */
  constructor(store: StoreLike, settings: Config, log: LogLike) {
    this.store = store
    this.settings = settings
    this.log = log
  }

  /** 表是否可用。 */
  get available(): boolean {
    return this.ready
  }

  /**
   * 建表（幂等）。由 `apply()` 调一次。
   * @returns 是否可用。
   */
  ensure(): boolean {
    try {
      const result = this.store.ensureTable(REVIEW_TABLE)
      for (const issue of result.issues) {
        this.log.warn('复习表建表问题（%s）：%s', issue.code, issue.detail)
      }
      this.ready = true
    } catch (error) {
      this.ready = false
      this.log.error('复习表建表失败（复习计划不可用，衰减强度仍可读）：%s', messageOf(error))
    }
    return this.ready
  }

  /**
   * 取一条计划。
   * @param id 记忆 id。
   */
  get(id: string): ReviewRow | undefined {
    if (!this.ready || typeof id !== 'string' || id === '') return undefined
    try {
      const row = this.store.select(TABLE_REVIEW, {
        where: [{ column: 'id', op: 'eq', value: id }],
        limit: 1,
      })
      const first = row[0]
      return first === undefined ? undefined : this.toRow(first)
    } catch (error) {
      this.log.warn('读复习计划失败（%s）：%s', id, messageOf(error))
      return undefined
    }
  }

  /**
   * 写入/覆盖一条计划。
   * @param row 计划。
   * @returns 是否写进去了。
   */
  put(row: ReviewRow): boolean {
    if (!this.ready) return false
    try {
      // 用 upsert 而不是「先查再决定 insert/update」：后者在两次调用之间
      // 可能被别人插入同一 id，结果是主键冲突——而这个冲突没有任何业务含义。
      this.store.upsert(TABLE_REVIEW, {
        id: row.id,
        ef: row.ef,
        reps: row.reps,
        lapses: row.lapses,
        interval_hours: row.intervalHours,
        last_review_at: row.lastReviewAt,
        due_at: row.dueAt,
        grade: row.grade,
        created_at: row.createdAt,
      })
      return true
    } catch (error) {
      this.log.warn('写复习计划失败（%s）：%s', row.id, messageOf(error))
      return false
    }
  }

  /**
   * 到期该复习的计划（按到期时间升序，越早到期越靠前）。
   * @param at 时刻。
   * @param limit 条数上限。
   */
  due(at: number, limit: number): readonly ReviewRow[] {
    if (!this.ready) return []
    try {
      const rows = this.store.select(TABLE_REVIEW, {
        where: [{ column: 'due_at', op: 'lte', value: at }],
        orderBy: [{ column: 'due_at', direction: 'asc' }],
        limit: Math.max(1, Math.min(this.settings.maxReviewBatch, Math.trunc(limit))),
      })
      return rows.map(row => this.toRow(row))
    } catch (error) {
      this.log.warn('取到期复习失败：%s', messageOf(error))
      return []
    }
  }

  /**
   * 删掉一条计划（记忆已被用户忘记时用）。
   *
   * 孤儿计划不清会一直留在表里：`countDue()` 会把它算进去，界面就会显示
   * 「有 3 条该复习了」，点进去一条都没有。
   * @param id 记忆 id。
   * @returns 是否删掉了。
   */
  remove(id: string): boolean {
    if (!this.ready || typeof id !== 'string' || id === '') return false
    try {
      return this.store.delete(TABLE_REVIEW, { id }) > 0
    } catch (error) {
      this.log.warn('删复习计划失败（%s）：%s', id, messageOf(error))
      return false
    }
  }

  /**
   * 已有哪些记忆有复习计划（**一次查询拿全**）。
   *
   * 为什么要有它：扫描时要对每条记忆判断「有没有计划」，逐条 `get()` 就是 N 次
   * 单行查询——3000 条约 3000 次往返，比一次全量查询慢一个量级，而它跑在
   * 可能被对话链调用的路径上。
   * @param limit 最多读多少行。
   */
  ids(limit: number): ReadonlySet<string> {
    const out = new Set<string>()
    if (!this.ready) return out
    try {
      const rows = this.store.select(TABLE_REVIEW, { limit: Math.max(1, Math.trunc(limit)) })
      for (const row of rows) {
        const id = strOf(row['id'])
        if (id !== null) out.add(id)
      }
    } catch (error) {
      this.log.warn('读复习计划 id 集合失败（本轮按「全都没计划」处理，会重复 put）：%s', messageOf(error))
    }
    return out
  }

  /**
   * 到期条数。
   * @param at 时刻。
   */
  countDue(at: number): number {
    if (!this.ready) return 0
    try {
      return this.store.count(TABLE_REVIEW, [{ column: 'due_at', op: 'lte', value: at }])
    } catch {
      return 0
    }
  }

  /** 总条数。 */
  count(): number {
    if (!this.ready) return 0
    try {
      return this.store.count(TABLE_REVIEW)
    } catch {
      return 0
    }
  }

  /** 行 → 视图。 */
  private toRow(row: RowLike): ReviewRow {
    return Object.freeze({
      id: strOf(row['id']) ?? '',
      ef: numOf(row['ef'], 2.5),
      reps: Math.max(0, intOf(row['reps'], 0)),
      lapses: Math.max(0, intOf(row['lapses'], 0)),
      intervalHours: Math.max(0, numOf(row['interval_hours'], 0)),
      lastReviewAt: intOf(row['last_review_at'], 0),
      dueAt: intOf(row['due_at'], 0),
      grade: intOf(row['grade'], -1),
      createdAt: intOf(row['created_at'], 0),
    })
  }
}
