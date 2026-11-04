/**
 * 10 个固定标签的层（手册 §3.2 / §3.12）。
 *
 * ## 标签与 PAD 的关系：两条独立通道，刻意不互相推导
 *
 * 一个很自然的想法是「开心的值高，愉悦度就该高」，于是让 PAD 由标签加权求和投影出来。
 * 本插件**不这么做**，理由有两条：
 *
 * 1. **投影需要一张权重表，而权重表没有出处。** 手册给了 PAD 三个轴的取值范围，
 *    也给了十个标签，但没给「开心对愉悦度的权重是 0.8 还是 1.0」。
 *    一旦编一张表，它就会变成事实上的第二真源，日后谁也不敢动。
 * 2. **投影会吃掉「说不清」的部分。** 人有时候就是「没什么理由地有点低」——
 *    十个标签全是 0，但愉悦度就是跌到 0.3。独立通道能表达这个状态，
 *    投影做不到。
 *
 * 代价是调用方要投两边就投两边。这个代价是明的，写在 `FeelingInput` 的注释里。
 *
 * ## 为什么基线是 0，而激素基线是 50
 *
 * 「没有情绪」就是 0——不生气、不难过、不开心，这是常态，也是默认值。
 * 激素不是这样：皮质醇基线 20 而不是 0，因为**一个活人身上永远有皮质醇**，
 * 0 意味着「死了」或者「数据没读到」。这两件事不一样，所以基线不能统一。
 */

import type { Label, Temperament } from './types.js'
import { LABELS, LABEL_HALF_LIFE_MINUTES, LABEL_MAX } from './types.js'
import { halfLifeWith, labelDelta, regressTowards } from './pad.js'

/** 一份全零的标签表。 */
export function emptyLabels(): Record<Label, number> {
  const out = {} as Record<Label, number>
  for (const label of LABELS) out[label] = 0
  return out
}

/** 复制一份标签表（快照不可变，对外一律给副本）。 */
export function cloneLabels(source: Readonly<Record<Label, number>>): Record<Label, number> {
  const out = {} as Record<Label, number>
  for (const label of LABELS) out[label] = source[label] ?? 0
  return out
}

/** 夹紧单个标签值。 */
export function clampLabel(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(LABEL_MAX, Math.max(0, value))
}

/**
 * 结算全部标签：各自向 0 做指数回归。
 *
 * 标签的基线一定是 0（见文件头），所以这里不需要传基线。
 * @param labels 当前值。
 * @param dtMinutes 经过的分钟数。
 * @param temperament 气质（只用到 `resilience`）。
 */
export function settleLabels(
  labels: Readonly<Record<Label, number>>,
  dtMinutes: number,
  temperament: Temperament,
): Record<Label, number> {
  const halfLife = halfLifeWith(LABEL_HALF_LIFE_MINUTES, temperament.resilience)
  const out = {} as Record<Label, number>
  for (const label of LABELS) {
    out[label] = clampLabel(regressTowards(labels[label] ?? 0, 0, halfLife, dtMinutes))
  }
  return out
}

/**
 * 把一组增量打到标签上。
 *
 * 每个标签独立走上限 0.12、总值上限 0.6 两道闸：
 * 前者管「一句话能有多狠」，后者管「情绪最多占满几分」。
 * @param labels 当前值。
 * @param patch 意图值（−1–1 的强度）。
 */
export function applyLabels(
  labels: Readonly<Record<Label, number>>,
  patch: Partial<Record<Label, number>> | undefined,
): Record<Label, number> {
  const out = cloneLabels(labels)
  if (patch === undefined) return out
  for (const label of LABELS) {
    const intent = patch[label]
    if (intent === undefined) continue
    out[label] = clampLabel(out[label] + labelDelta(intent))
  }
  return out
}

/**
 * 当前最强的标签。
 *
 * 全为零（或者最大值低于「勉强算有情绪」的 0.02）时返回 `undefined`——
 * 面板上「最强烈的情绪：无聊 0.01」比不显示更糟。
 * @param labels 当前值。
 */
export function dominantOf(labels: Readonly<Record<Label, number>>): Label | undefined {
  let best: Label | undefined
  let bestValue = 0.02
  for (const label of LABELS) {
    const value = labels[label] ?? 0
    if (value > bestValue) {
      bestValue = value
      best = label
    }
  }
  return best
}

/**
 * 从存档的松散对象里恢复标签表。
 *
 * **缺字段补 0**（标签的基线就是 0）；未知键丢弃（标签表是封闭的十个，
 * 存档里多出来的键多半是旧版本残留，留着会让「标签数量」这件事失去意义）。
 * @param raw 存档里的原始值。
 */
export function parseLabels(raw: unknown): Record<Label, number> {
  const out = emptyLabels()
  if (typeof raw !== 'object' || raw === null) return out
  const record = raw as Record<string, unknown>
  for (const label of LABELS) {
    const value = record[label]
    if (typeof value === 'number' && Number.isFinite(value)) out[label] = clampLabel(value)
  }
  return out
}
