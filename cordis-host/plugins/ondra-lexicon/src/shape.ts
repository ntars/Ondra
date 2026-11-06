/**
 * 语感的**纯统计层**：一条消息 → 一个形状；一堆形状 → 三个统计量；三个统计量 → 一段正文。
 *
 * 全部是纯函数：不读文件、不取时间、不碰 `ctx`。这样才能在没有编译器的环境里
 * 用文本手段把口径核清楚（§16.2），也才能在 README 里把每个数字的来历说死。
 *
 * ## 口径三句话
 *
 * - **句长去标点、去空白**：问的是「一句话多长」，不是「一行多长」。标点另有一个
 *   独立指标（无标点率），两者不重复计数。
 * - **无标点率按消息算**：按句算时，「一句没标点」必然等价于「整条没标点」，
 *   两条指标会变成同一个指标；按消息算才回答「他说话爱不爱打标点」。
 * - **语气词只认句末单字**：句中的「啊」多半是实词（「啊这」），句末的「啊」
 *   才是语气。闭集在 `types.ts`，这里不做二次筛选。
 */

import { MARKER, PARTICLES, SAMPLE_WINDOW } from './types.js'
import type { LexiconSample, LexiconStats, MessageShape } from './types.js'

/** 句界字符。`；` 不算句界：分号连接的是同一句话的两个分句，切开会把句长压短一半。 */
const SENTENCE_END: ReadonlySet<string> = new Set(['。', '！', '？', '!', '?', '…', '\n', '\r'])

/** 标点闭集。判断「这条消息有没有标点」用它；切句时也会被剔掉。 */
const PUNCT: ReadonlySet<string> = new Set([
  '。', '，', '、', '；', '：', '？', '！', '…', '—', '～', '~', '·',
  ',', '.', ';', ':', '?', '!', '(', ')', '（', '）', '[', ']', '【', '】',
  '「', '」', '『', '』', '《', '》', '“', '”', '‘', '’', '"', "'", '{', '}',
])

/** 正文里出现这些字符就当作「打了标点」。 */
export const PUNCT_COUNT = PUNCT.size

/**
 * 码位长度。
 *
 * 用 `Array.from` 而不是 `.length`：中文 BMP 里两者相同，但 emoji 是代理对，
 * `.length` 会把它算成 2，中位句长会被表情符号悄悄推高。
 * @param text 正文。
 */
export function charsOf(text: string): number {
  return Array.from(text).length
}

/** 这个字符是不是标点。 */
export function isPunct(ch: string): boolean {
  return PUNCT.has(ch)
}

/**
 * 剔掉标点与空白，留下「可数的字」。
 * @param text 正文。
 */
export function stripOf(text: string): string {
  let out = ''
  for (const ch of text) {
    if (PUNCT.has(ch)) continue
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u3000') continue
    out += ch
  }
  return out
}

/**
 * 切成句子。**去标点、去空白之后的句子**，空句不返回。
 * @param text 正文。
 */
export function sentencesOf(text: string): readonly string[] {
  const out: string[] = []
  let buffer = ''
  for (const ch of text) {
    if (SENTENCE_END.has(ch)) {
      const sentence = stripOf(buffer)
      if (sentence.length > 0) out.push(sentence)
      buffer = ''
      continue
    }
    buffer += ch
  }
  const tail = stripOf(buffer)
  if (tail.length > 0) out.push(tail)
  return out
}

/**
 * 整条消息有没有标点。
 * @param text 正文。
 */
export function hasNoPunct(text: string): boolean {
  for (const ch of text) {
    if (PUNCT.has(ch)) return false
  }
  return true
}

/**
 * 一句的句末语气词。不在闭集里返回空串。
 * @param sentence 已去标点的句子。
 */
export function tailParticleOf(sentence: string): string {
  if (sentence.length === 0) return ''
  let last = ''
  for (const ch of sentence) last = ch
  return PARTICLES.includes(last) ? last : ''
}

/**
 * 32 位 FNV-1a，转 8 位十六进制。
 *
 * 与 O-126 / O-127 / O-134 同一份实现（同一算法、同一输出），不共享代码：
 * 共享代码会让两个包在卸载一个时编译失败（§15.5）。
 * @param text 正文。
 */
export function fnv1a64(text: string): string {
  let hash = 0x811c9dc5
  for (const ch of text) {
    hash ^= ch.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 判重指纹：正文 + 时刻。
 *
 * 带时刻的理由：主人可能在新的一天说了同一句「早」，那是两条真实消息；
 * 只有「同一条被通道重推」才该判重，而重推的时刻是一样的。
 * @param text 正文。
 * @param at 时刻（毫秒）。
 */
export function fingerprintOf(text: string, at: number): string {
  return fnv1a64(`${at}\u0000${text}`)
}

/**
 * 一条消息 → 一个形状。**原文到此为止**：返回之后不再有任何字段引用原话。
 * @param sample 入参。
 * @param fallbackAt 没给时刻时用的当前时刻。
 * @returns 形状；正文为空时返回 undefined（由调用方计入拒收）。
 */
export function shapeOf(sample: LexiconSample, fallbackAt: number): MessageShape | undefined {
  const text = typeof sample.text === 'string' ? sample.text : ''
  const clean = stripOf(text)
  if (clean.length === 0) return undefined

  const at = typeof sample.at === 'number' && Number.isFinite(sample.at) ? Math.trunc(sample.at) : fallbackAt
  const sentences = sentencesOf(text)
  const sentenceChars = sentences.map(sentence => charsOf(sentence))

  const particles: Record<string, number> = {}
  for (const sentence of sentences) {
    const particle = tailParticleOf(sentence)
    if (particle === '') continue
    particles[particle] = (particles[particle] ?? 0) + 1
  }

  return Object.freeze({
    fingerprint: fingerprintOf(text, at),
    at,
    chars: charsOf(clean),
    sentenceChars: Object.freeze(sentenceChars),
    noPunct: hasNoPunct(text),
    particles: Object.freeze(particles),
  })
}

/**
 * 中位数。空数组返回 0。
 *
 * 偶数个时取中间两个的**较小者**，而不是平均：平均值会给出 9.5 这种
 * 「没有一条句子是这个长度」的数，读起来像假精度。
 * @param values 已排序或未排序的整数数组。
 */
export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor((sorted.length - 1) / 2)
  // 显式标注 `number | undefined`：未开 `noUncheckedIndexedAccess` 时下标读出来是
  // `number`，直接和 `undefined` 比较会被 TS 判成「无交集」的编译错误（TS2367）。
  const picked: number | undefined = sorted[middle]
  return picked === undefined ? 0 : picked
}

/**
 * 占比，0–1。分母为 0 时返回 0。
 * @param part 分子。
 * @param total 分母。
 */
export function rateOf(part: number, total: number): number {
  if (total <= 0) return 0
  return part / total
}

/**
 * 最高频的几个句末语气词。
 *
 * 次数相同按**闭集表内顺序**，保证同一批样本两次调用结果一致：
 * 排序不稳定会让注入正文在两个内容相同的回合里变字，白丢一次前缀命中。
 * @param shapes 样本集。
 * @param limit 取几个。
 */
export function topParticlesOf(shapes: readonly MessageShape[], limit: number): readonly string[] {
  const totals = new Map<string, number>()
  for (const shape of shapes) {
    for (const [particle, count] of Object.entries(shape.particles)) {
      totals.set(particle, (totals.get(particle) ?? 0) + count)
    }
  }
  const candidates = [...totals.entries()].filter(([, count]) => count > 0)
  candidates.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return PARTICLES.indexOf(a[0]) - PARTICLES.indexOf(b[0])
  })
  return candidates.slice(0, Math.max(0, limit)).map(([particle]) => particle)
}

/**
 * 截到字数上限。**在句读边界退让**，不在半个词里切。
 * @param text 正文。
 * @param max 上限（码位）。
 */
export function clipToChars(text: string, max: number): string {
  if (max <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  let cut = chars.slice(0, max).join('')
  const boundary = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('，'),
    cut.lastIndexOf('、'),
    cut.lastIndexOf('；'),
    cut.lastIndexOf('：'),
  )
  if (boundary >= Math.floor(max / 2)) cut = cut.slice(0, boundary + 1)
  return cut.trimEnd()
}

/** `composeText()` 的入参。 */
export interface ComposeOptions {
  /** 字数上限。 */
  readonly maxChars: number
  /** 最多报几个语气词。 */
  readonly topParticles: number
}

/**
 * 三个统计量 → 一段正文。
 *
 * ## 为什么正文里不写「最近 128 条」
 *
 * 手册 §12.1 的禁止报数铁律管的是「她对主人说话时不许报内部计数」。注入段里
 * 一旦出现「最近 128 条」，模型极容易把它复述成「你最近 128 条消息里……」——
 * 那正是铁律要消灭的句式。所以条数只进 `stats()` 与日志，**不进正文**。
 * @param stats 统计。
 * @param options 上限。
 */
export function composeText(stats: LexiconStats, options: ComposeOptions): string {
  if (stats.samples <= 0) return ''

  const median = stats.medianSentenceChars
  const noPunct = Math.round(stats.noPunctRate * 100)
  const particles = stats.topParticles.slice(0, Math.max(0, options.topParticles))

  const particleClause =
    particles.length === 0
      ? '句末很少带语气词'
      : `句末常带${particles.map(particle => `「${particle}」`).join('')}`

  const body = `主人说话的节奏：句中位 ${median} 字，${noPunct}% 不打标点，${particleClause}。跟着这个节奏说，不必学他说过的话。`

  return clipToChars(`${MARKER} ${body}`, options.maxChars)
}

/**
 * 置信度：按样本量开方给，样本满窗（300）为 1。
 *
 * 用开方而不是线性：30 条就有 0.32，已经够用；线性会给 0.1，
 * 而 0.1 会让下游按 `confidence` 门槛把这段直接丢掉——样本够却不出段，
 * 比「出一段不太准的」更没用。
 * @param samples 样本条数。
 * @param window 窗口条数。
 */
export function confidenceOf(samples: number, window: number = SAMPLE_WINDOW): number {
  if (samples <= 0) return 0
  const ratio = Math.max(0, Math.min(1, samples / Math.max(1, window)))
  return Math.round(Math.sqrt(ratio) * 100) / 100
}
