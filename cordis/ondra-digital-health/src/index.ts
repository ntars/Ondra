/**
 * O-105 `ondra-digital-health`：数字健康护栏（〔薄〕薄封装，L9 扩展池）。
 *
 * ## 它到底做什么
 *
 * 回答一个问题：**「这个人已经连着用了多久？此刻该不该劝一句？」**
 * 计时、日历、跨天、时区四件事全走 O-003 `ondra-clock`，本插件只做
 * 「阈值判定 + 提醒水位」这一层——这正是 §3.8 对薄封装的定义。
 *
 * ## 它刻意不做什么（五条）
 *
 * - **不自己发消息。** 只产出 `advise()`；把话真正说出来归 O-042 与 O-047。
 *   自己发就绕过了静默时段、日额度、去重、风控退避那一整套节制闸。
 * - **不打点键盘鼠标。** 谁在活动由调用方告诉我们。全局键鼠监听要辅助功能
 *   授权，不该由一个护栏插件顺带索取——那是 O-111 的活，且它默认关闭。
 * - **不存任何正文。** 只有时间戳与毫秒数。不存窗口标题、不存应用名、不截屏。
 * - **不出健康分。** 一旦有「今日健康分 62」，第二天就有人为了这个数关掉护栏。
 * - **不做界面。** L8 界面插件已整批下线，渲染归应用外壳（`desktop/`）。
 *
 * ## 依赖纪律
 *
 * 三项软依赖（时钟 / 路径 / 配置真源）+ 一项可选（身份，只为日志命名空间）。
 * **一项硬依赖都没有**，故不声明插件级 `inject`：缺任何一项都能起来，
 * 只是降级，而降级在 `stored` 与日志里都看得见。
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
import type { Config as DigitalHealthConfig } from './settings.js'
import { DigitalHealth } from './service.js'
import { DIGITAL_HEALTH_SERVICE_KEY } from './types.js'
import type {
  ClockLike,
  ConfigSchemaLike,
  DigitalHealthService,
  IdentityLike,
  LogLike,
  PathLike,
} from './types.js'

export type * from './types.js'
export {
  DIGITAL_HEALTH_SERVICE_KEY,
  NAME_RE,
  STATE_FILE_NAME,
  STATE_VERSION,
  HEALTH_LEVELS,
  HEALTH_SIGNALS,
  LEVEL_ORDER,
  DigitalHealthError,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  CONFIG_SECTION,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  HHMM_RE,
  completeConfig,
} from './settings.js'
export {
  emptyState,
  normalizeState,
  minutesOf,
  maxLevel,
  derive,
  pulseState,
  judge,
  noteOf,
  snapshotOf,
} from './health.js'
export type { HealthState, JudgeInput, JudgeResult } from './health.js'
export { readState, writeState } from './store.js'
export type { LoadResult } from './store.js'
export { DigitalHealth } from './service.js'
export type { DigitalHealthDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-digital-health'

/**
 * 本插件**不声明** `inject`：没有任何硬依赖。
 *
 * 这一点写在代码里是给未来的自己看的：护栏插件最容易被顺手加上
 * 「屏幕感知」（O-109）或「键鼠反应」（O-111）当硬依赖，
 * 而那两个都默认关闭、都要系统授权——一旦成了硬依赖，
 * 关掉它们就等于把护栏也一起关掉。
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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-digital-health: 注册配置段')
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
    /** 数字健康护栏服务；未装载本插件时为 undefined。 */
    'ondra-digital-health'?: DigitalHealthService
  }
}

/**
 * Cordis 入口：解析配置、建服务、注册。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: DigitalHealthConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('digital-health') : 'ondra.digital-health')

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
  const service = new DigitalHealth({
    settings,
    log,
    path: () => ctx.get('ondra-path-layout') as PathLike | undefined,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  // 4. 注册服务，并在卸载时**先落盘再撤服务**。
  //    顺序反了的话，最后 60 秒的打点会跟着进程一起消失，而日志里什么也看不出来。
  ctx.effect(() => {
    const dispose = ctx.provide(DIGITAL_HEALTH_SERVICE_KEY, service)
    return () => {
      service.flush()
      dispose()
    }
  }, 'ondra-digital-health: 注册数字健康护栏服务')

  // 5. 报一次现状。可用性与依赖到位情况都要能被自检读到，不许黑箱。
  log.info(
    '数字健康护栏就绪：%s（连续 %d 分钟开始劝 / %d 分钟收工，休息门槛 %d 分钟）',
    service.available ? '可用' : '不可用（enable=false）',
    settings.sessionWarnMinutes,
    settings.sessionStopMinutes,
    settings.breakMinutes,
  )
  if (ctx.get('ondra-path-layout') === undefined) {
    log.info('路径服务未装载：护栏只在内存，重启后当日累计会清零')
  }
  if (ctx.get('ondra-clock') === undefined) {
    log.info('时钟服务未装载：自然日与深夜窗改按本机时区算（口径相同，仅夏令时极端情形差一天）')
  }
  if (settings.lateNightStart === settings.lateNightEnd) {
    // 与 O-003 同一条语义：起点等于终点是**空窗**，不是整天。
    log.warn('深夜窗起止相同（%s）：按空窗处理，深夜信号永远不会触发', settings.lateNightStart)
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。八个字段都能安全补全
 * （数字夹到区间内、`HH:MM` 形状不对就回退），因此永远不产 issue——
 * 配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: DigitalHealthConfig }
      | { readonly issues: readonly { readonly message: string }[] }
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
