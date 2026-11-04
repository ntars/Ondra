/**
 * 话题键：把「一件事」压成一个可比较的字符串。
 *
 * ## 为什么用稳定 id 而不是正文相似度
 *
 * 72 小时冷却要回答「这件事最近说过没有」。用正文相似度做这件事，
 * O-129 已经踩过坑：模板化正文（`搜索「X」没有结果`）共享前缀，
 * 任意两句都有 0.7–0.8 的相似度，于是所有搜索结果类执念被当成同一件事。
 *
 * 所以本文件的第一选择永远是**上游给的稳定 id**（缺口 id / 承诺 id / 待办 id）——
 * 同一个 id 跨轮不变，换个说法也认得出来，而且不需要任何阈值。
 * 只有调用方只给了自由文本时，才退回「归一化后取前 12 字」。
 *
 * ## 前缀要剥
 *
 * 待办与承诺的正文常常带标记（`【待办】记得买牛奶`）。不剥的话，
 * 「记得买牛奶」与「买牛奶」会变成两个话题，冷却就漏了。
 * 剥的清单是**封闭的**：只剥本仓自己写进正文的那几个标记词，
 * 不做「去掉所有可能的修饰」——那会把正文剥空，让所有待办变成同一个话题。
 */

import { TOPIC_CHARS } from './types.js'

/** 方括号/圆括号包起来的前缀（`【待办】`、`[todo]`、`（提醒）`）。 */
const BRACKET_PREFIX_RE = /^\s*(?:【[^】]*】|\[[^\]]*\]|（[^）]*）|\([^)]*\))\s*/u

/** 引导词前缀。只收本仓会写进正文的那几个。 */
const LEAD_WORD_RE = /^(?:记得|别忘了|别忘记|提醒我|要记得|待办[:：]?|承诺[:：]?)\s*/u

/** 空白、标点、符号（去重与话题键都不关心它们）。 */
const NOISE_RE = /[\s\p{P}\p{S}]/gu

/**
 * 归一化一段文本：全半角统一、去前缀标记、去空白与标点、英文小写。
 * @param text 原文。
 */
export function normalizeTopic(text: string): string {
  let out = text.normalize('NFKC').trim()
  // 前缀可能叠加（`【待办】记得…`），循环剥到不再变化为止。
  // 上限 3 次：正常正文不会有三层前缀，无限循环只会把「一直剥」变成死循环。
  for (let i = 0; i < 3; i += 1) {
    const before = out
    out = out.replace(BRACKET_PREFIX_RE, '').replace(LEAD_WORD_RE, '')
    if (out === before) break
  }
  return out.toLowerCase().replace(NOISE_RE, '')
}

/**
 * 取归一化文本的前 `n` 个字（按码点切，不切坏代理对）。
 * @param text 原文。
 * @param n 字数。
 */
export function prefixOf(text: string, n: number): string {
  const chars = Array.from(normalizeTopic(text))
  return chars.slice(0, Math.max(0, n)).join('')
}

/**
 * 自由文本的话题键。
 * @param text 原文。
 */
export function textTopic(text: string): string {
  return 'text:' + prefixOf(text, TOPIC_CHARS)
}

/**
 * 造一个话题键：有稳定 id 就用 id，没有才退回文本前缀。
 * @param kind 种类。
 * @param key 稳定键（空串表示没有）。
 * @param text 正文。
 */
export function topicOf(kind: string, key: string, text: string): string {
  const trimmed = key.trim()
  return trimmed === '' ? textTopic(text) : kind + ':' + trimmed
}

/**
 * 从「她说过的话」里判断某条候选的正文是否被提到了。
 *
 * 从长片段往短片段试（8 → 4 字）：长片段更精确，短片段更容易命中。
 * 先试长的，是为了让「同一件事的两种说法」优先按长的认出来。
 * 片段太短（< 4 字）时直接放弃——「今天」这种两字片段会命中一切。
 * @param haystack 她发出去的话。
 * @param candidateText 候选正文。
 * @param minFragment 最短片段。
 * @param maxFragment 最长片段。
 */
export function mentions(
  haystack: string,
  candidateText: string,
  minFragment: number,
  maxFragment: number,
): boolean {
  const body = normalizeTopic(haystack)
  if (body === '') return false
  const chars = Array.from(normalizeTopic(candidateText))
  const top = Math.min(maxFragment, chars.length)
  for (let size = top; size >= minFragment; size -= 1) {
    const fragment = chars.slice(0, size).join('')
    if (fragment !== '' && body.includes(fragment)) return true
  }
  return false
}
