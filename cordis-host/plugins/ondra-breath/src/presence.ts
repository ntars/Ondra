/**
 * 「正在输入」的**纯映射**：阶段 → 该不该显示。
 *
 * 只有一张表，没有第二个判据。这张表把 O-039 已经定下的口径变成可执行的东西：
 *
 * | 阶段 | 显示 | 为什么 |
 * |---|---|---|
 * | `thinking` | 是 | 首条之前 800–2000ms，她确实在想 |
 * | `typing` | 是 | 正常打字 |
 * | `paused` | **否** | 长停顿 3–9 秒，她走神了。指示器亮 9 秒却一个字不来，比不亮更假 |
 * | `idle` | 否 | 本轮结束 |
 *
 * 「`paused` 不显示」**刻意没有开关**。开关一开，症状是「她一直显示正在输入，
 * 但就是不发消息」——这种「看起来在忙、其实没动」最难归因，
 * 没人会想到是某个布尔值被打开了。
 */

import type { PresenceReason, PresenceView, TypingPhaseLike } from './types.js'

/** 阶段 → 是否显示。 */
const SHOW_OF_PHASE: Readonly<Record<TypingPhaseLike, boolean>> = Object.freeze({
  thinking: true,
  typing: true,
  paused: false,
  idle: false,
})

/** 阶段 → 原因码。 */
const REASON_OF_PHASE: Readonly<Record<TypingPhaseLike, PresenceReason>> = Object.freeze({
  thinking: 'thinking',
  typing: 'typing',
  paused: 'paused',
  idle: 'idle',
})

/** 判一个值是不是已知阶段。 */
export function isTypingPhase(value: unknown): value is TypingPhaseLike {
  return value === 'thinking' || value === 'typing' || value === 'paused' || value === 'idle'
}

/**
 * 把任意值收窄成阶段。
 *
 * 认不出来的一律当 `idle`（不显示）——上游改了枚举时，
 * 错误的方向应该是「不显示正在输入」，而不是「永远显示」。
 * @param value 原始值。
 */
export function normalizePhase(value: unknown): TypingPhaseLike {
  return isTypingPhase(value) ? value : 'idle'
}

/**
 * 阶段 → 判定结果。
 * @param phase 阶段。
 * @param conversationId 会话 id。
 */
export function presenceOf(phase: TypingPhaseLike, conversationId: string): PresenceView {
  return Object.freeze({
    conversationId,
    show: SHOW_OF_PHASE[phase],
    phase,
    reason: REASON_OF_PHASE[phase],
  })
}

/**
 * 不显示的判定（关掉、没有上游时用）。
 * @param conversationId 会话 id。
 * @param reason 原因码。
 */
export function hidden(conversationId: string, reason: PresenceReason): PresenceView {
  const view: PresenceView = { conversationId, show: false, phase: 'idle', reason }
  return Object.freeze(view)
}
