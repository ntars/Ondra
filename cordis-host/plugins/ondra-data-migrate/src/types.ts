/**
 * O-008 `ondra-data-migrate` 的对外契约：**版本迁移与表重建**。
 *
 * 定位：L1 存储层里「表结构会变」的那半边。O-006 只做「缺什么补什么」——
 * 补列、补索引，不碰类型，也不碰主键，遇到 `ALTER TABLE` 做不到的事就记一条
 * `primary-key-skipped` 然后跳过。**那条缺口就是本插件存在的理由。**
 *
 * 三条设计取向（都有代价，写在这里防后人改坏）：
 *
 * 1. **版本真源是 `PRAGMA user_version`，不是历史表。**
 *    `user_version` 是库头里的一个整数，随事务一起提交/回滚，天然与 DDL 原子。
 *    历史表 `meta_migration` 只服务「给人看」与「审计」，**不参与判定**。
 *    两者不一致时以 `user_version` 为准并打 warn——否则一次手工改表就能让
 *    「要不要跑迁移」这件事变成两个答案。
 *
 * 2. **一条迁移 = 一个事务 = 一次版本号自增。** 中途崩掉必然整体回滚，
 *    版本号不会半升，下次启动从头再来。这条保证了「幂等」不是靠迁移作者自觉，
 *    而是靠执行器结构。唯一的例外是 `transactional: false`（`VACUUM` 这类
 *    不许进事务的语句），那种迁移**必须自身幂等**，代价已写进 README。
 *
 * 3. **不允许在迁移里直接拿 `store`。** 迁移上下文只给 `raw` / 结构读取 / 重建，
 *    不给 `store.transaction`——给了就一定会有人套出嵌套事务，
 *    而 SQLite 的嵌套 `BEGIN` 会抛错或静默吃掉内层提交，是最难查的一类故障。
 *
 * 与 O-006 的关系：**只经服务键消费，不 import 它的源码**（§15.5 / §18.5）。
 * 下面所有 `*Like` 类型都是 O-006 `StorePort` / `TableSpec` 的**结构对位镜像**，
 * 形状一变，本文件与消费方的赋值处就会报错。
 */

/** 本插件注册的服务键（连字符，非 `ondra:data-migrate`）。全仓唯一归属。 */
export const DATA_MIGRATE_SERVICE_KEY = 'ondra-data-migrate'

/**
 * 迁移历史表名。**写死，不做配置**：
 * 允许改名等于允许同一个库里出现两份互相矛盾的历史。
 */
export const LEDGER_TABLE = 'meta_migration'

/** 迁移 id 的合法形状，与服务键同一条正则（手册 §8.4）。 */
export const MIGRATION_ID_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 表名 / 列名 / 索引名的合法形状。
 * 与 O-006 的 `IDENT_RE` 同口径：SQL 标识符里连字符永远要加引号，一律禁掉。
 */
export const SQL_NAME_RE = /^[a-z][a-z0-9_]*$/

/** 列类型，与 O-006 的 `ColumnType` 同集合（`STRICT` 表只认这五种）。 */
export type ColumnTypeLike = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'

/** 列声明（O-006 `ColumnSpec` 的对位镜像）。 */
export interface ColumnSpecLike {
  /** 列名。 */
  readonly name: string
  /** 类型。 */
  readonly type: ColumnTypeLike
  /** 是否非空。 */
  readonly notNull?: boolean
  /** 是否主键。 */
  readonly primaryKey?: boolean
  /** 默认值字面量。 */
  readonly default?: string
}

/** 索引声明（O-006 `IndexSpec` 的对位镜像）。 */
export interface IndexSpecLike {
  /** 索引名。 */
  readonly name: string
  /** 参与索引的列。 */
  readonly columns: readonly string[]
  /** 是否唯一。 */
  readonly unique?: boolean
}

/** 表声明（O-006 `TableSpec` 的对位镜像）。 */
export interface TableSpecLike {
  /** 表名。 */
  readonly name: string
  /** 列，顺序即建表顺序。 */
  readonly columns: readonly ColumnSpecLike[]
  /** 索引。 */
  readonly indexes?: readonly IndexSpecLike[]
  /** 是否建 `STRICT` 表，默认 true。 */
  readonly strict?: boolean
}

/** 原始 SQL 面（O-006 `RawSqlFacet` 的对位镜像）。 */
export interface RawSqlFacetLike {
  /** 执行多语句 SQL。 */
  exec(sql: string): void
  /** 执行写语句，参数一律 `?` 占位绑定。 */
  run(sql: string, ...params: readonly (string | number | bigint | null | Uint8Array)[]): {
    readonly changes: number
    readonly lastInsertRowid: number | bigint
  }
  /** 查询多行。 */
  all<T = Record<string, unknown>>(sql: string, ...params: readonly (string | number | bigint | null | Uint8Array)[]): T[]
  /** 查询单行。 */
  get<T = Record<string, unknown>>(sql: string, ...params: readonly (string | number | bigint | null | Uint8Array)[]): T | undefined
}

/** 能力位（O-006 `StoreCaps` 的对位子集）。 */
export interface StoreCapsLike {
  /** 是否支持原始 SQL。**迁移一步也离不开它**：`PRAGMA` 与表重建只有 SQL 能给。 */
  readonly sql: boolean
  /** 事务是否真的能回滚。 */
  readonly transaction: boolean
}

/** 存储端口（O-006 `StorePort` 的对位子集，只取本插件用到的部分）。 */
export interface StoreLike {
  /** 当前状态：只有 `open` 才允许迁移。 */
  readonly state: 'open' | 'degraded' | 'closed'
  /** 能力位。 */
  readonly caps: StoreCapsLike
  /** 原始 SQL 面；`caps.sql === false` 时为 undefined。 */
  readonly raw: RawSqlFacetLike | undefined
  /** 库文件绝对路径；内存后端为 null。 */
  readonly filePath: string | null
  /** 事务；回调抛错则回滚并原样抛出。 */
  transaction<T>(fn: () => T): T
  /** 建表并补缺列/缺索引（幂等）。用于「只增不改」的对齐路径。 */
  ensureTable(spec: TableSpecLike): unknown
}

/** 库里某一列的真实形态（`PRAGMA table_info` 的解读结果）。 */
export interface ColumnInfo {
  /** 列名。 */
  readonly name: string
  /** 库里声明的类型文本（可能是空串：非 `STRICT` 表的无类型列）。 */
  readonly type: string
  /** 是否非空。 */
  readonly notNull: boolean
  /** 默认值原文；无默认值为 null。 */
  readonly defaultValue: string | null
  /** 是否主键成员。 */
  readonly primaryKey: boolean
  /** 主键内的序号（非主键为 0）。复合主键靠它排序，不能靠数组顺序。 */
  readonly primaryKeyIndex: number
  /** 列位置（`cid`）。 */
  readonly position: number
}

/** 库里某个索引的真实形态。 */
export interface IndexInfo {
  /** 索引名。 */
  readonly name: string
  /** 是否唯一。 */
  readonly unique: boolean
  /** 来源：`c` 建表时创建 / `u` 唯一约束 / `pk` 主键。 */
  readonly origin: string
  /** 参与索引的列（按索引内顺序）。 */
  readonly columns: readonly string[]
}

/** 一张表在库里的真实形态。 */
export interface TableShape {
  /** 表名。 */
  readonly table: string
  /** 是否存在。 */
  readonly exists: boolean
  /** 列，按 `cid` 排序。 */
  readonly columns: readonly ColumnInfo[]
  /** 索引（含主键自动索引）。 */
  readonly indexes: readonly IndexInfo[]
}

/** 一处列差异。 */
export interface ColumnChange {
  /** 列名。 */
  readonly column: string
  /** 库里现在的值。 */
  readonly from: string
  /** 声明里要求的值。 */
  readonly to: string
}

/**
 * 声明与现实的差异。
 *
 * 分成三组，因为**处理方式完全不同**：
 * - `missingColumns` / `missingIndexes` → 只增不改，交给 O-006 的 `ensureTable`；
 * - `typeChanged` / `notNullChanged` / `primaryKeyChanged` → 只能重建表；
 * - `extraColumns` → 库里多出来的列，**默认不动**，要删必须显式批准。
 */
export interface TableDiff {
  /** 表名。 */
  readonly table: string
  /** 表是否存在。 */
  readonly exists: boolean
  /** 库里缺的列。 */
  readonly missingColumns: readonly string[]
  /** 库里多出来的列（声明里没有）。 */
  readonly extraColumns: readonly string[]
  /** 类型不一致的列。 */
  readonly typeChanged: readonly ColumnChange[]
  /** 非空约束不一致的列。 */
  readonly notNullChanged: readonly ColumnChange[]
  /** 库里的主键列（按主键序号）。 */
  readonly primaryKeyActual: readonly string[]
  /** 声明里的主键列（按声明顺序）。 */
  readonly primaryKeyDeclared: readonly string[]
  /** 主键是否不一致（列不同、或顺序不同都算）。 */
  readonly primaryKeyChanged: boolean
  /** 库里缺的索引名。 */
  readonly missingIndexes: readonly string[]
  /** 只有「加列/加索引」，没有需要重建的项。 */
  readonly additiveOnly: boolean
  /** 必须重建表才能对齐。 */
  readonly needsRebuild: boolean
}

/** 重建表的结果。 */
export interface RebuildResult {
  /** 表名。 */
  readonly table: string
  /** 搬过去的行数。 */
  readonly copiedRows: number
  /** 本次补上的列。 */
  readonly addedColumns: readonly string[]
  /** 本次丢掉的列——**每一条都是调用方显式批准过的**。 */
  readonly droppedColumns: readonly string[]
  /** 本次重建出来的索引。 */
  readonly createdIndexes: readonly string[]
  /** 重建后 `PRAGMA foreign_key_check` 报出的违规行数（0 才算过）。 */
  readonly foreignKeyViolations: number
}

/** 重建选项。 */
export interface RebuildOptions {
  /**
   * 批准丢弃的列。`extraColumns` 里没被批准的列会让重建**直接拒绝**，
   * 而不是「先丢了再说」——丢列是不可逆的数据损失。
   */
  readonly dropColumns?: readonly string[]
  /** 重建后是否跑 `PRAGMA foreign_key_check`，默认 true。 */
  readonly checkForeignKeys?: boolean
}

/** 只增不改的对齐结果。 */
export interface AlignResult {
  /** 表名。 */
  readonly table: string
  /** 走的是哪条路径。 */
  readonly mode: 'noop' | 'additive' | 'rebuild'
  /** 差异详情，永远给出，便于排查。 */
  readonly diff: TableDiff
  /** 重建结果（`mode === 'rebuild'` 时存在）。 */
  readonly rebuild: RebuildResult | undefined
}

/** 迁移上下文。**刻意不含 `store`**：不给嵌套事务留口子。 */
export interface MigrationContext {
  /** 本迁移执行前的版本号。 */
  readonly version: number
  /** 本迁移的目标版本号。 */
  readonly toVersion: number
  /** 原始 SQL 面。 */
  readonly raw: RawSqlFacetLike
  /** 读一张表的真实形态。 */
  inspect(table: string): TableShape
  /** 比对声明与现实。 */
  diff(spec: TableSpecLike): TableDiff
  /**
   * 重建表。**必须在迁移事务内调用**（执行器已保证 `rebuild: true` 的迁移有事务）。
   * @param spec 目标表声明。
   * @param options 重建选项。
   */
  rebuild(spec: TableSpecLike, options?: RebuildOptions): RebuildResult
  /**
   * 对齐表：只增不改交给 `ensureTable`，需要重建时**抛错**而不是偷偷重建。
   * 想重建请显式调 `rebuild()`——重建会丢列，不能藏在 `align()` 后面。
   * @param spec 目标表声明。
   */
  align(spec: TableSpecLike): AlignResult
  /** 日志。 */
  readonly log: MigrationLog
}

/** 日志门面（结构对位，不引 Cordis 的 Logger 类型）。 */
export interface MigrationLog {
  /** 普通信息。 */
  info(message: string, ...args: unknown[]): void
  /** 告警。 */
  warn(message: string, ...args: unknown[]): void
  /** 错误。 */
  error(message: string, ...args: unknown[]): void
}

/** 一条迁移。 */
export interface Migration {
  /** 稳定标识，写进历史表。**发布后不许改名**，改名等于历史对不上。 */
  readonly id: string
  /** 目标版本号，正整数、全仓唯一、严格递增。 */
  readonly toVersion: number
  /** 一句话中文说明，直接进历史表给人看。 */
  readonly description: string
  /**
   * 是否包事务，默认 true。
   * 只有 `VACUUM` 这类**不许在事务内执行**的语句才置 false；
   * 置 false 之后版本号只能事后单独写，**该迁移必须自身幂等**。
   */
  readonly transactional?: boolean
  /**
   * 这条迁移会重建表。执行器会在事务外先关外键、事务内跑完再开回来，
   * 并在提交前跑 `foreign_key_check`。**不要自己开关外键**——
   * `PRAGMA foreign_keys` 在事务内是静默无效的，自己开等于没开。
   */
  readonly rebuild?: boolean
  /** 执行体。 */
  readonly up: (context: MigrationContext) => void
}

/** 迁移问题码。 */
export type MigrationIssueCode =
  | 'sql-unsupported'
  | 'no-transaction'
  | 'store-not-open'
  | 'invalid-identifier'
  | 'duplicate-version'
  | 'duplicate-id'
  | 'stale-migration'
  | 'version-regression'
  | 'reentrant'
  | 'hook-aborted'
  | 'migration-failed'
  | 'ledger-unreadable'

/** 一条迁移问题。**全部都要能被界面读到**，不许只写日志。 */
export interface MigrationIssue {
  /** 问题码。 */
  readonly code: MigrationIssueCode
  /** 相关迁移 id（若适用）。 */
  readonly migrationId: string | undefined
  /** 中文说明，直接给人看。 */
  readonly detail: string
}

/** 一条历史记录（`meta_migration` 的一行）。 */
export interface MigrationRecord {
  /** 版本号。 */
  readonly version: number
  /** 迁移 id。 */
  readonly id: string
  /** 说明。 */
  readonly description: string
  /** 应用时间（毫秒时间戳）。 */
  readonly appliedAtMs: number
  /** 耗时（毫秒）。 */
  readonly durationMs: number
  /** 是否走了重建路径。 */
  readonly rebuild: boolean
}

/** 一次 `ensure()` 的结果。 */
export interface MigrationReport {
  /** 本次是否真的具备迁移能力。false 时 `issues` 必有一条说明原因。 */
  readonly available: boolean
  /** 执行前版本。 */
  readonly fromVersion: number
  /** 执行后版本。 */
  readonly toVersion: number
  /** 本次跑过的迁移 id，按执行顺序。 */
  readonly applied: readonly string[]
  /** 本次没跑但已登记的迁移 id（版本已覆盖）。 */
  readonly skipped: readonly string[]
  /** 出问题的项。非空即代表**没有全部做成**。 */
  readonly issues: readonly MigrationIssue[]
  /** 耗时（毫秒）。 */
  readonly durationMs: number
}

/** 迁移前钩子的入参。 */
export interface MigrationHookInput {
  /** 当前版本。 */
  readonly fromVersion: number
  /** 将要到达的版本。 */
  readonly toVersion: number
  /** 将要执行的迁移 id。 */
  readonly pending: readonly string[]
}

/**
 * 迁移前钩子。
 * 返回值给字符串 = **中止本次迁移**（例如备份失败）。
 * 抛错也按中止处理，但会记 issue——返回值是「预期内的拒绝」，抛错是「意外」。
 */
export type MigrationHook = (input: MigrationHookInput) => string | void

/** 运行期统计。 */
export interface MigrationStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因（可用时为 null）。 */
  readonly unavailableReason: string | null
  /** 当前版本（来自 `user_version`）。 */
  readonly version: number
  /** 已登记迁移里的最高版本。 */
  readonly latestVersion: number
  /** 已登记条数。 */
  readonly registered: number
  /** 未执行条数。 */
  readonly pending: number
  /** 历史表行数；关掉 `recordHistory` 或表不可读时为 null。 */
  readonly historyRows: number | null
  /** 最近一次报告。 */
  readonly lastReport: MigrationReport | null
  /** 库文件路径。 */
  readonly filePath: string | null
}

/** 迁移服务。注册到 `ondra-data-migrate` 键上。 */
export interface MigrationService {
  /** 是否可用（`caps.sql` 且库处于 open）。 */
  readonly available: boolean
  /** 当前版本。 */
  readonly version: number
  /** 待执行条数。 */
  readonly pending: number
  /**
   * 登记一条迁移。**登记完请立刻调一次 `ensure()`**——
   * 本插件不装定时器、不等启动收尾，谁登记谁负责触发，这样执行时机是确定的。
   * @param migration 迁移。
   */
  register(migration: Migration): void
  /** 批量登记。 */
  registerAll(migrations: readonly Migration[]): void
  /**
   * 幂等执行：只跑版本号大于当前值的迁移。
   *
   * 重复调用安全。**失败语义**：某一条失败后，本次调用立即停止，不跑后面的
   * （后面的可能依赖它）；下一次 `ensure()` 会重试那条失败的迁移，
   * 因为撞锁（`SQLITE_BUSY`）这类瞬时错误重试一次就好了，
   * 永久封死会让整个进程再也升不了版本。
   * @param options 目标版本上限（用于「只升到 N」的灰度场景）。
   */
  ensure(options?: { readonly to?: number }): MigrationReport
  /** 读历史表。 */
  history(): readonly MigrationRecord[]
  /**
   * 登记迁移前钩子（例如 O-009 的快照）。
   * @returns 撤销函数。
   */
  onBeforeApply(hook: MigrationHook): () => void
  /** 运行期统计。 */
  stats(): MigrationStats
}

/** 错误码。 */
export type MigrateErrorCode =
  | 'invalid-identifier'
  | 'invalid-version'
  | 'duplicate-version'
  | 'duplicate-id'
  | 'no-raw'
  | 'rebuild-required'
  | 'drop-not-approved'
  | 'not-null-without-default'
  | 'primary-key-not-nullable'
  | 'foreign-key-violation'
  | 'bad-argument'

/** 迁移错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class MigrateError extends Error {
  /** 错误码。 */
  readonly code: MigrateErrorCode
  /** 补充说明。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: MigrateErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'MigrateError'
    this.code = code
    this.detail = detail
  }
}
