/**
 * O-008 `ondra-data-migrate`：幂等初始化与版本迁移（〔研〕自研）。
 *
 * 为什么是自研：生态里的迁移工具（dbmate / node-pg-migrate / knex migrations）
 * 全部是**命令行工具**，绑的是「部署时在服务器上跑一次」的模型；本项目的形态是
 * 「插件在用户机器上随 app 启动」，而且手册 §12.4 明令禁止产出独立 CLI。
 * 唯一可借的是机制：单调整的版本号、每条迁移一个事务、历史表只作审计。
 * 这三条已在 `runner.ts` 独立实现，未引入任何第三方代码。
 *
 * 与 O-006 的分工（这条边界必须守住）：
 * - O-006 管「缺什么补什么」：补列、补索引，幂等，随时可调；
 * - 本插件管「改不动的怎么办」：类型漂移、主键变更、非空约束，必须重建表；
 * - 两者都走同一个 `StorePort`，不互相 import，不共享缓存（§14.2）。
 *
 * 三条容易踩空的地方：
 * 1. 版本真源是 `PRAGMA user_version`，历史表只是给人看的（见 `types.ts` 头注释）；
 * 2. 迁移体里拿不到 `store`，只能拿 `raw`，从结构上堵掉嵌套事务；
 * 3. 库版本高于程序版本时**拒绝迁移**，绝不把版本号改回去。
 */

import type { Context } from '@ntars/cordis'
import { MigrationRunner } from './runner.js'
import { DATA_MIGRATE_SERVICE_KEY, LEDGER_TABLE } from './types.js'
import type { MigrationLog, MigrationService, StoreLike } from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、正则），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { DATA_MIGRATE_SERVICE_KEY, LEDGER_TABLE, MIGRATION_ID_RE, SQL_NAME_RE, MigrateError } from './types.js'
export { MigrationRunner } from './runner.js'
export { buildCreateTable, rebuildTable, alignTable, withRebuildWrap } from './rebuild.js'
export { diffTable, describeDiff, inspectTable } from './inspect.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-data-migrate'

/** 配置项：全部有默认值。 */
export interface Config {
  /**
   * 是否写迁移历史表（默认 true）。
   * 关掉只影响「给人看」的审计视图，**版本号照旧准**——它存在库头，不依赖历史表。
   */
  readonly recordHistory: boolean
  /**
   * 迁移前钩子失败时是否中止（默认 true）。
   *
   * 钩子的典型用途是「迁移前 `VACUUM INTO` 备份」（O-009 会注册一个）。
   * 备份失败还继续改表结构，等于放弃了唯一的回退路径，所以默认中止。
   * 置 false 的代价写进 README：可能出现「没有备份就动了结构」。
   */
  readonly abortOnHookFailure: boolean
  /**
   * 重建表后是否跑 `PRAGMA foreign_key_check`（默认 true）。
   * 关掉更快，但会把「丢列删掉了被引用的键」这类错推到最后一次业务写入才炸。
   */
  readonly checkForeignKeys: boolean
}

/** 默认配置。 */
const DEFAULT_CONFIG: Config = {
  recordHistory: true,
  abortOnHookFailure: true,
  checkForeignKeys: true,
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 补全配置。 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const record = raw['recordHistory']
  const abort = raw['abortOnHookFailure']
  const fk = raw['checkForeignKeys']
  return {
    recordHistory: typeof record === 'boolean' ? record : DEFAULT_CONFIG.recordHistory,
    abortOnHookFailure: typeof abort === 'boolean' ? abort : DEFAULT_CONFIG.abortOnHookFailure,
    checkForeignKeys: typeof fk === 'boolean' ? fk : DEFAULT_CONFIG.checkForeignKeys,
  }
}

/**
 * O-001 身份服务的结构对位子集（只用来拼日志命名空间）。
 * 不 `import type` 它的源码：那会让两个插件在编译期互相绑定，单独卸载就编译失败。
 */
interface IdentityLike {
  loggerName(feature: string): string
}

/** 日志门面的最小形状（与迁移执行器要的 `MigrationLog` 同形）。 */
type LogLike = MigrationLog

declare module '@ntars/cordis' {
  interface Context {
    /** 迁移服务；未装载时为 undefined。 */
    'ondra-data-migrate'?: MigrationService
  }
}

/**
 * Cordis 入口：接上存储端口，注册迁移服务。**永不抛错**，任何缺失都只降级。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  const complete = completeConfig(config)

  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(
    identity ? identity.loggerName('data-migrate') : 'ondra.data-migrate',
  ) as unknown) as LogLike

  // 存储缺席：不注册「半个服务」。
  // 理由与 O-006 一致——打半个服务会让下游以为「迁移已就绪」，而实际一条都跑不了；
  // 取到 undefined 时下游会走 `if (!svc) return`，那条路径是明确写过的。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  if (store === undefined) {
    log.warn('找不到可用的存储端口（ondra-store-sqlite / ondra-store-memory 都不在），本插件不注册服务')
    return
  }

  const runner = new MigrationRunner(store, log, complete, () => Date.now())

  // 可逆注册：卸载只摘服务。本插件没有定时器、没有连接、没有缓存需要清。
  ctx.effect(
    () => ctx.provide(DATA_MIGRATE_SERVICE_KEY, runner),
    'ondra-data-migrate: 注册迁移服务',
  )

  const stats = runner.stats()
  if (!runner.available) {
    // 「明确拒绝」而不是「静默跳过」：下游查得到原因，界面能说清是哪一块不可用。
    log.warn(
      '迁移服务已注册但不可用（版本 %d，已登记 %d 条）：%s',
      stats.version,
      stats.registered,
      stats.unavailableReason ?? '未知原因',
    )
    return
  }
  log.info(
    '迁移服务就绪：版本 %d，已登记 %d 条迁移，历史表 %s',
    stats.version,
    stats.registered,
    complete.recordHistory ? LEDGER_TABLE : '未启用',
  )
  if (!complete.checkForeignKeys) {
    log.warn('checkForeignKeys=false：重建表后不校验外键，脏数据要等到下次业务写入才暴露')
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
      const issues: { message: string }[] = []
      if (isRecord(value)) {
        for (const key of ['recordHistory', 'abortOnHookFailure', 'checkForeignKeys'] as const) {
          const field = value[key]
          if (field !== undefined && typeof field !== 'boolean') {
            issues.push({ message: `配置项 ${key} 必须是布尔值` })
          }
        }
      }
      if (issues.length > 0) return { issues }
      return { value: completeConfig(value) }
    },
  },
}
