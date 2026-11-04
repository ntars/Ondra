/**
 * O-031 `ondra-emotion-express`：情绪六态 → 三处表达参数（〔研〕自研）。
 *
 * ## 一句话
 *
 * **六个状态名不变，三处参数只在这里出现一次。**
 *
 * ## 为什么这一项必须自研
 *
 * 手册 §1.8 把「六态映射」列在自研档：它不是「情绪识别」，
 * 而是**一组产品口径**——雀跃时句尾会翘、蔫的时候一句话说完就不想说了。
 * 生态里的情绪库能告诉你 PAD 是 (0.7, 0.6, 0.4)，
 * 但没有一个会告诉你「这个状态该把主动发言额度加一、语速快一成」。
 * 那组系数就是本插件的全部内容。
 *
 * ## 与邻居的边界（四条，全部有出处）
 *
 * - **不持有情绪**：mood / energy / tension 归 O-026，本插件只 `state()` 读一次。
 * - **不产出提示词正文**：投影文本唯一归 O-032（「一个文本出口」原则）。
 * - **不写句长百分比**：「句长 −40%」是应激倾斜，归 O-038 / O-040。
 * - **不判冲突锁**：`tension > 0.5` 只是「炸毛」的判据，锁的建立与解除归 O-030。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * `inject: ['ondra-emotion-core']` 会让情绪缺席时整个插件停在 PENDING
 * （静默不加载，宿主只在 stderr 留一行）。而本插件的正确降级是
 * **照常注册 + 按出厂基线出「平静」档**：下游能区分「没装六态映射」
 * 与「装了但读不到情绪」——后者的表现是表达全默认，而不是她忽然不会说话了。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  isRecord,
  valuesToConfigShape,
} from './settings.js'
import type { Config as ExpressConfig } from './settings.js'
import { ExpressRepository } from './service.js'
import { EXPRESS_SERVICE_KEY, STATE_ZH, STATES } from './types.js'
import type { ConfigSchemaLike, EmotionLike, ExpressService, IdentityLike, LogLike } from './types.js'

export type * from './types.js'
export {
  EXPRESS_SERVICE_KEY,
  STATE_SPECS,
  STATE_ZH,
  STATES,
} from './types.js'
export {
  BASELINE_ENERGY,
  BASELINE_MOOD,
  BASELINE_TENSION,
  ENERGY_SCALE,
  ENERGY_MAX,
  ENERGY_MIN,
  MOOD_MAX,
  MOOD_MIN,
  TENSION_MAX,
  TENSION_MIN,
  clampAxes,
  fallbackStateOf,
  matchedStateOf,
  rangeMatches,
  resolveState,
  specMatches,
} from './judge.js'
export type { Axes } from './judge.js'
export {
  PARTICLES_ZH,
  PUNCT_ZH,
  RHYTHM_SPECS,
  SHAPE_ZH,
  VOLUME_ZH,
  promptStyleOf,
  rhythmOf,
  ttsOf,
} from './specs.js'
export { CONFIG_SECTION, CONFIG_SECTION_ID, DEFAULT_CONFIG, FIELD_SPECS } from './settings.js'
export { ExpressRepository } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-emotion-express'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-emotion-express: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（四层合并不可用，退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 六态表达服务；未装载本插件时为 undefined。 */
    'ondra-emotion-express'?: ExpressService
  }
}

/**
 * Cordis 入口：接上情绪读数、注册服务。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: ExpressConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = (ctx.logger(identity ? identity.loggerName('emotion-express') : 'ondra.emotion.express') as unknown) as LogLike

  // 1. 配置：有 O-005 就走四层合并（并能说出「哪一层的哪个字段」）。
  const raw: Record<string, unknown> = isRecord(config) ? config : {}
  let effective: unknown = raw
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: raw })
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
  const service = new ExpressRepository(settings, log, () => Date.now(), () => {
    const emotion = ctx.get('ondra-emotion-core') as EmotionLike | undefined
    return emotion
  })
  ctx.effect(() => ctx.provide(EXPRESS_SERVICE_KEY, service), 'ondra-emotion-express: 注册六态表达')

  // 3. 报一次现状（§12.2：可用性、降级原因都要能被自检读到，不许黑箱）。
  const stats = service.stats()
  if (!stats.available) {
    log.warn('六态表达已注册但不可用（%s）：一律按「平静」出档，不改变任何表达参数', stats.reason ?? '未知原因')
    return
  }
  const probe = service.profileOf()
  log.info(
    '六态表达就绪：%s（mood %.2f / energy %.0f / tension %.2f），语速档 %s，主动额度 %d，数值来源 %s',
    STATE_ZH[probe.view.state],
    probe.view.mood,
    probe.view.energy,
    probe.view.tension,
    probe.tts.tempo,
    probe.rhythm.proactiveQuotaDelta,
    stats.source === 'emotion' ? '情绪服务' : '出厂基线（未接情绪服务）',
  )
  log.debug?.('六态全集：%s', STATES.map(id => `${id}=${STATE_ZH[id]}`).join(' / '))
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
    ) => { readonly value: ExpressConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // `completeConfig` 永不抛错：非法值一律回退默认，都是「能补的」。
      return { value: completeConfig(value) }
    },
  },
}
