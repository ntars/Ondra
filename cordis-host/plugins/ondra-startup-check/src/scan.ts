/**
 * 源码扫描：把「服务键 / 依赖 / 越界 import / 判空」从 TS 文本里读出来。
 *
 * ## 为什么先「遮注释」而不是「删注释」
 *
 * 本仓的 `src/types.ts` 里大量出现 `ctx.get('ondra-memory-core')` 这类**注释里的示例**。
 * 直接 grep 会把它算成一条依赖，于是自检报出一个不存在的悬空键，人会去改一段本来
 * 正确的代码。所以扫描前必须遮掉注释。
 *
 * 遮法是**把注释字符换成等长空格**，不是删除：
 *
 * - 删掉会让后面的字符前移，行号与列位全错（纪律 144 就是这一族错误的另一面）；
 * - 换成等长空格后，正则的 `index` 与原文一一对应，行号还是原行号。
 *
 * 字符串**不遮**：服务键就写在字符串里（`ctx.provide('ondra-x')`）。
 *
 * ## 已知的假阳性
 *
 * 字符串里出现 `ctx.get(` 会被当成一次调用。本仓没有这种写法；若将来出现，
 * 结果只是多报一条依赖——**宁可多报也不漏报**（漏报的后果是悬空键进了交付）。
 */

import type { SourceFile } from './types.js'

/** 一行被遮过的源码。 */
export interface MaskedLine {
  /** 相对路径。 */
  readonly path: string
  /** 行号（1 起）。 */
  readonly no: number
  /** 原文（报错时给人看）。 */
  readonly raw: string
  /** 遮掉注释后的同行文本（长度与原文一致）。 */
  readonly masked: string
}

/**
 * 遮掉一段源码里的注释（等长替换）。
 * @param text 全文。
 * @returns 逐行结果（与原文行数一致）。
 */
export function maskComments(text: string): readonly string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let inBlock = false
  for (const line of lines) {
    let masked = ''
    let quote: '"' | "'" | '`' | null = null
    let i = 0
    while (i < line.length) {
      if (inBlock) {
        if (line.startsWith('*/', i)) {
          masked += '  '
          i += 2
          inBlock = false
          continue
        }
        masked += ' '
        i += 1
        continue
      }
      const ch = line[i]
      if (quote !== null) {
        masked += ch
        if (ch === '\\' && i + 1 < line.length) {
          masked += line[i + 1]
          i += 2
          continue
        }
        if (ch === quote) quote = null
        i += 1
        continue
      }
      if (line.startsWith('//', i)) {
        masked += ' '.repeat(line.length - i)
        i = line.length
        continue
      }
      if (line.startsWith('/*', i)) {
        masked += '  '
        i += 2
        inBlock = true
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
        masked += ch
        i += 1
        continue
      }
      masked += ch
      i += 1
    }
    out.push(masked)
  }
  return out
}

/**
 * 把一份源码遮成逐行结构。
 * @param file 源码。
 * @returns 逐行结构。
 */
export function maskFile(file: SourceFile): readonly MaskedLine[] {
  const masked = maskComments(file.text)
  const raw = file.text.split('\n')
  return masked.map((line, index) => ({
    path: file.path,
    no: index + 1,
    raw: raw[index] ?? '',
    masked: line,
  }))
}

/** 一个文件内的常量表（`const X = 'ondra-y'`）。 */
function constTable(lines: readonly MaskedLine[]): ReadonlyMap<string, string> {
  const table = new Map<string, string>()
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*['"]([^'"]+)['"]/g
  for (const line of lines) {
    re.lastIndex = 0
    for (let match = re.exec(line.masked); match !== null; match = re.exec(line.masked)) {
      table.set(match[1], match[2])
    }
  }
  return table
}

/**
 * 两个成员名的取值正则（**模块级只建一次**）。
 *
 * 每行都 `new RegExp` 的话，扫 82 个包要建几万个正则对象——不报错，只是慢，
 * 而慢下来的自检会被关掉。
 */
const ARG_RES: ReadonlyMap<string, RegExp> = new Map([
  ['get', /ctx\.get\(\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))/],
  ['provide', /ctx\.provide\(\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))/],
])

/**
 * 从一行里取 `ctx.xxx(` 的第一个实参。
 * @param line 遮过的行。
 * @param callee 被调用的成员名（`get` / `provide`）。
 * @param consts 常量表。
 * @returns 键；取不到返回 `null`。
 */
function firstArgOf(line: string, callee: string, consts: ReadonlyMap<string, string>): string | null {
  const re = ARG_RES.get(callee)
  if (re === undefined) return null
  const match = re.exec(line)
  if (match === null) return null
  if (match[1] !== undefined) return match[1]
  if (match[2] !== undefined) return match[2]
  const ident = match[3]
  if (ident === undefined) return null
  return consts.get(ident) ?? null
}

/** 扫描结果。 */
export interface SourceScan {
  /** 本包 `ctx.provide()` 声明的服务键（去重、保序）。 */
  readonly provideKeys: readonly string[]
  /** 本包 `ctx.get()` 消费的服务键（去重、保序）。 */
  readonly consumeKeys: readonly string[]
  /** `from 'ondra-…'` 的越界 import（**应当永远为空**）。 */
  readonly crossImports: readonly { readonly path: string; readonly no: number; readonly text: string }[]
  /** `const x = ctx.get(...)` 之后看不到判空的位置。 */
  readonly degradeMisses: readonly { readonly path: string; readonly no: number; readonly text: string }[]
  /** 检查了几处 `ctx.get` 赋值。 */
  readonly degradeChecked: number
  /** `export const name` 的值。 */
  readonly exportName: string | null
  /** 有 `export function apply(` 或 `export const apply =`。 */
  readonly hasApply: boolean
  /** 有 `export const inject =`。 */
  readonly hasInject: boolean
  /** 有 `export const Config`。 */
  readonly hasConfig: boolean
  /** `Config` 里有 `~standard`（标准 schema 形状）。 */
  readonly configStandard: boolean
}

/** 判空痕迹（在同一标识符上找这些形状）。 */
const GUARD_PATTERNS: readonly RegExp[] = Object.freeze([
  /===\s*undefined/,
  /!==\s*undefined/,
  /===\s*void 0/,
  /!==\s*void 0/,
])

/**
 * 扫一批源码。
 * @param sources 源码清单。
 * @returns 扫描结果。
 */
export function scanSources(sources: readonly SourceFile[]): SourceScan {
  const provideKeys: string[] = []
  const consumeKeys: string[] = []
  const crossImports: { path: string; no: number; text: string }[] = []
  const degradeMisses: { path: string; no: number; text: string }[] = []
  let degradeChecked = 0
  let exportName: string | null = null
  let hasApply = false
  let hasInject = false
  let hasConfig = false
  let configStandard = false

  for (const file of sources) {
    const lines = maskFile(file)
    const consts = constTable(lines)

    for (const line of lines) {
      const provided = firstArgOf(line.masked, 'provide', consts)
      if (provided !== null && provided !== '' && !provideKeys.includes(provided)) {
        provideKeys.push(provided)
      }
      const consumed = firstArgOf(line.masked, 'get', consts)
      if (consumed !== null && consumed !== '' && !consumeKeys.includes(consumed)) {
        consumeKeys.push(consumed)
      }

      if (/from\s+['"]ondra-[^'"]*['"]/.test(line.masked)) {
        crossImports.push({ path: line.path, no: line.no, text: line.raw.trim() })
      }

      if (/export\s+const\s+name\s*(?::\s*string\s*)?=/.test(line.masked)) {
        const match = /export\s+const\s+name\s*(?::\s*string\s*)?=\s*['"]([^'"]+)['"]/.exec(line.masked)
        if (match !== null) exportName = match[1]
      }
      if (/export\s+(?:async\s+)?function\s+apply\s*\(/.test(line.masked)) hasApply = true
      if (/export\s+const\s+apply\s*=/.test(line.masked)) hasApply = true
      if (/export\s+const\s+inject\s*=/.test(line.masked)) hasInject = true
      if (/export\s+const\s+Config\b/.test(line.masked)) hasConfig = true
      if (line.masked.includes('~standard')) configStandard = true

      // 判空：只看 `const X = ctx.get(...)` 这种赋值形状。
      const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*ctx\.get\(/.exec(line.masked)
      if (assign === null) continue
      degradeChecked += 1
      const ident = assign[1]
      if (guardedAfter(lines, line.no, ident)) continue
      degradeMisses.push({ path: line.path, no: line.no, text: line.raw.trim() })
    }
  }

  return {
    provideKeys: Object.freeze(provideKeys),
    consumeKeys: Object.freeze(consumeKeys),
    crossImports: Object.freeze(crossImports),
    degradeMisses: Object.freeze(degradeMisses),
    degradeChecked,
    exportName,
    hasApply,
    hasInject,
    hasConfig,
    configStandard,
  }
}

/**
 * 判空是否在赋值之后的不远处出现。
 *
 * 看 8 行：本仓的写法都是「取 → 紧接着判」，超过 8 行还没判，多半是把 `undefined`
 * 一路传下去了。这是**启发式**，所以只出 `warn`，不出 `fail`。
 * @param lines 全部行。
 * @param no 赋值所在行号（1 起）。
 * @param ident 标识符。
 */
function guardedAfter(lines: readonly MaskedLine[], no: number, ident: string): boolean {
  const escaped = ident.replace(/[$]/g, '\\$&')
  const direct = new RegExp(`\\b${escaped}\\b\\s*(?:===|!==)\\s*(?:undefined|void 0)`)
  const negated = new RegExp(`!\\s*${escaped}\\b`)
  const optional = new RegExp(`\\b${escaped}\\b\\s*(?:\\?\\.|\\?\\?)`)
  const limit = Math.min(lines.length, no - 1 + 8)
  for (let index = no - 1; index < limit; index += 1) {
    const text = lines[index].masked
    if (direct.test(text) || negated.test(text) || optional.test(text)) return true
    if (GUARD_PATTERNS.some(pattern => pattern.test(text) && new RegExp(`\\b${escaped}\\b`).test(text))) {
      return true
    }
  }
  return false
}
