/**
 * 按平台上限切条。**纯函数**：给同样的输入，永远同样的输出。
 *
 * ## 它不做什么
 *
 * 它**不做拟人分条**。手册 §9.2 的「单条上限 40 字、最多 4 条」是
 * `ondra-rhythm`（O-038）的事——那是「像人一样分几条」。
 * 本插件只管「平台允许一条多长」：telegram 4000、wechat-official 800、
 * qq-official 1200……
 *
 * 顺序必须是**先拟人、后平台**：先用 O-038 分成 4 条 40 字，
 * 每条再看要不要按平台上限继续切。反过来做，40 字的句子会被
 * 4000 字的上限「合并」回一整段，她的话就变成一大坨。
 *
 * ## 三条不变量（自检按这三条查）
 *
 * 1. **拼回等于原文**：`pieces.join('') === text`。绝不为了好看吞掉一个空格，
 *    也不补一个句号——补一个就等于替她说话。
 * 2. **每片 ≤ max，且不为空串**。唯一例外见第 3 条。
 * 3. **不切开代理对**：硬切时若末位是高位代理（emoji 的前半个），退一格把它留到下一片；
 *    只有当这一片只剩一个码元的余量（`max < 2`）时，宁可**多带一个码元**——
 *    半截 emoji 会被平台渲染成 `?` 或直接拒收，而超一个字符最坏只是被截。
 */

import type { ChunkResult } from './types.js'

/** 句末：切这里最自然。`\n` 也算——换行本来就是断句。 */
const SENTENCE_ENDERS = '。！？!?…\n'

/** 句内：找不到句末才用。空格在列，因为英文靠它断词。 */
const CLAUSE_ENDERS = '，、；：,;: '

/** 句末之后可以顺带带走的收尾符号。不带的话，下一片会以「」开头。 */
const CLOSERS = ['”', '’', '）', ')', '」', '』', '】', '》', '"', "'"] as const

/**
 * 是不是高位代理（UTF-16 里 emoji 的前半个）。
 * @param code 码元。
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * 在窗口内找一个断点。
 * @param text 原文。
 * @param from 本片起点。
 * @param to 本片允许的终点（不含）。
 * @returns 断点位置（片 = `text.slice(from, cut)`）；找不到返回 0。
 */
function findCut(text: string, from: number, to: number): number {
  // 第一遍：句末，从后往前找（让每片尽量装满）。
  for (let i = to; i > from; i -= 1) {
    if (SENTENCE_ENDERS.includes(text[i - 1])) {
      let cut = i
      while (cut < to && (CLOSERS as readonly string[]).includes(text[cut])) cut += 1
      return cut
    }
  }
  // 第二遍：句内标点。
  for (let i = to; i > from; i -= 1) {
    if (CLAUSE_ENDERS.includes(text[i - 1])) return i
  }
  return 0
}

/**
 * 切条。
 * @param text 正文。
 * @param max 平台单条上限（字符）。≤0 按 1 处理。
 */
export function chunkText(text: string, max: number): ChunkResult {
  const source = typeof text === 'string' ? text : ''
  const limit = Math.max(1, Math.trunc(Number.isFinite(max) ? max : 1))

  if (source === '') {
    return Object.freeze({
      pieces: Object.freeze([]) as readonly string[],
      chars: 0,
      max: limit,
      hardBreaks: 0,
      longest: 0,
    })
  }

  if (source.length <= limit) {
    return Object.freeze({
      pieces: Object.freeze([source]) as readonly string[],
      chars: source.length,
      max: limit,
      hardBreaks: 0,
      longest: source.length,
    })
  }

  const pieces: string[] = []
  let hardBreaks = 0
  let longest = 0
  let cursor = 0

  while (cursor < source.length) {
    const windowEnd = Math.min(cursor + limit, source.length)

    // 剩下的能装进最后一片。
    if (windowEnd === source.length) {
      const tail = source.slice(cursor)
      pieces.push(tail)
      if (tail.length > longest) longest = tail.length
      break
    }

    const cut = findCut(source, cursor, windowEnd)
    if (cut > cursor) {
      const piece = source.slice(cursor, cut)
      pieces.push(piece)
      if (piece.length > longest) longest = piece.length
      cursor = cut
      continue
    }

    // 硬切。绝不切开代理对。
    //
    // 两种收场，都很明确：
    // - 切点正好落在代理对中间，且前面还有余量 → 退一格，把这个 emoji 留到下一片；
    // - 本片只剩一个码元的余量（`max < 2`）→ 宁可让这一片多带一个码元，
    //   也不产出「半截 emoji」。超一个字符最坏是被平台截，而孤立的代理项
    //   在多数平台上直接拒收或渲染成 `?`。
    let hardEnd = windowEnd
    if (isHighSurrogate(source.charCodeAt(hardEnd - 1))) {
      hardEnd = hardEnd - 1 > cursor ? hardEnd - 1 : hardEnd + 1
    }
    if (hardEnd <= cursor) hardEnd = windowEnd
    const piece = source.slice(cursor, hardEnd)
    pieces.push(piece)
    if (piece.length > longest) longest = piece.length
    cursor = hardEnd
    hardBreaks += 1
  }

  return Object.freeze({
    pieces: Object.freeze(pieces) as readonly string[],
    chars: source.length,
    max: limit,
    hardBreaks,
    longest,
  })
}
