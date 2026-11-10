/**
 * 三层令牌桶 + 同会话冷却 + 重复去重的**纯算术**。
 *
 * ## 为什么日层是「自然日计数」而分钟/小时层是「滚动窗口」
 *
 * 这两个「日」不是同一个日（见 `types.ts` 文件头）：
 *
 * - **产品额度**（`dailyQuota`）是「今天说了几句」，跨零点归零才符合直觉；
 * - **防封速率**（`perDay=1500`）是「一天别超过 1500 条」，腾讯看的是长期曲线。
 *
 * 日层用自然日计数，代价是「23:59 与 00:01 各有 1500 额度」这个边界。
 * 不为此改成滚动 24 小时，是因为**小时层（滚动）已经把爆发挡住了**：
 * 一次爆发最多 200 条，要凑满 1500 得连着 8 个小时满速发——那不是边界效应，
 * 那是脚本在刷。把日层也做成滚动，只会让状态文件从 3KB 涨到 30KB、每次发送都要重写。
 *
 * ## 分钟/小时层必须滚动
 *
 * 固定窗口的边界效应在这里是**真问题**：23:59:59 发 20 条 + 00:00:01 再 20 条，
 * 固定窗口会放行 2 秒 40 条，而滚动窗口不会。这正是 §5.3-4 那句
 * 「只做时上限是踩过的坑」的同类事故。
 */

import { HOUR_MS, MINUTE_MS, RECORD_WINDOW_MS } from './types.js'
import type { SentRecord } from './types.js'

/**
 * 裁掉窗口外的记录，并按时刻升序排好。
 *
 * 排序不是洁癖：`bucketDeferMs()` 靠「第 N 早的那条」算等待时长，
 * 顺序错了算出来的等待就是个随机数。
 * @param records 原记录。
 * @param at 当前时刻。
 * @param windowMs 窗口长度。
 */
export function trimRecords(
  records: readonly SentRecord[],
  at: number,
  windowMs: number = RECORD_WINDOW_MS,
): readonly SentRecord[] {
  const floor = at - windowMs
  const kept = records.filter(record => record.at > floor)
  kept.sort((a, b) => a.at - b.at)
  return Object.freeze(kept)
}

/**
 * 窗口内有多少条。
 * @param records 记录（须已裁到窗口内，或更长——本函数自己会过滤）。
 * @param at 当前时刻。
 * @param windowMs 窗口长度。
 */
export function countWithin(records: readonly SentRecord[], at: number, windowMs: number): number {
  const floor = at - windowMs
  let count = 0
  for (const record of records) {
    if (record.at > floor) count += 1
  }
  return count
}

/**
 * 要让窗口内条数降到 `cap` 以下，还得等多少毫秒。
 *
 * 已在额度内返回 `0`。返回值**至少 1 毫秒**：返回 0 会让调用方立刻重试、
 * 再次被拦，形成一次没有 sleep 的忙等。
 * @param records 记录。
 * @param at 当前时刻。
 * @param cap 上限。
 * @param windowMs 窗口长度。
 */
export function bucketDeferMs(
  records: readonly SentRecord[],
  at: number,
  cap: number,
  windowMs: number,
): number {
  const floor = at - windowMs
  const recent: SentRecord[] = []
  for (const record of records) {
    if (record.at > floor) recent.push(record)
  }
  if (recent.length < cap) return 0
  recent.sort((a, b) => a.at - b.at)
  // 要降到 cap - 1 条，需要「第 (length - cap + 1) 早」的那条滑出窗口。
  const index = recent.length - cap
  const target = recent.at(index)
  if (target === undefined) return 0
  return Math.max(1, target.at + windowMs - at)
}

/**
 * 分钟层的等待时长。
 * @param records 记录。
 * @param at 当前时刻。
 * @param cap 每分钟上限。
 */
export function minuteDeferMs(records: readonly SentRecord[], at: number, cap: number): number {
  return bucketDeferMs(records, at, cap, MINUTE_MS)
}

/**
 * 小时层的等待时长。
 * @param records 记录。
 * @param at 当前时刻。
 * @param cap 每小时上限。
 */
export function hourDeferMs(records: readonly SentRecord[], at: number, cap: number): number {
  return bucketDeferMs(records, at, cap, HOUR_MS)
}

/**
 * 同会话冷却还剩多少毫秒。
 * @param lastAt 该会话上一次发送时刻（`0` = 没发过）。
 * @param at 当前时刻。
 * @param cooldownMs 冷却时长。
 */
export function cooldownDeferMs(lastAt: number, at: number, cooldownMs: number): number {
  if (lastAt <= 0) return 0
  const left = lastAt + cooldownMs - at
  return left > 0 ? left : 0
}

/**
 * 在去重窗口里找一条与 `text` 相同的记录。
 * @param records 记录。
 * @param text 待发正文。
 * @param at 当前时刻。
 * @param windowMs 去重窗口。
 * @param same 判同函数（由调用方注入，保证与本插件其它地方同一套归一化）。
 */
export function findDuplicate(
  records: readonly SentRecord[],
  text: string,
  at: number,
  windowMs: number,
  same: (a: string, b: string) => boolean,
): SentRecord | undefined {
  const floor = at - windowMs
  for (const record of records) {
    if (record.at <= floor) continue
    if (same(record.text, text)) return record
  }
  return undefined
}

/**
 * 把会话冷却表裁到「最近还可能有用的那些」。
 *
 * 不裁的话这张表会随会话数无限长，而它每次发送都要整表写进状态文件。
 * @param table 原表。
 * @param at 当前时刻。
 * @param keepMs 保留多久以内的记录。
 */
export function trimConversations(
  table: Readonly<Record<string, number>>,
  at: number,
  keepMs: number = 10 * MINUTE_MS,
): Readonly<Record<string, number>> {
  const floor = at - keepMs
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > floor) {
      out[key] = value
    }
  }
  return Object.freeze(out)
}
