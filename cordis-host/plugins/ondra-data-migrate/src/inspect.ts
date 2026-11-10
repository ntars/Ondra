/**
 * 结构读取与差异比对：把 `PRAGMA` 的原始行翻译成「库里到底是什么样」，
 * 再和插件声明的 `TableSpec` 逐字段对位。
 *
 * 这一层是**纯读**：不建表、不改表、不开事务。所有写操作都在 `rebuild.ts`。
 *
 * 三个容易写错的地方，写在这里说明为什么这么写：
 *
 * 1. **主键列不参与非空比对。** SQLite 的 `PRAGMA table_info` 对
 *    `INTEGER PRIMARY KEY` 报的是 `notnull = 0`——主键当然非空，但元数据不这么写。
 *    照直比对会让每一张带整型主键的表都被判成「非空约束不一致」，
 *    然后触发一次毫无必要的整表重建。这是最典型的「元数据陷阱」。
 *
 * 2. **主键用 `pk` 序号排序，不靠列顺序。** 复合主键的列顺序决定索引形状，
 *    `PRIMARY KEY (a, b)` 与 `PRIMARY KEY (b, a)` 是两个不同的键。
 *
 * 3. **索引只判「有没有」，不判「定义对不对」。** 同名不同列的索引
 *    `CREATE INDEX IF NOT EXISTS` 改不动，需要 `DROP` 再建。
 *    这一项本轮不检测，写进 README「已知限制」——宁可不管，也不假装在管。
 */

import { MigrateError, SQL_NAME_RE } from './types.js'
import type {
  ColumnInfo,
  IndexInfo,
  RawSqlFacetLike,
  TableDiff,
  TableShape,
  TableSpecLike,
} from './types.js'

/**
 * 校验 SQL 标识符。不合规直接抛错——**绝不「清洗一下继续用」**：
 * 清洗会把两个不同的名字映射成同一个，那是最难查的串表事故。
 * @param name 名字。
 * @param kind 种类，只用于报错文案。
 */
export function assertSqlName(name: string, kind: string): void {
  if (typeof name !== 'string' || !SQL_NAME_RE.test(name)) {
    throw new MigrateError(
      'invalid-identifier',
      `${kind}名 "${String(name)}" 不合规：必须匹配 ^[a-z][a-z0-9_]*$（小写字母开头，只含小写字母、数字、下划线）`,
    )
  }
  if (name.startsWith('sqlite_')) {
    throw new MigrateError('invalid-identifier', `${kind}名 "${name}" 用了 SQLite 保留前缀 sqlite_`)
  }
}

/**
 * 表是否存在。
 * @param raw 原始 SQL 面。
 * @param table 表名（已校验）。
 */
export function tableExists(raw: RawSqlFacetLike, table: string): boolean {
  const row = raw.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  )
  return row !== undefined
}

/**
 * 读列信息。
 *
 * `PRAGMA table_info` 不能用占位绑定（它是语法不是查询），所以先过标识符正则再拼，
 * 并且**一律套双引号**——双引号在 SQLite 里是标识符引用，拼进去的只能是已校验的名字。
 * @param raw 原始 SQL 面。
 * @param table 表名（已校验）。
 */
export function readColumns(raw: RawSqlFacetLike, table: string): ColumnInfo[] {
  const rows = raw.all<{
    cid: number
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }>(`PRAGMA table_info("${table}")`)
  return rows.map((row) => ({
    name: row.name,
    type: typeof row.type === 'string' ? row.type : '',
    notNull: row.notnull === 1,
    defaultValue: row.dflt_value ?? null,
    primaryKey: row.pk > 0,
    primaryKeyIndex: row.pk,
    position: row.cid,
  }))
}

/**
 * 读索引信息（含建表时自动生成的主键索引与唯一索引）。
 * @param raw 原始 SQL 面。
 * @param table 表名（已校验）。
 */
export function readIndexes(raw: RawSqlFacetLike, table: string): IndexInfo[] {
  const listed = raw.all<{ seq: number; name: string; unique: number; origin: string; partial: number }>(
    `PRAGMA index_list("${table}")`,
  )
  const result: IndexInfo[] = []
  for (const item of listed) {
    // 索引名同样过一遍正则；自动索引名形如 `sqlite_autoindex_xxx_1`，含保留前缀，
    // 但它只是**读**出来给人看，不参与任何拼接，所以这里不调 assertSqlName。
    const columns = raw
      .all<{ seqno: number; cid: number; name: string | null }>(`PRAGMA index_info("${item.name}")`)
      .sort((a, b) => a.seqno - b.seqno)
      // 表达式索引的列名是 null，用占位符表示——重建时不复制表达式索引，见 rebuild.ts。
      .map((column) => column.name ?? '<expr>')
    result.push({
      name: item.name,
      unique: item.unique === 1,
      origin: typeof item.origin === 'string' ? item.origin : 'c',
      columns,
    })
  }
  return result
}

/**
 * 读一张表的真实形态。表不存在时返回 `exists: false` 的空形态，不抛错——
 * 「不存在」是正常状态（首次初始化），不是异常。
 * @param raw 原始 SQL 面。
 * @param table 表名。
 */
export function inspectTable(raw: RawSqlFacetLike, table: string): TableShape {
  assertSqlName(table, '表')
  if (!tableExists(raw, table)) {
    return { table, exists: false, columns: [], indexes: [] }
  }
  return { table, exists: true, columns: readColumns(raw, table), indexes: readIndexes(raw, table) }
}

/**
 * 归一化类型文本，用于比对。
 * SQLite 对类型大小写不敏感，`text` 与 `TEXT` 是同一个类型；
 * 空串代表「非 STRICT 表的无类型列」，按 `ANY` 处理（`STRICT` 表里它只能是 ANY）。
 * @param type 库里的类型文本。
 */
function normalizeType(type: string): string {
  const upper = type.trim().toUpperCase()
  return upper === '' ? 'ANY' : upper
}

/**
 * 比对声明与现实。
 * @param shape 真实形态。
 * @param spec 声明的表结构。
 */
export function diffTable(shape: TableShape, spec: TableSpecLike): TableDiff {
  assertSqlName(spec.name, '表')
  const actual = new Map<string, ColumnInfo>()
  for (const column of shape.columns) actual.set(column.name, column)
  const declaredNames = new Set(spec.columns.map((column) => column.name))

  const missingColumns: string[] = []
  const typeChanged: TableDiff['typeChanged'][number][] = []
  const notNullChanged: TableDiff['notNullChanged'][number][] = []

  for (const column of spec.columns) {
    assertSqlName(column.name, '列')
    const found = actual.get(column.name)
    if (found === undefined) {
      missingColumns.push(column.name)
      continue
    }
    if (normalizeType(found.type) !== normalizeType(column.type)) {
      typeChanged.push({ column: column.name, from: found.type, to: column.type })
    }
    // 陷阱一：主键列在元数据里报 notnull=0，不参与比对。
    if (!column.primaryKey && !found.primaryKey) {
      const declaredNotNull = column.notNull === true
      if (declaredNotNull !== found.notNull) {
        notNullChanged.push({
          column: column.name,
          from: found.notNull ? 'NOT NULL' : 'NULL',
          to: declaredNotNull ? 'NOT NULL' : 'NULL',
        })
      }
    }
  }

  const extraColumns = shape.columns
    .map((column) => column.name)
    .filter((name) => !declaredNames.has(name))

  const primaryKeyActual = shape.columns
    .filter((column) => column.primaryKey)
    .sort((a, b) => a.primaryKeyIndex - b.primaryKeyIndex)
    .map((column) => column.name)
  const primaryKeyDeclared = spec.columns.filter((column) => column.primaryKey === true).map((column) => column.name)
  const primaryKeyChanged =
    primaryKeyActual.length !== primaryKeyDeclared.length ||
    primaryKeyActual.some((name, index) => name !== primaryKeyDeclared[index])

  const existingIndexes = new Set(shape.indexes.map((index) => index.name))
  const missingIndexes = (spec.indexes ?? [])
    .map((index) => index.name)
    .filter((name) => !existingIndexes.has(name))

  const needsRebuild = typeChanged.length > 0 || notNullChanged.length > 0 || primaryKeyChanged
  const additiveOnly = !needsRebuild && extraColumns.length === 0

  return {
    table: spec.name,
    exists: shape.exists,
    missingColumns,
    extraColumns,
    typeChanged,
    notNullChanged,
    primaryKeyActual,
    primaryKeyDeclared,
    primaryKeyChanged,
    missingIndexes,
    additiveOnly,
    needsRebuild,
  }
}

/**
 * 把差异压成一行人话，用于日志与历史。
 * @param diff 差异。
 */
export function describeDiff(diff: TableDiff): string {
  if (!diff.exists) return `${diff.table}：表不存在`
  const parts: string[] = []
  if (diff.missingColumns.length > 0) parts.push(`缺列 ${diff.missingColumns.join('/')}`)
  if (diff.extraColumns.length > 0) parts.push(`多列 ${diff.extraColumns.join('/')}`)
  if (diff.typeChanged.length > 0)
    parts.push(`类型不符 ${diff.typeChanged.map((item) => `${item.column}:${item.from}→${item.to}`).join('/')}`)
  if (diff.notNullChanged.length > 0)
    parts.push(`非空不符 ${diff.notNullChanged.map((item) => item.column).join('/')}`)
  if (diff.primaryKeyChanged) parts.push(`主键不符（库里 ${diff.primaryKeyActual.join(',') || '无'}）`)
  if (diff.missingIndexes.length > 0) parts.push(`缺索引 ${diff.missingIndexes.join('/')}`)
  return parts.length === 0 ? `${diff.table}：一致` : `${diff.table}：${parts.join('；')}`
}
