/**
 * 记账表 `memory_recall_trace`（本插件独占）。
 *
 * ## 为什么只记「未命中次数」
 *
 * 内核已经有 `hits`（被检索命中）与 `lastHitAt`（最近被想起）。本插件若再记一份
 * 「上次想起时间」，就会出现两个答案：骰子说昨天想起过、注入说三天没见。
 * 手册的「3 天内想过跳过」于是时灵时不灵，且查不出原因。
 *
 * 所以本表**只记内核没有的概念**：`miss_count`（勾起了但没想起来）。
 * 「上次被想起」一律读内核的 `lastHitAt`（`reinforce('hit')` 会写它）。
 *
 * ## 没有存储端口时
 *
 * 退到内存 `Map`，`stats().tracePersisted = false`，并记一条 `trace-memory-only`。
 * **不假装落过盘**：进程重启后 `miss_count` 归零，这是可见的降级，
 * 不是「悄悄丢了一点点统计」。
 */

import type { LogLike, RecallTrace, StoreLike, TableSpecLike } from './types.js'

/** 表名。 */
export const TABLE_TRACE = 'memory_recall_trace'

/** 表声明。 */
export const TRACE_SPEC: TableSpecLike = Object.freeze({
  name: TABLE_TRACE,
  columns: Object.freeze([
    Object.freeze({ name: 'id', type: 'TEXT' as const, primaryKey: true }),
    Object.freeze({ name: 'miss_count', type: 'INTEGER' as const, notNull: true, default: '0' }),
    Object.freeze({ name: 'dice_count', type: 'INTEGER' as const, notNull: true, default: '0' }),
    Object.freeze({ name: 'cue_count', type: 'INTEGER' as const, notNull: true, default: '0' }),
    Object.freeze({ name: 'last_miss_at', type: 'INTEGER' as const, notNull: true, default: '0' }),
    Object.freeze({ name: 'last_dice_at', type: 'INTEGER' as const, notNull: true, default: '0' }),
  ]),
})

/** 取整数（库里读回来的可能是 string，也可能是 undefined）。 */
function intOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return fallback
}

/** 一次自增的增量。 */
export interface TraceBump {
  /** 未命中 +1。 */
  readonly miss?: boolean
  /** 勾起评估 +1。 */
  readonly cue?: boolean
  /** 固定回忆抽中 +1。 */
  readonly dice?: boolean
  /** 时间戳。 */
  readonly at: number
}

/** 记账存储。 */
export class TraceStore {
  private readonly store: StoreLike | undefined
  private readonly log: LogLike
  private readonly memory = new Map<string, RecallTrace>()
  private ready = false

  /**
   * @param store 存储端口；缺席则退内存。
   * @param log 日志。
   */
  constructor(store: StoreLike | undefined, log: LogLike) {
    this.store = store
    this.log = log
  }

  /** 是否落盘。 */
  get persisted(): boolean {
    return this.store !== undefined && this.ready
  }

  /** 建表。失败不抛，只降级到内存。 */
  ensure(): boolean {
    if (this.store === undefined) {
      this.log.warn('没有存储端口：未命中记账只存内存，进程重启后归零（stats().tracePersisted = false）')
      return false
    }
    try {
      const result = this.store.ensureTable(TRACE_SPEC)
      if (result.addedColumns.length > 0) {
        this.log.info('记账表补列：%s', result.addedColumns.join('、'))
      }
      this.ready = true
      return true
    } catch (error) {
      this.log.warn('记账表初始化失败，退回内存：%s', error instanceof Error ? error.message : String(error))
      this.ready = false
      return false
    }
  }

  /**
   * 读一条记账。
   * @param id 记忆 id。
   */
  read(id: string): RecallTrace | undefined {
    if (this.persisted && this.store !== undefined) {
      try {
        const row = this.store.get(TABLE_TRACE, { id })
        if (row !== undefined) return toTrace(row)
      } catch (error) {
        this.log.warn('读记账失败（%s）：%s', id, error instanceof Error ? error.message : String(error))
      }
    }
    return this.memory.get(id)
  }

  /**
   * 自增并写回。
   * @param id 记忆 id。
   * @param bump 增量。
   */
  bump(id: string, bump: TraceBump): RecallTrace {
    const previous = this.read(id) ?? {
      id,
      missCount: 0,
      diceCount: 0,
      cueCount: 0,
      lastMissAt: 0,
      lastDiceAt: 0,
    }

    const next: RecallTrace = Object.freeze({
      id,
      missCount: previous.missCount + (bump.miss === true ? 1 : 0),
      diceCount: previous.diceCount + (bump.dice === true ? 1 : 0),
      cueCount: previous.cueCount + (bump.cue === true ? 1 : 0),
      lastMissAt: bump.miss === true ? bump.at : previous.lastMissAt,
      lastDiceAt: bump.dice === true ? bump.at : previous.lastDiceAt,
    })

    if (this.persisted && this.store !== undefined) {
      try {
        this.store.upsert(TABLE_TRACE, {
          id: next.id,
          miss_count: next.missCount,
          dice_count: next.diceCount,
          cue_count: next.cueCount,
          last_miss_at: next.lastMissAt,
          last_dice_at: next.lastDiceAt,
        })
        return next
      } catch (error) {
        // 写失败不抛：记账是旁路，不该让「她想起什么」这件事因为统计写不进去而失败。
        this.log.warn('写记账失败（%s），本条只留内存：%s', id, error instanceof Error ? error.message : String(error))
      }
    }

    this.memory.set(id, next)
    return next
  }

  /** 内存里的总未命中次数（只用于统计；落盘时不代表全量）。 */
  memoryMisses(): number {
    let sum = 0
    for (const trace of this.memory.values()) sum += trace.missCount
    return sum
  }
}

/**
 * 一行 → 记账。
 * @param row 数据行。
 */
function toTrace(row: Record<string, unknown>): RecallTrace {
  const id = typeof row['id'] === 'string' ? row['id'] : ''
  return Object.freeze({
    id,
    missCount: intOf(row['miss_count'], 0),
    diceCount: intOf(row['dice_count'], 0),
    cueCount: intOf(row['cue_count'], 0),
    lastMissAt: intOf(row['last_miss_at'], 0),
    lastDiceAt: intOf(row['last_dice_at'], 0),
  })
}
