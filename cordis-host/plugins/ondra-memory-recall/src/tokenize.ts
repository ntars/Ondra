/**
 * 文本归一化与二元组切分（**纯函数，不碰 ctx、不碰时间**）。
 *
 * 为什么不用分词器：本仓库禁止装依赖（§16.3），而 `jieba` 一类分词器是原生扩展。
 * 手册 §2.3 的两路里，第一路原话是「IDF 罕见词命中（jieba 分词 + 通用 IDF，阈值 9）」，
 * 本插件用**字符二元组**近似「词」：
 *
 * - 中文短句里二元组的重合度与词级重合度高度相关，且不需要词典；
 * - 代价是 IDF 分布不同（词表几万 → 二元组几万到几十万），故 `rareIdf` 门槛
 *   在小库上够不到，`channels` 里会显式标 `absent` 而不是静默空转。
 *
 * **归一化会丢掉的东西**（都是刻意的）：
 * - 标点与空白：`「怕狗」` 与 `怕狗` 应该命中同一条；
 * - 全角字母：`ＡＢＣ` 与 `abc` 视为同词；
 * - 表情与符号：它们进不了倒排表，留着只会让 df 变脏。
 */

/**
 * 归一化：小写、只保留汉字 / 拉丁字母 / 数字。
 *
 * 用 `Array.from` 遍历而不是按 UTF-16 单元切，避免把代理对（扩展区汉字、emoji）
 * 从中间劈开——劈开会产生两个替换字符，它们会互相匹配，等于凭空造出一个高频词。
 * @param text 原文。
 */
export function normalizeText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  let out = ''
  for (const ch of Array.from(text)) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\u{20000}-\u{2fa1f}]/u.test(ch)) {
      out += ch
      continue
    }
    if (/[0-9A-Za-z]/.test(ch)) {
      out += ch.toLowerCase()
    }
  }
  return out
}

/**
 * 取字符二元组（去重，保持首次出现顺序）。
 *
 * 只有一个字符时返回该字符本身——否则「猫」这种单字查询会得到空集合，
 * 而单字恰恰是中文里最需要精确命中的情形。
 * @param text 已归一化或未归一化的文本（内部会再归一化一次）。
 */
export function bigramsOf(text: string): string[] {
  const normalized = normalizeText(text)
  const chars = Array.from(normalized)
  if (chars.length === 0) return []
  if (chars.length === 1) return [chars[0] as string]
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const gram = `${chars[i]}${chars[i + 1]}`
    if (seen.has(gram)) continue
    seen.add(gram)
    out.push(gram)
  }
  return out
}

/**
 * 取词频（二元组 → 出现次数）。
 *
 * 与 `bigramsOf` 的区别：这里**保留重复计数**，因为 BM25 的 `tf` 要的是次数。
 * @param text 文本。
 */
export function termFreqOf(text: string): Map<string, number> {
  const normalized = normalizeText(text)
  const chars = Array.from(normalized)
  const freq = new Map<string, number>()
  if (chars.length === 0) return freq
  if (chars.length === 1) {
    freq.set(chars[0] as string, 1)
    return freq
  }
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const gram = `${chars[i]}${chars[i + 1]}`
    freq.set(gram, (freq.get(gram) ?? 0) + 1)
  }
  return freq
}

/**
 * 归一化后的字符数（BM25 的文档长度）。
 * @param text 文本。
 */
export function charLengthOf(text: string): number {
  return Array.from(normalizeText(text)).length
}

/**
 * 两个文本共享的二元组个数（用于「候选闸门」与解释文案）。
 * @param a 文本 a。
 * @param b 文本 b。
 */
export function sharedGramsOf(a: string, b: string): number {
  const left = new Set(bigramsOf(a))
  if (left.size === 0) return 0
  let shared = 0
  for (const gram of new Set(bigramsOf(b))) {
    if (left.has(gram)) shared += 1
  }
  return shared
}
