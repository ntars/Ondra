/**
 * O-115 `ondra-ritual`：节气仪式（〔复〕复用档，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 回答两个连着的问题：**「今天是什么日子？」** 和 **「这一天适合做一件什么事？」**
 *
 * 前一半完全来自 O-046 `ondra-live`（节气 / 农历节日），本插件**一行历法都不算**；
 * 后一半是查一张写死在代码里的仪式表，给一句方向 + 一个具体动作。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不算农历、不算节气。** 农历是一张要按年维护的表（闰月、定朔、节气时刻），
 *   上游已经做过接线与双分支对拍；在这里重写的唯一后果是两个真源，
 *   而错的那个不会报错，只会把立冬说成大寒。
 * - **不编节日。** 表里没有的日子一律报「今天没有可确认的仪式」。
 *   编一个不存在的节气，比没有仪式糟得多——用户会当真的用。
 * - **一个数字都不给。** 不说「距离冬至还有多少天」，也不说「这是第几个节气」。
 *   倒计时会把一个日子变成一条进度条。
 * - **不提醒、不装定时器、不主动发送。** 没有 `setInterval` / `setTimeout`，
 *   也没有任何「每天零点」的东西。要不要说、什么时候说，归 O-042 的六道闸；
 *   本插件只在她问起「今天是什么日子」时给事实。
 * - **不做界面、不落盘。** 仪式表与择取都是纯函数，没有存档，
 *   也就不存在「今天做过了没有」这种会被拿来评价她的记录。
 *
 * ## 依赖纪律
 *
 * 四项全是**软依赖**（日期 / 时钟 / 天气 / 身份），故不声明插件级 `inject`。
 * 任一缺席都能跑，只是降级——降级处各有一行日志，不静默。
 * 最要紧的那条降级是：**没有 `ondra-live` 就明说没有可确认的仪式**，
 * 而不是拿公历季节凑一条出来。
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
import type { Config as RitualConfig } from './settings.js'
import { Ritual } from './service.js'
import { RITUAL_COUNT } from './table.js'
import { RITUAL_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LiveLike,
  LogLike,
  RitualService,
  WeatherLike,
} from './types.js'

export type * from './types.js'
export {
  RITUAL_SERVICE_KEY,
  NAME_RE,
  SEASONS,
  RitualError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  UPCOMING_FLOOR,
  UPCOMING_CEILING,
  SCAN_FLOOR,
  SCAN_CEILING,
  completeConfig,
} from './settings.js'
export {
  RITUAL_TABLE,
  RITUAL_COUNT,
  UNIVERSAL_MUST_NOT,
  SEASON_LABEL,
} from './table.js'
export type { RitualEntry } from './table.js'
export { classifyDay, pickUpcoming, planOf, seasonOf, solarOnlyDay } from './ritual.js'
export type { PlanOptions } from './ritual.js'
export { Ritual } from './service.js'
export type { RitualDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-ritual'

/**
 * 本插件**不声明** `inject`：四项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：这个插件最容易被加上的东西是一个「每天提醒」的定时器，
 * 而它一旦加上，就会绕过 O-042 的静默时段与日额度。**不要加。**
 */

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 向 O-005 注册配置段。放进 `ctx.effect`：段是本插件的资源，卸载时必须一起撤。
 * @param ctx 宿主上下文。
 * @param schema 配置真源服务。
 * @param log 日志。
 * @returns 注册是否成功。
 */
function registerSection(ctx: Context, schema: ConfigSchemaLike, log: LogLike): boolean {
  try {
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-ritual: 注册配置段')
    return true
  } catch (error) {
    log.warn(
      '向 ondra-config-schema 注册配置段失败（四层合并与来源追溯不可用，退回插件实例配置）：%s',
      messageOf(error),
    )
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 节气仪式服务；未装载本插件时为 undefined。 */
    'ondra-ritual'?: RitualService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: RitualConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('ritual') : 'ondra.ritual')

  const raw: unknown = isRecord(config) ? config : {}
  let effective: unknown = raw

  // 1. 有 O-005 就让配置走四层合并（出问题时能说出「哪一层的哪个字段」）。
  const schema = ctx.get('ondra-config-schema') as ConfigSchemaLike | undefined
  if (schema !== undefined && registerSection(ctx, schema, log)) {
    try {
      const resolved = schema.resolve(CONFIG_SECTION_ID, { user: normalizeUserLayer(raw) })
      if (resolved !== undefined) {
        effective = valuesToConfigShape(resolved.values)
        if (resolved.fallbackCount > 0) {
          // 回退是静默的危险动作：不报数等于埋雷（O-005 原话）。
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }

  // 2. 补全。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 建服务。三个上游都用取值函数：晚装载时能自愈，早卸载时立刻退回降级。
  const service = new Ritual({
    settings,
    log,
    live: () => ctx.get('ondra-live') as LiveLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    weather: () => ctx.get('ondra-weather') as WeatherLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(RITUAL_SERVICE_KEY, service), 'ondra-ritual: 注册节气仪式服务')

  // 4. 报一次现状：仪式表有几条必须能被自检读到，否则「表里没有就报无仪式」无从核对。
  log.info(
    '节气仪式就绪：%s（仪式表 %d 条；节日%s；不做提醒、不装定时器）',
    service.available ? '可用' : '不可用',
    RITUAL_COUNT,
    settings.includeFestivals ? '纳入' : '不纳入',
  )
  if (!settings.enable) {
    log.warn('节气仪式已关闭（enable=false）：服务照常注册，today() / upcoming() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。五个字段互不相干，
 * 越界会被夹到区间内，因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: RitualConfig } | { readonly issues: readonly { readonly message: string }[] }
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
