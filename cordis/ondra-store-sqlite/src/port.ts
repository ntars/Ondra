/**
 * `StorePort` 的 SQLite 实现。
 *
 * 与上游 `@ntars/ondra-storage-sqlite` 的关系：**同一层问题、不同抽象**。
 * 上游那套是「storage hub 的 kv 后端」——文档级（`key TEXT / value TEXT` JSON），
 * 服务对象是 hub，不是「任意业务表 + 任意 SQL」。记忆检索要 FTS5、快照要 `VACUUM INTO`、
 * 寿命计算要按列扫描，这些在 kv 后端里根本表达不出来。
 * 所以本插件**复用的是上游已核实的机制与参数**（0600 建文件、`PRAGMA foreign_keys`、
 * journal_mode 四值、`STRICT` 表、语句预编译与 `BEGIN IMMEDIATE`），
 * 接口按业务表重写，不引它的代码（§11.2 纪律：机制可借鉴，代码自写）。
 */

import { fileSizeOf } from './open.js'
import type { SqliteDatabaseLike, SqliteStatementLike } from './open.js'
import {
  addColumnPlan,
  assertIdent,
  buildAddColumn,
  buildCreateIndex,
  buildCreateTable,
  buildLimit,
  buildOrderBy,
  buildWhere,
  normalizeRow,
  quote,
  relaxToNullable,
} from './schema.js'
import { StoreError } from './types.js'
import type {
  EnsureResult,
  Filter,
  RawSqlFacet,
  Row,
  RunResult,
  SelectQuery,
  SqlValue,
  StoreCaps,
  StoreIssue,
  StorePort,
  StoreState,
  StoreStats,
  TableSpec,
} from './types.js'

/** 语句缓存上限。动态拼出来的 `LIMIT ?` 变体不多，但别让它无界增长。 */
const MAX_CACHED_STATEMENTS = 256

/** 一张已登记表的元信息。 */
interface TableMeta {
  /** 列名集合，用于快速校验行对象。 */
  readonly columns: ReadonlySet<string>
  /** 主键列。 */
  readonly primaryKey: readonly string[]
}

/**
 * SQLite 端口。
 *
 * 状态机：`open` →（回滚失败）→ `degraded` → `closed`。`degraded` 之后只允许 `close()`，
 * 任何读写都抛 `degraded`——因为事务状态未知时继续写，可能把半截数据写进库。
 */
export class SqliteStore implements StorePort {
  readonly provider = 'sqlite' as const
  readonly caps: StoreCaps
  readonly filePath: string

  private stateValue: StoreState = 'open'
  private readonly db: SqliteDatabaseLike
  private readonly statements = new Map<string, SqliteStatementLike>()
  private readonly tables = new Map<string, TableMeta>()
  private readonly openedAtMs = Date.now()
  private statementCount = 0
  private transactionCount = 0
  private failureCount = 0
  private depth = 0
  private readonly info: {
    readonly journalMode: string
    readonly foreignKeys: boolean
    readonly synchronous: string
    readonly busyTimeoutMs: number
  }
  private readonly displayPathValue: string | null
  private rawFacet: RawSqlFacet | undefined

  /**
   * @param db 已配置好的连接。
   * @param filePath 库文件绝对路径。
   * @param displayPath 用户可见写法。
   * @param info 读回的真实参数。
   * @param fts5 是否支持 FTS5。
   */
  constructor(
    db: SqliteDatabaseLike,
    filePath: string,
    displayPath: string | null,
    info: { journalMode: string; foreignKeys: boolean; synchronous: string; busyTimeoutMs: number },
    fts5: boolean,
  ) {
    this.db = db
    this.filePath = filePath
    this.displayPathValue = displayPath
    this.info = info
    this.caps = Object.freeze({ sql: true, fts: fts5, persist: true, transaction: true })
    this.rawFacet = Object.freeze({
      exec: (sql: string) => this.exec(sql),
      run: (sql: string, ...params: SqlValue[]) => this.runSql(sql, params),
      all: <T = Row>(sql: string, ...params: SqlValue[]) => this.allSql<T>(sql, params),
      get: <T = Row>(sql: string, ...params: SqlValue[]) => this.getSql<T>(sql, params),
    })
  }

  get state(): StoreState {
    return this.stateValue
  }

  get raw(): RawSqlFacet | undefined {
    return this.rawFacet
  }

  /** 用户可见路径。 */
  get displayPath(): string | null {
    return this.displayPathValue
  }

  /** 取（并缓存）一条预编译语句。 */
  private statement(sql: string): SqliteStatementLike {
    const cached = this.statements.get(sql)
    if (cached !== undefined) return cached
    this.assertUsable()
    let prepared: SqliteStatementLike
    try {
      prepared = this.db.prepare(sql)
    } catch (error) {
      this.failureCount += 1
      throw new StoreError(
        'bad-argument',
        'SQL 预编译失败：' + (error instanceof Error ? error.message : String(error)),
        sql,
      )
    }
    if (this.statements.size >= MAX_CACHED_STATEMENTS) {
      // Map 保持插入顺序，删最早的一条即 FIFO。不按 LRU 是因为 SQL 是有限集合，
      // 真正的风险只有「动态拼 SQL 导致无界增长」，FIFO 已经够。
      const oldest = this.statements.keys().next()
      if (!oldest.done) this.statements.delete(oldest.value)
    }
    this.statements.set(sql, prepared)
    return prepared
  }

  /** 可用性闸门。 */
  private assertUsable(): void {
    if (this.stateValue === 'closed') {
      throw new StoreError('closed', '存储已关闭，不能再读写')
    }
    if (this.stateValue === 'degraded') {
      throw new StoreError(
        'degraded',
        '存储处于降级态（曾发生回滚失败，事务状态未知），必须关闭后重建',
      )
    }
  }

  /** 直接执行多条语句。 */
  private exec(sql: string): void {
    this.assertUsable()
    try {
      this.db.exec(sql)
      this.statementCount += 1
    } catch (error) {
      this.failureCount += 1
      throw new StoreError('bad-argument', 'SQL 执行失败：' + (error instanceof Error ? error.message : String(error)), sql)
    }
  }

  /** 执行写语句（绑定参数）。 */
  private runSql(sql: string, params: readonly SqlValue[]): RunResult {
    this.assertUsable()
    try {
      const result = this.statement(sql).run(...params)
      this.statementCount += 1
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
    } catch (error) {
      this.failureCount += 1
      if (error instanceof StoreError) throw error
      throw new StoreError('constraint', '写语句失败：' + (error instanceof Error ? error.message : String(error)), sql)
    }
  }

  /** 查询多行。 */
  private allSql<T = Row>(sql: string, params: readonly SqlValue[]): T[] {
    this.assertUsable()
    try {
      const rows = this.statement(sql).all(...params)
      this.statementCount += 1
      return rows as T[]
    } catch (error) {
      this.failureCount += 1
      if (error instanceof StoreError) throw error
      throw new StoreError('bad-argument', '查询失败：' + (error instanceof Error ? error.message : String(error)), sql)
    }
  }

  /** 查询单行。 */
  private getSql<T = Row>(sql: string, params: readonly SqlValue[]): T | undefined {
    this.assertUsable()
    try {
      const row = this.statement(sql).get(...params)
      this.statementCount += 1
      return row === undefined ? undefined : (row as T)
    } catch (error) {
      this.failureCount += 1
      if (error instanceof StoreError) throw error
      throw new StoreError('bad-argument', '查询失败：' + (error instanceof Error ? error.message : String(error)), sql)
    }
  }

  /** 取表的元信息，未登记则从 `PRAGMA table_info` 现场读一次。 */
  private metaOf(table: string): TableMeta {
    assertIdent('表', table)
    const cached = this.tables.get(table)
    if (cached !== undefined) return cached
    if (!this.tableExists(table)) {
      throw new StoreError('unknown-table', '表「' + table + '」不存在', '请先用 ensureTable() 声明该表')
    }
    const info = this.allSql<{ name: string; pk: number }>('PRAGMA table_info(' + quote(table) + ')', [])
    const columns = new Set<string>()
    const primaryKey: string[] = []
    for (const row of info) {
      columns.add(String(row.name))
      if (Number(row.pk) > 0) primaryKey.push(String(row.name))
    }
    const meta: TableMeta = { columns, primaryKey }
    this.tables.set(table, meta)
    return meta
  }

  /** 表是否存在。 */
  tableExists(table: string): boolean {
    this.assertUsable()
    assertIdent('表', table)
    const row = this.getSql<{ name?: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [table],
    )
    return row !== undefined
  }

  /**
   * 建表 + 补列 + 建索引（幂等）。
   * @param spec 表声明。
   */
  ensureTable(spec: TableSpec): EnsureResult {
    this.assertUsable()
    assertIdent('表', spec.name)
    const issues: StoreIssue[] = []
    const addedColumns: string[] = []
    const createdIndexes: string[] = []
    const wantStrict = spec.strict !== false

    const existed = this.tableExists(spec.name)
    if (!existed) {
      try {
        this.exec(buildCreateTable(spec, wantStrict))
      } catch (error) {
        if (!wantStrict) throw error
        // 老版本 SQLite 不认 STRICT：退回普通表，但记 issue——这张表从此不做类型强校验。
        this.exec(buildCreateTable(spec, false))
        issues.push({
          code: 'strict-unavailable',
          table: spec.name,
          detail: '建 STRICT 表失败，已退回普通表（该 SQLite 可能早于 3.37）：' + (error instanceof Error ? error.message : String(error)),
        })
      }
    } else {
      const existing = new Set(
        this.allSql<{ name: string }>('PRAGMA table_info(' + quote(spec.name) + ')', []).map((row) => String(row.name)),
      )
      for (const column of spec.columns) {
        if (existing.has(column.name)) continue
        const plan = addColumnPlan(column)
        if (plan.skip) {
          issues.push({
            code: 'primary-key-skipped',
            table: spec.name,
            column: column.name,
            detail:
              'SQLite 不允许 ALTER TABLE ADD COLUMN 添加主键列，「' +
              column.name +
              '」被跳过；要加主键只能重建表（归 O-008 ondra-data-migrate）',
          })
          continue
        }
        if (plan.issue === 'not-null-without-default') {
          issues.push({
            code: 'not-null-without-default',
            table: spec.name,
            column: column.name,
            detail:
              '「' +
              column.name +
              '」声明为非空但无默认值，SQLite 无法补这种列；已按可空补上，业务写入必须自己兜底',
          })
          this.exec(buildAddColumn(spec.name, relaxToNullable(column)))
        } else {
          this.exec(buildAddColumn(spec.name, column))
        }
        addedColumns.push(column.name)
        existing.add(column.name)
      }
    }

    // 索引独立于建表：新建表与补列后的表都要建，`IF NOT EXISTS` 保证幂等。
    for (const index of spec.indexes ?? []) {
      try {
        this.exec(buildCreateIndex(spec.name, index))
        createdIndexes.push(index.name)
      } catch (error) {
        issues.push({
          code: 'index-skipped',
          table: spec.name,
          detail: '建索引「' + index.name + '」失败：' + (error instanceof Error ? error.message : String(error)),
        })
      }
    }

    // 元信息缓存作废：刚补过列。
    this.tables.delete(spec.name)
    return { table: spec.name, created: !existed, addedColumns, createdIndexes, issues }
  }

  /** 插入一行。 */
  insert(table: string, row: Row): void {
    const meta = this.metaOf(table)
    const values = normalizeRow(table, row, meta.columns)
    if (values.size === 0) {
      throw new StoreError('bad-argument', '插入「' + table + '」时没有给任何列')
    }
    const columns = [...values.keys()]
    const sql =
      'INSERT INTO ' +
      quote(table) +
      ' (' +
      columns.map(quote).join(', ') +
      ') VALUES (' +
      columns.map(() => '?').join(', ') +
      ')'
    this.runSql(sql, [...values.values()])
  }

  /** 按主键 upsert。 */
  upsert(table: string, row: Row): void {
    const meta = this.metaOf(table)
    if (meta.primaryKey.length === 0) {
      throw new StoreError('unsupported-op', '表「' + table + '」没有主键，无法 upsert')
    }
    const values = normalizeRow(table, row, meta.columns)
    for (const key of meta.primaryKey) {
      if (!values.has(key)) {
        throw new StoreError('bad-argument', 'upsert「' + table + '」缺少主键列「' + key + '」')
      }
    }
    const columns = [...values.keys()]
    const updatable = columns.filter((column) => !meta.primaryKey.includes(column))
    const sql =
      'INSERT INTO ' +
      quote(table) +
      ' (' +
      columns.map(quote).join(', ') +
      ') VALUES (' +
      columns.map(() => '?').join(', ') +
      ')' +
      (updatable.length === 0
        ? ' ON CONFLICT DO NOTHING'
        : ' ON CONFLICT (' +
          meta.primaryKey.map(quote).join(', ') +
          ') DO UPDATE SET ' +
          updatable.map((column) => quote(column) + ' = excluded.' + quote(column)).join(', '))
    this.runSql(sql, [...values.values()])
  }

  /** 按主键更新。 */
  update(table: string, key: Row, patch: Row): number {
    const meta = this.metaOf(table)
    if (meta.primaryKey.length === 0) {
      throw new StoreError('unsupported-op', '表「' + table + '」没有主键，无法按主键更新')
    }
    const keyValues = normalizeRow(table, key, meta.columns)
    const patchValues = normalizeRow(table, patch, meta.columns)
    if (patchValues.size === 0) {
      throw new StoreError('bad-argument', '更新「' + table + '」时没有给任何要改的列')
    }
    const where = this.buildPrimaryKeyWhere(table, meta, keyValues)
    const sql =
      'UPDATE ' +
      quote(table) +
      ' SET ' +
      [...patchValues.keys()].map((column) => quote(column) + ' = ?').join(', ') +
      where.sql
    return this.runSql(sql, [...patchValues.values(), ...where.params]).changes
  }

  /** 按主键删除。 */
  delete(table: string, key: Row): number {
    const meta = this.metaOf(table)
    if (meta.primaryKey.length === 0) {
      throw new StoreError('unsupported-op', '表「' + table + '」没有主键，无法按主键删除')
    }
    const keyValues = normalizeRow(table, key, meta.columns)
    const where = this.buildPrimaryKeyWhere(table, meta, keyValues)
    return this.runSql('DELETE FROM ' + quote(table) + where.sql, [...where.params]).changes
  }

  /** 按主键取一行。 */
  get(table: string, key: Row): Row | undefined {
    const meta = this.metaOf(table)
    if (meta.primaryKey.length === 0) {
      throw new StoreError('unsupported-op', '表「' + table + '」没有主键，无法按主键取行')
    }
    const keyValues = normalizeRow(table, key, meta.columns)
    const where = this.buildPrimaryKeyWhere(table, meta, keyValues)
    return this.getSql<Row>('SELECT * FROM ' + quote(table) + where.sql, [...where.params])
  }

  /** 条件查询。 */
  select(table: string, query?: SelectQuery): Row[] {
    const meta = this.metaOf(table)
    const where = buildWhere(query?.where, meta.columns)
    const orderBy = buildOrderBy(query?.orderBy, meta.columns)
    const limit = buildLimit(query)
    return this.allSql<Row>(
      'SELECT * FROM ' + quote(table) + where.sql + orderBy + limit.sql,
      [...where.params, ...limit.params],
    )
  }

  /** 计数。 */
  count(table: string, where?: readonly Filter[]): number {
    const meta = this.metaOf(table)
    const built = buildWhere(where, meta.columns)
    const row = this.getSql<{ n?: number | bigint }>(
      'SELECT COUNT(*) AS n FROM ' + quote(table) + built.sql,
      [...built.params],
    )
    return Number(row?.n ?? 0)
  }

  /**
   * 事务。
   *
   * 用 `BEGIN IMMEDIATE` 而不是 `BEGIN`：默认的 `BEGIN` 是 deferred，
   * 读转写时才拿写锁，两个连接同时这么干会有一方直接 `SQLITE_BUSY`（且此时已读过数据，
   * 重试要重做全部逻辑）。`IMMEDIATE` 一开始就拿写锁，配合 `busy_timeout` 排队等待。
   * @param fn 事务体。
   */
  transaction<T>(fn: () => T): T {
    this.assertUsable()
    if (this.depth > 0) {
      throw new StoreError(
        'nested-transaction',
        '嵌套事务被拒绝：外层事务尚未结束，内层又请求 BEGIN',
        '回调里请勿再调 transaction()；需要局部原子性请把逻辑合并到同一个事务里',
      )
    }
    this.depth += 1
    try {
      this.exec('BEGIN IMMEDIATE')
    } catch (error) {
      // BEGIN 自己失败（撞锁超时、磁盘满）时**必须把深度复位**：
      // 否则 depth 永远停在 1，之后每次 transaction() 都被误判成嵌套事务，
      // 现象是「第一次撞锁之后，这个库再也不能写事务了」。
      this.depth = 0
      throw error
    }
    this.transactionCount += 1
    try {
      const result = fn()
      this.exec('COMMIT')
      this.depth = 0
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch (rollbackError) {
        // 回滚都失败了：事务状态未知，继续用这个连接就是往未知里写。降级并锁死。
        this.stateValue = 'degraded'
        this.failureCount += 1
        throw new StoreError(
          'degraded',
          '事务回滚失败，存储进入降级态，必须关闭后重建',
          String(error) + ' / ' + String(rollbackError),
        )
      }
      this.depth = 0
      this.failureCount += 1
      throw error
    }
  }

  /** 构造「按主键定位」的 WHERE 片段。 */
  private buildPrimaryKeyWhere(
    table: string,
    meta: TableMeta,
    keyValues: Map<string, SqlValue>,
  ): { sql: string; params: readonly SqlValue[] } {
    const parts: string[] = []
    const params: SqlValue[] = []
    for (const key of meta.primaryKey) {
      if (!keyValues.has(key)) {
        throw new StoreError('bad-argument', '定位「' + table + '」的记录时缺少主键列「' + key + '」')
      }
      parts.push(quote(key) + ' = ?')
      const value = keyValues.get(key)
      params.push(value === undefined ? null : value)
    }
    return { sql: ' WHERE ' + parts.join(' AND '), params }
  }

  /** 统计。 */
  stats(): StoreStats {
    let tableCount = 0
    try {
      const row = this.getSql<{ n?: number | bigint }>(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
      )
      tableCount = Number(row?.n ?? 0)
    } catch {
      tableCount = 0
    }
    return {
      provider: 'sqlite',
      state: this.stateValue,
      filePath: this.filePath,
      displayPath: this.displayPathValue,
      journalMode: this.info.journalMode,
      foreignKeys: this.info.foreignKeys,
      synchronous: this.info.synchronous,
      busyTimeoutMs: this.info.busyTimeoutMs,
      tableCount,
      sizeBytes: this.filePath === ':memory:' ? null : fileSizeOf(this.filePath),
      openedAtMs: this.openedAtMs,
      statements: this.statementCount,
      transactions: this.transactionCount,
      failures: this.failureCount,
      degraded: this.stateValue !== 'open',
    }
  }

  /** 关闭。幂等。 */
  close(): void {
    if (this.stateValue === 'closed') return
    this.stateValue = 'closed'
    this.statements.clear()
    try {
      this.db.close()
    } catch (error) {
      this.failureCount += 1
      throw new StoreError('closed', '关闭数据库失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
}
