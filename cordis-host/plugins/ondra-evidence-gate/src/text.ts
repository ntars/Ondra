/**
 * 引文归一化与文本小工具。
 *
 * ## 这里的口径**逐字对齐 O-011 的 `verify.ts`**（第三份镜像在 O-019 `quote.ts`）
 *
 * 比对前只做三件事：**NFKC 归一**（全角→半角）、**折叠空白**、**去掉引文首尾标点**。
 *
 * 为什么不多做：一旦把「所有标点都删掉」，`我不去` 就能匹配到 `我，不去`，
 * 两句意思不同却都通过——闸门就从「防编造」变成了「防不住」。
 * 允许的只有「模型少抄了个句号」这一类，不允许改字、不允许跨句拼接。
 *
 * 为什么不做小写化：中文没有大小写，而英文专名（GitHub / github）的大小写本身就是信息。
 *
 * **跨插件禁 import**（§6 禁令 4 / §18.5），所以这里有第三份副本。
 * 纪律：**O-011 `verify.ts` / O-019 `quote.ts` / 本文档，改一处必须同改三处**。
 * 口径漂移的后果是「提炼时能过、做梦时过不了、手写时又能过」，而三边都不报错——
 * 这是最难查的一类不一致，本轮已用脚本逐字比对过三处的正则与函数体。
 *
 * ## 分句为什么也在这里
 *
 * 「没有出处的数字要剥离」剥到哪一层是个真问题：
 * 只删数字会得到「我今年岁」这种残句，删**分句**才读得通。分句是原语，
 * 不是策略；策略（剥还是整条拒）在 `settings.ts` 里。
 */

/** 引文首尾要去掉的标点（只去首尾，不动中间）。与 O-011 / O-019 逐字一致。 */
const EDGE_PUNCTUATION = /^[\s，。、；：！？,.;:!?…—\-"'“”「」『』（）()]+|[\s，。、；：！？,.;:!?…—\-"'“”「」『』（）()]+$/g

/**
 * 分句边界。取「句读类」标点，**不含**引号与括号——
 * 引号里的逗号仍是同一句话，在这里断开会把一句引文拆成两半。
 */
const CLAUSE_BOUNDARY = /[，。、；：！？,.;:!?\n]/

/**
 * 比对用的归一化。
 *
 * **不做小写化**，理由见文件头。
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
 * @param material 素材原文。
 * @param quote 引文。
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
 * 于是「引文不足 2 字」对带表情的文本判不准。
 * @param text 文本。
 */
export function charCount(text: string): number {
  return [...text].length
}

/**
 * 按码点截断。
 * @param text 文本。
 * @param max 上限（字）。
 */
export function cutByCodepoints(text: string, max: number): string {
  if (max <= 0) return ''
  return charCount(text) <= max ? text : [...text].slice(0, max).join('')
}

/** 一个分句：正文 + 紧跟其后的标点串。 */
export interface Clause {
  /** 分句正文（不含尾部标点）。 */
  readonly text: string
  /** 尾部标点串（可能是空串，也可能是「，。」这种连续标点）。 */
  readonly tail: string
}

/**
 * 把标点并到上一条分句的尾巴上。
 * @param out 已收集的分句。
 * @param extra 要追加的标点串。
 */
function appendTail(out: Clause[], extra: string): void {
  const last = out.at(-1)
  if (last === undefined) return
  out[out.length - 1] = { text: last.text, tail: last.tail + extra }
}

/**
 * 按句读标点分句，**保留标点**（`joinClauses(splitClauses(x)) === x`）。
 *
 * 保序保标点是硬要求：剥离之后要能原样拼回去，否则「剥了一个数字」
 * 会顺带改掉别处的标点，而这种改动没人会去核对。
 * @param text 原文。
 */
export function splitClauses(text: string): readonly Clause[] {
  const out: Clause[] = []
  let body = ''
  let tail = ''
  for (const char of text) {
    if (CLAUSE_BOUNDARY.test(char)) {
      tail += char
      if (body !== '') {
        out.push({ text: body, tail })
        body = ''
        tail = ''
      }
    } else {
      if (body === '' && tail !== '') {
        // 句首就是标点（例如接在上一句后面）：并回上一条，不新起一个空分句。
        appendTail(out, tail)
        tail = ''
      }
      body += char
    }
  }
  if (body !== '') out.push({ text: body, tail })
  else if (tail !== '') appendTail(out, tail)
  return out
}

/**
 * 把分句拼回原文。
 * @param clauses 分句。
 */
export function joinClauses(clauses: readonly Clause[]): string {
  return clauses.map(clause => clause.text + clause.tail).join('')
}
