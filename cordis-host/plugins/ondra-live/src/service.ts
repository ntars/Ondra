/**
 * `ondra-live` 的业务层：**唯一一处把分支、节日表、公历算术拼成「今天是什么日子」**。
 *
 * ## 缓存为什么是「整天清空」而不是 LRU
 *
 * 一天的事实算一次是几十微秒（农历分支是一次对象构造），缓存的价值只在
 * 「同一轮对话里反复问今天几号」。所以上限一到就整体清空，是最省心也最不容易错的做法：
 * LRU 要么自己写链表、要么用 `Map` 的插入序伪装——而这两种都会在「只读也刷新顺序」
 * 这个坑上栽一次（纪律 73）。缓存丢了只是重算，不会算错。
 *
 * ## 三个「不猜」的落点
 *
 * 1. 农历拿不到 → `lunar: null`，不编一个「假设是农历初一」；
 * 2. 节气拿不到 → `jieQi: null`，不拿节气名表按日期硬套（节气是太阳黄经，不是固定日期）；
 * 3. 日期键非法 → **按今天算并在日志里说一句**，不返回到处是 `NaN` 的事实。
 *
 * ## 与「前缀缓存」的关系（手册 §8.5）
 *
 * `text()` 输出的是**易变段**：它每天变、甚至跨零点就变。调用方必须把它追加到
 * 提示词尾部，不能拼进冻结前缀——拼进去会让缓存命中率从 99% 掉到接近 0，
 * 而症状是「账单变贵」，没有任何报错。这一点写在 `text()` 的注释里，也写在 README。
 */

import { shiftDay, isValidDay, localDayKeyOf, partsOf, weekdayOf, dayOfYearOf, isLeapYear } from './solar.js'
import { lunarFestivalsOf, solarFestivalsOf } from './festivals.js'
import { describeSelection, selectProviders } from './select.js'
import { WEEKDAY_NAMES } from './types.js'
import type {
  ClockLike,
  CrosscheckMismatch,
  CrosscheckReport,
  DateFacts,
  JieQiView,
  LiveEvent,
  LiveService,
  LiveStats,
  LogLike,
  LunarSnapshot,
  ProviderStatus,
} from './types.js'
import { UPCOMING_CEIL } from './settings.js'
import type { Config } from './settings.js'
import type { Selection } from './select.js'

/** 服务依赖。 */
export interface LiveOptions {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 时钟（只用来取自然日键）。 */
  readonly clock: () => ClockLike | undefined
  /** 现在。 */
  readonly now: () => number
}

/** 找下一个节气时最多往后看多少天。两个节气之间最多隔 16 天，30 天是两倍余量。 */
export const JIEQI_SCAN_DAYS = 30

/** 对拍默认比几天。比一周足够发现「历法表过期」，再长只是多烧 CPU。 */
export const CROSSCHECK_DAYS = 7

/** 统计计数器的可变形状（对外只给只读快照）。 */
interface Counters {
  calls: number
  cacheHits: number
  crosschecks: number
  mismatches: number
  refreshes: number
  errors: number
}

/** 服务的实现。 */
export class Live implements LiveService {
  private readonly deps: LiveOptions
  private selection: Selection
  private readonly factsCache = new Map<string, DateFacts>()
  private readonly jieQiCache = new Map<string, string>()
  private readonly counters: Counters = {
    calls: 0,
    cacheHits: 0,
    crosschecks: 0,
    mismatches: 0,
    refreshes: 0,
    errors: 0,
  }

  constructor(deps: LiveOptions) {
    this.deps = deps
    this.selection = selectProviders(deps.settings.provider, deps.log)
  }

  get available(): boolean {
    return this.deps.settings.enable
  }

  get reason(): 'disabled' | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  get provider(): 'lunar-js' | 'tyme4ts' | 'solar-only' {
    return this.selection.chosen.name
  }

  get lunarReady(): boolean {
    return this.selection.lunarReady
  }

  /* ---------------------------------------------------------------- *
   * 事实
   * ---------------------------------------------------------------- */

  facts(at?: number): DateFacts {
    return this.of(this.dayKeyOf(at ?? this.deps.now()))
  }

  of(dayKey: string): DateFacts {
    this.counters.calls += 1
    if (!isValidDay(dayKey)) {
      const fallback = this.dayKeyOf(this.deps.now())
      this.deps.log.warn('日期键非法（%s），按今天（%s）算', dayKey, fallback)
      return this.of(fallback)
    }

    const cached = this.factsCache.get(dayKey)
    if (cached !== undefined) {
      this.counters.cacheHits += 1
      return cached
    }

    const facts = this.build(dayKey)
    this.remember(dayKey, facts)
    return facts
  }

  text(at?: number): string {
    const facts = this.facts(at)
    const bits: string[] = [`${facts.month} 月 ${facts.day} 日 ${facts.weekdayName}`]
    if (facts.lunar !== null) {
      const leap = facts.lunar.leap ? '闰' : ''
      bits.push(`农历${leap}${facts.lunar.monthName}月${facts.lunar.dayName}`)
    }
    if (facts.jieQi !== null) bits.push(`今天${facts.jieQi}`)
    if (facts.festivals.length > 0) bits.push(`今天是${facts.festivals.join('、')}`)
    if (facts.nextJieQi !== null) {
      bits.push(`距${facts.nextJieQi.name}还有 ${facts.nextJieQi.daysAway} 天`)
    }
    return bits.join('，')
  }

  upcoming(days?: number, at?: number): readonly LiveEvent[] {
    const start = this.dayKeyOf(at ?? this.deps.now())
    const span = Math.max(0, Math.min(days ?? this.deps.settings.upcomingDays, UPCOMING_CEIL))
    const out: LiveEvent[] = []
    for (let index = 0; index <= span; index += 1) {
      const dayKey = shiftDay(start, index)
      const facts = this.of(dayKey)
      if (facts.jieQi !== null) {
        out.push({ kind: 'jieqi', name: facts.jieQi, dayKey, daysAway: index })
      }
      for (const name of facts.solarFestivals) {
        out.push({ kind: 'festival', name, dayKey, daysAway: index })
      }
      for (const name of facts.lunarFestivals) {
        out.push({ kind: 'lunar-festival', name, dayKey, daysAway: index })
      }
    }
    return out
  }

  /* ---------------------------------------------------------------- *
   * 对拍
   * ---------------------------------------------------------------- */

  crosscheck(days?: number, at?: number): CrosscheckReport {
    this.counters.crosschecks += 1
    const comparable = this.selection.comparable
    const span = Math.max(1, Math.min(days ?? CROSSCHECK_DAYS, UPCOMING_CEIL))
    const names = comparable.map(provider => provider.name)

    if (comparable.length < 2) {
      return {
        providers: names,
        days: 0,
        fields: 0,
        mismatches: [],
        summary:
          comparable.length === 0
            ? '没有任何农历分支在位，无可对拍（只有公历事实可用）'
            : `只有一条农历分支在位（${names[0] ?? '?'}），无可对拍`,
      }
    }

    const first = comparable[0]
    const second = comparable[1]
    const mismatches: CrosscheckMismatch[] = []
    const start = this.dayKeyOf(at ?? this.deps.now())

    if (first === undefined || second === undefined) {
      // 上面已判过 length，这里只是让类型收窄，不会走到。
      return { providers: names, days: 0, fields: 0, mismatches, summary: '分支数量不足，跳过' }
    }

    for (let index = 0; index < span; index += 1) {
      const dayKey = shiftDay(start, index)
      const a = this.safeLunar(first, dayKey)
      const b = this.safeLunar(second, dayKey)
      if (a !== null && b !== null) {
        if (a.month !== b.month || a.day !== b.day) {
          mismatches.push({
            dayKey,
            field: 'lunar',
            a: `${a.month}-${a.day}`,
            b: `${b.month}-${b.day}`,
          })
        }
        if (a.leap !== b.leap) {
          mismatches.push({ dayKey, field: 'leap', a: String(a.leap), b: String(b.leap) })
        }
      }
      const qa = this.safeJieQi(first, dayKey)
      const qb = this.safeJieQi(second, dayKey)
      if (qa !== qb) {
        mismatches.push({ dayKey, field: 'jieQi', a: qa === '' ? '(空)' : qa, b: qb === '' ? '(空)' : qb })
      }
    }

    this.counters.mismatches += mismatches.length
    if (mismatches.length > 0) {
      this.deps.log.warn(
        '农历对拍发现 %d 处差异（%s 与 %s）：至少一条分支的历法表需要更新',
        mismatches.length,
        first.name,
        second.name,
      )
    }

    return {
      providers: names,
      days: span,
      fields: 3,
      mismatches,
      summary:
        mismatches.length === 0
          ? `${first.name} 与 ${second.name} 在 ${span} 天内完全一致`
          : `${first.name} 与 ${second.name} 在 ${span} 天内有 ${mismatches.length} 处不一致`,
    }
  }

  /* ---------------------------------------------------------------- *
   * 分支管理
   * ---------------------------------------------------------------- */

  refresh(): readonly ProviderStatus[] {
    this.counters.refreshes += 1
    this.factsCache.clear()
    this.jieQiCache.clear()
    this.selection = selectProviders(this.deps.settings.provider, this.deps.log)
    this.deps.log.info('日期事实分支已重新探测：%s', describeSelection(this.selection))
    return this.selection.providers
  }

  stats(): LiveStats {
    return Object.freeze({
      calls: this.counters.calls,
      cacheHits: this.counters.cacheHits,
      cachedDays: this.factsCache.size,
      providers: Object.freeze(this.selection.providers.map(status => Object.freeze({ ...status }))),
      provider: this.selection.chosen.name,
      crosschecks: this.counters.crosschecks,
      mismatches: this.counters.mismatches,
      refreshes: this.counters.refreshes,
      errors: this.counters.errors,
    })
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  /**
   * 拼一天的事实。**只读、无副作用**（写缓存由 `of()` 做，免得两处都写）。
   * @param dayKey 合法的自然日键。
   */
  private build(dayKey: string): DateFacts {
    const parts = partsOf(dayKey)
    const weekday = weekdayOf(dayKey)
    const lunar = this.lunarOf(dayKey)
    const tomorrow = lunar === null ? null : this.lunarOf(shiftDay(dayKey, 1))
    const solarFestivals = solarFestivalsOf(dayKey)
    const lunarFestivals = lunarFestivalsOf(lunar, tomorrow)
    const jieQiName = this.jieQiOf(dayKey)

    return Object.freeze({
      dayKey,
      year: parts.year,
      month: parts.month,
      day: parts.day,
      weekday,
      weekdayName: WEEKDAY_NAMES[weekday] ?? '',
      dayOfYear: dayOfYearOf(dayKey),
      leapYear: isLeapYear(parts.year),
      lunar,
      jieQi: jieQiName === '' ? null : jieQiName,
      nextJieQi: this.nextJieQiFrom(dayKey),
      solarFestivals,
      lunarFestivals,
      festivals: Object.freeze(
        [...new Set([...solarFestivals, ...lunarFestivals])].sort((a, b) => a.localeCompare(b, 'zh')),
      ),
      provider: this.selection.chosen.name,
      lunarReady: this.selection.lunarReady,
    })
  }

  /**
   * 取农历（带异常兜底：分支抛错也不许传播，§8.1 C3）。
   * @param dayKey 自然日键。
   */
  private lunarOf(dayKey: string): LunarSnapshot | null {
    try {
      return this.selection.chosen.lunarOf(dayKey)
    } catch (error) {
      this.counters.errors += 1
      this.deps.log.warn(
        '分支 %s 取农历失败（已降级为无农历）：%s',
        this.selection.chosen.name,
        error instanceof Error ? error.message : String(error),
      )
      return null
    }
  }

  /**
   * 取节气名（带自己的小缓存：找下一个节气要连着读十几天）。
   * @param dayKey 自然日键。
   */
  private jieQiOf(dayKey: string): string {
    const cached = this.jieQiCache.get(dayKey)
    if (cached !== undefined) return cached
    let name = ''
    try {
      name = this.selection.chosen.jieQiOf(dayKey)
    } catch (error) {
      this.counters.errors += 1
      this.deps.log.warn(
        '分支 %s 取节气失败（当作没有节气）：%s',
        this.selection.chosen.name,
        error instanceof Error ? error.message : String(error),
      )
      name = ''
    }
    if (this.jieQiCache.size >= this.deps.settings.cacheDays * 2) this.jieQiCache.clear()
    this.jieQiCache.set(dayKey, name)
    return name
  }

  /**
   * 从某天往后找第一个节气。
   * @param dayKey 起点（不含）。
   */
  private nextJieQiFrom(dayKey: string): JieQiView | null {
    if (!this.selection.lunarReady) return null
    for (let index = 1; index <= JIEQI_SCAN_DAYS; index += 1) {
      const key = shiftDay(dayKey, index)
      const name = this.jieQiOf(key)
      if (name !== '') return { name, dayKey: key, daysAway: index }
    }
    return null
  }

  /**
   * 对拍时安全取农历（异常一律当 `null`，不进 `errors`——对拍不该污染主链统计）。
   * @param provider 分支。
   * @param dayKey 自然日键。
   */
  private safeLunar(provider: { lunarOf(dayKey: string): LunarSnapshot | null }, dayKey: string): LunarSnapshot | null {
    try {
      return provider.lunarOf(dayKey)
    } catch {
      return null
    }
  }

  /**
   * 对拍时安全取节气。
   * @param provider 分支。
   * @param dayKey 自然日键。
   */
  private safeJieQi(provider: { jieQiOf(dayKey: string): string }, dayKey: string): string {
    try {
      return provider.jieQiOf(dayKey)
    } catch {
      return ''
    }
  }

  /**
   * 写缓存，超上限就整体清空。
   * @param dayKey 自然日键。
   * @param facts 事实。
   */
  private remember(dayKey: string, facts: DateFacts): void {
    if (this.factsCache.size >= this.deps.settings.cacheDays) this.factsCache.clear()
    this.factsCache.set(dayKey, facts)
  }

  /**
   * 某时刻的自然日键。有 `ondra-clock` 就用它（产品时区），没有退回本机时区。
   * @param at 时刻。
   */
  private dayKeyOf(at: number): string {
    const clock = this.deps.clock()
    return clock === undefined ? localDayKeyOf(at) : clock.dayKey(at)
  }
}
