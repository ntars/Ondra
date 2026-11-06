/**
 * O-047 `ondra-weather` 的对外契约。
 *
 * 定位：**天气事实的唯一来源**。别的插件想知道「外面冷不冷、要不要带伞」，
 * 一律经 `ctx.get('ondra-weather')` 取，**不得各自去请求天气接口**。
 *
 * ## 为什么坐标是一个 `lat,lon` 字符串，而不是两个数字字段
 *
 * 两个数字字段必然出现「只填了纬度、经度还是默认 0」的半对状态，而这种状态
 * 不会报错——它会安静地给出**几内亚湾**的天气。一个字段只有一个坏法：
 * 解析不出来 → `no-coords` → 不提。半对的天气比没有天气更糟，因为用户会当真。
 *
 * ## 为什么失败不给「陈旧兜底」
 *
 * 手册 §3.7 的口径是「取不到就不提」。把两小时前的实况当现在说，用户
 * 一开窗就知道不对；而插件这边每个字段都合格、日志全绿。**沉默是可解释的，
 * 说错是不可解释的**。缓存只活 `ttlMinutes`，过期即作废，不做第二层兜底。
 *
 * ## 网络出口
 *
 * 本仓 `desktop/packages` 与 `desktop/docs` 里**没有可消费的 HTTP 服务键**
 * （全仓 grep 零命中），因此本插件用运行时的 `globalThis.fetch` 直连，
 * 只允许 `api.open-meteo.com` 一个主机、只允许 GET、响应体上限 64 KiB。
 * 这条限制写在 README「已知限制」，日后宿主提供 transport 服务时
 * 只需替换 `src/transport.ts` 一处（`FetchLike` 即替换点）。
 */

/** 本插件注册的服务键（连字符，非 `ondra:weather`）。全仓唯一归属。 */
export const WEATHER_SERVICE_KEY = 'ondra-weather'

/** 服务键 / 工具名 / 配置键的硬约束（手册 §8.4）。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 唯一允许请求的主机。写死是为了让「换个接口」必须改代码，而不是改一行配置。 */
export const PROVIDER_HOST = 'api.open-meteo.com'

/** 接口路径。 */
export const PROVIDER_PATH = '/v1/forecast'

/** 响应体上限（字节）。正常响应 2–3 KiB，64 KiB 已经宽到足以发现异常。 */
export const MAX_BODY_BYTES = 64 * 1024

/** 坐标字符串的形状：`纬度,经度`，允许空格与负号。 */
export const COORDS_RE = /^(-?\d{1,4}(?:\.\d+)?)\s*,\s*(-?\d{1,4}(?:\.\d+)?)$/

/** 数据时刻与抓取时刻。 */
export type WeatherReason =
  /** 取到了，且新鲜。 */
  | 'ok'
  /** 配置里关掉了。 */
  | 'disabled'
  /** 没填坐标。手册要求「需显式坐标」，这里绝不猜。 */
  | 'no-coords'
  /** 坐标写错（越界、形状不对、或经典的 `0,0` 残留值）。 */
  | 'bad-coords'
  /** 运行时没有 `fetch`（宿主裁剪过运行时）。 */
  | 'no-transport'
  /** 连不上 / DNS / 证书。 */
  | 'network'
  /** 超时。 */
  | 'timeout'
  /** HTTP 非 2xx。 */
  | 'http'
  /** 响应不是可用的 JSON，或字段形状变了。 */
  | 'payload'

/** 一次天气快照。失败时只有 `available` / `reason` / `fetchedAt` 有意义。 */
export interface WeatherView {
  /** 这一次拿到的是**新鲜可用**的数据。 */
  readonly available: boolean
  /** 结果码。成功为 `ok`，其余为失败原因。 */
  readonly reason: WeatherReason
  /** 数据时刻（接口给的观测/模型时刻），解析不出时等于 `fetchedAt`。 */
  readonly observedAt: number
  /** 抓取时刻。 */
  readonly fetchedAt: number
  /** 地点名（用户自己填的标签，可为空）。 */
  readonly place?: string
  /** 气温 ℃。 */
  readonly tempC?: number
  /** 体感 ℃。 */
  readonly feelsC?: number
  /** 相对湿度 %。 */
  readonly humidity?: number
  /** 风速 km/h。 */
  readonly windKph?: number
  /** 降水 mm。 */
  readonly precipMm?: number
  /** 今日降水概率上限 %。 */
  readonly precipProb?: number
  /** WMO 天气码。 */
  readonly code?: number
  /** 天气现象的中文短语，例如「多云」「小雨」。 */
  readonly phenomenon?: string
  /** 白天 / 夜间（接口的 `is_day`）。 */
  readonly day?: boolean
  /** 今日最高 ℃。 */
  readonly highC?: number
  /** 今日最低 ℃。 */
  readonly lowC?: number
}

/** 供提示词与对话链消费的精简事实。**取不到就没有这个对象**。 */
export interface WeatherFacts {
  readonly place?: string
  /** 一句中文，可直接嵌进提示词。 */
  readonly text: string
  readonly tempC: number
  readonly feelsC?: number
  readonly highC?: number
  readonly lowC?: number
  readonly precipProb?: number
  readonly phenomenon?: string
  readonly day: boolean
  readonly observedAt: number
}

/** 运行计数（**只在内存**，进程重启归零）。 */
export interface WeatherStats {
  /** 真正发出请求的次数。 */
  readonly calls: number
  /** 命中缓存、没发请求的次数。 */
  readonly hits: number
  /** 失败次数（含超时与格式错）。 */
  readonly failures: number
  /** 最后一次成功的抓取时刻，0 表示从未成功。 */
  readonly lastOkAt: number
  /** 最后一次失败的原因码，`undefined` 表示没失败过。 */
  readonly lastError?: WeatherReason
  /** 当前缓存年龄（毫秒），无缓存为 `undefined`。 */
  readonly cacheAgeMs?: number
}

/** 天气服务。 */
export interface WeatherService {
  /** 服务本身能不能工作：开关 + 坐标合法 + 有网络出口。 */
  readonly available: boolean
  /** 服务不能工作的原因（`available=true` 时为 `undefined`）。 */
  readonly reason?: WeatherReason
  /** 坐标是否已配置且合法。 */
  readonly configured: boolean

  /**
   * 取一次快照（走缓存）。**永不抛出**：失败以 `available=false` 表达。
   * @param at 判缓存是否过期的时刻，省略用系统时间。
   */
  snapshot(at?: number): Promise<WeatherView>

  /**
   * 强制重新抓一次，忽略缓存。用于面板上的「刷新」。
   * @param at 时刻。
   */
  refresh(at?: number): Promise<WeatherView>

  /**
   * 供提示词消费的精简事实。**取不到返回 `undefined`**——
   * 调用方据此「不提天气」，而不是拿到一个空对象再自己猜。
   * @param at 时刻。
   */
  facts(at?: number): Promise<WeatherFacts | undefined>

  /**
   * 一句中文天气。取不到返回 `undefined`。
   * @param at 时刻。
   */
  text(at?: number): Promise<string | undefined>

  /** 清空缓存（改坐标、切城市后调用）。 */
  clear(): void

  /** 运行计数。 */
  stats(): WeatherStats
}

/** 一次 HTTP 响应的结构对位子集（`fetch` 的返回满足它）。 */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/** 网络出口。**唯一替换点**：日后宿主给出 transport 服务，只改这里。 */
export type FetchLike = (
  url: string,
  init: { readonly signal?: AbortSignal; readonly headers?: Readonly<Record<string, string>> },
) => Promise<FetchResponseLike>

/** 时间服务的结构对位子集（只用到 `now()`）。 */
export interface ClockLike {
  now(): number
}

/** 日志器的结构对位子集。 */
export interface LogLike {
  debug(format: string, ...args: unknown[]): void
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

/** 字段声明（与 O-005 对位）。 */
export interface FieldSpecLike {
  readonly kind: 'string' | 'number' | 'boolean' | 'enum' | 'json'
  readonly default?: unknown
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly pattern?: string
  readonly secret?: boolean
  readonly advancedOnly?: boolean
  readonly doc?: string
}

/** O-005 的段声明形状。 */
export interface SectionDeclLike {
  readonly id: string
  readonly title: string
  readonly fields: Readonly<Record<string, FieldSpecLike>>
  readonly owner?: string
}

/** O-005 配置真源的结构对位子集（只用到注册与解析）。 */
export interface ConfigSchemaLike {
  register(section: SectionDeclLike, owner?: string): () => void
  resolve(
    sectionId: string,
    layer?: { readonly user?: Readonly<Record<string, unknown>> },
  ):
    | { readonly values: Readonly<Record<string, unknown>>; readonly fallbackCount: number }
    | undefined
}

/** O-001 身份服务的结构对位子集（只用来拼日志命名空间）。 */
export interface IdentityLike {
  loggerName(feature: string): string
}

/** 坐标解析结果。**只有两个出口**：合法，或不合法（带原因）。 */
export type CoordResult =
  | { readonly ok: true; readonly lat: number; readonly lon: number }
  | { readonly ok: false; readonly reason: 'no-coords' | 'bad-coords' }

/** 组装完成的请求地址与解析出的坐标。 */
export interface WeatherRequest {
  readonly url: string
  readonly lat: number
  readonly lon: number
}
