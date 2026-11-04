/**
 * 补丁文件的 YAML **子集**解析器（O-133 自带一份，刻意不复用 O-077 的实现）。
 *
 * ## 为什么要自带一份
 *
 * 台账写得很明确：「移植 `parsePatchYaml / applyEntryPatches / composeEntries`」。
 * 而 §15.5「禁止同轮互相 import」与 §15.6「全仓只允许 channel-kit 做类型消费」
 * 两条合起来，意味着 O-077 里那份**已经写好**的移植版本包不能 `import`——
 * 一旦 `import`，卸载 O-077 就会让本包编译失败。
 *
 * 所以这是**同一份语义的第二份实现**，不是「忘了复用」。代价写在 README
 * 「已知限制 1」：两边要一起改。真源是 `desktop/vendor/include/src/index.ts`
 * 的 `applyEntryPatches`，不是 O-077 也不是本包。
 *
 * ## 为什么不用 `yaml` / `js-yaml`
 *
 * 宿主的真实现用 `js-yaml` + 自定义 `!!js` 标签。本仓插件的 `peerDependencies` 只有
 * `@ntars/cordis`，多声明一个依赖，宿主没带这个包时 `import` 在模块加载期就抛——
 * 整个插件连注册都做不到，比「自检少做一项」糟得多。
 *
 * ## 子集边界是**可证**的
 *
 * 全仓 105 个 `cordis.patch.yml` 去掉注释与空行后只有一种形状：
 *
 * ```
 * - insert:
 *     - id: ondra-xxx
 *       name: 'ondra-xxx'
 * ```
 *
 * 所以子集只需要：块序列、块映射、单行标量（裸 / 单引号 / 双引号）、注释。
 * 超出的**明确拒绝**并标 `unsupported`——不猜近似值。理由：本包要回答
 * 「宿主会不会加载它」，若解析器给出近似结果，报告会说「能装」而宿主说「不能」，
 * 那时人会开始怀疑自己没读懂手册。标 `unverifiable` 是唯一诚实的答案。
 *
 * 拒绝清单：`!!` 标签、`&` 锚点、`*` 别名、`|` `>` 块标量、**非空**流式集合、
 * `%` 指令、`@` 与反引号开头的保留字符、行内「标量后面还有更深缩进」。
 *
 * **例外**：空的 `[]` 与 `{}` 放行。它们没有歧义（一个字符确定整个值），
 * 而 `config: []` 是「先建空组、等别的层往里 insert」的自然写法；
 * 不放行会把一份完全合法的补丁判成 `unverifiable`，那是把工具的边界当成用户的错。
 */

import type { Row } from './types.js'

/** 解析结果。 */
export type YamlOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly line: number; readonly reason: string; readonly unsupported: boolean }

/** 解析过程中的一行。 */
interface Line {
  readonly indent: number
  readonly content: string
  readonly no: number
}

/** 内部错误（带行号与「是否属于不支持」）。 */
class SubsetError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly unsupported: boolean,
  ) {
    super(message)
    this.name = 'SubsetError'
  }
}

/**
 * 判断一行是不是序列项。
 * @param content 去缩进后的内容。
 */
function isSeqItem(content: string): boolean {
  return content === '-' || content.startsWith('- ')
}

/**
 * 在引号之外找第一个「键冒号」（后面必须是空白或行尾）。
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
 * 去掉行尾注释（引号内的 `#` 不算）。
 * @param content 一行内容。
 */
function stripComment(content: string): string {
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
    if (ch === '#' && (i === 0 || content[i - 1] === ' ' || content[i - 1] === '\t')) {
      return content.slice(0, i).trimEnd()
    }
  }
  return content
}

/**
 * 把标量文本转成值：裸 / 单引号 / 双引号；`true` / `false` / `null` / 数字；
 * 以及**空集合字面量** `[]` 与 `{}`。
 *
 * ## 为什么单独放行 `[]` 与 `{}`
 *
 * 流式集合整体不在子集内（`{id: x}` 这种要正确处理嵌套与引号，成本远超收益）。
 * 但**空**的 `[]` / `{}` 没有歧义：一个字符确定整个值，解析器不需要理解流式语法
 * 就能得到正确答案。而 `config: []` 是写「空组」时的自然写法（`group: true` 后面
 * 常跟一个空列表等着被别的层 insert），不放行会让一份完全合法的补丁被判
 * `unverifiable`——那是把工具的边界当成了用户的错。
 * @param raw 标量原文。
 * @param line 行号（报错用）。
 */
function parseScalar(raw: string, line: number): unknown {
  const text = raw.trim()
  if (text === '') return null

  const head = text[0]

  // 空集合字面量：放行（见上）。
  if (text === '[]') return []
  if (text === '{}') return {}

  // 其余流式集合、块标量、锚点别名标签指令：明确拒绝。
  if (head === '{' || head === '[') {
    throw new SubsetError('非空的流式集合 `{…}` / `[…]` 不在本包 YAML 子集内（空的 `[]` / `{}` 可以）', line, true)
  }
  if (head === '|' || head === '>') {
    throw new SubsetError('块标量 `|` / `>` 不在本包 YAML 子集内', line, true)
  }
  if (head === '&') throw new SubsetError('锚点 `&` 不在本包 YAML 子集内', line, true)
  if (head === '*') throw new SubsetError('别名 `*` 不在本包 YAML 子集内', line, true)
  if (head === '!') throw new SubsetError('标签 `!` 不在本包 YAML 子集内', line, true)
  if (head === '%') throw new SubsetError('指令 `%` 不在本包 YAML 子集内', line, true)
  if (head === '@' || head === '`') {
    throw new SubsetError('`@` / 反引号开头是 YAML 保留字符', line, true)
  }

  if (head === '"' || head === "'") {
    if (text.length < 2 || text[text.length - 1] !== head) {
      throw new SubsetError('引号没有闭合（多行标量不在子集内）', line, false)
    }
    const inner = text.slice(1, -1)
    if (head === "'") {
      // 单引号里只有 '' 转义。
      return inner.replaceAll("''", "'")
    }
    // 双引号里只处理最常见的四种转义，其余原样保留（宁可多留一个反斜杠也不猜）。
    return inner
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
  }

  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  // 数字：只在能完整转成有限数时转换，其余一律当字符串（避免把 `08` 变成 8）。
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const num = Number(text)
    if (Number.isFinite(num)) return num
  }
  return text
}

/**
 * 解析块结构。
 * @param lines 已预处理的行。
 * @param start 起始下标。
 * @param indent 当前缩进。
 * @param cursor 光标。
 */
function parseBlock(lines: readonly Line[], start: number, indent: number, cursor: { i: number }): unknown {
  if (start >= lines.length) return null
  const first = lines[start]
  const seq = isSeqItem(first.content)

  if (seq) {
    const out: unknown[] = []
    let i = start
    while (i < lines.length) {
      const line = lines[i]
      if (line.indent < indent) break
      if (line.indent > indent) {
        throw new SubsetError('序列项的缩进比上一项更深，缺上级键', line.no, false)
      }
      if (!isSeqItem(line.content)) break
      const rest = line.content === '-' ? '' : line.content.slice(2).trim()

      if (rest === '') {
        // `- ` 后面没内容：值在下一行的更深缩进里。
        const next = lines[i + 1]
        if (next === undefined || next.indent <= indent) {
          out.push(null)
          i += 1
          continue
        }
        cursor.i = i + 1
        const value = parseBlock(lines, i + 1, next.indent, cursor)
        out.push(value)
        i = cursor.i
        continue
      }

      // `- key: value` 或 `- key:`（映射起点，后续同缩进行的键要并进来）。
      const colon = findKeyColon(rest)
      if (colon >= 0) {
        const key = rest.slice(0, colon).trim()
        const after = rest.slice(colon + 1).trim()
        // 这一项自成一张映射：先解析本行，再看后续「比序列项缩进更深」的行。
        const itemIndent = indent + 2
        const map: Record<string, unknown> = {}
        if (after === '') {
          const next = lines[i + 1]
          if (next !== undefined && next.indent > itemIndent) {
            cursor.i = i + 1
            map[key] = parseBlock(lines, i + 1, next.indent, cursor)
            i = cursor.i
          } else if (next !== undefined && next.indent === itemIndent && isSeqItem(next.content)) {
            cursor.i = i + 1
            map[key] = parseBlock(lines, i + 1, itemIndent, cursor)
            i = cursor.i
          } else {
            map[key] = null
            i += 1
          }
        } else {
          map[key] = parseScalar(after, line.no)
          i += 1
        }
        // 继续吃同一缩进层级（`itemIndent`）上属于这张映射的键。
        while (i < lines.length) {
          const next = lines[i]
          if (next.indent < itemIndent) break
          if (next.indent > itemIndent) {
            throw new SubsetError('映射项的缩进比上一项更深，缺上级键', next.no, false)
          }
          if (isSeqItem(next.content)) break
          const c2 = findKeyColon(next.content)
          if (c2 < 0) throw new SubsetError('这一行既不是键值也不是序列项', next.no, false)
          const k2 = next.content.slice(0, c2).trim()
          const v2 = next.content.slice(c2 + 1).trim()
          if (v2 === '') {
            const deeper = lines[i + 1]
            if (deeper !== undefined && deeper.indent > itemIndent) {
              cursor.i = i + 1
              map[k2] = parseBlock(lines, i + 1, deeper.indent, cursor)
              i = cursor.i
            } else if (deeper !== undefined && deeper.indent === itemIndent && isSeqItem(deeper.content)) {
              cursor.i = i + 1
              map[k2] = parseBlock(lines, i + 1, itemIndent, cursor)
              i = cursor.i
            } else {
              map[k2] = null
              i += 1
            }
          } else {
            map[k2] = parseScalar(v2, next.no)
            i += 1
          }
        }
        out.push(map)
        continue
      }

      // `- 纯标量`
      out.push(parseScalar(rest, line.no))
      i += 1
    }
    cursor.i = i
    return out
  }

  // 块映射。
  const map: Record<string, unknown> = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) throw new SubsetError('映射项的缩进比上一项更深，缺上级键', line.no, false)
    if (isSeqItem(line.content)) break
    const colon = findKeyColon(line.content)
    if (colon < 0) throw new SubsetError('这一行既不是键值也不是序列项', line.no, false)
    const key = line.content.slice(0, colon).trim()
    const rest = line.content.slice(colon + 1).trim()
    if (rest === '') {
      const next = lines[i + 1]
      if (next !== undefined && next.indent > indent) {
        cursor.i = i + 1
        map[key] = parseBlock(lines, i + 1, next.indent, cursor)
        i = cursor.i
      } else if (next !== undefined && next.indent === indent && isSeqItem(next.content)) {
        cursor.i = i + 1
        map[key] = parseBlock(lines, i + 1, indent, cursor)
        i = cursor.i
      } else {
        map[key] = null
        i += 1
      }
    } else {
      map[key] = parseScalar(rest, line.no)
      i += 1
    }
  }
  cursor.i = i
  return map
}

/**
 * 解析补丁文件的 YAML 子集。
 * @param text 文件全文。
 */
export function parsePatchYaml(text: string): YamlOutcome {
  const lines: Line[] = []
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  for (let i = 0; i < raw.length; i += 1) {
    const no = i + 1
    const original = raw[i]
    // 制表符缩进在 YAML 里非法，且极难看出：直接拒绝。
    if (original.startsWith('\t')) {
      return { ok: false, line: no, reason: '缩进用了制表符（YAML 只认空格）', unsupported: false }
    }
    const noComment = stripComment(original)
    if (noComment.trim() === '') continue
    if (noComment.trim() === '---' || noComment.trim() === '...') continue
    const indent = noComment.length - noComment.trimStart().length
    lines.push({ indent, content: noComment.trimStart().trimEnd(), no })
  }

  if (lines.length === 0) return { ok: true, value: [] }

  try {
    const value = parseBlock(lines, 0, lines[0].indent, { i: 0 })
    return { ok: true, value }
  } catch (error) {
    if (error instanceof SubsetError) {
      return { ok: false, line: error.line, reason: error.message, unsupported: error.unsupported }
    }
    return { ok: false, line: 1, reason: String(error), unsupported: false }
  }
}

/**
 * 判一个值是不是普通对象（补丁行必须是普通对象）。
 * @param value 值。
 */
export function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
