/**
 * 排序（**纯函数**）。
 *
 * ## 字典序，不是加权
 *
 * `score = (8 − 序位) × 10 + 权重`。序位相差 1 就是 10 分，而权重最多 1 分——
 * 所以任何一条高序位的候选都排在所有低序位候选前面，**权重只在同种类内起作用**。
 *
 * 这不是「顺手这么写」，而是手册的原话：§5.1 说的是**「话由优先级」**。
 * 若改成加权，一条刚生成的弱承诺（紧迫度 0.1）就可能压过一条张力 95 的执念，
 * 于是「该说心事的时候她在提明天交周报」。
 *
 * ## 排序键要有第三段
 *
 * `score` 相等时按 `key` 升序。少了这一段，`Array.prototype.sort` 在不同引擎上
 * 对相等元素的相对顺序不保证，同一批候选两次调用可能给出不同的 `pick`——
 * 而「她这次选了 A、下次选了 B」在日志里完全看不出来。
 *
 * ## 冷却中的候选**照样排序、照样返回**
 *
 * 手册 §12.1 的 P0 是「不按条数砍」。冷却不是「砍掉」，是「标出来」：
 * 面板要能回答「她为什么这次没话说」——答案是「有 3 条，但全在冷却里」，
 * 而不是「一条都没有」。故 `ReasonCandidate.cooling` 是一个字段，不是过滤器。
 */

import { KIND_ORDER, KIND_STEP } from './types.js'
import type { CandidateSeed, ReasonCandidate } from './types.js'
import { coolingUntil } from './cooldown.js'
import type { CooldownEntry } from './cooldown.js'

/** 夹到 0–1。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 某种类的序位（0 = 最高）。
 * @param kind 种类。
 */
export function orderOf(kind: string): number {
  const index = KIND_ORDER.indexOf(kind as (typeof KIND_ORDER)[number])
  return index < 0 ? KIND_ORDER.length : index
}

/**
 * 排序分。
 * @param kind 种类。
 * @param weight 强度 0–1。
 */
export function scoreOf(kind: string, weight: number): number {
  return (KIND_ORDER.length - orderOf(kind)) * KIND_STEP + clamp01(weight)
}

/**
 * 排序并标注冷却。
 * @param seeds 候选。
 * @param entries 冷却表。
 * @param at 时刻。
 */
export function rank(
  seeds: readonly CandidateSeed[],
  entries: readonly CooldownEntry[],
  at: number,
): readonly ReasonCandidate[] {
  const scored = seeds.map(item => {
    const until = coolingUntil(entries, item.topic)
    const candidate: ReasonCandidate = {
      ...item,
      score: scoreOf(item.kind, item.weight),
      rank: 0,
      cooling: until > at,
      cooledUntil: until > at ? until : 0,
    }
    return candidate
  })

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // 第三段：稳定序。少了它，同分候选的顺序由引擎决定。
    return a.key < b.key ? -1 : a.key > b.key ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0
  })

  return Object.freeze(
    scored.map((item, index) => Object.freeze({ ...item, rank: index + 1 })),
  )
}

/**
 * 取最高分且未冷却的那条。
 * @param candidates 已排序的候选。
 */
export function pickOf(candidates: readonly ReasonCandidate[]): ReasonCandidate | undefined {
  for (const item of candidates) {
    if (!item.cooling) return item
  }
  return undefined
}
