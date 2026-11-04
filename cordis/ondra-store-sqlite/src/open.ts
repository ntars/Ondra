/**
 * 开库：加载 `node:sqlite`、建文件（0600）、应用 PRAGMA、**读回真实生效值**、探测 FTS5。
 *
 * 三个不显然但必要的动作：
 *
 * 1. **`node:sqlite` 用 `createRequire` 加载，不用顶层 `import`。**
 *    静态 `import 'node:sqlite'` 在缺少该内建模块的 Node 上会在**模块求值期**直接崩，
 *    而模块崩掉的表现是「插件没加载」，宿主只在 stderr 留一行——正是手册说的最隐蔽失败。
 *    换成 `require` 就能 try/catch，降级成一条中文 error 让 O-077 看得见。
 *
 * 2. **`PRAGMA journal_mode = WAL` 会「静默失败」**。它是一条有返回值的语句：
 *    在网络盘、部分 FUSE 上 WAL 不可用，SQLite 会**保持原模式并在返回行里告诉你**，
 *    不抛错。只 `exec()` 不看返回，就会以为开了 WAL 而实际在 rollback-journal 上跑。
 *    所以这里必须读回。
 *
 * 3. **`-wal` / `-shm` 是带数据的旁挂文件**，主库 chmod 0600 管不到它们。
 *    目录已经是 0700（O-002 负责）时风险有限，但能收紧就收紧。
 */

import { chmodSync, existsSync, openSync, closeSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { StoreError } from './types.js'
import type { SqlValue } from './types.js'

/** 非 POSIX 平台不折腾权限位。 */
const POSIX = process.platform !== 'win32'

/** 私有文件权限：仅本人可读写。 */
const FILE_MODE = 0o600

/**
 * `node:sqlite` 的**结构对位**类型。
 *
 * 刻意不 `import type { DatabaseSync } from 'node:sqlite'`：那会把「能不能编译」
 * 绑在宿主 `@types/node` 的版本上。这里只声明本插件**实际用到**的那几个方法，
 * 全部来自上游 `desktop/packages/storage/storage-sqlite/src/schema.ts` 与 `unit.ts`
 * 里已出现过的调用（`exec / prepare / get / all / run / close / isTransaction`）。
 */
export interface SqliteStatementLike {
  /** 查单行。 */
  get(...params: SqlValue[]): unknown
  /** 查多行。 */
  all(...params: SqlValue[]): unknown[]
  /** 执行写语句。 */
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

/** 连接的最小形状。 */
export interface SqliteDatabaseLike {
  /** 执行多语句。 */
  exec(sql: string): void
  /** 预编译。 */
  prepare(sql: string): SqliteStatementLike
  /** 关闭。 */
  close(): void
  /** 是否在事务中（部分实现提供）。 */
  readonly isTransaction?: boolean
}

/** 模块的最小形状。 */
export interface SqliteModuleLike {
  /** 同步连接构造器。 */
  DatabaseSync: new (path: string) => SqliteDatabaseLike
}

/** 加载结果。 */
export interface SqliteLoadResult {
  /** 模块；加载失败为 null。 */
  readonly module: SqliteModuleLike | null
  /** 失败原因（中文）；成功为空串。 */
  readonly reason: string
}

/**
 * 尝试加载 `node:sqlite`。**永不抛错。**
 */
export function loadSqliteModule(): SqliteLoadResult {
  try {
    const require = createRequire(import.meta.url)
    const loaded = require('node:sqlite') as Partial<SqliteModuleLike>
    if (typeof loaded.DatabaseSync !== 'function') {
      return {
        module: null,
        reason: '当前 Node 的 node:sqlite 里没有 DatabaseSync（需要 Node 22.5 以上，且未被裁剪）',
      }
    }
    return { module: { DatabaseSync: loaded.DatabaseSync }, reason: '' }
  } catch (error) {
    return {
      module: null,
      reason:
        '加载 node:sqlite 失败：' +
        (error instanceof Error ? error.message : String(error)) +
        '（需要 Node 22.5 以上；本插件不引第三方 SQLite 驱动）',
    }
  }
}

/**
 * 独占创建一个 0600 的库文件。已存在则保留原权限位（稍后单独收紧）。
 * @param path 绝对路径。
 */
function createDatabaseFile(path: string): void {
  if (existsSync(path)) return
  try {
    const fd = openSync(path, 'wx', FILE_MODE)
    closeSync(fd)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw new StoreError('open-failed', '创建数据库文件「' + path + '」失败', String(error))
  }
}

/**
 * 把主库与旁挂的 `-wal` / `-shm` 一起收紧到 0600。失败不抛，只回报。
 * @param path 主库绝对路径。
 * @returns 收紧失败的文件名列表（空表示全部成功或本来就不存在）。
 */
function tightenFiles(path: string): string[] {
  if (!POSIX) return []
  const failed: string[] = []
  for (const candidate of [path, path + '-wal', path + '-shm']) {
    if (!existsSync(candidate)) continue
    try {
      chmodSync(candidate, FILE_MODE)
    } catch {
      failed.push(candidate)
    }
  }
  return failed
}

/** 打开选项。 */
export interface OpenOptions {
  /** 库文件绝对路径，或 `:memory:`。 */
  readonly path: string
  /** journal_mode，已校验的四值之一。 */
  readonly journalMode: 'wal' | 'delete' | 'truncate' | 'persist'
  /** 同步级别，已校验。 */
  readonly synchronous: 'full' | 'normal' | 'off'
  /** 忙等超时毫秒。 */
  readonly busyTimeoutMs: number
  /** 是否开启外键。 */
  readonly foreignKeys: boolean
  /** 是否收紧文件权限。 */
  readonly tightenPermissions: boolean
}

/** 打开结果：连接 + 读回的真实参数 + 告警。 */
export interface OpenResult {
  /** 连接。 */
  readonly db: SqliteDatabaseLike
  /** 实际生效的 journal_mode（小写）。 */
  readonly journalMode: string
  /** 外键实际状态。 */
  readonly foreignKeys: boolean
  /** 同步级别实际值（小写）。 */
  readonly synchronous: string
  /** 旁挂文件收紧失败的名字。 */
  readonly tightenFailures: readonly string[]
  /** 是否支持 FTS5。 */
  readonly fts5: boolean
  /** 不影响可用性的告警（中文，可直接进日志）。 */
  readonly warnings: readonly string[]
}

/**
 * 读一条返回单行的 PRAGMA。
 * @param db 连接。
 * @param sql PRAGMA 语句（值可内联的就内联，PRAGMA 不支持参数绑定）。
 */
function readPragma(db: SqliteDatabaseLike, sql: string): unknown {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  const keys = Object.keys(row)
  return keys.length > 0 ? row[keys[0] as string] : undefined
}

/**
 * 探测 FTS5 是否真的可用：建一张临时虚拟表再删掉。
 *
 * 不用 `PRAGMA compile_options` 里找 `ENABLE_FTS5`——那说明的是「编译期选项在」，
 * 而运行时能不能建表才是消费方关心的事。临时表失败不留痕。
 * @param db 连接。
 */
function probeFts5(db: SqliteDatabaseLike): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.ondra_fts_probe USING fts5(x)')
    db.exec('DROP TABLE IF EXISTS temp.ondra_fts_probe')
    return true
  } catch {
    try {
      db.exec('DROP TABLE IF EXISTS temp.ondra_fts_probe')
    } catch {
      // 探测失败时清理也失败：无副作用（temp 表随连接销毁），不必再报。
    }
    return false
  }
}

/**
 * 开库并配置。
 * @param options 打开选项。
 * @param module 已加载的 sqlite 模块。
 */
export function openDatabase(options: OpenOptions, module: SqliteModuleLike): OpenResult {
  const actual = options.path === ':memory:' ? ':memory:' : resolve(options.path)
  const warnings: string[] = []
  let tightenFailures: readonly string[] = []

  if (actual !== ':memory:') {
    try {
      createDatabaseFile(actual)
    } catch (error) {
      throw error instanceof StoreError
        ? error
        : new StoreError('open-failed', '准备数据库文件失败', String(error))
    }
  }

  let db: SqliteDatabaseLike
  try {
    db = new module.DatabaseSync(actual)
  } catch (error) {
    throw new StoreError(
      'open-failed',
      '打开数据库「' + actual + '」失败：' + (error instanceof Error ? error.message : String(error)),
      '常见原因：文件被另一进程独占、文件不是 SQLite 格式、或所在卷不支持共享内存',
    )
  }

  try {
    // 忙等必须在任何事务之前设：两个连接（本进程 + 快照进程）撞车时，
    // 没有 busy_timeout 会立刻 SQLITE_BUSY，而不是等一会儿。
    db.exec('PRAGMA busy_timeout = ' + Math.max(0, Math.trunc(options.busyTimeoutMs)))

    if (options.foreignKeys) {
      // 外键是**连接级**开关，不写进库文件；每次开库都必须重设，否则新连接默认全关。
      db.exec('PRAGMA foreign_keys = ON')
    }

    // journal_mode 有返回值，读回来才知道到底生效没有（见文件头第 2 条）。
    const modeRow = db.prepare('PRAGMA journal_mode = ' + options.journalMode.toUpperCase()).get() as
      | { journal_mode?: string }
      | undefined
    const journalMode = String(modeRow?.journal_mode ?? '').toLowerCase()
    if (journalMode === '') {
      warnings.push('journal_mode 读回为空，无法确认日志模式，按 rollback-journal 对待')
    } else if (journalMode !== options.journalMode) {
      warnings.push(
        '期望 journal_mode=' +
          options.journalMode +
          '，实际生效 ' +
          journalMode +
          '（该卷可能不支持 WAL 的共享内存文件，功能不受影响但并发写会退化）',
      )
    }

    db.exec('PRAGMA synchronous = ' + options.synchronous.toUpperCase())

    const foreignKeys = Number(readPragma(db, 'PRAGMA foreign_keys')) === 1
    if (options.foreignKeys && !foreignKeys) {
      // 极少数构建会把 foreign_keys 编掉；此时不能假装已开。
      warnings.push('已请求开启外键，但读回仍是关闭状态，本库不保证引用完整性')
    }
    const syncRaw = String(readPragma(db, 'PRAGMA synchronous') ?? '').toLowerCase()

    if (actual !== ':memory:' && options.tightenPermissions) {
      tightenFailures = tightenFiles(actual)
      if (tightenFailures.length > 0) {
        warnings.push(
          '数据库文件权限收紧到 0600 失败：' +
            tightenFailures.join('、') +
            '（目录权限 0700 仍在兜底，但仍建议检查文件属主）',
        )
      }
    }
    if (!POSIX && options.tightenPermissions) {
      warnings.push('当前平台不支持 POSIX 权限位，0600 未生效')
    }

    const fts5 = probeFts5(db)

    return {
      db,
      journalMode: journalMode === '' ? 'delete' : journalMode,
      foreignKeys,
      synchronous: syncRaw === '' ? options.synchronous : syncRaw,
      tightenFailures,
      fts5,
      warnings,
    }
  } catch (error) {
    try {
      db.close()
    } catch {
      // 配置失败后关闭也失败：连接本来就没可用，无需二次报错。
    }
    throw error instanceof StoreError
      ? error
      : new StoreError('open-failed', '配置数据库失败：' + (error instanceof Error ? error.message : String(error)))
  }
}

/**
 * 取文件字节数（拿不到返回 null，绝不抛）。
 * @param path 绝对路径。
 */
export function fileSizeOf(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/**
 * 确保库文件所在目录存在**由 O-002 负责**；这里只做一次存在性判断，
 * 缺失时给一句可操作的错误，而不是自己去 `mkdir`（那样会绕过 0700 与越界校验）。
 * @param path 库文件绝对路径。
 */
export function assertParentDir(path: string): void {
  if (path === ':memory:') return
  const parent = dirname(resolve(path))
  if (!existsSync(parent)) {
    throw new StoreError(
      'open-failed',
      '数据库所在目录「' + parent + '」不存在',
      '应由 O-002 ondra-path-layout 的 ensure() 预先创建；本插件不自己建目录，避免绕过 0700 与越界校验',
    )
  }
}
