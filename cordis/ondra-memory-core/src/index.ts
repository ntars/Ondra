/**
 * O-010 `ondra-memory-core`：记忆内核（〔研〕自研）。
 *
 * 为什么是自研：手册 §1.8 把「记忆底层存储 / 检索 / 去重 / 衰减」列为可复用档，
 * 本插件**把存储与检索全部交了出去**——建表、事务、CRUD 走 O-006 / O-007，
 * 一个字都不重写。真正自研的只有三样生态里没有的东西：
 *
 * 1. **11 类基线乘积式寿命**（P0）。生态里的记忆库清一色「一个半衰期配所有条目」，
 *    没有「看片 2 小时 / 自我 20000 小时」这种差四个数量级的分类基线。
 *    这不是实现差异，是**产品参数**，只能自己算。
 * 2. **双层表 + 四态删除**（原文层不被衰减、墓碑不许复活）。生态方案要么只存提炼结果
 *    （原文一删，逐字引文校验就没有比对源），要么只存原文（没有寿命可言）。
 * 3. **写入打分表**。这是中文语料专用的启发式（「第一次」「一辈子」「没什么」），
 *    没有任何通用库能提供。
 *
 * 与 O-013 的边界：**本插件只管「这条本来能活多久」，不管「现在衰减到多少」**。
 * 衰减扫描、SM-2 复习排期是 O-013 的活；本插件只保证 `strengthOf()` 这个纯函数
 * 给出的强度是全仓唯一口径。
 *
 * 与 O-014 的边界（P0 红线）：**本插件不排序、不裁剪、不 topK**。
 * 「召回不按条数砍，`dropped` 恒为 0」是 O-014 的硬指标。任何在这里加 `topK` 的改动
 * 都会让那条红线在无人察觉的情况下失效——因为砍在这里，O-014 的 `dropped` 依然是 0。
 */

import type { Context } from '@ntars/cordis'
import { MemoryRepository } from './repository.js'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  normalizeUserLayer,
  valuesToConfigShape,
} from './settings.js'
import type { Config as MemoryConfig } from './settings.js'
import { MEMORY_CORE_SERVICE_KEY } from './types.js'
import type {
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  MemoryCoreService,
  StoreLike,
} from './types.js'

// 契约里既有纯类型也有运行时值（服务键、错误类、正则），分开导出才不违背
// 「类型导入不得混入运行时值」这条自检项。
export type * from './types.js'
export { MEMORY_CORE_SERVICE_KEY, MemoryError, MEMORY_ID_RE, MEMORY_CATEGORIES, MEMORY_KINDS, MEMORY_CHANNELS } from './types.js'
export { STABILITY_BASE_HOURS, CHANNEL_DAYS, stabilityOf, strengthAt, scoreText, mentionFactor, hitFactor } from './stability.js'
export type { StabilityParams, ScoreParams } from './stability.js'
export { digestOf } from './repository.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-memory-core'

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
function registerSection(
  ctx: Context,
  schema: ConfigSchemaLike,
  log: LogLike,
): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-memory-core: 注册配置段')
    return true
  } catch (error) {
    // 注册失败不是致命：四层合并与来源追溯用不上，但插件实例配置照样能跑。
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 记忆内核服务；未装载本插件时为 undefined。 */
    'ondra-memory-core'?: MemoryCoreService
  }
}

/**
 * Cordis 入口：接上存储端口、建表、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-store-sqlite']` 后，
 * 后端缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「取不到就不注册服务」，下游 `ctx.get('ondra-memory-core')` 得到 undefined，
 * 走它自己的降级分支——这是 §3.3-1 的原话（`if (!svc) return`）。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: MemoryConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('memory-core') : 'ondra.memory-core') as unknown) as LogLike

  // 1. 存储端口。两个后端实现同一接口，**只取一个、只写一个**——
  //    同时写两个就是双真源，比没有后端更糟。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  if (store === undefined) {
    log.warn('找不到可用的存储端口（ondra-store-sqlite / ondra-store-memory 都不在），本插件不注册服务')
    return
  }

  // 2. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
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

  // 3. 建表 + 构造服务。建表放在 `ctx.effect` 里：卸载时不需要额外动作，
  //    但把它登记成 effect 能让 `getEffects()` 看见「本插件做过一次建表」。
  const repository = new MemoryRepository(store, settings, log, () => Date.now())
  ctx.effect(() => {
    const issues = repository.ensure()
    if (issues.length > 0) {
      for (const issue of issues.slice(0, 5)) log.warn('建表问题（%s）：%s', issue.code, issue.detail)
      if (issues.length > 5) log.warn('建表问题还有 %d 条，详见 stats().issues', issues.length - 5)
    }
    return () => undefined
  }, 'ondra-memory-core: 建表')

  ctx.effect(() => ctx.provide(MEMORY_CORE_SERVICE_KEY, repository), 'ondra-memory-core: 注册记忆内核')

  // 4. 报一次现状。可用性、后端、表行数都要能被自检读到，不许黑箱（§12.2）。
  if (!repository.available) {
    log.error('记忆内核已注册但不可用（%s）：下游应跳过记忆读写而不是崩溃', repository.reason ?? '未知原因')
    return
  }

  const stats = repository.stats()
  log.info(
    '记忆内核就绪：后端 %s，原文 %d 条 / 事实 %d 条 / 墓碑 %d 条（活跃 %d、沉底 %d、封存 %d）',
    stats.provider,
    stats.tables.raw,
    stats.tables.fact,
    stats.tables.tombstone,
    stats.states.active,
    stats.states.archived,
    stats.states.sealed,
  )
  if (!store.caps.persist) {
    // 内存后端能跑，但「她记得你」这件事在进程退出那一刻归零。必须说出来。
    log.warn('当前跑在内存后端：记忆不会落盘，进程退出即丢。请检查 SQLite 是否可用')
  }
  if (!settings.scoreOnWrite) {
    log.warn('scoreOnWrite=false：写入不打分，全部按 50 分等权（仅应出现在对拍调试时）')
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
    ) => { readonly value: MemoryConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // `completeConfig` 永不抛错，所以这里永远不会产出 issue：
      // 越界值被夹紧、类型错回退默认，都是「能补的」。真正补不了的（例如整个配置不是对象）
      // 也已按空对象处理——那等于「全用默认」，仍然是能跑的。
      return { value: completeConfig(value) }
    },
  },
}
