/**
 * 分条的**纯文本处理**：切句 → 拆超长句 → 装箱 → 套条数上限。
 *
 * 四步顺序不能换：
 *
 * 1. **先切句**：只在 `。！？…；` 与换行处断，断完把紧跟的收尾引号/括号带上
 *    （`「走吧。」` 的 `」` 必须跟着走，否则下一条会以 `」` 开头）。
 * 2. **再拆超长句**：一句话 60 字，40 字上限下必须拆。先找 `，、；：`，
 *    找不到才硬切——**硬切是最后手段**，因为中文没有词边界，硬切会切在词中间。
 * 3. **再装箱**：短句往一条里并，并到装不下为止。这一步决定「像不像连发」。
 * 4. **最后套条数上限**：超过 4 条就「保留前 3 条 + 尾部全部合并成第 4 条」。
 *    合并后可能超过 40 字，**不截断**（见 `overflow`）。
 *
 * 第 4 步必须在第 3 步之后：先套上限再装箱，会把已经合并好的第 4 条又拆开，
 * 结果还是 5 条以上——上限形同虚设。
 */

import type { CapResult, SplitResult } from './types.js'

/** 句末标点。`…` 也算：聊天里「我……」本来就是一个停顿点。 */
const TERMINATORS = new Set(['。', '！', '？', '!', '?', '…', '；', ';'])

/** 收尾符号：紧跟在句末标点后面时要一起带走。 */
const CLOSERS = new Set(['」', '』', '”', '"', '’', '）', ')', '】', '》', '〉', '〕'])

/** 句中可停的标点（拆超长句时优先在这里断）。 */
const CLAUSE_MARKS = new Set(['，', '、', '；', '：', ',', ';', ':'])

/**
 * 数字数。**去空白**，按码点计（一个 emoji 算一个字，不算两个）。
 * @param text 正文。
 */
export function countChars(text: string): number {
  let n = 0
  for (const ch of text) {
    if (!/\s/.test(ch)) n += 1
  }
  return n
}

/**
 * 切句。返回的每一条都 `trim` 过，空句丢弃。
 * @param text 正文。
 */
export function splitSentences(text: string): readonly string[] {
  const chars = Array.from(text.replace(/\r\n?/g, '\n'))
  const out: string[] = []
  let buf = ''

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]

    if (ch === '\n') {
      const line = buf.trim()
      if (line !== '') out.push(line)
      buf = ''
      continue
    }

    buf += ch
    if (!TERMINATORS.has(ch)) continue

    // 吃掉连续标点：「！？」是两个语气，「……」是四个点。
    while (i + 1 < chars.length && TERMINATORS.has(chars[i + 1])) {
      i += 1
      buf += chars[i]
    }
    // 吃掉收尾引号/括号，否则下一条会以它开头。
    while (i + 1 < chars.length && CLOSERS.has(chars[i + 1])) {
      i += 1
      buf += chars[i]
    }

    const sentence = buf.trim()
    if (sentence !== '') out.push(sentence)
    buf = ''
  }

  const tail = buf.trim()
  if (tail !== '') out.push(tail)
  return out
}

/**
 * 把一句超长的句子拆成若干 ≤ `cap` 字的片段。
 *
 * 优先在 `，、；：` 处断；一个片段仍然超长时才硬切。
 * @param sentence 一句话。
 * @param cap 单条上限。
 */
export function splitLong(sentence: string, cap: number): readonly string[] {
  const limit = Math.max(1, Math.floor(cap))
  if (countChars(sentence) <= limit) return [sentence]

  // 第一步：按句中标点切成小片（标点跟着前一片走）。
  const pieces: string[] = []
  let buf = ''
  for (const ch of sentence) {
    buf += ch
    if (CLAUSE_MARKS.has(ch)) {
      pieces.push(buf)
      buf = ''
    }
  }
  if (buf !== '') pieces.push(buf)

  // 第二步：仍然超长的片硬切。
  const out: string[] = []
  for (const piece of pieces) {
    if (countChars(piece) <= limit) {
      out.push(piece)
      continue
    }
    let chunk = ''
    let used = 0
    for (const ch of piece) {
      chunk += ch
      if (!/\s/.test(ch)) used += 1
      if (used >= limit) {
        out.push(chunk)
        chunk = ''
        used = 0
      }
    }
    if (chunk !== '') out.push(chunk)
  }
  return out
}

/**
 * 装箱：切句 → 拆超长 → 短句并进同一条。**不套条数上限**。
 * @param text 正文。
 * @param cap 单条上限。
 */
export function packMessages(text: string, cap: number): SplitResult {
  const limit = Math.max(1, Math.floor(cap))
  const units: string[] = []
  let innerSplits = 0

  for (const sentence of splitSentences(text)) {
    const parts = splitLong(sentence, limit)
    if (parts.length > 1) innerSplits += parts.length - 1
    for (const part of parts) units.push(part)
  }

  const messages: string[] = []
  let cur = ''
  for (const unit of units) {
    if (cur !== '' && countChars(cur) + countChars(unit) > limit) {
      messages.push(cur)
      cur = unit
      continue
    }
    cur += unit
  }
  if (cur !== '') messages.push(cur)

  return { messages, innerSplits }
}

/**
 * 套条数上限：保留前 `max-1` 条，其余**从尾部合并**成第 `max` 条。
 *
 * 合并后超过单条上限时不截断，只标 `overflow`——丢一句话比多发几个字严重得多。
 * @param messages 已装箱的消息。
 * @param max 条数上限（≤ 4）。
 * @param cap 单条上限（只用来判 overflow）。
 */
export function capMessages(messages: readonly string[], max: number, cap: number): CapResult {
  const limit = Math.max(1, Math.floor(max))
  if (messages.length <= limit) {
    return { messages: [...messages], mergedCount: 0, overflowCount: 0 }
  }

  const head = messages.slice(0, limit - 1)
  const tail = messages.slice(limit - 1).join('')
  const merged = [...head, tail]
  const overflowCount = countChars(tail) > cap ? 1 : 0

  return {
    messages: merged,
    mergedCount: messages.length - merged.length,
    overflowCount,
  }
}
