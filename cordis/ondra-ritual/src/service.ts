/**
 * 接线与降级：把纯判定层（`ritual.ts`）接上日期、时钟与天气。
 *
 * ## 本插件不持有任何状态
 *
 * 没有存档、没有「今天做过没有」、没有上一次给的仪式。这不是省事：
 * 一旦记了「今天已做过」，第二天它就会开始问「昨天为什么没做」，
 * 而这个问题属于打卡应用，不属于一个说「今天冬至」的插件。
 *
 * 唯一的可变状态是 `stats()` 里那几个计数——**只在内存**，重启归零，
 * 且只用于「它到底降级了几次」这一个诊断问题。
 *
 * ## 四种降级，各自看得见
 *
 * | 缺什么 | 退回什么 | 怎么看出来 |
 * |---|---|---|
 * | `ondra-live` | 只有公历季节，明确报「无仪式」 | `source='solar'` + 一行日志 |
 * | `ondra-live` 有但没农历分支 | 同上（没有农历就没有节气，也没有农历节日） | `source='solar'` |
 * | `ondra-clock` | 本机时区的自然日 | `dayKey` 仍正确，无额外告警 |
 * | `ondra-weather` | 不做雨天判断，动作照原样给 | `wetHint()` 返回 `undefined` |
 *
 * `ondra-config-schema` 的降级在 `index.ts`（配置在装载期就定型了）。
 *
 * ## 它不发出任何一句话
 *
 * 返回值只有事实与仪式的骨架（方向 + 动作 + 禁令）。说什么、什么时候说、
 * 说不说，全部不归这里。
 */

import type {
  ClockLike,
  DayFactsLike,
  DayFactsView,
  DayHint,
  LiveLike,
  LogLike,
  RitualErrorCode,
  RitualPlan,
  RitualService,
  RitualStats,
  UpcomingRitual,
  WeatherFactsLike,
  WeatherLike,
} from './types.js'
import { RitualError } from './types.js'
import type { Config } from './settings.js'
import { classifyDay, pickUpcoming, planOf, solarOnlyDay } from './ritual.js'

/** 降雨概率到多少算「今天要下」。一半一半就提醒换动作，总比让人淋一场好。 */
const WET_PRECIP_PROB = 50

/** 现象里出现这些字就当要下。宁可多判一次「要下」，也不让人白跑一趟。 */
const WET_PATTERN = /雨|雪|雷|冰|雹/

/** 依赖。全部用取值函数：上游晚装载时能自愈，早卸载时立刻退回降级。 */
export interface RitualDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 日期事实服务（可能缺席）。 */
  readonly live: () => LiveLike | undefined
  /** 时钟服务（可能缺席）。 */
  readonly clock: () => ClockLike | undefined
  /** 天气服务（可能缺席）。 */
  readonly weather: () => WeatherLike | undefined
  /** 系统时钟（毫秒）。 */
  readonly now: () => number
}

/** 把时刻参数规整成合法值；非法一律抛 `bad-request`。 */
function atOf(given: number | undefined, now: () => number): number {
  const at = given === undefined ? now() : given
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
    throw new RitualError('bad-request', '时刻必须是正的有限数', String(given))
  }
  return Math.trunc(at)
}

/** 本机时区的自然日键。只做公历格式化，**不碰农历**。 */
function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return String(date.getFullYear()) + '-' + month + '-' + day
}

/** 天气事实算不算「今天要下」。 */
function isWet(facts: WeatherFactsLike): boolean {
  const prob = facts.precipProb
  if (typeof prob === 'number' && Number.isFinite(prob) && prob >= WET_PRECIP_PROB) return true
  const phenomenon = facts.phenomenon
  return typeof phenomenon === 'string' && WET_PATTERN.test(phenomenon)
}

/** 节气仪式。 */
export class Ritual implements RitualService {
  readonly #deps: RitualDeps

  /** `today()` 调用次数。 */
  #calls = 0

  /** 返回过「有仪式」的次数。 */
  #confirmed = 0

  /** 返回过「无仪式」的次数。 */
  #empty = 0

  /** 上游缺席而降级的次数。 */
  #degraded = 0

  /** 最近一次失败原因。 */
  #lastIssue: string | undefined

  /**
   * @param deps 依赖。
   */
  constructor(deps: RitualDeps) {
    this.#deps = deps
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): RitualErrorCode | undefined {
    return this.available ? undefined : 'disabled'
  }

  /** 取错误消息文本。 */
  #messageOf(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  /** 总开关关掉时，读方法也一律拒绝：**静默给一份看起来正常的仪式比报错更糟**。 */
  #guard(): void {
    if (!this.available) {
      throw new RitualError('disabled', '节气仪式已关闭（enable=false）')
    }
  }

  /** 自然日与月份。优先走 O-003，缺席时按本机时区自己格式化公历。 */
  #solarOf(at: number): { readonly dayKey: string; readonly month: number } {
    const clock = this.#deps.clock()
    if (clock !== undefined) {
      try {
        const dayKey = clock.dayKey(at)
        if (typeof dayKey === 'string' && dayKey.length >= 7) {
          const month = Number(dayKey.slice(5, 7))
          if (month >= 1 && month <= 12) return { dayKey, month }
        }
      } catch (error) {
        this.#lastIssue = '时钟服务取值失败，按本机时区格式化：' + this.#messageOf(error)
      }
    }
    const date = new Date(at)
    return { dayKey: localDayKey(date), month: date.getMonth() + 1 }
  }

  /**
   * 今天是什么日子。
   * @param at 毫秒时间戳，省略用系统时间。
   */
  today(at?: number): DayFactsView {
    this.#guard()
    const stamp = atOf(at, this.#deps.now)
    this.#calls += 1

    const live = this.#deps.live()
    if (live === undefined) {
      return this.#degrade('没有 ondra-live，只能按公历说是哪个季节', this.#solarOf(stamp))
    }

    let facts: DayFactsLike
    try {
      facts = live.facts(stamp)
    } catch (error) {
      // 降级原因先落到局部变量再传下去：`#lastIssue` 的类型是「可能没有」，
      // 直接传会逼出一个非空断言，而那个断言迟早会在某次重构里变成为空。
      const issue = 'ondra-live 取事实失败，退回公历季节：' + this.#messageOf(error)
      return this.#degrade(issue, this.#solarOf(stamp))
    }

    // 没有农历分支就没有节气、也没有农历节日——那时上游给的 `jieQi` 恒为 null，
    // 直接当成「今天什么都不是」会说谎（它会说「今天不是节气」，
    // 而它其实只是不知道）。所以走降级，并且明说是降级。
    if (!facts.lunarReady) {
      return this.#degrade('ondra-live 没有农历分支，节气与农历节日都不可知', {
        dayKey: facts.dayKey,
        month: facts.month,
      })
    }

    return classifyDay(facts)
  }

  /** 造降级事实，并记一次降级。 */
  #degrade(issue: string, solar: { readonly dayKey: string; readonly month: number }): DayFactsView {
    this.#degraded += 1
    this.#lastIssue = issue
    return solarOnlyDay(solar.dayKey, solar.month)
  }

  /**
   * 由日子的判定择取仪式。
   * @param day `today()` 的返回值。
   * @param hint 天气软判断，省略即「不知道」。
   */
  ritualOf(day: DayFactsView, hint?: DayHint): RitualPlan {
    if (typeof day !== 'object' || day === null || typeof day.dayKey !== 'string') {
      throw new RitualError('bad-request', '日子必须是 today() 的返回值', typeof day)
    }
    const plan = planOf(
      day,
      { includeFestivals: this.#deps.settings.includeFestivals, wetAdjust: this.#deps.settings.wetAdjust },
      hint,
    )
    if (plan.action === null) this.#empty += 1
    else this.#confirmed += 1
    return plan
  }

  /**
   * 快到了的几个日子。只有名字，没有天数。
   * @param at 毫秒时间戳，省略用系统时间。
   */
  upcoming(at?: number): readonly UpcomingRitual[] {
    this.#guard()
    const stamp = atOf(at, this.#deps.now)
    const live = this.#deps.live()
    if (live === undefined) {
      this.#degraded += 1
      this.#lastIssue = '没有 ondra-live，说不出快到了哪一天'
      return Object.freeze([])
    }
    try {
      const events = live.upcoming(this.#deps.settings.scanDays, stamp)
      return pickUpcoming(
        events,
        {
          includeFestivals: this.#deps.settings.includeFestivals,
          wetAdjust: this.#deps.settings.wetAdjust,
        },
        this.#deps.settings.upcomingLimit,
      )
    } catch (error) {
      this.#lastIssue = 'ondra-live 取未来事件失败：' + this.#messageOf(error)
      this.#deps.log.warn('%s（这一次不报「快到了」）', this.#lastIssue)
      return Object.freeze([])
    }
  }

  /**
   * 问一次天气，只回答「今天会不会下」。
   * @param at 毫秒时间戳，省略用系统时间。
   */
  async wetHint(at?: number): Promise<boolean | undefined> {
    const weather = this.#deps.weather()
    if (weather === undefined) return undefined
    try {
      const facts = await weather.facts(at)
      if (facts === undefined) return undefined
      return isWet(facts)
    } catch (error) {
      this.#lastIssue = 'ondra-weather 取天气失败：' + this.#messageOf(error)
      return undefined
    }
  }

  /** 累计统计快照。 */
  stats(): RitualStats {
    const base = {
      calls: this.#calls,
      confirmed: this.#confirmed,
      empty: this.#empty,
      degraded: this.#degraded,
    }
    return Object.freeze(
      this.#lastIssue === undefined ? base : { ...base, lastIssue: this.#lastIssue },
    )
  }
}
