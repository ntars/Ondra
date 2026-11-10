/**
 * 表重建：O-006 留下的那条缺口。
 *
 * O-006 的 `ensureTable` 只能「加列、加索引」。遇到**类型改错**、**主键要换**、
 * **非空约束要改**，`ALTER TABLE` 一律做不到，它只能记一条 `primary-key-skipped`
 * 然后跳过——数据还在，但结构永远是错的，而且没人知道。这个文件就是补这个口子。
 *
 * 用的是 SQLite 官方推荐的重建流程（「ALTER TABLE 做不到时的十二步」）的收敛版：
 *
 * ```
 * 关外键(事务外) → 建新表(临时名) → 复制数据 → 删旧表 → 改名 → 重建索引
 * → foreign_key_check(提交前) → 提交 → 开外键
 * ```
 *
 * 三个必须守住的细节：
 *
 * 1. **`PRAGMA foreign_keys` 必须在事务外开**。它在事务内是**静默无效**的：
 *    语句不报错，但外键照旧开着，于是 `DROP TABLE` 会级联删数据或直接失败。
 *    「自己以为自己关了」是这类事故的唯一成因，所以开关只在这一个文件里做。
 *
 * 2. **丢列必须显式批准**。`extraColumns` 里没出现在 `dropColumns` 的列会让重建
 *    直接抛错。丢列不可逆，不能藏在「顺手对齐一下」的调用里。
 *
 * 3. **新列若非空且无默认值，重建必然失败**，所以在建表之前就拦下来，
 *    给出「要么给默认值、要么改成可空」的可操作提示，而不是让用户看到一句
 *    `NOT NULL constraint failed`。
 */

import { assertSqlName, diffTable, inspectTable } from './inspect.js'
import { MigrateError } from './types.js'
import type {
  ColumnSpecLike,
  RawSqlFacetLike,
  RebuildOptions,
  RebuildResult,
  StoreLike,
  TableDiff,
  TableSpecLike,
} from './types.js'

/**
 * 默认值只接受字面量。
 *
 * 与 O-006 同口径：`NULL` / `CURRENT_TIMESTAMP` / 数字 / 单引号字符串。
 * 收任意 SQL 片段等于把注入面开到建表语句里——建表语句拼的是表名，
 * 一旦有人塞 `0); DROP TABLE ...`，整库就没了。
 */
const DEFAULT_LITERAL_RE =
  /^(?:NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|'(?:[^']|'')*')$/i

/**
 * 渲染一列的建表片段。
 * @param column 列声明。
 * @param tableLevelPrimaryKey 是否把主键提到表级（复合主键必须这样写）。
 */
function renderColumn(column: ColumnSpecLike, tableLevelPrimaryKey: boolean): string {
  assertSqlName(column.name, '列')
  const parts: string[] = [`"${column.name}"`, column.type]
  if (column.primaryKey === true && !tableLevelPrimaryKey) parts.push('PRIMARY KEY')
  if (column.notNull === true && column.primaryKey !== true) parts.push('NOT NULL')
  if (column.default !== undefined) {
    if (!DEFAULT_LITERAL_RE.test(column.default)) {
      throw new MigrateError(
        'bad-argument',
        `列 "${column.name}" 的默认值 "${column.default}" 不是字面量：只接受 NULL / CURRENT_TIMESTAMP / 数字 / 单引号字符串`,
      )
    }
    parts.push(`DEFAULT ${column.default}`)
  }
  return parts.join(' ')
}

/**
 * 拼建表语句。
 * @param spec 表声明。
 * @param name 实际写进 SQL 的表名（可能是临时名）。
 */
export function buildCreateTable(spec: TableSpecLike, name: string): string {
  const primaryKeys = spec.columns.filter((column) => column.primaryKey === true)
  // 单列主键写在列上（`INTEGER PRIMARY KEY` 才是 rowid 别名，行为差异很大）；
  // 复合主键只能写表级，否则会被解析成「每个列各自是主键」。
  const tableLevel = primaryKeys.length > 1
  const definitions = spec.columns.map((column) => renderColumn(column, tableLevel))
  if (tableLevel) {
    definitions.push(`PRIMARY KEY (${primaryKeys.map((column) => `"${column.name}"`).join(', ')})`)
  }
  const strict = spec.strict === false ? '' : ' STRICT'
  return `CREATE TABLE "${name}" (${definitions.join(', ')})${strict}`
}

/**
 * 找一个不冲突的临时表名。**不用固定名字**：万一用户真有一张同名表，
 * 「先删掉再建」会把他那张表的数据一起删了。
 * @param raw 原始 SQL 面。
 * @param table 目标表名。
 */
function pickTempName(raw: RawSqlFacetLike, table: string): string {
  for (let index = 1; index <= 5; index += 1) {
    const candidate = `${table}__migrate${index}`
    const taken = raw.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      candidate,
    )
    if (taken === undefined) return candidate
  }
  throw new MigrateError('bad-argument', `找不到可用的临时表名（${table}__migrate1..5 都被占用）`)
}

/**
 * 按声明建索引，返回建了哪些。
 *
 * **表达式索引不重建**：`PRAGMA index_info` 对表达式列返回 `null`，
 * 拿不到原始表达式文本，硬写只会建出一个错的索引。
 * 带表达式索引的表重建后需要手工补——写进 README「已知限制」。
 * @param raw 原始 SQL 面。
 * @param spec 表声明（索引取自它的 `indexes`）。
 */
function createIndexes(raw: RawSqlFacetLike, spec: TableSpecLike): string[] {
  const created: string[] = []
  for (const index of spec.indexes ?? []) {
    assertSqlName(index.name, '索引')
    const columns = index.columns.map((name) => `"${name}"`).join(', ')
    const unique = index.unique === true ? 'UNIQUE ' : ''
    raw.exec(`CREATE ${unique}INDEX IF NOT EXISTS "${index.name}" ON "${spec.name}" (${columns})`)
    created.push(index.name)
  }
  return created
}

/**
 * 重建一张表。**必须在事务内调用**，且调用前外键已关。
 * @param raw 原始 SQL 面。
 * @param spec 目标结构。
 * @param diff 已算好的差异。
 * @param options 重建选项。
 * @returns 重建结果。
 */
export function rebuildTable(
  raw: RawSqlFacetLike,
  spec: TableSpecLike,
  diff: TableDiff,
  options: RebuildOptions = {},
): RebuildResult {
  assertSqlName(spec.name, '表')
  const checkForeignKeys = options.checkForeignKeys !== false

  // 1. 丢列必须先批准。
  const approved = new Set(options.dropColumns ?? [])
  const unapproved = diff.extraColumns.filter((name) => !approved.has(name))
  if (unapproved.length > 0) {
    throw new MigrateError(
      'drop-not-approved',
      `表 "${spec.name}" 里有多余列 ${unapproved.join('、')}，重建会丢数据；` +
        '要删请把它们放进 rebuild 的 dropColumns 里显式批准',
    )
  }

  // 2. 表根本不存在：直接建，没有「复制」这一步。
  //    走这条而不是抛错，是因为「重建」在首次初始化时被调用是很自然的写法，
  //    让它自己去判断「有没有东西可搬」比让每个调用方先写一遍 if 更不容易漏。
  if (!diff.exists) {
    raw.exec(buildCreateTable(spec, spec.name))
    return {
      table: spec.name,
      copiedRows: 0,
      addedColumns: spec.columns.map((column) => column.name),
      droppedColumns: [],
      createdIndexes: createIndexes(raw, spec),
      foreignKeyViolations: 0,
    }
  }

  // 3. 新列若非空且无默认值，复制阶段必然失败，提前拦。
  for (const column of spec.columns) {
    if (diff.missingColumns.includes(column.name) && column.notNull === true && column.default === undefined) {
      throw new MigrateError(
        'not-null-without-default',
        `表 "${spec.name}" 的新列 "${column.name}" 是非空且无默认值，旧行无法满足；` +
          '请给它一个默认值，或先建成可空列再在迁移里回填',
      )
    }
  }

  // 4. 建新表（临时名）。
  const tempName = pickTempName(raw, spec.name)
  raw.exec(buildCreateTable(spec, tempName))

  // 5. 复制数据：只搬「新旧都有的列」。新列由默认值或 NULL 填，丢掉的列自然消失。
  const copyColumns = spec.columns.map((column) => column.name).filter((name) => !diff.missingColumns.includes(name))
  if (copyColumns.length === 0) {
    throw new MigrateError(
      'bad-argument',
      `表 "${spec.name}" 的目标结构里没有一个列能与旧表对上，拒绝重建（那等于清空数据）`,
    )
  }
  const columnList = copyColumns.map((name) => `"${name}"`).join(', ')
  raw.exec(`INSERT INTO "${tempName}" (${columnList}) SELECT ${columnList} FROM "${spec.name}"`)

  // 6. 删旧表、改名。
  raw.exec(`DROP TABLE "${spec.name}"`)
  raw.exec(`ALTER TABLE "${tempName}" RENAME TO "${spec.name}"`)

  // 7. 重建索引。
  const createdIndexes = createIndexes(raw, spec)

  // 8. 提交前查外键。这项检查必须在事务内、提交前做：
  //    提交后再查，坏数据已经落盘，只能回滚到上一个快照。
  let violations = 0
  if (checkForeignKeys) {
    violations = raw.all<Record<string, unknown>>('PRAGMA foreign_key_check').length
    if (violations > 0) {
      throw new MigrateError(
        'foreign-key-violation',
        `表 "${spec.name}" 重建后外键检查发现 ${violations} 条违规，已回滚；` +
          '通常是丢列时连带删掉了被引用的键，请把那一列加回 dropColumns 之外的保留列',
      )
    }
  }

  const counted = raw.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${spec.name}"`)
  return {
    table: spec.name,
    copiedRows: counted?.n ?? 0,
    addedColumns: diff.missingColumns,
    droppedColumns: diff.extraColumns,
    createdIndexes,
    foreignKeyViolations: violations,
  }
}

/**
 * 在「外键已关 + 事务已开」的包裹里执行动作。
 *
 * **整个仓库只有这里开关 `PRAGMA foreign_keys`**。别处再写一遍，就会出现
 * 「一个关了另一个又开回来」的竞态，而且事务内的开关是静默无效的，查不出来。
 * @param store 存储端口。
 * @param fn 动作；抛错则回滚。
 * @param checkForeignKeys 是否在提交前跑外键检查。
 * @returns 动作的返回值。
 */
export function withRebuildWrap<T>(
  store: StoreLike,
  fn: () => T,
  checkForeignKeys = true,
): T {
  const raw = store.raw
  if (raw === undefined) {
    throw new MigrateError('no-raw', '当前存储后端没有原始 SQL 面（caps.sql=false），无法重建表')
  }
  const before = raw.get<{ foreign_keys: number }>('PRAGMA foreign_keys')
  const wasOn = (before?.foreign_keys ?? 0) === 1
  // 必须在 BEGIN 之前关：事务内的 PRAGMA foreign_keys 不生效且不报错。
  raw.exec('PRAGMA foreign_keys = OFF')
  try {
    return store.transaction(() => {
      const value = fn()
      if (checkForeignKeys) {
        const violations = raw.all<Record<string, unknown>>('PRAGMA foreign_key_check').length
        if (violations > 0) {
          throw new MigrateError(
            'foreign-key-violation',
            `重建后外键检查发现 ${violations} 条违规，已回滚`,
          )
        }
      }
      return value
    })
  } finally {
    // 无论成功、失败、抛错，连接的外键开关都要还原成进来时的样子。
    //
    // 这里**吞掉还原失败的异常**：还原失败说明连接已经降级（O-006 会把它标成
    // `degraded` 并拒绝后续使用），此时抛出只会把「真正的原因」盖成
    // 「还原 PRAGMA 失败」，反而更难查。
    try {
      raw.exec(`PRAGMA foreign_keys = ${wasOn ? 'ON' : 'OFF'}`)
    } catch {
      // 交给上层：真正有价值的错误已经在上面的 try 里抛出去了。
    }
  }
}

/**
 * 对齐一张表：只增不改走 `ensureTable`，需要重建就**抛错**。
 * 重建会丢列，不能藏在 `align()` 后面——想重建请显式调 `rebuild()`。
 * @param store 存储端口。
 * @param spec 目标结构。
 */
export function alignTable(
  store: StoreLike,
  spec: TableSpecLike,
): { mode: 'noop' | 'additive' | 'rebuild'; diff: TableDiff } {
  const raw = store.raw
  if (raw === undefined) {
    throw new MigrateError('no-raw', '当前存储后端没有原始 SQL 面（caps.sql=false），无法对齐表结构')
  }
  const shape = inspectTable(raw, spec.name)
  const diff = diffTable(shape, spec)
  if (!shape.exists) {
    store.ensureTable(spec)
    return { mode: 'additive', diff }
  }
  if (diff.needsRebuild) {
    throw new MigrateError(
      'rebuild-required',
      `表 "${spec.name}" 需要重建才能对齐（类型/主键/非空约束不一致），请显式调用 rebuild()`,
    )
  }
  if (diff.missingColumns.length > 0 || diff.missingIndexes.length > 0) {
    store.ensureTable(spec)
    return { mode: 'additive', diff }
  }
  return { mode: 'noop', diff }
}
