/**
 * 可朗读净化：把「写给人看的一段」变成「念出来不奇怪的一段」。
 *
 * ## 边界：这一步**只删东西，不改写**
 *
 * 手册 §2.7 的原话是「每条回复先改写成自然口语再朗读（剥离代码/表格/Markdown）」。
 * 其中**改写**（加语气词、拆长句、补省略）归 O-041 `ondra-oral`；
 * 本插件只保留**剥离**这一步，且理由不是风格而是事故：
 * 把一段 `const a = 1` 或一张 Markdown 表格念出来，不是「不够口语」，
 * 是「她在念一段没人听得懂的东西」。
 *
 * 所以这里刻意**不做**的四件事：
 * 1. 不加语气词、不改句序（那是改写，归 O-041）；
 * 2. 不删「（伸了个懒腰）」这类动作描写（归 O-041 的动作语域）；
 * 3. 不补标点（句界判定归 O-036）；
 * 4. 不截断（超过字数上限由 `service.ts` 直接拒绝，截断会念半句）。
 *
 * ## 为什么剥离顺序是固定的
 *
 * 围栏代码块必须最先剥：它内部可能含 `|`（表格）、`http://`（网址）、
 * `` ` ``（行内代码）。先剥表格会让代码块里的管道符留下一堆残行，
 * 后面再怎么清都清不干净。
 */

/** 围栏代码块（成对的三个反引号，含语言标注）。 */
const FENCE = /```[\s\S]*?```/g

/** 表格行（以 `|` 起头）。 */
const TABLE_ROW = /^[ \t]*\|.*$/gm

/** 行内代码。 */
const INLINE_CODE = /`[^`\n]*`/g

/** HTML 标签（`<br>` / `<b>` 这类）。 */
const HTML_TAG = /<\/?[a-zA-Z][^>\n]*>/g

/** 裸链接。中文里链接后面常跟全角标点，不算进链接。 */
const URL_PATTERN = /https?:\/\/[^\s）)」】》]+/g

/** 行首的块级标记：标题 / 引用 / 列表序号。 */
const BLOCK_MARK = /^[ \t]{0,3}(?:#{1,6}[ \t]*|>[ \t]?|[-*+][ \t]+|\d{1,3}[.)][ \t]+)/gm

/** 成对的强调标记。单个 `*` / `_` 刻意不动：它可能是算式的一部分。 */
const EMPHASIS = /\*\*|__|~~/g

/** 零宽字符（模型偶尔吐出来，念的时候没有声音，但会让字数判定偏）。 */
const ZERO_WIDTH = /[\u200b-\u200f\ufeff]/g

/** 行内连续空白。 */
const INLINE_SPACES = /[ \t]+/g

/** 连续空行。 */
const BLANK_LINES = /\n{2,}/g

/** 标点与符号（用来判「净化完是不是什么都不剩」）。 */
const PUNCT_ONLY = /[\p{P}\p{S}\s]/gu

/**
 * 净化一段文本。
 *
 * **永不抛错**：任何输入都返回字符串，净化到空就返回空串（由调用方判 `empty`）。
 * @param text 原文。
 * @returns 可朗读的文本（可能为空串）。
 */
export function speakable(text: unknown): string {
  if (typeof text !== 'string') return ''
  let body = text
  if (body === '') return ''

  body = body.replace(FENCE, '')
  // 剩下的 ``` 是「没闭合的代码块」：从它开始到结尾都不该念。
  // 不这样处理，一个漏写的结束标记会让她把整段源码念完。
  const unclosed = body.indexOf('```')
  if (unclosed >= 0) body = body.slice(0, unclosed)

  body = body.replace(TABLE_ROW, '')
  body = body.replace(INLINE_CODE, '')
  body = body.replace(HTML_TAG, '')
  body = body.replace(URL_PATTERN, '')
  body = body.replace(BLOCK_MARK, '')
  body = body.replace(EMPHASIS, '')
  body = body.replace(ZERO_WIDTH, '')
  body = body.replace(INLINE_SPACES, ' ')
  body = body.replace(BLANK_LINES, '\n')

  // 逐行去首尾空白，再拼回去：块级标记被剥掉以后，行首会留下一个空格，
  // 那个空格会被 `say` 念成一个停顿，听起来像她突然卡了一下。
  const lines = body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  body = lines.join('\n').trim()

  if (body === '') return ''
  // 只剩标点与符号（例如一整行「……」或一串 emoji）时也算空：
  // 让它进引擎的后果是合成出一段 0.3 秒的气音，比什么都不做更奇怪。
  if (body.replace(PUNCT_ONLY, '') === '') return ''
  return body
}

/**
 * 按「字」数长度（不按 UTF-16 码元）。
 *
 * 中文一个字就是一个字；用 `String.length` 数 emoji 会得到 2，
 * 于是「看起来 12 个字」的一句话会被判成 14 个字而超限。
 * @param text 文本。
 */
export function charCount(text: string): number {
  return Array.from(text).length
}
