/**
 * 网络出口。**全插件唯一发请求的地方**。
 *
 * ## 为什么不是「调用宿主 http 服务」
 *
 * 手册允许消费的只有「文档或源码里确认存在的服务键」。本仓 `desktop/packages`
 * 与 `desktop/docs` 全仓检索无 http / fetch / net 服务键，因此没有可消费对象，
 * 用运行时的 `globalThis.fetch`。这件事**不是没有代价**：宿主若配了
 * `dsh-http-proxy`，直连的请求不走它。所以：
 *
 * 1. 出口收在一个文件里，日后有 transport 服务只改这里（`FetchLike` 即替换点）；
 * 2. 只允许一个主机、只允许 GET、响应体封顶 64 KiB——直连的出口必须比别人窄。
 *
 * ## 为什么超时不靠 `AbortController` 单打独斗
 *
 * 有的运行时被裁剪掉了 `AbortController`。此时只用 `AbortController` 的写法
 * 会**永不超时**（`signal` 是 undefined，请求一直挂着），而调用方以为设了 4 秒。
 * 这里做双保险：有 controller 就 abort，没有就 `Promise.race` 一个超时分支；
 * 两条路都能在 `timeoutMs` 内返回，代价是后者在后台还留着一个未完成的请求
 * （它不会写任何东西，只是多占一个 socket 到自然结束）。
 */

import { MAX_BODY_BYTES, PROVIDER_HOST, PROVIDER_PATH } from './types.js'
import type { FetchLike, LogLike, WeatherRequest } from './types.js'

/** 一次请求的结果。**只有两种**：拿到可解析的文本，或一个原因码。 */
export type TransportResult =
  | { readonly ok: true; readonly body: string }
  | {
      readonly ok: false
      readonly reason: 'no-transport' | 'network' | 'timeout' | 'http' | 'payload'
      readonly status?: number
      readonly detail?: string
    }

/** 需要从接口取的当前字段。改这里必须同步改 `payload.ts` 的解析。 */
export const CURRENT_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'precipitation',
  'weather_code',
  'wind_speed_10m',
  'is_day',
] as const

/** 需要从接口取的当日字段。 */
export const DAILY_FIELDS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_probability_max',
] as const

/**
 * 拼请求地址。**主机与路径写死**，不接受外部传入的 url——
 * 一旦坐标或地点名能改主机，这个插件就成了一个任意请求器。
 * @param lat 纬度。
 * @param lon 经度。
 */
export function buildRequest(lat: number, lon: number): WeatherRequest {
  const query = [
    'latitude=' + lat.toFixed(4),
    'longitude=' + lon.toFixed(4),
    'current=' + CURRENT_FIELDS.join(','),
    'daily=' + DAILY_FIELDS.join(','),
    'timezone=auto',
    'forecast_days=1',
    'wind_speed_unit=kmh',
  ].join('&')
  return { url: 'https://' + PROVIDER_HOST + PROVIDER_PATH + '?' + query, lat, lon }
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 找一个可用的 `fetch`。**只认函数**，不认「看起来像」的对象。
 * @returns 可用的实现，或 undefined。
 */
export function resolveFetch(): FetchLike | undefined {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') return undefined
  // 绑定到 globalThis：部分运行时把 fetch 实现成依赖 this 的方法，裸调用会抛 Illegal invocation。
  return candidate.bind(globalThis) as FetchLike
}

/** 网络出口。 */
export interface Transport {
  /** 有没有可用的 fetch。 */
  readonly available: boolean
  /**
   * 发一次 GET。
   * @param url 由 `buildRequest()` 生成。
   */
  request(url: string): Promise<TransportResult>
}

/**
 * 建一个出口。
 * @param deps 依赖：抓取实现（缺席即 `no-transport`）、超时、日志。
 */
export function createTransport(deps: {
  readonly fetch: FetchLike | undefined
  readonly timeoutMs: number
  readonly log: LogLike
}): Transport {
  const impl = deps.fetch
  const timeoutMs = deps.timeoutMs

  return {
    available: impl !== undefined,

    async request(url: string): Promise<TransportResult> {
      if (impl === undefined) return { ok: false, reason: 'no-transport' }

      // 只允许 HTTPS 且主机在白名单内。`buildRequest()` 已经保证，这里再判一次：
      // 它是「唯一出口」这条约束的最后一道闸，不能靠调用方守规矩。
      if (!url.startsWith('https://' + PROVIDER_HOST + '/')) {
        return { ok: false, reason: 'payload', detail: '拒绝请求白名单外的主机' }
      }

      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false

      const timeout = new Promise<TransportResult>(resolve => {
        timer = setTimeout(() => {
          timedOut = true
          controller?.abort()
          resolve({ ok: false, reason: 'timeout' })
        }, timeoutMs)
      })

      const run = async (): Promise<TransportResult> => {
        try {
          const response = await impl(url, {
            signal: controller?.signal,
            headers: { accept: 'application/json', 'user-agent': 'ondra-weather/0.1' },
          })
          if (!response.ok) {
            return { ok: false, reason: 'http', status: response.status }
          }
          const body = await response.text()
          if (body.length > MAX_BODY_BYTES) {
            // 正常响应 2–3 KiB。超限说明对面换了东西（或被劫持），不解析。
            return { ok: false, reason: 'payload', detail: '响应体超过上限' }
          }
          return { ok: true, body }
        } catch (error) {
          if (timedOut) return { ok: false, reason: 'timeout' }
          const detail = messageOf(error)
          // AbortError 有两种来源：我们的超时（上面已返回）与运行时自己取消。
          if (detail.includes('abort')) return { ok: false, reason: 'timeout' }
          return { ok: false, reason: 'network', detail }
        }
      }

      // 一律 race，而不是「有 controller 就走 abort」：abort 是否被实现尊重，
      // 在裁剪过的运行时里并不可靠；race 是唯一不依赖对面配合的上限。
      const result = await Promise.race([run(), timeout])
      if (timer !== undefined) clearTimeout(timer)
      // race 输掉的那一路仍会在后台结束，它不会再写任何状态——这里只是不 await 它。
      return result
    },
  }
}
