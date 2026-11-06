/**
 * O-108 `ondra-absence`：空窗期礼仪（〔研〕自研，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 回答一句话：**「隔了很久回来，第一句该怎么接？」**
 *
 * 五档分级（今天 / 昨天 / 几天 / 一阵子 / 很久），每档只给：必须做到的事、
 * 绝对不许做的事、句数上限、要不要承认隔了一段、允不允许一点温度。
 * **一个数字都不给**，连「多久」也只以五个粗粒度词出现。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不报精确间隔。** 「我们 17 天没说话了」不是关心，是把重逢变成审讯。
 * - **不问对方去哪了。** 契约里 `askAboutGap` 的类型就是字面量 `false`——
 *   做成 boolean 就一定会有 `true` 分支，而那个分支一定会在某次「关心一下」里被打开。
 * - **不替空窗期编造情节。** 「我一直在等你」是施压，不是深情。
 * - **不主动发消息。** 要不要在她回来之前主动找她，归 O-042 的静默与额度；
 *   本插件只管「她已经回来了」那一刻。
 * - **不做界面。** L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
 *
 * ## 依赖纪律
 *
 * 四项全是**软依赖**（身份 / 时钟 / 路径 / 配置），故不声明插件级 `inject`。
 * 任一缺席都能跑，只是降级——降级处各有一行日志，不静默。
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
import type { Config as AbsenceConfig } from './settings.js'
import { Absence } from './service.js'
import { ABSENCE_SERVICE_KEY } from './types.js'
import type {
  AbsenceService,
  ClockLike,
  ConfigSchemaLike,
  IdentityLike,
  LogLike,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  ABSENCE_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  STATE_VERSION,
  ABSENCE_TIERS,
  TIER_ORDER,
  COARSE_GAPS,
  COARSE_OF,
  AbsenceError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  SENTENCE_CAP_FLOOR,
  SENTENCE_CAP_CEILING,
  completeConfig,
} from './settings.js'
export {
  emptyState,
  normalizeState,
  gapOf,
  tierOf,
  planOf,
  noteOf,
  coarseZhOf,
  maxTier,
  minutesOf,
} from './gap.js'
export type { AbsenceState } from './gap.js'
export { Absence } from './service.js'
export type { AbsenceDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-absence'

/**
 * 本插件**不声明** `inject`：四项依赖全是软依赖，缺谁都能跑。
 *
 * 写在这里是给未来的自己看的：空窗期最容易顺手接上「主动找她」，
 * 接上之后它就有了一条能自己开口的路径，而那条路径不经过六道闸。
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-absence: 注册配置段')
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
    /** 空窗期礼仪服务；未装载本插件时为 undefined。 */
    'ondra-absence'?: AbsenceService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: AbsenceConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('absence') : 'ondra.absence')

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

  // 3. 建服务。时钟与路径都用取值函数：上游晚装载时能自愈，早卸载时立刻退回降级。
  const service = new Absence({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(ABSENCE_SERVICE_KEY, service), 'ondra-absence: 注册空窗期礼仪服务')

  // 4. 报一次现状。四道阈值必须能被自检读到，不许黑箱。
  log.info(
    '空窗期礼仪就绪：%s（%dh / %dd / %dd / %dd 四道阈值，句数上限 %d；只给约束不给台词）',
    service.available ? '可用' : '不可用',
    settings.briefHours,
    settings.noticedDays,
    settings.longDays,
    settings.distantDays,
    settings.maxSentencesCap,
  )
  if (!settings.enable) {
    log.warn('空窗期礼仪已关闭（enable=false）：服务照常注册，touch() / mention() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。四道阈值越界会被夹到区间内，
 * 顺序写反会被抬到前一道之上，因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: AbsenceConfig } | { readonly issues: readonly { readonly message: string }[] }
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
