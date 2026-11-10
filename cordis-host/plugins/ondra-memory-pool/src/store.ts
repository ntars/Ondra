/**
 * 两张表的读写（**只走表级 CRUD，不用 `raw`**）。
 *
 * 理由与其余记忆插件一致：必须两个后端都能跑（SQLite 与内存兜底），
 * 一旦用上自定义 SQL，内存后端立刻失效——而它存在的理由正是「SQLite 打不开」。
 *
 * 三处刻意的实现选择：
 *
 * 1. **`digestOf()` 与 O-010 的 `digestOf()` 逐字同口径**（去空白 + sha256 前 32 位）。
 *    两边各算一份是「结构对位」的代价：不能 import 对方源码（§18.5），
 *    所以口径一致性只能靠**同实现 + 注释互指**维持。改一处必须同改另一处，
 *    否则「同一句话」在这两个插件里会被认成两句。
 *
 * 2. **写操作全部包 try/catch 并降级成布尔/空值**，不向上抛。
 *    存储层出错时抛异常会把 `apply()` 直接炸掉（=插件加载失败），
 *    而真因可能只是某一行写不进去。服务层用 `undefined`/`false` 表达失败，
 *    再由 `stats()` 与 `issues` 说出来。
 *
 * 3. **`countByPool()` 一次全量取回再在内存里分组**，不是每个池发一条 `count()`。
 *    9 个池就是 9 次查询；端口没有聚合面，而 `select` 已经能一次取回。
 *    条数上限由 `pageSize` 兜住——超出的部分不静默丢，见 `PoolStoreStats.complete`。
 */

import { createHash } from 'node:crypto'
import { TABLE_HINT, TABLE_POOL } from './types.js'
import type {
  LogLike,
  PoolAssignment,
  PoolAssignSource,
  PoolHint,
  PoolId,
  RowLike,
  StoreLike,
} from './types.js'
import { TABLE_HINT_SPEC, TABLE_POOL_SPEC } from './schema.js'

/**
 * 归一化正文摘要。**与 O-010 `repository.ts` 的 `digestOf()` 逐字一致**。
 * @param text 正文。
 */
export function digestOf(text: string): string {
  const normalized = text.replace(/\s+/g, '')
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32)
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 收口数字。 */
function numberOf(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return fallback
}

/** 收口字符串。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 收口布尔（整型 0/1）。 */
function boolOf(value: unknown): boolean {
  return numberOf(value, 0) !== 0
}

/**
 * 行 → 池归属。
 * @param row 数据行。
 */
export function toAssignment(row: RowLike): PoolAssignment {
  const source = textOf(row['source'])
  const known: readonly PoolAssignSource[] = ['explicit', 'label', 'fallback', 'manual']
  return {
    factId: textOf(row['fact_id']),
    pool: textOf(row['pool']) as PoolId,
    assignedAt: numberOf(row['assigned_at'], 0),
    // 认不出的来源一律按 `label` 处理：它不是任何判定分支的关键输入，
    // 只是审计字段，硬报错反而会让一条本来正常的登记读不出来。
    source: (known as readonly string[]).includes(source) ? (source as PoolAssignSource) : 'label',
    unclassified: boolOf(row['unclassified']),
    matchedLabel: row['matched_label'] === null || row['matched_label'] === undefined ? null : textOf(row['matched_label']),
    note: textOf(row['note']),
  }
}

/**
 * 池归属 → 行。
 * @param record 池归属。
 */
export function assignmentToRow(record: PoolAssignment): RowLike {
  return {
    fact_id: record.factId,
    pool: record.pool,
    assigned_at: record.assignedAt,
    source: record.source,
    unclassified: record.unclassified ? 1 : 0,
    matched_label: record.matchedLabel,
    note: record.note,
  }
}

/**
 * 行 → 未归类线索。
 * @param row 数据行。
 */
export function toHint(row: RowLike): PoolHint {
  return {
    digest: textOf(row['digest']),
    preview: textOf(row['preview']),
    attempts: numberOf(row['attempts'], 0),
    escalated: boolOf(row['escalated']),
    firstAt: numberOf(row['first_at'], 0),
    lastAt: numberOf(row['last_at'], 0),
  }
}

/**
 * 未归类线索 → 行。
 * @param record 线索。
 */
export function hintToRow(record: PoolHint): RowLike {
  return {
    digest: record.digest,
    preview: record.preview,
    attempts: record.attempts,
    escalated: record.escalated ? 1 : 0,
    first_at: record.firstAt,
    last_at: record.lastAt,
  }
}

/** 池归属仓库。 */
export class PoolStore {
  private readonly store: StoreLike
  private readonly log: LogLike
  private ensured = false
  private ensureFailed = false

  /**
   * @param store 存储端口。
   * @param log 日志。
   */
  constructor(store: StoreLike, log: LogLike) {
    this.store = store
    this.log = log
  }

  /**
   * 建两张表（幂等）。失败只记日志不抛——建表失败让服务转 `available=false`，
   * 但那由服务层判断，不该在这里炸掉宿主。
   * @returns 是否可用。
   */
  ensure(): boolean {
    if (this.ensured) return true
    if (this.ensureFailed) return false
    try {
      for (const spec of [TABLE_POOL_SPEC, TABLE_HINT_SPEC]) {
        const result = this.store.ensureTable(spec)
        if (result.issues.length > 0) {
          for (const issue of result.issues) {
            this.log.warn('池表结构告警（%s / %s）：%s', issue.code, issue.table, issue.detail)
          }
        }
      }
      this.ensured = true
      return true
    } catch (error) {
      // 记住失败，避免每次调用都重试一遍并刷日志。
      this.ensureFailed = true
      this.log.error('建池表失败（池分类不可用）：%s', messageOf(error))
      return false
    }
  }

  /** 后端标识。 */
  get provider(): string {
    return this.store.provider
  }

  /**
   * 按记忆 id 取池归属。
   * @param factId 记忆 id。
   */
  get(factId: string): PoolAssignment | undefined {
    try {
      const row = this.store.get(TABLE_POOL, { fact_id: factId })
      return row === undefined ? undefined : toAssignment(row)
    } catch (error) {
      this.log.warn('读池归属失败（%s）：%s', factId, messageOf(error))
      return undefined
    }
  }

  /**
   * 覆盖写池归属（同一条记忆重复分配 = 刷新池与时刻，不产生第二行）。
   * @param record 池归属。
   * @returns 是否写成功。
   */
  put(record: PoolAssignment): boolean {
    try {
      this.store.upsert(TABLE_POOL, assignmentToRow(record))
      return true
    } catch (error) {
      this.log.error('写池归属失败（%s → %s）：%s', record.factId, record.pool, messageOf(error))
      return false
    }
  }

  /**
   * 删一条池归属（**不删记忆**）。
   * @param factId 记忆 id。
   * @returns 是否删掉了。
   */
  remove(factId: string): boolean {
    try {
      return this.store.delete(TABLE_POOL, { fact_id: factId }) > 0
    } catch (error) {
      this.log.warn('撤销池归属失败（%s）：%s', factId, messageOf(error))
      return false
    }
  }

  /** 数一个池里的条数（`core` 上限判定用）。 */
  countInPool(pool: PoolId): number {
    try {
      return this.store.count(TABLE_POOL, [{ column: 'pool', op: 'eq', value: pool }])
    } catch (error) {
      this.log.warn('数池条数失败（%s）：%s', pool, messageOf(error))
      return 0
    }
  }

  /** 一个池里的全部记忆 id（单槽池找「当前占槽者」用）。 */
  idsInPool(pool: PoolId, limit: number): string[] {
    try {
      return this.store
        .select(TABLE_POOL, {
          where: [{ column: 'pool', op: 'eq', value: pool }],
          orderBy: [{ column: 'assigned_at', direction: 'desc' }],
          limit,
        })
        .map(row => textOf(row['fact_id']))
        .filter(id => id !== '')
    } catch (error) {
      this.log.warn('读池成员失败（%s）：%s', pool, messageOf(error))
      return []
    }
  }

  /**
   * 全量取回池归属并按池分组。
   *
   * 返回 `complete=false` 表示撞到 `limit`——**不静默当作全量**，
   * 成长面板与自检要据此显示「统计可能不完整」。
   * @param limit 取回上限。
   */
  groupByPool(limit: number): { readonly byPool: Partial<Record<PoolId, number>>; readonly complete: boolean } {
    try {
      const rows = this.store.select(TABLE_POOL, { limit })
      const byPool: Partial<Record<PoolId, number>> = {}
      for (const row of rows) {
        const pool = textOf(row['pool']) as PoolId
        byPool[pool] = (byPool[pool] ?? 0) + 1
      }
      return { byPool, complete: rows.length < limit }
    } catch (error) {
      this.log.warn('分组池统计失败：%s', messageOf(error))
      return { byPool: {}, complete: false }
    }
  }

  /** 全部池归属（归档候选扫描用；按 `assigned_at` 正序让结果稳定）。 */
  all(limit: number): PoolAssignment[] {
    try {
      return this.store
        .select(TABLE_POOL, { orderBy: [{ column: 'assigned_at', direction: 'asc' }], limit })
        .map(toAssignment)
    } catch (error) {
      this.log.warn('读池归属列表失败：%s', messageOf(error))
      return []
    }
  }

  /**
   * 取一条未归类线索。
   * @param digest 摘要。
   */
  getHint(digest: string): PoolHint | undefined {
    try {
      const row = this.store.get(TABLE_HINT, { digest })
      return row === undefined ? undefined : toHint(row)
    } catch (error) {
      this.log.warn('读未归类线索失败（%s）：%s', digest, messageOf(error))
      return undefined
    }
  }

  /**
   * 写一条未归类线索。
   * @param record 线索。
   * @returns 是否写成功。
   */
  putHint(record: PoolHint): boolean {
    try {
      this.store.upsert(TABLE_HINT, hintToRow(record))
      return true
    } catch (error) {
      this.log.error('写未归类线索失败（%s）：%s', record.digest, messageOf(error))
      return false
    }
  }

  /**
   * 删一条未归类线索（人工定池之后调）。
   * @param digest 摘要。
   * @returns 是否删掉了。
   */
  removeHint(digest: string): boolean {
    try {
      return this.store.delete(TABLE_HINT, { digest }) > 0
    } catch (error) {
      this.log.warn('清未归类线索失败（%s）：%s', digest, messageOf(error))
      return false
    }
  }

  /** 线索表条数（上限判定用）。 */
  countHints(): number {
    try {
      return this.store.count(TABLE_HINT)
    } catch (error) {
      this.log.warn('数未归类线索失败：%s', messageOf(error))
      return 0
    }
  }

  /** 未归类的池归属条数（成长面板要能把「不知道该归哪儿」这件事显出来）。 */
  countUnclassified(): number {
    try {
      return this.store.count(TABLE_POOL, [{ column: 'unclassified', op: 'eq', value: 1 }])
    } catch (error) {
      this.log.warn('数未归类条数失败：%s', messageOf(error))
      return 0
    }
  }

  /** 已升级「需人工定池」的线索条数。 */
  countEscalated(): number {
    try {
      return this.store.count(TABLE_HINT, [{ column: 'escalated', op: 'eq', value: 1 }])
    } catch (error) {
      this.log.warn('数升级线索失败：%s', messageOf(error))
      return 0
    }
  }

  /** 已升级「需人工定池」的线索（按最近出现倒序）。 */
  escalated(limit: number): PoolHint[] {
    try {
      return this.store
        .select(TABLE_HINT, {
          where: [{ column: 'escalated', op: 'eq', value: 1 }],
          orderBy: [{ column: 'last_at', direction: 'desc' }],
          limit,
        })
        .map(toHint)
    } catch (error) {
      this.log.warn('读升级线索失败：%s', messageOf(error))
      return []
    }
  }
}
