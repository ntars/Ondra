/**
 * 边表的读写（**只走表级 CRUD，不用 `raw`**）。
 *
 * 为什么不用原始 SQL：本插件必须两个后端都能跑（SQLite 与内存兜底），
 * 一旦用上自定义 SQL 或 FTS，内存后端立刻失效——而「SQLite 打不开」正是
 * 内存后端存在的理由。代价是没有聚合查询，故 `stats()` 用 `count()` 逐个算。
 *
 * 行 ↔ 对象的转换集中在一个地方（`toEdge` / `toRow`）：
 * 分散转换会让「`approved` 存成 `'1'` 还是 `1`」这种问题在某一处悄悄出错。
 * 存储端口给回来的值类型不保证（SQLite 给数字、内存后端可能给布尔），
 * 故一律走 `numberOf` / `boolOf` 收口。
 */

import { TABLE_LINK } from './types.js'
import type { GraphEdge, LogLike, RowLike, StoreLike } from './types.js'
import { TABLE_LINK_SPEC } from './schema.js'

/** 全表遍历的安全阀（防止端口「返回不满一页却永远不空」的死循环）。 */
const MAX_PAGES = 400

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

/** 收口布尔（0/1、'0'/'1'、true/false 都认）。 */
function boolOf(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true'
  return false
}

/** 收口字符串。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 行 → 边。
 * @param row 数据行。
 */
export function toEdge(row: RowLike): GraphEdge {
  return {
    id: textOf(row['id']),
    from: textOf(row['from_id']),
    to: textOf(row['to_id']),
    relation: textOf(row['relation']),
    weight: numberOf(row['weight'], 0),
    hits: numberOf(row['hits'], 0),
    lastFiredAt: numberOf(row['last_fired_at'], 0),
    decayedAt: numberOf(row['decayed_at'], 0),
    createdAt: numberOf(row['created_at'], 0),
    approved: boolOf(row['approved']),
    surreal: boolOf(row['surreal']),
  }
}

/**
 * 边 → 行（布尔一律存 0/1：SQLite 没有布尔类型，存 `true` 会变成字符串 `'true'`，
 * 而 `where approved = 1` 就再也查不到它）。
 * @param edge 边。
 */
export function toRow(edge: GraphEdge): RowLike {
  return {
    id: edge.id,
    from_id: edge.from,
    to_id: edge.to,
    relation: edge.relation,
    weight: edge.weight,
    hits: edge.hits,
    last_fired_at: edge.lastFiredAt,
    decayed_at: edge.decayedAt,
    created_at: edge.createdAt,
    approved: edge.approved ? 1 : 0,
    surreal: edge.surreal ? 1 : 0,
  }
}

/** 边表仓库。 */
export class EdgeStore {
  private readonly store: StoreLike
  private readonly log: LogLike
  private ensured = false

  /**
   * @param store 存储端口。
   * @param log 日志。
   */
  constructor(store: StoreLike, log: LogLike) {
    this.store = store
    this.log = log
  }

  /**
   * 建表（幂等）。失败只记日志，不抛——建表失败会让服务转 `available=false`，
   * 但那由服务层判断，不该在这里炸掉宿主。
   * @returns 是否可用。
   */
  ensure(): boolean {
    if (this.ensured) return true
    try {
      const result = this.store.ensureTable(TABLE_LINK_SPEC)
      if (result.issues.length > 0) {
        for (const issue of result.issues) {
          this.log.warn('边表结构告警（%s / %s）：%s', issue.code, issue.table, issue.detail)
        }
      }
      this.ensured = true
      return true
    } catch (error) {
      this.log.error('建边表失败：%s', messageOf(error))
      return false
    }
  }

  /** 按 id 取。 */
  getById(id: string): GraphEdge | undefined {
    try {
      const row = this.store.get(TABLE_LINK, { id })
      return row === undefined ? undefined : toEdge(row)
    } catch (error) {
      this.log.warn('读边失败（%s）：%s', id, messageOf(error))
      return undefined
    }
  }

  /** 插入（主键冲突会抛，调用方应先 `getById`）。 */
  insert(edge: GraphEdge): void {
    this.store.insert(TABLE_LINK, toRow(edge))
  }

  /** 覆盖（幂等建边走这条）。 */
  upsert(edge: GraphEdge): void {
    this.store.upsert(TABLE_LINK, toRow(edge))
  }

  /** 局部更新。 */
  patch(id: string, fields: Partial<GraphEdge>): number {
    const row: RowLike = {}
    if (fields.weight !== undefined) row['weight'] = fields.weight
    if (fields.hits !== undefined) row['hits'] = fields.hits
    if (fields.lastFiredAt !== undefined) row['last_fired_at'] = fields.lastFiredAt
    if (fields.decayedAt !== undefined) row['decayed_at'] = fields.decayedAt
    if (fields.approved !== undefined) row['approved'] = fields.approved ? 1 : 0
    if (Object.keys(row).length === 0) return 0
    return this.store.update(TABLE_LINK, { id }, row)
  }

  /** 按 id 删。 */
  deleteById(id: string): number {
    return this.store.delete(TABLE_LINK, { id })
  }

  /**
   * 取一侧的全部边。
   * @param id 记忆 id。
   * @param side `from` 或 `to`。
   * @param limit 上限（默认枢纽度上限）。
   */
  edgesOfSide(id: string, side: 'from' | 'to', limit: number): GraphEdge[] {
    try {
      const rows = this.store.select(TABLE_LINK, {
        where: [{ column: side === 'from' ? 'from_id' : 'to_id', op: 'eq', value: id }],
        orderBy: [{ column: 'weight', direction: 'desc' }],
        limit,
      })
      return rows.map(toEdge)
    } catch (error) {
      this.log.warn('按侧读边失败（%s）：%s', id, messageOf(error))
      return []
    }
  }

  /**
   * 取触及某个 id 的全部边（两个方向）。
   * @param id 记忆 id。
   * @param limit 每侧上限。
   */
  edgesTouching(id: string, limit: number): GraphEdge[] {
    return [...this.edgesOfSide(id, 'from', limit), ...this.edgesOfSide(id, 'to', limit)]
  }

  /**
   * 批量取「一端落在给定集合里」的边。
   *
   * 用于 `relatedness()`：一次拿到种子周边的全部边，而不是「每个候选查一次」。
   * @param ids 端点集合。
   * @param side 端点在哪一侧。
   */
  edgesWithSideIn(ids: readonly string[], side: 'from' | 'to'): GraphEdge[] {
    if (ids.length === 0) return []
    try {
      const rows = this.store.select(TABLE_LINK, {
        where: [{ column: side === 'from' ? 'from_id' : 'to_id', op: 'in', value: [...ids] }],
      })
      return rows.map(toEdge)
    } catch (error) {
      this.log.warn('批量读边失败：%s', messageOf(error))
      return []
    }
  }

  /**
   * 全表分页遍历（衰减 / 剪枝 / 统计用）。
   * @param pageSize 分页大小。
   * @param visit 每条边回调；返回 `false` 提前结束。
   */
  forEachEdge(pageSize: number, visit: (edge: GraphEdge) => boolean | void): number {
    let offset = 0
    let seen = 0
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let rows: RowLike[]
      try {
        rows = this.store.select(TABLE_LINK, {
          orderBy: [{ column: 'id', direction: 'asc' }],
          limit: pageSize,
          offset,
        })
      } catch (error) {
        this.log.warn('遍历边表失败：%s', messageOf(error))
        return seen
      }
      if (!Array.isArray(rows) || rows.length === 0) return seen
      for (const row of rows) {
        seen += 1
        if (visit(toEdge(row)) === false) return seen
      }
      offset += rows.length
      if (rows.length < pageSize) return seen
    }
    this.log.warn('遍历边表触发安全阀（%d 页），可能未遍历完', MAX_PAGES)
    return seen
  }

  /** 总条数。 */
  countAll(): number {
    try {
      return this.store.count(TABLE_LINK)
    } catch (error) {
      this.log.warn('统计边数失败：%s', messageOf(error))
      return 0
    }
  }

  /** 按列计数。 */
  countWhere(column: string, value: unknown): number {
    try {
      return this.store.count(TABLE_LINK, [{ column, op: 'eq', value }])
    } catch (error) {
      this.log.warn('按 %s 统计边数失败：%s', column, messageOf(error))
      return 0
    }
  }

  /**
   * 删掉触及某 id 的全部边。
   * @param id 记忆 id。
   */
  deleteTouching(id: string): number {
    let removed = 0
    for (const edge of this.edgesTouching(id, 1000)) {
      try {
        removed += this.deleteById(edge.id)
      } catch (error) {
        this.log.warn('删边失败（%s）：%s', edge.id, messageOf(error))
      }
    }
    return removed
  }
}
