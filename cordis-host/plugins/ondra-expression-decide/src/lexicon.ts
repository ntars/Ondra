/**
 * 六态的**线索词表与标点表** —— 本插件唯一的语料来源。
 *
 * ## 手册没给词表，这是自定语料
 *
 * 手册 §3.2 给的是**数值判据**（`mood > 0.7` 之类），不是词表；
 * §4.2 只给了「口头禅池 12–20 条」这种数量口径。所以「哪些词算雀跃」
 * 手册里没有答案。本文件的每一张表都是自定的，已写进 README
 * 「已知限制」与台账待裁决——**不冒充手册口径**。
 *
 * 三条收录纪律（与 O-051 的情绪词表同源）：
 *
 * 1. **只收两字及以上。** 单字「累 / 烦 / 气 / 乖 / 哼」在
 *    「累积 / 烦请 / 气垫 / 乖乖 / 哼唱」里会误命中，而误命中的症状
 *    是"她的表情偶尔莫名其妙"，没人会怀疑到词表。
 * 2. **不收网络流行梗。** 半衰期只有几个月；过期不报错，只是慢慢失效，
 *    而失效之后词表看起来仍然"很全"。
 * 3. **同一句话里长词优先、命中的片段挖掉。** 「最喜欢」里含「喜欢」，
 *    不挖掉就会一条线索记两次分，同一句话的表情比别的句子"更确定"，
 *    这种偏差在任何日志里都看不出来。
 */

import type { ExpressionCue, ExpressionState } from './types.js'

/** 强线索权重：单独一条就够定表情。 */
export const WEIGHT_STRONG = 3

/** 中线索权重：需要两条，或配一条句形/标点线索。 */
export const WEIGHT_MID = 2

/** 标点线索权重。 */
export const WEIGHT_PUNCT = 2

/** 句形线索权重（最弱：它只说"这句话的形状像某态"，不说内容）。 */
export const WEIGHT_SHAPE = 1

/**
 * 强线索词（权重 3）。
 *
 * 入选标准：这句话**几乎只会在那一种情绪下说出口**，
 * 且不会作为更长词的一部分出现在别的意思里。
 */
export const STRONG_WORDS: Readonly<Record<ExpressionState, readonly string[]>> = Object.freeze({
  joyful: Object.freeze(['太好了', '好棒', '好耶', '最喜欢', '太开心']),
  soft: Object.freeze(['别担心', '我陪你', '心疼', '抱抱']),
  calm: Object.freeze([]),
  wilted: Object.freeze(['有点累', '难受', '对不起', '抱歉']),
  bristled: Object.freeze(['你走开', '别碰', '凭什么', '烦不烦', '少来']),
  sleepy: Object.freeze(['好困', '想睡', '睁不开']),
})

/**
 * 中线索词（权重 2）。
 *
 * 入选标准：明显偏向某态，但在别的语境里也可能出现（「喜欢」可以是喜欢一件事，
 * 也可以是喜欢一个人）。这类词靠"两条一起出现"才定案，正是 `minScore` 的用途。
 */
export const MID_WORDS: Readonly<Record<ExpressionState, readonly string[]>> = Object.freeze({
  joyful: Object.freeze(['开心', '高兴', '喜欢', '期待', '有意思', '好玩']),
  soft: Object.freeze(['好啦', '乖乖', '慢慢来', '没事的', '没关系的', '摸摸', '辛苦啦']),
  calm: Object.freeze(['收到', '知道了', '我看看', '嗯嗯', '没问题', '行吧']),
  wilted: Object.freeze(['算了', '不想', '难过', '随便吧']),
  bristled: Object.freeze(['讨厌', '生气', '别闹', '才不']),
  sleepy: Object.freeze(['睡了', '晚安', '困了', '打哈欠', '眯一会']),
})

/** 词 → 态 的反查表（长词在前，保证「最喜欢」先于「喜欢」命中）。 */
interface WordHit {
  readonly word: string
  readonly state: ExpressionState
  readonly weight: number
}

/** 全部线索词按长度降序排好，**只排一次**。 */
const WORD_TABLE: readonly WordHit[] = Object.freeze(
  (['joyful', 'soft', 'calm', 'wilted', 'bristled', 'sleepy'] as const).flatMap(state => [
    ...STRONG_WORDS[state].map(word => ({ word, state, weight: WEIGHT_STRONG })),
    ...MID_WORDS[state].map(word => ({ word, state, weight: WEIGHT_MID })),
  ]).sort((a, b) => b.word.length - a.word.length),
)

/** 去空白后的字数。与 O-051 的 `charCount()` 同口径（只去空白，不去标点）。 */
export function charCount(text: string): number {
  return text.replace(/\s+/g, '').length
}

/**
 * 数一遍词线索。
 *
 * 命中的片段会被替换成占位空格（长度保持不变），因此
 * 「最喜欢」命中后，同一位置的「喜欢」不会再命中；
 * 而「喜欢」与「开心」这类互不重叠的词各算一次。
 * @param text 一条正文。
 */
export function matchWords(text: string): readonly ExpressionCue[] {
  let rest = text
  const cues: ExpressionCue[] = []
  for (const hit of WORD_TABLE) {
    let from = rest.indexOf(hit.word)
    while (from >= 0) {
      cues.push({ kind: 'word', state: hit.state, weight: hit.weight, cue: hit.word })
      // 挖掉命中片段，长度不变（保持后续下标稳定）。
      rest = rest.slice(0, from) + '　'.repeat(hit.word.length) + rest.slice(from + hit.word.length)
      from = rest.indexOf(hit.word)
    }
  }
  return cues
}

/** 标点线索表。`re` 用全局匹配，一条句子里可能出现多次。 */
interface PunctRule {
  readonly re: RegExp
  readonly state: ExpressionState
  readonly weight: number
}

/**
 * 标点线索。
 *
 * `？！` / `！？` 排在 `！` 之前：手册 §3.2 把「？！多」判给炸毛，
 * 而「！」判给雀跃——先判组合，炸毛的 3 分才会压过雀跃的 2 分；
 * 反过来逐条判，一句「你怎么这样？！」会先被算成雀跃。
 */
const PUNCT_RULES: readonly PunctRule[] = Object.freeze([
  { re: /[？！]{2}|[?!]{2}/g, state: 'bristled', weight: WEIGHT_STRONG },
  { re: /？{2,}|\?{2,}/g, state: 'bristled', weight: WEIGHT_PUNCT },
  { re: /！+|!+|～+|~+/g, state: 'joyful', weight: WEIGHT_PUNCT },
  { re: /…{2,}/g, state: 'wilted', weight: WEIGHT_SHAPE },
])

/**
 * 数一遍标点线索。
 * @param text 一条正文。
 */
export function matchPunct(text: string): readonly ExpressionCue[] {
  const cues: ExpressionCue[] = []
  for (const rule of PUNCT_RULES) {
    const found = text.match(rule.re)
    if (found === null) continue
    // 同一串「？？？」只算一条线索：连打五个问号是同一个情绪，
    // 算五条会让它在整轮里压过真正有内容的那一句。
    cues.push({ kind: 'punct', state: rule.state, weight: rule.weight, cue: found[0] })
  }
  return cues
}

/** 句形线索的阈值：不超过这个字数算「极短」。 */
export const SHORT_CHARS = 4

/** 句形线索的阈值：不少于这个字数算「长句一条说完」。 */
export const LONG_CHARS = 30

/** 有没有任何标点（中文与英文常用标点都算）。引号不计：引号本身不代表语气。 */
const ANY_PUNCT = /[，。！？、；：…—～·,.!?;:]/

/**
 * 句形线索：只看**长度与有没有标点**，不看内容。
 *
 * 两条都来自手册 §3.2 的句形描述——炸毛「极短常单字」、
 * 蔫「长句一条说完」。它们权重最低（1），因为形状相似的两句话
 * 内容可能完全相反；它们的作用是"补一刀"，不是"定案"。
 * @param text 一条正文。
 * @param chars 去空白后的字数。
 */
export function matchShape(text: string, chars: number): readonly ExpressionCue[] {
  const cues: ExpressionCue[] = []
  if (chars > 0 && chars <= SHORT_CHARS && !ANY_PUNCT.test(text)) {
    cues.push({ kind: 'shape', state: 'bristled', weight: WEIGHT_SHAPE, cue: `${chars} 字且无标点` })
  }
  if (chars >= LONG_CHARS) {
    cues.push({ kind: 'shape', state: 'wilted', weight: WEIGHT_SHAPE, cue: `${chars} 字长句` })
  }
  return cues
}

/**
 * 语料自检：词表本身有没有问题。
 *
 * 在 `apply()` 里调一次并打日志。检查四件事：
 * 长度不足两字、跨态重复、含空白、同态内重复。
 * 这四类错都不会让代码报错，只会让表情慢慢偏——所以必须能自己喊出来。
 * @returns 问题描述（空数组表示没问题）。
 */
export function lexiconIssues(): readonly string[] {
  const issues: string[] = []
  const seen = new Map<string, ExpressionState>()
  const states: readonly ExpressionState[] = ['joyful', 'soft', 'calm', 'wilted', 'bristled', 'sleepy']

  for (const state of states) {
    const own = new Set<string>()
    for (const [tier, list] of [
      ['强', STRONG_WORDS[state]],
      ['中', MID_WORDS[state]],
    ] as const) {
      for (const word of list) {
        if (word.length < 2) issues.push(`${tier}词「${word}」不足两字`)
        if (/\s/.test(word)) issues.push(`${tier}词「${word}」含空白`)
        if (own.has(word)) issues.push(`${state} 的「${word}」重复收录`)
        own.add(word)
        const previous = seen.get(word)
        if (previous !== undefined && previous !== state) {
          issues.push(`「${word}」同时属于 ${previous} 与 ${state}`)
        }
        seen.set(word, state)
      }
    }
  }
  return issues
}
