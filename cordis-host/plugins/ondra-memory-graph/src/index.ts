/**
 * O-015 `ondra-memory-graph`：记忆之间「谁和谁有关」（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层存储」列为复用档，本插件把**存储与建表**
 * 全部交了出去——表由 O-006/O-007 的端口建、事务由端口给、记忆本体在 O-010。
 * 真正自研的只有三样：
 *
 * 1. **四边的权重工艺**：同主题 0.72 起每次 +0.05、共现 0.15 起每次 +0.10、
 *    荒诞 0.03 永不进检索。这是产品参数，生态里的图数据库只提供「边」这个容器。
 * 2. **步进式衰减 + `decayed_at` 游标**。90 天 ×0.5 是**步进**，不是闭式函数；
 *    没有游标就会重复乘算成 0.5^N（手册 §9.7 原话）。
 *    **注意这与 O-013 恰好相反**：O-013 的条目强度是 `0.5^(Δt/S)` 的闭式，
 *    扫一百次也一样，所以它不该有游标。形状不同，做法就必须不同。
 * 3. **1 跳扩散与枢纽度上限共用同一个常量**（手册原话「建链与扩散共用同一常量」）。
 *
 * 边界（写死在这里，防止下一轮有人顺手改）：
 * - **绝不写 `memory_fact` 的任何一列**。条目衰减归 O-013，边权归本插件（裁决⑪）。
 * - **绝不装定时器**。衰减 / 剪枝都是写操作，交给一个不知道第几个装载的定时器
 *   会让「为什么昨晚的边变轻了」永远查不出来。时机由 O-019 夜巡显式调用。
 * - **`surreal` 边永不进检索**，且没有开关。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as GraphConfig } from './settings.js'
import { GraphRepository } from './service.js'
import { EdgeStore } from './store.js'
import { GRAPH_SERVICE_KEY, TABLE_LINK } from './types.js'
import type {
  ConfigSchemaLike,
  GraphService,
  IdentityLike,
  LogLike,
  MemoryCoreLike,
  StoreLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、关系预设），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export {
  DECAY_FACTOR,
  DECAY_INTERVAL_DAYS,
  DIFFUSE_MIN_WEIGHT,
  GRAPH_SERVICE_KEY,
  HUB_CAP,
  PRUNE_BELOW,
  PRUNE_TO,
  RELATION_PRESETS,
  RING_WEIGHTS,
  TABLE_LINK,
  GraphError,
} from './types.js'
export { EdgeStore, toEdge, toRow } from './store.js'
export { TABLE_LINK_SPEC } from './schema.js'
export {
  advancedCursor,
  canonicalPair,
  clampWeight,
  decayedWeight,
  edgeIdOf,
  isNameLike,
  isPruneCandidate,
  nextWeight,
  profileOf,
  ringWeightOf,
  stepsElapsed,
} from './weights.js'
export type { RelationProfile } from './weights.js'
export { GraphRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-graph'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-graph: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆图谱服务；未装载本插件时为 undefined。 */
    'ondra-memory-graph'?: GraphService
  }
}

/**
 * Cordis 入口：接上存储端口与记忆内核，建边表，注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-store-sqlite']` 后，
 * 内存兜底在位也救不了——整插件会停在 PENDING（静默不加载）。
 * 改成「照常注册 + `available=false`」，下游能区分「没装图谱」与「装了但存储不可用」。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: GraphConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-graph') : 'ondra.memory-graph') as unknown) as LogLike

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

  // 2. 存储端口：SQLite 优先，内存兜底。两个都没有才真的不可用。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  const storePresent = store !== undefined
  let edgeStore: EdgeStore | undefined
  if (store !== undefined) {
    edgeStore = new EdgeStore(store, log)
  } else {
    log.warn('没有可用存储端口（ondra-store-sqlite / ondra-store-memory 都缺席）：图谱服务以「不可用」状态注册')
  }

  // 3. 记忆内核是**软依赖**：只用来验端点存在。缺席时照样建边（表间无外键）。
  const core = ctx.get('ondra-memory-core') as MemoryCoreLike | undefined
  if (core === undefined) {
    log.info('没有记忆内核（ondra-memory-core）：端点不再校验，边照写（孤儿边由 forgetOf 清）')
  }

  const service = new GraphRepository(edgeStore, storePresent, core, settings, log, () => Date.now())

  // 4. 建表放进 effect：表是本插件的资源，卸载时要能被撤（端口不支持删表，
  //    但注册顺序与重载语义仍然要挂在 effect 上，否则重载会重复 ensure）。
  ctx.effect(() => {
    const ok = service.ready()
    if (!ok) log.warn('边表 %s 初始化失败：图谱服务转「不可用」', TABLE_LINK)
    return () => undefined
  }, 'ondra-memory-graph: 建边表')

  ctx.effect(() => ctx.provide(GRAPH_SERVICE_KEY, service), 'ondra-memory-graph: 注册图谱服务')

  // 5. 报一次现状。可用性、边数、各关系条数都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('图谱服务已注册但不可用（%s）：O-014 的图谱因子会退出归一化，其余四项照跑', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '图谱就绪：边 %d 条（同主题 %d / 共现 %d / 荒诞 %d），扩散门槛 %s，枢纽度上限 %d，衰减 %d 天 ×%s',
    stats.edges,
    stats.byRelation.same_topic,
    stats.byRelation.cooccur,
    stats.byRelation.surreal,
    settings.diffuseMinWeight,
    settings.hubCap,
    settings.decayDays,
    settings.decayFactor,
  )
  if (settings.maxRings > 1) {
    log.warn('maxRings=%d：台账职责是 1 跳扩散，多圈会让「顺着话头想起来」变成「翻箱倒柜」', settings.maxRings)
  }
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
    ) => { readonly value: GraphConfig } | { readonly issues: readonly { readonly message: string }[] }
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
