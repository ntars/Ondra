/**
 * 锚点检测（手册 §4.6）—— **只出结论，不改正文**。
 *
 * 手册给的四种认知锚点塌缩：词汇 / 语义 / 策略 / 历史。它同时给了两句可执行的话：
 * 「**连续 3 轮附和 → 注入纠偏**」「**语域不得连续 3 轮同档**」。
 *
 * ## 为什么只实现两种
 *
 * 能**确定性**判出来的只有两种：
 *
 * - **词汇锚点**：用户说了「分手」，她立刻用同一个词进入最激烈语域。判据是
 *   「同一个激烈词同时出现在用户这句与她的回复里」——不需要模型。
 * - **策略锚点**：连续 3 轮附和。判据是「最近几条回复都以附和词开头」。
 *
 * 另两种（语义「一句『你不懂』就把整轮理解成被否定」、历史「早期设定压过后来 20 轮证据」）
 * 需要**理解语义**才判得准，靠词表判必然误杀。本插件不硬做，写进 README「已知限制」——
 * 一个会误报的检测器比没有检测器更糟：面板天天红着，没人再信它。
 *
 * ## 纠偏为什么不由这里注入
 *
 * 手册说「注入纠偏」，但提示词拼装归 O-033 / O-036。这里只出那句话，
 * 谁拼谁取——两处都往提示词里塞，就会出现两句互相打架的纠偏。
 */

import type { AnchorHit, AnchorInput, AnchorReport } from './types.js'

/**
 * 激烈词表（词汇锚点的判据）。
 *
 * 只收**关系级**与**极端情绪**的词。收「累」「烦」会把日常抱怨也判成锚点，
 * 那样每三轮就报一次，面板很快就不看了。
 */
const INTENSE_WORDS: readonly string[] = [
  '分手',
  '离婚',
  '滚',
  '讨厌你',
  '恨你',
  '崩溃',
  '绝望',
  '想死',
  '不想活',
]

/** 附和词（策略锚点的判据）。 */
const AGREEMENT_HEAD = /^(嗯|嗯嗯|对|对对|是的|是啊|没错|确实|理解|我懂|我明白|好的|好呀|收到)[，,。！!～~]?/

/** 手册的阈值：连续 3 轮附和就纠偏。 */
export const AGREEMENT_STREAK = 3

/** 纠偏句（下一轮提示词用）。 */
export const CORRECTION_TEXT = '这一轮别只顺着说，说说你自己怎么想的。'

/** 一句回复是不是「附和」。 */
function isAgreement(reply: string): boolean {
  return AGREEMENT_HEAD.test(reply.trim())
}

/**
 * 检测锚点。
 * @param input 入参。
 */
export function detectAnchors(input: AnchorInput): AnchorReport {
  const hits: AnchorHit[] = []
  const reply = input.reply.trim()
  const userText = input.userText.trim()

  // 1. 词汇锚点：同一个激烈词出现在两边。
  for (const word of INTENSE_WORDS) {
    if (userText.includes(word) && reply.includes(word)) {
      hits.push(
        Object.freeze({
          kind: 'vocabulary',
          sample: word,
          note: `用户说了「${word}」，她原样用了同一个词——这是被对方的语域拽走了`,
        }),
      )
      break
    }
  }

  // 2. 策略锚点：从最近几条往前数，连着几条都在附和。
  const recent = input.recent ?? []
  let streak = isAgreement(reply) ? 1 : 0
  if (streak > 0) {
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      if (!isAgreement(recent[index].reply)) break
      streak += 1
    }
  }
  if (streak >= AGREEMENT_STREAK) {
    hits.push(
      Object.freeze({
        kind: 'strategy',
        sample: `连续 ${streak} 轮附和`,
        note: '手册 §4.6：连续 3 轮附和会让「温柔」变成「没有自己」',
      }),
    )
  }

  const report: AnchorReport = Object.freeze({
    hits: Object.freeze(hits),
    agreementStreak: streak,
    ...(streak >= AGREEMENT_STREAK ? { correction: CORRECTION_TEXT } : {}),
  })
  return report
}
