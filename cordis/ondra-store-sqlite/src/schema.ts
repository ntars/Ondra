/**
 * 表结构相关的**纯函数**：标识符校验、建表 / 补列 / 建索引的 SQL 拼装、默认值字面量校验、
 * 条件查询的 `WHERE` 构造。
 *
 * 这一层刻意不碰任何连接对象，也不碰 `ctx`——它是可单独推演的部分，
 * 出错时能一眼看出是「SQL 拼错」还是「连接坏了」。
 */

import { IDENT_RE, StoreError } from './types.js'
import type { ColumnSpec, Filter, FilterOp, IndexSpec, SelectQuery, SortRule, SqlValue, TableSpec } from './types.js'

/** 允许出现在 `DEFAULT` 位置的字面量形状。 */
const DEFAULT_LITERAL_RE = /^(NULL|\d+(\.\d+)?|'(?:[^']|'')*'|CURRENT_(TIMESTAMP|DATE|TIME))$/i

/** 过滤算子到 SQL 的映射。`in` / `is-null` / `not-null` 需要特殊处理，不在这里。 */
const SIMPLE_OPERATORS: Record<'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like', string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
}

/** 单次查询里 `IN` 列表的上限，防「一次塞一万个参数」把语句缓存撑爆。 */
const MAX_IN_ITEMS = 500

/**
 * 校验标识符，非法即抛。
 * @param kind 种类（用于错误文案）。
 * @param name 待校验名字。
 */
export function assertIdent(kind: '表' | '列' | '索引', name: string): void {
  if (!IDENT_RE.test(name)) {
    throw new StoreError(
      'invalid-identifier',
      kind + '名「' + name + '」不合法：必须匹配 ^[a-z][a-z0-9_]*$（小写字母开头，只含小写字母、数字、下划线）',
    )
  }
}

/**
 * 给标识符加双引号。名字已通过 `assertIdent`，这里只是防御性兜底（双引号转义成两个）。
 * @param name 已验证的名字。
 */
export function quote(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

/**
 * 校验并原样返回 `DEFAULT` 字面量。
 * @param raw 声明的默认值。
 */
export function assertDefault(raw: string): string {
  const trimmed = raw.trim()
  if (!DEFAULT_LITERAL_RE.test(trimmed)) {
    throw new StoreError(
      'bad-argument',
      '默认值「' + raw + '」不是允许的字面量：只接受 NULL / 数字 / \'单引号字符串\' / CURRENT_TIMESTAMP',
    )
  }
  return trimmed
}

/**
 * 渲染单列定义。
 * @param column 列声明。
 */
export function renderColumn(column: ColumnSpec): string {
  assertIdent('列', column.name)
  const parts = [quote(column.name), column.type]
  if (column.primaryKey === true) parts.push('PRIMARY KEY')
  if (column.notNull === true) parts.push('NOT NULL')
  if (column.default !== undefined) parts.push('DEFAULT ' + assertDefault(column.default))
  return parts.join(' ')
}

/**
 * 渲染建表语句。
 * @param spec 表声明。
 * @param strict 是否追加 `STRICT`。
 */
export function buildCreateTable(spec: TableSpec, strict: boolean): string {
  assertIdent('表', spec.name)
  if (spec.columns.length === 0) {
    throw new StoreError('bad-argument', '表「' + spec.name + '」没有任何列，建表语句无意义')
  }
  const body = spec.columns.map(renderColumn).join(', ')
  return 'CREATE TABLE IF NOT EXISTS ' + quote(spec.name) + ' (' + body + ')' + (strict ? ' STRICT' : '')
}

/**
 * 渲染补列语句。
 *
 * SQLite 的 `ALTER TABLE ADD COLUMN` **不能加主键、不能加非空但无默认值的列**；
 * 这两种情况由调用方先判断再决定降级或跳过，这里只负责拼。
 * @param table 表名。
 * @param column 列声明。
 */
export function buildAddColumn(table: string, column: ColumnSpec): string {
  assertIdent('表', table)
  return 'ALTER TABLE ' + quote(table) + ' ADD COLUMN ' + renderColumn(column)
}

/**
 * 渲染建索引语句。
 * @param table 表名。
 * @param index 索引声明。
 */
export function buildCreateIndex(table: string, index: IndexSpec): string {
  assertIdent('表', table)
  assertIdent('索引', index.name)
  if (index.columns.length === 0) {
    throw new StoreError('bad-argument', '索引「' + index.name + '」没有列')
  }
  for (const column of index.columns) assertIdent('列', column)
  return (
    'CREATE ' +
    (index.unique === true ? 'UNIQUE ' : '') +
    'INDEX IF NOT EXISTS ' +
    quote(index.name) +
    ' ON ' +
    quote(table) +
    ' (' +
    index.columns.map(quote).join(', ') +
    ')'
  )
}

/**
 * 把 `boolean` 归一化成 `0 | 1`，其余值原样返回。
 *
 * 两个后端做同样的转换——只有一处做就会变成「换后端数据含义变了」。
 * @param value 待归一化的值。
 */
export function normalizeValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new StoreError('unsupported-value', '数字 ' + String(value) + ' 不能入库：NaN / Infinity 不是有效的 SQL 值')
    }
    return value
  }
  if (typeof value === 'string' || typeof value === 'bigint') return value
  if (value instanceof Uint8Array) return value
  throw new StoreError(
    'unsupported-value',
    '值类型 ' + Object.prototype.toString.call(value) + ' 不能入库：对象与数组请调用方自己 JSON.stringify 成字符串',
  )
}

/**
 * 校验一个行对象的列名都合法，并归一化其值。
 * @param table 表名（用于错误文案）。
 * @param row 行数据。
 * @param known 已声明的列名集合。
 */
export function normalizeRow(table: string, row: Record<string, unknown>, known: ReadonlySet<string>): Map<string, SqlValue> {
  const out = new Map<string, SqlValue>()
  for (const [key, value] of Object.entries(row)) {
    if (!known.has(key)) {
      throw new StoreError('unknown-column', '表「' + table + '」没有列「' + key + '」', '请先在建表声明里加上该列')
    }
    out.set(key, normalizeValue(value))
  }
  return out
}

/** 拼好的条件：SQL 片段与绑定参数。 */
export interface WhereSql {
  /** 片段，已含 `WHERE ` 前缀；无条件时为空串。 */
  readonly sql: string
  /** 绑定参数。 */
  readonly params: readonly SqlValue[]
}

/**
 * 构造 `WHERE` 片段。多个条件之间 `AND`，空条件返回空串（不是 `WHERE 1=1`）。
 * @param filters 过滤条件。
 * @param known 已声明的列名集合。
 */
export function buildWhere(filters: readonly Filter[] | undefined, known: ReadonlySet<string>): WhereSql {
  if (filters === undefined || filters.length === 0) return { sql: '', params: [] }
  const parts: string[] = []
  const params: SqlValue[] = []
  for (const filter of filters) {
    if (!known.has(filter.column)) {
      throw new StoreError('unknown-column', '过滤条件用了未声明的列「' + filter.column + '」')
    }
    const column = quote(filter.column)
    const op: FilterOp = filter.op
    if (op === 'is-null') {
      parts.push(column + ' IS NULL')
      continue
    }
    if (op === 'not-null') {
      parts.push(column + ' IS NOT NULL')
      continue
    }
    if (op === 'in') {
      if (!Array.isArray(filter.value)) {
        throw new StoreError('bad-argument', 'in 算子的值必须是数组')
      }
      if (filter.value.length === 0) {
        // 空集合的 IN 恒假。写成 `IN (NULL)` 会变成「永不为真但语法合法」的怪语句，
        // 不如直接给一个恒假片段，语义清楚。
        parts.push('0 = 1')
        continue
      }
      if (filter.value.length > MAX_IN_ITEMS) {
        throw new StoreError('bad-argument', 'in 算子的数组上限是 ' + MAX_IN_ITEMS + ' 项')
      }
      const values = filter.value.map(normalizeValue)
      parts.push(column + ' IN (' + values.map(() => '?').join(', ') + ')')
      for (const value of values) params.push(value)
      continue
    }
    const operator = SIMPLE_OPERATORS[op]
    if (operator === undefined) {
      throw new StoreError('bad-argument', '未知的过滤算子「' + String(op) + '」')
    }
    parts.push(column + ' ' + operator + ' ?')
    params.push(normalizeValue(filter.value))
  }
  return { sql: ' WHERE ' + parts.join(' AND '), params }
}

/**
 * 构造 `ORDER BY` 片段。
 * @param orderBy 排序规则。
 * @param known 已声明的列名集合。
 */
export function buildOrderBy(orderBy: readonly SortRule[] | undefined, known: ReadonlySet<string>): string {
  if (orderBy === undefined || orderBy.length === 0) return ''
  const parts = orderBy.map((rule) => {
    if (!known.has(rule.column)) {
      throw new StoreError('unknown-column', '排序用了未声明的列「' + rule.column + '」')
    }
    return quote(rule.column) + (rule.direction === 'desc' ? ' DESC' : ' ASC')
  })
  return ' ORDER BY ' + parts.join(', ')
}

/**
 * 构造完整的 `LIMIT` / `OFFSET` 片段。
 *
 * SQLite 的 `OFFSET` 必须跟 `LIMIT`，所以只有 offset 没有 limit 时补一个 `LIMIT -1`。
 * @param query 查询条件。
 */
export function buildLimit(query: SelectQuery | undefined): { sql: string; params: number[] } {
  if (query === undefined) return { sql: '', params: [] }
  const limit = query.limit
  const offset = query.offset
  if (typeof limit === 'number') {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new StoreError('bad-argument', 'limit 必须是非负整数')
    }
    if (typeof offset === 'number') {
      if (!Number.isInteger(offset) || offset < 0) {
        throw new StoreError('bad-argument', 'offset 必须是非负整数')
      }
      return { sql: ' LIMIT ? OFFSET ?', params: [limit, offset] }
    }
    return { sql: ' LIMIT ?', params: [limit] }
  }
  if (typeof offset === 'number') {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new StoreError('bad-argument', 'offset 必须是非负整数')
    }
    return { sql: ' LIMIT -1 OFFSET ?', params: [offset] }
  }
  return { sql: '', params: [] }
}

/**
 * 判断某列能否被 `ALTER TABLE ADD COLUMN` 补上。
 *
 * 返回降级说明：`null` 表示可以直接加；字符串表示需要降级（空串表示必须跳过）。
 * @param column 列声明。
 */
export function addColumnPlan(column: ColumnSpec): { skip: boolean; issue: 'not-null-without-default' | 'primary-key-skipped' | null } {
  if (column.primaryKey === true) return { skip: true, issue: 'primary-key-skipped' }
  if (column.notNull === true && column.default === undefined) {
    return { skip: false, issue: 'not-null-without-default' }
  }
  return { skip: false, issue: null }
}

/**
 * 把补列时用的列声明降级成可空（去掉 `NOT NULL`）。
 * @param column 原声明。
 */
export function relaxToNullable(column: ColumnSpec): ColumnSpec {
  return {
    name: column.name,
    type: column.type,
    primaryKey: column.primaryKey,
    default: column.default,
  }
}
