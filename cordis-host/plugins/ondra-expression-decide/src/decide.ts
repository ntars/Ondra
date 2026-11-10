/**
 * 判定链的**纯函数层**：正文 → 线索 → 分数 → 标记。
 *
 * 这一层不读服务、不看时钟、不写日志，因此可以逐例对拍
 * （本轮用独立逻辑复刻跑过一遍，见简报）。凡是"要不要换脸"这类
 * 需要外部信息的判断，都不放在这里。
 *
 * ## 判定顺序
 *
 * ```
 * 线索（词 / 标点 / 句形） → 六态各累一分 → 取最高
 *   ├─ 最高分 ≥ minScore          → source 'text'（可以换脸）
 *   ├─ 否则有当前六态              → source 'state'（脸上不该动）
 *   └─ 否则                        → source 'default'（退回配置的默认表情）
 * ```
 *
 * `source` 比分数更重要：调用方看 `source === 'text'` 才换脸。
 * 只看分数的话，"一分都没有"和"两分但刚好够线"会被当成同一件事。
 */

import { charCount, matchPunct, matchShape, matchWords } from './lexicon.js'
import { STATE_PRIORITY } from './types.js'
import type { ExpressionCue, ExpressionMark, ExpressionState } from './types.js'

/** 一次判定的入参。 */
export interface MarkInput {
  /** 一条正文。 */
  readonly text: string
  /** 在整轮里的序号。 */
  readonly index: number
  /** 分数门槛。 */
  readonly minScore: number
  /** 什么都没有时用的默认表情。 */
  readonly fallbackState: ExpressionState
  /** 当前六态（来自 O-031）。缺席表示拿不到。 */
  readonly stateFromExpress?: ExpressionState
}

/** 六态零分表。每次判定都要一份新的，不能共享（会被累加污染）。 */
function zeroScores(): Record<ExpressionState, number> {
  return { joyful: 0, soft: 0, calm: 0, wilted: 0, bristled: 0, sleepy: 0 }
}

/**
 * 收一条正文的全部线索。
 * @param text 正文。
 */
export function collectCues(text: string): { cues: readonly ExpressionCue[]; chars: number } {
  const chars = charCount(text)
  const cues = [...matchWords(text), ...matchPunct(text), ...matchShape(text, chars)]
  // 按权重降序：面板上"为什么判成这个"第一条就该是最有说服力的那条。
  cues.sort((a, b) => b.weight - a.weight)
  return { cues, chars }
}

/**
 * 把线索累加成六态分数。
 * @param cues 线索。
 */
export function scoreOf(cues: readonly ExpressionCue[]): Record<ExpressionState, number> {
  const scores = zeroScores()
  for (const cue of cues) scores[cue.state] += cue.weight
  return scores
}

/**
 * 取最高分的态。
 *
 * 并列时按 `STATE_PRIORITY` 取（与 O-031 的判据优先级同序），
 * 因此"同一组读数"在两处不会得出两个不同的答案。
 * @param scores 六态分数。
 */
export function rankOf(scores: Readonly<Record<ExpressionState, number>>): {
  readonly state: ExpressionState
  readonly score: number
  readonly runnerUp?: { readonly state: ExpressionState; readonly score: number }
} {
  const ranked = STATE_PRIORITY.map(state => ({ state, score: scores[state] })).sort(
    (a, b) =>
      b.score - a.score ||
      STATE_PRIORITY.indexOf(a.state) - STATE_PRIORITY.indexOf(b.state),
  )
  const top = ranked[0] as { state: ExpressionState; score: number }
  const second = ranked[1] as { state: ExpressionState; score: number }
  // 第二名为 0 分不算"竞争者"：报出去会让面板显示「和 0 分并列」，读的人会困惑。
  return second.score > 0
    ? { state: top.state, score: top.score, runnerUp: { state: second.state, score: second.score } }
    : { state: top.state, score: top.score }
}

/**
 * 判一条。
 * @param input 入参。
 */
export function markOf(input: MarkInput): ExpressionMark {
  const { cues, chars } = collectCues(input.text)
  const ranked = rankOf(scoreOf(cues))

  let state: ExpressionState
  let source: ExpressionMark['source']
  if (ranked.score >= input.minScore) {
    state = ranked.state
    source = 'text'
  } else if (input.stateFromExpress !== undefined) {
    state = input.stateFromExpress
    source = 'state'
  } else {
    state = input.fallbackState
    source = 'default'
  }

  const mark: ExpressionMark = {
    index: input.index,
    state,
    source,
    score: ranked.score,
    ...(ranked.runnerUp === undefined ? {} : { runnerUp: ranked.runnerUp }),
    cues: Object.freeze(cues),
    chars,
  }
  return Object.freeze(mark)
}

/**
 * 一整轮脸上最后该是哪个态。
 *
 * 规则：**累计文本分最高**的态；并列时取**最后一条**的态
 * （一轮说完，脸上停住的是最后那个表情）。
 * 整轮都没有文本线索时，等于最后一条的 `state`。
 * @param marks 逐条标记。
 * @param fallbackState 一条都没有时用的默认表情。
 */
export function dominantOf(
  marks: readonly ExpressionMark[],
  fallbackState: ExpressionState,
): ExpressionState {
  if (marks.length === 0) return fallbackState

  const totals = zeroScores()
  let hasText = false
  for (const mark of marks) {
    if (mark.source !== 'text') continue
    hasText = true
    totals[mark.state] += mark.score
  }
  if (!hasText) return (marks[marks.length - 1] as ExpressionMark).state

  // 并列时"最后一条"胜：从后往前找第一个分数等于最高分的。
  let best = -1
  for (const state of STATE_PRIORITY) best = Math.max(best, totals[state])
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    const mark = marks[i] as ExpressionMark
    if (mark.source === 'text' && totals[mark.state] === best) return mark.state
  }
  return fallbackState
}
