/**
 * 纯进度层：把「已经兑现了几拍」变成一份可读的进度快照。
 *
 * **本文件没有 IO、没有 `Date`、没有定时器。** 所有时刻都由调用方传进来，
 * 于是同一串操作在任何时候重放都得到同一份进度——这是它可被静态复核的前提。
 *
 * ## 水位与账目必须分开记（本文件最容易写错的地方）
 *
 * - `position` 是**水位**：现在该做第几拍；
 * - `delivered` 是**账目**：真的把哪几拍说出来过。
 *
 * 平时两者同步增长。唯一会让它们分开的是 `interrupt()`：被打断时水位直接
 * 推到收束拍，但**绝不替对方把没听到的三拍补记为「已兑现」**——账目一旦
 * 造假，日志里就再也查不出「那次初见其实只说了两句」。
 *
 * ## 为什么进度只增不减（除了 `reset`）
 *
 * 初见是一次性的仪式。允许「退回上一拍」听起来灵活，实际会造出两种麻烦：
 * 一是两个调用方各自退一格之后水位开始飘；二是退回后重复的拍会被用户当成
 * 「她怎么又说一遍」。要重来只有一个口子：`reset()`，它会把 `restarts` 加一，
 * 于是「重来过几次」是看得见的。
 *
 * ## `interrupt` 为什么跳到收束拍而不是原地停
 *
 * 被打断说明对方已经在说话了。留在原地等「轮到我说」，会让人说完一段却等来
 * 一句不该来的自我介绍；退到收束才是对的——听见了就接上。而收束拍要做的
 * 两件事（确认称呼、记一条事实）恰恰是被打断之后最该补的。
 */

import type { BeatId, MeetSnapshot } from './types.js'
import { BEAT_IDS } from './types.js'

/** 存档形状。**只放进度与时刻**，一个字的内容都不放。 */
export interface MeetState {
  /** 是否已经见过（`met` 为假时其余字段没有意义）。 */
  readonly met: boolean
  /** 初见时刻。 */
  readonly metAt: number | null
  /** 水位：现在该做第几拍（0–5）。 */
  readonly position: number
  /** 账目：真的兑现过的节拍，按 `BEAT_IDS` 顺序。 */
  readonly delivered: readonly BeatId[]
  /** 仪式是否走完。 */
  readonly done: boolean
  /** 是否被打断过。 */
  readonly interrupted: boolean
  /** 重来次数。 */
  readonly restarts: number
}

/** 全部拍数。 */
const TOTAL_BEATS = BEAT_IDS.length

/** 空状态（没见过）。 */
export function emptyState(restarts = 0): MeetState {
  return Object.freeze({
    met: false,
    metAt: null,
    position: 0,
    delivered: Object.freeze([]) as readonly BeatId[],
    done: false,
    interrupted: false,
    restarts,
  })
}

/** 判空对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 有限正时刻，否则 `null`。 */
function stampOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.trunc(value)
}

/** 非负整数，否则 0。 */
function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.trunc(value)
}

/**
 * 只保留闭集内的节拍 id，**并按 `BEAT_IDS` 顺序重排**。
 *
 * 重排而不是照单全收：旧档若被手改成 `['invite','arrival']`，照单全收会让
 * 账目顺序与水位对不上，之后 `advance` 的校验就永远过不了。
 * @param raw 原始值。
 */
function deliveredOf(raw: unknown): readonly BeatId[] {
  if (!Array.isArray(raw)) return Object.freeze([]) as readonly BeatId[]
  const seen = new Set<BeatId>()
  for (const item of raw) {
    if (typeof item === 'string' && (BEAT_IDS as readonly string[]).includes(item)) {
      seen.add(item as BeatId)
    }
  }
  return Object.freeze(BEAT_IDS.filter(id => seen.has(id)))
}

/** 追加一拍。**幂等**：已经记过的拍不会重复出现。 */
function withBeat(delivered: readonly BeatId[], id: BeatId): readonly BeatId[] {
  if (delivered.includes(id)) return delivered
  return Object.freeze([...delivered, id])
}

/**
 * 归一化存档。**任何异常都退化成空状态**，不抛错。
 *
 * 关键取舍：`met` 为假时其余字段一律清空。留着「上次的进度但 met=false」
 * 这种半截状态，会让下一轮从第二拍开始——而那时对方其实是第一次见。
 *
 * 水位取 `max(账目长度, 存档水位)`：既挡住「账目比水位多」的坏档，
 * 也保留 `interrupt()` 之后「水位高于账目」这个合法状态。
 * @param raw 原始值。
 */
export function normalizeState(raw: unknown): MeetState {
  if (!isRecord(raw)) return emptyState()
  const restarts = countOf(raw['restarts'])
  if (raw['met'] !== true) return emptyState(restarts)
  const delivered = deliveredOf(raw['delivered'])
  const stored = countOf(raw['position'])
  const position = Math.min(TOTAL_BEATS, Math.max(delivered.length, stored))
  return Object.freeze({
    met: true,
    metAt: stampOf(raw['metAt']),
    position,
    delivered,
    done: position >= TOTAL_BEATS,
    interrupted: raw['interrupted'] === true,
    restarts,
  })
}

/**
 * 兑现**当前**水位那一拍。**纯函数**，返回新状态。
 *
 * 水位 +1 而不是「账目长度」：被打断之后水位可以比账目高，
 * 用账目长度当新水位会把她退回到第二拍去。
 * @param state 旧状态。
 * @param at 时刻。
 */
export function advanceState(state: MeetState, at: number): MeetState {
  if (state.position >= TOTAL_BEATS) return state
  const id = BEAT_IDS[state.position]
  const delivered = withBeat(state.delivered, id)
  const position = state.position + 1
  return Object.freeze({
    met: true,
    metAt: state.metAt ?? at,
    position,
    delivered,
    done: position >= TOTAL_BEATS,
    interrupted: state.interrupted,
    restarts: state.restarts,
  })
}

/**
 * 被打断：水位推到最后一拍（收束），**账目不动**。
 * @param state 旧状态。
 * @param at 时刻。
 */
export function interruptState(state: MeetState, at: number): MeetState {
  const target = TOTAL_BEATS - 1
  if (state.position >= target) {
    return Object.freeze({ ...state, met: true, metAt: state.metAt ?? at, interrupted: true })
  }
  return Object.freeze({
    met: true,
    metAt: state.metAt ?? at,
    position: target,
    delivered: state.delivered,
    done: false,
    interrupted: true,
    restarts: state.restarts,
  })
}

/**
 * 整段跳过。`done` 直接为真，`interrupted` **不置位**——
 * 「明确说了不用介绍」与「被打断」是两件事，混一起日志就读不出区别。
 *
 * 账目记满：跳过是对方明确要求的，不是我们漏了。
 * @param state 旧状态。
 * @param at 时刻。
 */
export function skipAllState(state: MeetState, at: number): MeetState {
  return Object.freeze({
    met: true,
    metAt: state.metAt ?? at,
    position: TOTAL_BEATS,
    delivered: Object.freeze([...BEAT_IDS]),
    done: true,
    interrupted: state.interrupted,
    restarts: state.restarts,
  })
}

/**
 * 组装只读快照。
 * @param state 状态。
 * @param stored 是否落盘。
 */
export function snapshotOf(state: MeetState, stored: boolean): MeetSnapshot {
  return Object.freeze({
    met: state.met,
    metAt: state.metAt,
    position: state.position,
    delivered: state.delivered,
    done: state.done,
    interrupted: state.interrupted,
    restarts: state.restarts,
    stored,
  })
}
