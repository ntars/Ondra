/**
 * 相似度的**纯算法**层：不碰 ctx、不碰库、不读时间、不调模型。
 *
 * 只提供一把尺子：**字符二元组包含度**。为什么是它、而不是余弦或 Jaccard：
 *
 * 1. **中文没有空格**。按词切分要先分词，而分词器本身是一个会漂移的依赖；
 *    二元组不需要词典，也不会因为「新词」而失效。
 * 2. **手册 §12.3 裁决⑥ 定的口径就是「包含度」**，原话还特别写了
 *    「口径不同不可互搬」。余弦 0.85 / Jaccard 0.75 是别处的标定值，
 *    搬过来会让同一对记忆时而合并、时而建边。
 * 3. **包含度天然处理「一条是另一条的补充」**：短句被长句完全覆盖时它等于 1.0，
 *    而余弦会因为长度差异被稀释到 0.5 以下，导致「她补充了一句」被误判成「新的事」。
 *
 * 包含度定义：`|A∩B| / min(|A|,|B|)`，A/B 为两条正文的二元组集合。
 * 取值 0–1；1.0 表示较短那条的每一对相邻字都在较长那条里出现过。
 */

/** 去掉一切非字母数字（空白、标点、符号），并折叠大小写。 */
export function normalizeForCompare(text: string): string {
  if (typeof text !== 'string') return ''
  // NFKC 把全角数字/字母折成半角，避免「２８岁」与「28岁」被判成两件事。
  const folded = text.normalize('NFKC')
  return folded.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
}

/** 有效字数（去掉空白与标点后的码点数）。 */
export function effectiveChars(text: string): number {
  return [...normalizeForCompare(text)].length
}

/**
 * 二元组集合。
 *
 * 单字正文没有二元组，退化成「单字集合」——否则「嗯」这类正文会得到空集合，
 * 空集合参与包含度计算会一路返回 0，让判重对极短句完全失效。
 * @param normalized 已归一化的正文。
 */
export function bigramsOf(normalized: string): Set<string> {
  const chars = [...normalized]
  const grams = new Set<string>()
  if (chars.length === 0) return grams
  if (chars.length === 1) {
    grams.add(chars[0] as string)
    return grams
  }
  for (let index = 0; index + 1 < chars.length; index += 1) {
    grams.add((chars[index] as string) + (chars[index + 1] as string))
  }
  return grams
}

/**
 * 包含度：`|A∩B| / min(|A|,|B|)`。
 *
 * 任一方为空时返回 0——「没有可比的东西」不该被算成「完全一样」。
 * @param a 集合 A。
 * @param b 集合 B。
 */
export function containmentOf(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const sizeA = a.size
  const sizeB = b.size
  if (sizeA === 0 || sizeB === 0) return 0
  const small = sizeA <= sizeB ? a : b
  const large = sizeA <= sizeB ? b : a
  let shared = 0
  for (const gram of small) {
    if (large.has(gram)) shared += 1
  }
  return shared / Math.min(sizeA, sizeB)
}

/**
 * 新颖度：`next` 里**`base` 没有**的二元组占比。
 *
 * 用来区分「复述」与「补充」：
 * - 0 表示全是旧信息，只该记一次被提起；
 * - 高表示确有新内容，该并进主条。
 * @param next 待写入正文的二元组。
 * @param base 旧条正文的二元组。
 */
export function noveltyOf(next: ReadonlySet<string>, base: ReadonlySet<string>): number {
  if (next.size === 0) return 0
  // 占比就是「绝对量 ÷ 总数」，只算一次绝对量，不写第二遍循环。
  return freshCountOf(next, base) / next.size
}

/**
 * 新颖度的**绝对量**：`next` 里 `base` 没有的二元组个数。
 *
 * 与 `noveltyOf`（占比）配合使用，理由见 `types.ts` 的 `freshGrams` 字段说明：
 * 长句加三个字占比可能只有 0.2，短句加两个字占比就到 0.33——
 * 单看任何一个都会判错一类。
 * @param next 待写入正文的二元组。
 * @param base 旧条正文的二元组。
 */
export function freshCountOf(next: ReadonlySet<string>, base: ReadonlySet<string>): number {
  let fresh = 0
  for (const gram of next) {
    if (!base.has(gram)) fresh += 1
  }
  return fresh
}

/**
 * 否定词个数。
 *
 * 只用来判**冲突**（「喜欢」vs「不喜欢」），不参与相似度。
 * 刻意不做词性分析：多算几个（例如「不错」里的「不」）只会多报一次冲突，
 * 而冲突默认是**只报告、不动数据**，误报的代价是一次人审，不是一次错改。
 * @param text 正文。
 */
export function negationCount(text: string): number {
  if (typeof text !== 'string') return 0
  const matches = text.normalize('NFKC').match(/[不没别未无勿甭]/gu)
  return matches === null ? 0 : matches.length
}

/**
 * 数字记号集合（半角数字，支持小数）。
 *
 * 只收 ASCII 数字，不解析中文数字（「二十八」与「28」不相等）。
 * 这是刻意的窄口径：中文数字歧义太多（「一点」不是 1），
 * 放宽会把大量正常正文误判成冲突。
 * @param text 正文。
 */
export function digitTokens(text: string): readonly string[] {
  if (typeof text !== 'string') return []
  const matches = text.normalize('NFKC').match(/[0-9]+(?:\.[0-9]+)?/gu)
  if (matches === null) return []
  return [...new Set(matches)].sort()
}

/** 两个数字集合是否不一致（都为空视为一致）。 */
export function digitsDiffer(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 && b.length === 0) return false
  if (a.length !== b.length) return true
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return true
  }
  return false
}

/**
 * 选合并后的正文：**取信息更全的那条**（有效字数多者），等长取新条。
 *
 * 为什么不拼接：中文短句硬拼会产出「她昨天去了医院她昨天去了医院复查」这种病句，
 * 而病句会原样进注入提示词。取较长者 + `revise()` 把旧正文存进 `oldText`，
 * 既没丢信息，也没造出病句。
 * @param oldText 旧正文。
 * @param newText 新正文。
 */
export function pickMergedText(oldText: string, newText: string): string {
  return effectiveChars(newText) >= effectiveChars(oldText) ? newText : oldText
}
