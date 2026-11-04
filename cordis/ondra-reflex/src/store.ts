/**
 * 状态落盘：反射与候选各写一行，同表不同 `kind`。
 *
 * ## 为什么一张表
 *
 * 两种记录的形状完全不同（反射是一对「工具×因」，候选是一条序列），但它们的
 * 使用方式一模一样：启动时全读一遍，之后按 id upsert。分两张表要多一套建表、多一处
 * 能漂的列定义，收益只有「看起来更整齐」。
 *
 * ## 落盘是**软要求**
 *
 * 手册没要求 O-144 持久化。但「同工具×同因失败 3 次」是按累计次数算的，
 * 不落盘就意味着每次重启都从第一次重新数——一个每天重启的进程永远长不出反射。
 * 所以有存储就写，没有就只在内存，并在 `stats().persisted` 里**明说**，
 * 而不是让人以为它在记。
 */

import type { StorePortLike, StoreRow, StoreTableLike } from './types.js'

/** 表名（SQL 标识符规则：小写 + 下划线）。 */
export const REFLEX_TABLE_NAME = 'reflex_record'

/** 表声明。 */
export const REFLEX_TABLE: StoreTableLike = Object.freeze({
  name: REFLEX_TABLE_NAME,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
    { name: 'kind', type: 'TEXT', notNull: true },
    { name: 'payload', type: 'TEXT', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
    { name: 'updated_at', type: 'INTEGER', notNull: true },
  ] as const),
  indexes: Object.freeze([{ name: 'idx_reflex_record_kind', columns: Object.freeze(['kind']) }] as const),
  strict: true,
})

/** 一行读出来的原始记录。 */
export interface StoredRow {
  readonly id: string
  readonly kind: string
  readonly payload: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** 落盘适配器。 */
export class ReflexStore {
  private ensured = false

  constructor(private readonly port: StorePortLike) {}

  /** 建表（幂等）。失败原样抛出，由调用方计数。 */
  ensure(): void {
    if (this.ensured) return
    this.port.ensureTable(REFLEX_TABLE)
    this.ensured = true
  }

  /**
   * 写一行。
   * @param id 主键（反射用 key，候选用 slug）。
   * @param kind 种类。
   * @param payload JSON 正文字符串。
   * @param at 写入时刻。
   */
  put(id: string, kind: string, payload: string, at: number): void {
    this.ensure()
    const row: StoreRow = { id, kind, payload, created_at: at, updated_at: at }
    this.port.upsert(REFLEX_TABLE_NAME, row)
  }

  /** 读全部记录（顺序不重要，调用方按 kind 分派）。 */
  rows(): readonly StoredRow[] {
    this.ensure()
    const out: StoredRow[] = []
    for (const row of this.port.select(REFLEX_TABLE_NAME)) {
      const id = row['id']
      const kind = row['kind']
      const payload = row['payload']
      const createdAt = row['created_at']
      const updatedAt = row['updated_at']
      if (typeof id !== 'string' || typeof kind !== 'string' || typeof payload !== 'string') continue
      if (typeof createdAt !== 'number' || typeof updatedAt !== 'number') continue
      out.push({ id, kind, payload, createdAt, updatedAt })
    }
    return out
  }
}
