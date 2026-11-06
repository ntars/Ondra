/**
 * `StorePort` 的内存实现（SQLite 打不开时的兜底）。
 *
 * 定位说清楚，避免被误用：**它不是「另一个数据库」，是一条让主对话还能进行的应急通道**。
 * 所以它只承诺「表级 CRUD 语义与 SQLite 后端一致」，**不承诺**：
 * 持久化、FTS5、事务回滚、并发控制、外键约束。
 * 这四件不做的事全部写进 `caps`，消费方必须在**装载期**读能力位分支
 * （`caps.sql` / `caps.transaction` / `caps.fts` / `caps.persist`），
 * 而不是运行到一半收到异常。
 *
 * 三处与 SQLite 后端**刻意对齐**的行为（对齐比「更宽松」重要，否则换后端就换语义）：
 *
 * 1. `boolean` 归一化成 `0 | 1`；对象/数组直接拒收（`unsupported-value`）。
 * 2. 嵌套事务抛 `nested-transaction`——不是「加入外层」。
 * 3. 补「非空但无默认值」的列时，旧行视为缺值，记 `not-null-without-default` issue。
 */

import { IDENT_RE, StoreError } from './types.js'
import type {
  ColumnSpec,
  EnsureResult,
  Filter,
  Row,
  SelectQuery,
  SortRule,
  SqlValue,
  StoreCaps,
  StoreIssue,
  StorePort,
  StoreState,
  StoreStats,
  TableSpec,
} from './types.js'

/** 单表行数上限（可配）。超限**拒绝写入**，不静默淘汰——静默淘汰等于悄悄删数据。 */
const DEFAULT_MAX_ROWS = 20000

/** 一张内存表。 */
interface MemTable {
  /** 列名 → 列声明（保持声明顺序即插入顺序）。 */
  columns: Map<string, ColumnSpec>
  /** 主键列（可能为空）。 */
  primaryKey: string[]
  /** 主键编码 → 行。 */
  rows: Map<string, Map<string, SqlValue>>
  /** 已登记索引名（不建索引，只回报）。 */
  indexNames: string[]
}

/** 主键编码分隔符。用 `\u0000` 而不是 `|`：它不可能出现在正常业务主键里。 */
const KEY_SEP = '\u0000'

/** 校验标识符。 */
function assertIdent(kind: '表' | '列' | '索引', name: string): void {
  if (!IDENT_RE.test(name)) {
    throw new StoreError(
      'invalid-identifier',
      kind + '名「' + name + '」不合法：必须匹配 ^[a-z][a-z0-9_]*$',
    )
  }
}

/** 值归一化：与 O-006 的 `normalizeValue` 保持同一规则。 */
function normalizeValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new StoreError('unsupported-value', '数字 ' + String(value) + ' 不能入库：NaN / Infinity 不是有效值')
    }
    return value
  }
  if (typeof value === 'string' || typeof value === 'bigint') return value
  if (value instanceof Uint8Array) return value
  throw new StoreError(
    'unsupported-value',
    '值类型 ' + Object.prototype.toString.call(value) + ' 不能入库：对象与数组请调用方自己 JSON.stringify',
  )
}

/** 解析默认值字面量（只支持最常用的几种，其余按 null）。 */
function defaultOf(column: ColumnSpec): SqlValue {
  const raw = column.default
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed)
  if (/^'.*'$/.test(trimmed)) return trimmed.slice(1, -1).replace(/''/g, "'")
  return null
}

/** 排序比较：数字按数值、字符串按编码序、null/缺值排最后。 */
function compareValues(a: SqlValue | undefined, b: SqlValue | undefined): number {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b ? 0 : a < b ? -1 : 1
  const sa = typeof a === 'string' ? a : String(a)
  const sb = typeof b === 'string' ? b : String(b)
  return sa === sb ? 0 : sa < sb ? -1 : 1
}

/** 匹配单个过滤条件。 */
function matchFilter(row: Map<string, SqlValue>, filter: Filter): boolean {
  const value = row.get(filter.column)
  switch (filter.op) {
    case 'is-null':
      return value === null || value === undefined
    case 'not-null':
      return value !== null && value !== undefined
    case 'in': {
      if (!Array.isArray(filter.value)) {
        throw new StoreError('bad-argument', 'in 算子的值必须是数组')
      }
      if (filter.value.length === 0) return false
      const needle = filter.value.map(normalizeValue)
      return needle.some((item) => compareValues(value, item) === 0)
    }
    case 'like': {
      // 只实现 `%`（任意串）与 `_`（单字符），与 SQL LIKE 的最小公共子集一致；
      // 不用正则，避免把 SQL 的通配符语义翻译错。
      const pattern = String(filter.value ?? '')
      if (value === null || value === undefined) return false
      const source = pattern
        .split('')
        .map((char) => (char === '%' ? '.*' : char === '_' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('')
      return new RegExp('^' + source + '$', 's').test(String(value))
    }
    default: {
      const comparison = compareValues(value, normalizeValue(filter.value))
      if (filter.op === 'eq') return comparison === 0
      if (filter.op === 'ne') return comparison !== 0
      if (filter.op === 'gt') return comparison > 0
      if (filter.op === 'gte') return comparison >= 0
      if (filter.op === 'lt') return comparison < 0
      if (filter.op === 'lte') return comparison <= 0
      throw new StoreError('bad-argument', '未知的过滤算子「' + String(filter.op) + '」')
    }
  }
}

/** 内存端口。 */
export class MemoryStore implements StorePort {
  readonly provider = 'memory' as const
  readonly caps: StoreCaps = Object.freeze({ sql: false, fts: false, persist: false, transaction: false })
  readonly filePath: string | null = null

  private readonly openedAtMs = Date.now()
  private readonly tables = new Map<string, MemTable>()
  private readonly maxRows: number
  private stateValue: StoreState = 'open'
  private statementCount = 0
  private transactionCount = 0
  private failureCount = 0
  private depth = 0
  /** 无主键表的行标识自增序号。用它而不是 `rows.size + 时间戳`：后者会在同一毫秒撞码并静默覆盖。 */
  private sequence = 0

  /**
   * @param maxRowsPerTable 单表行数上限。
   */
  constructor(maxRowsPerTable: number) {
    this.maxRows = maxRowsPerTable > 0 ? Math.trunc(maxRowsPerTable) : DEFAULT_MAX_ROWS
  }

  get state(): StoreState {
    return this.stateValue
  }

  get raw(): undefined {
    return undefined
  }

  /** 可用性闸门。 */
  private assertUsable(): void {
    if (this.stateValue === 'closed') {
      throw new StoreError('closed', '内存存储已关闭，不能再读写')
    }
  }

  /** 取表，不存在则抛。 */
  private tableOf(table: string): MemTable {
    assertIdent('表', table)
    const found = this.tables.get(table)
    if (found === undefined) {
      throw new StoreError('unknown-table', '表「' + table + '」不存在', '请先用 ensureTable() 声明该表')
    }
    return found
  }

  /** 把行对象归一化并校验列名。 */
  private normalizeRow(table: string, meta: MemTable, row: Record<string, unknown>): Map<string, SqlValue> {
    const out = new Map<string, SqlValue>()
    for (const [key, value] of Object.entries(row)) {
      if (!meta.columns.has(key)) {
        throw new StoreError('unknown-column', '表「' + table + '」没有列「' + key + '」')
      }
      out.set(key, normalizeValue(value))
    }
    return out
  }

  /**
   * 把内部行摊成对外的完整行：**所有声明过的列都出现**，缺的补 `null`。
   *
   * 与 SQL 的 `SELECT *` 对齐——否则「同一段代码换后端」会因为少几个键而行为分叉
   * （典型症状：`Object.keys(row).length` 不同、`for...in` 少遍历几列）。
   * @param meta 表元信息。
   * @param values 内部行。
   */
  private materialize(meta: MemTable, values: Map<string, SqlValue>): Row {
    const out: Record<string, unknown> = {}
    for (const name of meta.columns.keys()) {
      const value = values.get(name)
      out[name] = value === undefined ? null : value
    }
    return out
  }

  /** 主键编码。没有主键时返回 null。 */
  private keyOf(meta: MemTable, values: Map<string, SqlValue>): string | null {    if (meta.primaryKey.length === 0) return null
    const parts: string[] = []
    for (const column of meta.primaryKey) {
      const value = values.get(column)
      if (value === undefined) {
        throw new StoreError('bad-argument', '缺少主键列「' + column + '」')
      }
      parts.push(String(value))
    }
    return parts.join(KEY_SEP)
  }

  /** 建表 / 补列。 */
  ensureTable(spec: TableSpec): EnsureResult {
    this.assertUsable()
    assertIdent('表', spec.name)
    const issues: StoreIssue[] = []
    const addedColumns: string[] = []
    const createdIndexes: string[] = []
    const existed = this.tables.has(spec.name)

    if (!existed) {
      const columns = new Map<string, ColumnSpec>()
      const primaryKey: string[] = []
      for (const column of spec.columns) {
        assertIdent('列', column.name)
        columns.set(column.name, column)
        if (column.primaryKey === true) primaryKey.push(column.name)
      }
      this.tables.set(spec.name, { columns, primaryKey, rows: new Map(), indexNames: [] })
    } else {
      const meta = this.tableOf(spec.name)
      for (const column of spec.columns) {
        if (meta.columns.has(column.name)) continue
        assertIdent('列', column.name)
        if (column.primaryKey === true) {
          issues.push({
            code: 'primary-key-skipped',
            table: spec.name,
            column: column.name,
            detail: '内存后端不支持给已有表补主键，「' + column.name + '」被跳过（与 SQLite 后端同口径）',
          })
          continue
        }
        if (column.notNull === true && column.default === undefined) {
          issues.push({
            code: 'not-null-without-default',
            table: spec.name,
            column: column.name,
            detail:
              '「' + column.name + '」声明为非空但无默认值，已有行的该列为空；业务写入必须自己兜底',
          })
        }
        meta.columns.set(column.name, column)
        addedColumns.push(column.name)
      }
    }

    const meta = this.tableOf(spec.name)
    for (const index of spec.indexes ?? []) {
      assertIdent('索引', index.name)
      if (!meta.indexNames.includes(index.name)) {
        meta.indexNames.push(index.name)
        createdIndexes.push(index.name)
      }
    }

    return { table: spec.name, created: !existed, addedColumns, createdIndexes, issues }
  }

  /** 表是否存在。 */
  tableExists(table: string): boolean {
    this.assertUsable()
    assertIdent('表', table)
    return this.tables.has(table)
  }

  /** 插入。主键重复即抛 `constraint`（与 SQLite 的主键冲突同口径）。 */
  insert(table: string, row: Row): void {
    this.assertUsable()
    const meta = this.tableOf(table)
    const values = this.normalizeRow(table, meta, row)
    if (values.size === 0) {
      throw new StoreError('bad-argument', '插入「' + table + '」时没有给任何列')
    }
    // 非空列必须有着落：显式值或默认值。
    for (const [name, column] of meta.columns) {
      if (column.notNull !== true) continue
      if (values.has(name)) continue
      if (column.default !== undefined) {
        values.set(name, defaultOf(column))
        continue
      }
      throw new StoreError('constraint', '表「' + table + '」的列「' + name + '」非空，插入时必须给值')
    }
    if (meta.rows.size >= this.maxRows) {
      this.failureCount += 1
      throw new StoreError(
        'constraint',
        '内存表「' + table + '」已达上限 ' + this.maxRows + ' 行',
        '内存后端是应急通道，不做淘汰式写入；请修好 SQLite 后端或调大 maxRowsPerTable',
      )
    }
    const key = this.keyOf(meta, values)
    const storageKey = key ?? '\u0001' + String(this.sequence++)
    if (key !== null && meta.rows.has(key)) {
      this.failureCount += 1
      throw new StoreError('constraint', '表「' + table + '」主键冲突：' + key)
    }
    meta.rows.set(storageKey, values)
    this.statementCount += 1
  }

  /** upsert。 */
  upsert(table: string, row: Row): void {
    this.assertUsable()
    const meta = this.tableOf(table)
    if (meta.primaryKey.length === 0) {
      throw new StoreError('unsupported-op', '表「' + table + '」没有主键，无法 upsert')
    }
    const values = this.normalizeRow(table, meta, row)
    const key = this.keyOf(meta, values)
    if (key === null) {
      throw new StoreError('bad-argument', 'upsert「' + table + '」缺少主键')
    }
    const existing = meta.rows.get(key)
    if (existing === undefined) {
      this.insert(table, row)
      return
    }
    for (const [name, value] of values) existing.set(name, value)
    this.statementCount += 1
  }

  /** 按主键更新。 */
  update(table: string, key: Row, patch: Row): number {
    this.assertUsable()
    const meta = this.tableOf(table)
    if (meta.primaryKey.length === 0) {
      throw new StoreError('unsupported-op', '表「' + table + '」没有主键，无法按主键更新')
    }
    const keyValues = this.normalizeRow(table, meta, key)
    const patchValues = this.normalizeRow(table, meta, patch)
    if (patchValues.size === 0) {
      throw new StoreError('bad-argument', '更新「' + table + '」时没有给任何要改的列')
    }
    const storageKey = this.keyOf(meta, keyValues)
    if (storageKey === null) return 0
    const existing = meta.rows.get(storageKey)
    if (existing === undefined) return 0
    for (const [name, value] of patchValues) {
      const column = meta.columns.get(name)
      if (column !== undefined && column.notNull === true && value === null) {
        throw new StoreError('constraint', '表「' + table + '」的列「' + name + '」非空，不能改成 null')
      }
      existing.set(name, value)
    }
    this.statementCount += 1
    return 1
  }

  /** 按主键删除。 */
  delete(table: string, key: Row): number {
    this.assertUsable()
    const meta = this.tableOf(table)
    if (meta.primaryKey.length === 0) {
      throw new StoreError('unsupported-op', '表「' + table + '」没有主键，无法按主键删除')
    }
    const keyValues = this.normalizeRow(table, meta, key)
    const storageKey = this.keyOf(meta, keyValues)
    if (storageKey === null) return 0
    const removed = meta.rows.delete(storageKey)
    if (removed) this.statementCount += 1
    return removed ? 1 : 0
  }

  /** 按主键取行。返回的是**副本**，改它不会影响存储。 */
  get(table: string, key: Row): Row | undefined {
    this.assertUsable()
    const meta = this.tableOf(table)
    if (meta.primaryKey.length === 0) {
      throw new StoreError('unsupported-op', '表「' + table + '」没有主键，无法按主键取行')
    }
    const keyValues = this.normalizeRow(table, meta, key)
    const storageKey = this.keyOf(meta, keyValues)
    if (storageKey === null) return undefined
    const found = meta.rows.get(storageKey)
    if (found === undefined) return undefined
    this.statementCount += 1
    return this.materialize(meta, found)
  }

  /** 条件查询。 */
  select(table: string, query?: SelectQuery): Row[] {
    this.assertUsable()
    const meta = this.tableOf(table)
    const where = query?.where ?? []
    for (const filter of where) {
      if (!meta.columns.has(filter.column)) {
        throw new StoreError('unknown-column', '过滤条件用了未声明的列「' + filter.column + '」')
      }
    }
    let matched = [...meta.rows.values()].filter((row) => where.every((filter) => matchFilter(row, filter)))
    const orderBy = query?.orderBy ?? []
    for (const rule of orderBy) {
      if (!meta.columns.has(rule.column)) {
        throw new StoreError('unknown-column', '排序用了未声明的列「' + rule.column + '」')
      }
    }
    if (orderBy.length > 0) {
      matched = matched.slice().sort((a, b) => {
        for (const rule of orderBy as readonly SortRule[]) {
          const comparison = compareValues(a.get(rule.column), b.get(rule.column))
          if (comparison !== 0) return rule.direction === 'desc' ? -comparison : comparison
        }
        return 0
      })
    }
    const offset = typeof query?.offset === 'number' ? Math.max(0, Math.trunc(query.offset)) : 0
    if (offset > 0) matched = matched.slice(offset)
    if (typeof query?.limit === 'number') matched = matched.slice(0, Math.max(0, Math.trunc(query.limit)))
    this.statementCount += 1
    return matched.map((row) => this.materialize(meta, row))
  }

  /** 计数。 */
  count(table: string, where?: readonly Filter[]): number {
    this.assertUsable()
    const meta = this.tableOf(table)
    const filters = where ?? []
    for (const filter of filters) {
      if (!meta.columns.has(filter.column)) {
        throw new StoreError('unknown-column', '过滤条件用了未声明的列「' + filter.column + '」')
      }
    }
    let total = 0
    for (const row of meta.rows.values()) {
      if (filters.every((filter) => matchFilter(row, filter))) total += 1
    }
    this.statementCount += 1
    return total
  }

  /**
   * 事务。**没有回滚语义**：回调抛错时异常原样抛出，但已写入的行留在内存里。
   *
   * 这是刻意不做的能力：真回滚要对全表做快照，而内存后端存在的意义是「最小可用」，
   * 不是「小号 SQLite」。需要原子性的写入必须检查 `caps.transaction`。
   * @param fn 事务体。
   */
  transaction<T>(fn: () => T): T {
    this.assertUsable()
    if (this.depth > 0) {
      throw new StoreError(
        'nested-transaction',
        '嵌套事务被拒绝：外层事务尚未结束，内层又请求事务（与 SQLite 后端同口径）',
      )
    }
    this.depth += 1
    this.transactionCount += 1
    try {
      const result = fn()
      this.depth = 0
      return result
    } catch (error) {
      this.depth = 0
      this.failureCount += 1
      throw error
    }
  }

  /** 统计。 */
  stats(): StoreStats {
    return {
      provider: 'memory',
      state: this.stateValue,
      filePath: null,
      displayPath: null,
      journalMode: null,
      foreignKeys: false,
      synchronous: null,
      busyTimeoutMs: 0,
      tableCount: this.tables.size,
      sizeBytes: null,
      openedAtMs: this.openedAtMs,
      statements: this.statementCount,
      transactions: this.transactionCount,
      failures: this.failureCount,
      degraded: true,
    }
  }

  /** 关闭。幂等。 */
  close(): void {
    if (this.stateValue === 'closed') return
    this.stateValue = 'closed'
    this.tables.clear()
  }
}
