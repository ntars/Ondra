/**
 * 优先级、投递窗口与批次挑选（纯函数，无 IO、无时钟）。
 *
 * ## 优先级只影响两件事
 *
 * 1. **排队顺序**：高优先级的先出箱。
 * 2. **截断时的取舍**：一批只能取 8 条时，先取高的。
 *
 * 它**不影响**三件事，这三条是纪律：
 *
 * - 不绕过 `enable`：总开关关掉时，`ingest()` 一律抛 `disabled`，无论多「急」。
 * - 不穿过静默时段：23:00–08:00 一律只入箱不投递。给高优先级留一条「紧急所以半夜说」
 *   的路，等于把静默时段降级成建议，而建议在半夜从来不成立。
 * - 不改变去重：同一件事第二次上报，无论优先级多高都不会再播一遍。
 *
 * ## 静默时段为什么自己判一次
 *
 * 真正的静默归 O-042。本插件仍在自己这层判一次，理由是**不同的闸管不同的事**：
 * O-042 管「这条消息该不该发出去」，本插件管「这条事件该不该进今天的播报批次」。
 * 两处都判是刻意的冗余——共用一份状态会让「改一处静默」变成没人敢做的改动。
 * 也正因为只是软判断，时钟缺席时退回系统本地时区，不阻断任何事。
 */

import type { InboxItem, Priority } from './types.js'
import { PRIORITIES } from './types.js'

/** 优先级的排序权重。数字小的先出箱。 */
const RANK: Readonly<Record<Priority, number>> = Object.freeze({ high: 0, normal: 1, low: 2 })

/**
 * 规整优先级：不在闭集里的一律 `normal`。
 *
 * 不抛错是刻意的：一个拼错的优先级不该让整条事件丢失。默认值选 `normal`
 * 而不是 `high`——「不认识就当紧急」是所有告警系统里最常见的自伤。
 * @param value 待判值。
 */
export function normalizePriority(value: unknown): Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)
    ? (value as Priority)
    : 'normal'
}

/**
 * 取排序权重。
 * @param priority 优先级。
 */
export function rankOf(priority: Priority): number {
  return RANK[priority]
}

/**
 * 排序比较：先按优先级，再按事件时刻（早的先），最后按入箱序号。
 *
 * 第三项不是凑数：同一刻到达的多条事件如果没有稳定次序，每次 `pending()` 的顺序都会变，
 * 调用方按 id 去重时会看到「同一批但顺序不同」，很难查。
 * @param a 条目。
 * @param b 条目。
 */
export function compareItems(a: InboxItem, b: InboxItem): number {
  const byRank = rankOf(a.priority) - rankOf(b.priority)
  if (byRank !== 0) return byRank
  const byAt = a.at - b.at
  if (byAt !== 0) return byAt
  return a.seq - b.seq
}

/**
 * 判断某个小时是否落在静默时段内。
 *
 * 起止相同视为**不设静默**：`23` 到 `23` 既可以读成「全天静默」也可以读成「不静默」，
 * 而把两种读法都留着，迟早会有一次配错然后整天收不到任何播报。这里固定读成「不静默」，
 * 并写进 README——有歧义时选那个「不会让人整天收不到消息」的解释。
 * @param hour 小时（0–23）。
 * @param startHour 起点（含）。
 * @param endHour 终点（不含）。
 */
export function inQuietHours(hour: number, startHour: number, endHour: number): boolean {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false
  if (startHour === endHour) return false
  if (startHour < endHour) return hour >= startHour && hour < endHour
  // 跨零点：23 → 8 是最常见的一档，也是唯一需要「或」的分支。
  return hour >= startHour || hour < endHour
}

/** 挑选批次的结果。 */
export interface DeliveryResult {
  /** 本批候选。 */
  readonly items: readonly InboxItem[]
  /** 为什么是这个结果。 */
  readonly reason: 'ok' | 'queue-empty' | 'quiet-hours' | 'rate-limited' | 'stale'
}

/** 挑选批次的输入。 */
export interface DeliveryQuery {
  /** 一批最多几条。 */
  readonly maxBatch: number
  /** 本小时剩余额度。 */
  readonly quota: number
  /** 现在是否静默。 */
  readonly quiet: boolean
  /** 现在（毫秒）。 */
  readonly now: number
  /** 超龄阈值（毫秒）。 */
  readonly maxAgeMs: number
}

/**
 * 从队列里挑一批可投递的条目。**纯函数：不修改入参、不写盘、不推进任何水位。**
 *
 * 判定顺序是有讲究的：先剔超龄（这是关于条目本身的事实），再判空、再判静默、再判额度。
 * 把静默放在判空之前会让「箱子里没东西」也报成静默，调用方就分不出「今天真的没事」
 * 和「有事但被压着」。
 * @param items 队列。
 * @param query 口径。
 */
export function selectDeliverable(
  items: readonly InboxItem[],
  query: DeliveryQuery,
): DeliveryResult {
  const fresh: InboxItem[] = []
  for (const item of items) {
    if (query.now - item.at >= query.maxAgeMs) continue
    fresh.push(item)
  }
  if (fresh.length === 0) {
    return { items: [], reason: items.length === 0 ? 'queue-empty' : 'stale' }
  }
  if (query.quiet) return { items: [], reason: 'quiet-hours' }
  if (query.quota <= 0) return { items: [], reason: 'rate-limited' }
  const sorted = [...fresh].sort(compareItems)
  const limit = Math.min(query.maxBatch, query.quota, sorted.length)
  return { items: Object.freeze(sorted.slice(0, limit)), reason: 'ok' }
}

/** 清理超龄条目的结果。 */
export interface ExpireResult {
  /** 留下的条目（保持原顺序）。 */
  readonly kept: readonly InboxItem[]
  /** 被清掉的条目（服务层要连它们的指纹一起丢掉）。 */
  readonly expired: readonly InboxItem[]
}

/**
 * 清掉超龄条目。
 *
 * 清条目时**必须连指纹一起丢**（由调用方负责）：只丢条目会让「已经进过箱但没播出去」的
 * 事件在下次上报时被判成重复，于是它永远不会被播——那是最难查的一类漏播。
 * @param items 队列。
 * @param now 现在（毫秒）。
 * @param maxAgeMs 超龄阈值（毫秒）。
 */
export function expireItems(
  items: readonly InboxItem[],
  now: number,
  maxAgeMs: number,
): ExpireResult {
  const kept: InboxItem[] = []
  const expired: InboxItem[] = []
  for (const item of items) {
    if (now - item.at >= maxAgeMs) expired.push(item)
    else kept.push(item)
  }
  return { kept, expired }
}

/**
 * 找最旧的一条的下标（用于队列满时丢弃）。
 *
 * 「最旧」按事件时刻算，不按入箱顺序：一次补投的历史事件可能后到，
 * 按入箱顺序丢会把它当成最新的留着，然后先丢掉刚刚发生的那条。
 * @param items 队列。
 * @returns 下标；空队列返回 -1。
 */
export function oldestIndex(items: readonly InboxItem[]): number {
  let index = -1
  let bestAt = Number.POSITIVE_INFINITY
  let bestSeq = Number.POSITIVE_INFINITY
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as InboxItem
    if (item.at < bestAt || (item.at === bestAt && item.seq < bestSeq)) {
      index = i
      bestAt = item.at
      bestSeq = item.seq
    }
  }
  return index
}
