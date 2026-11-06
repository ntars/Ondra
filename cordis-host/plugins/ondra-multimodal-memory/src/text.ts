/**
 * 纯文本工具：码位计数、截断、标题、指纹、取值收窄。
 *
 * ## 为什么与 O-126 / O-127 的 `text.ts` 重复
 *
 * §15.5 禁止同轮插件互相 import（任一单独卸载都不该让另一个编译失败），
 * §15.3 又要求共享结构由先做方定义。两条同时成立的唯一解就是
 * 「契约镜像 + 工具各自实现」。这里只抄六个纯函数，每个都能一眼看完。
 *
 * ## 指纹必须是**同一个函数**，不只是「同一个算法」
 *
 * O-128 的去重全靠指纹。若本包的 `fnv1a64` 与两个上游有任何一位差别
 * （比如这里按码位、那边按码元），同一段内容会被算成两个指纹，
 * 于是「同一张图描述两次」变成两条记忆——而它们说的是同一件事。
 *
 * 所以实现逐字对齐 `ondra-asr/src/text.ts`：
 * 同样按 `charCodeAt`（UTF-16 码元）逐位异或，同样 64 位掩码，同样 16 位补零。
 * 拼接方式也一致：`modality + '\u0000' + sourcePath + '\u0000' + text`。
 */

/**
 * 码位数（emoji 算一个）。
 *
 * `String.length` 数的是 UTF-16 码元：一个 emoji 算 2。用 `length` 做「最多 N 字」
 * 的上限，会在含 emoji 的转写上提前截断一半，且可能切出半个代理对。
 * @param text 文本。
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
export function clip(
  text: string,
  max: number,
): { readonly text: string; readonly truncated: boolean } {
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
 *
 * 标题只给记忆列表用，**不参与检索**；所以取第一个句界之前的那一截就够了。
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
 * 与 O-126 / O-127 同一实现。指纹只用来去重，不是安全用途；
 * FNV 是纯算术、无依赖、可逐字节对拍。
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
 * 算内容指纹。
 *
 * 拼接方式由契约规定（见 `types.ts` 的 `MultimodalDraft.fingerprint`），
 * 三个包各写一份实现但必须拼出同一个字符串。**改动这里等于让全库去重失效**，
 * 所以单独抽成一个函数，让「改没改」一眼可见。
 * @param modality 种类。
 * @param sourcePath 原始文件路径。
 * @param text 正文。
 */
export function fingerprintOf(modality: string, sourcePath: string, text: string): string {
  return fnv1a64(`${modality}\u0000${sourcePath}\u0000${text}`)
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

/**
 * 把异常折成一句文本。
 *
 * 绝不 `throw` 到调用方：本包站在「用户刚发了一张图」的回调路径上，
 * 一个冒泡的异常会让整条消息处理链断掉。
 * @param error 异常。
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
