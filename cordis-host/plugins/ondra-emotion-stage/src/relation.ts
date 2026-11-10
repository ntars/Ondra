/**
 * 关系三维的纯算术 + 熟悉度的推导。**不碰 ctx、不碰存储、不碰时钟**。
 *
 * ## 为什么熟悉度是推导的，不是存的
 *
 * 手册 §3.4 给了三维的半衰期（affection 240h / trust 720h / intimacy 8760h），
 * **没有给 familiarity 的**；master-plan §9.1 只给了它的初值 0。
 *
 * 三条路都试过了：
 *
 * 1. **也给它编一条半衰期** —— 编出来的数就是第二真源，而且「熟悉度会衰减」
 *    在语义上就说不通（她不会因为两周没聊就忘了认识你多久）。
 * 2. **当成可写维度，让调用方推** —— 每次最多 +0.06，要推 17 次才到 1。
 *    结果是它永远停在 0，而 `ondra-emotion-diffuse` 的公式里它一出现就是 0，
 *    那一段 `(1 − familiarity × 0.5)` 等于白写。
 * 3. **从累计互动次数推导** —— `min(1, interactions / 5000)`。
 *
 * 取第三条。**分母 5000 不是新造的**：手册 §3.5 的阈值漂移公式
 * `base × (1 + 0.6 × min(1, interactions/5000))` 用的就是它。
 * 同一个「相处多久算熟」的标定，两处用同一个分母，才不会出现
 * 「阈值说你们很熟了，熟悉度说你们刚认识」。
 *
 * 代价：熟悉度不可外部写入。若主人裁定要可写，只需把 `familiarityOf()`
 * 换成读一个字段——调用点只有 `snapshot()` 一处。
 *
 * ## 为什么衰减是闭式的，且读的时候投影、不落盘
 *
 * `b + (v₀ − b) · 0.5^(dt / hl)` 是时间的闭式函数，算一次和算一百次一样。
 * 所以 `relation()` 直接把存储值投影到当前时刻就够，**读操作不写库**。
 * 只有 `settle()` / `adjust()` 才把投影结果固化。
 *
 * 反过来做（读的时候顺手写库）会让「看一眼面板」变成一次磁盘写，
 * 而且面板每秒刷新就会每秒写一次。
 */

import {
  FAMILIARITY_SATURATION,
  MAX_STEP,
  MS_PER_DAY,
  MS_PER_MINUTE,
  RELATION_DIMS,
  RELATION_SPEC,
  type RelationDim,
  type RelationPatch,
} from './types.js'

/** 三维取值。 */
export type DimValues = Readonly<Record<RelationDim, number>>

/** 三维的基线（从 `RELATION_SPEC` 派生，不手写第二份）。 */
export const DIM_BASELINE: DimValues = Object.freeze({
  affection: RELATION_SPEC.affection.baseline,
  trust: RELATION_SPEC.trust.baseline,
  intimacy: RELATION_SPEC.intimacy.baseline,
})

/**
 * 夹一个维度到合法区间。非有限数回落到基线（不是 0）。
 *
 * 为什么不是 0：手册 §3.2 对情绪说过「0 在界面上等于极度烦躁，那是伪造情绪」，
 * 同一个道理——关系值被写成 NaN 时，回落到基线表示「不知道，按出厂算」，
 * 回落到 0 表示「她恨你」，那是凭空造出来的一段关系。
 * @param dim 维度。
 * @param value 原始值。
 */
export function clampDim(dim: RelationDim, value: number): number {
  const spec = RELATION_SPEC[dim]
  if (typeof value !== 'number' || !Number.isFinite(value)) return spec.baseline
  return Math.min(spec.max, Math.max(spec.min, value))
}

/**
 * 把三维整体夹紧。
 * @param values 原始三维。
 */
export function clampDims(values: DimValues): DimValues {
  return Object.freeze({
    affection: clampDim('affection', values.affection),
    trust: clampDim('trust', values.trust),
    intimacy: clampDim('intimacy', values.intimacy),
  })
}

/**
 * 熟悉度：`min(1, interactions / 5000)`。
 * @param interactions 累计互动次数。
 */
export function familiarityOf(interactions: number): number {
  if (typeof interactions !== 'number' || !Number.isFinite(interactions) || interactions <= 0) return 0
  return Math.min(1, interactions / FAMILIARITY_SATURATION)
}

/**
 * 一次闭式衰减：朝基线走，`0.5^(分钟 / 半衰期分钟)`。
 * @param dim 维度。
 * @param value 起始值。
 * @param minutes 经过的分钟数（非负）。
 */
export function decayedDim(dim: RelationDim, value: number, minutes: number): number {
  const spec = RELATION_SPEC[dim]
  const from = clampDim(dim, value)
  if (spec.halfLifeHours <= 0) return from
  if (!Number.isFinite(minutes) || minutes <= 0) return from
  const halfLifeMinutes = spec.halfLifeHours * 60
  const factor = Math.pow(0.5, minutes / halfLifeMinutes)
  return clampDim(dim, spec.baseline + (from - spec.baseline) * factor)
}

/**
 * 把三维投影到「经过 minutes 分钟之后」。
 *
 * 截断到 `maxMinutes`：存档放很久再打开时，若按真实时间差算，
 * 好感会精确落回 0.1——那看起来不是「很久没联系」，而是「重置了」。
 * 与 O-026 的 `maxSettleMinutes` 同一条纪律。
 * @param values 起始三维。
 * @param minutes 经过的分钟数。
 * @param maxMinutes 截断上限。
 */
export function projectDims(values: DimValues, minutes: number, maxMinutes: number): DimValues {
  const capped = Math.min(Math.max(0, minutes), Math.max(0, maxMinutes))
  return Object.freeze({
    affection: decayedDim('affection', values.affection, capped),
    trust: decayedDim('trust', values.trust, capped),
    intimacy: decayedDim('intimacy', values.intimacy, capped),
  })
}

/**
 * 把一次增量夹到 `MAX_STEP` 以内。
 *
 * 步长闸就是这一行。**只夹绝对值，不改方向**：
 * 一次被骂掉 0.2 和一次被夸涨 0.2，同样不许一步到位。
 * @param delta 原始增量。
 * @returns `[夹紧后的增量, 是否被截断]`。
 */
export function clampStep(delta: number): readonly [number, boolean] {
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) return [0, false]
  if (delta > MAX_STEP) return [MAX_STEP, true]
  if (delta < -MAX_STEP) return [-MAX_STEP, true]
  return [delta, false]
}

/** 一次增量应用的结果。 */
export interface PatchResult {
  /** 应用后的三维。 */
  readonly values: DimValues
  /** 是否至少有一维真的动了（决定要不要 +1 互动）。 */
  readonly changed: boolean
  /** 是否有维度被步长闸截断。 */
  readonly clamped: boolean
}

/**
 * 在已有三维上应用一次增量。
 * @param values 起始三维。
 * @param patch 增量。
 */
export function applyPatch(values: DimValues, patch: RelationPatch): PatchResult {
  const next: Record<RelationDim, number> = {
    affection: values.affection,
    trust: values.trust,
    intimacy: values.intimacy,
  }
  let changed = false
  let clamped = false
  for (const dim of RELATION_DIMS) {
    const raw = patch[dim]
    if (raw === undefined) continue
    const [delta, cut] = clampStep(raw)
    if (cut) clamped = true
    if (delta === 0) continue
    const after = clampDim(dim, next[dim] + delta)
    if (after !== next[dim]) changed = true
    next[dim] = after
  }
  return Object.freeze({ values: Object.freeze(next), changed, clamped })
}

/**
 * 相处天数：自然日序号差（不是 24 小时滑窗）。
 *
 * 「认识第三天」应该是「日历上翻了三页」，不是「累计 72 小时」。
 * 与 O-003 的 `dayNumber` 同一口径；这里不 import 它，因为本插件要在
 * clock 缺席时也能算（§18.5）。
 * @param at 当前时刻。
 * @param firstMetAt 首次相遇时刻。
 */
export function daysOf(at: number, firstMetAt: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(firstMetAt)) return 0
  const diff = at - firstMetAt
  if (diff <= 0) return 0
  return Math.floor(diff / MS_PER_DAY)
}

/**
 * 两个时刻相差多少分钟（非负）。
 * @param from 较早时刻。
 * @param to 较晚时刻。
 */
export function minutesBetween(from: number, to: number): number {
  const diff = to - from
  if (!Number.isFinite(diff) || diff <= 0) return 0
  return diff / MS_PER_MINUTE
}
