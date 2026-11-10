/**
 * O-121 `ondra-store-json` 的对外契约：**JSONL 持久化后端（StorePort 的第三个实现）**。
 *
 * 这是 O-006 `src/types.ts` 里 `StorePort` 的**结构对位镜像**（写法沿 O-007）。
 *
 * 为什么不 `import type { StorePort } from '../ondra-store-sqlite/src/types.js'`：
 * §15.5 / §18.5 明令禁止跨包 import——任一单独卸载都会让另一个编译失败。
 * 契约靠**结构对位**：消费方拿到的对象要能赋给同一个变量
 * （`ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory') ?? ctx.get('ondra-store-json')`），
 * 形状一旦分叉，那一行赋值立刻报类型错，不会静默跑歪。
 *
 * 维护纪律：**改动本文件必须同步 O-006 / O-007 的 `src/types.ts`**，
 * 两边字段名、可选性、顺序都要一致。允许的差异只有两处（O-007 已立先例）：
 * `StoreProvider` 的取值集合与本插件自己的服务键常量。
 *
 * 多方案定位（手册 §12.3「持久化后端」行）：**SQLite（WAL）为底座，JSONL / 内存为分支**。
 * 三个后端实现同一接口、注册三个不同的服务键；消费方按配置选一个、只写一个——
 * 同时写两个后端就是双真源，比没有后端更糟。
 */

/** 本插件注册的服务键（连字符，非 `ondra:store-json`）。全仓唯一归属。 */
export const STORE_JSON_SERVICE_KEY = 'ondra-store-json'

/** 后端标识。与 O-006/O-007 的唯一契约差异：多一个 `'jsonl'` 取值。 */
export type StoreProvider = 'sqlite' | 'memory' | 'jsonl'

/**
 * 端口状态。
 *
 * - `open`：正常可用；
 * - `degraded`：**落盘失败过且内存回滚也失败**（磁盘满、权限被夺），内存与文件可能不一致，
 *   只允许关库重建；与 O-006 的语义对齐——「状态未知」比「假装正常」诚实；
 * - `closed`：已关闭，任何调用都抛 `closed`。
 */
export type StoreState = 'open' | 'degraded' | 'closed'

/** 能力位。消费方在装载期读它决定走哪条分支，不要在调用期试探。 */
export interface StoreCaps {
  /** 是否支持原始 SQL。JSONL 后端恒为 false。 */
  readonly sql: boolean
  /** 是否支持 FTS5。JSONL 后端恒为 false。 */
  readonly fts: boolean
  /** 是否持久化。JSONL 后端恒为 true——这是它与内存后端的本质区别。 */
  readonly persist: boolean
  /**
   * 事务是否具备回滚语义。JSONL 后端为 true：事务内的变更先缓冲在内存，
   * 提交时才一次性落盘——**未提交的变更从未落过盘**，回滚即丢弃缓冲并还原内存快照。
   */
  readonly transaction: boolean
}

/**
 * 端口接受的值。
 *
 * **刻意不含 `boolean`**：与 O-006 同口径，归一化时 `boolean` 转 `0 | 1`，
 * 除此之外不做任何隐式编码——要存对象请调用方自己 `JSON.stringify`。
 */
export type SqlValue = null | number | bigint | string | Uint8Array

/** 一行数据。键必须是已声明的列名。 */
export type Row = Record<string, unknown>

/** 列类型。与 O-006 保持同一枚举（不含 `NUMERIC`，详见 O-006 注释）。 */
export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'ANY'

/** 列声明。 */
export interface ColumnSpec {
  /** 列名，必须匹配 `^[a-z][a-z0-9_]*$`。 */
  readonly name: string
  /** 类型。 */
  readonly type: ColumnType
  /** 是否非空。JSONL 后端**真的**按它拒绝 null 写入。 */
  readonly notNull?: boolean
  /** 是否主键。JSONL 后端支持多列复合主键（列值按序拼接作行键）。 */
  readonly primaryKey?: boolean
  /** 默认值（插入缺列时用它填；只接受字面量文本，不做 SQL 求值）。 */
  readonly default?: string
}

/** 索引声明。JSONL 后端**不建索引**，只把名字记下来用于 `EnsureResult` 与 schema 留档。 */
export interface IndexSpec {
  /** 索引名，必须匹配 `^[a-z][a-z0-9_]*$`。 */
  readonly name: string
  /** 参与索引的列。 */
  readonly columns: readonly string[]
  /** 是否唯一索引（JSONL 后端不强制，只记录）。 */
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
  /** 是否 `STRICT`（JSONL 后端忽略该位；类型约束见列声明的运行期检查）。 */
  readonly strict?: boolean
}

/** 建表/补列/加载过程中发现的、**不致命但必须让人看见**的问题。 */
export interface StoreIssue {
  /** 问题码。 */
  readonly code:
    | 'not-null-without-default'
    | 'primary-key-skipped'
    | 'strict-unavailable'
    | 'tighten-skipped'
    | 'index-skipped'
    /** 追加日志里存在解析不了的行（已跳过，不致命，但行数要让人看见）。 */
    | 'corrupt-line-skipped'
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
  /** 本次是否新建了表。磁盘上原本没有该表的数据文件才算 true；文件已存在只是「本次接入」，为 false。 */
  readonly created: boolean
  /** 本次补上的列名。 */
  readonly addedColumns: readonly string[]
  /** 本次新建的索引名（JSONL 后端恒为空，只做记录）。 */
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
  /** 跳过条数。 */
  readonly offset?: number
}

/** 写语句的结果。 */
export interface RunResult {
  /** 受影响行数。 */
  readonly changes: number
  /** 最后插入的行序号（JSONL 后端用自增整数模拟 rowid；无则为 0）。 */
  readonly lastInsertRowid: number | bigint
}

/** 运行期统计，供体检面板与 `ondra-startup-check` 读取。 */
export interface StoreStats {
  /** 后端标识。 */
  readonly provider: StoreProvider
  /** 当前状态。 */
  readonly state: StoreState
  /** 数据目录绝对路径（每张表一个 `.jsonl` 文件放在它下面）。 */
  readonly filePath: string | null
  /** 用户可见写法（如 `~/.ondra/user/jsonl-store`），绝不把机器绝对路径塞界面。 */
  readonly displayPath: string | null
  /** JSONL 后端没有 journal_mode，恒为 null。 */
  readonly journalMode: string | null
  /** JSONL 后端没有外键概念，恒为 false。 */
  readonly foreignKeys: boolean
  /** JSONL 后端没有同步级别可调，恒为 null。 */
  readonly synchronous: string | null
  /** 忙等超时毫秒。JSONL 后端无锁竞争，恒为 0。 */
  readonly busyTimeoutMs: number
  /** 已接入的表数量。 */
  readonly tableCount: number
  /** 数据文件总字节数（全部 `<table>.jsonl` 之和；表结构声明在每张表日志的首行，不单独设文件）。 */
  readonly sizeBytes: number | null
  /** 打开时间戳（毫秒）。 */
  readonly openedAtMs: number
  /** 已执行写语句条数（insert/upsert/update/delete）。 */
  readonly statements: number
  /** 已开启事务次数。 */
  readonly transactions: number
  /** 失败次数（含被捕获的降级）。 */
  readonly failures: number
  /** 是否处于降级态。 */
  readonly degraded: boolean
  /** 累计跳过的坏行数（读侧容忍，见 `StoreIssue['corrupt-line-skipped']`）。 */
  readonly corruptLines: number
  /** 自上次压缩以来每个表的追加行数峰值。超过阈值就该压缩。 */
  readonly appendedSinceCompact: number
}

/**
 * 原始 SQL 面。JSONL 后端 `caps.sql === false`，`raw` 恒为 `undefined`。
 * 保留形状只为与 O-006/O-007 的结构对位——消费方的可选链在两个后端上行为一致。
 */
export interface RawSqlFacet {
  exec(sql: string): void
  run(sql: string, ...params: SqlValue[]): RunResult
  all<T = Row>(sql: string, ...params: SqlValue[]): T[]
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined
}

/** 存储端口。三个后端实现同一形状，注册不同服务键。 */
export interface StorePort {
  /** 后端标识。 */
  readonly provider: StoreProvider
  /** 当前状态。 */
  readonly state: StoreState
  /** 能力位。 */
  readonly caps: StoreCaps
  /** 数据目录绝对路径。 */
  readonly filePath: string | null
  /** 原始 SQL 面；JSONL 后端恒为 undefined。 */
  readonly raw: RawSqlFacet | undefined

  /**
   * 确保表存在，并补齐缺失的列与索引声明（幂等）。首次调用时加载已有数据文件。
   * @param spec 表声明。
   */
  ensureTable(spec: TableSpec): EnsureResult
  /**
   * 表是否存在（以本端口是否接入过该表为准）。
   * @param table 表名。
   */
  tableExists(table: string): boolean

  /**
   * 插入一行。主键冲突抛错。列名必须是已声明的列。
   * @param table 表名。
   * @param row 行数据。
   */
  insert(table: string, row: Row): void
  /**
   * 按主键插入或更新。
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
   * 条件查询（内存过滤 + 排序）。
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
   * 事务。回调抛错则按内存快照还原并原样抛出；缓冲的日志行整批丢弃，
   * **未提交的变更从未落过盘**。
   *
   * **嵌套调用直接抛 `nested-transaction`**：快照是单层的，
   * 静默「加入外层事务」会让内层的回滚把外层已提交的变更一起吞掉。
   * @param fn 事务体。
   */
  transaction<T>(fn: () => T): T

  /**
   * 压缩：把一张表的追加日志全量重写成「每主键一行」（临时文件 + rename 原子替换）。
   * 追加日志会随更新变长，压缩是 JSONL 后端的日常保养，不是修复。
   * @param table 表名。
   * @returns 压缩后的行数。
   */
  compact(table: string): number

  /** 运行期统计。 */
  stats(): StoreStats
  /** 关闭。幂等。未提交的事务按回滚处理。 */
  close(): void
}

/** 错误码。与 O-006 的集合保持一致，消费方可按码分支，不必匹配中文文案。 */
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
  | 'open-failed'

/** 端口错误。带稳定错误码，消费方可按码分支。 */
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


