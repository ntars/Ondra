/**
 * 指针的编码与切分 —— **纯函数**。
 *
 * ## 三件事只在这里做一次
 *
 * 1. **数码位**：`charsOf` 用「UTF-16 长度减去代理对」来数，结果等于 `Array.from` 的长度，
 *    但不分配数组。指针里写的 `<字符数>` 与账本里的 `chars` 必须是同一个口径，
 *    否则恢复时的长度校验会把好数据判成坏数据。
 * 2. **算指纹**：FNV-1a 64 位。选它不是因为抗碰撞强（12 位十六进制只有 48 位），
 *    而是因为**纯同步、零依赖、逐字节确定**。它在这里的用途是「同一段正文得到同一个
 *    指针」以及「恢复后对账」，不是安全。
 * 3. **切段**：超长的正文必须切开，但**不许切在代理对中间**——切坏了恢复回来就是
 *    两个半字符，而长度校验还会通过（因为按码位数是对的）。所以切点一律走
 *    `indexAfterChars`，它只落在完整码位之后。
 */

/** 切段时优先尝试的分隔符，从粗到细。 */
const SEPARATORS: readonly string[] = ['\n\n', '\n', '。', '！', '？', '. ', ' ']

/**
 * 数码位（一个 emoji 算一个字）。
 * @param text 正文。
 */
export function charsOf(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i += 1
    }
    count += 1
  }
  return count
}

/**
 * 从 `start` 起数 `n` 个码位，返回其后的 UTF-16 下标。
 * @param text 正文。
 * @param start 起点。
 * @param n 码位数。
 */
export function indexAfterChars(text: string, start: number, n: number): number {
  let index = start
  let left = n
  while (index < text.length && left > 0) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) index += 1
    }
    index += 1
    left -= 1
  }
  return index
}

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const U64_MASK = 0xffffffffffffffffn

/**
 * FNV-1a 64 位，返回 16 位小写十六进制。
 *
 * 按 UTF-16 码元逐位吃，不按码位：同一串字符在任何环境下码元序列都相同，
 * 而「按码位」需要先拆代理对，多一步就多一处能写错的地方。
 * @param text 正文。
 */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * FNV_PRIME) & U64_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * 指针 id：`zr-` + 指纹前 12 位。
 *
 * **会话参与哈希**：同一条记录只能指向一个会话的 session log，跨会话共用会让恢复指错人。
 * 代价是同一段正文在两个会话里得到两个指针——这是对的，因为它们指向两份不同的证据。
 * @param sessionId 会话 id。
 * @param text 正文。
 */
export function baseIdOf(sessionId: string, text: string): string {
  return `zr-${fnv1a64(`${sessionId}\u0000${text}`).slice(0, 12)}`
}

/**
 * 第 n 个候选 id（n 从 1 起）。撞号时才用得到，正常路径永远是 n=1。
 * @param base 基础 id。
 * @param n 序号。
 */
export function idCandidateOf(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`
}

/**
 * 指针文本：`[zr-xxxxxxxxxxxx/字符数]`。
 * @param id 指针 id。
 * @param chars 字符数。
 */
export function pointerOf(id: string, chars: number): string {
  return `[${id}/${chars}]`
}

/**
 * 从一段可能带指针的正文里取出 id。
 * @param text 指针或裸 id。
 */
export function idOfPointer(text: string): string | undefined {
  const trimmed = text.trim()
  const match = /^\[(zr-[0-9a-f]{12}(?:-[0-9]+)?)\/([0-9]+)\]$/.exec(trimmed)
  if (match !== null) return match[1]
  if (/^zr-[0-9a-f]{12}(?:-[0-9]+)?$/.test(trimmed)) return trimmed
  return undefined
}

/**
 * 按码位上限切段。切点优先落在分隔符之后，其次硬切在完整码位之后。
 * @param text 正文。
 * @param maxChars 单段码位上限。
 */
export function chunkText(text: string, maxChars: number): readonly string[] {
  if (maxChars <= 0) return text.length === 0 ? [] : [text]
  if (charsOf(text) <= maxChars) return text.length === 0 ? [] : [text]

  const out: string[] = []
  let start = 0
  while (start < text.length) {
    const limit = indexAfterChars(text, start, maxChars)
    if (limit >= text.length) {
      out.push(text.slice(start))
      break
    }
    let cut = -1
    for (const separator of SEPARATORS) {
      const index = text.lastIndexOf(separator, limit)
      if (index <= start) continue
      // 分隔符可能跨过上限（`.` 在 limit-1、空格在 limit）：整体切点不许越界，
      // 否则「单条最多 maxChars」这条约定会在最常见的空格处失守一个字符。
      if (index + separator.length > limit) continue
      // 太靠前的分隔符不认：那会切出一堆几十字的小段，账本被碎块撑满。
      if (index - start < Math.floor(maxChars / 4)) continue
      cut = index + separator.length
      break
    }
    if (cut <= start) cut = limit
    const piece = text.slice(start, cut)
    if (piece.length > 0) out.push(piece)
    start = cut
  }
  return out
}
