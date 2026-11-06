/**
 * 三通道视图的**聚合层**（只读）。
 *
 * ## 这里一个天数都不出现，是刻意的
 *
 * 手册 §2.4：`fact` 4 天 / `gist` 12 天 / `affect` 180 天，作为「第二层调制」
 * 与类别基线**相乘**。这三个数住在 O-010（`CHANNEL_DAYS` + `channelAnchorDays`）。
 *
 * 本插件要显示「这条走哪条通道、这条通道整体还亮不亮」，**不需要**天数：
 * 每条记录的 `stabilityHours` 已经含了通道调制的结果，平均一下就是答案。
 * 若为了显示「事实 4 天」而抄一份天数表，就会出现两个真源——
 * 改 O-010 一处，界面上的数字不跟着变，而且不报错。
 *
 * 所以 `ChannelProfile.modulation` 只给定性档位（最短/中位/最长）。
 *
 * ## 平均强度的口径
 *
 * 只算 `active`。沉底的强度必然很低（那正是它沉底的原因），封存的根本不参与回忆；
 * 把这两类混进平均，会让「这个通道整体还亮不亮」被系统性地压低——
 * 而用户看到的会是「她对这个人的记忆整体变淡了」，与事实不符。
 */

import { CHANNEL_PROFILES, MEMORY_CHANNELS } from './types.js'
import type { ChannelView, MemoryChannel, MemoryRecordLike } from './types.js'
import type { StrengthProbe } from './dice.js'

/**
 * 一条记忆走哪条通道。
 *
 * 未知通道兜底到 `gist`——与 O-010 的 `channelDaysOf()` 的兜底一致（它也按 `gist` 算）。
 * 两处兜底必须同向：若这里兜到 `fact`，界面会把一条按 12 天调制的记忆显示成 4 天档。
 * @param record 记忆。
 */
export function channelOfRecord(record: MemoryRecordLike): MemoryChannel {
  const channel = record.channel
  return (MEMORY_CHANNELS as readonly string[]).includes(channel) ? (channel as MemoryChannel) : 'gist'
}

/**
 * 聚合三通道。
 * @param records 参与统计的记录。
 * @param strengthOf 强度解析（来自 O-010；时间戳由调用方闭包绑定）。
 */
export function summarizeChannels(
  records: readonly MemoryRecordLike[],
  strengthOf: StrengthProbe,
): readonly ChannelView[] {
  return Object.freeze(
    MEMORY_CHANNELS.map(channel => {
      const mine = records.filter(record => channelOfRecord(record) === channel)
      const active = mine.filter(record => !record.archived && !record.sealed)

      let strengthSum = 0
      let stabilitySum = 0
      for (const record of active) {
        strengthSum += strengthOf(record).strength
        stabilitySum += record.stabilityHours
      }

      const samples = [...mine]
        .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
        .slice(0, 3)
        .map(record => record.id)

      return Object.freeze({
        channel,
        count: mine.length,
        active: active.length,
        archived: mine.filter(record => record.archived).length,
        sealed: mine.filter(record => record.sealed).length,
        // 空通道给 `null` 而不是 0：0 会被读成「全都快忘了」。
        avgStrength: active.length === 0 ? null : strengthSum / active.length,
        avgStabilityHours: active.length === 0 ? null : stabilitySum / active.length,
        sampleIds: Object.freeze(samples),
        profile: CHANNEL_PROFILES[channel],
      })
    }),
  )
}

/**
 * 三通道的总条数（统计用）。
 * @param views 三通道视图。
 */
export function totalOf(views: readonly ChannelView[]): number {
  return views.reduce((sum, view) => sum + view.count, 0)
}

/**
 * 取一个合法时间戳。
 * @param value 传入值。
 * @param now 当前时刻。
 */
export function stampOf(value: number | undefined, now: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : now
}
