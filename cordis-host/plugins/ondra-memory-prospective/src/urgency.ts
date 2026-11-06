/**
 * 「反向权重」——承诺的紧迫度（**纯函数，不碰 ctx、不碰库**）。
 *
 * 这是本插件与记忆域其余部分**方向相反**的一条时间轴，也是本轮最容易抄错的地方：
 *
 * ```
 * 记忆强度  0.5^(Δt/S)          越久越淡  ── 单调递减
 * 承诺紧迫  随剩余时间倒数上升   越近越急  ── 单调递增
 * ```
 *
 * 一条 `promise` 类的记忆有 8000 小时基线，按记忆强度的算法，它写下来之后
 * 大半年都「很新鲜」——但承诺的价值不在「新鲜」，在「快到了」。
 * 若沿用强度排序，注入块 ① 会在到期前 2 小时把一条三天前的琐事排在它前面。
 *
 * **手册只写了「反向权重」四个字，没有给曲线。** 本插件取一个分段线性的口径，
 * 并把参数全部做成配置（`urgencyHorizonDays` / `urgencyFloor`），
 * 登记为待裁决（README 已知限制 1）。曲线本身只有一段，没有第二个真源：
 *
 * ```
 * urgency(d) = 1                                          d ≤ 0（到期日与宽限期内）
 *            = floor + (1-floor) × (1 - d/horizon)         0 < d < horizon
 *            = floor                                       d ≥ horizon
 * ```
 *
 * 其中 `d` 是剩余天数。三个性质都是刻意的：
 * - `d = horizon` 时正好落到 `floor`，曲线连续，不会在窗口边界跳变；
 * - `d ≤ 0` 恒为 1（**不是继续上升**）——过期后的「更急」应该由提醒去表达，
 *   而不是让一个 0–1 的数溢出；
 * - 非 `open` 状态恒为 0：结算完的承诺不该继续占据注入位。
 */

import type { ReminderItem } from './types.js'

/** 一天的毫秒数（**只用于把时间差换算成天数**，不用于日历推进）。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 剩余天数。负数表示已过到期时刻（可能仍在宽限期内）。
 * @param dueAt 到期时刻；`0` 表示无期限。
 * @param at 当前时刻。
 */
export function daysLeftOf(dueAt: number, at: number): number {
  if (dueAt <= 0) return Number.POSITIVE_INFINITY
  return (dueAt - at) / DAY_MS
}

/**
 * 剩余小时数（提醒文案直接用这个）。
 * @param dueAt 到期时刻；`0` 表示无期限。
 * @param at 当前时刻。
 */
export function hoursLeftOf(dueAt: number, at: number): number {
  if (dueAt <= 0) return Number.POSITIVE_INFINITY
  return (dueAt - at) / (60 * 60 * 1000)
}

/**
 * 紧迫度 0–1。
 * @param input 到期时刻、状态、当前时刻与两个参数。
 */
export function urgencyOf(input: {
  readonly dueAt: number
  readonly state: string
  readonly at: number
  readonly horizonDays: number
  readonly floor: number
}): number {
  // 已结算 / 已过期：不占注入位。这里必须给 0 而不是 floor——
  // 否则一条上个月就该兑现的承诺会永远排在待办前面。
  if (input.state !== 'open') return 0
  // 无期限（「下次」）：只保留底分，不升温。它连「什么时候算到期」都没有。
  if (input.dueAt <= 0) return input.floor
  const d = daysLeftOf(input.dueAt, input.at)
  if (d <= 0) return 1
  if (d >= input.horizonDays) return input.floor
  return input.floor + (1 - input.floor) * (1 - d / input.horizonDays)
}

/**
 * 排序比较器：紧迫度高的在前；同分按到期早的在前；再无期限的垫底。
 *
 * 排序必须是**全序**（`compare` 三态），不能只给「a 是否比 b 急」的布尔——
 * 布尔比较器在 `Array.prototype.sort` 里会让顺序取决于引擎实现。
 * @param a 甲。
 * @param b 乙。
 */
export function compareUrgency(a: ReminderItem, b: ReminderItem): number {
  if (b.urgency !== a.urgency) return b.urgency - a.urgency
  const left = a.promise.dueAt <= 0 ? Number.POSITIVE_INFINITY : a.promise.dueAt
  const right = b.promise.dueAt <= 0 ? Number.POSITIVE_INFINITY : b.promise.dueAt
  if (left !== right) return left - right
  return 0
}
