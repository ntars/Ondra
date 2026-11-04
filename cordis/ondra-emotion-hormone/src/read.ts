/**
 * 纯读取层：**把快照里的数变成档位**，不做任何判定以外的计算。
 *
 * 这一层刻意不碰 ctx、不碰存储、不写日志——它是纯函数，
 * 所有边界都能用 Python 逐条复刻（本轮对拍 24 例）。
 *
 * ## 一个容易写错的地方：分母
 *
 * 档位用「占比」而不是「绝对差」。理由是绝对差不可跨维度：
 * 皮质醇基线 20，涨 20 就是翻倍（100 的空间走了 25%）；
 * 多巴胺基线 50，涨 20 只走了 40% 的上行空间的一半。同一个 +20，
 * 在两维上的分量完全不同。用占比之后，`0.5` 在每一维都表示
 * 「走了一半的可用空间」，只有这样才能用同一组边界。
 *
 * 分母**必须分段**：高于基线时是 `100 − baseline`，低于基线时是 `baseline`。
 * 写成统一的 `100` 会让基线 20 的皮质醇在跌到 0 时只算出 −0.2，
 * 而它其实已经到底了——「彻底放松」看起来像「稍微低一点」。
 */

import {
  BELOW_RATIO,
  HORMONE_SPECS,
  LOW_RATIO,
  PRIMARY_HORMONES,
  REFERENCE_HORMONES,
} from './types.js'
import type {
  HormoneBand,
  HormoneDim,
  HormoneDimSpec,
  HormoneRead,
  HormoneReading,
  HormoneWeights,
  PrimaryHormone,
  TemperamentLike,
} from './types.js'

/** 夹到 0–100。`NaN` / `Infinity` 一律当 0（宁可显示「最低」，不显示 `NaN`）。 */
export function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** 夹到 0–1。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 取一个维度的**当前基线**。
 *
 * 只有多巴胺会偏离表里的缺省值：手册 §3.2 明写 `enthusiasm` 是
 * 「多巴胺出厂基线」。读不到气质时退回表里的 50（不是 0——
 * 0 在 0–100 尺度上等于「极度低落」，那是伪造情绪）。
 * @param spec 维度说明。
 * @param temperament 气质，可缺席。
 */
export function baselineOf(spec: HormoneDimSpec, temperament: TemperamentLike | undefined): number {
  if (spec.source !== 'core-temperament') return spec.baseline
  const raw = temperament?.enthusiasm
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return spec.baseline
  // 气质 enthusiasm 的范围是 20–80（手册 §3.2），夹一次防脏数据。
  return Math.min(80, Math.max(20, raw))
}

/**
 * 相对「可偏离空间」的比例，−1–1。
 * @param value 当前值。
 * @param baseline 当前基线。
 */
export function ratioOf(value: number, baseline: number): number {
  const delta = clamp100(value) - baseline
  const span = delta >= 0 ? 100 - baseline : baseline
  if (!(span > 0)) return 0
  const ratio = delta / span
  return Math.min(1, Math.max(-1, ratio))
}

/**
 * 由比例判档位。
 *
 * 上行的两条边界来自维度表（cortisol 的两条有手册出处，另两维是工程取值）；
 * 下行的两条是全局常量，因为「低到多少算低」在三类激素上没有产品口径，
 * 分成三套只会造出三个待裁决。
 * @param ratio 比例。
 * @param spec 维度说明。
 */
export function bandOfRatio(ratio: number, spec: HormoneDimSpec): HormoneBand {
  if (!Number.isFinite(ratio)) return 'normal'
  // 四条边界**只判一次**，区间闭合关系写在注释里，避免「同一时刻命中两档」：
  // [-1, -0.5] low ｜ (-0.5, -0.12) below ｜ [-0.12, aboveRatio) normal
  // ｜ [aboveRatio, highRatio) above ｜ [highRatio, 1] high
  if (ratio <= LOW_RATIO) return 'low'
  if (ratio < BELOW_RATIO) return 'below'
  if (ratio < spec.aboveRatio) return 'normal'
  if (ratio < spec.highRatio) return 'above'
  return 'high'
}

/** 由值直接判档位（内部先算比例）。 */
export function bandOf(spec: HormoneDimSpec, value: number, baseline: number): HormoneBand {
  return bandOfRatio(ratioOf(value, baseline), spec)
}

/**
 * 从快照里取一个维度的值。
 *
 * **读不到就是 `undefined`，不补 0**：补 0 会让「这一维没建」看起来像
 * 「这一维到底了」，而那正是手册反复警告的伪造情绪。
 * @param hormones 快照里的激素表。
 * @param name 维度名。
 */
export function valueIn(hormones: Readonly<Record<string, number>>, name: string): number | undefined {
  const raw = hormones[name]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  return clamp100(raw)
}

/** 组一条读数。 */
function readingOf(spec: HormoneDimSpec, value: number, baseline: number, missing: boolean): HormoneReading {
  const ratio = ratioOf(value, baseline)
  return Object.freeze({
    name: spec.name,
    zh: spec.zh,
    role: spec.role,
    value: clamp100(value),
    baseline,
    deviation: Math.round((clamp100(value) - baseline) * 100) / 100,
    ratio: Math.round(ratio * 1000) / 1000,
    band: bandOfRatio(ratio, spec),
    missing,
  })
}

/** 这一次要读哪些维度。 */
function dimsOf(includeSerotonin: boolean): readonly HormoneDim[] {
  return includeSerotonin ? [...PRIMARY_HORMONES, ...REFERENCE_HORMONES] : [...PRIMARY_HORMONES]
}

/**
 * 读一次。
 *
 * @param snapshot 情绪快照；缺席时一切按出厂基线。
 * @param at 时刻。
 * @param includeSerotonin 是否带上参考维度。
 */
export function readOf(
  snapshot: { readonly hormones: Readonly<Record<string, number>>; readonly temperament: TemperamentLike } | undefined,
  at: number,
  includeSerotonin: boolean,
): HormoneRead {
  const readings: Record<string, HormoneReading> = {}
  const missing: string[] = []

  for (const name of dimsOf(includeSerotonin)) {
    const spec = HORMONE_SPECS[name]
    const baseline = baselineOf(spec, snapshot?.temperament)
    const found = snapshot === undefined ? undefined : valueIn(snapshot.hormones, name)
    if (found === undefined) missing.push(name)
    readings[name] = readingOf(spec, found ?? baseline, baseline, found === undefined)
  }

  return Object.freeze({
    at,
    source: snapshot === undefined ? 'baseline' : 'emotion',
    readings: Object.freeze(readings),
    missing: Object.freeze(missing),
  })
}

/**
 * 三个主维度的**影响力权重**。
 *
 * 口径：按「偏离基线的绝对幅度」归一化。偏离最大的那一维最能解释她此刻的状态，
 * 所以权重最高；三维都贴在基线上时**均分**（各 1/3），而不是全零——
 * 全零会让下游除出 `NaN`，而「没有主导维度」本身也是一个有意义的信息。
 *
 * **缺失维退出分母**（手册 §2.3：「归一化只除以参与权重的因子」）。
 * 把缺失维按 0 计入分母，会让「只读得到两维」的时候三维权重一起被压低，
 * 现象是「面板上三根柱子都矮了一截」而没有任何报错。
 *
 * 返回类型固定是三键（缺失维填 0），**不是丢键**：`Record<string, number>`
 * 赋不给 `HormoneWeights`（索引签名不保证具体键存在），而丢键会让下游
 * `weights.cortisol` 在类型上「可能不存在」，每个调用点都要判空一次。
 * @param readings 读数表。
 */
export function weightsOf(readings: Readonly<Record<string, HormoneReading>>): HormoneWeights {
  const parts: { name: PrimaryHormone; magnitude: number }[] = []
  const out: Record<string, number> = { cortisol: 0, dopamine: 0, oxytocin: 0 }

  for (const name of PRIMARY_HORMONES) {
    const reading = readings[name]
    // 缺失维不进 `parts`，于是它既不进分子也不进分母，权重留在 0。
    if (reading === undefined) continue
    parts.push({ name, magnitude: Math.abs(reading.deviation) })
  }

  const total = parts.reduce((sum, part) => sum + part.magnitude, 0)
  if (parts.length === 0) return Object.freeze(out)

  if (total <= 0) {
    const even = Math.round((1 / parts.length) * 1000) / 1000
    for (const part of parts) out[part.name] = even
    return Object.freeze(out)
  }
  for (const part of parts) out[part.name] = Math.round((part.magnitude / total) * 1000) / 1000
  return Object.freeze(out)
}
