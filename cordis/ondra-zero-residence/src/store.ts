/**
 * 存储适配层：把「零常驻账本」落到 O-006 `ondra-store-sqlite` 上。
 *
 * ## 只做一件事：让「先落盘再交指针」真的成立
 *
 * 手册的顺序是死的：**压缩前状态先写 SQLite**，然后才允许把指针交出去。
 * 所以本文件唯一的职责是「写成功」或「抛错」，绝不悄悄吞掉写失败——
 * 吞掉的后果是调用方拿到一条指向空处的指针，而账上看起来一切正常。
 *
 * ## 一张表，不建第二张
 *
 * `zr_record` 里正文与元数据同表。分成「索引表 + 正文表」的写法在这里没有收益：
 * 读取永远是「按主键取一行」，而分表要多一次事务协调，也就多一处能不一致的地方。
 *
 * ## 为什么键里有 `session_id` 却不用复合主键
 *
 * id 已经是「会话 + 正文」的指纹，全局唯一。用单列主键的好处是 `get(id)` 一句话就能取，
 * 不必先知道会话；坏处是理论上 48 位撞号时会同 id 不同内容——那种情况由
 * `service.ts` 的撞号后缀处理，不进表结构。
 */

import type { StorePortLike, StoreRow, StoreTableLike, ZrRecord } from './types.js'
import type { ZrEntry } from './ledger.js'

/** 表名。符合 `^[a-z][a-z0-9_]*$`（列与表不走 `KEY_RE`，它们是 SQL 标识符）。 */
export const ZR_TABLE_NAME = 'zr_record'

/** 表声明。`STRICT` 让「往 INTEGER 列写字符串」当场报错，而不是存进去以后取出来才发现。 */
export const ZR_TABLE: StoreTableLike = Object.freeze({
  name: ZR_TABLE_NAME,
  columns: Object.freeze([
    { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
    { name: 'session_id', type: 'TEXT', notNull: true },
    { name: 'ordinal', type: 'INTEGER', notNull: true },
    { name: 'chars', type: 'INTEGER', notNull: true },
    { name: 'fnv', type: 'TEXT', notNull: true },
    { name: 'text', type: 'TEXT', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
  ] as const),
  indexes: Object.freeze([
    { name: 'idx_zr_record_session', columns: Object.freeze(['session_id', 'ordinal']) },
  ] as const),
  strict: true,
})

/**
 * 把一行读成记录。**缺字段就返回 undefined**，不补默认值：
 * 补出来的 `chars: 0` 会让恢复永远判「长度不符」，比不返回更难查。
 * @param row 数据库行。
 */
function recordOfRow(row: StoreRow | undefined): ZrRecord | undefined {
  if (row === undefined) return undefined
  const id = row['id']
  const sessionId = row['session_id']
  const ordinal = row['ordinal']
  const chars = row['chars']
  const fnv = row['fnv']
  const createdAt = row['created_at']
  if (typeof id !== 'string' || typeof sessionId !== 'string') return undefined
  if (typeof ordinal !== 'number' || typeof chars !== 'number') return undefined
  if (typeof fnv !== 'string' || typeof createdAt !== 'number') return undefined
  return { id, sessionId, ordinal, chars, fnv, createdAt }
}

/** 账本落盘适配器。 */
export class ZrStoreAdapter {
  private ensured = false

  constructor(private readonly port: StorePortLike) {}

  /** 建表（幂等）。失败原样抛出，由调用方折成 `store-error`。 */
  ensure(): void {
    if (this.ensured) return
    this.port.ensureTable(ZR_TABLE)
    this.ensured = true
  }

  /**
   * 一次性写入多条。**同一个事务**：要么全进，要么一条都不进。
   *
   * 逐个写会在第三个失败时留下两条孤记录——它们无害（没人引用），但会让
   * 「账本条数」与「真实可恢复条数」对不上，而那个差值是查不出来的。
   * @param entries 待写记录（含正文）。
   */
  putMany(entries: readonly ZrEntry[]): void {
    if (entries.length === 0) return
    this.ensure()
    this.port.transaction(() => {
      for (const entry of entries) {
        const row: StoreRow = {
          id: entry.id,
          session_id: entry.sessionId,
          ordinal: entry.ordinal,
          chars: entry.chars,
          fnv: entry.fnv,
          text: entry.text ?? '',
          created_at: entry.createdAt,
        }
        this.port.upsert(ZR_TABLE_NAME, row)
      }
    })
  }

  /**
   * 取一条正文。
   * @param id 指针 id。
   */
  textOf(id: string): string | undefined {
    this.ensure()
    const row = this.port.get(ZR_TABLE_NAME, { id })
    if (row === undefined) return undefined
    const text = row['text']
    return typeof text === 'string' ? text : undefined
  }

  /**
   * 取一条元数据。
   * @param id 指针 id。
   */
  recordOf(id: string): ZrRecord | undefined {
    this.ensure()
    return recordOfRow(this.port.get(ZR_TABLE_NAME, { id }))
  }

  /**
   * 全量索引（**不含正文**）。
   *
   * 启动时只读索引，正文按需取：512 条 × 4000 字全部提前读进内存，
   * 就是 2MB 常驻——一个号称「零常驻」的插件自己先常驻 2MB，说不过去。
   */
  index(): readonly ZrRecord[] {
    this.ensure()
    const rows = this.port.select(ZR_TABLE_NAME, { orderBy: [{ column: 'ordinal', direction: 'asc' }] })
    const out: ZrRecord[] = []
    for (const row of rows) {
      const record = recordOfRow(row)
      if (record !== undefined) out.push(record)
    }
    return out
  }
}
