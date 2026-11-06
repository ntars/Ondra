/**
 * 建索引与渲染索引块。
 *
 * 这个文件负责「把记忆库读成一段能塞进 prompt 的稳定文本」，三件事按顺序发生：
 *
 * 1. **选集合**：先排除封存（恒）/ 沉底（按配置）/ 空正文，再按显著度取前 N 条；
 * 2. **排序**：按 `seq`（= `createdAt` 排名）升序——新条目永远在尾部，旧块恒是新块的前缀；
 * 3. **装箱**：逐行累加估算 token，装不下就跳过这一条继续试下一条（不是「到此为止」）。
 *
 * 第 2 与第 3 的顺序不能换：先装后排会让新条目插到中间，等于每加一条记忆就重写整块。
 *
 * 为什么「装不下跳过继续试」而不是「停下」：手册 §2.6 的装箱制就是这个口径
 * （「按权重全局排序逐条装，装不下跳过继续试」）。停下来会让一条长记忆把后面几十条
 * 全挡在门外，而它只是「这一条太长」，不是「预算用完了」。
 */

import type { IndexEntry, MemoryRecordLike } from './types.js'
import { assignSlugs } from './slug.js'
import { bigramsOf, charLengthOf, estTokensOf, extractTriggers, linksOf, normalizeText } from './text.js'

/** 建索引的参数（由 `settings.ts` 给出，本文件不读配置）。 */
export interface BuildOptions {
  /** 最多进几条。 */
  readonly maxEntries: number
  /** token 预算。 */
  readonly indexBudgetTokens: number
  /** 单行字符上限（含 slug）。 */
  readonly entryCharLimit: number
  /** 每条最多几个触发词。 */
  readonly triggersPerEntry: number
  /** 是否把已沉底的记忆也纳入索引。 */
  readonly includeArchived: boolean
}

/** 建索引结果。 */
export interface BuildResult {
  /** 索引条目（已按 `seq` 升序）。 */
  readonly entries: readonly IndexEntry[]
  /** 索引正文（只含索引行，见 `types.ts` 文件头第 2 条）。 */
  readonly text: string
  /** 因条数上限或 token 预算没进块的条数。 */
  readonly omitted: number
  /** 字符数。 */
  readonly chars: number
  /** 估算 token。 */
  readonly estTokens: number
  /** 内容哈希。 */
  readonly revision: string
  /** 被排除的原因计数（诊断用，不进块）。 */
  readonly skipped: {
    /** 封存（恒排除，无开关）。 */
    readonly sealed: number
    /** 沉底（配置排除时计数）。 */
    readonly archived: number
    /** 正文为空。 */
    readonly empty: number
  }
}

/** 一条记忆能不能进索引。 */
function admittable(record: MemoryRecordLike, includeArchived: boolean): 'ok' | 'sealed' | 'archived' | 'empty' {
  // 封存恒排除，且**没有开关**（手册 §2.4 + O-014 同一铁律）。
  if (record.sealed === true) return 'sealed'
  if (includeArchived !== true && record.archived === true) return 'archived'
  if (typeof record.text !== 'string' || record.text.trim() === '') return 'empty'
  return 'ok'
}

/** 稳定排序：`createdAt` 升序，同值按 id 字典序（码位比较，不依赖 locale）。 */
function compareForSeq(left: MemoryRecordLike, right: MemoryRecordLike): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * 渲染一行。
 *
 * 逐词添加而不是整段截断：整段截断会把「周五考试」切成「周五考」，
 * 而模型看到半个词比看不到这个词更糟——它会往那个方向编。
 * @param slug 短名。
 * @param triggers 触发词。
 * @param limit 字符上限。
 */
export function renderLine(slug: string, triggers: readonly string[], limit: number): string {
  let line = slug
  for (const trigger of triggers) {
    if (trigger === '') continue
    const next = `${line} ${trigger}`
    if (charLengthOf(next) > limit) break
    line = next
  }
  return line
}

/**
 * 建索引。
 * @param records 记忆记录（`listFacts` 的原样输出）。
 * @param options 参数。
 */
export function buildIndex(records: readonly MemoryRecordLike[], options: BuildOptions): BuildResult {
  const skipped = { sealed: 0, archived: 0, empty: 0 }
  const alive: MemoryRecordLike[] = []
  for (const record of records) {
    const verdict = admittable(record, options.includeArchived)
    if (verdict === 'ok') alive.push(record)
    else skipped[verdict] += 1
  }

  // `seq` 只在这一步确定：稳定排序 → 下标 +1。它不依赖索引重建了几次，
  // 所以「同一批记忆在任何机器上都是同一批 seq」。
  const ordered = [...alive].sort(compareForSeq)
  const slugs = assignSlugs(ordered)

  const entries: IndexEntry[] = []
  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index]
    const slug = slugs.get(record.id)
    if (slug === undefined) continue
    const summary = typeof record.summary === 'string' && record.summary.trim() !== '' ? record.summary : null
    const grams = [...bigramsOf(`${record.text}\n${summary ?? ''}`)].sort()
    entries.push({
      id: record.id,
      slug,
      seq: index + 1,
      triggers: extractTriggers(record.text, summary, options.triggersPerEntry),
      // 二元组上限 400：正文已被 O-010 截到 ≤200 字，二元组最多 199 个，
      // 这个上限只是防止调用方传进一条没截断的长文把内存吃掉。
      grams: grams.slice(0, 400),
      text: normalizeText(`${record.text}\n${summary ?? ''}`),
      links: linksOf(record.text),
      createdAt: record.createdAt,
      salience: Number.isFinite(record.salience) ? record.salience : 0,
    })
  }

  // 选集合：显著度高的优先留下。同分按 seq 升序（更早的记忆更该被认出——
  // 它是「长期事实」，而最近的记忆还有短时上下文保底）。
  const bySalience = [...entries].sort((left, right) => {
    if (right.salience !== left.salience) return right.salience - left.salience
    return left.seq - right.seq
  })
  const keep = new Set<string>()
  for (const entry of bySalience) {
    if (keep.size >= options.maxEntries) break
    keep.add(entry.id)
  }

  // 装箱：按 seq 升序逐行装，装不下跳过继续试。
  const lines: string[] = []
  const packed: IndexEntry[] = []
  let estTokens = 0
  let omitted = entries.length - keep.size
  for (const entry of entries) {
    if (!keep.has(entry.id)) continue
    const line = renderLine(entry.slug, entry.triggers, options.entryCharLimit)
    const cost = estTokensOf(line) + 1 // +1 是换行
    if (estTokens + cost > options.indexBudgetTokens) {
      omitted += 1
      continue
    }
    lines.push(line)
    packed.push(entry)
    estTokens += cost
  }

  const text = lines.join('\n')
  return {
    // `entries` 只回传**真正进块**的那些，否则 `indexState().entries` 会报一个
    // 比 prompt 里多得多得数，而那个数字会被界面当成「索引里有这么多条」。
    entries: packed,
    text,
    omitted,
    chars: charLengthOf(text),
    estTokens,
    revision: revisionOf(text, optionsFingerprint(options)),
    skipped,
  }
}

/**
 * 内容哈希。
 *
 * 直接对整块文本做 FNV-1a：块内容变了哈希就变，不存在「哈希没变但内容变了」。
 * 额外掺入 `salt` 是为了让「同一文本、不同构建参数」也能被区分（例如预算从 6000
 * 调到 12000，块文本可能一模一样，但「这一块代表什么」已经不同）。
 * @param text 块文本。
 * @param salt 参数指纹。
 */
export function revisionOf(text: string, salt: string): string {
  const joined = `${text}|${salt}`
  let hash = 0x811c9dc5
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 参数指纹（进 `revision` 的 `salt`）。
 * @param options 参数。
 */
export function optionsFingerprint(options: BuildOptions): string {
  return [
    options.maxEntries,
    options.indexBudgetTokens,
    options.entryCharLimit,
    options.triggersPerEntry,
    options.includeArchived ? 1 : 0,
  ].join(',')
}
