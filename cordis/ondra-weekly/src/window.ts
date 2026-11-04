/**
 * 窗口算术：**纯函数，不碰 ctx、不碰文件**。
 *
 * 这一层只回答一个问题：**「这一周」是哪一段**。
 *
 * ## 为什么是滚动 7 天，不是自然周
 *
 * 「这周」在中文里至少有两种算法：周一起、周日止；周日起、周六止。
 * 还有一些人按「最近七天」理解。三种都说得通，于是**必然**出现同一周被出两份周报、
 * 或者周日晚上看时少了周一那一段。故本插件只做滚动窗口（默认最近 7 天，含今天），
 * 并在 `WeeklyRange` 里把 `fromKey` / `toKey` 一起交出去——看到日期就没有歧义。
 *
 * ## 为什么日界要问 O-003 而不用 `ms / DAY_MS`
 *
 * 夏令时切换那天只有 23 或 25 小时，用毫秒除会数出 6.96 天这种值，
 * 取整之后窗口就少了一截。`clock.startOfDay()` + `clock.daysBetween()` 走日历算术，
 * 不会错。时钟缺席时才退回本机时区的近似算法，并在 `WeeklyRange.clock` 标 `false`，
 * 让消费方知道这个窗口可能差一天。
 */

import { DAY_MS, MAX_WINDOW_DAYS, MIN_WINDOW_DAYS } from './types.js'
import type { ClockLike, WeeklyRange } from './types.js'

/** 自然日键的形状。只认 `YYYY-MM-DD`。 */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 本机时区的自然日键。
 * @param epoch 毫秒时间戳。
 */
export function localDayKey(epoch: number): string {
  const date = new Date(epoch)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 本机时区某日的 00:00 时间戳。
 * @param epoch 毫秒时间戳。
 */
export function startOfLocalDay(epoch: number): number {
  const date = new Date(epoch)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 把天数夹到 1–31；非有限数用回退值。 */
export function spanOf(days: number, fallback: number): number {
  if (!Number.isFinite(days)) return fallback
  const truncated = Math.trunc(days)
  if (truncated < MIN_WINDOW_DAYS) return MIN_WINDOW_DAYS
  if (truncated > MAX_WINDOW_DAYS) return MAX_WINDOW_DAYS
  return truncated
}

/**
 * 算一个窗口。
 *
 * 起点取「`days - 1` 天前那一天的 00:00」，终点取 `now` 本身：
 * 于是窗口**含今天**，且永远不会把明天算进来。
 * @param now 参照时刻。
 * @param days 天数（会被夹到 1–31）。
 * @param clock O-003 时钟；缺席时退回本机时区。
 */
export function windowOf(now: number, days: number, clock: ClockLike | undefined): WeeklyRange {
  const span = spanOf(days, 7)
  // 起点先按毫秒粗估，再由 startOfDay 归到那一天的开头：粗估偏几小时不影响结果。
  const anchor = now - (span - 1) * DAY_MS

  if (clock !== undefined) {
    try {
      const from = clock.startOfDay(anchor)
      if (Number.isFinite(from)) {
        const fromKey = clock.dayKey(from)
        const toKey = clock.dayKey(now)
        if (DAY_KEY_RE.test(fromKey) && DAY_KEY_RE.test(toKey)) {
          const counted = clock.daysBetween(from, now) + 1
          const actual = Number.isFinite(counted) && counted >= 1 ? Math.trunc(counted) : span
          return Object.freeze({ from, to: now, days: actual, fromKey, toKey, clock: true })
        }
      }
    } catch {
      // 时钟自身抛错也走本机兜底：窗口算不准比整份骨架出不来好得多（C3 同一条纪律）。
    }
  }

  const from = startOfLocalDay(anchor)
  return Object.freeze({
    from,
    to: now,
    days: span,
    fromKey: localDayKey(from),
    toKey: localDayKey(now),
    clock: false,
  })
}

/**
 * 某时刻是否落在窗口内（左闭右闭：`to` 就是调用时刻）。
 * @param at 时刻。
 * @param range 窗口。
 */
export function withinRange(at: number, range: WeeklyRange): boolean {
  return at >= range.from && at <= range.to
}

/**
 * 某自然日键是否落在窗口内。按字符串比较：`YYYY-MM-DD` 的字典序就是时间序。
 * @param dayKey 自然日键。
 * @param range 窗口。
 */
export function dayKeyInRange(dayKey: string, range: WeeklyRange): boolean {
  if (!DAY_KEY_RE.test(dayKey)) return false
  return dayKey >= range.fromKey && dayKey <= range.toKey
}
