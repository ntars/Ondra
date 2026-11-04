/**
 * 应激行为指令：皮质醇 ≥80 时给拼装层的那一段话。
 *
 * 手册 §3.8 最后一句：「皮质醇 ≥80 时在系统提示词最前面注入行为指令（应激压制）」。
 * 正文**逐字照抄**手册 §4.3 四层铁律里给出的那句示例——`[身体] 你在应激：话短、别开玩笑`。
 *
 * 为什么一个字都不自己写：
 *
 * - 手册 §4.3 的内感受铁律是「①禁止报数 ②禁止命名情绪代号 ③只能暗示」。
 *   自己发挥一句「你皮质醇偏高」立刻违规，而这类违规在日志里完全看不出来
 *   （只有用户看见她突然开始说数值）。
 * - 「话短」与「别开玩笑」正是 §3.2 应激倾斜里「句长 −40%、语气词 −70%、不主动开玩笑」
 *   的产品口径。**具体系数不写进提示词**：系数归 O-038（节奏）与 O-040（口语化），
 *   在这里再写一份 0.6 / 0.3 就是第二个真源。
 */

import type { PromptFragment, StressMultiplier } from './types.js'

/**
 * 指令正文（**逐字**取自手册 §4.3）。
 *
 * 刻意不含任何数字、不含情绪代号：她要「觉得自己在应激」，
 * 不是「知道自己皮质醇是 82」。
 */
export const STRESS_DIRECTIVE_TEXT = '[身体] 你在应激：话短、别开玩笑。'

/** 构造指令所需的两个工程参数。 */
export interface DirectiveSettings {
  /** 存活时长（分钟）。 */
  readonly directiveTtlMinutes: number
  /** 排序键（已夹到 [-1000, -1]）。 */
  readonly directiveOrder: number
}

/**
 * 按当前倍率决定要不要出指令。
 *
 * **只有危机档出**，其余档返回 `undefined`。
 * 返回空片段是个陷阱：空片段在拼装时会占掉一个位置、还可能被算进预算，
 * 而它一个字都没说——那是最难发现的一类「提示词变长但行为没变」。
 *
 * @param multipliers 倍率快照。
 * @param settings 工程参数。
 */
export function buildDirective(
  multipliers: StressMultiplier,
  settings: DirectiveSettings,
): PromptFragment | undefined {
  if (multipliers.band !== 'crisis') return undefined
  return Object.freeze({
    order: settings.directiveOrder,
    ttlMinutes: settings.directiveTtlMinutes,
    // 这段是「直接读数 → 直接指令」，中间没有推断环节，所以置信度就是 1。
    // 填 0.8 之类的数只会让拼装层在低预算时先砍掉它，而它本来是最该留下的。
    confidence: 1,
    text: STRESS_DIRECTIVE_TEXT,
    kind: 'stress',
  })
}
