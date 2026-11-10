/**
 * 七阶判据的**阈值漂移接收端**：把 O-130 给的系数接到「升阶条件」上。
 *
 * ## 补的是哪条断掉的边
 *
 * `ondra-persona-evolve` 的口号是「以前 60 就算开心，后来要 80」，
 * 而七阶表的 `days / affection / trust` 是**常量**，没有任何一处接受外部阈值。
 * 于是那段漂移只在自己的 README 里成立：`thresholdOf()` 算出一个数，
 * `probeStage()` 照旧读 `affection: 0.18`。装上不等于生效。
 *
 * 本文件把这个断点接上，并且**只做适配，不做算术**：
 *
 * ```text
 * 本插件自己的 STAGE_SPECS  ← base 的唯一真源（本文件只读）
 *              │ base
 *              ▼
 * persona-evolve.thresholdOf(key, base)   ← 只做乘法
 *              │ 生效阈值
 *              ▼
 * driftedStages()  ← 本文件：量程护栏 + 单调性护栏（新增）
 * ```
 *
 * 与 O-130 README「`base` 由调用方传进，本插件只持久化 `n`」对齐：
 * 谁的表谁给 base，乘法归它，两边都不存对方的数。
 *
 * ## 三条纪律（与六态侧同构，理由各自独立）
 *
 * 1. **不漂 `days`。** 相处天数是**客观经过的时间**，不是「被取悦的难度」。
 *    手册 §3.5 讲的是「阈值上移」，指的是心理门槛；把时间闸也乘 1.6 等于说
 *    「处得越久，心动需要越久」——那是循环论证，还会让「第 96 天才落定」
 *    这种既不好解释也不好验证的数字冒出来。
 *
 * 2. **不漂 `maxTrust`。** 它是病态阶的**上界**（`trust ≤ 0.55`），
 *    上移会让病态更难成立、下移更容易成立，两个方向手册都没说。
 *    不动即最安全：它表达的是「信任过高就不算病态」这条定性判断。
 *
 * 3. **不漂 `minInteractions`。** 它的驱动量就是互动次数本身 ——
 *    拿 `n` 去漂 `n` 的门槛是自指，会让升级条件随自己往后退。
 *
 * 所以真正漂的只有 `affection` 与 `trust` 两个心理门槛，且都必须通过
 * **量程护栏**（≤ 1）与**单调护栏**（低阶门槛不得高于高阶，否则七阶会乱序）。
 */

import { STAGES, STAGE_SPECS } from './types.js'
import type { StageId, StageSpec } from './types.js'

/**
 * 阈值漂移函数。形状与 O-130 的 `thresholdOf(key, base)` 严格一致。
 *
 * 本插件**不 import** 那个插件（§18.5），只声明形状；也不缓存返回值 ——
 * 系数是「当前互动次数」的函数，缓存就等于把相处时长冻在装载那一刻。
 */
export type ThresholdDrift = (key: string, base: number) => number

/** 一次漂移的逐条结果，供面板与诊断读。 */
export interface StageDriftReport {
  /** 问过几条阈值。 */
  readonly asked: number
  /** 真的换掉了的键（`stage.dim`）。 */
  readonly applied: readonly string[]
  /** 被护栏挡回的键与原因。 */
  readonly rejected: readonly { readonly key: string; readonly why: string }[]
}

/** 漂移的维度（只有两个心理门槛）。 */
type DriftDim = 'affection' | 'trust'

/** 好感与信任的量程上限都是 1。 */
const SCALE = 1

/**
 * 按漂移函数产出这一轮实际使用的七阶表。
 *
 * @param drift 漂移函数；`undefined`（没装 / 已关）→ 返回出厂表本身。
 */
export function driftedStages(drift?: ThresholdDrift): {
  readonly specs: Readonly<Record<StageId, StageSpec>>
  readonly report: StageDriftReport
} {
  if (drift === undefined) {
    return Object.freeze({
      specs: STAGE_SPECS,
      report: Object.freeze({ asked: 0, applied: Object.freeze([]), rejected: Object.freeze([]) }),
    })
  }

  const applied: string[] = []
  const rejected: { key: string; why: string }[] = []
  const specs: Partial<Record<StageId, StageSpec>> = {}
  let asked = 0

  /*
   * **从高阶往低阶**处理，这是单调护栏能一遍算完的唯一顺序。
   *
   * 七阶的 `affection` 必须随阶序不减（出厂表本来如此）。抬高某一阶之后，
   * 它可能顶到「更高的那一阶」的出厂值——那时乱序就发生了。
   *
   * 若从低阶往高阶走，处理第 i 阶时还不知道第 i+1 阶最终会落在哪，
   * 只能两遍扫描或者整表退回。整表退回在高系数下等于「一条都不涨」，
   * 那正是本文件要消灭的那种「算得出但没生效」，所以不用它。
   *
   * 从高阶往低阶走，每一步都只看**已经定下来的那个更高阶**，
   * 一遍扫完，且挡回的永远是最低的那几阶（抬高它们最不容易伤人）。
   */
  const descending = [...STAGES].sort((a, b) => {
    const sa = STAGE_SPECS[a]
    const sb = STAGE_SPECS[b]
    return sb.order - sa.order
  })

  // 已经定下来的更高阶门槛（阶序更大）。初值 `Infinity` 表示「没有上限」。
  let higherAffection = Number.POSITIVE_INFINITY
  let higherTrust = Number.POSITIVE_INFINITY

  for (const id of descending) {
    const base = STAGE_SPECS[id]
    let next: StageSpec = base
    for (const dim of ['affection', 'trust'] as const satisfies readonly DriftDim[]) {
      const threshold = base[dim]
      // 门槛为 0 时没有可乘的东西，不算「问过」。
      if (!(threshold > 0)) continue
      const key = `${id}.${dim}`
      asked += 1
      const ceiling = dim === 'affection' ? higherAffection : higherTrust

      let factor = 1
      try {
        const effective = drift(key, threshold)
        if (Number.isFinite(effective) && effective > 0) factor = effective / threshold
      } catch {
        // 一次乘法失败不该换掉整套判据。
        factor = 1
      }
      if (factor === 1) continue

      const raised = threshold * factor
      if (!(raised <= SCALE)) {
        rejected.push(
          Object.freeze({
            key,
            why: `阈值 ${threshold} × ${factor.toFixed(2)} = ${raised.toFixed(2)} 超出量程 ${SCALE}，这一阶将永远到不了`,
          }),
        )
        continue
      }
      if (raised > ceiling) {
        rejected.push(
          Object.freeze({
            key,
            why: `阈值 ${threshold} × ${factor.toFixed(2)} = ${raised.toFixed(2)} 会高于更高阶的 ${ceiling.toFixed(2)}，七阶将乱序`,
          }),
        )
        continue
      }
      next = Object.freeze({ ...next, [dim]: raised })
      applied.push(key)
    }
    specs[id] = next
    /*
     * 上限用**这一阶最终落定的值**，不管它漂没漂。
     *
     * 这里曾经写成「只在真的漂了才更新上限」——于是被量程挡回的
     * 献祭 / 落定两阶没有把 0.7 / 0.75 传下来，病态一路涨到 0.992，
     * 反而高过它们。七阶乱序，而没有任何一处报错。
     * 反向验证（把 `applied` 改成空）没能抓到它，因为乱序是**另一件事**。
     */
    if (next.affection > 0) higherAffection = next.affection
    if (next.trust > 0) higherTrust = next.trust
  }

  return Object.freeze({
    specs: Object.freeze(specs as Record<StageId, StageSpec>),
    report: Object.freeze({
      asked,
      applied: Object.freeze(applied),
      rejected: Object.freeze(rejected),
    }),
  })
}

/** 一句人话（面板用，允许数字）。 */
export function describeStageDrift(report: StageDriftReport): string {
  if (report.asked === 0) return '阶门槛没漂：人格演化未装载，或没有可漂的门槛'
  const head =
    report.applied.length === 0
      ? '阶门槛一条都没漂'
      : `${String(report.applied.length)} 条阶门槛已按相处时长上移`
  if (report.rejected.length === 0) return head
  return `${head}；${String(report.rejected.length)} 条撞量程或乱序被挡回出厂值`
}
