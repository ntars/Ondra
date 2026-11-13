/**
 * O-046 `ondra-live`：日期事实（公历 / 星期 / 农历 / 节气 / 节日），本机算。
 *
 * ## 它为什么是〔复〕而不是〔研〕
 *
 * 手册 §1.8 把「农历」列进复用档，§1.7 又点名 `lunar-javascript` / `tyme4ts` 双分支对拍。
 * 本插件**一行农历算法都不写**：只做接线（`branches/`）、对拍（`select.ts` / `crosscheck()`）、
 * 降级（没有包就只有公历）。自己写农历就是一年一调的历法表，写错是节气差一天。
 *
 * ## 出厂态：只有公历，这是正常的
 *
 * 本仓禁装依赖，所以第一次启动必然没有农历。此时：
 *
 * - `available = true`（功能开着）；
 * - `lunarReady = false`（农历不在位）；
 * - `facts().lunar = null`，`text()` 只说公历、星期、公历节日；
 * - 日志一行 info 说明装哪个包能补上农历。
 *
 * **不报错、不阻断、不编数据**。装包后调 `refresh()` 即可热接上，不必重启。
 *
 * ## 明确不做
 *
 * - **不联网**：不查黄历接口、不校时。全部本机算（手册 §4「日期事实，本机算」）。
 * - **不注入提示词**：本插件只提供 `text()`，注入位置与预算归 O-036；前缀冻结归 O-033。
 * - **不算运势、宜忌、八字**：那是另一类产品，且需要更多历法表。
 * - **不改其他插件**：`fakeLunar` 之类「假装有农历」的开关刻意不做（那是编数据）。
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
import type { Config as LiveConfig } from './settings.js'
import { Live, CROSSCHECK_DAYS, JIEQI_SCAN_DAYS } from './service.js'
import { LIVE_SERVICE_KEY, NAME_RE } from './types.js'
import type { ClockLike, ConfigSchemaLike, IdentityLike, LiveService, LogLike } from './types.js'

export type * from './types.js'
export {
  LIVE_SERVICE_KEY,
  NAME_RE,
  DAY_KEY_RE,
  WEEKDAY_NAMES,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  PROVIDER_VALUES,
  DEFAULT_UPCOMING_DAYS,
  UPCOMING_CEIL,
  CACHE_FLOOR,
  CACHE_CEIL,
  completeConfig,
} from './settings.js'
export { dayOfYearOf, daysBetween, daysInMonth, isLeapYear, isValidDay, localDayKeyOf, partsOf, shiftDay, weekdayOf } from './solar.js'
export type { SolarParts } from './solar.js'
export { LUNAR_FESTIVAL_TABLE, SOLAR_FESTIVAL_TABLE, lunarFestivalsOf, solarFestivalsOf } from './festivals.js'
export { createSolarBranch } from './branches/solar.js'
export { createLunarJsBranch } from './branches/lunar-js.js'
export type { LunarJsProbe } from './branches/lunar-js.js'
export { createTyme4tsBranch } from './branches/tyme4ts.js'
export type { Tyme4tsProbe } from './branches/tyme4ts.js'
export { describeSelection, selectProviders } from './select.js'
export type { Selection } from './select.js'
export { Live, CROSSCHECK_DAYS, JIEQI_SCAN_DAYS } from './service.js'
export type { LiveOptions } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-live'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-live: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 日期事实服务；未装载本插件时为 undefined。 */
    'ondra-live'?: LiveService
  }
}

/**
 * Cordis 入口：解析配置、探测分支、注册服务、按需对拍一次。**永不阻断宿主**。
 *
 * 刻意不声明插件级 `inject`：本插件对 `ondra-clock` 只是**软依赖**（没有它就用本机时区），
 * 对 `ondra-config-schema` 同理。若声明 `inject`，任何一个缺席都会让整个插件停在 PENDING，
 * 于是「今天几号」这种最基础的事实会整块消失——而它本来只依赖系统时钟。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: LiveConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('live') : 'ondra.live')

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
          log.warn('配置有 %d 个字段校验失败，已逐个回退默认值', resolved.fallbackCount)
        }
      }
    } catch (error) {
      log.warn('解析配置段失败，退回插件实例配置：%s', messageOf(error))
    }
  }

  // 2. 补全 + 校验。任何非法值都回退默认，绝不抛。
  const settings = completeConfig(effective)

  // 3. 分支探测与选路。**这一步就要给出结论**，因为面板要显示「为什么没有农历」。
  const live = new Live({
    settings,
    log,
    clock: () => ctx.get('ondra-clock') as ClockLike | undefined,
    now: () => Date.now(),
  })

  ctx.effect(() => ctx.provide(LIVE_SERVICE_KEY, live), 'ondra-live: 注册日期事实服务')

  // 4. 对拍一次（两条农历分支都在位才有实际动作，否则 `crosscheck()` 直接返回「无可对拍」）。
  if (settings.crosscheckOnStart) {
    try {
      const report = live.crosscheck(CROSSCHECK_DAYS)
      if (report.mismatches.length === 0) {
        log.debug?.('农历对拍：%s', report.summary)
      }
    } catch (error) {
      log.warn('启动对拍失败（不影响日期事实）：%s', messageOf(error))
    }
  }

  // 5. 报一次现状。分支、农历在位与否、缓存上限都要能被自检读到（§12.2）。
  const statuses = live.stats().providers
  log.info(
    '日期事实就绪：%s · 事实缓存 %d 天 · 找节气往后看 %d 天',
    live.lunarReady ? `农历分支 ${live.provider}` : '只有公历',
    settings.cacheDays,
    JIEQI_SCAN_DAYS,
  )
  if (!settings.enable) {
    log.warn('日期事实已关闭（enable=false）：服务照常注册，界面应显示已关闭')
  }
  if (!live.lunarReady && settings.verbose) {
    const hints = statuses
      .filter(status => status.name !== 'solar-only')
      .map(status => `${status.name}：${status.detail}`)
      .join('；')
    log.info('当前只有公历（星期、公历节日可用；农历与节气不可用）。原因：%s', hints)
  }
  if (ctx.get('ondra-clock') === undefined && settings.verbose) {
    log.info('时间服务未装载：自然日退回本机时区（跨时区部署时「今天」可能差一天）')
  }
  if (!NAME_RE.test(name)) {
    log.error('插件名不合规（%s）：服务键会被模型侧拒绝', name)
  }
}

/**
 * 配置校验器（标准 schema 形状）。手写而不引 schemastery：本轮禁止装依赖。
 *
 * 校验口径：**能补的全补，补不了的才报 issue**。配置错不该让插件不加载。
 */
export const Config: {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: LiveConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法值回退默认、数值夹紧），因此永远不产 issue。
      return { value: completeConfig(value) }
    },
  },
}
