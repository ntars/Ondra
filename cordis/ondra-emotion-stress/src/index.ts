/**
 * O-029 `ondra-emotion-stress`：应激注意力倍率（〔研〕自研）。
 *
 * ## 一句话
 *
 * `weight = 原始相关度 × 注意力倍率 × 情绪共鸣微调` —— **只改顺序，不改内容**。
 *
 * ## 为什么这一项必须自研
 *
 * 手册 §1.8 把「应激倍率」列进自研档（P0 第九条补丁点，§1608 行）：
 * 生态里的重排器都是「按分数排序 + 截断」，没有一个会按**内分泌状态**
 * 改变「什么值得看」——而这正是本条的全部内容：
 * 危机时她只看得见威胁，日常偏好被压到十分之一。
 *
 * 真正自研的东西只有两样：**危机 / 日常两类不同的斜率**与
 * **「只改顺序不改内容」这条硬约束的接口形状**（`dropped: 0` 字面量）。
 * 二阶的东西都不是新的：线性插值是手册原话，皮质醇与半衰期是 O-026 的。
 *
 * ## 与邻居的边界
 *
 * - **不持有情绪**：皮质醇归 O-026，本插件只 `state()` 读一次。
 * - **不判类别**：危机 / 日常是条目属性，由 O-010 / O-014 带进来。
 * - **不写提示词正文**：正文逐字取手册 §4.3 的示例；进来的顺序归 O-036。
 * - **不 import 任何邻居的源码**（§18.5）：只用结构对位镜像。
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
import type { Config as StressConfig } from './settings.js'
import { StressRepository } from './service.js'
import { BAND_ZH, STRESS_SERVICE_KEY } from './types.js'
import type { ConfigSchemaLike, EmotionLike, IdentityLike, LogLike, StressService } from './types.js'

export type * from './types.js'
export {
  BAND_ZH,
  CALM_CEILING,
  CORTISOL_MAX,
  CORTISOL_MIN,
  CRISIS_FLOOR,
  CRISIS_PEAK,
  DAILY_TROUGH,
  DEFAULT_CORTISOL,
  MIN_FRAGMENT_ORDER,
  STRESS_SERVICE_KEY,
} from './types.js'
export {
  bandOf,
  clampCortisol,
  crisisWeightOf,
  dailyWeightOf,
  multiplierAt,
  pickMultiplier,
  rankOf,
  weightOfItem,
} from './stress.js'
export { STRESS_DIRECTIVE_TEXT, buildDirective } from './directive.js'
export type { DirectiveSettings } from './directive.js'
export { CONFIG_SECTION, CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS } from './settings.js'
export { StressRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-emotion-stress'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-emotion-stress: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 应激倍率服务；未装载本插件时为 undefined。 */
    'ondra-emotion-stress'?: StressService
  }
}

/**
 * Cordis 入口：接上情绪读数、注册服务。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：`inject: ['ondra-emotion-core']` 会让情绪缺席时
 * 整个插件停在 PENDING（静默不加载，最难查的失败形态）。
 * 而本插件的正确降级是「照常注册 + 倍率恒为 ×1」：
 * 下游能区分「没装应激倍率」与「装了但读不到皮质醇」——
 * 后者的表现是排序不变，而不是她忽然变得没心没肺。
 *
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: StressConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('emotion-stress') : 'ondra.emotion.stress') as unknown) as LogLike

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

  // 2. 情绪读数用**延迟取值**：装载顺序不确定，构造时拿不到不代表以后拿不到。
  const service = new StressRepository(settings, log, () => Date.now(), () => {
    const emotion = ctx.get('ondra-emotion-core') as EmotionLike | undefined
    return emotion
  })
  ctx.effect(() => ctx.provide(STRESS_SERVICE_KEY, service), 'ondra-emotion-stress: 注册应激倍率')

  // 3. 报一次现状（§12.2：可用性、降级原因都要能被自检读到，不许黑箱）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('应激倍率已注册但不可用（%s）：所有倍率恒为 ×1，排序不受影响', stats.reason ?? '未知原因')
    return
  }
  const probe = service.multiplierOf()
  log.info(
    '应激倍率就绪：皮质醇 %d（%s），危机类 ×%.2f / 日常类 ×%.2f，片段排序键 %d，皮质醇来源 %s',
    probe.cortisol,
    BAND_ZH[probe.band],
    probe.crisis,
    probe.daily,
    settings.directiveOrder,
    stats.cortisolSource === 'emotion' ? '情绪服务' : '出厂基线（未接情绪服务）',
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
    ) => { readonly value: StressConfig } | { readonly issues: readonly { readonly message: string }[] }
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
