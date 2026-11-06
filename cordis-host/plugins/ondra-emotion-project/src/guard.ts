/**
 * 内感受护栏（§4.3 的机器可读版本）。
 *
 * 它扫四类东西：**数字 / 百分号 / 维度名 / 六态名 / 激素名**。
 * 命中任何一条，`pass` 就是 `false`。
 *
 * ## 三条必须写清的边界
 *
 * 1. **只扫投影与注入块，不扫对话正文。**
 *    这条不是「怕麻烦」，是产品正确性：用户说「我今天 8 点起床」，
 *    她引用这句话时必然带数字。扫正文会让她连用户的话都不能复述。
 *    铁律约束的是**她描述自己**的方式，不是整个世界。
 *
 * 2. **只拦阿拉伯数字与全角数字，不拦中文数字词。**
 *    「一点累」「两句」「三天」是自然语言的程度与数量，不是报数；
 *    报数的形态是「0.62」「82 分」「百分之八十」。
 *    拦中文数字会把「有点提不起劲」整句判死——那正是我们想要的暗示。
 *    代价：「百分之八十」不带百分号时漏网。已在 README「已知限制」写明。
 *
 * 3. **`困` 只拦组合词，不拦裸字。**
 *    「困」是六态名，但它出现在「困难」「困扰」「困境」里的概率远高于状态名。
 *    所以只匹配 `困了 / 困得 / 好困 / 很困 / 有点困 / 困意 / 犯困`。
 *    这是**宁可漏一次，不要误杀一片**——误杀会让整段模板被拒，
 *    而漏一次只是「她说了一句『好困』」，仍然是暗示，不是报数。
 */

import type { GuardHit, GuardKind, GuardReport } from './types.js'

/** 数字：连续的阿拉伯数字或全角数字，合并成一次命中。 */
const DIGIT_PATTERN = /[0-9０-９]+/g

/** 百分号：`%` 与 `％`。出现即视为报数（「八成」这种不带符号的漏网，见文件头）。 */
const PERCENT_PATTERN = /[%％]+/g

/** 维度名。中英并列。 */
const AXIS_WORDS: readonly string[] = Object.freeze([
  'pleasure',
  'arousal',
  'dominance',
  'mood',
  'energy',
  'tension',
  '愉悦度',
  '唤醒度',
  '支配感',
  '心情',
  '能量',
  '张力',
  '情绪值',
  '数值',
  '指数',
  '评分',
])

/**
 * 六态名。
 *
 * `困` 拆成组合词（见文件头第 3 条）；其余五个都足够独特，直接用。
 */
const STATE_WORDS: readonly string[] = Object.freeze([
  'joyful',
  'soft',
  'calm',
  'wilted',
  'bristled',
  'sleepy',
  '雀跃',
  '软和',
  '平静',
  '蔫',
  '炸毛',
  '困了',
  '困得',
  '好困',
  '很困',
  '有点困',
  '困意',
  '犯困',
])

/** 激素名。§3.8 的指令与 §4.3 的示例都不带激素名，这里一并拦住。 */
const HORMONE_WORDS: readonly string[] = Object.freeze([
  'cortisol',
  'dopamine',
  'serotonin',
  'oxytocin',
  '皮质醇',
  '多巴胺',
  '血清素',
  '催产素',
  '激素',
])

/** 空计数。 */
function emptyCounts(): Record<GuardKind, number> {
  return { digit: 0, percent: 0, axis: 0, state: 0, hormone: 0 }
}

/** 转义正则元字符（词表将来若加 `.` 或 `-` 不会被当成语法）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 是否纯 ASCII 单词（决定用词边界还是 `indexOf`）。 */
function isAsciiWord(value: string): boolean {
  return /^[a-z]+$/i.test(value)
}

/**
 * `困` 后面接这些字时，它不是状态名，是另一个词。
 *
 * 「有点困」与「有点困扰」只差一个字，而后者是个常见说法。
 * 中文没有词边界，所以只能做**后一字否决**：命中「……困」之后，
 * 看紧跟的那一个字是不是构词成分。是，就跳过这次命中。
 *
 * 这条是纯逻辑对拍时被真实文本逼出来的：`有点困扰` 被判成「有点困」，
 * 而误杀的后果是**整段模板被拒**（`template-violation`），比漏拦严重得多。
 */
const STATE_CONTINUATION = '难扰境界惑苦顿局守住'

/**
 * 一个状态词命中是否应当否决。
 * @param word 命中的词。
 * @param text 整段文本。
 * @param index 命中起点。
 */
function vetoStateHit(word: string, text: string, index: number): boolean {
  if (!word.endsWith('困')) return false
  const next = text.charAt(index + word.length)
  return next !== '' && STATE_CONTINUATION.includes(next)
}

/**
 * 收集正则命中（合并连续片段，例如 `82` 只算一次）。
 * @param text 文本。
 * @param pattern 全局正则（调用方负责 `g`）。
 * @param kind 种类。
 */
function collectPattern(text: string, pattern: RegExp, kind: GuardKind): GuardHit[] {
  const hits: GuardHit[] = []
  // 每次调用都重置 lastIndex：正则对象是模块级常量，带 `g` 就有状态，
  // 不重置会让第二次调用从上次的位置继续扫，漏掉前半段。
  pattern.lastIndex = 0
  let match = pattern.exec(text)
  while (match !== null) {
    hits.push({ kind, text: match[0], index: match.index })
    if (match[0].length === 0) pattern.lastIndex += 1
    match = pattern.exec(text)
  }
  return hits
}

/**
 * 收集词表命中。
 *
 * 中文词直接 `indexOf` 循环（要拿到**每一处**，不是第一处）；
 * 英文词用带 `\b` 的正则，避免 `mood` 命中 `moody`、`soft` 命中 `softly`。
 *
 * `veto` 是给中文词赔的一个小小词边界（见 `vetoStateHit`）。
 * @param text 文本。
 * @param words 词表。
 * @param kind 种类。
 * @param veto 命中后是否否决。
 */
function collectWords(
  text: string,
  words: readonly string[],
  kind: GuardKind,
  veto?: (word: string, text: string, index: number) => boolean,
): GuardHit[] {
  const hits: GuardHit[] = []
  for (const word of words) {
    if (isAsciiWord(word)) {
      const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi')
      let match = pattern.exec(text)
      while (match !== null) {
        hits.push({ kind, text: match[0], index: match.index })
        match = pattern.exec(text)
      }
      continue
    }
    let from = 0
    while (from <= text.length) {
      const index = text.indexOf(word, from)
      if (index < 0) break
      if (veto === undefined || !veto(word, text, index)) {
        hits.push({ kind, text: word, index })
      }
      from = index + word.length
    }
  }
  return hits
}

/**
 * 扫一段文本。
 * @param text 待检文本。
 */
export function guardText(text: string): GuardReport {
  const source = typeof text === 'string' ? text : ''
  const hits: GuardHit[] = [
    ...collectPattern(source, DIGIT_PATTERN, 'digit'),
    ...collectPattern(source, PERCENT_PATTERN, 'percent'),
    ...collectWords(source, AXIS_WORDS, 'axis'),
    ...collectWords(source, STATE_WORDS, 'state', vetoStateHit),
    ...collectWords(source, HORMONE_WORDS, 'hormone'),
  ].sort((left, right) => left.index - right.index)

  const counts = emptyCounts()
  for (const hit of hits) counts[hit.kind] += 1

  return Object.freeze({
    pass: hits.length === 0,
    hits: Object.freeze(hits),
    counts: Object.freeze(counts),
  })
}
