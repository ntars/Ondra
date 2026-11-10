/**
 * 六态判据的**阈值漂移接收端**：把 O-130 给的系数真正接到判定上。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-persona-evolve` 的公式算得出「相处 5000 次后阈值 ×1.60」，
 * 但六态的 `STATE_SPECS` 是一张**常量表**，没有任何一处接受外部阈值。
 * 于是那句话只剩在 README 里成立：`thresholdOf()` 算出一个数，
 * 判定侧照旧读 `mood > 0.7`。**装上不等于生效**，而 `×1.00` 是合法系数，
 * 所以谁也不报错。
 *
 * 本文件把「判定侧读谁给的阈值」这件事固定下来：
 *
 * ```text
 * 本插件自己的常量表 STATE_SPECS  ← base 的唯一真源（本文件只读不改）
 *              │ base
 *              ▼
 * persona-evolve.thresholdOf(key, base)   ← 只做乘法，不存 base
 *              │ 生效阈值
 *              ▼
 * driftedSpecs()  ← 本文件：夹进量程 + 可达性护栏（新增）
 * ```
 *
 * 与 O-130 README「`base` 每次由调用方传进 `explainThreshold(key, base)`，
 * 本插件只持久化 `n`」完全对齐：**base 归这里，乘法归它，谁都不存对方的数**。
 *
 * ## 三条纪律
 *
 * 1. **只漂上界（`gt` / `gte`），下界一律不动。**
 *    手册 §3.5 说的是「阈值单调上移」。上界上移 = 更难被取悦，成立；
 *    但 `蔫` 的 `mood < 0.35` 与 `困` 的 `energy < 30` 是**下界**，
 *    把下界上移等于「她更容易没精神」——那不是手册的意思，是误读。
 *    移动量会随相处次数增长，误读一次就是永久副作用，所以宁可不动。
 *
 * 2. **可达性护栏：漂到判据不可能满足时，退回出厂值并如实上报。**
 *    `mood > 0.7` 乘 1.6 等于 1.12，而 mood 的量程只到 1 ——
 *    `mood > 1.12` 永远不成立，于是「雀跃」这一态在相处 3571 次之后
 *    就再也判不出来。这不是「变难取悦」，是**把一态判死**。
 *    所以超过量程的一律 `rejected`，判定继续用出厂值。
 *    宁可少漂一点，也不让六态变成五态。
 *
 * 3. **系数缺席（未装 / 已关）时逐字等价于出厂。**
 *    不是「近似等价」：`driftedSpecs(undefined)` 直接返回 `STATE_SPECS` 本身，
 *    连对象都不复制。这样「没装人格演化」与「装了但 0 次互动」在判定上
 *    完全不可区分——两者本来就该一样。
 */

import { STATE_SPECS, STATE_ZH, STATES } from './types.js'
import type { ExpressState, NumericRange, StateSpec } from './types.js'

/**
 * 阈值漂移函数。形状与 O-130 的 `thresholdOf(key, base)` 严格一致。
 *
 * 本插件**不 import** 那个插件（§18.5），只声明形状；也不缓存它的返回值，
 * 每次判定现问——系数本身是「当前互动次数」的函数，缓存就等于把
 * 「她相处了多久」冻在装载那一刻。
 */
export type ThresholdDrift = (key: string, base: number) => number

/** 一次漂移的逐条结果，供面板与诊断读。 */
export interface DriftReport {
  /** 问过几条阈值。 */
  readonly asked: number
  /** 真的换掉了的键（`state.dim`）。 */
  readonly applied: readonly string[]
  /** 被可达性护栏挡下的键，附原因。 */
  readonly rejected: readonly { readonly key: string; readonly why: string }[]
}

/** 可漂移的维度。 */
type DriftDim = 'mood' | 'energy' | 'tension'

/**
 * 可漂移的键表：**状态 → 维度**。
 *
 * 只列上界维度。`soft` / `calm` / `wilted` / `sleepy` 一个都不在其中——
 * 前两者的区间上下都有界（`0.55–0.7` / `0.45–0.55`），单独平移任一端都会
 * 与邻居打架；后两者只有下界。
 */
const DRIFT_KEYS: Readonly<Record<ExpressState, readonly DriftDim[]>> = Object.freeze({
  joyful: Object.freeze<DriftDim[]>(['mood', 'energy']),
  soft: Object.freeze<DriftDim[]>([]),
  calm: Object.freeze<DriftDim[]>([]),
  wilted: Object.freeze<DriftDim[]>([]),
  bristled: Object.freeze<DriftDim[]>(['tension']),
  sleepy: Object.freeze<DriftDim[]>([]),
})

/**
 * 每个维度的量程。**本插件自己的知识**，不向别人要。
 *
 * 与 `judge.ts` 的 `MOOD_MAX` / `ENERGY_MAX` 是同一组数，但那几个常量是
 * 「夹读数」用的，这里的语义是「阈值最多能漂到哪」，用途不同。
 * 两处都指向同一组物理事实（mood 0–1、energy 0–100），不存在漂移风险；
 * 刻意不复用是为了让本文件的判断不依赖 `judge.ts` 的导出顺序。
 */
const SCALE: Readonly<Record<'mood' | 'energy' | 'tension', number>> = Object.freeze({
  mood: 1,
  energy: 100,
  tension: 1,
})

/** 键名。统一成 `joyful.mood` 这种形状，日志与诊断共用。 */
export function driftKeyOf(state: ExpressState, dim: 'mood' | 'energy' | 'tension'): string {
  return `${state}.${dim}`
}

/**
 * 把一个上界区间按系数漂移一次，带可达性护栏。
 *
 * @param range 出厂区间（**只读，绝不就地改**）。
 * @param factor 系数（1.00–1.60）；非有限值按 1 处理。
 * @param scale 该维度的量程上限。
 * @returns 漂移后的区间；`rejected` 有值表示护栏挡下了，调用方应沿用出厂区间。
 */
export function driftRange(
  range: NumericRange,
  factor: number,
  scale: number,
): { readonly range: NumericRange; readonly rejected?: string } {
  if (!Number.isFinite(factor) || factor === 1) return { range }

  const out: { gt?: number; gte?: number; lt?: number; lte?: number } = {}
  let moved = false

  for (const bound of ['gt', 'gte'] as const) {
    const base = range[bound]
    if (base === undefined) continue
    const next = base * factor
    /*
     * 可达性判据：
     * - `gt: x` 要求读数**严格大于** x，所以 x 必须 < 量程（x = 量程时永远不成立）；
     * - `gte: x` 允许等于，所以 x 可以 = 量程，只有 > 量程才不成立。
     */
    const unsatisfiable = bound === 'gt' ? next >= scale : next > scale
    if (unsatisfiable) {
      return {
        range,
        rejected: `阈值 ${base} × ${factor.toFixed(2)} = ${next.toFixed(2)} 已超出量程 ${scale}，判定将永远不成立`,
      }
    }
    out[bound] = next
    moved = true
  }

  // 下界原样带过去（本条纪律见文件头第 1 条）。
  if (range.lt !== undefined) out.lt = range.lt
  if (range.lte !== undefined) out.lte = range.lte
  if (!moved && range.gt === undefined && range.gte === undefined) return { range }
  return { range: Object.freeze(out) }
}

/**
 * 按漂移函数产出这一轮实际使用的判据表。
 *
 * @param drift 漂移函数；`undefined` 表示没装 / 已关 → 返回出厂表本身。
 */
export function driftedSpecs(drift?: ThresholdDrift): {
  readonly specs: Readonly<Record<ExpressState, StateSpec>>
  readonly report: DriftReport
} {
  if (drift === undefined) {
    return Object.freeze({
      specs: STATE_SPECS,
      report: Object.freeze({ asked: 0, applied: Object.freeze([]), rejected: Object.freeze([]) }),
    })
  }

  const applied: string[] = []
  const rejected: { key: string; why: string }[] = []
  const specs: Partial<Record<ExpressState, StateSpec>> = {}
  let asked = 0

  for (const state of STATES) {
    const dims = DRIFT_KEYS[state]
    const base = STATE_SPECS[state]
    if (dims.length === 0) {
      specs[state] = base
      continue
    }

    let next: StateSpec = base
    for (const dim of dims) {
      const range = base[dim]
      if (range === undefined) continue
      const lower = lowerBoundOf(range)
      // 门槛为 0 时没有可乘的东西（0 × 任何数 = 0），不算「问过」。
      if (lower <= 0) continue
      const key = driftKeyOf(state, dim)
      asked += 1

      let factor = 1
      try {
        // base 由**本插件**给：它是这张常量表的主人，别的插件只负责乘。
        const effective = drift(key, lower)
        if (Number.isFinite(effective) && effective > 0) factor = effective / lower
      } catch {
        // 漂移函数抛错就按不漂处理：判定不能因为一次乘法失败而换一套判据。
        factor = 1
      }
      if (factor === 1) {
        specs[state] = next
        continue
      }

      const drifted = driftRange(range, factor, SCALE[dim])
      if (drifted.rejected !== undefined) {
        rejected.push(Object.freeze({ key, why: drifted.rejected }))
        specs[state] = next
        continue
      }
      next = Object.freeze({ ...next, [dim]: drifted.range })
      applied.push(key)
      specs[state] = next
    }
    specs[state] = next
  }

  return Object.freeze({
    specs: Object.freeze(specs as Record<ExpressState, StateSpec>),
    report: Object.freeze({
      asked,
      applied: Object.freeze(applied),
      rejected: Object.freeze(rejected),
    }),
  })
}

/**
 * 取区间的「出厂门槛值」（用于把它交给漂移函数）。
 *
 * 上界优先：本文件只漂上界，所以有 `gt`/`gte` 时那一个就是门槛。
 * 都没有时返回 0，`driftedSpecs()` 会因 `lower > 0` 不成立而按系数 1 处理。
 */
function lowerBoundOf(range: NumericRange): number {
  return range.gt ?? range.gte ?? 0
}

/** 一句人话（面板用，允许数字）。 */
export function describeDrift(report: DriftReport): string {
  if (report.asked === 0) return '阈值没漂：没有可漂的判据，或人格演化未装载'
  const names = report.applied
    .map(key => {
      const [state, dim] = key.split('.')
      const zh = STATE_ZH[state as ExpressState] ?? state
      const dimZh = dim === 'mood' ? '心情' : dim === 'energy' ? '能量' : '张力'
      return `${zh}·${dimZh}`
    })
    .join('、')
  const head = report.applied.length === 0 ? '一条都没漂' : `${names} 已按相处时长上移`
  if (report.rejected.length === 0) return head
  return `${head}；${String(report.rejected.length)} 条撞量程被挡回出厂值`
}
