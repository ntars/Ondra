/**
 * O-121 `ondra-store-json` 的 JSONL 实现。
 *
 * 三条落盘纪律（顺序错了就是数据丢失，写死在实现里）：
 *
 * 1. **先落盘、后改内存。** 追加写失败时内存保持原样、直接抛错——
 *    消费方看到的是「这次写没成功」，而不是「内存说成功、盘上没有」的静默漂移。
 * 2. **追加日志 + 最后一条为准。** 每次写都是往 `<表名>.jsonl` 追加一行完整 JSON；
 *    读取时按主键取**最后**出现的那条。进程崩溃最多丢「正在写的那半行」，
 *    已完成的行永远完整（每行一个 `\n` 结尾，JSON 值内的换行由 `JSON.stringify` 转义）。
 * 3. **压缩才是原子重写。** 日志会随更新变长，`compact()` 把它重写成每主键一行：
 *    先写 `<表名>.jsonl.tmp` 并 fsync，再 rename 覆盖——rename 在同一目录内是原子的，
 *    任何时刻断电，文件要么是旧完整版、要么是新完整版。
 *
 * 与 O-007 内存后端的分工：本后端 `caps.persist = true`、`caps.transaction = true`
 * （撤销日志回滚内存；未提交的变更从未落过盘），但 `caps.sql` 恒为 false——
 * 需要 FTS5 / `VACUUM INTO` 的消费方必须在装载期检查能力位后留在 SQLite 分支。
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { StoreError } from './types.js'
import type {
  ColumnSpec,
  EnsureResult,
  Filter,
  Row,
  SelectQuery,
  SortRule,
  StoreCaps,
  StoreIssue,
  StorePort,
  StoreProvider,
  StoreState,
  StoreStats,
  TableSpec,
} from './types.js'

/** 值归一化：`boolean` 转 `0 | 1`；其余按 O-006 口径原样收（对象请调用方自己序列化）。 */
function normalizeValue(table: string, column: string, value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string' ||
    value instanceof Uint8Array
  ) {
    return value
  }
  throw new StoreError(
    'unsupported-value',
    `列 ${table}.${column} 收到不可存储的类型（${typeof value}）；对象请先 JSON.stringify`,
  )
}

/** 校验标识符（表名 / 列名 / 索引名）。 */
function assertIdent(kind: string, name: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new StoreError('invalid-identifier', `${kind}「${name}」不合法：只允许小写字母开头的 [a-z0-9_]`)
  }
}

/** 主键行键：主键列值按声明顺序用 `\u0000` 拼接（该分隔符不可能与列值内容混淆）。 */
function rowKeyOf(spec: TableSpec, pkColumns: readonly ColumnSpec[], source: Row): string {
  const parts: string[] = []
  for (const column of pkColumns) {
    const value = source[column.name]
    if (value === undefined || value === null) {
      throw new StoreError('bad-argument', `表 ${spec.name} 的主键列 ${column.name} 缺失或为 null`)
    }
    parts.push(String(normalizeValue(spec.name, column.name, value)))
  }
  return parts.join('\u0000')
}

/** 判空对象。 */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 安静地 chmod（收紧权限是尽力而为，失败不致命——不该为一个 chmod 中断业务）。 */
function chmodQuiet(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // Windows / 特殊卷上 chmod 可能不可用，静默跳过。
  }
}

/** 受 `tightenPermissions` 控制的 chmod：关掉时一个权限调用都不发（调试期用）。 */
function chmodIf(allowed: boolean, path: string, mode: number): void {
  if (!allowed) return
  chmodQuiet(path, mode)
}

/** 取文件大小，出错返回 0。 */
function sizeOfQuiet(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 把默认值文本还原成字面量（只接受数字 / 单引号字符串 / NULL / CURRENT_TIMESTAMP）。 */
function literalOf(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === 'NULL' || trimmed === 'null') return null
  if (trimmed === 'CURRENT_TIMESTAMP') return Date.now()
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?\d*\.\d+$/.test(trimmed)) return Number(trimmed)
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

/**
 * 列并集合并（只加不减，与 O-006 补列语义一致）。
 * 旧 schema 有而新声明没有的列保留进尾部，并把列名记进 `addedColumns`（语义：本端口「补上」的列）。
 */
function mergeSpec(
  incoming: TableSpec,
  previous: TableSpec,
  addedColumns: string[],
  issues: StoreIssue[],
): TableSpec {
  const previousByName = new Map(previous.columns.map((column) => [column.name, column]))
  const columns: ColumnSpec[] = incoming.columns.map((column) => {
    const old = previousByName.get(column.name)
    if (old === undefined) return column
    // 「收紧」类变更（可空→非空）不回溯旧行：旧行里可能已有 null，硬套会让数据自相矛盾。
    if (column.notNull === true && old.notNull !== true) {
      issues.push({
        code: 'tighten-skipped',
        table: incoming.name,
        column: column.name,
        detail: '非空收紧不回溯旧行，仅对新写入生效',
      })
    }
    return column
  })
  for (const column of previous.columns) {
    if (!columns.some((item) => item.name === column.name)) {
      columns.push(column)
      addedColumns.push(column.name)
    }
  }
  return { ...incoming, columns }
}

/** 把 SQL `LIKE` 的 `%` / `_` 翻译成正则（ASCII 大小写不敏感，与 O-006 / O-007 同口径）。 */
function likeToRegExp(pattern: string): RegExp {
  let out = ''
  for (const char of pattern) {
    if (char === '%') out += '.*'
    else if (char === '_') out += '.'
    else out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 'i')
}

/** 单条件匹配。NULL 只对 is-null / not-null 有意义（与 SQL 三值逻辑同向）。 */
function matchFilter(row: Row, filter: Filter): boolean {
  const value = row[filter.column]
  switch (filter.op) {
    case 'is-null':
      return value === null || value === undefined
    case 'not-null':
      return !(value === null || value === undefined)
    case 'eq':
      return looseEqual(value, filter.value)
    case 'ne':
      return !looseEqual(value, filter.value)
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return compareValues(value, filter.value, filter.op)
    case 'like':
      return typeof value === 'string' && typeof filter.value === 'string'
        ? likeToRegExp(filter.value).test(value)
        : false
    case 'in':
      return Array.isArray(filter.value) && filter.value.some((item) => looseEqual(value, item))
    default:
      throw new StoreError('unsupported-op', `不支持的过滤算子：${String(filter.op)}`)
  }
}

/** 宽松相等：数字与 bigint 互比走 Number 通道。 */
function looseEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left === 'number' && typeof right === 'bigint') return left === Number(right)
  if (typeof left === 'bigint' && typeof right === 'number') return Number(left) === right
  return false
}

/** 数值/文本比较。类型不一致时返回 false（与 STRICT 表「类型不混比」的精神一致）。 */
function compareValues(
  left: unknown,
  right: unknown,
  op: 'gt' | 'gte' | 'lt' | 'lte',
): boolean {
  if (typeof left === 'number' && typeof right === 'number') {
    if (op === 'gt') return left > right
    if (op === 'gte') return left >= right
    if (op === 'lt') return left < right
    return left <= right
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (op === 'gt') return left > right
    if (op === 'gte') return left >= right
    if (op === 'lt') return left < right
    return left <= right
  }
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if (op === 'gt') return left > right
    if (op === 'gte') return left >= right
    if (op === 'lt') return left < right
    return left <= right
  }
  return false
}

/** 多列排序比较器。 */
function compareBy(rules: readonly SortRule[]): (left: Row, right: Row) => number {
  return (left: Row, right: Row): number => {
    for (const rule of rules) {
      const a = left[rule.column]
      const b = right[rule.column]
      if (a === b) continue
      if (a === null || a === undefined) return -1
      if (b === null || b === undefined) return 1
      let order: number
      if (typeof a === 'number' && typeof b === 'number') order = a - b
      else if (typeof a === 'bigint' && typeof b === 'bigint') order = a < b ? -1 : a > b ? 1 : 0
      else order = String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
      if (order !== 0) return rule.direction === 'desc' ? -order : order
    }
    return 0
  }
}

/** 单表状态：声明、数据、文件、统计。 */
interface TableState {
  /** 当前生效的表声明（ensureTable 可能把列补进来）。 */
  spec: TableSpec
  /** 主键列（按声明顺序）。 */
  pkColumns: readonly ColumnSpec[]
  /** 数据：行键 → 最后一条完整行。无主键表用 `#<序号>` 作键。 */
  rows: Map<string, Row>
  /** 追加日志文件。 */
  dataFile: string
  /** schema 文件。 */
  schemaFile: string
  /** 自上次压缩以来的追加行数。 */
  appendedSinceCompact: number
}

/** JSONL 存储实现。一个实例对应一个数据目录。 */
export class JsonlStore implements StorePort {
  readonly provider: StoreProvider = 'jsonl'
  readonly caps: StoreCaps = {
    sql: false,
    fts: false,
    persist: true,
    transaction: true,
  }
  /** 数据目录绝对路径。 */
  readonly filePath: string | null

  private currentState: StoreState = 'open'
  private readonly tables = new Map<string, TableState>()
  /** 撤销日志：事务内的每次写记一条「改之前的行」，回滚按倒序恢复。 */
  private undoLog: { table: TableState; key: string; before: Row | undefined }[] | null = null
  private rowidSeq = 0
  private statements = 0
  private transactions = 0
  private failures = 0
  private corruptLines = 0
  private readonly openedAtMs = Date.now()
  private readonly maxRowsPerTable: number
  private readonly compactFactor: number
  private readonly tightenPermissions: boolean
  /** 用户可见写法（只进 stats，不进任何文件）。 */
  private readonly display: string | null

  /**
   * @param dir 数据目录（由入口用 O-002 的 `ensure('user', 'jsonl-store')` 给出）。
   * @param displayPath 用户可见写法（如 `~/.ondra/user/jsonl-store`）。
   * @param maxRowsPerTable 单表行数上限：到上限拒绝新增，不悄悄淘汰旧行。
   * @param compactFactor 追加行数达到「存活行数与 64 的较大者」的多少倍时自动压缩（0 = 关闭）。
   * @param tightenPermissions 是否把目录收紧到 0700、文件收紧到 0600。
   */
  constructor(
    dir: string,
    displayPath: string | null,
    maxRowsPerTable: number,
    compactFactor: number,
    tightenPermissions: boolean,
  ) {
    this.filePath = dir
    this.display = displayPath
    this.maxRowsPerTable = maxRowsPerTable
    this.compactFactor = compactFactor
    this.tightenPermissions = tightenPermissions
    try {
      mkdirSync(dir, { recursive: true })
      chmodIf(tightenPermissions, dir, 0o700)
    } catch (error) {
      throw new StoreError('open-failed', `JSONL 数据目录创建失败：${dir}`, messageOf(error))
    }
  }

  /** 当前状态。 */
  get state(): StoreState {
    return this.currentState
  }

  /** JSONL 后端没有 SQL 面。 */
  get raw(): undefined {
    return undefined
  }

  /** 断言端口可用。 */
  private assertOpen(): void {
    if (this.currentState === 'closed') {
      throw new StoreError('closed', 'JSONL 存储已关闭，任何调用都不会生效')
    }
    if (this.currentState === 'degraded') {
      throw new StoreError('degraded', 'JSONL 存储处于降级态（落盘与内存可能不一致），只允许 close 后重建')
    }
  }

  /** 取表（未接入即报 unknown-table）。 */
  private tableOf(table: string): TableState {
    const state = this.tables.get(table)
    if (state === undefined) {
      throw new StoreError('unknown-table', `表 ${table} 尚未接入（先 ensureTable）`)
    }
    return state
  }

  /**
   * 追加一行到日志文件。**只落盘，不改内存**——由调用方在成功后改内存。
   * 逐次 fsync 太贵：追加用 appendFileSync，进程崩溃最多丢内核缓冲里最后一小段；
   * `compact()` 才 fsync。这是日志型存储的标准取舍。
   */
  private appendLine(state: TableState, line: Row): void {
    try {
      appendFileSync(state.dataFile, JSON.stringify(line) + '\n', 'utf8')
      chmodIf(this.tightenPermissions, state.dataFile, 0o600)
      state.appendedSinceCompact += 1
    } catch (error) {
      this.failures += 1
      throw new StoreError('open-failed', `表 ${state.spec.name} 追加落盘失败（内存未变更）`, messageOf(error))
    }
  }

  /** schema 文件原子写：tmp + rename。schema 与数据行分文件，schema 损坏不连累数据。 */
  private writeSchema(state: TableState): void {
    const payload = JSON.stringify({ version: 1, spec: state.spec }, null, 2) + '\n'
    const tmp = state.schemaFile + '.tmp'
    try {
      writeFileSync(tmp, payload, 'utf8')
      chmodIf(this.tightenPermissions, tmp, 0o600)
      renameSync(tmp, state.schemaFile)
    } catch (error) {
      this.failures += 1
      try {
        unlinkSync(tmp)
      } catch {
        // 临时文件删不掉不影响主流程——下次写会覆盖它。
      }
      throw new StoreError('open-failed', `表 ${state.spec.name} 的 schema 写入失败`, messageOf(error))
    }
  }

  /**
   * 首次接入一张表：读旧 schema（有则做列并集）、加载追加日志、写回 schema。
   * 懒加载：没被 ensureTable 的表不占内存、不占启动时间。
   */
  private loadTable(spec: TableSpec, addedColumns: string[], issues: StoreIssue[]): void {
    const dir = this.filePath ?? ''
    const schemaFile = join(dir, `${spec.name}.schema.json`)
    const dataFile = join(dir, `${spec.name}.jsonl`)
    let previous: TableSpec | undefined
    if (existsSync(schemaFile)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(schemaFile, 'utf8'))
        if (isRecordObject(parsed) && isRecordObject(parsed['spec'])) {
          previous = parsed['spec'] as unknown as TableSpec
        }
      } catch {
        issues.push({ code: 'corrupt-line-skipped', table: spec.name, detail: 'schema 文件解析失败，按本次声明重建' })
      }
    }
    const merged = previous === undefined ? spec : mergeSpec(spec, previous, addedColumns, issues)
    const table: TableState = {
      spec: merged,
      pkColumns: merged.columns.filter((column) => column.primaryKey === true),
      rows: new Map(),
      dataFile,
      schemaFile,
      appendedSinceCompact: 0,
    }
    // 加载追加日志：按行 JSON.parse，坏行跳过并计数（最后一行不完整是崩溃常态，不是异常）。
    if (existsSync(dataFile)) {
      const text = readFileSync(dataFile, 'utf8')
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line === '') continue
        let entry: unknown
        try {
          entry = JSON.parse(line)
        } catch {
          this.corruptLines += 1
          issues.push({
            code: 'corrupt-line-skipped',
            table: merged.name,
            detail:
              index === lines.length - 2
                ? '追加日志最后一行不完整（多为上次进程中断），已跳过'
                : '追加日志中间有一行损坏，已跳过',
          })
          continue
        }
        if (!isRecordObject(entry) || typeof entry['__key'] !== 'string') {
          this.corruptLines += 1
          issues.push({
            code: 'corrupt-line-skipped',
            table: merged.name,
            detail: `追加日志第 ${index + 1} 行缺少行键，已跳过`,
          })
          continue
        }
        if (entry['__del'] === true) {
          table.rows.delete(entry['__key'])
          continue
        }
        if (!isRecordObject(entry['v'])) {
          this.corruptLines += 1
          issues.push({
            code: 'corrupt-line-skipped',
            table: merged.name,
            detail: `追加日志第 ${index + 1} 行的行数据不是对象，已跳过`,
          })
          continue
        }
        table.rows.set(entry['__key'], entry['v'])
      }
    }
    this.tables.set(merged.name, table)
    this.writeSchema(table)
  }

  /** 组装一行：补默认值、校验非空、归一化。 */
  private buildRow(state: TableState, source: Row): Row {
    const row: Row = {}
    for (const column of state.spec.columns) {
      let value = source[column.name]
      if (value === undefined && column.default !== undefined) {
        value = literalOf(column.default)
      }
      if (value === undefined || value === null) {
        if (column.notNull === true) {
          throw new StoreError('bad-argument', `列 ${state.spec.name}.${column.name} 非空，收到 ${String(value)}`)
        }
        row[column.name] = null
        continue
      }
      row[column.name] = normalizeValue(state.spec.name, column.name, value)
    }
    return row
  }

  /** 追加行数超过「存活行数与 64 的较大者 × 倍数」时自动压缩（事务外才触发）。 */
  private maybeCompact(state: TableState): void {
    if (this.compactFactor <= 0) return
    if (state.appendedSinceCompact < this.compactFactor * Math.max(64, state.rows.size)) return
    try {
      this.compact(state.spec.name)
    } catch {
      // 自动压缩失败不致命：日志照常可用，只是更长了。失败计数已在 compact 内记过。
    }
  }

  /** 写一行（insert / upsert / update 的最终形态都走这里）。 */
  private putRow(state: TableState, key: string, row: Row): void {
    this.assertOpen()
    this.statements += 1
    if (this.undoLog !== null) {
      // 事务内：记前像、改内存；落盘延迟到提交点。
      this.undoLog.push({ table: state, key, before: state.rows.get(key) })
      state.rows.set(key, row)
      return
    }
    this.appendLine(state, { __key: key, v: row })
    state.rows.set(key, row)
    this.maybeCompact(state)
  }

  /** 删除一行：追加墓碑；内存立即移除。 */
  private removeRow(state: TableState, key: string): void {
    this.assertOpen()
    this.statements += 1
    if (this.undoLog !== null) {
      this.undoLog.push({ table: state, key, before: state.rows.get(key) })
      state.rows.delete(key)
      return
    }
    this.appendLine(state, { __key: key, __del: true })
    state.rows.delete(key)
  }

  /** 上限检查：新增（键不存在）时若已到上限则拒绝。 */
  private assertQuota(state: TableState, key: string): void {
    if (state.rows.has(key)) return
    if (state.rows.size >= this.maxRowsPerTable) {
      this.failures += 1
      throw new StoreError(
        'bad-argument',
        `表 ${state.spec.name} 已到单表上限 ${this.maxRowsPerTable} 行，拒绝新增（不悄悄淘汰旧行）`,
      )
    }
  }

  /** 校验 patch 的列名都存在。 */
  private assertColumns(state: TableState, names: readonly string[]): void {
    for (const name of names) {
      if (!state.spec.columns.some((column) => column.name === name)) {
        throw new StoreError('unknown-column', `表 ${state.spec.name} 没有列 ${name}`)
      }
    }
  }

  // ---------------- StorePort ----------------

  /** 确保表存在（幂等）。 */
  ensureTable(spec: TableSpec): EnsureResult {
    this.assertOpen()
    assertIdent('表名', spec.name)
    for (const column of spec.columns) assertIdent(`表 ${spec.name} 的列名`, column.name)
    for (const index of spec.indexes ?? []) assertIdent(`表 ${spec.name} 的索引名`, index.name)
    const existing = this.tables.get(spec.name)
    if (existing !== undefined) {
      // 已接入：只做补列（列并集），已有数据不动。
      const addedColumns: string[] = []
      const issues: StoreIssue[] = []
      const known = new Set(existing.spec.columns.map((column) => column.name))
      const incoming = spec.columns.filter((column) => !known.has(column.name))
      if (incoming.length > 0) {
        const merged = mergeSpec(spec, existing.spec, addedColumns, issues)
        existing.spec = merged
        existing.pkColumns = merged.columns.filter((column) => column.primaryKey === true)
        this.writeSchema(existing)
      }
      return { table: spec.name, created: false, addedColumns, createdIndexes: [], issues }
    }
    const addedColumns: string[] = []
    const issues: StoreIssue[] = []
    // created 的口径（types.ts）：磁盘上原本没有该表的数据文件才算 true；
    // 文件已存在只是「本次接入」，为 false——消费方靠它区分「新建」与「续用」。
    const existedOnDisk = existsSync(join(this.filePath ?? '', `${spec.name}.jsonl`))
    this.loadTable(spec, addedColumns, issues)
    return { table: spec.name, created: !existedOnDisk, addedColumns, createdIndexes: [], issues }
  }

  /** 表是否已接入。 */
  tableExists(table: string): boolean {
    return this.tables.has(table)
  }

  /** 插入一行。主键冲突抛错。 */
  insert(table: string, row: Row): void {
    const state = this.tableOf(table)
    if (state.pkColumns.length === 0) {
      // 无主键表：追加型语义，行号作键，select/count 可用；get/update/delete 不可用。
      this.assertOpen()
      if (this.undoLog !== null) {
        throw new StoreError('bad-argument', '无主键表不支持在事务内写入（无法稳定定位行）')
      }
      if (state.rows.size >= this.maxRowsPerTable) {
        this.failures += 1
        throw new StoreError('bad-argument', `表 ${table} 已到单表上限 ${this.maxRowsPerTable} 行，拒绝新增`)
      }
      this.rowidSeq += 1
      const key = `#${this.rowidSeq}`
      const built = this.buildRow(state, row)
      this.appendLine(state, { __key: key, v: built })
      state.rows.set(key, built)
      this.statements += 1
      this.maybeCompact(state)
      return
    }
    const key = rowKeyOf(state.spec, state.pkColumns, row)
    if (state.rows.has(key)) {
      this.failures += 1
      throw new StoreError('bad-argument', `表 ${table} 主键已存在（insert 不覆盖，要用 upsert）`)
    }
    this.assertQuota(state, key)
    this.putRow(state, key, this.buildRow(state, row))
  }

  /** 按主键插入或更新。 */
  upsert(table: string, row: Row): void {
    const state = this.tableOf(table)
    if (state.pkColumns.length === 0) {
      throw new StoreError('bad-argument', `表 ${table} 未声明主键列，upsert 不可用`)
    }
    const key = rowKeyOf(state.spec, state.pkColumns, row)
    this.assertQuota(state, key)
    this.putRow(state, key, this.buildRow(state, row))
  }

  /** 按主键更新。 */
  update(table: string, key: Row, patch: Row): number {
    const state = this.tableOf(table)
    if (state.pkColumns.length === 0) {
      throw new StoreError('bad-argument', `表 ${table} 未声明主键列，update 不可用`)
    }
    this.assertColumns(state, Object.keys(patch))
    const rowKey = rowKeyOf(state.spec, state.pkColumns, key)
    const current = state.rows.get(rowKey)
    if (current === undefined) return 0
    this.putRow(state, rowKey, this.buildRow(state, { ...current, ...patch }))
    return 1
  }

  /** 按主键删除。 */
  delete(table: string, key: Row): number {
    const state = this.tableOf(table)
    if (state.pkColumns.length === 0) {
      throw new StoreError('bad-argument', `表 ${table} 未声明主键列，delete 不可用`)
    }
    const rowKey = rowKeyOf(state.spec, state.pkColumns, key)
    if (!state.rows.has(rowKey)) return 0
    this.removeRow(state, rowKey)
    return 1
  }

  /** 按主键取一行。 */
  get(table: string, key: Row): Row | undefined {
    const state = this.tableOf(table)
    if (state.pkColumns.length === 0) {
      throw new StoreError('bad-argument', `表 ${table} 未声明主键列，get 不可用`)
    }
    const rowKey = rowKeyOf(state.spec, state.pkColumns, key)
    const row = state.rows.get(rowKey)
    return row === undefined ? undefined : { ...row }
  }

  /** 条件查询：内存过滤 + 排序 + 分页。 */
  select(table: string, query?: SelectQuery): Row[] {
    const state = this.tableOf(table)
    let rows = [...state.rows.values()]
    if (query?.where !== undefined) {
      for (const filter of query.where) rows = rows.filter((row) => matchFilter(row, filter))
    }
    if (query?.orderBy !== undefined && query.orderBy.length > 0) {
      rows.sort(compareBy(query.orderBy))
    }
    const offset = query?.offset !== undefined && query.offset > 0 ? Math.trunc(query.offset) : 0
    const limit = query?.limit !== undefined && query.limit > 0 ? Math.trunc(query.limit) : rows.length
    return rows.slice(offset, offset + limit).map((row) => ({ ...row }))
  }

  /** 计数。 */
  count(table: string, where?: readonly Filter[]): number {
    const state = this.tableOf(table)
    if (where === undefined || where.length === 0) return state.rows.size
    let total = 0
    for (const row of state.rows.values()) {
      let matched = true
      for (const filter of where) {
        if (!matchFilter(row, filter)) {
          matched = false
          break
        }
      }
      if (matched) total += 1
    }
    return total
  }

  /**
   * 事务：撤销日志 + 提交时统一落盘。
   *
   * 提交阶段落盘失败**不回滚内存**（部分行已落盘，回滚只会制造不一致），
   * 改标 `degraded`——与 O-006 的「状态未知比假装正常诚实」同一条哲学。
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen()
    if (this.undoLog !== null) {
      throw new StoreError('nested-transaction', 'JSONL 存储不支持嵌套事务（撤销日志是单层的）')
    }
    const log: { table: TableState; key: string; before: Row | undefined }[] = []
    this.undoLog = log
    this.transactions += 1
    let result: T
    try {
      result = fn()
    } catch (error) {
      // 回滚：按倒序恢复前像。内存从未落盘，恢复即一致。
      for (let index = log.length - 1; index >= 0; index -= 1) {
        const entry = log[index]
        if (entry.before === undefined) entry.table.rows.delete(entry.key)
        else entry.table.rows.set(entry.key, entry.before)
      }
      this.undoLog = null
      this.failures += 1
      throw error
    }
    // 提交：先撤掉撤销日志（此后失败不走回滚），再统一落盘。
    this.undoLog = null
    const touched = new Map<TableState, Set<string>>()
    for (const entry of log) {
      let keys = touched.get(entry.table)
      if (keys === undefined) {
        keys = new Set()
        touched.set(entry.table, keys)
      }
      keys.add(entry.key)
    }
    try {
      for (const [state, keys] of touched) {
        for (const key of keys) {
          const row = state.rows.get(key)
          if (row === undefined) this.appendLine(state, { __key: key, __del: true })
          else this.appendLine(state, { __key: key, v: row })
        }
        this.maybeCompact(state)
      }
    } catch (error) {
      this.currentState = 'degraded'
      throw error
    }
    return result
  }

  /** 压缩：全量重写为每主键一行（tmp + fsync + rename 原子替换）。 */
  compact(table: string): number {
    this.assertOpen()
    const state = this.tableOf(table)
    const tmp = state.dataFile + '.tmp'
    try {
      const fd = openSync(tmp, 'w')
      try {
        for (const [key, row] of state.rows) {
          writeSync(fd, JSON.stringify({ __key: key, v: row }) + '\n', null, 'utf8')
        }
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      chmodIf(this.tightenPermissions, tmp, 0o600)
      renameSync(tmp, state.dataFile)
      state.appendedSinceCompact = 0
      return state.rows.size
    } catch (error) {
      this.failures += 1
      try {
        unlinkSync(tmp)
      } catch {
        // 同上：临时文件删不掉不影响主流程。
      }
      throw new StoreError('open-failed', `表 ${table} 压缩失败（原日志未动，数据无损）`, messageOf(error))
    }
  }

  /** 运行期统计。 */
  stats(): StoreStats {
    let sizeBytes = 0
    let appendedPeak = 0
    for (const state of this.tables.values()) {
      sizeBytes += sizeOfQuiet(state.dataFile) + sizeOfQuiet(state.schemaFile)
      if (state.appendedSinceCompact > appendedPeak) appendedPeak = state.appendedSinceCompact
    }
    return {
      provider: this.provider,
      state: this.currentState,
      filePath: this.filePath,
      displayPath: this.display,
      journalMode: null,
      foreignKeys: false,
      synchronous: null,
      busyTimeoutMs: 0,
      tableCount: this.tables.size,
      sizeBytes,
      openedAtMs: this.openedAtMs,
      statements: this.statements,
      transactions: this.transactions,
      failures: this.failures,
      degraded: this.currentState === 'degraded',
      corruptLines: this.corruptLines,
      appendedSinceCompact: appendedPeak,
    }
  }

  /** 关闭。幂等。未提交的事务按回滚处理。 */
  close(): void {
    if (this.currentState === 'closed') return
    if (this.undoLog !== null) {
      const log = this.undoLog
      this.undoLog = null
      for (let index = log.length - 1; index >= 0; index -= 1) {
        const entry = log[index]
        if (entry.before === undefined) entry.table.rows.delete(entry.key)
        else entry.table.rows.set(entry.key, entry.before)
      }
    }
    this.currentState = 'closed'
    this.tables.clear()
  }
}
