/**
 * 天气服务：缓存、取数、措辞。**永不抛出**。
 *
 * ## 三次闸门，顺序固定
 *
 * ```
 * 开关 → 坐标 → 网络出口 → 缓存 → 请求 → 解析
 * ```
 *
 * 顺序不是随意的：坐标判在请求之前，才不会出现「没填坐标却先发了一次
 * `latitude=NaN` 的请求」；出口判在缓存之后，是因为命中缓存时根本不需要出口
 * （例如运行时没有 fetch，但一分钟前刚拿到过数据）。
 *
 * ## 并发去重
 *
 * 面板刷新、对话链取事实、提示词组装可能在同一秒各调一次。没有去重就是
 * **三次同样的请求**，而接口按 IP 限流——症状是「偶尔取不到」，且越刷新越取不到。
 * 这里把进行中的那一次存下来，后来的调用直接复用它。
 *
 * ## 缓存只活 TTL
 *
 * 过期就作废，不返回「上次的天气」。理由见 `types.ts` 文件头。
 */

import { parseCoords, TTL_MIN } from './settings.js'
import type { Config } from './settings.js'
import { buildRequest } from './transport.js'
import type { Transport } from './transport.js'
import { parsePayload } from './payload.js'
import { phenomenonOf } from './wmo.js'
import type { LogLike, WeatherFacts, WeatherReason, WeatherService, WeatherStats, WeatherView } from './types.js'

/** 组装服务所需的依赖。全部用取值函数或不可变对象，避免持有会变的上游句柄。 */
export interface WeatherDeps {
  readonly settings: Config
  readonly log: LogLike
  readonly transport: Transport
  /** 当前时刻。走 O-003 的 `now()`，不在这里 `Date.now()`（便于自检与换时区）。 */
  readonly now: () => number
}

/** 一次失败快照（只有三个字段有值）。 */
function failureOf(reason: WeatherReason, at: number): WeatherView {
  return Object.freeze({ available: false, reason, observedAt: at, fetchedAt: at })
}

/** 把数值四舍五入成整数字符串（天气报小数没有意义，还占字）。 */
function round(value: number): string {
  return String(Math.round(value))
}

/**
 * 把一份快照说成一句话。**只包含确实取到的字段**。
 *
 * 措辞刻意平：不写「今天天气真好呀」这类评价——评价属于人格层，
 * 本插件只提供事实，让 O-033 决定要不要带情绪。
 * @param view 成功快照。
 */
export function sentenceOf(view: WeatherView): string {
  if (view.tempC === undefined) return ''
  const head: string[] = []
  if (view.place !== undefined && view.place !== '') head.push(view.place)
  if (view.phenomenon !== undefined) head.push(view.phenomenon)
  head.push(round(view.tempC) + '℃')

  const parts: string[] = [head.join(' ')]
  if (view.lowC !== undefined && view.highC !== undefined) {
    parts.push('今天 ' + round(view.lowC) + '–' + round(view.highC) + '℃')
  } else if (view.highC !== undefined) {
    parts.push('今天最高 ' + round(view.highC) + '℃')
  } else if (view.lowC !== undefined) {
    parts.push('今天最低 ' + round(view.lowC) + '℃')
  }
  if (view.precipProb !== undefined) parts.push('降水概率 ' + round(view.precipProb) + '%')
  return parts.join('，')
}

/** 天气服务实现。 */
export class Weather implements WeatherService {
  private readonly deps: WeatherDeps

  /** 缓存：快照 + 抓取时刻。过期即整个丢掉，不保留第二层。 */
  private cache: { readonly view: WeatherView; readonly at: number } | undefined

  /** 进行中的请求。完成后清空——它是去重用的，不是缓存。 */
  private pending: Promise<WeatherView> | undefined

  private calls = 0
  private hits = 0
  private failures = 0
  private lastOkAt = 0
  private lastError: WeatherReason | undefined

  constructor(deps: WeatherDeps) {
    this.deps = deps
  }

  /** 闸门：返回第一个拦住服务的理由，全通返回 undefined。 */
  private gateOf(): WeatherReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    const coords = parseCoords(this.deps.settings.coords)
    if (!coords.ok) return coords.reason
    if (!this.deps.transport.available) return 'no-transport'
    return undefined
  }

  get available(): boolean {
    return this.gateOf() === undefined
  }

  get reason(): WeatherReason | undefined {
    return this.gateOf()
  }

  get configured(): boolean {
    return parseCoords(this.deps.settings.coords).ok
  }

  async snapshot(at?: number): Promise<WeatherView> {
    const now = at ?? this.deps.now()
    const gate = this.gateOf()
    if (gate !== undefined) return failureOf(gate, now)

    const ttlMs = Math.max(TTL_MIN, this.deps.settings.ttlMinutes) * 60_000
    const cached = this.cache
    if (cached !== undefined) {
      const age = now - cached.at
      // `age < 0` 表示时钟被往回拨过：这份缓存的「未来时间戳」不可信，重新取一次。
      if (age >= 0 && age < ttlMs) {
        this.hits += 1
        return cached.view
      }
    }
    return this.load(now)
  }

  async refresh(at?: number): Promise<WeatherView> {
    return this.load(at ?? this.deps.now())
  }

  async facts(at?: number): Promise<WeatherFacts | undefined> {
    const view = await this.snapshot(at)
    if (!view.available || view.tempC === undefined) return undefined
    return Object.freeze({
      place: view.place,
      text: sentenceOf(view),
      tempC: view.tempC,
      feelsC: view.feelsC,
      highC: view.highC,
      lowC: view.lowC,
      precipProb: view.precipProb,
      phenomenon: view.phenomenon,
      day: view.day ?? true,
      observedAt: view.observedAt,
    })
  }

  async text(at?: number): Promise<string | undefined> {
    const facts = await this.facts(at)
    if (facts === undefined) return undefined
    return facts.text === '' ? undefined : facts.text
  }

  clear(): void {
    this.cache = undefined
  }

  stats(): WeatherStats {
    const cacheAgeMs = this.cache === undefined ? undefined : Math.max(0, this.deps.now() - this.cache.at)
    return Object.freeze({
      calls: this.calls,
      hits: this.hits,
      failures: this.failures,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      cacheAgeMs,
    })
  }

  /**
   * 真的去取一次。并发调用共享同一次请求。
   * @param at 抓取时刻。
   */
  private async load(at: number): Promise<WeatherView> {
    const running = this.pending
    if (running !== undefined) return running

    // 闸门在 load 里再判一次：`refresh()` 是公开入口，可以绕过 `snapshot()`。
    const gate = this.gateOf()
    if (gate !== undefined) return failureOf(gate, at)
    const coords = parseCoords(this.deps.settings.coords)
    if (!coords.ok) return failureOf(coords.reason, at)

    const task = this.fetchOnce(buildRequest(coords.lat, coords.lon).url, at)
    this.pending = task
    try {
      return await task
    } finally {
      // 只清自己那一次：若期间被 `clear()` 换过，也不要紧（clear 不动 pending）。
      if (this.pending === task) this.pending = undefined
    }
  }

  /**
   * @param url 已校验的地址。
   * @param at 抓取时刻。
   */
  private async fetchOnce(url: string, at: number): Promise<WeatherView> {
    this.calls += 1
    const result = await this.deps.transport.request(url)
    if (!result.ok) {
      this.noteFailure(result.reason)
      return failureOf(result.reason, at)
    }

    const parsed = parsePayload(result.body, at)
    if (!parsed.ok) {
      this.noteFailure('payload')
      this.log('解析失败：%s', parsed.detail)
      return failureOf('payload', at)
    }

    const data = parsed.data
    const view: WeatherView = Object.freeze({
      available: true,
      reason: 'ok' as const,
      observedAt: data.observedAt,
      fetchedAt: at,
      place: this.deps.settings.place === '' ? undefined : this.deps.settings.place,
      tempC: data.tempC,
      feelsC: data.feelsC,
      humidity: data.humidity,
      windKph: data.windKph,
      precipMm: data.precipMm,
      precipProb: data.precipProb,
      code: data.code,
      phenomenon: phenomenonOf(data.code),
      day: data.day,
      highC: data.highC,
      lowC: data.lowC,
    })

    this.cache = { view, at }
    this.lastOkAt = at
    // 成功一次就把上一次的错误清掉：面板上的「上次失败」不该永远挂着一条旧错误。
    this.lastError = undefined
    return view
  }

  /**
   * 记一次失败。**同一个原因只告警一次**——轮询面板时每次失败都打一行，
   * 日志会被「network」刷满，而真正的第一条（时间、原因）反被埋掉。
   * @param reason 原因码。
   */
  private noteFailure(reason: WeatherReason): void {
    this.failures += 1
    const previous = this.lastError
    this.lastError = reason
    if (previous !== reason) this.log('取天气失败：%s（同一原因不再重复告警）', reason)
  }

  /**
   * 按配置决定要不要说话。`verbose=false` 时静默。
   * @param format 格式串。
   * @param args 参数。
   */
  private log(format: string, ...args: unknown[]): void {
    if (!this.deps.settings.verbose) return
    this.deps.log.warn(format, ...args)
  }
}
