/**
 * O-007 `ondra-store-memory` 的对外契约。
 *
 * 这是 O-006 `src/types.ts` 里 `StorePort` 的**结构对位镜像**。
 *
 * 为什么不 `import type { StorePort } from '../ondra-store-sqlite/src/types.js'`：
 * §15.5 / §18.5 明令禁止同轮两个插件互相 import——任一单独卸载都会让另一个编译失败。
 * 所以契约靠**结构对位**：消费方拿到的两个对象要赋给同一个变量
 * （`const store = ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')`），
 * 形状一旦分叉，那一行赋值立刻报类型错，不会静默跑歪。
 *
 * 维护纪律：**改动本文件必须同步改 O-006 的 `src/types.ts`**，两边字段名、可选性、顺序都要一致。
 * 唯一的允许差异是 `StoreProvider` 的取值与本插件自己的服务键常量。
 */

/** 本插件注册的服务键（连字符，非 `ondra:store-memory`）。全仓唯一归属。 */
export const STORE_MEMORY_SERVICE_KEY = 'ondra-store-memory'

/** 后端标识。 */
export type StoreProvider = 'sqlite' | 'memory'

/** 端口状态。内存后端没有 `degraded`——它不需要回滚，也没有连接会坏。 */
export type StoreState = 'open' | 'degraded' | 'closed'

/** 能力位。内存后端 `sql=false`、`fts=false`、`persist=false`、`transaction=false`。 */
export interface StoreCaps {
  /** 是否支持原始 SQL。内存后端恒为 false。 */
  readonly sql: boolean
  /** 是否支持 FTS5。内存后端恒为 false。 */
  readonly fts: boolean
  /** 是否持久化。内存后端恒为 false。 */
  readonly persist: boolean
  /** 事务是否具备回滚语义。内存后端恒为 false（只保证异常不被吞掉）。 */
  readonly transaction: boolean
}

/** SQLite 可绑定的值。内存后端接受同一集合，并对 `boolean` 做同样的 0/1 归一化。 */
export type SqlValue = null | number | bigint | string | Uint8Array

/** 一行数据。 */
export type Row = Record<string, unknown>

/** 列类型。与 O-006 保持同一枚举（内存后端只做展示与类型提示，不做强制转换）。 */
export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'

/** 列声明。 */
export interface ColumnSpec {
  /** 列名，必须匹配 `^[a-z][a-z0-9_]*$`。 */
  readonly name: string
  /** 类型。 */
  readonly type: ColumnType
  /** 是否非空。内存后端会**真的**按它拒绝 null 写入。 */
  readonly notNull?: boolean
  /** 是否主键。 */
  readonly primaryKey?: boolean
  /** 默认值（内存后端只在插入缺列时用它填）。 */
  readonly default?: string
}

/** 索引声明。内存后端**不建索引**，只把名字记下来用于 `EnsureResult`。 */
export interface IndexSpec {
  /** 索引名。 */
  readonly name: string
  /** 列。 */
  readonly columns: readonly string[]
  /** 是否唯一（内存后端不强制）。 */
  readonly unique?: boolean
}

/** 表声明。 */
export interface TableSpec {
  /** 表名，必须匹配 `^[a-z][a-z0-9_]*$`。 */
  readonly name: string
  /** 列。 */
  readonly columns: readonly ColumnSpec[]
  /** 索引（内存后端不建，只记录）。 */
  readonly indexes?: readonly IndexSpec[]
  /** 是否 `STRICT`（内存后端忽略）。 */
  readonly strict?: boolean
}

/** 建表/补列时的问题。内存后端只可能产出 `not-null-without-default`。 */
export interface StoreIssue {
  /** 问题码。 */
  readonly code:
    | 'not-null-without-default'
    | 'primary-key-skipped'
    | 'strict-unavailable'
    | 'tighten-skipped'
    | 'index-skipped'
  /** 表。 */
  readonly table: string
  /** 列（若适用）。 */
  readonly column?: string
  /** 中文说明。 */
  readonly detail: string
}

/** `ensureTable()` 的结果。 */
export interface EnsureResult {
  /** 表名。 */
  readonly table: string
  /** 是否新建。 */
  readonly created: boolean
  /** 补上的列。 */
  readonly addedColumns: readonly string[]
  /** 建了的索引名（内存后端只登记名字）。 */
  readonly createdIndexes: readonly string[]
  /** 问题。 */
  readonly issues: readonly StoreIssue[]
}

/** 过滤算子。 */
export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'is-null' | 'not-null'

/** 过滤条件。 */
export interface Filter {
  /** 列名。 */
  readonly column: string
  /** 算子。 */
  readonly op: FilterOp
  /** 值。 */
  readonly value?: unknown
}

/** 排序规则。 */
export interface SortRule {
  /** 列名。 */
  readonly column: string
  /** 方向。 */
  readonly direction?: 'asc' | 'desc'
}

/** 查询条件。 */
export interface SelectQuery {
  /** 过滤。 */
  readonly where?: readonly Filter[]
  /** 排序。 */
  readonly orderBy?: readonly SortRule[]
  /** 上限。 */
  readonly limit?: number
  /** 跳过。 */
  readonly offset?: number
}

/** 写语句结果。内存后端 `lastInsertRowid` 恒为 0（没有 rowid 概念）。 */
export interface RunResult {
  /** 受影响行数。 */
  readonly changes: number
  /** 恒为 0。 */
  readonly lastInsertRowid: number | bigint
}

/** 运行期统计。 */
export interface StoreStats {
  /** 后端标识，恒为 `memory`。 */
  readonly provider: StoreProvider
  /** 状态。 */
  readonly state: StoreState
  /** 恒为 null。 */
  readonly filePath: string | null
  /** 恒为 null。 */
  readonly displayPath: string | null
  /** 恒为 null。 */
  readonly journalMode: string | null
  /** 恒为 false。 */
  readonly foreignKeys: boolean
  /** 恒为 null。 */
  readonly synchronous: string | null
  /** 恒为 0。 */
  readonly busyTimeoutMs: number
  /** 内存中的表数量。 */
  readonly tableCount: number
  /** 恒为 null。 */
  readonly sizeBytes: number | null
  /** 创建时间戳。 */
  readonly openedAtMs: number
  /** 已执行操作次数。 */
  readonly statements: number
  /** 事务次数。 */
  readonly transactions: number
  /** 失败次数。 */
  readonly failures: number
  /** 恒为 true——用内存后端本身就是降级。 */
  readonly degraded: boolean
}

/** 原始 SQL 面。内存后端**恒为 undefined**（`caps.sql === false`）。 */
export interface RawSqlFacet {
  /** 执行多语句。 */
  exec(sql: string): void
  /** 写语句。 */
  run(sql: string, ...params: SqlValue[]): RunResult
  /** 查询多行。 */
  all<T = Row>(sql: string, ...params: SqlValue[]): T[]
  /** 查询单行。 */
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined
}

/** 存储端口。与 O-006 的 `StorePort` 逐字段一致。 */
export interface StorePort {
  /** 后端标识。 */
  readonly provider: StoreProvider
  /** 状态。 */
  readonly state: StoreState
  /** 能力位。 */
  readonly caps: StoreCaps
  /** 恒为 null。 */
  readonly filePath: string | null
  /** 恒为 undefined。 */
  readonly raw: RawSqlFacet | undefined

  /** 确保表存在并补列。 */
  ensureTable(spec: TableSpec): EnsureResult
  /** 表是否存在。 */
  tableExists(table: string): boolean

  /** 插入一行。 */
  insert(table: string, row: Row): void
  /** 按主键 upsert。 */
  upsert(table: string, row: Row): void
  /** 按主键更新。 */
  update(table: string, key: Row, patch: Row): number
  /** 按主键删除。 */
  delete(table: string, key: Row): number
  /** 按主键取行。 */
  get(table: string, key: Row): Row | undefined
  /** 条件查询。 */
  select(table: string, query?: SelectQuery): Row[]
  /** 计数。 */
  count(table: string, where?: readonly Filter[]): number

  /** 事务。无回滚语义（见 `caps.transaction`）。 */
  transaction<T>(fn: () => T): T

  /** 统计。 */
  stats(): StoreStats
  /** 关闭。幂等。 */
  close(): void
}

/** 错误码。与 O-006 同集合，便于消费方按码分支而不用分辨后端。 */
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

/** 端口错误。 */
export class StoreError extends Error {
  /** 错误码。 */
  readonly code: StoreErrorCode
  /** 补充说明。 */
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

/** 表名 / 列名 / 索引名的合法形状（与 O-006 同一个正则）。 */
export const IDENT_RE = /^[a-z][a-z0-9_]*$/
