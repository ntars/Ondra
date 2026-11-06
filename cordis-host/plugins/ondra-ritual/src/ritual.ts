/**
 * 纯判定层：把「一份上游事实」变成「今天是什么日子」，再变成「一份仪式」。
 *
 * **本文件没有 IO、没有 `Date`、没有定时器、没有 `async`。** 所有入参都由调用方
 * 传进来，于是同一份事实在任何时候重放都得到同一份仪式——这是它可被静态复核的前提。
 *
 * ## 为什么分两步（`classifyDay` → `planOf`）
 *
 * 「今天是什么日子」是**事实**，「这一天给什么仪式」是**择取**。合成一步之后，
 * 「上游说是寒食、我们表里没有」这种情况就只能二选一：说成普通的一天（撒谎），
 * 或者现编一条（更糟）。分开之后，`today()` 老实报「今天是寒食」，
 * `ritualOf()` 老实报「没有可确认的仪式」，两句都是真的。
 *
 * ## 为什么 `planOf()` 里一个数字都没有
 *
 * 仪式的全部文案都是常量字符串，且**一个数字都不含**：不报「还有几天」、
 * 不报「第几个节气」、不报温度。要报就得先算，算出来就一定有一次会算错，
 * 而算错的那一次不会报错，只会安静地把冬至说成还剩四十多天。
 *
 * ## 上游缺席时给什么
 *
 * 只给**公历季节**这一个粗格子，并且**明确说「今天没有可确认的仪式」**。
 * 季节不是日子，说「现在是冬天」不需要任何历法；而说「今天是立冬」
 * 需要一张表，我们没有，所以不说。
 */

import type {
  DayFactsLike,
  DayFactsView,
  DayHint,
  LiveEventLike,
  RitualPlan,
  Season,
  UpcomingRitual,
} from './types.js'
import { RITUAL_TABLE, SEASON_LABEL, UNIVERSAL_MUST_NOT } from './table.js'
import type { RitualEntry } from './table.js'

/** 降级与无仪式时那句恒定的话。**故意只写一次**：这句话不该被各处改写成不同版本。 */
const NO_RITUAL_TEXT = '今天没有可确认的仪式'

/** `planOf` 的开关。只收不放，故只有两个布尔。 */
export interface PlanOptions {
  /** 是否把传统节日也纳入仪式。 */
  readonly includeFestivals: boolean
  /** 下雨时是否换成室内替代动作。 */
  readonly wetAdjust: boolean
}

/**
 * 查仪式表。
 *
 * 不直接写 `RITUAL_TABLE[name]`：那份表的类型是 `Record<string, RitualEntry>`，
 * 直接索引在类型上永远是「一定有」，于是「表里没有」这条分支在类型层面写不出来。
 * 包一层之后，`undefined` 才是一个能表达、也必须处理的状态——**这正是本插件的核心性质**。
 * @param name 上游给的名字。
 */
export function lookupRitual(name: string): RitualEntry | undefined {
  return Object.prototype.hasOwnProperty.call(RITUAL_TABLE, name) ? RITUAL_TABLE[name] : undefined
}

/**
 * 由公历月份判季节（三月到五月为春，依次类推）。
 *
 * 括号里没有「按节气」这三个字：按节气判季节就要查那二十四天，
 * 那是上游的活。这里要的只是一个「上游不在时也说得出口」的粗格子，
 * 所以宁可粗到月份，也不在这里开第二张节气表。
 * @param month 公历月 1–12；非法值按冬天处理。
 */
export function seasonOf(month: number): Season {
  if (!Number.isFinite(month) || month < 1 || month > 12) return 'winter'
  if (month <= 2) return 'winter'
  if (month <= 5) return 'spring'
  if (month <= 8) return 'summer'
  if (month <= 11) return 'autumn'
  return 'winter'
}

/**
 * 在当天的节日里找**表里有**的那一个。
 *
 * 农历节日排在前面：同一天既是农历节日又是公历节日（极少，但存在），
 * 农历那个才是「今天是这个日子」的本意。
 * @param facts 上游事实。
 */
function festivalHit(facts: DayFactsLike): string | null {
  for (const name of facts.lunarFestivals) {
    const entry = lookupRitual(name)
    if (entry !== undefined && entry.kind === 'festival') return name
  }
  for (const name of facts.solarFestivals) {
    const entry = lookupRitual(name)
    if (entry !== undefined && entry.kind === 'festival') return name
  }
  return null
}

/**
 * 判定这一天是什么日子。**只查表，不重算历法。**
 *
 * 匹配顺序是「节气优先」：清明既是节气也是节日，两个身份给的是同一段方向，
 * 但记成节气更准（它是按太阳位置定的，不是按农历）。
 * @param facts 上游事实（已确认农历分支在位）。
 */
export function classifyDay(facts: DayFactsLike): DayFactsView {
  const season = seasonOf(facts.month)
  const jieQi = facts.jieQi

  // 上游给了节气名就一定是节气日，哪怕我们表里没有它——「今天是寒食」这个事实
  // 与「我们有没有寒食的仪式」是两件事，不能因为后者缺失就把前者抹掉。
  if (jieQi !== null && jieQi !== '') {
    const asJieQi: DayFactsView = {
      dayKey: facts.dayKey,
      weekdayName: facts.weekdayName,
      kind: 'jieqi',
      dayName: jieQi,
      season,
      confirmed: true,
      source: 'live',
      upstream: facts.provider,
      lunarReady: facts.lunarReady,
    }
    return Object.freeze(asJieQi)
  }

  const hit = festivalHit(facts)
  if (hit !== null) {
    const asFestival: DayFactsView = {
      dayKey: facts.dayKey,
      weekdayName: facts.weekdayName,
      kind: 'festival',
      dayName: hit,
      season,
      confirmed: true,
      source: 'live',
      upstream: facts.provider,
      lunarReady: facts.lunarReady,
    }
    return Object.freeze(asFestival)
  }

  const ordinary: DayFactsView = {
    dayKey: facts.dayKey,
    weekdayName: facts.weekdayName,
    kind: 'ordinary',
    dayName: null,
    season,
    confirmed: false,
    source: 'live',
    upstream: facts.provider,
    lunarReady: facts.lunarReady,
  }
  return Object.freeze(ordinary)
}

/**
 * 造一份「只有公历」的降级事实。
 *
 * `weekdayName` 给空串：**星期几也不自己排**。排一份星期表当然只要七行，
 * 但那样一来本插件就多了一处「自己算日期」的地方，而这一处的第一个 bug
 * 会是时区——它只在跨时区时出现，很难复现，也很难怪到这个插件头上。
 * @param dayKey 自然日键。
 * @param month 公历月（用于判季节）。
 */
export function solarOnlyDay(dayKey: string, month: number): DayFactsView {
  const view: DayFactsView = {
    dayKey,
    weekdayName: '',
    kind: 'ordinary',
    dayName: null,
    season: seasonOf(month),
    confirmed: false,
    source: 'solar',
    upstream: 'none',
    lunarReady: false,
  }
  return Object.freeze(view)
}

/**
 * 造一份「没有可确认的仪式」。
 * @param day 当天的判定。
 * @param note 一句中文说明**为什么**没有。
 */
function noRitual(day: DayFactsView, note: string): RitualPlan {
  const plan: RitualPlan = {
    kind: day.source === 'solar' ? 'season' : 'none',
    dayName: day.dayName,
    confirmed: false,
    season: day.season,
    direction: NO_RITUAL_TEXT,
    action: null,
    actionIndoor: null,
    mustNot: UNIVERSAL_MUST_NOT,
    note,
  }
  return Object.freeze(plan)
}

/**
 * 由判定择取一份仪式。**纯查表。**
 * @param day `classifyDay()` / `solarOnlyDay()` 的返回值。
 * @param options 两个开关。
 * @param hint 天气软判断，省略即「不知道」。
 */
export function planOf(day: DayFactsView, options: PlanOptions, hint?: DayHint): RitualPlan {
  if (day.source === 'solar') {
    return noRitual(
      day,
      '上游日期服务不在或没有农历分支，按公历只知道现在是' +
        SEASON_LABEL[day.season] +
        '；不猜节气，也不猜节日。',
    )
  }
  if (day.dayName === null) {
    return noRitual(day, '上游日期服务在场，今天不是节气，也不是仪式表里的日子。')
  }

  const entry = lookupRitual(day.dayName)
  if (entry === undefined) {
    return noRitual(day, '上游说今天是「' + day.dayName + '」，但仪式表里没有这一天——不现编一条。')
  }
  if (entry.kind === 'festival' && !options.includeFestivals) {
    return noRitual(day, '节日仪式已关闭（include-festivals），只认二十四节气。')
  }

  // 下雨才换室内版本，且只有表里写了替代动作才换：没有替代就照原样给，
  // 硬编一句「改在室内做」会让「去剪个头发」这类动作变得没法执行。
  const wet = hint?.wet === true && options.wetAdjust && entry.indoor !== null
  const plan: RitualPlan = {
    kind: entry.kind,
    dayName: day.dayName,
    confirmed: true,
    season: day.season,
    direction: entry.direction,
    action: wet ? entry.indoor : entry.action,
    actionIndoor: entry.indoor,
    mustNot: UNIVERSAL_MUST_NOT,
    note:
      '依据上游日期服务的' +
      (entry.kind === 'jieqi' ? '节气' : '农历节日') +
      '判定' +
      (wet ? '；今天要下，动作换成了室内那个' : '') +
      '。',
  }
  return Object.freeze(plan)
}

/**
 * 从上游的未来事件里挑出**表里有**的几个。
 *
 * `daysAway` 与 `dayKey` 一进这里就被丢掉：上游给它们是为了排日程，
 * 而本插件**一个数字都不给**——连「还有三天」也不给。要说的只是「快到冬至了」。
 * @param events 上游事件。
 * @param options 开关。
 * @param limit 最多几条。
 */
export function pickUpcoming(
  events: readonly LiveEventLike[],
  options: PlanOptions,
  limit: number,
): readonly UpcomingRitual[] {
  const out: UpcomingRitual[] = []
  const seen = new Set<string>()
  for (const event of events) {
    if (out.length >= limit) break
    const entry = lookupRitual(event.name)
    if (entry === undefined) continue
    if (entry.kind === 'festival' && !options.includeFestivals) continue
    if (seen.has(event.name)) continue
    seen.add(event.name)
    out.push(Object.freeze({ kind: entry.kind, name: event.name }))
  }
  return Object.freeze(out)
}
