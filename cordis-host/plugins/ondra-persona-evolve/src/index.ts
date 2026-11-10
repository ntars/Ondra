/**
 * O-130 `ondra-persona-evolve`：由经历改写人格（〔研〕自研，P0）。
 *
 * ## 一句话
 *
 * 人设包给的是出厂设定，这里记的是「她被什么改变过」——只动数值，不动正文。
 *
 * ## 为什么必须自研
 *
 * 手册 §1.8 把「人格生成论阈值漂移」列进「必须自研」，理由在语料 §2.2：
 * 「缺的不是数值，是**阈值本身是变量**这一层结构」。
 * 生态里（含 `dsh-identity`）把特质当**证据**存——只记「她表现出过什么」，
 * 没有任何一处让「门槛本身随相处时间上移」。而 `threshold = base × (1 + 0.6 × min(1, n/5000))`
 * 这个式子的全部意义，就是让「以前 60 就算开心，现在要 80」成立。
 *
 * ## 与邻居的边界
 *
 * - **不改人设正文**：内核归 O-020/O-021。
 * - **不持有情绪**：六维与激素归 O-026；本插件只给「阈值应该调到多少」。
 * - **不决定哪条阈值**：`base` 由调用方传（O-028 的七阶、O-031 的六态各用各的）。
 * - **不 import 任何邻居的源码**（§18.5）：只经服务键被调用。
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
import type { Config as EvolveConfig } from './settings.js'
import { EvolveRepository } from './service.js'
import { EvolveStore } from './store.js'
import { DRIFT_RATE, DRIFT_SATURATION, PERSONA_EVOLVE_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, IdentityLike, LogLike, PersonaEvolveService, StoreLike } from './types.js'

export type * from './types.js'
export {
  DRIFT_RATE,
  DRIFT_SATURATION,
  MAX_DRIFT_RATIO,
  MAX_INTERACTIONS,
  PERSONA_EVOLVE_SERVICE_KEY,
} from './types.js'
export {
  clamp,
  driftProgress,
  effectiveThreshold,
  explainThreshold,
  maxDeltaOf,
  round2,
  traitBounds,
  traitSentence,
  traitValueOf,
} from './drift.js'
export { CONFIG_SECTION, CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS } from './settings.js'
export { TABLE_DELTA, TABLE_INTERACTION, TABLE_TRAIT, EvolveStore } from './store.js'
export { EvolveRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-persona-evolve'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。
 *
 * 注册放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤，
 * 否则重载后第二次注册会撞「段键已被占用」。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-persona-evolve: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 人格演化服务；未装载本插件时为 undefined。 */
    'ondra-persona-evolve'?: PersonaEvolveService
  }
}

/**
 * Cordis 入口：接上存储、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：人格演化的正确降级是
 * 「照常注册 + 特质一律读基线」——下游拿到的是「没被改变过的她」，
 * 而不是 `undefined`（那会让 O-023 的装配整段失效）。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: EvolveConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('persona-evolve') : 'ondra.persona.evolve') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
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

  // 2. 三张表：漂移日志必须落盘，否则重启等于「她一夜回到出厂」。
  //    这是产品语义问题（她真的变了没有），不是性能问题。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  let evolveStore: EvolveStore | undefined
  if (store === undefined) {
    log.warn('没有可用存储端口：人格漂移只活在内存里，重启等于「她一夜回到出厂」')
  } else {
    const created = new EvolveStore(store, log)
    if (created.ensure()) evolveStore = created
  }

  // 3. 注册服务。
  const service = new EvolveRepository(settings, log, () => Date.now(), evolveStore)
  ctx.effect(() => ctx.provide(PERSONA_EVOLVE_SERVICE_KEY, service), 'ondra-persona-evolve: 注册人格演化')

  // 4. 报一次现状（§12.2：可用性、降级原因都要能被自检读到，不许黑箱）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('人格演化已注册但不可用（%s）：特质一律读基线、阈值不漂移', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '人格演化就绪：%d 个特质 / %d 条漂移，存储 %s；互动 %d 次，阈值系数 ×%.2f（饱和点 %d，斜率 %.1f）',
    stats.counters.traits,
    stats.driftEntries,
    stats.storeProvider,
    stats.interactions,
    stats.factor,
    DRIFT_SATURATION,
    DRIFT_RATE,
  )
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
    ) => { readonly value: EvolveConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      return { value: completeConfig(value) }
    },
  },
}
