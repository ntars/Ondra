/**
 * 确定性识别（同步那 2ms）：slug 精确命中 / 触发词包含 / 二元组重合 / `[[links]]` 邻域游走。
 *
 * 这个文件**不调模型、不做 IO**。它存在的理由是：查询一来就得给答案，
 * 而等一个 0.4s 的模型调用会让「她想起什么」变成「她正在想」。
 *
 * 四条分档为什么是这些数（全部 derived，手册只给了「确定性命中 ~2ms」一句）：
 *
 * | 情形 | 分 | 理由 |
 * |---|---|---|
 * | 查询里出现 slug | 1.00 | 这是作者/工具显式写的入口，最可信 |
 * | 触发词与查询完全相等 | 0.92 | 一个词对上整句，几乎不会错 |
 * | 查询包含某个触发词 | 0.55 + 0.05×长度 | 越长越具体；4 字给 0.75，6 字给 0.85 |
 * | 查询被某个触发词包含 | 0.50 + 0.04×长度 | 用户只说了半句（「考试」），弱一档但仍算 |
 * | 二元组重合 | 0.30 + 0.45×重合比 | 兜底：同一个主题换了说法 |
 *
 * 全部低于 0.30 的丢掉（`minScore` 默认 0.30）。这一条也要说清楚：
 * **它不是「召回裁剪」**——被丢的条目本来就没被识别出来，不构成「有证据却被砍」。
 */

import type { IndexEntry } from './types.js'
import { RING_WEIGHTS } from './types.js'
import { charLengthOf, gramOverlap, triggerRelation } from './text.js'

/** 一次匹配命中（带「怎么被认出来的」）。 */
export interface MatchHit {
  /** 记忆 id。 */
  readonly id: string
  /** 识别分 0–1。 */
  readonly score: number
  /** 认出来的方式。 */
  readonly via: 'slug' | 'trigger' | 'gram' | 'ring'
}

/** 匹配参数。 */
export interface MatchOptions {
  /** 低于它丢掉。 */
  readonly minScore: number
  /** 最多几个种子参与游走。 */
  readonly maxSeeds: number
  /** 最多走几圈（0 = 不游走）。 */
  readonly maxRing: number
  /** 返回上限。 */
  readonly limit: number
}

/** 条目索引（三种查找入口）。 */
export interface EntryIndex {
  /** id → 条目。 */
  readonly byId: ReadonlyMap<string, IndexEntry>
  /** slug → 条目。 */
  readonly bySlug: ReadonlyMap<string, IndexEntry>
  /** 触发词 → 条目（重复时取 seq 最小的那条，保证确定性）。 */
  readonly byTrigger: ReadonlyMap<string, IndexEntry>
}

/**
 * 建查找索引。
 * @param entries 条目。
 */
export function indexEntries(entries: readonly IndexEntry[]): EntryIndex {
  const byId = new Map<string, IndexEntry>()
  const bySlug = new Map<string, IndexEntry>()
  const byTrigger = new Map<string, IndexEntry>()
  for (const entry of entries) {
    byId.set(entry.id, entry)
    bySlug.set(entry.slug, entry)
    for (const trigger of entry.triggers) {
      const previous = byTrigger.get(trigger)
      // 同一个触发词挂在多条记忆上很常见（「考试」可能属于两条）。取 seq 最小的，
      // 理由是确定性：靠「谁先遍历到」会随数组顺序变，而 seq 是稳定量。
      if (previous === undefined || entry.seq < previous.seq) byTrigger.set(trigger, entry)
    }
  }
  return { byId, bySlug, byTrigger }
}

/** 单条打分（不含游走）。 */
function scoreEntry(entry: IndexEntry, query: string, queryGrams: ReadonlySet<string>): { score: number; via: MatchHit['via'] } {
  // ① slug 直接出现在查询里（用户打了「fod-a1b2」或工具回传了 slug）。
  if (query.includes(entry.slug)) return { score: 1, via: 'slug' }

  let best = 0
  let via: MatchHit['via'] = 'gram'
  for (const trigger of entry.triggers) {
    const relation = triggerRelation(query, trigger)
    if (relation === 'none') continue
    let score = 0
    if (relation === 'equal') score = 0.92
    else if (relation === 'contains') {
      // 查询包含触发词：越长越具体。
      score = Math.min(0.88, 0.55 + 0.05 * Math.min(6, charLengthOf(trigger)))
    } else {
      // 查询被触发词包含：用户只说了半句。长度按查询算，短查询不该被高估。
      score = Math.min(0.7, 0.5 + 0.04 * Math.min(5, charLengthOf(query)))
    }
    if (score > best) {
      best = score
      via = 'trigger'
    }
  }
  if (best > 0) return { score: best, via }

  const ratio = gramOverlap(queryGrams, entry.grams)
  if (ratio > 0) return { score: Math.min(0.75, 0.3 + 0.45 * ratio), via: 'gram' }
  return { score: 0, via }
}

/**
 * 确定性匹配（第一轮，不含游走）。
 * @param entries 条目。
 * @param query 已归一化的查询。
 * @param queryGrams 查询的二元组。
 * @param minScore 门槛。
 */
export function matchEntries(
  entries: readonly IndexEntry[],
  query: string,
  queryGrams: ReadonlySet<string>,
  minScore: number,
): readonly MatchHit[] {
  if (query === '') return []
  const hits: MatchHit[] = []
  for (const entry of entries) {
    const { score, via } = scoreEntry(entry, query, queryGrams)
    if (score < minScore || score <= 0) continue
    hits.push({ id: entry.id, score, via })
  }
  // 分降序；同分按 id 字典序（不允许「顺序随实现变」，否则同一句话两次查询结果不同）。
  hits.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  return hits
}

/**
 * 解析一个 `[[links]]` 目标。
 *
 * 顺序是**刻意**的：slug → id → 触发词。前两个是「精确标识」，最后一个才是「按词找」。
 * 反过来先按触发词找，一条记忆改了触发词就会把旧链接指向别处——那是静默的错指。
 *
 * slug 用**归一化后**的值查：正文里写 `[[ FOD-A1B2 ]]`（带空格、带大写）是很自然的事，
 * 而 slug 本身是小写的，用原文查会查不到——表现为「链接写了却走不过去」，且不报错。
 * id 两种都试：O-010 生成的 id 是小写，但调用方自定的 id 不一定。
 * @param target 目标原文（未归一化）。
 * @param index 查找索引。
 * @param query 已归一化的目标。
 */
export function resolveTarget(target: string, index: EntryIndex, query: string): IndexEntry | undefined {
  const direct = index.bySlug.get(query) ?? index.byId.get(target) ?? index.byId.get(query)
  if (direct !== undefined) return direct
  return index.byTrigger.get(query)
}

/**
 * `[[links]]` 邻域游走。
 *
 * 圈权重取 `RING_WEIGHTS`（借用 §2.3 三圈权重，见 `types.ts` 注释）。
 * 同一条记忆取**经过的所有路径里的最高分**，且只走一次——不走「反复折返刷分」，
 * 那样会让一个枢纽节点把全库拉平。
 * @param index 查找索引。
 * @param seeds 第一轮命中（已按分降序）。
 * @param options 参数。
 */
export function walkLinks(index: EntryIndex, seeds: readonly MatchHit[], options: MatchOptions): readonly MatchHit[] {
  if (options.maxRing <= 0 || seeds.length === 0) return []
  const best = new Map<string, MatchHit>()
  for (const seed of seeds.slice(0, options.maxSeeds)) {
    best.set(seed.id, seed)
  }

  let frontier: { id: string; score: number }[] = [...best.values()].map(hit => ({ id: hit.id, score: hit.score }))
  const visited = new Set<string>(frontier.map(item => item.id))

  for (let ring = 1; ring <= options.maxRing; ring += 1) {
    const weight = RING_WEIGHTS[ring] ?? 0
    if (weight <= 0) break
    const next: { id: string; score: number }[] = []
    for (const node of frontier) {
      const entry = index.byId.get(node.id)
      if (entry === undefined) continue
      for (const target of entry.links) {
        // `[[links]]` 的目标可能带空格或标点，归一化后再查（slug/id 是 ASCII，
        // 归一化不会改它们；触发词则需要归一化才能对上）。
        const normalized = target.trim().toLowerCase()
        const found = resolveTarget(target, index, normalized)
        if (found === undefined) continue
        const score = node.score * weight
        if (score < options.minScore) continue
        const previous = best.get(found.id)
        if (previous === undefined || score > previous.score) {
          best.set(found.id, { id: found.id, score, via: 'ring' })
        }
        if (!visited.has(found.id)) {
          visited.add(found.id)
          next.push({ id: found.id, score })
        }
      }
    }
    if (next.length === 0) break
    frontier = next
  }

  return [...best.values()]
}

/**
 * 合并第一轮与游走结果（同 id 取高分，`via` 跟着高分那一条）。
 * @param direct 第一轮。
 * @param walked 游走。
 * @param limit 返回上限。
 */
export function mergeHits(direct: readonly MatchHit[], walked: readonly MatchHit[], limit: number): readonly MatchHit[] {
  const merged = new Map<string, MatchHit>()
  for (const hit of [...direct, ...walked]) {
    const previous = merged.get(hit.id)
    if (previous === undefined || hit.score > previous.score) merged.set(hit.id, hit)
  }
  const out = [...merged.values()]
  out.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  return out.slice(0, Math.max(1, limit))
}
