/**
 * 弥散标记的持久化面：一张单行表。
 *
 * ## 只存「上一次弥散到哪儿」，不存历史
 *
 * 幂等只需要一个事实：**最近一次提领用的是哪个边界键、什么时候**。
 * 存成流水表会让「查上一次」变成一次排序查询，而这张表每场会话只写一行，
 * 流水会无限长而没人读。要审计就去看日志（`verbose` 打开时一行一条）。
 *
 * ## 时间存毫秒整数
 *
 * 与 O-010 / O-026 同口径。跨时区比较不会退化成字典序。
 *
 * ## 读失败按「没有标记」处理
 *
 * 读不出来时若当成「有标记」，弥散会永远不再发生（静默失效）；
 * 当成「没有标记」，最坏是多算一次（残差再乘 0.4）。两害相权取后者。
 */

import type { ColumnSpecLike, LogLike, RowLike, StoreLike, TableSpecLike } from './types.js'

/** 标记表名。 */
export const TABLE_MARK = 'emotion_diffuse_mark'

/** 单行表的主键。永远只有这一行。 */
const SINGLETON_ID = 'singleton'

/**
 * 列声明。
 *
 * 显式标成 `readonly ColumnSpecLike[]`：三组形状不同的对象字面量放一个数组里，
 * 推断会把 `type` 拓宽成 `string`，整个表声明就不再满足 `TableSpecLike`。
 */
const MARK_COLUMNS: readonly ColumnSpecLike[] = Object.freeze([
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'boundary_key', type: 'TEXT', notNull: true },
  { name: 'claimed_at', type: 'INTEGER', notNull: true },
  { name: 'mood_before', type: 'REAL', notNull: true },
  { name: 'target', type: 'REAL', notNull: true },
  { name: 'familiarity', type: 'REAL', notNull: true },
])

/** 表结构。 */
const MARK_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_MARK,
  columns: MARK_COLUMNS,
  strict: true,
})

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 一行标记。 */
export interface MarkRow {
  /** 边界键。 */
  readonly boundaryKey: string
  /** 提领时刻。 */
  readonly claimedAt: number
  /** 弥散前的心情。 */
  readonly moodBefore: number
  /** 目标心情。 */
  readonly target: number
  /** 当时的熟悉度。 */
  readonly familiarity: number
}

/** 标记仓库。 */
export class MarkStore {
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

  /** 后端标识，给 `stats()` 用（`none` 表示只在内存）。 */
  get provider(): string {
    return this.store.provider
  }

  /**
   * 建表。失败**不抛**：没有标记表时弥散照常算，只是重启后可能重算一次。
   * @returns 是否可用。
   */
  ensure(): boolean {
    try {
      const result = this.store.ensureTable(MARK_TABLE)
      for (const issue of result.issues) {
        this.log.warn('弥散标记表有问题（%s）：%s', issue.code, issue.detail)
      }
      return true
    } catch (error) {
      this.log.warn('建弥散标记表失败，本次运行只记内存：%s', messageOf(error))
      return false
    }
  }

  /**
   * 读标记。
   * @returns 标记；没有或读失败时为 `undefined`。
   */
  load(): MarkRow | undefined {
    try {
      const rows: RowLike[] = this.store.select(TABLE_MARK, {
        where: [{ column: 'id', op: 'eq', value: SINGLETON_ID }],
        limit: 1,
      })
      const row: RowLike | undefined = rows[0]
      if (row === undefined) return undefined
      return {
        boundaryKey: String(row['boundary_key'] ?? ''),
        claimedAt: Number(row['claimed_at'] ?? 0),
        moodBefore: Number(row['mood_before'] ?? 0),
        target: Number(row['target'] ?? 0),
        familiarity: Number(row['familiarity'] ?? 0),
      }
    } catch (error) {
      this.log.warn('读弥散标记失败，按「没有标记」处理：%s', messageOf(error))
      return undefined
    }
  }

  /**
   * 写标记。
   * @param mark 要写的一行。
   * @returns 是否成功。
   */
  save(mark: MarkRow): boolean {
    const row: RowLike = {
      id: SINGLETON_ID,
      boundary_key: mark.boundaryKey,
      claimed_at: Math.trunc(mark.claimedAt),
      mood_before: mark.moodBefore,
      target: mark.target,
      familiarity: mark.familiarity,
    }
    try {
      // upsert 而不是 insert：单行表第二次保存时主键已存在。
      this.store.upsert(TABLE_MARK, row)
      return true
    } catch (error) {
      this.log.warn('写弥散标记失败（下次再试）：%s', messageOf(error))
      return false
    }
  }
}
