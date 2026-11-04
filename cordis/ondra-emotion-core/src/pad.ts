/**
 * 六维的**指数回归**（手册 §3.2「六维指数回归」）。
 *
 * 这一层是纯函数：不读时间、不碰存储、不认识宿主。给它一个值、一个基线、
 * 一个时间差，它给你结算后的值。所以它可以被单独对拍——
 * 「关机 3 小时后 cortisol 应该是多少」这类问题，不需要起一个 app 才能回答。
 *
 * ## 为什么是闭式函数，不是「每次 tick 乘一次」
 *
 * 和 O-013 同一个理由：`b + (v₀ − b) · 0.5^(dt / hl)` 是**关于时间的闭式表达式**。
 * 结算一次与结算一百次，同一时刻算出来的数完全一样。
 * 如果写成「每 5 分钟衰减一次」，那么「app 开着」与「app 关着」会得到两个结果，
 * 而用户会立刻发现：**挂着不关，她忘得快；关了重开，情绪还停在原处**。
 * 那不是拟人，那是漏算。
 *
 * ## 半衰期表为什么这么定
 *
 * - PAD 三轴：45 分钟。手册只给了「标签半衰期 45 分钟」，PAD 是标签的同层投影
 *   （一句「我好开心」让 P 上涨，标签涨多少，P 就该涨多少），同层同命。
 * - 心情：360 分钟。手册 §3.2 明写「心情半衰期 6 小时」。
 * - 能量：240 分钟。**手册未给**，取 4 小时：比心情慢一档，比张力快一档，
 *   落在「睡一觉能缓过来、但赖床两小时也回不满」的位置。
 * - 张力：1440 分钟。与手册 §3.4 关系域的 `tension 24h` 同值——
 *   两个 tension 若半衰期不同，就会出现「关系上已经和好了、情绪上还在记仇」的错位。
 */

import type { Axis, Temperament } from './types.js'
import { AXIS_SPEC } from './types.js'

/** 一分钟的毫秒数。 */
export const MINUTE_MS = 60000

/**
 * 单条消息对某一个轴的影响上限（手册 §3.2）。
 *
 * 注意它是**上限**也是**满档**：调用方传的 `intent` 是 −1–1 的强度，
 * 实际位移 = `intent × 0.12`。所以传 1 就是「一句话能造成的最剧烈变化」，
 * 传 0.3 就是三成力道。这样调用方不必知道 0.12 这个数字，也就不容易写错量纲。
 */
export const MAX_STEP = 0.12

/**
 * 一次事件传导到「心情」的比例。
 *
 * 手册只说心情半衰期 6 小时，没说单次传导系数。取 0.5 的理由是拟人：
 * 心情是底色，一句夸奖能让此刻高兴（P 涨满档），但不该让一整天都变好。
 * 这不是手册参数，是工程取值——要改就改这一处。
 */
export const MOOD_COUPLING = 0.5

/**
 * 一次事件对单个激素的位移上限（0–100 尺度）。
 *
 * 手册未给。取 30 的理由：皮质醇基线 20，一次改变 30 就已经是
 * 「从平静直接跳到应激」的量级；再高就没有「逐渐上头」的过程了。
 */
export const MAX_HORMONE_STEP = 30

/** 各轴的半衰期（分钟）。改动这里之前先读文件头。 */
export const AXIS_HALF_LIFE: Readonly<Record<Axis, number>> = Object.freeze({
  pleasure: 45,
  arousal: 45,
  dominance: 45,
  mood: 360,
  energy: 240,
  tension: 1440,
})

/** 把值夹进某个区间。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 按维度夹紧。 */
export function clampAxis(axis: Axis, value: number): number {
  const spec = AXIS_SPEC[axis]
  return clamp(value, spec.min, spec.max)
}

/**
 * 指数回归一格。
 *
 * @param value 当前值。
 * @param baseline 基线（静息水平）。
 * @param halfLifeMinutes 半衰期（分钟）。
 * @param dtMinutes 经过的分钟数。
 * @returns 结算后的值。
 */
export function regressTowards(value: number, baseline: number, halfLifeMinutes: number, dtMinutes: number): number {
  if (!(dtMinutes > 0) || !(halfLifeMinutes > 0)) return value
  // `0.5 ** (dt / hl)`：过了一个半衰期就是 0.5，过了两个就是 0.25。
  const keep = Math.pow(0.5, dtMinutes / halfLifeMinutes)
  return baseline + (value - baseline) * keep
}

/**
 * 应用气质里的 `resilience`（恢复力）后的半衰期。
 *
 * 语义方向必须说清：**恢复力越大，半衰期越短**。
 * 手册原话是「`resilience` 恢复力（半衰期乘数）」，乘在「恢复速度」上而不是
 * 「半衰期」上——如果直接乘半衰期，恢复力 2.0 会让她忘得更慢，
 * 那就把「恢复力」写成了「迟钝」，方向反了。
 *
 * @param halfLifeMinutes 原始半衰期。
 * @param resilience 恢复力（0.5–2.0）。
 */
export function halfLifeWith(halfLifeMinutes: number, resilience: number): number {
  if (!(resilience > 0)) return halfLifeMinutes
  return halfLifeMinutes / resilience
}

/**
 * 结算一个维度。
 *
 * @param axis 维度。
 * @param value 当前值。
 * @param dtMinutes 经过的分钟数。
 * @param temperament 气质（只用到 `resilience`）。
 */
export function settleAxis(axis: Axis, value: number, dtMinutes: number, temperament: Temperament): number {
  const spec = AXIS_SPEC[axis]
  const halfLife = halfLifeWith(AXIS_HALF_LIFE[axis], temperament.resilience)
  return clampAxis(axis, regressTowards(value, spec.baseline, halfLife, dtMinutes))
}

/**
 * 把 −1–1 的强度意图换算成某个轴的实际位移。
 *
 * @param intent 强度意图，−1–1。越界会被夹紧。
 * @param coupling 传导比例（心情用 `MOOD_COUPLING`，其余用 1）。
 */
export function axisDelta(intent: number, coupling = 1): number {
  if (!Number.isFinite(intent)) return 0
  return clamp(intent, -1, 1) * MAX_STEP * coupling
}

/**
 * 把 0–1 的标签强度意图换算成标签的实际位移。
 *
 * 标签和轴共用同一个 0.12 上限（手册 §3.2 把两者写在同一条参数行里）。
 * @param intent 强度意图，−1–1。
 */
export function labelDelta(intent: number): number {
  return axisDelta(intent, 1)
}

/**
 * 把激素位移意图夹进合理范围。
 * @param delta 原始增量（0–100 尺度）。
 */
export function hormoneDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0
  return clamp(delta, -MAX_HORMONE_STEP, MAX_HORMONE_STEP)
}

/**
 * 把毫秒时间差换算成分钟，并按 `maxMinutes` 截断。
 *
 * 截断不是防溢出，是产品决定：存档放一个月再打开，
 * 若按真实时间差积分，所有量都会「精确回落」，看起来像重置。
 * 截断到 7 天等于说「再久也只能恢复到这个程度，剩下的靠重新相处」。
 *
 * @param fromMs 起点。
 * @param toMs 终点。
 * @param maxMinutes 上限（分钟）。
 */
export function elapsedMinutes(fromMs: number, toMs: number, maxMinutes: number): number {
  const raw = (toMs - fromMs) / MINUTE_MS
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(raw, maxMinutes)
}
