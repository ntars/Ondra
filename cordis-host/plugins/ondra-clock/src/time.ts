/**
 * O-003 的纯日历数学：不碰 ctx、不注册定时器、不读盘。
 *
 * 这一层刻意与 Cordis 解耦，因为它是全仓最容易出错的一段：
 * 自然日、跨时区、夏令时三件事叠在一起时，任何「看起来更短」的写法
 * （毫秒除法、`getHours()`、算距下次毫秒）都会在换日那一刻炸掉。
 */

import { ClockFormatError } from './types.js'
import type { CalendarParts } from './types.js'

/** 一天的毫秒数。只用于「日号 × 一天」这类纯日历换算，**不用于切自然日**。 */
const MS_PER_DAY = 86_400_000

/** 补零到两位。 */
export function pad2(value: number): string {
  return value < 10 ? '0' + String(value) : String(value)
}

/**
 * 解析 `HH:MM` 成分钟数。
 * @param hhmm `HH:MM` 文本。
 * @returns 0–1439 的分钟数。
 */
export function parseHhmm(hhmm: string): number {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!matched) {
    throw new ClockFormatError(hhmm, '期望 HH:MM（例如 03:00）')
  }
  const hour = Number(matched[1])
  const minute = Number(matched[2])
  if (hour > 23 || minute > 59) {
    throw new ClockFormatError(hhmm, '小时须在 0–23、分钟须在 0–59')
  }
  return hour * 60 + minute
}

/**
 * 用 `Intl` 取某时区下的日历字段。
 *
 * 不用 `Date.prototype.getHours()`：那读的是进程本地时区，
 * 与本插件「时区可配置」的立场冲突。
 * @param epoch 毫秒时间戳。
 * @param timeZone IANA 时区名。
 */
export function calendarIn(epoch: number, timeZone: string): CalendarParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // hourCycle h23：否则 `en-US` 会把午夜输出成 24 点，日号也要跟着 +1，极易出错。
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const fields: Record<string, number> = {}
  for (const part of formatter.formatToParts(new Date(epoch))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value)
  }
  return {
    year: fields['year'] ?? 1970,
    month: fields['month'] ?? 1,
    day: fields['day'] ?? 1,
    hour: fields['hour'] ?? 0,
    minute: fields['minute'] ?? 0,
    second: fields['second'] ?? 0,
  }
}

/**
 * 把日历三元组换算成连续的日序号（1970-01-01 为 0）。
 *
 * 用 `Date.UTC` 而不是「自己算闰年」：它对 1970 前后的负值也正确，
 * 手写公式在格里高利历边界上容易翻车。
 * @param parts 日历字段。
 */
export function toDayNumber(parts: CalendarParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MS_PER_DAY)
}

/**
 * 取某时刻在目标时区相对 UTC 的偏移（毫秒）。
 * @param epoch 毫秒时间戳（按秒取整，避免毫秒残差干扰）。
 * @param timeZone IANA 时区名。
 */
function offsetAt(epoch: number, timeZone: string): number {
  const p = calendarIn(epoch, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(epoch / 1000) * 1000
}

/**
 * 把「目标时区的墙钟时间」换算成时间戳。
 *
 * 做法是「猜一个 UTC 时刻 → 用该时刻的真实偏移纠正 → 再猜」，迭代三次收敛。
 * 不用固定偏移：`Asia/Shanghai` 没有夏令时，但用户可能改成 `Europe/Berlin`。
 *
 * 两个边界如实记录：
 * - 夏令时**跳过**的墙钟（如 02:30 不存在）会落到跳变后的第一个时刻；
 * - 夏令时**重复**的墙钟（如 01:30 出现两次）取先到的那一次。
 * 这两种情况一年最多各一次，且不会让日号算错——日号始终来自日历字段。
 * @param timeZone IANA 时区名。
 * @param year 年。
 * @param month 月（1–12）。
 * @param day 日。
 * @param hour 时。
 * @param minute 分。
 */
export function wallClockToEpoch(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0)
  let guess = target
  for (let round = 0; round < 3; round += 1) {
    const next = target - offsetAt(guess, timeZone)
    if (next === guess) return next
    guess = next
  }
  return guess
}

/**
 * 某时刻所在自然日的 00:00 时间戳。
 *
 * 刻意不复用「减去墙钟偏移」：夏令时切换日墙钟差与真实流逝差一小时，
 * 直接相减会落到前一天 23:00 或当天 01:00。这里改走墙钟换算，日号不会被带偏。
 * @param epoch 毫秒时间戳。
 * @param timeZone IANA 时区名。
 */
export function startOfDayIn(epoch: number, timeZone: string): number {
  const p = calendarIn(epoch, timeZone)
  return wallClockToEpoch(timeZone, p.year, p.month, p.day, 0, 0)
}

/**
 * 按模板格式化。只支持本仓真正用到的七个占位符，不追求通用。
 * @param epoch 毫秒时间戳。
 * @param timeZone IANA 时区名。
 * @param pattern 模板。
 */
export function formatIn(epoch: number, timeZone: string, pattern: string): string {
  const p = calendarIn(epoch, timeZone)
  const millis = ((epoch % 1000) + 1000) % 1000
  return pattern.replace(/YYYY|SSS|MM|DD|HH|mm|ss/g, (token) => {
    if (token === 'YYYY') return String(p.year)
    if (token === 'SSS') return String(millis).padStart(3, '0')
    if (token === 'MM') return pad2(p.month)
    if (token === 'DD') return pad2(p.day)
    if (token === 'HH') return pad2(p.hour)
    if (token === 'mm') return pad2(p.minute)
    return pad2(p.second)
  })
}

/**
 * 判断时区名是否被运行时接受。
 *
 * 非法时区名会让 `Intl` 抛 `RangeError`，这是唯一可靠的探测方式；
 * 不能用「字符串像不像时区名」猜。
 * @param timeZone 待测时区名。
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
