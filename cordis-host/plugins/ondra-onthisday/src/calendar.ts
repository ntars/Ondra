/**
 * 日历算术。**纯函数，零 IO，零依赖**。
 *
 * ## 为什么不用「毫秒差 ÷ 一天」
 *
 * 那算的是「过了多少个 24 小时」，不是「隔了几个自然日」。
 * 夏令时切换那天会差一小时，于是「整 365 天」在切换日附近整整漏掉一条——
 * 而这种漏只在一年里的两天出现，事后从数据上看不出规律。
 * 本文件用「年月日 → 日历日序号」的整数换算（Howard Hinnant 的
 * `days_from_civil` 同构算法），与时区、夏令时、闰秒全部无关。
 *
 * ## 为什么时区解读不在这里
 *
 * 「某个时间戳是几号」取决于时区，而时区归 O-003 `ondra-clock`。
 * 本文件只接受**已经拆好的年月日**，不碰 `Date` 的本地化。
 * 唯一的例外是 `partsAt()` 在时钟缺席时的兜底，那里也只取本机时区的年月日，
 * 不做任何换算——宁可退化成「跟系统一致」，也不在插件里自带一套时区库。
 */

import type { CalendarPartsLike, ClockLike } from './types.js'
import { LEAP_FOLD_TARGET, MONTH_DAY_SPAN, YEAR_DAY } from './types.js'
import type { Shelf } from './types.js'

/** 自然日键的形状（`YYYY-MM-DD`）。 */
export const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * 是不是闰年。
 *
 * 世纪年要能被 400 整除才是闰年——所以 1900 不是、2000 是。
 * 写成 `% 4 === 0` 会让 1900 年 2 月 29 日「存在」，于是那天写下的记忆
 * 在平年被当成闰日折叠掉。
 * @param year 年。
 */
export function isLeapYear(year: number): boolean {
  if (year % 4 !== 0) return false
  if (year % 100 !== 0) return true
  return year % 400 === 0
}

/**
 * 某年某月有几天。月份非法时返回 0（调用方据此判非法，不抛）。
 * @param year 年。
 * @param month 月，1–12。
 */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31
}

/**
 * 日历年月日是否真实存在（2 月 30 日、13 月都不存在）。
 * @param year 年。
 * @param month 月。
 * @param day 日。
 */
export function isValidDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1970 || year > 9999) return false
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  return true
}

/** 补两位。 */
function pad2(value: number): string {
  return value < 10 ? '0' + String(value) : String(value)
}

/**
 * 日历三元组 → 自然日键。
 * @param parts 年月日。
 */
export function dayKeyOf(parts: CalendarPartsLike): string {
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)}`
}

/**
 * 自然日键 → 日历三元组。形状不对或日期不存在时返回 `undefined`。
 *
 * **严格校验**而不是「能解析就用」：`2026-02-30` 这种键一旦被接受，
 * 算出来的日序号是 3 月 2 日，于是「那年今日」会在错误的一天触发，
 * 而日志里看不出任何异常。
 * @param key 自然日键。
 */
export function parseDayKey(key: string): CalendarPartsLike | undefined {
  const hit = DAY_KEY_RE.exec(key)
  if (hit === null) return undefined
  const year = Number(hit[1])
  const month = Number(hit[2])
  const day = Number(hit[3])
  if (!isValidDate(year, month, day)) return undefined
  return Object.freeze({ year, month, day })
}

/**
 * 日历三元组 → 日历日序号。
 *
 * 同一天恒定、每跨一天严格 ±1，与时区无关（入参已经是拆好的年月日）。
 * 算法同 Howard Hinnant 的 `days_from_civil`：先把 3 月当作一年的开头，
 * 于是闰日落在年末，2 月的天数不用特判。
 * @param parts 年月日。
 */
export function dayNumberOf(parts: CalendarPartsLike): number {
  const month = parts.month
  const year = parts.year - (month <= 2 ? 1 : 0)
  const era = Math.floor(year / 400)
  const yearOfEra = year - era * 400
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + parts.day - 1
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra - 719468
}

/**
 * 某个时刻的日历三元组。
 *
 * 时钟在位时**必须**走它（配置的时区可能不是本机时区）；
 * 时钟缺席时退回本机时区，并保持与 `dayKeyOf()` 同一套解读——
 * 两边各用一套时区，会出现「日键是 11 月 2 日、记忆被算成 11 月 1 日」。
 * @param epoch 毫秒时间戳。
 * @param clock 时间服务，可为空。
 */
export function partsAt(epoch: number, clock: ClockLike | undefined): CalendarPartsLike | undefined {
  if (!Number.isFinite(epoch)) return undefined
  if (clock !== undefined) {
    try {
      const parts = clock.parts(epoch)
      if (
        typeof parts === 'object' &&
        parts !== null &&
        Number.isInteger(parts.year) &&
        Number.isInteger(parts.month) &&
        Number.isInteger(parts.day)
      ) {
        return Object.freeze({ year: parts.year, month: parts.month, day: parts.day })
      }
    } catch {
      // 时钟抛错就用本机时区兜底：这一块挂了不该让整个「那年今日」消失。
    }
  }
  const date = new Date(epoch)
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return undefined
  return Object.freeze({ year, month, day })
}

/**
 * 某个时刻的自然日键。
 * @param epoch 毫秒时间戳。
 * @param clock 时间服务，可为空。
 */
export function dayKeyAt(epoch: number, clock: ClockLike | undefined): string | undefined {
  const parts = partsAt(epoch, clock)
  if (parts === undefined) return undefined
  if (!isValidDate(parts.year, parts.month, parts.day)) return undefined
  return dayKeyOf(parts)
}

/** 一次命中的判定结果。 */
export interface ShelfMatch {
  /** 命中哪一档。 */
  readonly shelf: Shelf
  /** 隔了几个自然日（≥1）。 */
  readonly daysAgo: number
  /** 隔了几年（`month-day` 档为 0）。 */
  readonly yearsAgo: number
  /** 是否走了闰日折叠。 */
  readonly leapFolded: boolean
}

/** 判定的入参。 */
export interface MatchInput {
  /** 今天（已按生效时区拆好）。 */
  readonly today: CalendarPartsLike
  /** 今天的日历日序号。 */
  readonly todayNumber: number
  /** 记忆写下那天。 */
  readonly memory: CalendarPartsLike
  /** 记忆写下那天的日历日序号。 */
  readonly memoryNumber: number
  /** 2 月 29 日是否折叠到 2 月 28 日。 */
  readonly leapFold: boolean
  /** 「周年」档开关。 */
  readonly shelfAnniversary: boolean
  /** 「整年」档开关。 */
  readonly shelfYearDay: boolean
  /** 「整月」档开关。 */
  readonly shelfMonthDay: boolean
}

/**
 * 判定一条记忆今天算不算「那年今日」。
 *
 * 顺序即优先级，**一条记忆只会命中一档**：
 * 1. `anniversary`：往年同月同日（含 2 月 29 日折叠）；
 * 2. `year-day`：正好 365 天但不同月同日——只可能落在闰日与跨年错位上；
 * 3. `month-day`：差 30/31 天。
 *
 * @param input 入参。
 * @returns 命中时返回档位与差值，不命中返回 `undefined`。
 */
export function matchShelf(input: MatchInput): ShelfMatch | undefined {
  const daysAgo = input.todayNumber - input.memoryNumber
  // 今天写下的、以及时间戳在未来的（时钟回拨、导入数据）一律不算——
  // 把「今天」说成「那年今日」是最容易被用户当场发现的那种错。
  if (daysAgo < 1) return undefined

  const yearsAgo = input.today.year - input.memory.year
  if (yearsAgo < 0) return undefined

  // 1. 周年：往年同月同日。
  if (input.shelfAnniversary && yearsAgo >= 1) {
    if (input.memory.month === input.today.month && input.memory.day === input.today.day) {
      return Object.freeze({ shelf: 'anniversary', daysAgo, yearsAgo, leapFolded: false })
    }
    // 1'. 闰日折叠：2 月 29 日写下的事，在平年的 2 月 28 日也算「那年今天」。
    // 不折叠的话，那天的记忆每四年才有一次被想起来的机会——
    // 而人自己回忆时也会说「哦对，是那年二月底」。
    const [foldMonth, foldDay] = LEAP_FOLD_TARGET
    if (
      input.leapFold &&
      input.memory.month === 2 &&
      input.memory.day === 29 &&
      input.today.month === foldMonth &&
      input.today.day === foldDay &&
      !isLeapYear(input.today.year)
    ) {
      return Object.freeze({ shelf: 'anniversary', daysAgo, yearsAgo, leapFolded: true })
    }
  }

  // 2. 整年：正好 365 天。同月同日的情况已在上面被拦下，
  //    走到这里的只剩「闰日没折叠」与「跨年错位」两种边角。
  //    不放宽到 366：那只会让闰日那条在 2/28 与 3/1 各出现一次（见 `YEAR_DAY` 注释）。
  if (input.shelfYearDay) {
    if (daysAgo === YEAR_DAY) {
      return Object.freeze({ shelf: 'year-day', daysAgo, yearsAgo, leapFolded: false })
    }
  }

  // 3. 整月：差 30/31 天。
  if (input.shelfMonthDay) {
    const [low, high] = MONTH_DAY_SPAN
    if (daysAgo >= low && daysAgo <= high) {
      return Object.freeze({ shelf: 'month-day', daysAgo, yearsAgo: 0, leapFolded: false })
    }
  }

  return undefined
}

/**
 * 毫秒时长（只给日志与耗时统计用）。
 * @param from 起点。
 * @param to 终点。
 */
export function elapsedMs(from: number, to: number): number {
  return Math.max(0, Math.round(to - from))
}
