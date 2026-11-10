/**
 * 清晰度三档：**把「强度」翻译成用户能听懂的话**。纯函数，不碰 ctx、不读库。
 *
 * 手册 §2.6 原话：
 *
 * | 强度 R | 话术 |
 * |---|---|
 * | `≥0.7` | 正常（不加任何后缀） |
 * | `0.4–0.7` | 「，记不太清了」 |
 * | `<0.4` | 「，只剩个模糊的影子」 |
 *
 * 为什么这件事重要：手册同时写着「用户可感知的『清晰/模糊评级』同时是**最拟人的
 * 遗忘表达**」。也就是说，衰减的最终产物不是某个数字，而是这句话尾。
 * 数字进不了提示词（内感受禁报数，§4.3），话术可以。
 *
 * 两个刻意的取舍：
 *
 * 1. **`clear` 的话术是空串，不是 `undefined`。**
 *    调用方（O-036 装箱注入）要把它直接拼在行尾。返回 `undefined` 会让每个调用方
 *    都写一遍 `?? ''`，而漏写一次就会在正文里出现「undefined」。
 * 2. **只按强度分档，不再判「重要性」。**
 *    手册说「越重要的记忆评级下降越慢」——而「重要」在 O-010 里已经体现为更长的 S，
 *    强度自然掉得慢。再判一次重要性就是同一个问题两个答案。
 */

import type { ClarityBand, ClarityView } from './types.js'

/** 三档话术。手册 §2.6 原文，逐字不改。 */
export const CLARITY_PHRASES: Readonly<Record<ClarityBand, string>> = Object.freeze({
  clear: '',
  faded: '，记不太清了',
  blur: '，只剩个模糊的影子',
})

/**
 * 强度 → 档位。
 *
 * 边界归属：`strength === clearAbove` 算「清晰」（`≥`），`=== fadedAbove` 算「记不太清」。
 * 用闭区间朝上归属，是为了让「刚好 0.7」不被判成「记不太清」——
 * 差一个浮点尾数就让整句加后缀，是很难向用户解释的抖动。
 * @param strength 强度 0–1。
 * @param clearAbove 「清晰」下界。
 * @param fadedAbove 「模糊」下界。
 */
export function bandOf(strength: number, clearAbove: number, fadedAbove: number): ClarityBand {
  const value = Number.isFinite(strength) ? strength : 0
  if (value >= clearAbove) return 'clear'
  if (value >= fadedAbove) return 'faded'
  return 'blur'
}

/**
 * 强度 → 清晰度视图。
 * @param strength 强度 0–1。
 * @param clearAbove 「清晰」下界。
 * @param fadedAbove 「模糊」下界。
 */
export function clarityOf(strength: number, clearAbove: number, fadedAbove: number): ClarityView {
  const value = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0
  const band = bandOf(value, clearAbove, fadedAbove)
  return Object.freeze({ band, phrase: CLARITY_PHRASES[band], strength: value })
}
