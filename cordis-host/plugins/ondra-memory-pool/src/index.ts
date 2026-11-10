/**
 * O-131 `ondra-memory-pool`：记忆八池分层（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层存储 / 检索 / 去重 / 衰减」列为复用档，
 * 本插件把**存储（O-006/O-007）、记忆本体与时钟（O-010）、强度（O-010）、
 * 注入装箱（O-036）** 全部交了出去。真正自研的只有三样，生态里都没有：
 *
 * 1. **八池那三列天级参数的落点**（宽限 / 半衰期 / 归档）。
 *    来源是 `dsh-chain` 的 `lib/pools.js`（MIT，只读思路未引入代码），
 *    但**参数取值与「铁律独立成池」这个产品决定**是本仓的。
 * 2. **「不猜」的落地**：认不出标签 → 海马体 + 未归类，且「重复写满 3 次
 *    升级人工定池」必须**跨会话累加**（落表，不是内存计数器）。
 * 3. **三段天级时间轴与 O-010 小时级强度的分工**：两条独立时间轴，
 *    互不推导、互不相乘。这是本轮最重要的一条边界，见 `types.ts` 文件头第 1 条。
 *
 * 三条写死在这里、防止下一轮有人顺手改的边界：
 * - **不算权重、不算强度。** 本插件只出时刻（`guardUntil` / `archiveAt` / `halfLives`）。
 *   给一个 0–1 权重就会有人拿它和 O-010 的 `strength` 比大小，两条曲线永远对不上。
 * - **不改 `memory_fact` 任何一列。** 池归属写 `memory_pool`；时钟只读。
 * - **海马体永不注入是硬性质。** 没有开关，`PoolPreset.injectable` 在该池恒为 false。
 */

import type { Context } from '@ntars/cordis'
import { POOL_PRESETS, checkPoolTimeline } from './pools.js'
import { PoolRepository, POOL_TABLE_NAMES, poolSummaryOf } from './service.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as PoolConfig } from './settings.js'
import { POOL_IDS, POOL_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  PoolService,
  StoreLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、池 id 表），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  POOL_SERVICE_KEY,
  POOL_IDS,
  TABLE_POOL,
  TABLE_HINT,
  PoolError,
} from './types.js'
export {
  POOL_PRESETS,
  DAY_MS,
  classifyByLabels,
  checkPoolTimeline,
  isPermanent,
  isPoolId,
  presetOf,
  resolveLabel,
  timelineOfPreset,
} from './pools.js'
export { PoolStore, digestOf, toAssignment, assignmentToRow, toHint, hintToRow } from './store.js'
export { TABLE_POOL_SPEC, TABLE_HINT_SPEC, POOL_TABLES } from './schema.js'
export { PoolRepository, POOL_TABLE_NAMES, poolSummaryOf } from './service.js'
export {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  completeConfig,
} from './settings.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-pool'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect` 里：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-pool: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆八池服务；未装载本插件时为 undefined。 */
    'ondra-memory-pool'?: PoolService
  }
}

/**
 * Cordis 入口：接上存储端口与记忆内核，建两张表，注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-memory-core']` 后，
 * 内核缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + 各能力分别降级」——纯分类（`classify` / `assign`）不依赖内核，
 * 只有时间轴需要它。下游能区分「没装内核」与「装了但存储不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: PoolConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-pool') : 'ondra.memory-pool') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      // 用户层用 kebab 键交给 O-005（§8.4 只认小写），回来再换成 camel 键。
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }
  const settings = completeConfig(effective)

  // 2. 存储端口是**硬依赖**：池归属与未归类线索都要落盘。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  if (store === undefined) {
    log.warn('没有可用存储端口（ondra-store-sqlite / ondra-store-memory 都缺席）：池归属无处可放，服务转「不可用」')
  }

  // 3. 记忆内核是**软依赖**：只读 `createdAt` / `lastSeenAt` 算时间轴。
  //    缺席时纯分类照常工作，只有 `timelineOf` / `dueForArchive` / `eligibleForInjection`
  //    的时间轴部分退化为「拿不到时钟」——**不编一个锚点**。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.info('没有记忆内核（ondra-memory-core）：只做池分类，算不了三段天级时间轴（不拿分配时刻顶替锚点）')
  }

  const service = new PoolRepository(store, core, settings, log, () => Date.now())

  // 4. 建表放进 effect：表是本插件的资源，卸载时不需要额外动作，
  //    但登记成 effect 能让 `getEffects()` 看见「本插件做过一次建表」，重载语义也确定。
  ctx.effect(() => {
    const ok = service.ready()
    if (!ok) log.warn('池表初始化失败：八池服务转「不可用」')
    return () => undefined
  }, 'ondra-memory-pool: 建池表')

  ctx.effect(() => ctx.provide(POOL_SERVICE_KEY, service), 'ondra-memory-pool: 注册八池服务')

  // 5. 开局自检池表本身：宽限 > 归档这类病态组合会让「永远碰不到归档」，
  //    必须在这里报出来，而不是等到某条记忆死活不沉底才查。
  const poolIssues = POOL_PRESETS.flatMap(checkPoolTimeline)
  for (const issue of poolIssues) log.error('池表声明有问题：%s', issue)

  // 6. 报一次现状。可用性、池条数、两个依赖在不在，都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('八池服务已注册但不可用（%s）', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '八池就绪：%d 个池 / %d 条归属（%s），核心 %d/%d，未归类 %d 条，待人工定池 %d 条，记忆时钟 %s',
    POOL_IDS.length,
    stats.assigned,
    poolSummaryOf(stats),
    stats.core.count,
    stats.core.cap,
    stats.unclassified,
    stats.escalations,
    stats.clockAvailable ? '可用' : '缺席',
  )
  if (!stats.clockAvailable) {
    log.warn('记忆内核缺席：池归属照常登记，但 `timelineOf()` 拿不到时钟会返回 undefined，归档候选为空')
  }
  if (!store?.caps.persist) {
    // 内存后端能跑，但「她把你的规矩归到铁律池」这件事在进程退出那一刻归零。必须说出来。
    log.warn('当前跑在内存后端：池归属与未归类线索都不会落盘，进程退出即丢')
  }
  if (settings.allowLegacySkill) {
    log.warn('allowLegacySkill=true：新记忆可被自动分到 legacy 的 skill 池（该行口径存疑：README 写 60、代码 90）')
  }
  log.debug?.('池表：%s', POOL_TABLE_NAMES.join(' / '))
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载，
 * 只该让某个字段回退默认并被记下来。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: PoolConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // `completeConfig` 永不抛错：越界值被夹紧、类型错回退默认，都是「能补的」。
      return { value: completeConfig(value) }
    },
  },
}
