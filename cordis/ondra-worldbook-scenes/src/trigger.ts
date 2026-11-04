/**
 * 触发判定：抽词、匹配、互斥、递归。**全部纯函数**。
 *
 * 这一层的每一步都能单独用几行脚本复现——因为"她这轮为什么用了这张卡"
 * 必须能回答到「命中了哪个词、输给了哪张卡、是第几层递归带出来的」，
 * 而不是一句「场景命中」。
 *
 * 五条判定纪律：
 *
 * 1. **先按互斥裁决，再从赢家递归。** 反过来（先递归再互斥）会让
 *   「输掉的那张卡」把别的卡带进候选池，于是淘汰了一张卡却多出两张——
 *   而日志里只显示"互斥淘汰 1 张"。
 *
 * 2. **否定邻域**：`不胖` 不触发「胖」，`没生气` 不触发「生气」。
 *   长期纪律里最贵的一条：同一字符在「不错」「没做好」里含义相反，只有邻近关系能分。
 *   窗口取前 2 个字符——再宽会把「我不觉得你胖」里的否定也算到「胖」头上，
 *   而那句话其实是夸。
 *
 * 3. **递归带出来的卡分数打 6 折，且有效分 = 分数 ÷ (深度+1)。**
 *   保证「直接命中」永远压过「拐了两道弯想起来的」。
 *
 * 4. **递归深度硬上限 3**（台账原文），且环靠 `visited` 集合断，
 *   不靠深度兜底：A→B→A 在深度 1 就该被 `visited` 拦住，
 *   等深度撞上限才停意味着中间白跑两轮、还可能带进无关的卡。
 *
 * 5. **一个字的触发词不参加匹配**（除非配置把它降到 1）：单字命中率接近 100%，
 *   那不是"触发"，是"每轮都用"。
 */

import type {
  ExclusionMode,
  SceneCard,
  SceneExclusion,
  SceneHit,
  ScenePlan,
} from './types.js'

/** 否定词（**紧邻**命中位置时判为否定语境）。 */
const NEGATIONS = ['不', '没', '別', '别', '无', '勿', '非', '未']

/**
 * 否定窗口：只看命中位置**前 1 个字**。
 *
 * 这是实测逼出来的边界：窗口取 2 时，`你是不是胖了` 的窗口是「不是」，
 * 于是「被说胖」这张卡在**最常出现的问法**上永远不触发；
 * 而 `我不胖`（窗口「不」）照样拦得住。
 * 取舍理由：误触发只是语气略偏，漏触发是「她不像她」——宁可多触发一次。
 */
const NEGATION_WINDOW = 1

/** 引号内的词（作者用引号标出来的"就是这几个词"）。 */
const QUOTED = /「([^」]+)」|『([^』]+)』|“([^”]+)”|"([^"]+)"/g

/** 触发栏里的分隔符。 */
const SEPARATORS = /[、，,;；/／|]/

/** 触发栏前缀里常见的动词/主语，剥掉它们才不会把「出现」「用户」当成触发词。 */
const LEAD_VERBS = /^(?:出现|涉及|提到|说到|谈到|问到|聊到|遇到|触及|关于|用户|对方|她|被|说|问|嫌|要求|直接问)/

/**
 * 这些词单独成词时一律丢掉：它们是**描述**，不是**触发内容**。
 * 不丢的话「出现」会让每张写「出现 XX」的卡都对任何含"出现"的句子命中。
 */
const STOP_TERMS = new Set([
  '出现',
  '涉及',
  '提到',
  '说到',
  '谈到',
  '问到',
  '聊到',
  '遇到',
  '触及',
  '关于',
  '用户',
  '对方',
  '会话开始',
  '用户第一句话',
  '第一句话',
])

/** 单个触发词的字符上限（再长就不可能逐字出现）。 */
const TERM_MAX = 24

/** 单张卡最多保留多少个触发词。 */
const TERMS_MAX = 24

/**
 * 一眼就能看出不是词的垃圾：行内栏名残渣、句号、冒号。
 *
 * 这些不是"不好"，是**结构错误的证据**：`**。**表面**：冷脸` 这种词只可能来自
 * 「一行挤了多栏且没拆」。留一道闸，是为了让下一次格式变化表现为「词少了」，
 * 而不是「命中了一些莫名其妙的句子」。
 */
const GARBAGE = /\*\*|：|:|。/

/**
 * 判断一个词能不能当触发词。
 * @param term 词。
 * @param minChars 最短字数。
 */
export function isUsableTerm(term: string, minChars: number): boolean {
  if (term.length < minChars || term.length > TERM_MAX) return false
  if (STOP_TERMS.has(term)) return false
  if (GARBAGE.test(term)) return false
  // 纯标点 / 纯空白不算词。
  return /[\p{L}\p{N}]/u.test(term)
}

/**
 * 归一化：小写、全角标点折成空格、压掉连续空白。
 *
 * **不做同义词替换、不做繁简转换**：那会让「命中了哪个词」这句话失去意义
 * （`plan().terms` 报出来的词在原文里其实没出现，审计就废了）。
 * @param text 原文。
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。！？、；：""''（）《》【】…—～·,.!?;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 合并多组词并去重（保序）。
 * @param lists 词表。
 * @param max 上限。
 */
export function mergeTerms(lists: readonly (readonly string[])[], max: number): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of lists) {
    for (const term of list) {
      if (seen.has(term)) continue
      seen.add(term)
      out.push(term)
      if (out.length >= max) return out
    }
  }
  return out
}

/**
 * 引号内的词单字也收。
 *
 * 理由：作者用引号写 `出现"胖""肥""圆滚滚"`，就是在说"这三个字就是触发词"。
 * 单字的风险由两道闸兜住——否定邻域（`不胖` 不算）与「同词最多计 2 次」；
 * 而拒收它的代价是「被说胖」这张最常用的卡永远不生效，
 * 且日志显示它"有触发词"，谁也不会去查。
 */
const QUOTED_MIN_CHARS = 1

/**
 * 从**标题**里抽词：只取引号内的内容。
 *
 * 这是被真实数据逼出来的：`哦鲸鲸` 的 `触发` 栏大多写成叙述句
 * （`用户直接问身份` / `任务需要资源，或她想让人留下来`），逐字匹配永远命中不了；
 * 而同一张卡的**标题**里有用户真正会说的话——`被问"你是不是 AI"`。
 * 只从标题取引号内容，不取整句：整句会变成"只有一字不差才命中"的假触发词。
 *
 * **不接受 `minTermChars`**：本函数的词**全部**来自引号，而引号内容是作者
 * 亲自点名的触发词，按 `QUOTED_MIN_CHARS`（1 字）收——同一套判据见
 * `extractTerms()` 的引号分支。把 `minTermChars` 传进来只会造出一个
 * 「配置说 2 字、行为按 1 字」的假参数，故本函数不收这个入参。
 * @param title 标题。
 */
export function extractTitleTerms(title: string): readonly string[] {
  const out: string[] = []
  QUOTED.lastIndex = 0
  let match: RegExpExecArray | null = QUOTED.exec(title)
  while (match !== null) {
    const span = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? '').trim()
    for (const piece of span.split(SEPARATORS)) {
      const term = piece.trim()
      if (isUsableTerm(term, QUOTED_MIN_CHARS)) out.push(term)
    }
    match = QUOTED.exec(title)
  }
  return mergeTerms([out], TERMS_MAX)
}

/**
 * 从 `触发` 栏抽出关键词。
 *
 * 先取引号内的词（作者已经指明了），再把剩下的按分隔符切开并剥掉前缀动词。
 * @param trigger `触发` 栏原文。
 * @param minChars 最短字数（只约束非引号来源）。
 */
export function extractTerms(trigger: string, minChars: number): readonly string[] {
  const out: string[] = []
  const push = (raw: string, min: number): void => {
    const term = raw.trim().replace(/^["'「」『』《》]+|["'「」『』《》]+$/g, '').trim()
    if (isUsableTerm(term, min)) out.push(term)
  }

  QUOTED.lastIndex = 0
  let match: RegExpExecArray | null = QUOTED.exec(trigger)
  while (match !== null) {
    push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '', QUOTED_MIN_CHARS)
    match = QUOTED.exec(trigger)
  }
  const rest = trigger.replace(QUOTED, '，')
  for (const chunk of rest.split(SEPARATORS)) {
    const cleaned = chunk.trim().replace(LEAD_VERBS, '').trim()
    if (cleaned.length === 0) continue
    push(cleaned, minChars)
    if (out.length >= TERMS_MAX) break
  }
  return mergeTerms([out], TERMS_MAX)
}

/**
 * 数一个词在文本里出现了几次（**跳过否定语境**）。
 * @param hay 已归一化的文本。
 * @param needle 已归一化的词。
 * @param guard 是否启用否定保护。
 * @param cap 计数上限（超过就没意义了，早停省时间）。
 */
export function countTerm(hay: string, needle: string, guard: boolean, cap: number): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  while (count < cap) {
    const at = hay.indexOf(needle, from)
    if (at < 0) break
    from = at + needle.length
    if (guard && isNegated(hay, at)) continue
    count += 1
  }
  return count
}

/**
 * 命中位置是否处于否定语境。
 * @param hay 文本。
 * @param at 命中起始下标。
 */
function isNegated(hay: string, at: number): boolean {
  const from = Math.max(0, at - NEGATION_WINDOW)
  const window = hay.slice(from, at)
  for (const negation of NEGATIONS) {
    if (window.includes(negation)) return true
  }
  return false
}

/** 一张卡的原始命中结果。 */
export interface CardScore {
  readonly score: number
  readonly terms: readonly string[]
}

/**
 * 去掉所有空白（用于纯中文词的"贴紧"比对）。
 *
 * 为什么需要：标题里引号内的原话常带空格——`被问"你是不是 AI"`，
 * 而用户打的是「你是不是AI」。不贴紧比对，这条最常用的触发词永远命中不了，
 * 现象是「这张卡从来不生效」，而日志显示它"有触发词"。
 * 只在词里**不含拉丁字母**时贴紧：英文词一旦去空格，`ai` 会命中 `said`。
 * @param text 文本。
 */
export function tighten(text: string): string {
  return text.replace(/\s+/g, '')
}

/**
 * 两层文本：原样归一化 + 贴紧版。
 * @param text 原文。
 */
export function prepare(text: string): { readonly hay: string; readonly tight: string } {
  const hay = normalize(text)
  return { hay, tight: tighten(hay) }
}

/**
 * 给一张卡打分。
 *
 * 权重口径：4 字及以上的词算 2 分，短词算 1 分；同一个词最多计 2 次
 * （复述一次是强调，复述十次不该等于十张卡）。
 * @param card 卡。
 * @param hay 已归一化的文本。
 * @param tight 贴紧版文本。
 * @param guard 否定保护。
 */
export function scoreCard(card: SceneCard, hay: string, tight: string, guard: boolean): CardScore {
  let score = 0
  const terms: string[] = []
  for (const term of card.triggers) {
    const needle = normalize(term)
    if (needle.length === 0) continue
    const latin = /[a-z]/.test(needle)
    const text = latin ? hay : tight
    const word = latin ? needle : tighten(needle)
    const hits = countTerm(text, word, guard, 2)
    if (hits === 0) continue
    const weight = word.length >= 4 ? 2 : 1
    score += weight * hits
    terms.push(term)
  }
  return { score, terms }
}

/** 排序：有效分降序 → priority 降序 → id 升序（稳定）。 */
function compareHits(a: SceneHit, b: SceneHit): number {
  if (a.effective !== b.effective) return b.effective - a.effective
  if (a.card.priority !== b.card.priority) return b.card.priority - a.card.priority
  return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0
}

/**
 * 互斥裁决：同一组里只留一张。
 * @param hits 候选（函数内不改入参）。
 * @param mode 粒度。
 */
export function applyExclusion(
  hits: readonly SceneHit[],
  mode: ExclusionMode,
): { readonly survivors: readonly SceneHit[]; readonly excluded: readonly SceneExclusion[] } {
  if (mode === 'off') return { survivors: hits.slice().sort(compareHits), excluded: [] }
  const winners = new Map<string, SceneHit>()
  const excluded: SceneExclusion[] = []
  for (const hit of hits.slice().sort(compareHits)) {
    const key = exclusionKey(hit.card, mode)
    if (key === undefined) {
      // 这个粒度下不参与互斥（例如 `slot` 模式里没声明槽的卡）：直接活。
      winners.set('\u0000' + hit.card.id, hit)
      continue
    }
    const current = winners.get(key)
    if (current === undefined) {
      winners.set(key, hit)
      continue
    }
    excluded.push({
      id: hit.card.id,
      title: hit.card.title,
      lostTo: current.card.id,
      reason: mode,
    })
  }
  return { survivors: Array.from(winners.values()).sort(compareHits), excluded }
}

/**
 * 取互斥键。`undefined` 表示这张卡在该粒度下不参与互斥。
 * @param card 卡。
 * @param mode 粒度。
 */
function exclusionKey(card: SceneCard, mode: ExclusionMode): string | undefined {
  switch (mode) {
    case 'group':
      return 'g:' + card.groupId
    case 'layer':
      return 'l:' + card.layer
    case 'slot':
      return card.slot.length === 0 ? undefined : 's:' + card.slot
    case 'off':
      return undefined
  }
}

/** 递归展开入参。 */
export interface ExpandInput {
  /** 全部卡。 */
  readonly cards: readonly SceneCard[]
  /** 直接命中的赢家。 */
  readonly seeds: readonly SceneHit[]
  /** 已经出现过的卡 id（避免 A→B→A）。 */
  readonly visited: ReadonlySet<string>
  /** 深度上限。 */
  readonly maxDepth: number
}

/**
 * 从赢家出发递归展开。
 * @param input 入参。
 */
export function expand(input: ExpandInput): { readonly hits: readonly SceneHit[]; readonly depth: number } {
  const out: SceneHit[] = []
  let frontier: SceneHit[] = input.seeds.slice()
  const visited = new Set<string>(input.visited)
  let depth = 0
  while (depth < input.maxDepth && frontier.length > 0) {
    const next: SceneHit[] = []
    for (const parent of frontier) {
      for (const card of input.cards) {
        if (visited.has(card.id)) continue
        if (card.titleKey.length < 2) continue
        if (!parent.card.raw.includes(card.titleKey)) continue
        const newDepth = depth + 1
        const score = parent.score * 0.6
        const hit: SceneHit = {
          card,
          score,
          // 有效分 = 分数 ÷ (深度+1)：直接命中（深度 0）永远压过拐了弯的。
          effective: score / (newDepth + 1),
          depth: newDepth,
          terms: [card.titleKey],
          via: 'recursive',
          parentId: parent.card.id,
        }
        visited.add(card.id)
        out.push(hit)
        next.push(hit)
      }
    }
    if (next.length === 0) break
    depth += 1
    frontier = next
  }
  return { hits: out, depth }
}

/** 判定入参。 */
export interface JudgeInput {
  readonly cards: readonly SceneCard[]
  readonly text: string
  readonly exclusion: ExclusionMode
  readonly maxDepth: number
  readonly guard: boolean
}

/**
 * 判一轮。
 * @param input 入参。
 */
export function judge(input: JudgeInput): ScenePlan {
  const { hay, tight } = prepare(input.text)
  const direct: SceneHit[] = []
  for (const card of input.cards) {
    const scored = scoreCard(card, hay, tight, input.guard)
    if (scored.score <= 0) continue
    direct.push({
      card,
      score: scored.score,
      effective: scored.score,
      depth: 0,
      terms: scored.terms,
      via: 'direct',
      parentId: undefined,
    })
  }

  // 1. 先互斥，再从赢家递归（见文件头第 1 条）。
  const first = applyExclusion(direct, input.exclusion)
  const excluded: SceneExclusion[] = first.excluded.slice()
  const directIds = new Set(direct.map(hit => hit.card.id))

  // 2. 递归：visited 含**所有直接命中**（含被淘汰的），避免"淘汰的那张又被带回来"。
  const expansion = expand({
    cards: input.cards,
    seeds: first.survivors,
    visited: directIds,
    maxDepth: input.maxDepth,
  })

  // 3. 递归出来的卡也要过一遍互斥；但已经有赢家的组不再接受新卡。
  const taken = new Set(first.survivors.map(hit => exclusionKey(hit.card, input.exclusion) ?? '\u0000' + hit.card.id))
  const recursive: SceneHit[] = []
  for (const hit of expansion.hits.slice().sort(compareHits)) {
    const key = exclusionKey(hit.card, input.exclusion) ?? '\u0000' + hit.card.id
    if (taken.has(key)) {
      excluded.push({
        id: hit.card.id,
        title: hit.card.title,
        lostTo: first.survivors[0] === undefined ? '' : first.survivors[0].card.id,
        reason: input.exclusion === 'off' ? 'group' : input.exclusion,
      })
      continue
    }
    taken.add(key)
    recursive.push(hit)
  }

  const hits = first.survivors.concat(recursive).sort(compareHits)
  const terms = new Set<string>()
  for (const hit of direct) for (const term of hit.terms) terms.add(term)
  return {
    hits,
    excluded,
    depth: expansion.depth,
    terms: Array.from(terms),
    excerpt: input.text.length > 120 ? input.text.slice(0, 120) + '…' : input.text,
  }
}
