/**
 * 纯文本工具：码位计数、截断、标题、指纹、取值收窄。
 *
 * ## 为什么与 O-126 的 `text.ts` 重复
 *
 * §15.5 禁止同轮两个插件互相 import：任一单独卸载都不该让另一个编译失败。
 * 而 §15.3 又要求共享数据结构由先做方定义——两条同时成立，唯一解就是
 * 「契约镜像 + 工具各自实现」。这里只抄**五个纯函数**，每个都能一眼看完；
 * 代价是两处改动要同步，收益是两包完全独立。
 *
 * 这与 O-007 对 O-006 的 `StorePort` 做结构对位镜像同一条纪律（见第 2 组产出登记）。
 */

/**
 * 码位数（emoji 算一个）。
 *
 * `String.length` 数的是 UTF-16 码元：一个 emoji 算 2。用 `length` 做「最多 N 字」
 * 的上限，会在含 emoji 的转写上提前截断一半，且可能切出半个代理对。
 */
export function charsOf(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/**
 * 按**码位**截断，且不切断代理对。
 * @param text 原文。
 * @param max 最多保留多少码位。
 */
export function clip(text: string, max: number): { readonly text: string; readonly truncated: boolean } {
  if (max <= 0) return { text: '', truncated: text !== '' }
  const chars = Array.from(text)
  if (chars.length <= max) return { text, truncated: false }
  return { text: chars.slice(0, max).join(''), truncated: true }
}

/** 去首尾空白并把连续空白压成一个空格。 */
export function squeeze(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * 从一段正文里取一句话标题。
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
 * 与 O-126 同一实现：指纹只用来去重，不是安全用途；FNV 是纯算术、无依赖、
 * 可逐字节对拍。**两个包必须给出同一个指纹**，否则 O-128 会认为同一段语音
 * 被两个插件各转写了一次——所以这里连哈希的输入拼接方式都一致
 * （`modality + '\0' + sourcePath + '\0' + text`）。
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
