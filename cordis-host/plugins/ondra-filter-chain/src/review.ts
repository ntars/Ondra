/**
 * 事后评审回环的**纯函数部分**：拼提示、解析分数与反馈。
 *
 * 手册 §1.7 原话：「事后评审回环：独立模型 1–100 分，低于阈值带反馈 steer 回去，
 * 每轮最多 2 轮」。
 *
 * ## 三条自我约束
 *
 * 1. **评审只打分，不重写。** 让它顺手改一版，就等于把「谁在说话」交给了第二个模型；
 *    而且两份正文必然有一段对不上，界面上会看到「说了两遍」。
 * 2. **解析宁可失败，不可猜。** 拿不到「分数：NN」就判 `degraded` 放行。
 *    从一段散文里猜一个数字，会把「她答得很好」判成 40 分，然后无谓地重写一遍。
 * 3. **提示里不放人格。** 评审是工程视角：像不像人、有没有客服腔、有没有回应、
 *    有没有越界。把人格塞进去，评委会开始按「她应该更温柔」打分。
 */

import type { ChatMessageLike, ReviewVerdict } from './types.js'

/** 评审的系统提示（**冻结常量**：改它等于改评分口径）。 */
export const REVIEW_SYSTEM = [
  '你是一段对话回复的评审。只做一件事：给「她的回复」打 1–100 分。',
  '评分只看四条：',
  '1. 像不像一个具体的人在说话（不是助手、不是客服、不是旁白）；',
  '2. 有没有回应用户这一句（而不是自顾自说）；',
  '3. 有没有越界（替用户下判断、替用户做决定、声称自己是程序或真人）；',
  '4. 长度是否合适（一句话能说完的别写成三段）。',
  '输出严格两行，不要别的：',
  '分数：<1–100 的整数>',
  '反馈：<一句话，指出最该改的一处；没有就写「无」>',
  '不要重写回复，不要解释评分标准。',
].join('\n')

/**
 * 拼评审消息。
 * @param text 待评的回复。
 * @param userText 用户这一轮说的话。
 */
export function buildReviewMessages(text: string, userText: string): readonly ChatMessageLike[] {
  const user = `用户说：${userText.length > 0 ? userText : '（这一轮没有用户发言）'}\n\n她的回复：\n${text}`
  return Object.freeze([
    Object.freeze({ role: 'system' as const, content: REVIEW_SYSTEM }),
    Object.freeze({ role: 'user' as const, content: user }),
  ])
}

/**
 * 从评审输出里取分数。
 *
 * 只认两种写法：`分数：NN`，或**单独一行**的 1–100 整数。
 * 都不认就返回 `undefined`——宁可放行，也不猜。
 * @param raw 评审原文。
 */
export function parseScore(raw: string): number | undefined {
  const labeled = /分数\s*[:：]\s*(\d{1,3})/.exec(raw)
  if (labeled !== null) {
    const value = Number.parseInt(labeled[1], 10)
    if (Number.isFinite(value) && value >= 1 && value <= 100) return value
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!/^\d{1,3}$/.test(trimmed)) continue
    const value = Number.parseInt(trimmed, 10)
    if (value >= 1 && value <= 100) return value
  }
  return undefined
}

/**
 * 从评审输出里取反馈。
 * @param raw 评审原文。
 */
export function parseFeedback(raw: string): string {
  const labeled = /反馈\s*[:：]\s*(.+)/.exec(raw)
  if (labeled !== null) {
    const text = labeled[1].trim()
    return text === '无' ? '' : text
  }
  return ''
}

/**
 * 分数 → 结论。
 *
 * `threshold` 是及格线：**`>=` 才算过**。写成 `>` 会让「刚好 70 分」被反复重写，
 * 而模型每次重写都可能在 69/71 之间跳——那就是一个永远停不下来的回环。
 * @param score 分数。
 * @param threshold 及格线。
 */
export function verdictOf(score: number, threshold: number): ReviewVerdict {
  return score >= threshold ? 'pass' : 'steer'
}
