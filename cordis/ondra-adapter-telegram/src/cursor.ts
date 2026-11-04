/**
 * 游标与兜底去重。**纯数据 + 纯函数，不碰网络、不发消息。**
 *
 * ## 为什么主去重是 `offset`，不是 `seen` 表
 *
 * `getUpdates` 的 `offset` 是一个顺序指针，它的语义就是「`update_id` 小于它
 * 的那些，我已经收过了」。只要它推进正确，同一条更新**不会**在下一批里再出现。
 * 这是**结构性**去重：不依赖内存、不依赖容量、重启也不丢。
 *
 * `seen` 表只是兜底，只对付三种情况：
 *
 * 1. 状态文件被删/坏了，从 `offset = 0` 重新拉（Telegram 会重投一批）；
 * 2. 我们崩在「处理完、还没来得及推进 offset」之间；
 * 3. 同一 `update_id` 因为平台重试真的出现两次。
 *
 * 所以它有容量上限（500）与时间上限（24 小时），**不是账本**。
 *
 * ## 推进 offset 的两条规矩
 *
 * 1. **整批处理完才推进**。先推进再处理，崩一次就永远丢那几条——而且无声无息。
 * 2. **不收窄**。`offset` 只取「比现在大」的值；平台返回更小的值（回退、重放旧批）
 *    一律忽略。写回去等于把自己送回过去，那一批会被重放一遍。
 *
 * ## 为什么用 `Map` 不用 `Record`
 *
 * `Record<string, number>` 上取下标在 `noUncheckedIndexedAccess` 关闭时类型是
 * `number`，「判一下有没有」写成 `!== undefined` 会被 TS 判成类型无重叠，
 * 写 `?? 0` 则是死代码。`Map.get()` 天然是 `number | undefined`。
 */

import { SEEN_LIMIT, SEEN_TTL_MS } from './types.js'

/** 游标状态。 */
export interface CursorState {
  /** 下一条要取的 `update_id`（0 = 还没拉过）。 */
  offset: number
  /** 兜底去重表（键 → 见到它的时刻）。 */
  seen: Map<string, number>
}

/** 空状态。 */
export function emptyState(): CursorState {
  return { offset: 0, seen: new Map() }
}

/**
 * 从任意输入解析状态。**永不抛错**，坏就回空。
 * @param raw 已 `JSON.parse` 的输入。
 */
export function parseState(raw: unknown): CursorState {
  const state = emptyState()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return state
  const record = raw as Record<string, unknown>

  const offset = record['offset']
  if (typeof offset === 'number' && Number.isFinite(offset) && offset > 0) {
    state.offset = Math.trunc(offset)
  }

  const seen = record['seen']
  if (typeof seen === 'object' && seen !== null && !Array.isArray(seen)) {
    for (const [key, value] of Object.entries(seen as Record<string, unknown>)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
      state.seen.set(key, value)
    }
  }
  return state
}

/**
 * 序列化成可落盘的形状。
 *
 * 只写 `offset` 与 `seen`：**没有 `updatedAt`**。它当初是为了「看一眼上次推进是什么时候」
 * 加的，实际没有任何一处读它——留着的代价是每次心跳都要改写文件，
 * 而没有人因此得到任何信息。
 * @param state 状态。
 */
export function toJson(state: CursorState): string {
  return JSON.stringify({ offset: state.offset, seen: Object.fromEntries(state.seen) })
}

/**
 * 推进 offset。**只增不减**，返回是否真的变了。
 * @param state 状态。
 * @param updateId 这一批里最大的 `update_id`。
 */
export function advanceTo(state: CursorState, updateId: number): boolean {
  if (!Number.isFinite(updateId) || updateId <= 0) return false
  const next = Math.trunc(updateId) + 1
  if (next <= state.offset) return false
  state.offset = next
  return true
}

/**
 * 这个键最近见过吗。
 * @param state 状态。
 * @param key 去重键。
 * @param at 当前时刻（毫秒）。
 */
export function seenRecently(state: CursorState, key: string, at: number): boolean {
  const seenAt = state.seen.get(key)
  if (seenAt === undefined) return false
  // 未来时刻（时钟回拨）按「见过」处理：宁可漏答一次，也不要同一句答两遍。
  if (seenAt > at) return true
  return at - seenAt < SEEN_TTL_MS
}

/**
 * 记一条键，并按容量裁剪。
 * @param state 状态。
 * @param key 去重键。
 * @param at 时刻（毫秒）。
 */
export function markSeen(state: CursorState, key: string, at: number): void {
  state.seen.set(key, at)
  if (state.seen.size <= SEEN_LIMIT) return
  // 裁掉最旧的一半，不是一条：一条一条裁会在每次插入时都触发一次全量排序。
  const ordered = [...state.seen.entries()].sort((left, right) => left[1] - right[1])
  for (const [item] of ordered.slice(0, ordered.length - Math.floor(SEEN_LIMIT / 2))) state.seen.delete(item)
}

/**
 * 心跳清理：扔掉过老的兜底记录。
 * @param state 状态。
 * @param at 当前时刻（毫秒）。
 */
export function prune(state: CursorState, at: number): void {
  const floor = at - SEEN_TTL_MS
  for (const [key, seenAt] of state.seen) {
    // 未来时刻（时钟回拨）**留着**：`seenRecently()` 把它当「见过」，
    // 这里删掉就等于让回拨那段时间的重复消息重新回答一遍。
    if (seenAt < floor) state.seen.delete(key)
  }
}
