/**
 * O-009 `ondra-snapshot`：记忆快照（〔研〕自研）。
 *
 * 为什么是自研：`VACUUM INTO` 是 SQLite 自带的能力，但「什么时候做、留几份、
 * 怎么验、怎么恢复」这套编排生态里没有现成插件（备份工具都是命令行、按 cron 跑）。
 * 而本项目的形态是插件随 app 启动，且手册 §12.4 禁止产出独立 CLI。
 * 驱动能力一行没写，编排是本项目自己的事。
 *
 * 三条不可让渡的纪律：
 *
 * 1. **绝不自动恢复。** 自动恢复 = 某次启动时用户昨天说的话被旧快照悄悄盖掉，
 *    而且没有任何提示。恢复必须 `{ confirm: 'restore' }` 字面量 + 库已关闭，两道闸。
 * 2. **KEEP=3 且永不删最新一份。** 轮转只动本插件自己命名的 `ondra-*.db`。
 * 3. **不可用时明确拒绝。** 内存后端上快照没有意义，此时服务仍注册但 `available=false`，
 *    每次调用都返回带原因码的拒绝——而不是返回一个空数组让人以为「还没备份过」。
 *
 * 与 O-008 的关系是**单向**的：本插件把自己的 `create()` 注册成 O-008 的迁移前钩子，
 * O-008 完全不知道本插件存在。反向禁止——那会让「能不能迁移」取决于「有没有备份插件」。
 */

import type { Context } from '@ntars/cordis'
import { SnapshotStore } from './service.js'
import type { PathLayoutLike } from './service.js'
import { SNAPSHOT_SERVICE_KEY } from './types.js'
import type { MigrationHookInput, SnapshotLog, SnapshotService, StoreLike } from './types.js'

// 契约里既有纯类型也有运行时值，分开导出才不违背「类型导入不得混入运行时值」。
export type * from './types.js'
export { SNAPSHOT_SERVICE_KEY, SNAPSHOT_NAME_RE, SNAPSHOT_DIR_SEGMENTS } from './types.js'
export { SnapshotStore } from './service.js'
export { checkSnapshot, vacuumInto, quoteSqlString } from './backup.js'
export { formatStamp, parseStamp, listSnapshotFiles, nextFileName } from './registry.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-snapshot'

/** 配置项：全部有默认值。 */
export interface Config {
  /**
   * 保留份数，默认 3（手册给定值）。
   * 三份刚好覆盖「改坏 → 发现 → 回退」的窗口：一份最新、一份上一次、一份兜底。
   * 最小 1，配成 0 会被夹到 1——「每次备份完立刻删掉」不是省空间，是自欺。
   */
  readonly keep: number
  /**
   * 做完是否立刻校验（默认 true）。
   *
   * 校验是 `ATTACH` + `PRAGMA quick_check`，几毫秒到几十毫秒。
   * 关掉能让备份更快，代价是「备份坏了但没人知道」，直到真要恢复那一刻才发现。
   */
  readonly verifyAfterCreate: boolean
  /**
   * 是否把「备份」注册成迁移前钩子（默认 true）。
   *
   * 手册 §9.7 的「三道保险」第一条就是「开工前 `VACUUM INTO` 备份」。
   * 关掉等于放弃这条保险，只有调试期才该关。
   */
  readonly snapshotBeforeMigration: boolean
  /**
   * 迁移前备份的最小间隔毫秒，默认 5 分钟。
   *
   * 启动时多个域插件会各自调一次 `ensure()`，不节流就会连做五份一模一样的备份，
   * 把 KEEP=3 的窗口瞬间冲掉——那等于「有备份」和「没备份」一样。
   */
  readonly minIntervalMs: number
}

/** 默认配置。 */
const DEFAULT_CONFIG: Config = {
  keep: 3,
  verifyAfterCreate: true,
  snapshotBeforeMigration: true,
  minIntervalMs: 300_000,
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 补全并夹紧配置。 */
function completeConfig(value: unknown): Config {
  const raw = isRecord(value) ? value : {}
  const keep = raw['keep']
  const verify = raw['verifyAfterCreate']
  const beforeMigration = raw['snapshotBeforeMigration']
  const interval = raw['minIntervalMs']
  return {
    keep: typeof keep === 'number' && Number.isFinite(keep) ? Math.min(50, Math.max(1, Math.trunc(keep))) : DEFAULT_CONFIG.keep,
    verifyAfterCreate: typeof verify === 'boolean' ? verify : DEFAULT_CONFIG.verifyAfterCreate,
    snapshotBeforeMigration: typeof beforeMigration === 'boolean' ? beforeMigration : DEFAULT_CONFIG.snapshotBeforeMigration,
    minIntervalMs:
      typeof interval === 'number' && Number.isFinite(interval)
        ? Math.min(86_400_000, Math.max(0, Math.trunc(interval)))
        : DEFAULT_CONFIG.minIntervalMs,
  }
}

/**
 * O-001 身份服务的结构对位子集（只用来拼日志命名空间）。
 * 不 `import type` 它的源码：那会让两个插件在编译期互相绑定，单独卸载就编译失败。
 */
interface IdentityLike {
  loggerName(feature: string): string
}

/**
 * O-008 迁移服务的结构对位子集。
 *
 * **只取两个成员**：`available` 与 `onBeforeApply`。取多了就变成依赖它的实现细节，
 * 而本插件对 O-008 的全部需求就是「在改结构之前让我插一句话」。
 */
interface MigrationLike {
  readonly available: boolean
  onBeforeApply(hook: (input: MigrationHookInput) => string | void): () => void
}

/** 日志门面的最小形状。 */
type LogLike = SnapshotLog

declare module '@ntars/cordis' {
  interface Context {
    /** 快照服务；未装载时为 undefined。 */
    'ondra-snapshot'?: SnapshotService
  }
}

/**
 * Cordis 入口：接上存储与路径，注册快照服务，并把备份挂到迁移前钩子上。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: Config): void {
  const complete = completeConfig(config)

  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('snapshot') : 'ondra.snapshot') as unknown) as LogLike

  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  if (store === undefined) {
    log.warn('找不到可用的存储端口（ondra-store-sqlite / ondra-store-memory 都不在），本插件不注册服务')
    return
  }
  const layout = ctx.get('ondra-path-layout') as PathLayoutLike | undefined
  if (layout === undefined) {
    // 快照目录必须落在数据根里。落到 cwd 意味着「换个目录启动就找不到备份了」，
    // 那是备份最讽刺的失效方式，所以宁可不可用也不猜。
    log.error('找不到路径服务 ondra-path-layout，无法确定快照目录；本插件注册但不可用')
  }

  const snapshot = new SnapshotStore(store, layout, log, complete, () => Date.now())

  ctx.effect(() => ctx.provide(SNAPSHOT_SERVICE_KEY, snapshot), 'ondra-snapshot: 注册快照服务')

  if (!snapshot.available) {
    log.warn('快照服务已注册但不可用：%s', snapshot.unavailableReason ?? '未知原因')
    return
  }

  const stats = snapshot.stats()
  log.info(
    '快照服务就绪：%s，现有 %d 份（保留 %d 份，共 %d 字节）',
    stats.displayDir ?? '未知目录',
    stats.count,
    stats.keep,
    stats.totalBytes,
  )
  if (!complete.verifyAfterCreate) {
    log.warn('verifyAfterCreate=false：备份做完不校验，坏备份要到恢复那一刻才会暴露')
  }
  if (stats.pendingRestore) {
    // 待恢复票存在说明上次有人登记了恢复但没执行完。**不自动执行**，只提醒。
    log.warn('发现一份待执行的恢复登记（不会自动执行）。如需恢复请人工确认后调用 restore()')
  }

  if (!complete.snapshotBeforeMigration) {
    log.info('snapshotBeforeMigration=false：迁移前不做自动备份（手册 §9.7 三道保险的第一条被关掉了）')
    return
  }

  wireMigrationHook(ctx, snapshot, complete, log)
}

/**
 * 把备份挂到 O-008 的迁移前钩子上。
 *
 * 装载顺序不确定：本插件可能先于 `ondra-data-migrate` 被 apply。
 * 所以先直接取，取不到就用 `ctx.inject` 开一个「依赖就绪后再跑」的子作用域。
 *
 * 注意这里的 `ctx.inject` 与插件级 `inject` **不是一回事**：
 * 插件级 `inject` 是硬依赖，服务缺席会让整个插件保持 PENDING（静默不加载，最糟）；
 * `ctx.inject` 只是开一个子 fiber，缺席时它自己不跑，本插件的服务照旧注册。
 * @param ctx 宿主上下文。
 * @param snapshot 快照服务。
 * @param config 已补全的配置。
 * @param log 日志。
 */
function wireMigrationHook(ctx: Context, snapshot: SnapshotService, config: Config, log: LogLike): void {
  const hook = (input: MigrationHookInput): string | void => {
    // 快照不可用时**不拦迁移**：备份是增强能力，让它决定「能不能启动」是本末倒置。
    // 但要留下 warn，否则用户会以为自己有备份。
    if (!snapshot.available) {
      log.warn('迁移前备份被跳过：快照服务不可用（%s）', snapshot.unavailableReason ?? '未知原因')
      return
    }
    const stats = snapshot.stats()
    if (stats.newestAtMs !== null && Date.now() - stats.newestAtMs < config.minIntervalMs) {
      // 刚备份过就不再重复做：启动时多个插件各调一次 ensure()，不节流会把 KEEP=3 冲光。
      log.info('迁移前备份被跳过：%d 毫秒内已有快照', config.minIntervalMs)
      return
    }
    const outcome = snapshot.create(`迁移前备份 v${input.fromVersion} → v${input.toVersion}`)
    if (!outcome.ok) {
      // 返回字符串 = 中止迁移。备份失败还继续改表结构，等于放弃了唯一的回退路径。
      return `迁移前备份失败（${outcome.refusal.code}）：${outcome.refusal.detail}；已中止本次迁移`
    }
    snapshot.prune()
  }

  const attach = (migrations: MigrationLike, scope: Context): void => {
    if (!migrations.available) {
      log.info('迁移服务存在但不可用（多为内存后端），不注册迁移前备份钩子')
      return
    }
    scope.effect(() => migrations.onBeforeApply(hook), 'ondra-snapshot: 迁移前备份钩子')
  }

  const existing = ctx.get('ondra-data-migrate') as MigrationLike | undefined
  if (existing !== undefined) {
    attach(existing, ctx)
    return
  }
  // 还没装载：开一个子作用域，等它出现再挂。子 fiber 随本插件一起卸载，钩子自动撤销。
  ctx.inject(['ondra-data-migrate'], (sub: Context) => {
    const late = sub.get('ondra-data-migrate') as MigrationLike | undefined
    if (late === undefined) return
    attach(late, sub)
  })
  log.info('迁移服务尚未装载，已登记「就绪后自动挂载备份钩子」')
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
        const keep = value['keep']
        if (keep !== undefined && (typeof keep !== 'number' || !Number.isFinite(keep) || keep < 1)) {
          issues.push({ message: '配置项 keep 必须是 ≥1 的数字（保留份数）' })
        }
        const interval = value['minIntervalMs']
        if (interval !== undefined && (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0)) {
          issues.push({ message: '配置项 minIntervalMs 必须是 ≥0 的毫秒数' })
        }
        for (const key of ['verifyAfterCreate', 'snapshotBeforeMigration'] as const) {
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
