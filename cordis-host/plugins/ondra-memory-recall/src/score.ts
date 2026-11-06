/**
 * 五因子计算与归一化（**纯函数，不碰 ctx、不碰库**）。
 *
 * 手册 §2.3 的五因子：语义 .18 + 关键词 .46 + 图谱 .11 + 重要 .14 + 新鲜 .11。
 * 三条纪律写在这里，而不是散在服务里：
 *
 * 1. **分母只算参与的因子。** 缺席的因子不能当 0 分算——那会把全库分数一起压低，
 *    表现为「今天她什么都想不起来」。故 `compose()` 返回 `used` 与 `normalized`，
 *    调用方据此能回答「这一轮到底按几项归一化的」。
 * 2. **新鲜度用的是内核算好的 S，本文件不重算。** `record.stabilityHours` 是
 *    O-010 的当前 S（含提及因子、命中因子、订正倍数）。在这里再套一遍
 *    「提及拉长半衰期」，等于同一件事乘两遍。
 * 3. **每项都夹到 0–1。** 五因子的权重只在同一量纲下才有意义；
 *    某一项越界（比如向量分支返回 1.4 的相似度）会让它单独吃掉整个排序。
 */

import { SPEC_WEIGHTS } from './types.js'
import type { MemoryRecordLike, RecallFactorName, RecallFactors } from './types.js'

/** 一小时的毫秒数。 */
const HOUR_MS = 3600000

/** 夹到 0–1。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 关键词因子：把无上界的 BM25 分单调压到 0–1。
 *
 * `x / (x + half)`：分到 `half` 时恰为 0.5，分趋于无穷时趋于 1。
 * 比 `1 - exp(-x)` 好解释（「半分点」是个能直接调的数），也不会在 x 很小时塌成 0。
 * @param raw BM25 分（≥0）。
 * @param half 半分点。
 */
export function keywordFactorOf(raw: number, half: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0
  const h = half > 0 ? half : 1
  return clamp01(raw / (raw + h))
}

/**
 * 重要因子：`salience / 100`。
 *
 * 刻意不再乘一个「重要与否」的开关：`important` 只决定归档窗口（30 天 / 90 天），
 * 若它同时进排序，就会出现「同一批记忆因为跨过阈值而整体上浮」的台阶，
 * 而那条阈值本来是给归档用的。
 * @param record 记忆。
 */
export function importanceOf(record: MemoryRecordLike): number {
  return clamp01(record.salience / 100)
}

/**
 * 新鲜因子：`0.5^(Δt / S)`。
 *
 * 锚点是 `lastHitAt ?? createdAt`（手册原话），半衰期取**当前** S。
 * S 缺失或非正时退化成 0——「连半衰期都没有的记忆」不该因为新鲜度得分虚高而上浮。
 * @param record 记忆。
 * @param at 时间戳。
 */
export function freshnessOf(record: MemoryRecordLike, at: number): number {
  const halfLifeHours = record.stabilityHours
  if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0) return 0
  const anchor = record.lastHitAt ?? record.createdAt
  const deltaHours = Math.max(0, (at - anchor) / HOUR_MS)
  return clamp01(Math.pow(0.5, deltaHours / halfLifeHours))
}

/** 因子入参：缺席的给 `null`，参与不了的给 `undefined`（同义，但显式写 `null` 更清楚）。 */
export interface FactorInput {
  /** 语义（向量分支）。缺席给 `null`。 */
  readonly semantic?: number | null
  /** 关键词（字面族）。 */
  readonly keyword: number
  /** 图谱（O-015）。缺席给 `null`。 */
  readonly graph?: number | null
  /** 重要。 */
  readonly importance: number
  /** 新鲜。 */
  readonly freshness: number
}

/**
 * 合成五因子：返回加权和（已归一化）与参与集合。
 *
 * 手册 §2.3「归一化只除以参与权重的因子」。
 * @param input 因子。
 */
export function composeFactors(input: FactorInput): { score: number; used: readonly RecallFactorName[]; normalized: number } {
  const used: RecallFactorName[] = []
  let weighted = 0
  let normalized = 0

  const semantic = input.semantic ?? null
  if (semantic !== null) {
    used.push('semantic')
    weighted += clamp01(semantic) * SPEC_WEIGHTS.semantic
    normalized += SPEC_WEIGHTS.semantic
  }

  used.push('keyword')
  weighted += clamp01(input.keyword) * SPEC_WEIGHTS.keyword
  normalized += SPEC_WEIGHTS.keyword

  const graph = input.graph ?? null
  if (graph !== null) {
    used.push('graph')
    weighted += clamp01(graph) * SPEC_WEIGHTS.graph
    normalized += SPEC_WEIGHTS.graph
  }

  used.push('importance')
  weighted += clamp01(input.importance) * SPEC_WEIGHTS.importance
  normalized += SPEC_WEIGHTS.importance

  used.push('freshness')
  weighted += clamp01(input.freshness) * SPEC_WEIGHTS.freshness
  normalized += SPEC_WEIGHTS.freshness

  return { score: normalized === 0 ? 0 : clamp01(weighted / normalized), used, normalized }
}

/**
 * 把合成结果与原始因子拼成对外视图。
 * @param input 因子。
 * @param composed 合成结果。
 */
export function toFactorsView(
  input: FactorInput,
  composed: { score: number; used: readonly RecallFactorName[]; normalized: number },
): RecallFactors {
  return {
    semantic: input.semantic === undefined || input.semantic === null ? null : clamp01(input.semantic),
    keyword: clamp01(input.keyword),
    graph: input.graph === undefined || input.graph === null ? null : clamp01(input.graph),
    importance: clamp01(input.importance),
    freshness: clamp01(input.freshness),
    used: composed.used,
    normalized: composed.normalized,
  }
}
