/**
 * 四道闸门的**纯函数**部分：不读服务、不写状态、不看时钟。
 *
 * 全部分开后，判定可以在面板里「预览」而不产生副作用（`decide()`）；
 * 记账（频控时刻、连读计数）只在 `admit()` 里做一次。
 *
 * ## 顺序是固定的一条链，不是一个集合
 *
 * ```
 * 开关 → 可用 → 句长 → 炸毛 → 情绪强度 → 频控 → 连读上限
 * ```
 *
 * - **句长在情绪前**：长度是确定性事实，不需要读任何服务；
 *   先读情绪会让「一句 3 个字」也去读一次情绪，白花一次调用。
 * - **炸毛在强度前**：炸毛时张力高、强度很可能过线，先判强度会放行，
 *   于是「她正生气」的时候出声——手册明写炸毛不朗读。
 * - **频控在情绪后**：先判「该不该说」，再判「能不能说得过来」；
 *   反过来的话，一条被频控拦下的消息会永远不知道自己其实该出声。
 * - **连读上限在最后**：它不是「不该说」，是「刚说够了」，理由不同、文案不同。
 */

import type { Config } from './settings.js'
import type { GateReason } from './types.js'

/**
 * 去空白后按**字符**计数。
 *
 * 用码点数而不是 `String.length`：一个 emoji 在 UTF-16 里算 2，
 * 于是「看着 30 字」的一句会被判成 32 字而拒读，且没人看得出为什么。
 * @param text 文本。
 */
export function charCount(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).length
}

/**
 * 情绪强度（手册 §9.4 原文：`max(|mood−0.5|, (energy−0.5)×0.5)`）。
 *
 * `energy` 取 **0–1**（O-026 的 `normalized`）。用 0–100 会算出 24.75 这种
 * 永远过线的数，于是「情绪闸形同不存在」——而它不报错，只是从不下判断。
 * @param mood 心情，0–1。
 * @param energy 情绪能量，0–1。
 */
export function intensityOf(mood: number, energy: number): number {
  const left = Math.abs(mood - 0.5)
  const right = (energy - 0.5) * 0.5
  return Math.max(left, right)
}

/**
 * 句长闸。
 * @param chars 去空白后的字数。
 * @param config 配置。
 */
export function lengthReason(chars: number, config: Config): GateReason | undefined {
  if (chars < config.minChars) return 'too-short'
  if (chars > config.maxChars) return 'too-long'
  return undefined
}

/**
 * 情绪闸。
 *
 * 只有「强度不足 **且** 没有情绪词」才拦。有情绪词时手册允许放行，
 * 因为「一句话的强度」与「一句话里有情绪词」是两种信号，后者更直接。
 * @param intensity 情绪强度；情绪服务缺席时为 `undefined`（此时不拦）。
 * @param emotive 本轮有没有情绪词。
 * @param config 配置。
 */
export function emotionReason(
  intensity: number | undefined,
  emotive: boolean,
  config: Config,
): GateReason | undefined {
  if (intensity === undefined) return undefined
  if (emotive && config.emotiveBypass) return undefined
  if (intensity >= config.intensityMin) return undefined
  return 'flat'
}

/**
 * 频控闸。
 * @param sinceLastMs 距上次放行的毫秒数（从未放行为 `undefined`）。
 * @param config 配置。
 */
export function cooldownReason(sinceLastMs: number | undefined, config: Config): GateReason | undefined {
  if (config.cooldownMs <= 0) return undefined
  if (sinceLastMs === undefined) return undefined
  // 时钟被回拨（`sinceLastMs < 0`）时按「刚放过」处理：宁可少说一句，
  // 也不要在时钟跳变的那几秒里连发三条语音。
  if (sinceLastMs < config.cooldownMs) return 'cooldown'
  return undefined
}

/**
 * 连读上限。
 * @param streak 已经连读了几条。
 * @param config 配置。
 */
export function streakReason(streak: number, config: Config): GateReason | undefined {
  if (streak >= config.maxConsecutive) return 'text-only'
  return undefined
}

/**
 * 取语速增量：六态给了就用，没给就返回 `undefined`（让引擎用默认）。
 *
 * **不要在这里补 0**：`undefined` 的意思是「手册没给这个状态的数字」，
 * 补成 0 会让「沿用引擎默认」与「明确要求原速」变成同一件事。
 * @param delta 六态给的增量。
 */
export function rateOf(delta: number | undefined): number | undefined {
  if (delta === undefined || !Number.isFinite(delta)) return undefined
  return Math.min(0.5, Math.max(-0.5, Math.round(delta * 100) / 100))
}
