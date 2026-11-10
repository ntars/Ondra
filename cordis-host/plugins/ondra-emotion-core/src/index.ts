/**
 * O-026 `ondra-emotion-core`：情绪状态的持有者（〔研〕自研）。
 *
 * ## 为什么这一项必须自研
 *
 * 手册 §1.8 把「情绪」列在自研档，不是没有生态可用，而是**没有生态可用得对**：
 * 现成的情感分析库给的是「这句话是正面还是负面」，那是**读别人**；
 * 本插件要的是「她自己现在怎么样」，那是**读自己**。两者的输入完全不同。
 *
 * 真正自研的只有四样：
 *
 * 1. **六维指数回归**（§3.2）。闭式函数而非步进衰减——挂机不关不该让她忘得更快。
 * 2. **化学池的三层结构**（§3.9）：激素回归 + 血清素两条慢变量 + 气质四旋钮。
 *    其中「既按分钟抽、又越过阈值一次性扣」这一条，是原始实现踩过坑之后
 *    特意写进手册的：两处都扣会互相放大，几分钟就把血清素打到 0。
 * 3. **存档缺字段按基线补，不按 0 补**（§3.2）。0 在界面上等于「极度烦躁」。
 * 4. **PAD 与标签两条独立通道**（`labels.ts` 文件头）。不投影，是因为投影要用
 *    一张没有出处的权重表。
 *
 * ## 与邻居的边界
 *
 * - **不管表达**：六态映射（雀跃/软和/平静/蔫/炸毛/困）归 **O-031**。
 *   本插件只给数字，不给形容词——形容词一进来，这套东西就变成了硬编码的剧本。
 * - **不管应激倍率**：cortisol ≥80 时检索权重的倾斜归 **O-029**。
 * - **不管冲突锁**：锁的建立与解除归 **O-030**。本插件只回答「张力过没过线」。
 * - **不管体力**：§3.10 末尾明写「`emotion-core` 的 energy 是情绪维度，不是体力」，
 *   真正的能量回血与作息归 **O-048**。
 * - **不 import 任何邻居的源码**（§18.5）：只用「结构对位」的镜像接口。
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
import type { Config as EmotionConfig } from './settings.js'
import { EmotionRepository } from './service.js'
import { StateStore } from './store.js'
import { EMOTION_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, EmotionService, EmotionUnavailableReason, IdentityLike, LogLike, StoreLike } from './types.js'

export type * from './types.js'
export {
  AXES,
  AXIS_SPEC,
  CORE_HORMONES,
  CORE_HORMONE_SPEC,
  DYNAMIC_HORMONE_SPEC,
  DEFAULT_TEMPERAMENT,
  EmotionError,
  LABELS,
  LABEL_MAX,
  LABEL_ZH,
  LABEL_HALF_LIFE_MINUTES,
  MAX_DYNAMIC_HORMONES,
  SEROTONIN_RECOVER_ENERGY,
  SEROTONIN_RECOVER_RATE,
  SEROTONIN_RECOVER_TENSION,
  SEROTONIN_STRESS_RATE,
  SEROTONIN_STRESS_THRESHOLD,
  EMOTION_SERVICE_KEY,
} from './types.js'
export {
  AXIS_HALF_LIFE,
  MAX_HORMONE_STEP,
  MAX_STEP,
  MOOD_COUPLING,
  axisDelta,
  clampAxis,
  elapsedMinutes,
  halfLifeWith,
  labelDelta,
  regressTowards,
  settleAxis,
} from './pad.js'
export { applyLabels, clampLabel, dominantOf, emptyLabels, parseLabels, settleLabels } from './labels.js'
export {
  MAX_SETTLE_STEPS,
  SEROTONIN_CROSS_PENALTY,
  STEP_MINUTES,
  applyHormone,
  baselineOf,
  createPool,
  hormoneOf,
  parsePool,
  settlePool,
  specOf,
} from './hormones.js'
export type { HormonePool } from './hormones.js'
export { TABLE_STATE, StateStore } from './store.js'
export type { RawStateRow, StateWrite } from './store.js'
export { COMFORT_STEP, EmotionRepository, parseAxes, parseTemperament } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-emotion-core'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-emotion-core: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 情绪内核服务；未装载本插件时为 undefined。 */
    'ondra-emotion-core'?: EmotionService
  }
}

/**
 * Cordis 入口：接上存储端口、读一次存档、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：声明 `inject: ['ondra-store-sqlite']` 之后，
 * 存储缺席会让整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 改成「照常注册 + 内存态运行」，下游能区分「没装情绪内核」与
 * 「装了但没有存储」——后者的表现是重启后情绪归零，而不是她不说话。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: EmotionConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('emotion-core') : 'ondra.emotion-core') as unknown) as LogLike

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

  // 2. 存储端口：情绪要跨会话存活，否则「昨天还在生气」今天早上就忘了。
  const store = (ctx.get('ondra-store-sqlite') ?? ctx.get('ondra-store-memory')) as StoreLike | undefined
  let stateStore: StateStore | undefined
  let reason: EmotionUnavailableReason | undefined

  if (!settings.enable) {
    reason = 'disabled'
    log.info('情绪内核被配置关闭：服务仍注册，所有读操作返回基线状态')
  } else if (store === undefined) {
    reason = 'no-store'
    log.warn('没有可用存储端口：情绪状态只活在内存里，重启即归零')
  } else {
    const created = new StateStore(store, log)
    if (created.ensure()) {
      stateStore = created
    } else {
      reason = 'schema-failed'
    }
  }

  // 3. 造服务并读一次存档。
  const service = new EmotionRepository(settings, log, () => Date.now(), stateStore, reason)
  const loaded = service.load()
  ctx.effect(() => ctx.provide(EMOTION_SERVICE_KEY, service), 'ondra-emotion-core: 注册情绪内核')

  // 4. 报一次现状。可用性、降级原因、激素种数都要能被自检读到，不许黑箱（§12.2）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('情绪内核已注册但不可用（%s）', stats.reason ?? '未知原因')
    return
  }
  log.info(
    '情绪内核就绪：激素 %d 种（动态 %d 种），张力阈值 %s，心情基线 %s',
    Object.keys(loaded.hormones).length,
    stats.dynamicHormones,
    settings.tensionHighThreshold,
    loaded.axes.mood.toFixed(2),
  )
  if (stats.reason !== undefined) {
    log.warn('情绪内核以降级状态运行：%s', stats.reason)
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
    ) => { readonly value: EmotionConfig } | { readonly issues: readonly { readonly message: string }[] }
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
