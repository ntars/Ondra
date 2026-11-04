/**
 * 文本工具：**分句**、n-gram、字面抽取、尾部裁剪。
 *
 * 这一层是整条链的地基，所以它只做纯函数、不碰 ctx、不读配置。
 *
 * ## 分句为什么这么讲究
 *
 * 九步里七步都是「删整句」。分错一次，就会出现两种事故：
 * - **切太细**（在逗号处切）：删掉「但是」这半句，剩下的句子读起来像另一个人写的；
 * - **切太粗**（整段一句）：删一句等于删一整段，过滤链退化成「要么全留要么全丢」。
 *
 * 所以这里只认**句末标点**（。！？!?… 与换行、分号），并在引号内**不切**
 * （引号里的句号不是这句话的结尾）——除非句号后面紧跟的就是收引号。
 *
 * ## 抽字面为什么不猜
 *
 * 硬红线与关系分寸都是**作者写的自然语言**（「不得说出『我是 AI』」）。
 * 想靠语义理解去判「这句话违反了哪条红线」，就是在插件里塞第二个模型。
 * 这里只抽两种**确定性**的东西：引号里的字面、禁止词后面的短语。
 * 抽不出来就这一步不命中——**漏拦只是语气偏，误判会把正常的话删掉**。
 */

/** 句末标点（会切开）。 */
const ENDERS = new Set(['。', '！', '？', '!', '?', '…', '\n', '；', ';'])

/** 开引号 / 开括号（只在同一对里计数）。 */
const OPENERS = new Set(['「', '『', '“', '（', '('])

/** 收引号 / 收括号。 */
const CLOSERS = new Set(['」', '』', '”', '）', ')'])

/** 一句（或一段）。 */
export interface Sentence {
  /** 原文（含它自己的标点）。 */
  readonly text: string
  /** 序号。 */
  readonly index: number
}

/**
 * 分句。
 *
 * 规则三条：
 * 1. 句末标点切开（`。！？!?…` 与换行、分号）；
 * 2. 引号 / 括号内不切——除非标点后紧跟收引号（那是「话说完」的样子）；
 * 3. 切开后把紧跟的收引号与空格并回前一句，避免出现「」单独成句。
 * @param text 正文。
 */
export function splitSentences(text: string): readonly Sentence[] {
  const out: Sentence[] = []
  let buffer = ''
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    buffer += char
    if (OPENERS.has(char)) {
      depth += 1
      continue
    }
    if (CLOSERS.has(char)) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (!ENDERS.has(char)) continue
    const next = index + 1 < text.length ? text[index + 1] : ''
    if (depth > 0 && !CLOSERS.has(next)) continue
    // 把紧跟的收引号与空白并回来。**收引号要同步减深度**：
    // 它被这里吃掉之后，外层循环不会再看到它，不减就会让此后整段都被当成「引号内」，
    // 于是再也不分句——过滤链退化成「要么全留要么全丢」，而且不报任何错。
    while (index + 1 < text.length && (CLOSERS.has(text[index + 1]) || text[index + 1] === ' ')) {
      index += 1
      buffer += text[index]
      if (CLOSERS.has(text[index])) depth = Math.max(0, depth - 1)
    }
    const piece = buffer.trim()
    if (piece.length > 0) out.push(Object.freeze({ text: piece, index: out.length }))
    buffer = ''
  }
  const tail = buffer.trim()
  if (tail.length > 0) out.push(Object.freeze({ text: tail, index: out.length }))
  return Object.freeze(out)
}

/**
 * 拼回一段。句子里已经带标点，所以**不加分隔符**。
 * @param sentences 句子正文。
 */
export function joinSentences(sentences: readonly string[]): string {
  return sentences.join('')
}

/**
 * n-gram 集合（按字符，先去掉标点与空白）。
 *
 * 中文没有词边界，按字符切是最稳的做法：`今天好累` 的 4-gram 是
 * `今天好累` 一个，而 `今天好累啊` 是 `今天好累` / `天好累啊` 两个——
 * 重合度自然落在「说了同一件事」上。
 * @param text 正文。
 * @param n 长度。
 */
export function ngramSet(text: string, n: number): ReadonlySet<string> {
  const clean = text.replace(/[\s，。！？!?、；;：:“”「」『』（）()…—－-]/g, '')
  const set = new Set<string>()
  if (n <= 0 || clean.length < n) return set
  for (let index = 0; index + n <= clean.length; index += 1) {
    set.add(clean.slice(index, index + n))
  }
  return set
}

/**
 * 重合度：`part` 里有多少比例出现在 `whole` 里。
 *
 * 用「被包含比例」而不是 Jaccard：一句 20 字的话与一段 200 字的话，
 * Jaccard 天生很低，但它可能整句都是复读。分母取 `part` 才是对的问题。
 * @param part 被比的一方。
 * @param whole 参照的一方。
 */
export function containment(part: ReadonlySet<string>, whole: ReadonlySet<string>): number {
  if (part.size === 0) return 0
  let hit = 0
  for (const gram of part) {
    if (whole.has(gram)) hit += 1
  }
  return hit / part.size
}

/**
 * 抽引号里的字面。
 *
 * 只认成对的引号，长度 2–20：一个字的引号（`『嗯』`）是举例，不是禁令。
 * @param text 作者写的约束原文。
 */
export function quotedLiterals(text: string): readonly string[] {
  const out: string[] = []
  const re = /[「『“"]([^」』”"]{2,20})[」』”"]/g
  let match = re.exec(text)
  while (match !== null) {
    const inner = match[1].trim()
    if (inner.length > 0) out.push(inner)
    match = re.exec(text)
  }
  return out
}

/**
 * 抽「不得 / 不许 / 禁止 / 不要 / 不能 / 严禁」后面的短语（2–12 字）。
 *
 * 这条抽取**故意很窄**：只取到标点为止，且限 12 字。取宽了会抽到
 * 「不得编造用户没说过的话」这种整句，然后拿整句去匹配正文——永远匹配不上，
 * 这一步就变成了一个看起来在工作、实际从不生效的假开关。
 * @param text 作者写的约束原文。
 */
export function phraseAfterBan(text: string): readonly string[] {
  const out: string[] = []
  const re = /(?:不得|不许|禁止|不要|不能|严禁|别再)([^，。；、！？\s]{2,12})/g
  let match = re.exec(text)
  while (match !== null) {
    const inner = match[1].trim()
    if (inner.length > 0) out.push(inner)
    match = re.exec(text)
  }
  return out
}

/**
 * 截一段给人看的样本（日志与报告用，**不参与改写**）。
 * @param text 原文。
 * @param max 上限。
 */
export function sampleOf(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}…`
}

/**
 * 从尾部按**整句**裁到上限内。
 *
 * 只有一种情况会切在句中：**第一句本身就超长**。那时没有「整句」可留，
 * 硬切是唯一选择，所以调用方必须能看到 `hardCut: true` 并把这件事报出去。
 * @param text 正文。
 * @param maxChars 上限。
 */
export function trimTail(text: string, maxChars: number): { text: string; hardCut: boolean } {
  if (text.length <= maxChars) return { text, hardCut: false }
  const sentences = splitSentences(text)
  if (sentences.length === 0) return { text: '', hardCut: false }
  const kept: string[] = []
  let used = 0
  for (const sentence of sentences) {
    if (used + sentence.text.length > maxChars) break
    kept.push(sentence.text)
    used += sentence.text.length
  }
  if (kept.length > 0) return { text: joinSentences(kept), hardCut: false }
  const head = sentences[0].text
  const cut = Math.max(0, maxChars - 1)
  return { text: `${head.slice(0, cut)}…`, hardCut: true }
}

/** 去首尾空白与零宽字符。 */
export function cleanText(text: string): string {
  return text.replace(/[\u200b-\u200f\ufeff]/g, '').trim()
}

/**
 * 摘掉句内的括号片段（旁白）。
 *
 * 为什么不按「整句」摘：`（低头看了一眼手机）我不累。` 在文本上就是**一句**
 * （括号后面没有标点），按整句摘会把「我不累」一起删掉。括号本身是成对的、
 * 自包含的，从中间拿掉它，剩下的句子仍然完整——这是全链唯一允许「句内动手」的地方，
 * 而且动的是**成对的括号**，不是任意切片。
 * @param text 正文。
 * @param shouldStrip 判定括号里的内容该不该摘。
 */
export function stripParentheticalSpans(
  text: string,
  shouldStrip: (inner: string) => boolean,
): { text: string; removed: number; samples: readonly string[] } {
  let out = ''
  const samples: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char !== '（' && char !== '(') {
      out += char
      index += 1
      continue
    }
    const close = char === '（' ? '）' : ')'
    let depth = 0
    let cursor = index
    while (cursor < text.length) {
      if (text[cursor] === char) depth += 1
      else if (text[cursor] === close) {
        depth -= 1
        if (depth === 0) break
      }
      cursor += 1
    }
    if (cursor >= text.length) {
      // 没闭合：原样留着。**不猜它到哪儿结束**——猜错会吃掉正文。
      out += text.slice(index)
      break
    }
    const inner = text.slice(index + 1, cursor)
    if (shouldStrip(inner)) {
      samples.push(inner.trim())
    } else {
      out += text.slice(index, cursor + 1)
    }
    index = cursor + 1
  }
  return { text: out, removed: samples.length, samples: Object.freeze(samples) }
}
