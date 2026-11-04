/**
 * 四类来源的许可表与「归功断言」的确定性识别。
 *
 * 手册 §2.2 的四行表，逐行对应到代码：
 *
 * | 类 | 是什么 | 许可什么 | 这里的落点 |
 * |---|---|---|---|
 * | `USER` | 用户自己的话 | 「他们决定了」「他们要求」 | 归功断言的唯一合法出处 |
 * | `TOOL` | 机器输出 | **数字的唯一来源** | 数字覆盖（见 `digits.ts`） |
 * | `ACT` | 被调用的工具 | 「这件事做了」 | 可支撑动作类断言，但不能支撑「用户说了什么」 |
 * | `SELF` | 她自己的散文 | 只许可第一人称判断，**永不许可裸事实** | 只有 SELF 引文 + 主体不是她 → `seed` |
 *
 * ## 「归功断言」为什么不能只看 `subject` 字段
 *
 * O-011 的判定是 `subject !== 'self' && 无 USER && 有 SELF/ACT` → 拒。
 * 它只看**字段**，而字段是模型填的：模型完全可以把 `subject` 写成 `self`，
 * 正文里却写着「用户答应下周一起吃饭」。字段对了，内容错了。
 *
 * 所以本插件再加一道**看正文**的：正文里同时出现「用户 / 你」与归功动词，
 * 却没有 USER 引文 → 拒。两道闸查的是同一件事的两个面，不是重复：
 * 一道查声明，一道查文本。
 *
 * ## 为什么动词表要短
 *
 * 动词表越长，误杀越多。「出现『你』就拒」会把「你还好吗」这类她的关心整类挡掉。
 * 这里只收「把某种立场/决定/说法归给某个人」的动词，且必须**同时**满足
 * 「有用户标记 + 无 USER 引文 + 主体不是她」三条——三条同时成立的句子，
 * 基本上就是「她替用户说了句话」。
 */

import { EVIDENCE_SOURCES } from './types.js'
import type { EvidenceSource } from './types.js'

/**
 * 判一个值是不是四类来源之一（大小写不敏感）。
 * @param value 原始值。
 */
export function asSource(value: unknown): EvidenceSource | undefined {
  if (typeof value !== 'string') return undefined
  const upper = value.trim().toUpperCase()
  return (EVIDENCE_SOURCES as readonly string[]).includes(upper) ? (upper as EvidenceSource) : undefined
}

/**
 * 来源的保留优先级（数字越小越先保留）。
 *
 * `maxEvidence` 截断时按它排序：**最先被牺牲的永远是她自己的散文**。
 * 这个顺序不是随意的——SELF 引文最不值钱（谁都能写），USER 引文最值钱（她编不出来）。
 */
export const SOURCE_PRIORITY: Readonly<Record<EvidenceSource, number>> = Object.freeze({
  USER: 0,
  TOOL: 1,
  ACT: 2,
  SELF: 3,
})

/**
 * 用户标记。正文里出现这些词，说明这句话在讲**用户**的事。
 *
 * 只收「用户」与第二人称。「他 / 她 / 朋友 / 同事」不收——那些可能是
 * TOOL 输出里提到的第三方，把它们算成「用户」会让一道防幻觉的闸变成误杀机器。
 */
export const USER_MARKERS = ['用户', '你', '您'] as const

/**
 * 归功动词：把某种立场、决定或说法归给某个人。
 *
 * 刻意**不收**「是 / 有 / 在」这类系词——「你在家」不需要 USER 引文（可能是 ACT 看到的）。
 */
export const ATTRIBUTION_VERBS = [
  '说',
  '讲',
  '告诉',
  '提到',
  '提过',
  '要求',
  '决定',
  '答应',
  '同意',
  '拒绝',
  '希望',
  '想要',
  '想让',
  '讨厌',
  '喜欢',
  '害怕',
  '担心',
  '承诺',
  '保证',
  '嘱咐',
  '提醒',
  '抱怨',
  '请求',
  '允许',
  '禁止',
  '相信',
  '认为',
  '觉得',
] as const

/**
 * 这段正文是否在**把某件事归给用户**。
 *
 * 判定：含用户标记 **且** 含归功动词。两条都满足才算，缺一条都不算。
 * @param text 正文。
 */
export function isAttributionClaim(text: string): boolean {
  const hasMarker = USER_MARKERS.some(marker => text.includes(marker))
  if (!hasMarker) return false
  return ATTRIBUTION_VERBS.some(verb => text.includes(verb))
}

/**
 * 主体归一化。
 *
 * 省略按 `user`——**这是保守方向**：把「她自己的事」误判成「用户的事」
 * 只会多要一条 USER 引文（可能被拒，可补），反过来会把她的猜测记成用户的画像（不可逆）。
 * @param value 原始主体。
 */
export function resolveSubject(value: unknown): string {
  if (typeof value !== 'string') return 'user'
  const trimmed = value.trim()
  return trimmed === '' ? 'user' : trimmed
}
