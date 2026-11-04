/**
 * 纯日历数学：**只管「哪一天」，不管「几点」。**
 *
 * ## 为什么这里要自己算一遍
 *
 * 时钟服务（O-003）是本插件唯一的「今天是哪一天」来源，但它是**软依赖**。
 * 缺它时若直接不能用，胶囊就变成「没装时钟就写不了信」——那太脆。
 * 故这里保留一份**退路**：用本机时区的日期三元组换算自然日序号。
 *
 * 关键点：退路**不做第二套语义**，它与 O-003 用的是同一个定义
 * （自然日序号 = 日历三元组换算，不是「毫秒除以一天」），因此两者可互换
 * 而不会在夏令时那天差一天。
 *
 * ## 存档里存的是时间戳，不是日序号（本文件第二条要记住的事）
 *
 * 日序号只是同一时刻下的相对量。若把它存进存档，用户换了时区之后
 * 那个数字仍然指向旧时区的那一天，胶囊就会在错的一天开。
 * 故存档只存 `openAt` 时间戳，`openDay` 每次视图现算。
 */

import type { ClockLike } from './types.js'

/** 一天的毫秒数。只用于「日序号换算」，不用于时间差。 */
const DAY_MS = 86_400_000

/**
 * 本机时区下某时刻的自然日序号。
 *
 * 用 `Date.UTC(年, 月, 日)` 换算而不是 `at / DAY_MS`：后者按 UTC 切日，
 * 东八区会让每天早上 8 点前算成前一天。
 * @param at 毫秒时间戳。
 */
export function localDayNumber(at: number): number {
  const date = new Date(at)
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

/**
 * 本机时区下某时刻的自然日键 `YYYY-MM-DD`。
 * @param at 毫秒时间戳。
 */
export function localDayKey(at: number): string {
  const date = new Date(at)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 本机时区下某时刻所在自然日的 00:00。
 * @param at 毫秒时间戳。
 */
export function localStartOfDay(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 日历操作的统一入口：有时钟用时钟，没有就退回本机。 */
export interface Calendar {
  /** 自然日序号。 */
  dayNumber(at: number): number
  /** 自然日键 `YYYY-MM-DD`。 */
  dayKey(at: number): string
  /** 该自然日的 00:00。 */
  startOfDay(at: number): number
  /** 相差几个自然日（`b - a`）。 */
  daysBetween(a: number, b: number): number
  /** 是否用的是退路（供日志与统计说明「为什么可能差一天」）。 */
  readonly fallback: boolean
}

/**
 * 造一个日历门面。
 * @param clock O-003 时钟；`undefined` 时退回本机时区。
 */
export function calendarOf(clock: ClockLike | undefined): Calendar {
  if (clock !== undefined) {
    return {
      fallback: false,
      dayNumber: at => safeCall(() => clock.dayNumber(at), () => localDayNumber(at)),
      dayKey: at => safeCall(() => clock.dayKey(at), () => localDayKey(at)),
      startOfDay: at => safeCall(() => clock.startOfDay(at), () => localStartOfDay(at)),
      daysBetween: (a, b) => safeCall(() => clock.daysBetween(a, b), () => localDayNumber(b) - localDayNumber(a)),
    }
  }
  return {
    fallback: true,
    dayNumber: localDayNumber,
    dayKey: localDayKey,
    startOfDay: localStartOfDay,
    daysBetween: (a, b) => localDayNumber(b) - localDayNumber(a),
  }
}

/**
 * 单次调用失败就退到本机算法。
 *
 * 上游抛错不该让「看一眼胶囊清单」也失败——那是把别人的故障传染给自己
 * （C3：器官错误不得传播，本插件按同一条纪律办）。
 * @param run 主路径。
 * @param fallback 退路。
 */
function safeCall<T>(run: () => T, fallback: () => T): T {
  try {
    return run()
  } catch {
    return fallback()
  }
}

/**
 * 把「多少天后」换成「那一天的 00:00」。
 * @param days 天数。
 * @param now 参照时刻。
 * @param calendar 日历。
 */
export function openAtAfterDays(days: number, now: number, calendar: Calendar): number {
  const target = calendar.startOfDay(now) + days * DAY_MS
  // 夏令时切换日 `+DAY_MS` 可能落到 23:00 或 01:00，再归一次零点把它扶正。
  return calendar.startOfDay(target)
}

/**
 * 判断某时刻是否已经「到了那一天」。
 *
 * 判据是**自然日序号比较**而不是时间戳比较：胶囊写的是「某一天开」，
 * 用 `now >= openAt` 会让「当天 00:00 之后写的、当天开」在写入时就已过期。
 * @param now 现在。
 * @param openAt 开封日 00:00。
 * @param calendar 日历。
 */
export function isDue(now: number, openAt: number, calendar: Calendar): boolean {
  return calendar.dayNumber(now) >= calendar.dayNumber(openAt)
}

/**
 * 距离可开还有几个自然日（已到期返回 0）。
 * @param now 现在。
 * @param openAt 开封日 00:00。
 * @param calendar 日历。
 */
export function daysLeft(now: number, openAt: number, calendar: Calendar): number {
  const gap = calendar.daysBetween(now, openAt)
  return gap > 0 ? gap : 0
}
