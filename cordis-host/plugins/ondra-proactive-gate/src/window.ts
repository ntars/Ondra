/**
 * 时间窗的纯算术。
 *
 * ## 为什么不直接用 O-003 的 `withinWindow()`
 *
 * 它会回答「在不在窗内」，但**不会回答「还有多久出窗」**。静默时段拦下一条消息时，
 * 调用方需要 `deferMs` 才能重排；如果判定用 O-003、`deferMs` 自己再算一遍，
 * 就会出现「说在窗内、算出来的等待是 0」这种两边都对不上的情况。
 *
 * 故本文件把两件事写在同一处：**判定与剩余时长共用一套环形分钟算术**。
 * 时区仍归 O-003（只取 `minuteOfDay()`）——跨零点、夏令时、非整点偏移都在那一处解决。
 *
 * 边界口径与 O-003 一致：**左闭右开**（`start` 含、`end` 不含）。
 * `start === end` 视为**空窗口**（恒 false），刻意不解释成「整天」——
 * 否则把静默时段误写成 `23:00`–`23:00` 就会变成全天静默，且很难看出来。
 */

/** 一天 1440 分钟。 */
const DAY_MINUTES = 1440

/**
 * 解析 `HH:MM`。
 * @param text 文本。
 * @returns 0–1439 的分钟数；形状不对返回 `undefined`。
 */
export function parseHhmm(text: unknown): number | undefined {
  if (typeof text !== 'string') return undefined
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour * 60 + minute
}

/**
 * 把分钟数格式化成 `HH:MM`（日志与提示用）。
 * @param minute 0–1439。
 */
export function formatHhmm(minute: number): string {
  const safe = ((Math.trunc(minute) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES
  const hour = Math.floor(safe / 60)
  const rest = safe % 60
  return String(hour).padStart(2, '0') + ':' + String(rest).padStart(2, '0')
}

/**
 * 判断某一分钟是否落在窗口内（支持跨零点）。
 * @param minute 当前分钟（0–1439）。
 * @param start 起点分钟。
 * @param end 终点分钟（不含）。
 */
export function inWindow(minute: number, start: number, end: number): boolean {
  if (start === end) return false
  if (start < end) return minute >= start && minute < end
  // 跨零点：23:00–08:00 → minute >= 1380 或 minute < 480。
  return minute >= start || minute < end
}

/**
 * 从当前分钟走到窗口终点还要多少分钟。
 *
 * 只在**窗内**调用才有意义（窗外调用会返回「绕一圈到终点」的值，没有用途）。
 * 结果为 `0` 时返回 `1440`——那是「整整一天」而不是「马上出窗」，
 * 后者会让调用方立刻重试并再次被拦。
 * @param minute 当前分钟。
 * @param end 终点分钟。
 */
export function minutesToWindowEnd(minute: number, end: number): number {
  const diff = ((end - minute) % DAY_MINUTES + DAY_MINUTES) % DAY_MINUTES
  return diff === 0 ? DAY_MINUTES : diff
}

/**
 * 把分钟数折成毫秒。
 * @param minutes 分钟数。
 */
export function minutesToMs(minutes: number): number {
  return Math.max(0, Math.trunc(minutes)) * 60_000
}

/**
 * 连续沉默了多少天。
 *
 * 用**毫秒差折算**而不是日历日差：阈值是 3 天与 7 天，夏令时带来的一小时误差
 * 影响不了这个判断，而引入第二套日历算法要多一个依赖面。
 * `lastUserAt === 0`（不知道）时返回 0 —— **不知道不能当成「沉默很久」**，
 * 否则一次状态文件损坏就会把她的额度削到零，且看起来像「她突然不理人了」。
 * @param at 当前时刻。
 * @param lastUserAt 最近一次用户开口的时刻（`0` = 不知道）。
 */
export function silentDaysOf(at: number, lastUserAt: number): number {
  if (lastUserAt <= 0) return 0
  const diff = at - lastUserAt
  if (diff <= 0) return 0
  return Math.floor(diff / 86_400_000)
}
