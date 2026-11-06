/**
 * 上游探测：模型清单与出口地区。
 *
 * ## 两个纪律
 *
 * 1. **探测不是计费请求**。这里只打 `GET /models` 与地区端点，绝不发一次
 *    真实的 chat 请求去「试试通不通」——那等于拿用户的额度验证配置。
 * 2. **失败一律静默降级**。探测挂在启动与刷新路径上，抛错会连带把对话打断；
 *    所以全部返回结构化结果，异常在内部转成 `failure` 码。
 *
 * ## 地区判定为什么读两个源
 *
 * 单一 IP 服务挂掉时，「地区受限模型」会被误判成不可用，用户看到的是模型消失，
 * 而不是「探测失败」。两个源依次回退，任一成功即返回；全部失败时
 * `known=false`，此时**不做任何移除**——不知道就不猜。
 */

import type { ProbeOutcome, RegionOutcome } from './types.js'

/** 探测超时（毫秒）。上游部分模型首字很慢，但清单接口不该慢；5 秒足够。 */
const PROBE_TIMEOUT_MS = 5_000

/** 地区判定超时（毫秒）。 */
const REGION_TIMEOUT_MS = 4_000

/** 请求头构造：只带必要项，不附带任何本机标识。 */
function headersOf(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return {
    Accept: 'application/json',
    'User-Agent': 'Ondra/1.0',
    ...extra,
  }
}

/**
 * 带超时地取 JSON。
 * @param url 目标地址。
 * @param init 请求参数。
 * @param timeoutMs 超时毫秒。
 * @param signal 外部取消信号。
 * @returns 解析后的 JSON；失败返回 `undefined`。
 */
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  const onAbort = (): void => { controller.abort() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 从上游清单响应里取模型数组。兼容 `{data:[...]}` 与裸数组两种形状。 */
function modelsOf(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload
  if (typeof payload === 'object' && payload !== null) {
    const data = (payload as { data?: unknown }).data
    if (Array.isArray(data)) return data
  }
  return undefined
}

/**
 * 探测一家渠道的模型清单。
 * @param channel 渠道键。
 * @param baseUrl 接口根地址。
 * @param modelsPath 清单路径（以斜杠开头）。
 * @param extraHeaders 额外请求头（免费车道用它带 Bearer）。
 * @param signal 外部取消信号。
 * @returns 探测结果；`modelCount` 为上游实际返回的条数。
 */
export async function probeModels(
  channel: string,
  baseUrl: string,
  modelsPath: string,
  extraHeaders: Readonly<Record<string, string>> | undefined,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const url = `${baseUrl}${modelsPath.startsWith('/') ? modelsPath : `/${modelsPath}`}`
  const payload = await fetchJson(url, { method: 'GET', headers: headersOf(extraHeaders) }, PROBE_TIMEOUT_MS, signal)
  if (payload === undefined) {
    return { channel, reachable: false, modelCount: 0, failure: 'network' }
  }
  const models = modelsOf(payload)
  if (models === undefined) {
    return { channel, reachable: false, modelCount: 0, failure: 'parse' }
  }
  return { channel, reachable: true, modelCount: models.length }
}

/**
 * 从各家响应里取两位国家码。
 *
 * 两个源的国家字段名不同：ipinfo 用 `country`，ipwho 用 `country_code`。
 * 按来源分支读取，不做「两个字段都试」——那种写法会在字段语义变化时静默读错值。
 */
function countryOf(source: RegionOutcome['source'], payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  const raw = source === 'ipwho' ? record['country_code'] : record['country']
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toUpperCase()
  // 只接受两位字母：有的源会返回空串或 "Unknown"。
  return /^[A-Z]{2}$/.test(value) ? value : undefined
}

/**
 * 按顺序尝试的地区源。
 *
 * 只用**响应体里直接带国家码**的源：
 * - `api.ipify.org` 只返回 IP、不返回国家，解析必然失败，故不用；
 * - `ipapi.co` 对无浏览器特征的请求会落到 Cloudflare 挑战页（返回 HTML），
 *   解析同样失败，故不用。
 * 两个源都做不到的事，写进列表只是多一次白跑的超时。
 */
const REGION_SOURCES: readonly { source: RegionOutcome['source']; url: string }[] = [
  { source: 'ipinfo', url: 'https://ipinfo.io/json' },
  { source: 'ipwho', url: 'https://ipwho.is/' },
]

/**
 * 判定出口地区。
 *
 * 只在启用免费车道时调用——用户没开免密车道，本插件不该有任何出站流量。
 * @param signal 外部取消信号。
 * @returns 判定结果；全部失败时 `known=false`。
 */
export async function detectRegion(signal?: AbortSignal): Promise<RegionOutcome> {
  for (const candidate of REGION_SOURCES) {
    const payload = await fetchJson(candidate.url, { method: 'GET', headers: headersOf(undefined) }, REGION_TIMEOUT_MS, signal)
    if (payload === undefined) continue
    const country = countryOf(candidate.source, payload)
    if (country !== undefined) return { known: true, country, source: candidate.source }
  }
  return { known: false, country: '', source: 'none' }
}
