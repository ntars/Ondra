/**
 * 纯计算层：阈值漂移公式、特质夹紧、解释文案。
 *
 * 不碰 ctx、不碰存储、不碰时钟。这一层是「她为什么变了」的全部算术，
 * 必须能被单独对拍（本轮已用 Python 复刻跑过 0–5000–1e6 全区间扫描）。
 */

import {
  DRIFT_RATE,
  DRIFT_SATURATION,
  MAX_DRIFT_RATIO,
  MAX_INTERACTIONS,
} from './types.js'
import type { ThresholdView, TraitSpec } from './types.js'

/** 夹到 [lo, hi]。非有限值归 `lo`。 */
export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.min(hi, Math.max(lo, value))
}

/**
 * 互动次数 → 进度与系数。
 *
 * ```text
 * progress = min(1, n / 5000)
 * factor   = 1 + 0.6 × progress      // 再夹一次 1.6，防「斜率被改大」时静默越界
 * ```
 * @param interactions 互动次数。
 */
export function driftProgress(interactions: number): { readonly progress: number; readonly factor: number } {
  const n = clamp(interactions, 0, MAX_INTERACTIONS)
  const progress = Math.min(1, n / DRIFT_SATURATION)
  const raw = 1 + DRIFT_RATE * progress
  const factor = Math.min(1 + MAX_DRIFT_RATIO, raw)
  return Object.freeze({ progress, factor })
}

/**
 * 生效阈值。
 * @param base 调用方自己的基线。
 * @param interactions 互动次数。
 */
export function effectiveThreshold(base: number, interactions: number): number {
  if (!Number.isFinite(base)) return 0
  const { factor } = driftProgress(interactions)
  return base * factor
}

/**
 * 阈值漂移的完整解释（`thresholdOf` 与 `explainThreshold` 共用这一处）。
 * @param key 标签。
 * @param base 基线。
 * @param interactions 互动次数。
 */
export function explainThreshold(key: string, base: number, interactions: number): ThresholdView {
  const safeBase = Number.isFinite(base) ? base : 0
  const { progress, factor } = driftProgress(interactions)
  const effective = safeBase * factor
  const rise = factor - 1
  const headroom = safeBase * MAX_DRIFT_RATIO * (1 - progress)
  const saturated = progress >= 1

  const label = key.length > 0 ? `「${key}」的阈值` : '阈值'
  const tail = saturated
    ? '已经涨满了（上限 +60%），再相处也不会更高。'
    : `还能再涨 ${round2(headroom)}。`

  return Object.freeze({
    key,
    base: safeBase,
    interactions: Math.trunc(clamp(interactions, 0, MAX_INTERACTIONS)),
    progress,
    factor,
    effective,
    rise,
    saturated,
    headroom,
    // 这句要能直接回答手册那句「为什么以前 60 就算开心，现在要 80」。
    sentence: `${label}：出厂 ${round2(safeBase)}，相处 ${Math.trunc(clamp(interactions, 0, MAX_INTERACTIONS))} 次后要 ${round2(effective)}（×${round2(factor)}）。${tail}`,
  })
}

/** 特质的漂移区间。 */
export function traitBounds(spec: TraitSpec): { readonly floor: number; readonly ceiling: number } {
  return Object.freeze({
    floor: Math.max(spec.min, spec.base - spec.maxDrift),
    ceiling: Math.min(spec.max, spec.base + spec.maxDrift),
  })
}

/**
 * 把「基线 + 增量总和」夹进漂移区间。
 * @param spec 特质。
 * @param sum 未回滚增量之和。
 */
export function traitValueOf(spec: TraitSpec, sum: number): number {
  const { floor, ceiling } = traitBounds(spec)
  return clamp(spec.base + (Number.isFinite(sum) ? sum : 0), floor, ceiling)
}

/**
 * 单次调整的幅度上限（占量程的比例）。
 * @param spec 特质。
 * @param maxDeltaRatio 比例。
 */
export function maxDeltaOf(spec: TraitSpec, maxDeltaRatio: number): number {
  const span = Math.abs(spec.max - spec.min)
  return Math.max(0, span * maxDeltaRatio)
}

/**
 * 特质的一句话解释。
 * @param spec 特质。
 * @param value 当前值。
 * @param entries 参与计算的条数。
 */
export function traitSentence(spec: TraitSpec, value: number, entries: number): string {
  const { floor, ceiling } = traitBounds(spec)
  const drift = value - spec.base
  const verb = drift > 0 ? '推高' : drift < 0 ? '压低' : '没动'
  if (entries === 0) {
    return `「${spec.labelZh}」还是出厂值 ${round2(spec.base)}，没被任何经历推动。`
  }
  return `「${spec.labelZh}」出厂 ${round2(spec.base)}，被 ${entries} 件事${verb}到 ${round2(value)}（可动区间 ${round2(floor)}–${round2(ceiling)}）。`
}

/** 两位小数（解释文案专用，不参与计算）。 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}
