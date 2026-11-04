/**
 * 历史裁剪 —— **纯函数**。
 *
 * ## 为什么必须成对裁
 *
 * 历史是 `[user, assistant, user, assistant, ...]`。从头部丢**一条**，
 * 数组就会以 `assistant` 开头——模型看到的第一句是「她说过的话」，
 * 而没有任何人问过。表现是她开始「接着上一个话题自说自话」，
 * 而日志里一切正常（没有报错、没有降级），只有用户觉得她怪。
 *
 * 所以裁剪单位是**一对**，并且有下限：至少留最近一轮。
 * 一轮都不留等于清空上下文，那不是压缩，那是失忆。
 *
 * ## 为什么条数与字数要同时判
 *
 * 两个闸门挡的是两类不同的膨胀：
 * - 只判条数：三条 3000 字的长消息（9000 字）照样进上下文；
 * - 只判字数：200 条「嗯」「在」加起来才 400 字，条数却已经爆了。
 *
 * 手册 §9.5 给的是「≤10 条且 ≤2000 字」，本来就是两个条件。
 */

import { charsOf } from './messages.js'
import type { DialogueMessage } from './types.js'

/** 裁剪结果。 */
export interface CompactOutcome {
  /** 丢掉的**消息条数**（由调用方折半成轮数显示）。 */
  readonly dropped: number
  /** 保留的条数。 */
  readonly kept: number
  /** 裁剪后的字符数。 */
  readonly chars: number
}

/**
 * 按条数与字数裁剪历史。
 *
 * **不修改入参**：返回的是裁剪后的新信息，入参原样不动。
 * 这样调用方可以先算一遍「裁完是什么样」再决定要不要替换
 * （界面上的「压缩预览」就需要这个能力）。
 * @param history 历史消息（应为成对）。
 * @param maxTurns 保留轮数上限。
 * @param maxChars 字符上限。
 */
export function compactHistory(
  history: readonly DialogueMessage[],
  maxTurns: number,
  maxChars: number,
): CompactOutcome {
  let list: readonly DialogueMessage[] = history
  const pairs = (): number => Math.floor(list.length / 2)

  // 条件里同时判 `pairs() > 1`：留至少一轮。这个下限不能省——
  // 一条超长消息就能让 `chars > maxChars` 永远成立，没有下限就是死循环
  // （或者把历史清空后仍然「超限」，表现是每轮都在裁、每轮都裁不掉）。
  while ((pairs() > maxTurns || charsOf(list) > maxChars) && pairs() > 1) {
    list = list.slice(2)
  }

  return {
    dropped: history.length - list.length,
    kept: list.length,
    chars: charsOf(list),
  }
}
