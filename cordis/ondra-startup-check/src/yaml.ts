/**
 * 补丁文件的 YAML **子集**解析器。
 *
 * ## 为什么不用 `yaml` / `js-yaml`
 *
 * 宿主的真实现（`desktop/vendor/include/src/index.ts`）用 `js-yaml` + 自定义
 * `!!js` 标签。本仓 82 个插件的 `peerDependencies` 里只有 `@ntars/cordis`，
 * 多声明一个依赖，宿主没带这个包时 `import` 在模块加载期就抛——整个插件连注册
 * 都做不到，比「自检少做一项」糟得多。
 *
 * ## 子集的边界是**可证的**，不是「大概够用」
 *
 * 全仓 82 个 `cordis.patch.yml` 去掉注释与空行后**只有一种形状**：
 *
 * ```
 * - insert:
 *     - id: ondra-xxx
 *       name: 'ondra-xxx'
 * ```
 *
 * 所以子集只需要：块序列、块映射、单行标量（裸 / 单引号 / 双引号）、注释。
 * 超出这个范围的一律**明确拒绝**并标 `unsupported`——不是猜一个近似值。
 * 拒绝清单：`!!` 标签、`&` 锚点、`*` 别名、`|` `>` 块标量、`{` `[` 流式集合、
 * `%` 指令、`@` 与反引号开头的保留字符、行内出现「标量后面还有更深缩进」。
 *
 * ## 为什么必须显式拒绝而不是「尽量解析」
 *
 * 第十项要回答「宿主会不会加载我」。若解析器对不认识的语法给出一个近似结果，
 * 自检就会说「能加载」而宿主说「不能」——那时人会开始怀疑自己没读懂手册
 * （纪律 153 的同族问题）。标 `unverifiable` 是唯一诚实的答案。
 */

import type { YamlResult } from './types.js'

/** 解析过程中的一行（已去掉缩进与行尾空白）。 */
interface Line {
  indent: number
  content: string
  no: number
}

/** 内部错误：带行号，可选标 unsupported。 */
class YamlError extends Error {
  readonly line: number
  readonly unsupported: boolean

  /**
   * @param message 说明。
   * @param line 行号（1 起）。
   * @param unsupported 是否属于「本子集不支持」而非「写错了」。
   */
  constructor(message: string, line: number, unsupported: boolean) {
    super(message)
    this.line = line
    this.unsupported = unsupported
  }
}

/** 光标。 */
interface Cursor {
  i: number
}

/**
 * 判断一行是不是序列项。
 * @param content 去缩进后的内容。
 */
function isSeqItem(content: string): boolean {
  return content === '-' || content.startsWith('- ')
}

/**
 * 在引号之外找第一个 `:`，且它后面是空白或行尾。
 * @param content 一行内容。
 * @returns 下标；找不到返回 `-1`。
 */
function findKeyColon(content: string): number {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ':' && (i + 1 === content.length || content[i + 1] === ' ')) return i
  }
  return -1
}

/**
 * 去掉引号之外的行内注释（` #` 起）。
 * @param text 一段文本。
 */
function stripInlineComment(text: string): string {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || text[i - 1] === ' ')) return text.slice(0, i).trimEnd()
  }
  return text
}

/** 标量解析结果。 */
type ScalarResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string; readonly unsupported: boolean }

/**
 * 解析一个单行标量。
 * @param raw 原始文本（已去行内注释）。
 */
function parseScalar(raw: string): ScalarResult {
  const text = raw.trim()
  if (text === '') return { ok: true, value: null }
  if (text === 'null' || text === '~') return { ok: true, value: null }
  if (text === 'true') return { ok: true, value: true }
  if (text === 'false') return { ok: true, value: false }

  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) {
      return { ok: false, reason: '单引号没有闭合', unsupported: false }
    }
    // YAML 的单引号转义是 `''`。
    return { ok: true, value: text.slice(1, -1).replaceAll("''", "'") }
  }

  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) {
      return { ok: false, reason: '双引号没有闭合', unsupported: false }
    }
    const inner = text.slice(1, -1)
    const unescaped = inner.replace(/\\(["\\/nrt])/g, (_match, ch: string) => {
      switch (ch) {
        case 'n':
          return '\n'
        case 'r':
          return '\r'
        case 't':
          return '\t'
        default:
          return ch
      }
    })
    return { ok: true, value: unescaped }
  }

  // 本子集不支持的写法：明确拒绝，不猜。
  if (text.startsWith('!!') || text.startsWith('!')) {
    return { ok: false, reason: '`!!js` 之类的标签不在子集内', unsupported: true }
  }
  if (text.startsWith('&')) return { ok: false, reason: '锚点 `&` 不在子集内', unsupported: true }
  if (text.startsWith('*')) return { ok: false, reason: '别名 `*` 不在子集内', unsupported: true }
  if (text.startsWith('|') || text.startsWith('>')) {
    return { ok: false, reason: '块标量 `|` / `>` 不在子集内', unsupported: true }
  }
  if (text.startsWith('{') || text.startsWith('[')) {
    return { ok: false, reason: '流式集合 `{}` / `[]` 不在子集内', unsupported: true }
  }
  if (text.startsWith('%')) return { ok: false, reason: '指令 `%` 不在子集内', unsupported: true }
  if (text.startsWith('@') || text.startsWith('`')) {
    return { ok: false, reason: '保留字符开头不在子集内', unsupported: true }
  }

  if (/^-?\d+$/.test(text)) return { ok: true, value: Number.parseInt(text, 10) }
  if (/^-?\d+\.\d+$/.test(text)) return { ok: true, value: Number.parseFloat(text) }
  return { ok: true, value: text }
}

/**
 * 解析一个块（映射或序列）。
 * @param lines 全部行。
 * @param cursor 光标。
 * @param indent 本块缩进。
 */
function parseBlock(lines: readonly Line[], cursor: Cursor, indent: number): unknown {
  const line = lines[cursor.i]
  if (line === undefined) throw new YamlError('文件意外结束', 0, false)
  if (line.indent !== indent) {
    throw new YamlError(`缩进不一致（期望 ${indent}，实际 ${line.indent}）`, line.no, false)
  }
  return isSeqItem(line.content) ? parseSeq(lines, cursor, indent) : parseMap(lines, cursor, indent)
}

/**
 * 解析序列。
 * @param lines 全部行。
 * @param cursor 光标。
 * @param indent 本块缩进。
 */
function parseSeq(lines: readonly Line[], cursor: Cursor, indent: number): unknown[] {
  const out: unknown[] = []
  while (cursor.i < lines.length) {
    const line = lines[cursor.i]
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new YamlError(`序列项缩进不一致（${line.indent} > ${indent}）`, line.no, false)
    }
    if (!isSeqItem(line.content)) break

    const after = line.content.slice(1)
    const trimmed = after.trimStart()
    if (trimmed === '') {
      // `-` 后面换行：子块在下一行（缩进必须更深）。
      cursor.i += 1
      const child = lines[cursor.i]
      if (child === undefined || child.indent <= indent) {
        out.push(null)
        continue
      }
      out.push(parseBlock(lines, cursor, child.indent))
      continue
    }

    // 把 `- xxx` 就地改写成 `xxx`，缩进取 xxx 的真实列位，然后按块解析。
    // 这样 `- insert:` 与 `- id: x` 走同一条路径，不需要两套逻辑。
    // 列位 = 本级缩进 + `-` 本身 1 列 + `-` 与内容之间的空格数。
    const restIndent = indent + 1 + (after.length - trimmed.length)
    if (isSeqItem(trimmed)) {
      // 行源是只读的：改写放在副本上，子块解析在副本内推进光标，行为与就地改写一致。
      const rewritten = lines.slice()
      rewritten[cursor.i] = { indent: restIndent, content: trimmed, no: line.no }
      out.push(parseBlock(rewritten, cursor, restIndent))
      continue
    }
    if (findKeyColon(trimmed) >= 0) {
      const rewritten = lines.slice()
      rewritten[cursor.i] = { indent: restIndent, content: trimmed, no: line.no }
      out.push(parseBlock(rewritten, cursor, restIndent))
      continue
    }
    // 纯标量项。
    const scalar = parseScalar(stripInlineComment(trimmed))
    if (!scalar.ok) throw new YamlError(scalar.reason, line.no, scalar.unsupported)
    out.push(scalar.value)
    cursor.i += 1
  }
  return out
}

/**
 * 解析映射。
 * @param lines 全部行。
 * @param cursor 光标。
 * @param indent 本块缩进。
 */
function parseMap(lines: readonly Line[], cursor: Cursor, indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  while (cursor.i < lines.length) {
    const line = lines[cursor.i]
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw new YamlError(`缩进不一致（${line.indent} > ${indent}）`, line.no, false)
    }
    if (isSeqItem(line.content)) break

    const colon = findKeyColon(line.content)
    if (colon < 0) throw new YamlError('不是 `key: value` 形状', line.no, false)
    const key = line.content.slice(0, colon).trim()
    if (key === '') throw new YamlError('键名是空的', line.no, false)
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new YamlError(`重复键「${key}」`, line.no, false)
    }
    const rest = stripInlineComment(line.content.slice(colon + 1).trim())
    cursor.i += 1

    if (rest === '') {
      const child = lines[cursor.i]
      if (child !== undefined && child.indent > indent) {
        out[key] = parseBlock(lines, cursor, child.indent)
      } else {
        out[key] = null
      }
      continue
    }

    const scalar = parseScalar(rest)
    if (!scalar.ok) throw new YamlError(scalar.reason, line.no, scalar.unsupported)
    out[key] = scalar.value
    const child = lines[cursor.i]
    if (child !== undefined && child.indent > indent) {
      throw new YamlError('标量后面出现了更深缩进的行（本子集不支持多行标量）', child.no, true)
    }
  }
  return out
}

/**
 * 解析补丁文件的 YAML 子集。
 * @param text 全文。
 * @returns 解析结果。
 */
export function parseYamlSubset(text: string): YamlResult {
  const rawLines = text.split('\n')
  const lines: Line[] = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index].replace(/\r$/, '')
    if (raw.trim() === '') continue
    if (raw.trimStart().startsWith('#')) continue
    const indentMatch = /^[ ]*/.exec(raw)
    const indent = indentMatch === null ? 0 : indentMatch[0].length
    const content = raw.slice(indent).trimEnd()
    if (content.startsWith('\t')) {
      return { ok: false, reason: '缩进里用了制表符（YAML 不允许）', line: index + 1, unsupported: false }
    }
    lines.push({ indent, content, no: index + 1 })
  }

  if (lines.length === 0) return { ok: true, value: null }

  const cursor: Cursor = { i: 0 }
  try {
    const first = lines[0]
    const value = parseBlock(lines, cursor, first.indent)
    if (cursor.i < lines.length) {
      const rest = lines[cursor.i]
      throw new YamlError(`还有没解析完的行（缩进 ${rest.indent}）`, rest.no, false)
    }
    return { ok: true, value }
  } catch (error) {
    if (error instanceof YamlError) {
      return { ok: false, reason: error.message, line: error.line, unsupported: error.unsupported }
    }
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      line: 0,
      unsupported: false,
    }
  }
}
