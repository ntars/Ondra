/**
 * 公历的**纯函数**层：不碰 ctx、不碰文件、不碰外部包。
 *
 * 这里只放「能一眼验算对错」的东西：日期分量、星期、一年第几天、闰年、前后挪日。
 * 农历、节气、干支一律不在这里——那些需要历法表，属复用档（见 `branches/`）。
 *
 * ## 为什么挪日走日历分量
 *
 * `dayKey ± n * 86400000` 在夏令时切换日会差一小时，于是「昨天」偶尔算成「前天」。
 * `new Date(y, m - 1, d + delta)` 让引擎按日历算，跨月跨年都对。
 */

import { DAY_KEY_RE } from './types.js'

/** 日期分量。 */
export interface SolarParts {
  /** 年。 */
  readonly year: number
  /** 月 1–12。 */
  readonly month: number
  /** 日 1–31。 */
  readonly day: number
}

/** 各月的天数（非闰年）。 */
const MONTH_DAYS: readonly number[] = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])

/** 一个月有几个 31 天之前的累计天数（用于算一年第几天）。 */
const CUMULATIVE: readonly number[] = Object.freeze([0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334])

/**
 * 拆日期分量。
 * @param dayKey `YYYY-MM-DD`。
 */
export function partsOf(dayKey: string): SolarParts {
  return {
    year: Number(dayKey.slice(0, 4)),
    month: Number(dayKey.slice(5, 7)),
    day: Number(dayKey.slice(8, 10)),
  }
}

/** 是否闰年。 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * 某月有几天。
 * @param year 年。
 * @param month 月 1–12。
 */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return MONTH_DAYS[month - 1] ?? 30
}

/**
 * 是否是**真实存在**的一天。
 *
 * 只看正则不够：`2026-02-30` 也匹配 `^\d{4}-\d{2}-\d{2}$`。
 * 面板传进来一个 2 月 30 日时，`new Date(2026, 1, 30)` 会被引擎悄悄改成 3 月 2 日——
 * 于是「看那一天」变成「看另一天」，而且没有任何报错。
 * @param dayKey 自然日键。
 */
export function isValidDay(dayKey: string): boolean {
  if (!DAY_KEY_RE.test(dayKey)) return false
  const { year, month, day } = partsOf(dayKey)
  if (month < 1 || month > 12) return false
  if (day < 1 || day > daysInMonth(year, month)) return false
  return true
}

/**
 * 星期几（0 = 周日）。
 * @param dayKey 自然日键。
 */
export function weekdayOf(dayKey: string): number {
  const { year, month, day } = partsOf(dayKey)
  // 取当天中午，避开「夏令时把 00:00 挪走」的边缘情况。
  return new Date(year, month - 1, day, 12, 0, 0, 0).getDay()
}

/**
 * 一年中的第几天（1–366）。
 * @param dayKey 自然日键。
 */
export function dayOfYearOf(dayKey: string): number {
  const { year, month, day } = partsOf(dayKey)
  const base = CUMULATIVE[month - 1] ?? 0
  return base + day + (month > 2 && isLeapYear(year) ? 1 : 0)
}

/**
 * 前后挪几天。
 * @param dayKey 自然日键。
 * @param delta 天数，负数往前。
 */
export function shiftDay(dayKey: string, delta: number): string {
  const { year, month, day } = partsOf(dayKey)
  const shifted = new Date(year, month - 1, day + delta, 12, 0, 0, 0)
  const outYear = String(shifted.getFullYear()).padStart(4, '0')
  const outMonth = String(shifted.getMonth() + 1).padStart(2, '0')
  const outDay = String(shifted.getDate()).padStart(2, '0')
  return `${outYear}-${outMonth}-${outDay}`
}

/**
 * 毫秒时间戳 → 本机时区的自然日键。
 *
 * **只在没有 `ondra-clock` 时用**：有它就一定走 `clock.dayKey()`，
 * 因为「自然日」必须与产品时区一致（跨时区部署时差一天）。
 * @param epoch 毫秒时间戳。
 */
export function localDayKeyOf(epoch: number): string {
  const date = new Date(epoch)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 两个自然日键相差几天（`b - a`）。
 * @param a 起点。
 * @param b 终点。
 */
export function daysBetween(a: string, b: string): number {
  const left = Date.UTC(partsOf(a).year, partsOf(a).month - 1, partsOf(a).day)
  const right = Date.UTC(partsOf(b).year, partsOf(b).month - 1, partsOf(b).day)
  return Math.round((right - left) / 86_400_000)
}
