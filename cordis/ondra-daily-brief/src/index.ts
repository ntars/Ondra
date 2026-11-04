/**
 * O-120 `ondra-daily-brief`：晨间简报（〔薄〕，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 早上第一屏只放三件事，按固定顺序：**有时限的承诺 → 昨天没说完的事 → 外面**。
 * 每段只点名一件、逐字引用上游原文，总共最多三件。
 *
 * ## 它刻意不做什么（六条）
 *
 * - **不做清单。** 一屏放三条以上就不叫简报。想全量的人去看承诺服务与待办服务，
 *   那里本来就是全量——本插件存在的理由恰恰是「不用看全量」。
 * - **不报数字。** 没有「你还有 7 条待办」。数字会被当成进度条，然后开始对着进度条过日子。
 *   宁可点名具体那一件。
 * - **不装定时器、不推送。** 「早上 7 点自动生成」看着顺手，代价是插件多了一条
 *   没人要求的唤醒路径，会在主人没看的时候把上游全叫一遍。什么时候看归应用外壳与主人。
 * - **不算任何东西。** 承诺归 O-016、记忆归 O-010、节气归 O-046、天气归 O-047。
 *   本插件只**选择与排序**，一个数都不重新定义。想加「今日完成度」这类指标时，
 *   那句话本身就是第二个真源。
 * - **不发消息。** 发出去归 O-042 主动投递闸。本插件的契约里连发送服务都不取。
 * - **不做界面。** 渲染归应用外壳（`desktop/`）。本插件只交 `DailyBrief` 结构化数据。
 *
 * ## 依赖纪律
 *
 * 六项依赖（时钟 / 身份 / 承诺 / 记忆 / 日期 / 天气）**全是软依赖**，故刻意不声明插件级
 * `inject`：缺哪一段就在那一段说「这块今天读不到」，其余照常出。
 * 若声明 `inject`，缺天气时整包会停在 PENDING——那时连「天气没装」这句话都读不到，
 * 正是最需要它的场景失效。
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
import type { Config as BriefConfig } from './settings.js'
import { DailyBrief } from './service.js'
import { DAILY_BRIEF_SERVICE_KEY, MAX_ITEMS } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  DailyBriefService,
  IdentityLike,
  LiveLike,
  LogLike,
  MemoryCoreLike,
  ProspectiveLike,
  WeatherLike,
} from './types.js'

export type * from './types.js'
export {
  DAILY_BRIEF_SERVICE_KEY,
  MAX_ITEMS,
  BRIEF_SLOTS,
  SLOT_SPECS,
  ITEM_STATES,
  BRIEF_ERROR_CODES,
  BriefError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  CONFIG_SECTION,
  completeConfig,
} from './settings.js'
// 与下面的 `const Config`（标准 schema 校验器）共存：类型空间与值空间各占一个名字。
import type { Config as SettingsConfig } from './settings.js'
export type Config = SettingsConfig
export { CARRY_URGENT_MS, sourceOf, dueItemOf, carryItemOf, summaryOf } from './aggregate.js'
export type { DueCandidate, CarryCandidate } from './aggregate.js'
export { ambientItemOf } from './ambient.js'
export { DailyBrief } from './service.js'
export type { DailyBriefDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-daily-brief'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-daily-brief: 注册配置段')
    return true
  } catch (error) {
    log.warn(
      '向 ondra-config-schema 注册配置段失败（四层合并与来源追溯不可用，退回插件实例配置）：%s',
      messageOf(error),
    )
    return false
  }
}

/**
 * 本插件**不声明** `inject`：六项依赖全是软依赖，缺谁都能出简报。
 *
 * 写在这里是给未来的自己看的：简报最容易顺手接上「到点自动推」，
 * 接上之后它就有了一条自己开口的路径，而那条路径不经过 O-042 主动投递闸。
 */

declare module '@ntars/cordis' {
  interface Context {
    /** 晨间简报服务；未装载本插件时为 undefined。 */
    'ondra-daily-brief'?: DailyBriefService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: BriefConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('daily-brief') : 'ondra.daily-brief')

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

  // 3. 依赖全部用取值函数：上游晚装载时能自愈，早卸载时立刻反映。
  const brief = new DailyBrief({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    prospective: () => ctx.get('ondra-memory-prospective') as ProspectiveLike | undefined,
    core: () => ctx.get('ondra-memory-core') as MemoryCoreLike | undefined,
    live: () => ctx.get('ondra-live') as LiveLike | undefined,
    weather: () => ctx.get('ondra-weather') as WeatherLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(DAILY_BRIEF_SERVICE_KEY, brief), 'ondra-daily-brief: 注册晨间简报服务')

  // 4. 报一次现状。缺席的上游要能被自检读到，不许黑箱。
  //    刻意**不在 apply 里出简报**：装载期上游可能还没就绪，那时出的是三段「读不到」。
  const absent: string[] = []
  if (ctx.get('ondra-memory-prospective') === undefined) absent.push('承诺与待办（前两段读不到）')
  if (ctx.get('ondra-memory-core') === undefined) absent.push('记忆内核（已删掉的承诺无法被跳过）')
  if (ctx.get('ondra-live') === undefined) absent.push('日期事实（「外面」那段只剩天气）')
  if (ctx.get('ondra-weather') === undefined) absent.push('天气（「外面」那段只剩节气与节日）')
  if (ctx.get('ondra-clock') === undefined) absent.push('时钟（自然日退回本机时区）')

  log.info(
    '晨间简报就绪：%s（最多 %d 段，只在被调用时生成；不装定时器、不推送、不落盘）',
    brief.available ? '可用' : `不可用（${brief.reason ?? '未知'}）`,
    MAX_ITEMS,
  )
  if (absent.length > 0) {
    log.info('以下上游未装载，对应那一段会显示「这块今天读不到」而不是「今天没有」：%s', absent.join('；'))
  }
  if (!settings.includeAmbient) {
    log.info('「外面」那一段已关掉（include-ambient=false）：只出承诺与悬着的事两段')
  }
  if (!settings.enable) {
    log.warn('晨间简报已关闭（enable=false）：服务照常注册，brief() / ack() 一律抛 disabled')
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。三个字段都是布尔，
 * 任何非法值都能安全退回默认，因此永远不产 issue——配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: BriefConfig } | { readonly issues: readonly { readonly message: string }[] }
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
