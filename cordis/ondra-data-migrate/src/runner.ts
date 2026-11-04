/**
 * 版本编排与执行。
 *
 * 这个文件的全部职责只有一句话：**保证「一条迁移只跑一次、跑不完就整体不算」**。
 *
 * 它靠三件事做到：
 * 1. 版本号存在库头（`PRAGMA user_version`），随事务一起提交/回滚；
 * 2. 每条迁移自己一个事务，版本号在**同一个事务里**最后写；
 * 3. 失败后本次立即停（不跑后面的），下一次 `ensure()` 才重试失败的那条——
 *    撞锁这类瞬时错误能自愈，而永久封死会让整个进程再也升不了版本。
 *
 * 为什么不用定时器自动跑：插件装载顺序不确定，定时器跑在第几个插件之后是运气。
 * 改成「谁登记谁调 `ensure()`」，执行时机就变成确定的——第一个登记者跑自己那条，
 * 后面的登记者跑后面那些，任何时刻调用都安全。
 */

import { describeDiff, diffTable, inspectTable } from './inspect.js'
import { alignTable, rebuildTable, withRebuildWrap } from './rebuild.js'
import { LEDGER_TABLE, MigrateError, MIGRATION_ID_RE } from './types.js'
import type {
  AlignResult,
  Migration,
  MigrationContext,
  MigrationHook,
  MigrationIssue,
  MigrationIssueCode,
  MigrationLog,
  MigrationRecord,
  MigrationReport,
  MigrationService,
  MigrationStats,
  RawSqlFacetLike,
  RebuildOptions,
  RebuildResult,
  StoreLike,
  TableShape,
  TableSpecLike,
} from './types.js'

/** 执行器选项，全部来自 Config。 */
export interface RunnerOptions {
  /** 是否写历史表。关掉只影响「给人看」的记录，版本号照旧准。 */
  readonly recordHistory: boolean
  /** 迁移前钩子失败（返回字符串或抛错）时是否中止迁移。 */
  readonly abortOnHookFailure: boolean
  /** 重建后是否跑 `PRAGMA foreign_key_check`。 */
  readonly checkForeignKeys: boolean
}

/**
 * 历史表的建表语句。
 *
 * 用 `STRICT`：历史表自己就是审计证据，不能允许「版本号写成了 '3' 字符串」这种事。
 * 旧 SQLite 不支持时会退回普通表（见 `ensureLedger`），并打一条 warn。
 */
const LEDGER_STRICT_SQL = `CREATE TABLE IF NOT EXISTS "${LEDGER_TABLE}" (
  "version" INTEGER NOT NULL PRIMARY KEY,
  "id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "applied_at" INTEGER NOT NULL,
  "duration_ms" INTEGER NOT NULL,
  "rebuild" INTEGER NOT NULL
) STRICT`

/** 退回版本（不支持 `STRICT` 的老 SQLite）。 */
const LEDGER_PLAIN_SQL = `CREATE TABLE IF NOT EXISTS "${LEDGER_TABLE}" (
  "version" INTEGER NOT NULL PRIMARY KEY,
  "id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "applied_at" INTEGER NOT NULL,
  "duration_ms" INTEGER NOT NULL,
  "rebuild" INTEGER NOT NULL
)`

/** 空报告，用于「没跑」的所有分支——保证返回形状永远一致，消费方不用分支。 */
function emptyReport(available: boolean, fromVersion: number, issue?: MigrationIssue): MigrationReport {
  return {
    available,
    fromVersion,
    toVersion: fromVersion,
    applied: [],
    skipped: [],
    issues: issue === undefined ? [] : [issue],
    durationMs: 0,
  }
}

/** 迁移执行器。 */
export class MigrationRunner implements MigrationService {
  /** 已登记的迁移，按 `toVersion` 升序（登记时保持有序）。 */
  private readonly registered: Migration[] = []
  /** 迁移前钩子。 */
  private readonly hooks: MigrationHook[] = []
  /** 同进程内是否已经出现过致命失败。 */
  private fatal: MigrationIssue | undefined
  /** 防重入：迁移里再调 `ensure()` 会直接返回，不会递归。 */
  private running = false
  /** 版本缓存；每次 `ensure()` 都会从库里重读，缓存只服务 `version` 只读属性。 */
  private cachedVersion = 0
  /** 最近一次报告。 */
  private lastReport: MigrationReport | null = null
  /** 历史表是否已确认可建（避免每次 ensure 都试一遍）。 */
  private ledgerReady = false
  /** 不可用原因。 */
  private readonly unavailableReason: string | null
  /** 不可用的问题码（比从中文原因里反推字符串稳）。 */
  private readonly unavailableCode: MigrationIssueCode | null

  /**
   * @param store 存储端口。
   * @param log 日志。
   * @param options 执行器选项。
   * @param now 取当前毫秒时间戳（注入以便将来做确定性测试）。
   */
  constructor(
    private readonly store: StoreLike,
    private readonly log: MigrationLog,
    private readonly options: RunnerOptions,
    private readonly now: () => number,
  ) {
    if (store.state !== 'open') {
      this.unavailableReason = `存储端口状态为 ${store.state}，迁移只在 open 状态下执行`
      this.unavailableCode = 'store-not-open'
    } else if (!store.caps.sql || store.raw === undefined) {
      this.unavailableReason = '当前存储后端没有原始 SQL 面（内存兜底后端），迁移无法执行'
      this.unavailableCode = 'sql-unsupported'
    } else if (!store.caps.transaction) {
      this.unavailableReason = '当前存储后端没有事务回滚语义，迁移无法保证「跑不完就整体不算」'
      this.unavailableCode = 'no-transaction'
    } else {
      this.unavailableReason = null
      this.unavailableCode = null
    }
    if (this.available) {
      try {
        this.cachedVersion = this.readVersion()
      } catch (error) {
        this.log.error('读取 user_version 失败：%s', errorMessage(error))
        this.cachedVersion = 0
      }
    }
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.unavailableReason === null
  }

  /** 当前版本（来自库头）。 */
  get version(): number {
    return this.cachedVersion
  }

  /** 未执行条数。 */
  get pending(): number {
    return this.registered.filter((migration) => migration.toVersion > this.cachedVersion).length
  }

  /**
   * 登记一条迁移。
   * @param migration 迁移。
   */
  register(migration: Migration): void {
    if (typeof migration.id !== 'string' || !MIGRATION_ID_RE.test(migration.id)) {
      throw new MigrateError(
        'invalid-identifier',
        `迁移 id "${String(migration.id)}" 不合规：必须匹配 ${MIGRATION_ID_RE.source}`,
      )
    }
    if (!Number.isInteger(migration.toVersion) || migration.toVersion < 1 || migration.toVersion > 1_000_000_000) {
      throw new MigrateError('invalid-version', `迁移 "${migration.id}" 的 toVersion 必须是 1 以上的整数`)
    }
    if (migration.transactional === false && migration.rebuild === true) {
      // 两者互斥：重建必须靠事务回滚兜底，否则中途崩掉会留下一张半截表。
      throw new MigrateError(
        'bad-argument',
        `迁移 "${migration.id}" 同时声明了 transactional:false 与 rebuild:true；重建必须包在事务里`,
      )
    }
    if (this.registered.some((item) => item.id === migration.id)) {
      throw new MigrateError('duplicate-id', `迁移 id "${migration.id}" 被登记了两次`)
    }
    if (this.registered.some((item) => item.toVersion === migration.toVersion)) {
      const other = this.registered.find((item) => item.toVersion === migration.toVersion)
      throw new MigrateError(
        'duplicate-version',
        `版本号 ${migration.toVersion} 已被迁移 "${other?.id ?? '?'}" 占用`,
      )
    }
    this.registered.push(migration)
    this.registered.sort((left, right) => left.toVersion - right.toVersion)
    if (migration.toVersion <= this.cachedVersion) {
      this.log.warn(
        '迁移 "%s"（版本 %d）登记时版本已是 %d，它不会被再次执行；若这是新迁移，说明版本号算错了',
        migration.id,
        migration.toVersion,
        this.cachedVersion,
      )
    }
  }

  /**
   * 批量登记。
   * @param migrations 迁移列表。
   */
  registerAll(migrations: readonly Migration[]): void {
    for (const migration of migrations) this.register(migration)
  }

  /**
   * 登记迁移前钩子。
   * @param hook 钩子。
   * @returns 撤销函数。
   */
  onBeforeApply(hook: MigrationHook): () => void {
    this.hooks.push(hook)
    return () => {
      const index = this.hooks.indexOf(hook)
      if (index >= 0) this.hooks.splice(index, 1)
    }
  }

  /**
   * 幂等执行。
   * @param options 目标版本上限。
   */
  ensure(options: { readonly to?: number } = {}): MigrationReport {
    if (!this.available) {
      const report = emptyReport(false, this.cachedVersion, {
        code: this.unavailableCode ?? 'sql-unsupported',
        migrationId: undefined,
        detail: this.unavailableReason ?? '迁移不可用',
      })
      this.lastReport = report
      return report
    }
    if (this.running) {
      // 迁移体里又调了 ensure()：不报错（那会让一次正常迁移失败），但必须留痕。
      this.log.warn('检测到 ensure() 重入（很可能是迁移体里又调了一次），本次直接返回')
      return emptyReport(true, this.cachedVersion, {
        code: 'reentrant',
        migrationId: undefined,
        detail: 'ensure() 被重入调用，本次未执行任何迁移',
      })
    }
    if (this.fatal !== undefined) {
      return emptyReport(true, this.cachedVersion, this.fatal)
    }

    this.running = true
    const started = this.now()
    try {
      return this.runOnce(started, options.to)
    } finally {
      this.running = false
    }
  }

  /**
   * 一次完整的执行过程。
   * @param started 开始时间。
   * @param cap 目标版本上限。
   */
  private runOnce(started: number, cap: number | undefined): MigrationReport {
    // 版本号以库头为准，每次重读：同进程里可能有别的路径改过它（手工修库、外部工具）。
    const fromVersion = this.readVersion()
    this.cachedVersion = fromVersion

    const latestVersion = this.registered.reduce((max, item) => Math.max(max, item.toVersion), 0)
    if (fromVersion > latestVersion) {
      // 库比代码新：用户装回了旧版本。**绝不「把版本号改回去」**——
      // 那等于宣称「旧代码认识新表」，下一次写入就会毁数据。
      const issue: MigrationIssue = {
        code: 'version-regression',
        migrationId: undefined,
        detail:
          `库里的版本是 ${fromVersion}，而本版程序登记的最高版本只有 ${latestVersion}；` +
          '说明这份数据被更新版本的程序打开过。拒绝降级迁移，请升级程序或从快照恢复。',
      }
      this.fatal = issue
      this.log.error('%s', issue.detail)
      const report = emptyReport(true, fromVersion, issue)
      this.lastReport = report
      return report
    }

    const limit = cap === undefined ? Number.POSITIVE_INFINITY : cap
    const pending = this.registered.filter((item) => item.toVersion > fromVersion && item.toVersion <= limit)
    if (pending.length === 0) {
      const report: MigrationReport = {
        available: true,
        fromVersion,
        toVersion: fromVersion,
        applied: [],
        skipped: this.registered.map((item) => item.id),
        issues: [],
        durationMs: this.now() - started,
      }
      this.lastReport = report
      return report
    }

    // 钩子只跑一次，且在所有迁移之前：备份要覆盖「这一批」而不是每一条各备份一份。
    const aborted = this.runHooks(fromVersion, pending)
    if (aborted !== undefined) {
      this.lastReport = aborted
      return aborted
    }

    const applied: string[] = []
    const issues: MigrationIssue[] = []
    for (const migration of pending) {
      try {
        this.applyOne(migration)
        applied.push(migration.id)
        this.cachedVersion = migration.toVersion
        this.log.info(
          '迁移完成：%d %s —— %s（重建=%s）',
          migration.toVersion,
          migration.id,
          migration.description,
          migration.rebuild === true ? '是' : '否',
        )
      } catch (error) {
        issues.push({
          code: 'migration-failed',
          migrationId: migration.id,
          detail: `迁移 "${migration.id}"（版本 ${migration.toVersion}）失败并已回滚：${errorMessage(error)}`,
        })
        this.log.error('迁移 "%s" 失败：%s', migration.id, errorMessage(error))
        // 后面的迁移可能依赖这一条，**必须停**。继续跑等于在最坏的状态上加盖新结构。
        break
      }
    }

    const report: MigrationReport = {
      available: true,
      fromVersion,
      // 版本号以库头为准：失败时它没变，成功时它等于最后一条跑完的迁移。
      toVersion: this.readVersion(),
      applied,
      skipped: this.registered.filter((item) => !applied.includes(item.id)).map((item) => item.id),
      issues,
      durationMs: this.now() - started,
    }
    this.lastReport = report
    return report
  }

  /**
   * 跑迁移前钩子。返回报告即代表「中止」，返回 undefined 代表「继续」。
   * @param fromVersion 当前版本。
   * @param pending 待执行迁移。
   */
  private runHooks(fromVersion: number, pending: readonly Migration[]): MigrationReport | undefined {
    if (this.hooks.length === 0) return undefined
    const input = {
      fromVersion,
      toVersion: pending[pending.length - 1]?.toVersion ?? fromVersion,
      pending: pending.map((item) => item.id),
    }
    for (const hook of this.hooks) {
      let refusal: string | void
      try {
        refusal = hook(input)
      } catch (error) {
        refusal = `钩子抛错：${errorMessage(error)}`
      }
      if (typeof refusal === 'string') {
        const issue: MigrationIssue = { code: 'hook-aborted', migrationId: undefined, detail: refusal }
        this.log.error('迁移前钩子拒绝了本次迁移：%s', refusal)
        if (this.options.abortOnHookFailure) {
          return emptyReport(true, fromVersion, issue)
        }
        // 配置允许「钩子失败也继续」时，只告警——这时的风险是「没有备份就动了结构」，
        // 所以这条 warn 必须留下，不能静默。
        this.log.warn('配置 abortOnHookFailure=false：钩子失败但继续迁移，本次可能没有备份')
      }
    }
    return undefined
  }

  /**
   * 执行一条迁移。
   * @param migration 迁移。
   */
  private applyOne(migration: Migration): void {
    const started = this.now()
    const body = (): void => {
      migration.up(this.createContext(migration))
      if (this.options.recordHistory) this.record(migration, started)
      this.writeVersion(migration.toVersion)
    }

    if (migration.rebuild === true) {
      // 重建要关外键，而 PRAGMA 必须在事务外开——这层包裹是唯一正确的时序。
      withRebuildWrap(this.store, body, this.options.checkForeignKeys)
      return
    }
    if (migration.transactional === false) {
      // 不给事务：只允许 `VACUUM` 这类语句。版本号最后单独写，
      // 中途崩掉会导致重跑，所以这类迁移**必须自身幂等**（README 里写死了这条）。
      body()
      return
    }
    this.store.transaction(body)
  }

  /**
   * 构造迁移上下文。**刻意不给 `store`**：不给嵌套事务留口子。
   * @param migration 迁移。
   */
  private createContext(migration: Migration): MigrationContext {
    const raw = this.requireRaw()
    return {
      version: this.readVersion(),
      toVersion: migration.toVersion,
      raw,
      inspect: (table: string): TableShape => inspectTable(raw, table),
      diff: (spec: TableSpecLike) => diffTable(inspectTable(raw, spec.name), spec),
      rebuild: (spec: TableSpecLike, options?: RebuildOptions): RebuildResult => {
        const diff = diffTable(inspectTable(raw, spec.name), spec)
        const result = rebuildTable(raw, spec, diff, options)
        this.log.info('表 "%s" 已重建：搬入 %d 行，补列 %d，丢列 %d', spec.name, result.copiedRows, result.addedColumns.length, result.droppedColumns.length)
        return result
      },
      align: (spec: TableSpecLike): AlignResult => {
        const outcome = alignTable(this.store, spec)
        this.log.info('表 "%s" 对齐：%s（%s）', spec.name, outcome.mode, describeDiff(outcome.diff))
        return { table: spec.name, mode: outcome.mode, diff: outcome.diff, rebuild: undefined }
      },
      log: this.log,
    }
  }

  /** 读历史表。 */
  history(): readonly MigrationRecord[] {
    if (!this.available || !this.options.recordHistory) return []
    const raw = this.requireRaw()
    try {
      if (!this.ledgerExists(raw)) return []
      const rows = raw.all<{
        version: number
        id: string
        description: string
        applied_at: number
        duration_ms: number
        rebuild: number
      }>(`SELECT "version", "id", "description", "applied_at", "duration_ms", "rebuild" FROM "${LEDGER_TABLE}" ORDER BY "version" ASC`)
      return rows.map((row) => ({
        version: row.version,
        id: row.id,
        description: row.description,
        appliedAtMs: row.applied_at,
        durationMs: row.duration_ms,
        rebuild: row.rebuild === 1,
      }))
    } catch (error) {
      // 历史表读不出来不影响版本判定（版本真源是 user_version），只影响审计视图。
      this.log.warn('读取迁移历史失败：%s', errorMessage(error))
      return []
    }
  }

  /** 运行期统计。 */
  stats(): MigrationStats {
    const latestVersion = this.registered.reduce((max, item) => Math.max(max, item.toVersion), 0)
    return {
      available: this.available,
      unavailableReason: this.unavailableReason,
      version: this.cachedVersion,
      latestVersion,
      registered: this.registered.length,
      pending: this.pending,
      historyRows: this.options.recordHistory ? this.history().length : null,
      lastReport: this.lastReport,
      filePath: this.store.filePath,
    }
  }

  /** 取原始 SQL 面；不可用时抛错（调用前已判过 available）。 */
  private requireRaw(): RawSqlFacetLike {
    const raw = this.store.raw
    if (raw === undefined) {
      throw new MigrateError('no-raw', '当前存储后端没有原始 SQL 面，迁移无法执行')
    }
    return raw
  }

  /** 读库头版本号。读不出来按 0 处理并留痕。 */
  private readVersion(): number {
    const raw = this.requireRaw()
    const row = raw.get<{ user_version: number }>('PRAGMA user_version')
    const value = row?.user_version
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
  }

  /**
   * 写库头版本号。
   *
   * `PRAGMA` 不接受占位绑定，只能把数字拼进 SQL。这里拼的是**本文件内校验过的整数**，
   * 不是外部输入——这条注释是为了防止后来者把参数直接接上业务字段。
   * @param version 目标版本（正整数）。
   */
  private writeVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) {
      throw new MigrateError('invalid-version', `拒绝写入非法版本号 ${String(version)}`)
    }
    this.requireRaw().exec(`PRAGMA user_version = ${version}`)
  }

  /** 历史表是否存在。 */
  private ledgerExists(raw: RawSqlFacetLike): boolean {
    const row = raw.get<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      LEDGER_TABLE,
    )
    return row !== undefined
  }

  /** 确保历史表存在（幂等；不支持 STRICT 时退回普通表）。 */
  private ensureLedger(raw: RawSqlFacetLike): void {
    if (this.ledgerReady || this.ledgerExists(raw)) {
      this.ledgerReady = true
      return
    }
    try {
      raw.exec(LEDGER_STRICT_SQL)
    } catch {
      this.log.warn('本库不支持 STRICT 表，迁移历史表退回普通表')
      raw.exec(LEDGER_PLAIN_SQL)
    }
    this.ledgerReady = true
  }

  /**
   * 写一条历史。
   * @param migration 迁移。
   * @param started 开始时间。
   */
  private record(migration: Migration, started: number): void {
    const raw = this.requireRaw()
    this.ensureLedger(raw)
    raw.run(
      `INSERT INTO "${LEDGER_TABLE}" ("version", "id", "description", "applied_at", "duration_ms", "rebuild") VALUES (?, ?, ?, ?, ?, ?)`,
      migration.toVersion,
      migration.id,
      migration.description,
      this.now(),
      Math.max(0, this.now() - started),
      migration.rebuild === true ? 1 : 0,
    )
  }
}

/**
 * 把任意异常压成一行中文可读文本。
 * @param error 异常。
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
