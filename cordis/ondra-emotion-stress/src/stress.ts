/**
 * 应激注意力倍率的**纯算术**：不碰 ctx、不读盘、不打日志，给同样的输入永远同样的输出。
 *
 * 拆出来的理由只有一个：这一段是 §3.8 的全部实现，必须能被逐条对拍。
 * 混进服务里之后，「读不到情绪时倍率是多少」这类问题就得靠猜。
 */

import {
  CALM_CEILING,
  CRISIS_FLOOR,
  CRISIS_PEAK,
  CORTISOL_MAX,
  CORTISOL_MIN,
  DAILY_TROUGH,
  type StressBand,
  type StressClass,
  type StressItem,
  type StressMultiplier,
  type StressRanked,
  type StressRanking,
} from './types.js'

/**
 * 危机类每单位皮质醇的斜率。
 *
 * 由锚点推导而**不是手写 0.05**：(3 − 1) / (80 − 40) = 0.05。
 * 手写的斜率改锚点后不会跟着动，于是「表里说 ×3、算出来 ×2.9」。
 */
const CRISIS_SLOPE = (CRISIS_PEAK - 1) / (CRISIS_FLOOR - CALM_CEILING)

/** 日常类每单位皮质醇的斜率：(1 − 0.1) / 40 = 0.0225。同样由锚点推导。 */
const DAILY_SLOPE = (1 - DAILY_TROUGH) / (CRISIS_FLOOR - CALM_CEILING)

/** 把一个数夹到区间内；非有限值按下界处理（C3：坏输入不得传播成 NaN 权重）。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 夹紧皮质醇。
 *
 * 超出 [0, 100] 不报错：O-026 自己也会夹，这里再夹一次是为了
 * 「调用方给 150」时不至于算出 ×6.5 这种把排序彻底压扁的数。
 * @param value 原始值。
 */
export function clampCortisol(value: number): number {
  return clamp(value, CORTISOL_MIN, CORTISOL_MAX)
}

/**
 * 分档（只给面板与日志用）。
 * @param cortisol 已夹紧的皮质醇。
 */
export function bandOf(cortisol: number): StressBand {
  if (cortisol <= CALM_CEILING) return 'calm'
  if (cortisol < 60) return 'mild'
  if (cortisol < CRISIS_FLOOR) return 'alert'
  return 'crisis'
}

/**
 * 危机类倍率。
 * @param cortisol 已夹紧的皮质醇。
 */
export function crisisWeightOf(cortisol: number): number {
  // 锚点左侧恒为 1（≤40 都是 ×1），锚点右侧恒为 3（≥80 都是 ×3）。
  return clamp(1 + CRISIS_SLOPE * (cortisol - CALM_CEILING), 1, CRISIS_PEAK)
}

/**
 * 日常类倍率。
 * @param cortisol 已夹紧的皮质醇。
 */
export function dailyWeightOf(cortisol: number): number {
  // 日常类与危机类**反着走**：越应激越顾不上日常。
  return clamp(1 - DAILY_SLOPE * (cortisol - CALM_CEILING), DAILY_TROUGH, 1)
}

/**
 * 取一档倍率。
 * @param cortisol 原始皮质醇（内部夹紧）。
 * @param source 值的来源，只用于可解释性。
 */
export function multiplierAt(cortisol: number, source: StressMultiplier['source']): StressMultiplier {
  const clamped = clampCortisol(cortisol)
  return Object.freeze({
    cortisol: clamped,
    band: bandOf(clamped),
    crisis: crisisWeightOf(clamped),
    daily: dailyWeightOf(clamped),
    source,
  })
}

/**
 * 取一个类别对应的倍率。
 * @param multipliers 倍率快照。
 * @param kind 类别。
 */
export function pickMultiplier(multipliers: StressMultiplier, kind: StressClass): number {
  return kind === 'crisis' ? multipliers.crisis : multipliers.daily
}

/**
 * 单条权重。
 *
 * `relevance` 的**尺度归产出方**（BM25 分、余弦相似度、手写权重都行）：
 * 本插件只做乘法，不做归一化。归一化会在这里制造第二套尺度，
 * 于是「召回自己算 0–1、这里算 0–100」，两边的阈值永远对不上。
 *
 * @param item 条目。
 * @param multipliers 倍率快照。
 */
export function weightOfItem(item: StressItem, multipliers: StressMultiplier): number {
  const multiplier = pickMultiplier(multipliers, item.class)
  const resonance = item.resonance === undefined ? 1 : item.resonance
  // 相关度不是有限数就按 0（排到最后），共鸣系数不是有限数就按 1（不起作用）。
  // 让一个坏字段把整张表算成 NaN，比让它排错位置糟得多。
  const relevance = Number.isFinite(item.relevance) ? item.relevance : 0
  const factor = Number.isFinite(resonance) ? resonance : 1
  return relevance * multiplier * factor
}

/**
 * 重排：**只改顺序，不改内容**。
 *
 * 排序规则：权重降序；权重相等时**保持原相对顺序**（显式写 `index` 比较，
 * 不依赖 `Array.prototype.sort` 的稳定性——那条保证在 ES2019 才有，
 * 而这里一旦不稳定，「同分条目每次刷新换位置」会让面板看起来在抖）。
 *
 * @param items 条目列表。
 * @param multipliers 倍率快照。
 */
export function rankOf<T extends StressItem>(
  items: readonly T[],
  multipliers: StressMultiplier,
): StressRanking<T> {
  const ranked = items.map((item, index) => ({
    item,
    index,
    weight: weightOfItem(item, multipliers),
    multiplier: pickMultiplier(multipliers, item.class),
  }))
  ranked.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight
    return a.index - b.index
  })
  const out = ranked.map(entry => {
    const merged: StressRanked<T> = { ...entry.item, weight: entry.weight, multiplier: entry.multiplier }
    return Object.freeze(merged)
  })
  return Object.freeze({ items: Object.freeze(out), multipliers, dropped: 0 as const })
}
