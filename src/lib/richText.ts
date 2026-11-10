/**
 * 消息正文的轻量 Markdown 解析。
 *
 * ## 为什么自己写，不用 `marked` / `remark`
 *
 * 三件事决定了这个选择：
 *
 * 1. **不能用 `innerHTML`。** 正文来自模型，模型输出里出现 `<img onerror=…>`
 *    是完全可能的。先转成 HTML 字符串再塞进 DOM，就必须自己写一遍消毒器，
 *    而消毒器是最容易漏的一类代码（漏一个标签就是远程代码执行）。
 *    这里解析成**数据结构**，由 React 逐个节点渲染——文本永远走文本节点，
 *    不进 HTML 解析器，注入面在结构上就不存在。
 * 2. **只需要七种块。** 正文只认代码块、
 *    行内代码、表格、图片、链接、引用、列表。`marked` 是 40KB 起步、
 *    覆盖整个 CommonMark，九成能力在这里用不到，却要跟着升级与审计。
 * 3. **行为要可控。** 聊天框不是文档编辑器：单换行保留成换行（用户和
 *    模型都这么写），而不是按 CommonMark 折成空格。第三方库要么不支持，
 *    要么得配一堆扩展，配出来的行为反而更难解释。
 *
 * ## 支持的范围（刻意收窄）
 *
 * | 块 | 语法 |
 * | --- | --- |
 * | 段落 | 空行分隔，段内单换行保留 |
 * | 标题 | `#` – `######`，只用于在正文里分小段 |
 * | 代码块 | 三反引号或三波浪线围栏，可带语言名 |
 * | 引用 | 行首 `>`，可嵌套 |
 * | 列表 | `-` / `*` / `+` 或 `1.` / `1)` |
 * | 表格 | GFM 管道表，带对齐行 |
 * | 分隔线 | 三个以上的 `-` / `*` / `_` |
 *
 * 行内：行内代码、`**粗**`、`*斜*`、`~~删~~`、`[文字](链接)`、`![说明](图片)`、反斜杠转义。
 *
 * **不支持**：缩进式代码块、HTML 片段、脚注、定义列表、任务列表。
 * 这些在模型回复里几乎不出现，加进来只会扩大解析面。
 */

/** 行内片段。 */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'image'; src: string; alt: string }

/** 表格列的对齐。 */
export type Align = 'left' | 'center' | 'right'

/** 块。 */
export type Block =
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'heading'; level: number; lines: Inline[][] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; body: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { kind: 'rule' }

/**
 * 引用嵌套上限。
 *
 * `> > > > …` 每层都要递归一次，输入由模型给出，不设上限等于给一个
 * 可以把栈打穿的入口。三层已经远超「引用一段话里的引用」的实际需要。
 */
const MAX_QUOTE_DEPTH = 3

/** 行内解析的递归上限，理由同上（`**a **b** c**` 这类嵌套）。 */
const MAX_INLINE_DEPTH = 6

/** 围栏代码块的起始行。 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/

/** 标题行。`#` 后必须有空格，`#话题` 不算标题。 */
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/

/** 分隔线。 */
const RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/

/** 无序列表项。 */
const BULLET = /^(\s*)([-*+])\s+(.*)$/

/** 有序列表项。`1.` 与 `1)` 都收。 */
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/

/** 表格的对齐行，如 `| :--- | ---: |`。 */
const TABLE_ALIGN = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/

/** 引用行。 */
const QUOTE = /^\s{0,3}>\s?(.*)$/

/**
 * 只放行这三种协议的链接。
 *
 * `javascript:` 与 `data:text/html` 是最常见的两条注入路径。界面上
 * 点击链接走壳的 opener，本来也不会执行脚本，但链接文本仍然会被渲染，
 * 留着一条 `javascript:` 的 href 迟早被某个未来代码路径当真。
 */
function safeHref(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  return /^(?:https?:\/\/|mailto:)/i.test(value) ? value : undefined
}

/**
 * 判断图片地址能否内联显示。
 *
 * ## 为什么远程图片不内联
 *
 * 应用的 CSP 是 `img-src 'self' data: asset: http://asset.localhost`——
 * 远程图片本来就加载不出来。可以给 CSP 加一条 `https:` 让它能显示，
 * 但代价是：模型输出里任何一个图片地址都会变成一次向外的请求，
 * 对方能从日志里读到这台机器的出口 IP 与打开时间。
 *
 * 一个本地优先、凭据不上云的陪伴应用，不该为了显示一张图把这条口子开了。
 * 远程图片因此渲染成一行可点的链接，交给系统浏览器——用户在浏览器里
 * 本来就带着自己的代理与隔离，知情且可控。
 */
export function imageSource(raw: string): { src: string; inline: boolean } | undefined {
  const value = raw.trim()
  if (/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) {
    return { src: value, inline: true }
  }
  const href = safeHref(value)
  if (href !== undefined && /^https?:\/\//i.test(href)) return { src: href, inline: false }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 行内
 * ------------------------------------------------------------------ */

/**
 * 解析一行里的行内片段。
 *
 * @param text 源文本（已去掉块级标记）。
 * @param depth 递归深度，超过 {@link MAX_INLINE_DEPTH} 时整段当纯文本。
 */
export function parseInline(text: string, depth = 0): Inline[] {
  if (text === '') return []
  if (depth > MAX_INLINE_DEPTH) return [{ kind: 'text', text }]

  const out: Inline[] = []
  let buffer = ''
  let index = 0

  const flush = (): void => {
    if (buffer === '') return
    out.push({ kind: 'text', text: buffer })
    buffer = ''
  }

  while (index < text.length) {
    const rest = text.slice(index)
    const char = text[index] ?? ''

    // 反斜杠转义：`\*` 输出一个星号，不再当强调符号。
    if (char === '\\' && index + 1 < text.length) {
      buffer += text[index + 1] ?? ''
      index += 2
      continue
    }

    // 行内代码优先于一切：代码里的星号与方括号都是字面量。
    if (char === '`') {
      const match = /^(`+)([\s\S]*?)\1/.exec(rest)
      if (match !== null && match[2] !== undefined) {
        flush()
        // 首尾各一个空格是 CommonMark 的「围栏内留白」写法，去掉更像代码。
        out.push({ kind: 'code', text: match[2].replace(/^ (.*) $/, '$1') })
        index += match[0].length
        continue
      }
    }

    // 图片必须在链接之前判，否则 `![]()` 会被当成 `!` + 链接。
    if (char === '!' && rest.startsWith('![')) {
      const match = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest)
      const src = match?.[2] === undefined ? undefined : imageSource(match[2])
      if (match !== null && src !== undefined) {
        flush()
        out.push({ kind: 'image', src: src.src, alt: match[1] ?? '' })
        index += match[0].length
        continue
      }
    }

    if (char === '[') {
      const match = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest)
      const href = match?.[2] === undefined ? undefined : safeHref(match[2])
      if (match !== null && href !== undefined) {
        flush()
        out.push({
          kind: 'link',
          href,
          children: parseInline(match[1] ?? '', depth + 1),
        })
        index += match[0].length
        continue
      }
    }

    // 加粗先于斜体：`**a**` 若先被斜体吃掉，会剩一对孤立的星号。
    if (rest.startsWith('**') || rest.startsWith('__')) {
      const marker = rest.slice(0, 2)
      const close = rest.indexOf(marker, 2)
      if (close > 2) {
        flush()
        out.push({
          kind: 'strong',
          children: parseInline(rest.slice(2, close), depth + 1),
        })
        index += close + 2
        continue
      }
    }

    if (char === '~' && rest.startsWith('~~')) {
      const close = rest.indexOf('~~', 2)
      if (close > 2) {
        flush()
        out.push({
          kind: 'del',
          children: parseInline(rest.slice(2, close), depth + 1),
        })
        index += close + 2
        continue
      }
    }

    if (char === '*' || char === '_') {
      const close = rest.indexOf(char, 1)
      // 单个字符不算强调，`a * b` 这种乘法式子要原样留着。
      if (close > 1) {
        flush()
        out.push({
          kind: 'em',
          children: parseInline(rest.slice(1, close), depth + 1),
        })
        index += close + 1
        continue
      }
    }

    buffer += char
    index += 1
  }

  flush()
  return out
}

/* ------------------------------------------------------------------ *
 * 块
 * ------------------------------------------------------------------ */

/** 一行是不是空行。 */
function isBlank(line: string): boolean {
  return line.trim() === ''
}

/**
 * 把一行按未转义的 `|` 切开。
 *
 * 表格单元格里写竖线要用 `\|` 转义——不认转义会把 `a\|b` 切成两格，
 * 而用户的本意是一格 `a|b`。
 */
function splitRow(line: string): string[] {
  const cells: string[] = []
  let buffer = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? ''
    if (char === '\\' && line[index + 1] === '|') {
      buffer += '|'
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(buffer)
      buffer = ''
      continue
    }
    buffer += char
  }
  cells.push(buffer)

  // 去掉两端竖线留下的空壳。只去两端，中间的空单元格是真实数据。
  if (cells.length > 1 && cells[0]?.trim() === '') cells.shift()
  if (cells.length > 1 && cells[cells.length - 1]?.trim() === '') cells.pop()
  return cells.map((cell) => cell.trim())
}

/** 这一行能不能当表格的分隔行。 */
function isAlignRow(line: string): boolean {
  return line.includes('-') && TABLE_ALIGN.test(line)
}

/** 从分隔行读出每列的对齐。 */
function readAlign(line: string): Align[] {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/**
 * 判断一行会不会开一个新的块。
 *
 * 段落收集到这个判据为止——否则「段落里正好有一行以 `-` 开头」会被
 * 吞进上一段，用户看到的是一段没有项目符号的列表。
 */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line)
    || HEADING.test(line)
    || RULE.test(line)
    || BULLET.test(line)
    || ORDERED.test(line)
    || QUOTE.test(line)
  )
}

/**
 * 解析整段正文。
 *
 * @param source 原始文本（模型回复或已存的消息内容）。
 * @returns 块序列。空输入返回空数组，调用方据此不渲染任何东西。
 */
export function parseMarkdown(source: string): Block[] {
  // 统一换行：Windows 剪贴板与部分模型输出会给 `\r\n`，留着会让
  // 每行末尾多一个不可见字符，后面所有正则都要跟着改。
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines, 0)
}

/** 解析一段行数组。引用块会带着内层内容递归进来。 */
function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (isBlank(line)) {
      index += 1
      continue
    }

    // --- 围栏代码块 ---
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[1] ?? '```'
      const lang = fence[2] ?? ''
      const body: string[] = []
      index += 1
      // 找同类的收尾围栏。没找到就吃到文末——未闭合的代码块在流式
      // 输出中途很常见，此时把剩下的字全当代码显示，比丢掉更好。
      while (index < lines.length) {
        const current = lines[index] ?? ''
        if (new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${String(marker.length)},}\\s*$`).test(current)) {
          index += 1
          break
        }
        body.push(current)
        index += 1
      }
      blocks.push({ kind: 'code', lang, text: body.join('\n') })
      continue
    }

    // --- 标题 ---
    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] ?? '#').length,
        lines: [parseInline((heading[2] ?? '').trim())],
      })
      index += 1
      continue
    }

    // --- 分隔线 ---
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    // --- 表格 ---
    if (line.includes('|') && index + 1 < lines.length && isAlignRow(lines[index + 1] ?? '')) {
      const head = splitRow(line).map((cell) => parseInline(cell))
      const align = readAlign(lines[index + 1] ?? '')
      index += 2
      const rows: Inline[][][] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        if (isBlank(current) || !current.includes('|')) break
        rows.push(splitRow(current).map((cell) => parseInline(cell)))
        index += 1
      }
      blocks.push({ kind: 'table', head, align, rows })
      continue
    }

    // --- 引用 ---
    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const matched = QUOTE.exec(current)
        if (matched === null) break
        inner.push(matched[1] ?? '')
        index += 1
      }
      // 到上限就不再往下递归，把内层当普通段落——总比不显示好。
      blocks.push({
        kind: 'quote',
        body: depth >= MAX_QUOTE_DEPTH
          ? [{ kind: 'paragraph', lines: inner.map((item) => parseInline(item)) }]
          : parseBlocks(inner, depth + 1),
      })
      continue
    }

    // --- 列表 ---
    const bullet = BULLET.exec(line)
    const ordered = ORDERED.exec(line)
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null
      const start = isOrdered ? Number(ordered[2] ?? '1') : 1
      const items: Inline[][] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        const nextBullet = BULLET.exec(current)
        const nextOrdered = ORDERED.exec(current)
        const marker = isOrdered ? nextOrdered : nextBullet
        if (marker === null) break
        const text = isOrdered ? (nextOrdered?.[3] ?? '') : (nextBullet?.[3] ?? '')
        items.push(parseInline(text))
        index += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, start, items })
      continue
    }

    // --- 段落 ---
    const paragraph: Inline[][] = []
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (isBlank(current)) break
      // 第一行之后遇到新的块起始行就收手，交给外层处理。
      if (paragraph.length > 0 && startsBlock(current)) break
      if (paragraph.length > 0 && current.includes('|') && isAlignRow(lines[index + 1] ?? '')) break
      paragraph.push(parseInline(current))
      index += 1
    }
    blocks.push({ kind: 'paragraph', lines: paragraph })
  }

  return blocks
}

/* ------------------------------------------------------------------ *
 * 纯文本
 * ------------------------------------------------------------------ */

/** 把行内片段还原成纯文本。 */
function inlineText(nodes: Inline[]): string {
  let text = ''
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
      case 'code':
        text += node.text
        break
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
        text += inlineText(node.children)
        break
      case 'image':
        // 图片在纯文本里退化成它的说明文字。`![]()` 什么都不留，
        // 与「复制下来发现多一行空括号」相比，丢掉更干净。
        text += node.alt
        break
    }
  }
  return text
}

/**
 * 把块序列还原成纯文本。
 *
 * ## 为什么需要它
 *
 * §5.4 对「复制」的要求是「复制纯文本，**不含 Markdown 记号**」。
 * 直接把源串写进剪贴板会把 `**`、`| --- |`、围栏反引号一起带出去，
 * 粘到别处就是一堆符号。
 *
 * @param blocks 解析结果。
 */
export function plainText(blocks: Block[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        parts.push(block.lines.map((line) => inlineText(line)).join('\n'))
        break
      case 'code':
        parts.push(block.text)
        break
      case 'quote':
        parts.push(plainText(block.body))
        break
      case 'list':
        block.items.forEach((item, order) => {
          const bullet = block.ordered ? `${String(block.start + order)}. ` : '· '
          parts.push(bullet + inlineText(item))
        })
        break
      case 'table':
        for (const row of [block.head, ...block.rows]) {
          parts.push(row.map((cell) => inlineText(cell)).join('\t'))
        }
        break
      case 'rule':
        break
    }
  }
  return parts.join('\n\n')
}
