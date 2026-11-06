/**
 * O-006 `ondra-store-sqlite`：SQLite 端口插件（〔薄〕薄封装）。
 *
 * 上游 `desktop/packages/storage/storage-sqlite` 已经把「用 `node:sqlite` 开库、开 WAL、
 * 开外键、0600 建文件、`STRICT` 表、预编译语句、`BEGIN IMMEDIATE`」这套机制跑通了，
 * 但它的服务对象是 **storage hub 的 kv 后端**（文档级 `key TEXT / value TEXT` JSON），
 * 表达不了「业务表 + 任意 SQL」。所以本插件做的是**薄封装**：复用它的机制与参数，
 * 按业务表重写接口，并补三件它没做的事——
 *
 * 1. **读回真实生效值**：`PRAGMA journal_mode` 在 WAL 不可用的卷上**不报错**，
 *    只把返回行里的模式改成实际的。只 `exec` 不看返回，就会以为在跑 WAL。
 * 2. **补列**：`ALTER TABLE ADD COLUMN` 的三条限制（不能加主键、非空必须带默认值）逐个处理，
 *    处理不了的记 issue 而不是让整个开库失败。
 * 3. **旁挂文件权限**：`-wal` / `-shm` 里也有数据，主库 chmod 0600 管不到它们。
 *
 * 不引它的代码（§11.2 纪律：机制可借鉴，代码自写），也不改它（§16.3 禁止改 `desktop/`）。
 */

import type { Context } from '@ntars/cordis'
import { assertParentDir, loadSqliteModule, openDatabase } from './open.js'
import type { SqliteModuleLike } from './open.js'
import { SqliteStore } from './port.js'
import { STORE_SQLITE_SERVICE_KEY } from './types.js'
import type { StorePort } from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、标识符正则），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { STORE_SQLITE_SERVICE_KEY, StoreError, IDENT_RE } from './types.js'
export { SqliteStore } from './port.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-store-sqlite'

/** 默认库文件名。放在 `user/` 区域下（可备份、不可随手清）。 */
const DEFAULT_DB_FILE = 'ondra.db'

/** 配置项：全部有默认值。 */
export interface Config {
  /**
   * 库文件路径。留空表示自动取 `user/ondra.db`（由 O-002 的 `fileIn('user', ...)` 给出）。
   * 支持 `:memory:`（仅用于自检，数据不落盘）。
   */
  readonly path: string
  /**
   * 日志模式。`wal` 默认；WAL 的共享内存文件在网络盘上不可用时，
   * 改成 `delete` / `truncate` / `persist`。
   */
  readonly journalMode: 'wal' | 'delete' | 'truncate' | 'persist'
  /**
   * 同步级别。WAL + `normal` 在**应用崩溃**时不丢事务，只有**断电**可能丢最后一批；
   * 内存/情绪这类可重建数据用 `normal` 足够，记忆库若追求极限安全可改 `full`。
   */
  readonly synchronous: 'full' | 'normal' | 'off'
  /**
   * 忙等超时毫秒。0 表示不等待、撞锁立刻失败。默认 5000。
   */
  readonly busyTimeoutMs: number
  /**
   * 是否开启外键约束。默认 true。关闭会让 `REFERENCES` 变成纯注释。
   */
  readonly foreignKeys: boolean
  /**
   * 是否把库文件与旁挂文件收紧到 0600。默认 true；Windows 上自动跳过。
   */
  readonly tightenPermissions: boolean
  /**
   * 新建表是否用 `STRICT`。默认 true。旧 SQLite 不支持时自动退回普通表并记 issue。
   */
  readonly strictTables: boolean
}

/** 默认配置。 */
const DEFAULT_CONFIG: Config = {
  path: '',
  journalMode: 'wal',
  synchronous: 'normal',
  busyTimeoutMs: 5000,
  foreignKeys: true,
  tightenPermissions: true,
  strictTables: true,
}

/** 允许的 journal_mode 四值。 */
const JOURNAL_MODES: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
/** 允许的同步级别。 */
const SYNC_MODES: readonly string[] = ['full', 'normal', 'off']

/**
 * O-002 路径服务的**结构对位**子集。
 *
 * 不用 `import type` 引它的源码：那会让两个插件在编译期互相绑定，
 * 任一单独卸载都会让另一个编译失败（§15.5）。形状一变，这里的赋值处就会报错。
 */
interface PathLayoutLike {
  readonly areas: { readonly root: string }
  readonly display: string
  ensure(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  fileIn(area: 'user' | 'logs' | 'cache' | 'tmp' | 'backups', ...segments: string[]): string
  isInside(filePath: string): boolean
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 补全并夹紧配置。 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const path = raw['path']
  const journal = raw['journalMode']
  const sync = raw['synchronous']
  const busy = raw['busyTimeoutMs']
  const fk = raw['foreignKeys']
  const tight = raw['tightenPermissions']
  const strict = raw['strictTables']
  return {
    path: typeof path === 'string' ? path : DEFAULT_CONFIG.path,
    journalMode:
      typeof journal === 'string' && JOURNAL_MODES.includes(journal)
        ? (journal as Config['journalMode'])
        : DEFAULT_CONFIG.journalMode,
    synchronous:
      typeof sync === 'string' && SYNC_MODES.includes(sync)
        ? (sync as Config['synchronous'])
        : DEFAULT_CONFIG.synchronous,
    busyTimeoutMs:
      typeof busy === 'number' && Number.isFinite(busy) ? Math.min(60000, Math.max(0, Math.trunc(busy))) : DEFAULT_CONFIG.busyTimeoutMs,
    foreignKeys: typeof fk === 'boolean' ? fk : DEFAULT_CONFIG.foreignKeys,
    tightenPermissions: typeof tight === 'boolean' ? tight : DEFAULT_CONFIG.tightenPermissions,
    strictTables: typeof strict === 'boolean' ? strict : DEFAULT_CONFIG.strictTables,
  }
}

/**
 * 把绝对路径换算成用户可见写法。绝不把机器绝对路径塞进界面。
 * @param filePath 绝对路径。
 * @param layout 路径服务（可为空）。
 */
function displayOf(filePath: string, layout: PathLayoutLike | undefined): string {
  if (filePath === ':memory:' || layout === undefined) return filePath
  if (!layout.isInside(filePath)) return filePath
  const root = layout.areas.root
  const tail = filePath.slice(root.length).replace(/^[\\/]+/, '').split(/[\\/]+/).join('/')
  return tail === '' ? layout.display : layout.display + '/' + tail
}

/**
 * 日志门面的最小形状（只声明本插件用到的三个级别）。
 * 用结构对位而不是引 Cordis 的 Logger 类型：日志实现换代不该让插件编译失败。
 */
interface LogLike {
  /** 普通信息。 */
  info(message: string, ...args: unknown[]): void
  /** 告警。 */
  warn(message: string, ...args: unknown[]): void
  /** 错误。 */
  error(message: string, ...args: unknown[]): void
}

/**
 * 开库并构造端口。**永不抛错**：任何失败都返回 undefined + 一条中文 error。
 * @param filePath 库文件绝对路径。
 * @param complete 已补全的配置。
 * @param module 已加载的 sqlite 模块。
 * @param layout 路径服务（用于生成用户可见路径）。
 * @param log 日志。
 */
function openStore(
  filePath: string,
  complete: Config,
  module: SqliteModuleLike,
  layout: PathLayoutLike | undefined,
  log: LogLike,
): SqliteStore | undefined {
  try {
    assertParentDir(filePath)
    const opened = openDatabase(
      {
        path: filePath,
        journalMode: complete.journalMode,
        synchronous: complete.synchronous,
        busyTimeoutMs: complete.busyTimeoutMs,
        foreignKeys: complete.foreignKeys,
        tightenPermissions: complete.tightenPermissions,
      },
      module,
    )
    // 开库阶段发现的降级（WAL 没生效、权限没收紧、外键没开）逐条上报，不吞。
    for (const warning of opened.warnings) log.warn('%s', warning)
    return new SqliteStore(
      opened.db,
      filePath === ':memory:' ? ':memory:' : filePath,
      displayOf(filePath, layout),
      {
        journalMode: opened.journalMode,
        foreignKeys: opened.foreignKeys,
        synchronous: opened.synchronous,
        busyTimeoutMs: complete.busyTimeoutMs,
      },
      opened.fts5,
    )
  } catch (error) {
    log.error(
      '打开数据库失败，本插件不注册服务（下游应回退到 ondra-store-memory）：%s',
      error instanceof Error ? error.message : String(error),
    )
    return undefined
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** SQLite 存储端口；未装载或开库失败时为 undefined。 */
    'ondra-store-sqlite'?: StorePort
  }
}

/**
 * Cordis 入口：开库、注册服务，失败只降级不阻断。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  const complete = completeConfig(config)

  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('store-sqlite') : 'ondra.store-sqlite')

  // 1. 定位库文件。**绝不落到当前工作目录**——那会让库文件散落在用户随便启动 app 的地方，
  //    换目录启动就换了一个库，「记忆忽然全没了」的最脏来源之一。
  let filePath = complete.path.trim()
  if (filePath === '') {
    if (layout === undefined) {
      log.error(
        '未配置 path，且找不到路径服务 ondra-path-layout；拒绝把数据库落到当前工作目录，本插件不注册服务',
      )
      return
    }
    try {
      // 目录归 O-002 建（0700 + 越界校验），本插件不自己 mkdir。
      layout.ensure('user')
      filePath = layout.fileIn('user', DEFAULT_DB_FILE)
    } catch (error) {
      log.error(
        '解析数据根下的库文件路径失败，本插件不注册服务：%s',
        error instanceof Error ? error.message : String(error),
      )
      return
    }
  }

  // 2. 加载 node:sqlite（缺内建模块时 catch 得住，不会让整个模块崩掉）。
  const loaded = loadSqliteModule()
  const module: SqliteModuleLike | null = loaded.module
  if (module === null) {
    log.error('%s；本插件不注册服务，下游应回退到 ondra-store-memory', loaded.reason)
    return
  }

  // 3. 开库。任何失败都只降级，不抛出 apply。
  const store = openStore(filePath, complete, module, layout, log)
  if (store === undefined) return

  // 4. 可逆注册：卸载时先摘服务再关连接。
  ctx.effect(
    () => {
      const dispose = ctx.provide(STORE_SQLITE_SERVICE_KEY, store)
      return () => {
        dispose()
        try {
          store.close()
        } catch (error) {
          log.error('关闭数据库时出错：%s', error instanceof Error ? error.message : String(error))
        }
      }
    },
    'ondra-store-sqlite: 注册存储端口',
  )

  const stats = store.stats()
  log.info(
    '存储就绪：%s（journal=%s，foreign_keys=%s，FTS5=%s，busy_timeout=%dms）',
    store.displayPath ?? filePath,
    stats.journalMode ?? '未知',
    stats.foreignKeys ? '开' : '关',
    store.caps.fts ? '可用' : '不可用',
    stats.busyTimeoutMs,
  )
  if (!store.caps.fts) {
    log.warn('本库不支持 FTS5：记忆域检索必须走 2-gram 倒排分支（O-014 的默认分支），不得启用 BM25 分支')
  }
  if (!complete.tightenPermissions) {
    log.warn('tightenPermissions=false：库文件权限未收紧到 0600，仅调试期可用')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: Config } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      const complete = completeConfig(value)
      const issues: { message: string }[] = []
      const path = complete.path.trim()
      if (path !== '' && path !== ':memory:' && path.startsWith('-')) {
        issues.push({ message: '配置项 path 不能以连字符开头' })
      }
      if (path !== '' && path !== ':memory:' && !path.includes('/') && !path.includes('\\')) {
        issues.push({ message: '配置项 path 必须是绝对路径或含目录的相对路径，不接受单个文件名' })
      }
      const raw = isRecord(value) ? value : {}
      if (typeof raw['journalMode'] === 'string' && !JOURNAL_MODES.includes(raw['journalMode'])) {
        issues.push({ message: '配置项 journalMode 只能是 wal / delete / truncate / persist' })
      }
      if (typeof raw['synchronous'] === 'string' && !SYNC_MODES.includes(raw['synchronous'])) {
        issues.push({ message: '配置项 synchronous 只能是 full / normal / off' })
      }
      if (issues.length > 0) return { issues }
      return { value: complete }
    },
  },
}
