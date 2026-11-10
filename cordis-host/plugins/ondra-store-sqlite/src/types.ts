/**
 * O-006 `ondra-store-sqlite` 的对外契约：**存储端口（StorePort）**。
 *
 * 定位：L1 存储层的唯一 SQL 出口。业务域插件（记忆、人格、情绪）**只声明表结构**，
 * 建库、开 WAL、开外键、补列、收权限、事务与语句缓存全部在这里做一次。
 *
 * 三条设计取向（都有代价，写在这里防后人改坏）：
 *
 * 1. **接口是同步的，不包 Promise。** `node:sqlite` 只提供 `DatabaseSync`；
 *    把本地同步文件操作包成 Promise 不会让它变快，只会让每个消费方被迫 `async`，
 *    并让「抛错」分散成「抛错 + 各自忘记 catch 的 rejection」两种失败形态。
 *
 * 2. **端口是「SQL 优先 + 表级 CRUD 兜底」双面**。SQL 是主面（记忆检索要走 FTS5、
 *    快照要走 `VACUUM INTO`，这些只有 SQL 能给）；表级 CRUD 是给「数据库坏了也要能跑」
 *    的少数场景用的，也让 O-007 内存后端有可实现的共同面。
 *
 * 3. **原始 SQL 面用能力位 `caps.sql` 显式标注，不靠「调了才知道」。**
 *    O-007 内存后端 `caps.sql === false`，消费方必须在**装载期**就分支，
 *    而不是运行到一半收到一个「不支持」异常。
 *
 * 与 O-007 `ondra-store-memory` 的关系（重要）：
 * 两者**实现同一个接口、注册两个不同的服务键**，消费方统一按
 * `ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')` 取用，
 * 且**只取一个、只写一个**——同时写两个后端就是双真源，比没有后端更糟。
 *
 * 本文件刻意不 import O-007 的源码（§15.5 / §18.5 禁止同轮互相 import），
 * 也不 import 任何 `@ondra/*` 包：契约靠「结构对位」，形状一变，消费方赋值处就会报错。
 */

/** 本插件注册的服务键（连字符，非 `ondra:store-sqlite`）。全仓唯一归属。 */
export const STORE_SQLITE_SERVICE_KEY = 'ondra-store-sqlite'

/** 后端标识。两个后端共用同一接口，靠它区分「我现在跑在谁身上」。 */
export type StoreProvider = 'sqlite' | 'memory'

/**
 * 端口状态。
 *
 * - `open`：正常可用；
 * - `degraded`：连接还在，但**回滚失败过**（SQLite 事务状态未知），只允许关库重建；
 * - `closed`：已关闭，任何调用都抛 `closed`。
 */
export type StoreState = 'open' | 'degraded' | 'closed'

/** 能力位。消费方在装载期读它决定走哪条分支，不要在调用期试探。 */
export interface StoreCaps {
  /** 是否支持原始 SQL（`raw` 面是否可用）。 */
  readonly sql: boolean
  /** 是否支持 FTS5 全文索引（已实测探测，不是「文档说有」）。 */
  readonly fts: boolean
  /** 是否持久化（内存后端为 false，进程退出即丢）。 */
  readonly persist: boolean
  /** 事务是否具备回滚语义（内存后端为 false，只保证异常不被吞掉）。 */
  readonly transaction: boolean
}

/**
 * SQLite 可绑定的值。
 *
 * **刻意不含 `boolean`**：SQLite 没有布尔类型，绑 `true` 在部分驱动实现里会直接抛错。
 * 端口在归一化时把 `boolean` 转成 `0 | 1`（两个后端做同样的转换），
 * 除此之外**不做任何隐式编码**——要存对象请调用方自己 `JSON.stringify`。
 */
export type SqlValue = null | number | bigint | string | Uint8Array

/** 一行数据。键必须是已声明的列名。 */
export type Row = Record<string, unknown>

/**
 * 列类型。
 *
 * **刻意不含 `NUMERIC`**：`STRICT` 表只接受 `INT / INTEGER / REAL / TEXT / BLOB / ANY`，
 * 收一个 `NUMERIC` 进来会让「严格表」在建表那一刻直接报错。
 */
export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'

/** 列声明。 */
export interface ColumnSpec {
  /** 列名，必须匹配 `^[a-z][a-z0-9_]*$`。 */
  readonly name: string
  /** 类型。 */
  readonly type: ColumnType
  /** 是否非空。补列时若无默认值会被降级为可空并记 issue（见 `StoreIssue`）。 */
  readonly notNull?: boolean
  /** 是否主键。补列时不支持（SQLite 不允许 `ALTER TABLE ADD COLUMN PRIMARY KEY`）。 */
  readonly primaryKey?: boolean
  /**
   * 默认值，**只接受字面量**：`NULL` / 数字 / `'单引号字符串'` / `CURRENT_TIMESTAMP`。
   * 不接受任意 SQL 片段——那是把注入面开到建表语句里。
   */
  readonly default?: string
}

/** 索引声明。 */
export interface IndexSpec {
  /** 索引名，必须匹配 `^[a-z][a-z0-9_]*$`。 */
  readonly name: string
  /** 参与索引的列，顺序即索引顺序。 */
  readonly columns: readonly string[]
  /** 是否唯一索引。 */
  readonly unique?: boolean
}

/** 表声明。业务域插件用它表达「我要一张什么样的表」。 */
export interface TableSpec {
  /** 表名，必须匹配 `^[a-z][a-z0-9_]*$`。 */
  readonly name: string
  /** 列，顺序即建表顺序。 */
  readonly columns: readonly ColumnSpec[]
  /** 索引，可省略。 */
  readonly indexes?: readonly IndexSpec[]
  /**
   * 是否建 `STRICT` 表（默认 true）。`STRICT` 会拒绝「往 INTEGER 列写 'abc'」这类脏写入，
   * 代价是类型必须落在允许集合内。旧 SQLite 不支持时会自动退回普通表并记 issue。
   */
  readonly strict?: boolean
}

/** 建表/补列过程中发现的、**不致命但必须让人看见**的问题。 */
export interface StoreIssue {
  /** 问题码。 */
  readonly code:
    | 'not-null-without-default'
    | 'primary-key-skipped'
    | 'strict-unavailable'
    | 'tighten-skipped'
    | 'index-skipped'
  /** 出问题的表。 */
  readonly table: string
  /** 出问题的列（若适用）。 */
  readonly column?: string
  /** 中文说明，直接给人看。 */
  readonly detail: string
}

/** `ensureTable()` 的结果：做了什么、没做成什么，一目了然。 */
export interface EnsureResult {
  /** 表名。 */
  readonly table: string
  /** 本次是否新建了表。 */
  readonly created: boolean
  /** 本次补上的列名。 */
  readonly addedColumns: readonly string[]
  /** 本次新建的索引名。 */
  readonly createdIndexes: readonly string[]
  /** 本次发现的问题。 */
  readonly issues: readonly StoreIssue[]
}

/** 过滤算子。`in` 需要数组值；`is-null` / `not-null` 不需要值。 */
export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'is-null' | 'not-null'

/** 一个过滤条件。 */
export interface Filter {
  /** 列名，必须是已声明的列。 */
  readonly column: string
  /** 算子。 */
  readonly op: FilterOp
  /** 值；`is-null` / `not-null` 省略。 */
  readonly value?: unknown
}

/** 排序规则。 */
export interface SortRule {
  /** 列名。 */
  readonly column: string
  /** 方向，默认 `asc`。 */
  readonly direction?: 'asc' | 'desc'
}

/** 查询条件（表级 CRUD 面）。 */
export interface SelectQuery {
  /** 过滤条件，多个之间是 `AND`。 */
  readonly where?: readonly Filter[]
  /** 排序。 */
  readonly orderBy?: readonly SortRule[]
  /** 最大返回条数。 */
  readonly limit?: number
  /** 跳过条数，需配合 `limit` 或单独使用（SQLite 的 `OFFSET` 必须跟 `LIMIT`）。 */
  readonly offset?: number
}

/** 写语句的结果。 */
export interface RunResult {
  /** 受影响行数。 */
  readonly changes: number
  /** 最后插入的 rowid（无则为 0）。 */
  readonly lastInsertRowid: number | bigint
}

/** 运行期统计，供体检面板与 `ondra-startup-check` 读取。 */
export interface StoreStats {
  /** 后端标识。 */
  readonly provider: StoreProvider
  /** 当前状态。 */
  readonly state: StoreState
  /** 数据库文件绝对路径；内存后端为 null。 */
  readonly filePath: string | null
  /** 用户可见写法（如 `~/.ondra/user/ondra.db`），绝不把机器绝对路径塞界面。 */
  readonly displayPath: string | null
  /** 实际生效的 journal_mode（**读回的真实值**，不是配置里写的愿望值）。 */
  readonly journalMode: string | null
  /** 外键是否真的开着（读回值）。 */
  readonly foreignKeys: boolean
  /** 同步级别（读回值）。 */
  readonly synchronous: string | null
  /** 忙等超时毫秒。 */
  readonly busyTimeoutMs: number
  /** 库里的用户表数量（不含 `sqlite_*`）。 */
  readonly tableCount: number
  /** 文件字节数；内存后端为 null。 */
  readonly sizeBytes: number | null
  /** 打开时间戳（毫秒）。 */
  readonly openedAtMs: number
  /** 已执行语句条数。 */
  readonly statements: number
  /** 已开启事务次数。 */
  readonly transactions: number
  /** 失败次数（含被捕获的降级）。 */
  readonly failures: number
  /** 是否处于降级态（`degraded` 或内存后端被启用）。 */
  readonly degraded: boolean
}

/**
 * 原始 SQL 面。只有 `caps.sql === true` 时可用。
 *
 * 参数一律走 `?` 占位绑定，**不允许字符串拼接**——拼接就是把注入面交给调用方。
 */
export interface RawSqlFacet {
  /**
   * 执行多语句 SQL（DDL / PRAGMA 用）。
   * @param sql SQL 文本。
   */
  exec(sql: string): void
  /**
   * 执行写语句。
   * @param sql SQL 文本，`?` 占位。
   * @param params 绑定参数。
   */
  run(sql: string, ...params: SqlValue[]): RunResult
  /**
   * 查询多行。
   * @param sql SQL 文本。
   * @param params 绑定参数。
   */
  all<T = Row>(sql: string, ...params: SqlValue[]): T[]
  /**
   * 查询单行。
   * @param sql SQL 文本。
   * @param params 绑定参数。
   */
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined
}

/** 存储端口。两个后端实现同一形状，注册不同服务键。 */
export interface StorePort {
  /** 后端标识。 */
  readonly provider: StoreProvider
  /** 当前状态。 */
  readonly state: StoreState
  /** 能力位。 */
  readonly caps: StoreCaps
  /** 库文件绝对路径；内存后端为 null。 */
  readonly filePath: string | null
  /** 原始 SQL 面；`caps.sql === false` 时为 undefined。 */
  readonly raw: RawSqlFacet | undefined

  /**
   * 确保表存在，并补齐缺失的列与索引（幂等）。
   * @param spec 表声明。
   */
  ensureTable(spec: TableSpec): EnsureResult
  /**
   * 表是否存在。
   * @param table 表名。
   */
  tableExists(table: string): boolean

  /**
   * 插入一行。列名必须是已声明的列。
   * @param table 表名。
   * @param row 行数据。
   */
  insert(table: string, row: Row): void
  /**
   * 按主键插入或更新（`INSERT ... ON CONFLICT DO UPDATE`）。
   * @param table 表名。
   * @param row 行数据，必须含全部主键列。
   */
  upsert(table: string, row: Row): void
  /**
   * 按主键更新。
   * @param table 表名。
   * @param key 主键列与值。
   * @param patch 要改的列与值。
   * @returns 受影响行数。
   */
  update(table: string, key: Row, patch: Row): number
  /**
   * 按主键删除。
   * @param table 表名。
   * @param key 主键列与值。
   * @returns 受影响行数。
   */
  delete(table: string, key: Row): number
  /**
   * 按主键取一行。
   * @param table 表名。
   * @param key 主键列与值。
   */
  get(table: string, key: Row): Row | undefined
  /**
   * 条件查询。
   * @param table 表名。
   * @param query 查询条件，可省略（取前 `limit` 条）。
   */
  select(table: string, query?: SelectQuery): Row[]
  /**
   * 计数。
   * @param table 表名。
   * @param where 过滤条件。
   */
  count(table: string, where?: readonly Filter[]): number

  /**
   * 事务。回调抛错则回滚并原样抛出。
   *
   * **嵌套调用直接抛 `nested-transaction`**：SQLite 不支持嵌套 `BEGIN`，
   * 静默「加入外层事务」会让内层的 `COMMIT` 语义消失，是最难查的一类错。
   * @param fn 事务体。
   */
  transaction<T>(fn: () => T): T

  /** 运行期统计。 */
  stats(): StoreStats
  /** 关闭。幂等。 */
  close(): void
}

/** 错误码。 */
export type StoreErrorCode =
  | 'not-open'
  | 'closed'
  | 'degraded'
  | 'nested-transaction'
  | 'unknown-table'
  | 'unknown-column'
  | 'invalid-identifier'
  | 'unsupported-value'
  | 'unsupported-op'
  | 'bad-argument'
  | 'constraint'
  | 'open-failed'

/** 端口错误。带稳定错误码，消费方可按码分支，不必匹配中文文案。 */
export class StoreError extends Error {
  /** 错误码。 */
  readonly code: StoreErrorCode
  /** 补充说明（表名、列名、原始错误）。 */
  readonly detail: string | undefined

  /**
   * @param code 错误码。
   * @param message 中文说明。
   * @param detail 补充说明。
   */
  constructor(code: StoreErrorCode, message: string, detail?: string) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 表名 / 列名 / 索引名的合法形状。
 *
 * 与上游 `@ntars/ondra-storage` 的 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 对齐，
 * **比服务键的正则更严**：服务键允许连字符，但 SQL 标识符里连字符必须永远加引号，
 * 一旦某处忘了加引号就是语法错。统一禁掉连字符，比事后满仓找引号便宜。
 */
export const IDENT_RE = /^[a-z][a-z0-9_]*$/
