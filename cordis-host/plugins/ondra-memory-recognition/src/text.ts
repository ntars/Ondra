/**
 * 纯文本工具：归一化、二元组、识别触发词抽取、token 估算、`[[links]]` 解析。
 *
 * 这个文件**不碰 ctx、不碰 IO、不记录状态**——全是可对拍的纯函数。
 * 拆出来的理由不是「好看」，是这三件事每一条都会静默出错：
 *
 * 1. **触发词抽错**不会报错，只会让某条记忆永远认不出来（用户感知为「她忘了」）；
 * 2. **归一化做漏**（全角逗号、大写英文）会让「同一句话」有两种形状，索引与查询对不上；
 * 3. **token 估算差一倍**会让 6k 预算变成 12k，而超预算的表现只是「慢了」，很难归因。
 *
 * 与 O-014 `tokenize.ts` 的关系：**结构对位，不 import**（§18.5）。那边是 BM25 口径
 * （要词频、要文档长度），这边是「一行触发词」口径（要短、要可读、要去停用词）。
 * 两边的二元组定义刻意保持一致：都是「归一化后相邻两字符」，这样同一个问题在
 * 字面通道与识别通道里看到的是同一批片段。
 */

/** CJK 统一表意文字 + 假名范围（用于 token 估算与片段切分）。 */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 归一化时保留的字符：汉字、字母、数字。其余一律当分隔符。 */
const KEEP_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]/

/**
 * 停用词表。
 *
 * 刻意**只放功能词**，不放任何实词：停用词表一旦放进「觉得不太重要」的词，
 * 就会变成「作者的主观判断」，而它影响的是「哪条记忆能被认出来」。
 * 这里每一条都是「单独出现时不携带任何检索信息」的词。
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  '的', '了', '我', '你', '他', '她', '它', '们', '是', '在', '和', '与', '就', '都', '也', '还',
  '又', '很', '太', '更', '最', '不', '没', '有', '会', '要', '能', '可', '想', '说', '去', '来',
  '着', '过', '吧', '呢', '啊', '吗', '嗯', '哦', '嘛', '呀', '把', '被', '让', '给', '对', '从',
  '到', '为', '以', '而', '但', '却', '如果', '因为', '所以', '但是', '然后', '现在', '时候',
  '一个', '我们', '你们', '他们', '自己', '这样', '那样', '这个', '那个', '什么', '怎么', '一下',
  '已经', '还是', '就是', '可以', '应该', '觉得', '知道', '今天', '昨天', '明天',
])

/** 停用词前缀（长度 > 2 的片段剥掉开头这些，剥完仍 ≥ 2 字才留）。 */
const STOP_PREFIXES: readonly string[] = Object.freeze([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '因为', '所以', '但是', '然后',
  '觉得', '知道', '可以', '应该', '已经', '还是', '就是', '不是', '没有', '一个',
])

/** `[[links]]` 的解析正则。字符类里不出现斜杠，避免被扫描器误判成正则结束。 */
const LINK_RE = /\[\[([^[\]\n]{1,64})\]\]/gu

/** 按「非保留字符」切片段。 */
const SPLIT_RE = /[^\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaffA-Za-z0-9]+/u

/**
 * 归一化：NFKC（全角→半角）+ 小写 + 非保留字符转空格 + 折叠空白。
 *
 * NFKC 是关键一步：它把「ＡＢＣ」「１２３」「，」统一成半角，
 * 否则用户从别处粘来的句子会与索引里的同一个词长得不一样。
 * @param text 原始文本。
 */
export function normalizeText(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  const folded = text.normalize('NFKC').toLowerCase()
  let out = ''
  let pendingSpace = false
  for (const ch of folded) {
    if (KEEP_RE.test(ch)) {
      if (pendingSpace && out !== '') out += ' '
      pendingSpace = false
      out += ch
    } else {
      pendingSpace = true
    }
  }
  return out.trim()
}

/**
 * 二元组集合（归一化后相邻两字符）。
 * @param text 已归一化或未归一化的文本（内部会再归一化一次，幂等）。
 */
export function bigramsOf(text: string): Set<string> {
  const normalized = normalizeText(text)
  const grams = new Set<string>()
  const chars = [...normalized]
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const pair = `${chars[index]}${chars[index + 1]}`
    // 空格参与的二元组没有检索价值，且会让「查一个词命中整句」。
    if (pair.includes(' ')) continue
    grams.add(pair)
  }
  return grams
}

/**
 * 字符数（按码点，不按 UTF-16 单元）。
 * @param text 文本。
 */
export function charLengthOf(text: string): number {
  return [...text].length
}

/**
 * 估算 token 数。
 *
 * 口径写清楚（否则数字没法跨轮比较）：**CJK 每字 1 token，其余每 4 字符 1 token**，
 * 向上取整。这是估算，不是分词器——手册给的「500 条≈6k token」本身就是个约数，
 * 这里的目标是「预算量级对得上」，不是「精确到个位」。
 * @param text 文本。
 */
export function estTokensOf(text: string): number {
  if (text === '') return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * FNV-1a 32 位哈希，输出 8 位十六进制。
 *
 * 用它而不是 `crypto`：这里只需要「内容变了没有」一个布尔，不需要密码学强度，
 * 而 `crypto` 在同步路径上要么引入 `node:crypto`（浏览器侧不可用），要么变异步。
 * @param text 文本。
 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 解析正文里的 `[[links]]`，返回目标原文（已去重、保持出现顺序）。
 *
 * **格式由本插件定义**（手册只写 `[[links]]` 四个字，没给语法细则）：
 * 双中括号中间是「一个不含括号与换行的目标」，最长 64 字。
 * 目标可以是 slug、记忆 id、或另一条记忆的触发词，解析顺序见 `match.ts`。
 * @param text 正文。
 */
export function linksOf(text: string): readonly string[] {
  if (typeof text !== 'string' || text === '') return []
  const out: string[] = []
  const seen = new Set<string>()
  LINK_RE.lastIndex = 0
  let match = LINK_RE.exec(text)
  while (match !== null) {
    const target = typeof match[1] === 'string' ? match[1].trim() : ''
    if (target !== '' && !seen.has(target)) {
      seen.add(target)
      out.push(target)
    }
    // 空匹配防护：目标为空时 `lastIndex` 不会前进，会死循环。
    if (match[0] === '') LINK_RE.lastIndex += 1
    match = LINK_RE.exec(text)
  }
  return out
}

/** 判一个片段是不是纯停用词。 */
function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token)
}

/** 剥掉一个停用词前缀（只剥一次，剥完不够 2 字就不剥）。 */
function stripStopPrefix(token: string): string {
  for (const prefix of STOP_PREFIXES) {
    if (token.length > prefix.length && token.startsWith(prefix)) {
      const rest = token.slice(prefix.length)
      if (rest.length >= 2) return rest
    }
  }
  return token
}

/** 片段切分：按非保留字符切开，丢掉空片段。 */
function clausesOf(text: string): string[] {
  const normalized = normalizeText(text)
  if (normalized === '') return []
  return normalized
    .split(SPLIT_RE)
    .map(part => part.trim())
    .filter(part => part !== '')
}

/**
 * 从一个片段里取候选触发词。
 *
 * 长度分档（derived，手册未给）：
 * - 2–6 字 → 整段就是候选（中文里 2–6 字正好是「一个词到一个短语」）；
 * - 7–12 字 → 取前 4 字与后 4 字（长句的头尾最有区分度，且截断后仍成词的概率最高）；
 * - > 12 字 → 每 4 字取一块，最多 4 块。
 * @param clause 片段。
 */
function candidatesOf(clause: string): string[] {
  const chars = [...clause]
  const length = chars.length
  if (length < 2) return []
  if (length <= 6) return [clause]
  if (length <= 12) {
    const head = chars.slice(0, 4).join('')
    const tail = chars.slice(length - 4).join('')
    return head === tail ? [head] : [head, tail]
  }
  const out: string[] = []
  const blocks = Math.min(4, Math.floor(length / 4))
  for (let index = 0; index < blocks; index += 1) {
    out.push(chars.slice(index * 4, index * 4 + 4).join(''))
  }
  return out
}

/** 候选打分。 */
interface ScoredTrigger {
  /** 候选词。 */
  readonly token: string
  /** 分数（越大越优先）。 */
  readonly score: number
}

/**
 * 抽识别触发词。
 *
 * 优先用 `summary`：摘要 ≤80 字、本身就是「这条记忆说了什么」的浓缩，
 * 比正文更适合当识别入口。摘要不存在或太短（<4 字）才退回正文。
 *
 * 确定性：同一段文本 + 同一组参数，输出**逐字相同**。所以排序的最后一级是字典序，
 * 不允许出现「顺序随实现变化」——索引块的内容哈希依赖这一点。
 * @param text 正文。
 * @param summary 摘要（可为 null）。
 * @param limit 最多几个。
 */
export function extractTriggers(text: string, summary: string | null, limit: number): readonly string[] {
  const source = typeof summary === 'string' && charLengthOf(normalizeText(summary)) >= 4 ? summary : text
  const clauses = clausesOf(source)
  const body = normalizeText(text)
  const scored = new Map<string, number>()

  for (const clause of clauses) {
    for (const raw of candidatesOf(clause)) {
      let token = raw
      if (isStopWord(token)) continue
      token = stripStopPrefix(token)
      if (charLengthOf(token) < 2) continue
      if (isStopWord(token)) continue
      const length = charLengthOf(token)
      // 长度是主要信号：4 字块比 2 字块更像「一个可被认出的说法」。
      let score = length * 2
      // 含数字/时间的词（周五、三次、2026）区分度极高——「周五考试」正是手册举的例子。
      if (/[0-9]/.test(token)) score += 4
      // 正文里出现频次（最多算 3 次，防止一个口头禅吃掉全部名额）。
      if (body.includes(token)) score += 1
      const previous = scored.get(token)
      if (previous === undefined || score > previous) scored.set(token, score)
    }
  }

  // 一个候选都没有（正文全是停用词 / 全是标点）时，退回「整段前 6 字」，
  // 让这条记忆至少有一个能被人看见的入口，而不是凭空消失。
  if (scored.size === 0) {
    const fallback = [...body.replace(/ /gu, '')].slice(0, 6).join('')
    return fallback === '' ? [] : [fallback]
  }

  const list: ScoredTrigger[] = [...scored.entries()].map(([token, score]) => ({ token, score }))
  list.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const leftLength = charLengthOf(left.token)
    const rightLength = charLengthOf(right.token)
    if (rightLength !== leftLength) return rightLength - leftLength
    return left.token < right.token ? -1 : left.token > right.token ? 1 : 0
  })

  const out: string[] = []
  for (const item of list) {
    if (out.length >= limit) break
    // 逐字包含的短词是长词的子串（「数学」与「数学考试」），只留长的那个：
    // 两个都留等于浪费一个名额，而名额是 token 预算。
    if (out.some(existing => existing.includes(item.token) || item.token.includes(existing))) continue
    out.push(item.token)
  }
  return out
}

/**
 * 判断查询与触发词的关系档位（`match.ts` 用）。
 * @param query 已归一化的查询。
 * @param trigger 触发词。
 * @returns `equal` / `contains`（触发词被查询包含）/ `inside`（查询被触发词包含）/ `none`。
 */
export function triggerRelation(query: string, trigger: string): 'equal' | 'contains' | 'inside' | 'none' {
  if (query === '' || trigger === '') return 'none'
  if (query === trigger) return 'equal'
  if (query.includes(trigger)) return 'contains'
  if (trigger.includes(query) && charLengthOf(query) >= 2) return 'inside'
  return 'none'
}

/**
 * 二元组重合比。
 * @param queryGrams 查询的二元组。
 * @param entryGrams 条目的二元组。
 */
export function gramOverlap(queryGrams: ReadonlySet<string>, entryGrams: readonly string[]): number {
  if (queryGrams.size === 0 || entryGrams.length === 0) return 0
  let shared = 0
  for (const gram of entryGrams) {
    if (queryGrams.has(gram)) shared += 1
  }
  if (shared === 0) return 0
  // 分母取两者较小值：查询很短（两个字）时，用条目长度当分母会把分压到 0，
  // 表现为「短问句永远认不出任何东西」。
  return shared / Math.min(queryGrams.size, entryGrams.length)
}
