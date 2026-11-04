/**
 * 纯文本工具：码位计数、截断、标题、指纹、宽松 JSON 提取。
 *
 * ## 为什么一个文件装这五件事
 *
 * 它们都满足同一条件：**没有 IO、没有状态、输入输出都是字符串**，而且
 * 每个都要在同一批函数里被反复调用（截断影响字数、字数影响指纹）。
 * 拆成五个文件只会让 import 列表更长，不会让任何一处更容易改。
 *
 * 与 O-143 的 `pointer.ts` 同一手法：把「可对拍的纯函数」集中在一处，
 * 将来要对拍（Python 复算一遍）只读这一个文件就够。
 */

/**
 * 码位数（emoji 算一个）。
 *
 * `String.length` 数的是 UTF-16 码元：一个 emoji 算 2，一个汉字算 1。
 * 用 `length` 做「最多 2000 字」的上限，会在含 emoji 的描述上提前截断一半——
 * 而截断点正好落在一个代理对中间时，输出里会留一个孤立的半个字符。
 */
export function charsOf(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/**
 * 按**码位**截断，且不切断代理对。
 *
 * `slice(0, n)` 是码元截断，会切出半个 emoji；用迭代器按码位走一遍即可。
 * @param text 原文。
 * @param max 最多保留多少码位。
 */
export function clip(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  if (max <= 0) return { text: '', truncated: text !== '' }
  const chars = Array.from(text)
  if (chars.length <= max) return { text, truncated: false }
  return { text: chars.slice(0, max).join(''), truncated: true }
}

/** 去首尾空白并把连续空白压成一个空格（模型爱回一堆空行）。 */
export function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 从一段正文里取一句话标题。
 *
 * 只取第一个句界之前的部分；没有句界就截断。**不调模型**：标题是给人扫一眼用的，
 * 为它多花一次请求，比没有标题还贵。
 * @param text 正文。
 * @param max 最多多少字。
 */
export function titleOf(text: string, max = 40): string {
  const flat = squeeze(text)
  if (flat === '') return ''
  const cut = flat.search(/[。！？!?\n]/)
  const head = cut > 0 ? flat.slice(0, cut) : flat
  return clip(head, max).text
}

/**
 * FNV-1a 64 位，返回 16 位小写十六进制。
 *
 * 选它而不是 SHA-256：这里只用来去重（同一段内容两次得到同一个指纹），
 * 不是安全用途。FNV 是纯算术、无依赖、可逐字节对拍；SHA 要 `node:crypto`，
 * 而 `crypto` 在某些裁剪过的运行时里不存在——指纹不该成为「视觉能不能用」的前提。
 *
 * 用 `BigInt` 而不是拆高低 32 位：拆位版本在乘法进位处最容易写错，
 * 而写错的表现是「偶尔撞号」，查起来比重写一遍还慢。
 * @param text 输入。
 */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * 从模型输出里挖出第一个 JSON 对象。
 *
 * 视觉模型对「只输出 JSON」这条指令的遵守率大概七成：剩下三成会包一层
 * ```json 代码块、或者在前后加一句「好的，结果如下：」。直接 `JSON.parse`
 * 会在这三成上全灭，而失败表现是「定位功能不好用」。
 *
 * 所以：先去代码块围栏，再从第一个 `{` 扫到配对的那个 `}`（按括号深度，且跳过
 * 字符串里的括号与转义）。扫不到或解析失败一律 `undefined`——**不猜、不补**。
 * @param raw 模型原文。
 */
export function firstJsonObject(raw: string): Record<string, unknown> | undefined {
  const unfenced = raw.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '')
  const start = unfenced.indexOf('{')
  if (start < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < unfenced.length; index += 1) {
    const ch = unfenced[index]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(unfenced.slice(start, index + 1))
          return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** 取一个有限数字；不是数字就 `undefined`。 */
export function numberOr(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 取一个去空白的字符串；不是字符串就 `undefined`。 */
export function stringOr(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined
}
