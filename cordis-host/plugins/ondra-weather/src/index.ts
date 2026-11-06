/**
 * O-047 `ondra-weather`：只认显式坐标的天气。取不到就不提。
 *
 * ## 装载期只做三件事
 *
 * 1. 解析配置（有 O-005 就走四层合并，没有就用本地校验）；
 * 2. 建服务并 `provide`——**不在这里发请求**：装载期宿主正忙（配置合并、
 *    界面首屏），一个 4 秒的超时会把「启动慢」记到天气头上；
 * 3. 把「为什么现在不能说天气」逐条打出来（没坐标 / 坐标写错 / 没有 fetch）。
 *
 * ## 刻意不声明插件级 `inject`
 *
 * 本插件只消费 `ondra-clock` / `ondra-config-schema` / `ondra-identity`，三者全软。
 * 声明 `inject` 会让缺一个就整包停 PENDING，而面板连「缺什么」都读不到；
 * 正确表现是服务照常注册、`facts()` 返回 `undefined`、日志里明说原因。
 *
 * ## 不注册工具
 *
 * 注册 `weather` 工具后，模型可以自己「查一下天气」再说——那就成了工具箱，
 * 而不是「她知道外面在下雨」。事实一律经 `facts()` 由提示词层取。
 */

import type { Context } from '@ntars/cordis'
import {
  CONFIG_SECTION,
  CONFIG_SECTION_ID,
  completeConfig,
  configDriftOf,
  isRecord,
  normalizeUserLayer,
  parseCoords,
  valuesToConfigShape,
} from './settings.js'
import type { Config as WeatherConfig } from './settings.js'
import { createTransport, resolveFetch } from './transport.js'
import { Weather } from './service.js'
import { NAME_RE, WEATHER_SERVICE_KEY } from './types.js'
import type { ClockLike, ConfigSchemaLike, IdentityLike, LogLike, WeatherService } from './types.js'

export type * from './types.js'
export {
  WEATHER_SERVICE_KEY,
  NAME_RE,
  PROVIDER_HOST,
  PROVIDER_PATH,
  MAX_BODY_BYTES,
  COORDS_RE,
} from './types.js'
export {
  CONFIG_SECTION_ID,
  DEFAULT_CONFIG,
  FIELD_SPECS,
  SECTION_KEYS,
  TTL_MIN,
  TTL_MAX,
  TIMEOUT_MIN,
  TIMEOUT_MAX,
  PLACE_MAX,
  completeConfig,
  configDriftOf,
  parseCoords,
} from './settings.js'
export { WMO_TABLE, isWmoCode, phenomenonOf } from './wmo.js'
export { CURRENT_FIELDS, DAILY_FIELDS, buildRequest, createTransport, resolveFetch } from './transport.js'
export type { Transport, TransportResult } from './transport.js'
export { parsePayload } from './payload.js'
export type { ParseResult, WeatherData } from './payload.js'
export { Weather, sentenceOf } from './service.js'
export type { WeatherDeps } from './service.js'

/** Cordis 函数插件名。与 `package.json` 的 `name` 完全一致。 */
export const name = 'ondra-weather'

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
    ctx.effect(() => schema.register(CONFIG_SECTION, name), 'ondra-weather: 注册配置段')
    return true
  } catch (error) {
    log.warn('向 ondra-config-schema 注册配置段失败（退回插件实例配置）：%s', messageOf(error))
    return false
  }
}

declare module '@ntars/cordis' {
  interface Context {
    /** 天气服务；未装载本插件时为 undefined。 */
    'ondra-weather'?: WeatherService
  }
}

/**
 * Cordis 入口：解析配置、注册服务、报一次现状。**永不阻断宿主**。
 * @param ctx 宿主上下文。
 * @param config 配置行内容。
 */
export function apply(ctx: Context, config: WeatherConfig): void {
  const identity = ctx.get('ondra-identity') as IdentityLike | undefined
  const log = ctx.logger(identity ? identity.loggerName('weather') : 'ondra.weather')

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

  // 3. 时间：有 O-003 就用它的 `now()`，没有才退回系统时钟（并在日志里说出来）。
  const clock = ctx.get('ondra-clock') as ClockLike | undefined
  const now = (): number => {
    const live = ctx.get('ondra-clock') as ClockLike | undefined
    return live === undefined ? Date.now() : live.now()
  }

  // 4. 网络出口：只在装载时解析一次 `fetch`（它是运行时常量，不必每轮找）。
  const transport = createTransport({
    fetch: resolveFetch(),
    timeoutMs: settings.timeoutMs,
    log,
  })

  const weather = new Weather({ settings, log, transport, now })

  ctx.effect(() => ctx.provide(WEATHER_SERVICE_KEY, weather), 'ondra-weather: 注册天气服务')
  // 卸载时清掉缓存：坐标是隐私，不该跟着模块变量留在内存里等下一次装载。
  ctx.effect(
    () => () => {
      weather.clear()
    },
    'ondra-weather: 卸载清缓存',
  )

  // 5. 报一次现状：坐标、缓存、出口、时区，都要能被自检读到（§12.2）。
  const drift = configDriftOf(raw)
  if (drift.length > 0) {
    log.warn('配置有值越界已回退（%s）：缓存与超时可能因此不是你设的数', drift.join(' / '))
  }

  const coords = parseCoords(settings.coords)
  if (!settings.enable) {
    log.warn('天气已关闭（enable=false）：服务照常注册，snapshot() 一律 disabled')
  } else if (!coords.ok) {
    // 没配是正常的（手册要求「需显式坐标」），配错才需要人管。
    if (coords.reason === 'no-coords') {
      log.info('未配置坐标：天气一律不提（不猜城市，见 README「已知限制」）')
    } else {
      log.warn('坐标「%s」不合法：应为「纬度,经度」且在范围内，0,0 视为未填', settings.coords)
    }
  } else {
    log.info(
      '天气就绪：%s · 缓存 %d 分钟 · 坐标 %s,%s',
      settings.place === '' ? '未填地点名' : settings.place,
      settings.ttlMinutes,
      String(coords.lat),
      String(coords.lon),
    )
  }

  if (!transport.available) {
    log.warn('运行时没有可用的 fetch：天气取不到（宿主若提供 transport 服务，替换 src/transport.ts 即可）')
  }
  if (clock === undefined) {
    log.info('时间服务未装载：缓存过期判定退回本机时钟，跨时区会偏')
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
    ) => { readonly value: WeatherConfig } | { readonly issues: readonly { readonly message: string }[] }
  }
} = {
  '~standard': {
    version: 1,
    vendor: 'ondra',
    validate(value: unknown) {
      // 全部字段都能被安全补全（非法值回退默认、数值夹紧），因此永远不产 issue。
      // 坐标写错**不在这里修**：修成空串会让面板显示「没配」，真正的原因就丢了。
      return { value: completeConfig(value) }
    },
  },
}
