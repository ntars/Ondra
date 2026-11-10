/**
 * 引文归一化与字数工具。
 *
 * ## 这里的口径**逐字对齐 O-011 的 `verify.ts`**
 *
 * 比对前只做三件事：**NFKC 归一**（全角→半角）、**折叠空白**、**去掉引文首尾标点**。
 *
 * 为什么不多做：一旦把「所有标点都删掉」，`我不去` 就能匹配到 `我，不去`，
 * 两句意思不同却都通过——闸门就从「防编造」变成了「防不住」。
 * 允许的只有「模型少抄了个句号」这一类，不允许改字、不允许跨句拼接。
 *
 * 为什么不做小写化：中文没有大小写，而英文专名（GitHub / github）的大小写本身就是信息。
 *
 * **跨插件禁 import**（§18.5 / §6 禁令 4），所以这里有一份副本。
 * 纪律：**O-011 `verify.ts` 与本文档改一处必须同改**。口径漂移的后果是
 * 「提炼时能过、做梦时过不了」，而两边都不报错——这是最难查的一类不一致。
 *
 * ## 二元组为什么也在这里
 *
 * 荒诞联想要找「同实体」的两条记忆（手册没定义实体），本插件用「共享 ≥N 个字符二元组」
 * 近似。二元组本身是个**原语**，不是阈值；判重阈值（包含度 0.4）仍然只有 O-012 一处，
 * 本插件不碰。原语在 O-011 / O-014 / O-018 各有一份，同样是跨插件禁 import 的代价。
 */

/** 引文首尾要去掉的标点（只去首尾，不动中间）。与 O-011 逐字一致。 */
const EDGE_PUNCTUATION = /^[\s，。、；：！？,.;:!?…—\-"'“”「」『』（）()]+|[\s，。、；：！？,.;:!?…—\-"'“”「」『』（）()]+$/g

/**
 * 比对用的归一化。
 * @param text 原文。
 */
export function normalizeForMatch(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u3000]+/g, ' ').trim()
}

/**
 * 引文比对用的归一化：在 `normalizeForMatch` 之上再去掉首尾标点。
 * @param text 引文。
 */
export function normalizeQuote(text: string): string {
  return normalizeForMatch(text).replace(EDGE_PUNCTUATION, '')
}

/**
 * 引文是否逐字出现在素材里。
 *
 * 两边都先归一化再判子串。**不做「忽略标点」的进一步放宽**，理由见文件头。
 * @param quote 引文。
 * @param material 素材原文。
 */
export function containsVerbatim(material: string, quote: string): boolean {
  const haystack = normalizeForMatch(material)
  const needle = normalizeQuote(quote)
  if (needle === '') return false
  return haystack.includes(needle)
}

/**
 * 字数（按码点，不按 UTF-16 单元）。
 *
 * 用 `[...text].length` 而不是 `text.length`：后者会把一个 emoji 数成 2，
 * 于是「30–50 字的梦话」对带表情的文本判不准。
 * @param text 文本。
 */
export function charCount(text: string): number {
  return [...text].length
}

/**
 * 按码点截断。
 * @param text 文本。
 * @param max 上限。
 */
export function cutTo(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/**
 * 取字符二元组集合。
 *
 * 只保留字母、汉字与数字，标点与空白全部丢弃——不去标点的话，
 * `，。` 会与任何一句带逗号的话共享二元组，「共享 ≥N」这道门槛形同虚设。
 * @param text 原文。
 */
export function bigrams(text: string): ReadonlySet<string> {
  const chars = [...normalizeForMatch(text)].filter(char => /[\p{L}\p{N}]/u.test(char))
  const out = new Set<string>()
  for (let index = 0; index + 1 < chars.length; index += 1) {
    out.add(`${chars[index]}${chars[index + 1]}`)
  }
  return out
}

/**
 * 两个集合的共享二元组个数。
 * @param left 集合 A。
 * @param right 集合 B。
 */
export function sharedGramCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let shared = 0
  for (const gram of small) {
    if (large.has(gram)) shared += 1
  }
  return shared
}

/**
 * 取本地日期键 `YYYY-MM-DD`（**不用 UTC**）。
 *
 * 做梦记的是「哪一晚」，那是墙上时间。用 `toISOString()` 会在东八区把
 * 23:30 的梦记到前一天——而 22:00 做梦正好落在这个窗口边上。
 * @param at 时间戳。
 */
export function dateKey(at: number): string {
  const date = new Date(at)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}
