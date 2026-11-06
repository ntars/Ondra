/**
 * 缺口池的持久化面：一张池表 + 一张投递状态表。
 *
 * ## 为什么是两张表
 *
 * 「什么时候投递过」属于**会话级调度状态**，与缺口本身无关：
 * 它必须在池子空掉之后仍然存在（否则关掉最后一条执念，冷却期就跟着消失，
 * 下一分钟新建的那条能立刻把她叫醒）。混进池表就只能靠「随便挑一行当载体」，
 * 而那一行随时可能被删除。
 *
 * ## 为什么张力不存
 *
 * 张力是 `created_at` 的闭式函数（`drive.ts` 的 `tensionOf`）。
 * 存一份「当前张力」会带来两个必然的错：
 * ①它需要定时器定期刷新，而「谁负责刷」在装载顺序不确定时没有答案；
 * ②刷一次、读一次、写一次之间必然有偏差，于是面板上的数与判定用的数不一样。
 * 表里只存公式的四个参数（`base` / `rate_per_hour` / `relief` / `bump`）与两个时刻。
 *
 * ## 读失败按「空池」处理
 *
 * 读不出来时若当成「有执念」，她会莫名其妙来找你说话且无人知道为什么；
 * 当成「没有」最坏只是不做主动——主动少一次没人会发现，多一次会被发现了。
 */

import type { ColumnSpecLike, DriveGap, GapSource, GapStatus, LogLike, RowLike, StoreLike, TableSpecLike } from './types.js'
import { GAP_SOURCES } from './types.js'

/** 池表名。 */
export const TABLE_GAP = 'drive_gap'

/** 投递状态表名。 */
export const TABLE_WAKE = 'drive_wake_state'

/** 单行表的主键。 */
const SINGLETON_ID = 'singleton'

/** 池表的列声明。 */
const GAP_COLUMNS: readonly ColumnSpecLike[] = Object.freeze([
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'text', type: 'TEXT', notNull: true, default: "''" },
  { name: 'source', type: 'TEXT', notNull: true, default: "'model-unsure'" },
  { name: 'query', type: 'TEXT', notNull: true, default: "''" },
  { name: 'status', type: 'TEXT', notNull: true, default: "'open'" },
  { name: 'base', type: 'REAL', notNull: true, default: '0' },
  { name: 'rate_per_hour', type: 'REAL', notNull: true, default: '0' },
  { name: 'relief', type: 'REAL', notNull: true, default: '0' },
  { name: 'bump', type: 'REAL', notNull: true, default: '0' },
  { name: 'paused_ms', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'created_at', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'closed_at', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'closed_siblings', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'picks', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'last_picked_at', type: 'INTEGER', notNull: true, default: '0' },
])

/** 池表结构。状态列建索引：每次判唤醒都只查 open。 */
const GAP_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_GAP,
  columns: GAP_COLUMNS,
  indexes: Object.freeze([
    Object.freeze({ name: 'idx_drive_gap_status', columns: Object.freeze(['status', 'created_at']) }),
  ]),
  strict: true,
})

/** 投递状态表的列声明。 */
const WAKE_COLUMNS: readonly ColumnSpecLike[] = Object.freeze([
  { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
  { name: 'last_wake_at', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'pauses', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'paused_total_ms', type: 'INTEGER', notNull: true, default: '0' },
  { name: 'updated_at', type: 'INTEGER', notNull: true, default: '0' },
])

/** 投递状态表结构。 */
const WAKE_TABLE: TableSpecLike = Object.freeze({
  name: TABLE_WAKE,
  columns: WAKE_COLUMNS,
  strict: true,
})

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 投递状态。 */
export interface WakeState {
  /** 最近一次投递时刻（0 表示从未）。 */
  readonly lastWakeAt: number
  /** 休眠记账次数。 */
  readonly pauses: number
  /** 累计休眠毫秒。 */
  readonly pausedTotalMs: number
}

/** 空的投递状态。 */
export const EMPTY_WAKE_STATE: WakeState = Object.freeze({ lastWakeAt: 0, pauses: 0, pausedTotalMs: 0 })

/** 缺口池仓库（只管读写，不含业务判定）。 */
export class GapStore {
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
   * 建表。失败**不抛**：池子退化到内存态。
   * @returns 是否成功（两张都成就行）。
   */
  ensure(): boolean {
    try {
      const gap = this.store.ensureTable(GAP_TABLE)
      for (const issue of gap.issues) {
        this.log.warn('缺口池表有问题（%s）：%s', issue.code, issue.detail)
      }
      const wake = this.store.ensureTable(WAKE_TABLE)
      for (const issue of wake.issues) {
        this.log.warn('投递状态表有问题（%s）：%s', issue.code, issue.detail)
      }
      return true
    } catch (error) {
      this.log.warn('建缺口池表失败，本次运行只在内存里记账：%s', messageOf(error))
      return false
    }
  }

  /**
   * 读全部缺口（按创建时刻升序，保证「保留最早那条措辞」可复现）。
   * @param status 只读某个状态；省略读全部。
   * @returns 行数组；读失败返回空数组。
   */
  loadAll(status?: GapStatus): readonly DriveGap[] {
    try {
      const rows: RowLike[] = this.store.select(TABLE_GAP, {
        where: status === undefined ? [] : [{ column: 'status', op: 'eq', value: status }],
        orderBy: [{ column: 'created_at', direction: 'asc' }],
      })
      const out: DriveGap[] = []
      for (const row of rows) {
        const gap = toGap(row)
        if (gap !== undefined) out.push(gap)
      }
      return out
    } catch (error) {
      this.log.warn('读缺口池失败，本次按空池处理：%s', messageOf(error))
      return []
    }
  }

  /**
   * 取一条。
   * @param id 主键。
   */
  get(id: string): DriveGap | undefined {
    try {
      const row: RowLike | undefined = this.store.get(TABLE_GAP, { id })
      return row === undefined ? undefined : toGap(row)
    } catch (error) {
      this.log.warn('读缺口 %s 失败：%s', id, messageOf(error))
      return undefined
    }
  }

  /**
   * 插入一条。
   * @param gap 缺口。
   * @returns 是否成功。
   */
  insert(gap: DriveGap): boolean {
    try {
      this.store.insert(TABLE_GAP, toRow(gap))
      return true
    } catch (error) {
      this.log.warn('写缺口失败（%s）：%s', gap.id, messageOf(error))
      return false
    }
  }

  /**
   * 按主键更新若干列。
   * @param id 主键。
   * @param patch 要改的列。
   * @returns 是否成功。
   */
  update(id: string, patch: RowLike): boolean {
    try {
      this.store.update(TABLE_GAP, { id }, patch)
      return true
    } catch (error) {
      this.log.warn('更新缺口 %s 失败：%s', id, messageOf(error))
      return false
    }
  }

  /**
   * 删除若干行（只给 `prune` 用）。
   * @param ids 主键列表。
   * @returns 实际删除条数。
   */
  remove(ids: readonly string[]): number {
    let done = 0
    for (const id of ids) {
      try {
        done += this.store.delete(TABLE_GAP, { id })
      } catch (error) {
        this.log.warn('删除缺口 %s 失败：%s', id, messageOf(error))
      }
    }
    return done
  }

  /** 读投递状态。 */
  loadWake(): WakeState {
    try {
      const row: RowLike | undefined = this.store.get(TABLE_WAKE, { id: SINGLETON_ID })
      if (row === undefined) return EMPTY_WAKE_STATE
      return Object.freeze({
        lastWakeAt: Number(row['last_wake_at'] ?? 0) || 0,
        pauses: Number(row['pauses'] ?? 0) || 0,
        pausedTotalMs: Number(row['paused_total_ms'] ?? 0) || 0,
      })
    } catch (error) {
      this.log.warn('读投递状态失败，按「从未投递」处理：%s', messageOf(error))
      return EMPTY_WAKE_STATE
    }
  }

  /**
   * 写投递状态。
   * @param state 新状态。
   * @param at 时刻。
   */
  saveWake(state: WakeState, at: number): boolean {
    try {
      this.store.upsert(TABLE_WAKE, {
        id: SINGLETON_ID,
        last_wake_at: Math.trunc(state.lastWakeAt),
        pauses: Math.trunc(state.pauses),
        paused_total_ms: Math.trunc(state.pausedTotalMs),
        updated_at: Math.trunc(at),
      })
      return true
    } catch (error) {
      this.log.warn('写投递状态失败（下次再试）：%s', messageOf(error))
      return false
    }
  }
}

/** 缺口 → 行。 */
function toRow(gap: DriveGap): RowLike {
  return {
    id: gap.id,
    text: gap.text,
    source: gap.source,
    query: gap.query,
    status: gap.status,
    base: gap.base,
    rate_per_hour: gap.ratePerHour,
    relief: gap.relief,
    bump: gap.bump,
    paused_ms: Math.trunc(gap.pausedMs),
    created_at: Math.trunc(gap.createdAt),
    closed_at: Math.trunc(gap.closedAt),
    closed_siblings: Math.trunc(gap.closedSiblings),
    picks: Math.trunc(gap.picks),
    last_picked_at: Math.trunc(gap.lastPickedAt),
  }
}

/**
 * 行 → 缺口。
 *
 * 脏数据（状态不是 open/closed、来源不认识）**丢掉这一行**而不是猜：
 * 猜一个来源会让「这条为什么在这儿」永远说不清。丢一行只是少一条执念。
 * @param row 原始行。
 */
function toGap(row: RowLike): DriveGap | undefined {
  const id = String(row['id'] ?? '')
  if (id.length === 0) return undefined

  const status = String(row['status'] ?? '')
  if (status !== 'open' && status !== 'closed') return undefined

  const source = String(row['source'] ?? '')
  if (!GAP_SOURCES.includes(source as GapSource)) return undefined

  return Object.freeze({
    id,
    text: String(row['text'] ?? ''),
    source: source as GapSource,
    query: String(row['query'] ?? ''),
    status: status as GapStatus,
    base: num(row['base']),
    ratePerHour: num(row['rate_per_hour']),
    relief: num(row['relief']),
    bump: num(row['bump']),
    pausedMs: Math.trunc(num(row['paused_ms'])),
    createdAt: Math.trunc(num(row['created_at'])),
    closedAt: Math.trunc(num(row['closed_at'])),
    closedSiblings: Math.trunc(num(row['closed_siblings'])),
    picks: Math.trunc(num(row['picks'])),
    lastPickedAt: Math.trunc(num(row['last_picked_at'])),
  })
}

/** 数字列 → number（非有限值归 0）。 */
function num(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}
