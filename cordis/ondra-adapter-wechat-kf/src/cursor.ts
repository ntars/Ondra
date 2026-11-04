/**
 * 游标与去重状态。**纯数据 + 纯函数，不碰网络、不发消息。**
 *
 * ## 为什么主去重是游标，不是 `seen` 表
 *
 * 拉取式协议自带一个顺序指针：`next_cursor`。它表达的是「这一批之后的新消息」，
 * 所以只要游标推进正确，同一条消息不会第二次出现在下一批里。
 * 这是**结构性的去重**，不依赖内存、不依赖容量、重启也不丢。
 *
 * `seen` 表是兜底，只对付三种情况：
 *
 * 1. 平台把同一批重放了一遍（游标回退、或者我们崩在「已推进游标」之后）；
 * 2. 游标文件被删/坏了，从空游标重拉；
 * 3. 同一 `msgid` 因平台重试真的出现了两次。
 *
 * 所以它有容量上限（500）与时间上限（7 天），**不是账本**。
 * 把它当成主去重就会写出「表越来越大、越用越慢、最后开始误判」的老路。
 *
 * ## 游标推进的两个规矩
 *
 * 1. **整批处理完才推进**。先推进再处理，崩一次就永远丢那几条——而且无声无息。
 * 2. **平台给空游标就不推进**。空串不是「到头了」的同义词，它更可能是
 *    「这一批没东西」，把它写进状态等于把游标清空，下次从最早开始重拉。
 */

import type { KfMessage } from './types.js'
import { SEEN_LIMIT, WINDOW_LIMIT } from './types.js'
import { sha1Hex } from './wire.js'

/** `seen` 表里的一条。 */
export interface SeenEntry {
  /** 指纹（`msgid`，缺失时用内容哈希）。 */
  key: string
  /** 见到它的时刻（毫秒）。 */
  at: number
}

/** 可落盘的游标状态。字段全部可缺省，以便兼容旧文件与被手工改过的文件。 */
export interface CursorState {
  /** 游标（空串 = 还没拉过）。 */
  cursor: string
  /** 兜底去重表（按时间升序）。 */
  seen: SeenEntry[]
  /** 每个外部联系人最后一次说话的时刻（毫秒）。 */
  windows: Record<string, number>
  /** 最后一次改动时刻（毫秒）。 */
  updatedAt: number
}

/** `seen` 条目的时间上限：7 天。超过它的条目不再有兜底价值（游标早飞过去了）。 */
export const SEEN_TTL_MS = 7 * 24 * 3_600_000

/** 空状态。 */
export function emptyState(): CursorState {
  return { cursor: '', seen: [], windows: {}, updatedAt: 0 }
}

/**
 * 从任意输入解析状态。**永不抛错**，坏就回空。
 * @param raw 已 `JSON.parse` 的输入。
 */
export function parseState(raw: unknown): CursorState {
  const state = emptyState()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return state
  const record = raw as Record<string, unknown>

  if (typeof record['cursor'] === 'string') state.cursor = record['cursor']

  const seen = record['seen']
  if (Array.isArray(seen)) {
    for (const item of seen) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      const key = typeof entry['key'] === 'string' ? entry['key'] : ''
      const at = typeof entry['at'] === 'number' && Number.isFinite(entry['at']) ? entry['at'] : 0
      if (key === '' || at <= 0) continue
      state.seen.push({ key, at })
    }
  }

  const windows = record['windows']
  if (typeof windows === 'object' && windows !== null && !Array.isArray(windows)) {
    for (const [key, value] of Object.entries(windows as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) state.windows[key] = value
    }
  }

  if (typeof record['updatedAt'] === 'number' && Number.isFinite(record['updatedAt'])) {
    state.updatedAt = record['updatedAt']
  }
  return state
}

/**
 * 一条消息的去重指纹。
 *
 * 正常情况下就是 `msgid`。**没有 `msgid` 的消息不应该被静默放行**：
 * 那会让「同一条消息被拉两次」变成「她答了两遍」。所以退化成
 * 「谁 + 何时 + 说了什么」的哈希——同样的内容在同一秒重复出现，本来也该当重复。
 * @param message 已归一化的消息。
 */
export function dedupeKey(message: KfMessage): string {
  if (message.messageId !== '') return message.messageId
  return 'h-' + sha1Hex([message.externalUserId, String(message.sendTime), message.text].join('\u0000'))
}

/**
 * 有没有见过这个指纹。
 * @param state 状态。
 * @param key 指纹。
 */
export function hasSeen(state: CursorState, key: string): boolean {
  return state.seen.some(entry => entry.key === key)
}

/**
 * 记一条指纹。**先记再答**：宁可漏答一次，也不要同一条答三遍。
 *
 * 漏答会被日志记成 `send-failed`（用户能看见「她没回」并追问一次），
 * 而答三遍是人格层面的破坏——用户会认为她在刷屏。两者的代价不对称。
 * @param state 状态。
 * @param key 指纹。
 * @param at 时刻（毫秒）。
 */
export function markSeen(state: CursorState, key: string, at: number): void {
  state.seen.push({ key, at })
  if (state.seen.length > SEEN_LIMIT) {
    // 裁掉最旧的一半，不是一条：一条一条裁会在每次插入时都触发一次数组搬移。
    state.seen = state.seen.slice(Math.floor(SEEN_LIMIT / 2))
  }
  state.updatedAt = at
}

/**
 * 记「这个人刚说过话」（窗口判定的依据）。
 * @param state 状态。
 * @param externalUserId 外部联系人。
 * @param at 时刻（毫秒）。
 */
export function markTouched(state: CursorState, externalUserId: string, at: number): void {
  state.windows[externalUserId] = at
  const keys = Object.keys(state.windows)
  if (keys.length <= WINDOW_LIMIT) return
  // 超容量时按「最久没说话」淘汰：窗口判定只关心最近的，老的留着只是占内存。
  const ordered = keys.sort((left, right) => (state.windows[left] ?? 0) - (state.windows[right] ?? 0))
  for (const key of ordered.slice(0, keys.length - WINDOW_LIMIT)) delete state.windows[key]
}

/**
 * 窗口内还能不能发。
 *
 * `lastAt` 缺失时判**过期**：从没说过话的人，平台本来就不允许主动发。
 * @param lastAt 最后一次来信时刻（毫秒）。
 * @param at 当前时刻（毫秒）。
 * @param hours 窗口小时数。
 */
export function withinWindow(lastAt: number | undefined, at: number, hours: number): boolean {
  if (lastAt === undefined || lastAt <= 0) return false
  const span = at - lastAt
  // 未来时间（时钟回拨）按窗口内处理：此时拒发比误发更糟——用户刚说完话却被判成窗口外。
  if (span < 0) return true
  return span <= hours * 3_600_000
}

/**
 * 心跳清理：扔掉过老的指纹与已关窗口的人。
 * @param state 状态。
 * @param at 当前时刻（毫秒）。
 * @param hours 窗口小时数。
 */
export function prune(state: CursorState, at: number, hours: number): void {
  const seenFloor = at - SEEN_TTL_MS
  state.seen = state.seen.filter(entry => entry.at >= seenFloor)
  for (const [key, lastAt] of Object.entries(state.windows)) {
    if (!withinWindow(lastAt, at, hours)) delete state.windows[key]
  }
  state.updatedAt = at
}
