/**
 * 响应解析。**宁可判 `payload` 失败，也不返回半个对象**。
 *
 * 一遍遍历里只做三件事：确认形状、取必需字段、取可选字段。
 * 任何一步对不上就整份放弃——天气数据是「一套」的：温度能读、最高最低读不到，
 * 拼出来就是「今天 21℃，今天 0–0℃」，而调用方没有任何办法察觉。
 *
 * 必需字段只有一个：当前气温。其余都是可选——少一个就少说一句，
 * 只有当前气温没有时整份数据没有意义（她唯一一定会说的就是「现在几度」）。
 */

/** 解析出来的天气数据。**全部字段都已经过类型与范围检查**。 */
export interface WeatherData {
  /** 数据时刻；接口没给可解析的时间时等于抓取时刻。 */
  readonly observedAt: number
  /** 当前气温 ℃。**唯一必需字段**。 */
  readonly tempC: number
  readonly feelsC?: number
  readonly humidity?: number
  readonly windKph?: number
  readonly precipMm?: number
  readonly precipProb?: number
  readonly code?: number
  readonly day?: boolean
  readonly highC?: number
  readonly lowC?: number
}

/** 解析结果。 */
export type ParseResult =
  | { readonly ok: true; readonly data: WeatherData }
  | { readonly ok: false; readonly detail: string }

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读一个有限数值。
 * @param value 原始值。
 * @param min 允许下限（含）。
 * @param max 允许上限（含）。
 */
function num(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

/**
 * 从数组里读第 0 项（接口的 daily 是「每天一格」的数组，本插件只要今天）。
 * @param value 原始数组。
 */
function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined
}

/**
 * 解析响应体。
 * @param body 响应文本。
 * @param fetchedAt 抓取时刻（接口没给时间时用它兜底）。
 */
export function parsePayload(body: string, fetchedAt: number): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { ok: false, detail: 'JSON 解析失败' }
  }
  if (!isRecord(parsed)) return { ok: false, detail: '根节点不是对象' }

  // 有些服务在参数不对时返回 200 + `{error:true,reason:...}`，这种必须当失败。
  if (parsed['error'] === true) {
    const reason = parsed['reason']
    return { ok: false, detail: typeof reason === 'string' ? reason : '接口报错' }
  }

  const current = parsed['current']
  if (!isRecord(current)) return { ok: false, detail: '缺 current' }

  // 气温范围放到 −90–60：地表的极端记录都在这个区间内。
  // 越界说明字段被换了含义（例如单位变成了华氏度），当格式错处理。
  const tempC = num(current['temperature_2m'], -90, 60)
  if (tempC === undefined) return { ok: false, detail: 'current.temperature_2m 不可用' }

  const daily = isRecord(parsed['daily']) ? parsed['daily'] : undefined
  const highC = daily === undefined ? undefined : num(firstOf(daily['temperature_2m_max']), -90, 60)
  const lowC = daily === undefined ? undefined : num(firstOf(daily['temperature_2m_min']), -90, 60)

  const data: WeatherData = {
    observedAt: timeOf(current['time'], fetchedAt),
    tempC,
    feelsC: num(current['apparent_temperature'], -90, 70),
    humidity: num(current['relative_humidity_2m'], 0, 100),
    windKph: num(current['wind_speed_10m'], 0, 500),
    precipMm: num(current['precipitation'], 0, 500),
    precipProb: daily === undefined ? undefined : num(firstOf(daily['precipitation_probability_max']), 0, 100),
    code: num(current['weather_code'], 0, 99),
    day: typeof current['is_day'] === 'number' ? current['is_day'] === 1 : undefined,
    highC,
    lowC,
  }
  return { ok: true, data }
}

/**
 * 读接口给的时间。`timezone=auto` 时它是**本地时间且不带时区**，
 * `Date.parse` 会按宿主本地时区解释——正好是我们要的口径。
 * @param value 原始值。
 * @param fallback 解析不出时的兜底。
 */
function timeOf(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : fallback
}
