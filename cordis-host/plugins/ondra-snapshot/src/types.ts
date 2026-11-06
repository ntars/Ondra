/**
 * O-009 `ondra-snapshot` 的对外契约：**记忆快照**。
 *
 * 定位：L1 存储层里「出事了怎么回来」的那半边。整条链路是：
 *
 * ```
 * 迁移前自动备份（钩子） → 日常手动/定时备份 → 出问题 → 人工挑一份 → 显式 restore
 * ```
 *
 * 四条设计取向（都有代价，写在这里防后人改坏）：
 *
 * 1. **绝不自动恢复。** 这是全仓唯一一条「自动化会让人后悔」的地方：
 *    自动恢复意味着某次启动时，用户昨天说的话被一份旧快照悄悄盖掉了，
 *    而且**没有任何提示**。所以 `restore()` 必须带 `{ confirm: 'restore' }` 字面量，
 *    少一个字都不执行。
 *
 * 2. **KEEP=3，且永不删最新一份。** 保留三份是手册给定的值（够覆盖「改坏—发现—回退」
 *    的窗口），不是省磁盘。轮转只动本插件自己命名的文件，别的一概不碰。
 *
 * 3. **`caps.sql === false` 时明确拒绝，不静默跳过。**
 *    内存后端上做快照没有意义（进程一退全没）。此时服务**仍然注册**但
 *    `available = false`，每次 `create()` 返回带 `sql-unsupported` 的拒绝理由——
 *    这样下游能区分「没装」与「装了但不支持」，而不是把 `undefined` 当成「不需要」。
 *
 * 4. **不做热恢复。** 恢复要换掉正在被连接持有的库文件，而关闭/重开连接是 O-006
 *    的职责，本插件不碰。所以 `restore()` 只在「库已关闭」时执行，否则返回
 *    `store-open` 拒绝并给出可操作提示。这条是**已知阻塞点**，写进 README。
 *
 * 与 O-008 的关系是**单向**的：本插件把「备份」注册成 O-008 的迁移前钩子，
 * O-008 完全不知道本插件存在。反向禁止——那会让迁移能力取决于备份能力在不在。
 */

/** 本插件注册的服务键（连字符，非 `ondra:snapshot`）。全仓唯一归属。 */
export const SNAPSHOT_SERVICE_KEY = 'ondra-snapshot'

/** 原始 SQL 面（O-006 `RawSqlFacet` 的对位镜像，只取本插件用到的部分）。 */
export interface RawSqlFacetLike {
  /** 执行多语句 SQL。 */
  exec(sql: string): void
  /** 查询多行。 */
  all<T = Record<string, unknown>>(sql: string, ...params: readonly (string | number | null)[]): T[]
  /** 查询单行。 */
  get<T = Record<string, unknown>>(sql: string, ...params: readonly (string | number | null)[]): T | undefined
}

/** 存储端口（O-006 `StorePort` 的对位子集）。 */
export interface StoreLike {
  /** 当前状态。恢复只在 `closed` 时允许。 */
  readonly state: 'open' | 'degraded' | 'closed'
  /** 能力位：`sql === false` 时快照无意义。 */
  readonly caps: { readonly sql: boolean }
  /** 原始 SQL 面。 */
  readonly raw: RawSqlFacetLike | undefined
  /** 库文件绝对路径；内存后端为 null。 */
  readonly filePath: string | null
}

/** 快照目录（相对数据根的 `backups` 区域）。 */
export const SNAPSHOT_DIR_SEGMENTS: readonly string[] = ['snapshots']

/**
 * 快照文件名的形状：`ondra-YYYYMMDDTHHmmssZ-NN.db`。
 *
 * 用 UTC 时间戳而不是本地时间：本地时间会随夏令时、时区修改而回退，
 * 一旦回退，按名字排序就乱了，而「哪份最新」正是恢复时唯一要看的东西。
 */
export const SNAPSHOT_NAME_RE = /^ondra-(\d{8})T(\d{6})Z-(\d{2})\.db$/

/** 拒绝原因码。 */
export type SnapshotRefusalCode =
  | 'sql-unsupported'
  | 'no-raw'
  | 'no-path-layout'
  | 'vacuum-failed'
  | 'verify-failed'
  | 'not-found'
  | 'store-open'
  | 'confirmation-required'
  | 'no-pending'
  | 'io-failed'
  | 'bad-argument'

/** 一次拒绝。**每次失败都要给出可读原因**，不许返回空对象。 */
export interface SnapshotRefusal {
  /** 原因码。 */
  readonly code: SnapshotRefusalCode
  /** 中文说明，直接给人看。 */
  readonly detail: string
}

/** 一份快照。 */
export interface SnapshotRecord {
  /** 标识（文件名去掉扩展名），全目录唯一。 */
  readonly id: string
  /** 文件名。 */
  readonly fileName: string
  /** 绝对路径。**只在进程内用，不进界面**。 */
  readonly filePath: string
  /** 用户可见写法（如 `~/.ondra/backups/snapshots/xxx.db`）。 */
  readonly displayPath: string
  /** 创建时间（毫秒时间戳，由文件名解析，不依赖文件系统时钟）。 */
  readonly createdAtMs: number
  /** 文件字节数。 */
  readonly sizeBytes: number
  /** 快照里的 `user_version`；读不出来时为 null。 */
  readonly schemaVersion: number | null
}

/** `create()` 的结果。判别联合，`ok` 为真时 `record` 必然存在。 */
export type SnapshotOutcome =
  | { readonly ok: true; readonly record: SnapshotRecord }
  | { readonly ok: false; readonly refusal: SnapshotRefusal }

/** `verify()` 的结果。 */
export type VerifyOutcome =
  | { readonly ok: true; readonly record: SnapshotRecord; readonly check: 'quick_check' | 'skipped' }
  | { readonly ok: false; readonly refusal: SnapshotRefusal; readonly record: SnapshotRecord | undefined }

/** `prune()` 的结果。 */
export interface PruneOutcome {
  /** 是否执行了（拒绝时为 false）。 */
  readonly ok: boolean
  /** 删掉的文件名。 */
  readonly removed: readonly string[]
  /** 留下的文件名（按新→旧）。 */
  readonly kept: readonly string[]
  /** 拒绝原因。 */
  readonly refusal: SnapshotRefusal | undefined
}

/** 恢复待办。**只描述「下次启动该做什么」，本身不动库**。 */
export interface RestoreTicket {
  /** 待恢复的快照 id。 */
  readonly snapshotId: string
  /** 快照绝对路径。 */
  readonly snapshotPath: string
  /** 目标库绝对路径。 */
  readonly targetPath: string
  /** 登记时间（毫秒）。 */
  readonly stagedAtMs: number
  /** 快照大小，用于恢复前二次确认「还是那份文件」。 */
  readonly sizeBytes: number
}

/** `stage()` 的结果。 */
export type StageOutcome =
  | { readonly ok: true; readonly ticket: RestoreTicket }
  | { readonly ok: false; readonly refusal: SnapshotRefusal }

/** `restore()` 的结果。 */
export interface RestoreOutcome {
  /** 是否真的换掉了库文件。 */
  readonly ok: boolean
  /** 拒绝原因。 */
  readonly refusal: SnapshotRefusal | undefined
  /** 换库前把原库挪到了哪里（回退用）。 */
  readonly backupPath: string | undefined
}

/**
 * O-008 迁移前钩子的入参（**结构对位镜像**，不 import 它的源码）。
 *
 * 只镜像本插件真正用到的三个字段。多镜像一个字段，就多一处「那边改了这边不知道」
 * 的编译期耦合——而 §18.5 禁止同轮互相 import 的初衷正是避免这种耦合。
 */
export interface MigrationHookInput {
  /** 迁移前版本。 */
  readonly fromVersion: number
  /** 迁移后版本。 */
  readonly toVersion: number
  /** 将要执行的迁移 id。 */
  readonly pending: readonly string[]
}

/** 日志门面（结构对位，不引 Cordis 的 Logger 类型）。 */export interface SnapshotLog {
  /** 普通信息。 */
  info(message: string, ...args: unknown[]): void
  /** 告警。 */
  warn(message: string, ...args: unknown[]): void
  /** 错误。 */
  error(message: string, ...args: unknown[]): void
}

/** 运行期统计。 */
export interface SnapshotStats {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly unavailableReason: string | null
  /** 快照目录的用户可见写法。 */
  readonly displayDir: string | null
  /** 快照份数。 */
  readonly count: number
  /** 最新一份的时间；没有则为 null。 */
  readonly newestAtMs: number | null
  /** 最旧一份的时间；没有则为 null。 */
  readonly oldestAtMs: number | null
  /** 总字节数。 */
  readonly totalBytes: number
  /** 是否有一份待执行的恢复。 */
  readonly pendingRestore: boolean
  /** 保留份数。 */
  readonly keep: number
}

/** 快照服务。注册到 `ondra-snapshot` 键上。 */
export interface SnapshotService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly unavailableReason: string | null
  /**
   * 立刻做一份快照（`VACUUM INTO`）。
   * @param reason 一句话说明用途，写进文件名之外的日志里。
   */
  create(reason?: string): SnapshotOutcome
  /** 列出全部快照，按新→旧排序。 */
  list(): readonly SnapshotRecord[]
  /**
   * 校验一份快照是否可读（`ATTACH` + `PRAGMA quick_check` + 读 `user_version`）。
   * @param id 快照 id。
   */
  verify(id: string): VerifyOutcome
  /**
   * 轮转到只剩 `keep` 份（默认取配置值，最小 1）。
   * @param keep 保留份数。
   */
  prune(keep?: number): PruneOutcome
  /**
   * 登记一份待恢复快照。**不动库**，只写一张待办票。
   * @param id 快照 id。
   */
  stage(id: string): StageOutcome
  /** 撤销待恢复登记。@returns 是否真的撤销了一份。 */
  cancelStaged(): boolean
  /** 读当前待恢复票。 */
  pendingRestore(): RestoreTicket | undefined
  /**
   * 显式恢复。**必须**传 `{ confirm: 'restore' }`；
   * 库仍处于打开状态时拒绝（换掉正在被持有的文件会毁库）。
   * @param id 快照 id。
   * @param options 二次确认；不传即拒绝。
   */
  restore(id: string, options?: { readonly confirm: 'restore' }): RestoreOutcome
  /** 运行期统计。 */
  stats(): SnapshotStats
}
