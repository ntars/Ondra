/**
 * 召回服务：把「这句话让她想起什么」接到 O-010 的记忆内核与 O-015 的图谱上。
 * **只经服务键调用，不 import 任何插件源码**（§18.5）。
 *
 * 一轮召回的六个步骤（顺序不能换）：
 *
 * 1. **取语料**：分页全量读 `memory_fact`，**排除封存**。分页不是为了限条数，
 *    是因为端口单次查询有硬上限；`maxScanRows` 默认 0 = 不设窗口。
 * 2. **建 / 复用索引**：索引建在「非封存全量」上，与单次请求的 `includeArchived`
 *    无关——否则同一个库会因为两种请求来回重建索引。
 * 3. **四条通道各跑一遍**：罕见词、二元组（BM25）、向量、recognition。
 *    前两条自带，后两条缺席即退出。
 * 4. **融合**：`rrf` 按名次，`weighted` 按五因子加权和。
 * 5. **算五因子**：关键词取 BM25 原始分压到 0–1；图谱取与种子的 1 跳最大边权；
 *    重要取 `salience/100`；新鲜取 `0.5^(Δt/S)`，S 直接用内核给的当前值。
 * 6. **排序 + 过滤**：沉底项按 `includeArchived` 过滤，主体按 `subject` 过滤。
 *    **一步都不按条数砍**——`dropped` 恒为 0（手册 §12.1 P0 第二条）。
 *
 * 为什么「过滤」不算砍条数：过滤条件都是**语义条件**（封存 / 沉底 / 主体），
 * 满足条件的条目一条不少地返回。`topK` 那种「第 11 条以后不要」才是砍。
 */

import { probeRecognition, probeVector } from './external.js'
import { compareFused, rrfFuse, weightedRank } from './fuse.js'
import type { ChannelList } from './fuse.js'
import { buildIndex, queryGramsOf, searchBigram, searchRare, unknownGramsOf } from './lexical.js'
import type { LexicalIndex, RankedItem } from './lexical.js'
import { composeFactors, freshnessOf, importanceOf, keywordFactorOf, toFactorsView } from './score.js'
import type { FactorInput } from './score.js'
import { normalizeText, sharedGramsOf } from './tokenize.js'
import { RecallError, SPEC_WEIGHTS } from './types.js'
import type { Config } from './settings.js'
import type {
  ChannelState,
  GraphLike,
  LogLike,
  MemoryCoreLike,
  MemoryRecordLike,
  RecallExplanation,
  RecallFactors,
  RecallHit,
  RecallIndexState,
  RecallPathHit,
  RecallRequest,
  RecallResult,
  RecallService,
  RecallStats,
  RecallUnavailableReason,
  RecognitionSourceLike,
  VectorSourceLike,
} from './types.js'

/** 服务键与因子名原样转出，便于自检脚本与界面按同一份常量渲染。 */
export { RECALL_FACTORS, RECALL_SERVICE_KEY } from './types.js'

/** 索引缓存的安全阀：单次扫描最多翻这么多页，防「端口返回不满一页却永远不空」的死循环。 */
const MAX_PAGES = 400

/** 语料快照。 */
interface Corpus {
  /** 非封存全量。 */
  readonly records: readonly MemoryRecordLike[]
  /** id → 记录。 */
  readonly byId: ReadonlyMap<string, MemoryRecordLike>
  /** 实际扫描条数。 */
  readonly scanned: number
  /** 是否被 `maxScanRows` 截断。 */
  readonly truncated: boolean
}

/** 索引缓存。 */
interface IndexCache {
  readonly index: LexicalIndex
  readonly size: number
  readonly builtAt: number
}

/** 一次评估的中间结果（`search` 与 `explain` 共用，保证两者看到同一轮候选）。 */
interface Evaluation {
  readonly result: RecallResult
  readonly corpus: Corpus
  readonly hitsById: ReadonlyMap<string, RecallHit>
  readonly query: string
}

/** 召回实现。 */
export class RecallRepository implements RecallService {
  private readonly core: MemoryCoreLike | undefined
  private readonly graph: GraphLike | undefined
  private readonly vector: VectorSourceLike | undefined
  private readonly recognition: RecognitionSourceLike | undefined
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number
  /** 不可用原因（`RecallService.reason` 的实现，构造时定下，不回改）。 */
  readonly reason: RecallUnavailableReason | undefined

  private cache: IndexCache | undefined
  private lastErrorText: string | undefined
  private readonly counters: { queries: number; hits: number; ms: number } = { queries: 0, hits: 0, ms: 0 }

  /**
   * @param core 记忆内核（可能缺席）。
   * @param graph 图谱服务（可能缺席）。
   * @param vector 向量分支（可能缺席）。
   * @param recognition recognition 分支（可能缺席）。
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   */
  constructor(
    core: MemoryCoreLike | undefined,
    graph: GraphLike | undefined,
    vector: VectorSourceLike | undefined,
    recognition: RecognitionSourceLike | undefined,
    settings: Config,
    log: LogLike,
    now: () => number,
  ) {
    this.core = core
    this.graph = graph
    this.vector = vector
    this.recognition = recognition
    this.settings = settings
    this.log = log
    this.now = now
    this.reason = deriveReason(core, settings)
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.reason === undefined
  }

  /**
   * 本轮要不要把已沉底的记忆也算进来。
   *
   * ## 为什么必须走这个方法，而不是直接读 `request.includeArchived`
   *
   * 设置页里有一个同名开关（`includeArchived`，默认关）。在本次修复之前，
   * 它**从来没有被任何一行代码读过**——请求参数一省略，判定就退化成字面量
   * `request.includeArchived === true` → `false`，于是用户把设置页那个开关
   * 打开、重启，行为一模一样：沉底的记忆照样不参与召回。这是个安静的假开关。
   *
   * ## 优先级：请求参数 > 配置
   *
   * 请求参数是**单轮覆盖**（`RecallRequest.includeArchived` 的原文：
   * 「默认 `false`（沉底的不该主动冒头）」——它说的是缺省值该往哪边倒，
   * 不是「永远不许打开」）。调用方显式传了就听调用方，没传才落到配置。
   * 这也让配置项第一次真的有了意义：它决定的是**缺省行为**。
   *
   * 注意 `false` 也是显式值：调用方传 `false` 时不能因为配置是 `true` 就被翻回来，
   * 所以判据是 `typeof === 'boolean'`，不是真值判断。
   * @param request 召回请求。
   */
  private archivedIncluded(request: RecallRequest): boolean {
    return typeof request.includeArchived === 'boolean'
      ? request.includeArchived
      : this.settings.includeArchived
  }

  /**
   * 召回。
   * @param request 请求。
   */
  search(request: RecallRequest): RecallResult {
    return this.evaluate(request).result
  }

  /**
   * 解释某一条为什么在 / 不在结果里。
   * @param id 记忆 id。
   * @param request 与 `search` 同一请求。
   */
  explain(id: string, request: RecallRequest): RecallExplanation {
    const evaluation = this.evaluate(request)
    const hit = evaluation.hitsById.get(id)
    if (hit !== undefined) {
      return {
        id,
        found: true,
        text: hit.text,
        rank: evaluation.result.hits.findIndex(item => item.id === id) + 1,
        factors: hit.factors,
        score: hit.score,
        paths: hit.paths,
        reason: '在候选里，且未被任何过滤条件排除',
      }
    }
    if (evaluation.result.reason !== undefined) {
      return { id, found: false, rank: null, reason: `召回不可用：${evaluation.result.reason}` }
    }
    const record = evaluation.corpus.byId.get(id)
    if (record === undefined) {
      return {
        id,
        found: false,
        rank: null,
        reason: '不在语料里：id 不存在，或该条已封存（封存永不参与回忆），或被 maxScanRows 截断在窗口外',
      }
    }
    if (record.archived && !this.archivedIncluded(request)) {
      return { id, found: false, text: record.text, rank: null, reason: '已沉底，且本轮 includeArchived=false（沉底的不占主动位，但没被删）' }
    }
    const subject = request.subject
    if (subject !== undefined && record.subject !== null && record.subject !== subject) {
      return { id, found: false, text: record.text, rank: null, reason: `主体不符：本轮只看「${subject}」，该条主体是「${record.subject}」` }
    }
    const shared = sharedGramsOf(record.text, evaluation.query)
    if (shared === 0) {
      return {
        id,
        found: false,
        text: record.text,
        rank: null,
        reason: '与查询没有任何词面证据（共享二元组 0 个），且向量 / recognition 通道也没给出它——手册 §2.3 硬规矩①：没有词面证据的条目不进候选',
      }
    }
    return {
      id,
      found: false,
      text: record.text,
      rank: null,
      reason: `与查询共享 ${shared} 个二元组，但未进入任何通道的命中列表（可能被索引缓存判为过期前的旧内容）`,
    }
  }

  /** 索引状态。 */
  indexState(): RecallIndexState {
    const at = this.now()
    const cache = this.cache
    if (cache === undefined) {
      return { size: 0, builtAt: 0, ageMs: 0, stale: true }
    }
    const ageMs = Math.max(0, at - cache.builtAt)
    return {
      size: cache.size,
      builtAt: cache.builtAt,
      ageMs,
      stale: this.settings.indexTtlMs === 0 || ageMs > this.settings.indexTtlMs,
    }
  }

  /** 统计快照。 */
  stats(): RecallStats {
    const counters = this.counters
    const base = {
      fuse: this.settings.fuse,
      index: this.indexState(),
      queries: counters.queries,
      avgHits: counters.queries === 0 ? 0 : counters.hits / counters.queries,
      avgMs: counters.queries === 0 ? 0 : counters.ms / counters.queries,
    }
    if (this.reason !== undefined) {
      return { available: false, reason: this.reason, ...base, ...(this.lastErrorText === undefined ? {} : { lastError: this.lastErrorText }) }
    }
    return { available: true, ...base, ...(this.lastErrorText === undefined ? {} : { lastError: this.lastErrorText }) }
  }

  /* ------------------------------ 内部 ------------------------------ */

  /**
   * 跑一次完整评估。
   * @param request 请求。
   */
  private evaluate(request: RecallRequest): Evaluation {
    const startedAt = this.now()
    const rawText = typeof request?.text === 'string' ? request.text : ''
    if (typeof request?.text !== 'string') {
      throw new RecallError('bad-request', 'recall 请求的 text 必须是字符串')
    }
    const at = typeof request.at === 'number' && Number.isFinite(request.at) ? request.at : startedAt
    const query = normalizeText(rawText)
    // 次数在入口就 +1：不可用与空查询也算一次调用，否则 `stats().avgHits` 会偏高。
    this.counters.queries += 1

    if (this.reason !== undefined) {
      const result = this.emptyResult(query, at, startedAt, this.reason)
      return { result, corpus: emptyCorpus(), hitsById: new Map<string, RecallHit>(), query }
    }

    const corpus = this.loadCorpus()
    if (query.length === 0) {
      return {
        result: {
          ...this.emptyResult(query, at, startedAt, undefined),
          scanned: corpus.scanned,
          note: '空查询不召回（没有话头时「按层发牌」归 O-018 的随机回顾，不归这里）',
        },
        corpus,
        hitsById: new Map<string, RecallHit>(),
        query,
      }
    }

    const index = this.ensureIndex(corpus, at)
    const grams = queryGramsOf(rawText)
    const channels: ChannelState[] = []
    const lists: ChannelList[] = []

    // ① 罕见词通道：库容不够时显式标 absent，不静默空转。
    if (index.docs.length < this.settings.rareMinDocs) {
      channels.push({
        channel: 'rare',
        family: 'lexical',
        status: 'absent',
        items: 0,
        detail: `库容 ${index.docs.length} 条 < ${this.settings.rareMinDocs}，idf 上界够不到门槛 ${this.settings.rareIdf}，该通道本轮不参与`,
      })
    } else {
      const rare = searchRare(index, grams, this.settings.rareIdf)
      channels.push({
        channel: 'rare',
        family: 'lexical',
        status: rare.length === 0 ? 'empty' : 'used',
        items: rare.length,
      })
      if (rare.length > 0) lists.push({ channel: 'rare', items: rare })
    }

    // ② 二元组通道：BM25。
    const bigram = searchBigram(index, grams, this.settings.bm25K1, this.settings.bm25B)
    channels.push({
      channel: 'bigram',
      family: 'lexical',
      status: bigram.length === 0 ? 'empty' : 'used',
      items: bigram.length,
    })
    if (bigram.length > 0) lists.push({ channel: 'bigram', items: bigram })

    // ③ 向量 / ④ recognition。
    const vectorProbe = probeVector(this.vector, rawText, {
      enabled: this.settings.vectorBranch === 'auto',
      limit: this.settings.externalLimit,
    })
    channels.push(vectorProbe.state)
    if (vectorProbe.items.length > 0) lists.push({ channel: 'vector', items: vectorProbe.items })

    const recognitionProbe = probeRecognition(this.recognition, rawText, {
      enabled: this.settings.recognitionBranch === 'auto',
      limit: this.settings.externalLimit,
    })
    channels.push(recognitionProbe.state)
    if (recognitionProbe.items.length > 0) lists.push({ channel: 'recognition', items: recognitionProbe.items })

    if (lists.length === 0) {
      const unknown = unknownGramsOf(index, grams)
      const note =
        unknown.length === grams.length
          ? `未命中：查询里的 ${grams.length} 个二元组在库中都不存在（手册裁决⑨：不退回，但段标题必须写出未命中）`
          : '未命中：有词面重合的条目一条都没有'
      return {
        result: {
          ok: true,
          query,
          at,
          hits: [],
          dropped: 0,
          scanned: corpus.scanned,
          candidates: 0,
          fuse: this.settings.fuse,
          channels,
          weights: SPEC_WEIGHTS,
          normalizedBy: 0,
          elapsedMs: Math.max(0, this.now() - startedAt),
          note,
        },
        corpus,
        hitsById: new Map<string, RecallHit>(),
        query,
      }
    }

    // 融合。
    const fused = rrfFuse(lists, this.settings.rrfK)
    const candidateIds = [...fused.keys()]

    // 图谱种子：取二元组通道前 N 条（**只用字面证据当种子**，不拿语义分当种子——
    // 种子一旦掺进向量分，图谱因子就会和语义因子互相加强，两处一起把同一件事算两遍）。
    const seeds = this.pickSeeds(bigram, request.graphSeeds)
    const graphScores = this.relatednessOf(candidateIds, seeds)

    // 逐条算因子。
    const factorsById = new Map<string, { factors: RecallFactors; score: number }>()
    for (const id of candidateIds) {
      const record = corpus.byId.get(id)
      if (record === undefined) continue
      const paths = fused.get(id)?.paths ?? []
      const input = this.factorsFor(record, at, paths, graphScores.get(id))
      const composed = composeFactors(input)
      factorsById.set(id, { factors: toFactorsView(input, composed), score: composed.score })
    }

    // 排序。
    const ordered =
      this.settings.fuse === 'weighted'
        ? weightedRank(new Map([...factorsById.entries()].map(([id, value]) => [id, value.score])))
        : [...fused.values()]
            .filter(entry => factorsById.has(entry.id))
            .sort((left, right) => compareFused(left, right, id => factorsById.get(id)?.score ?? 0))
            .map(entry => ({ id: entry.id, score: entry.fused }))

    // 过滤（语义条件，不是条数）。
    const includeArchived = this.archivedIncluded(request)
    const subject = typeof request.subject === 'string' && request.subject.length > 0 ? request.subject : undefined
    const hits: RecallHit[] = []
    let filteredArchived = 0
    let filteredSubject = 0
    for (const entry of ordered) {
      const record = corpus.byId.get(entry.id)
      if (record === undefined) continue
      if (record.archived && !includeArchived) {
        filteredArchived += 1
        continue
      }
      if (subject !== undefined && record.subject !== null && record.subject !== subject) {
        filteredSubject += 1
        continue
      }
      const bundle = factorsById.get(entry.id)
      if (bundle === undefined) continue
      hits.push({
        id: record.id,
        text: record.text,
        summary: record.summary,
        category: record.category,
        kind: record.kind,
        channel: record.channel,
        score: entry.score,
        factors: bundle.factors,
        paths: fused.get(entry.id)?.paths ?? [],
        strength: this.strengthOf(record, at),
        important: record.important,
        archived: record.archived,
        createdAt: record.createdAt,
        lastHitAt: record.lastHitAt,
      })
    }

    const elapsedMs = Math.max(0, this.now() - startedAt)
    // 归一化分母按「本轮整体参与集合」算，不拿第一条命中当代表：
    // 种子条目的图谱因子是 null（与自己没有关联度），它们的个人分母会比别的小 0.11。
    // 若拿第一条当代表，`normalizedBy` 会在两种值之间随机跳，界面解释就自相矛盾。
    let normalizedBy = SPEC_WEIGHTS.keyword + SPEC_WEIGHTS.importance + SPEC_WEIGHTS.freshness
    if (vectorProbe.items.length > 0) normalizedBy += SPEC_WEIGHTS.semantic
    if (graphScores.size > 0) normalizedBy += SPEC_WEIGHTS.graph
    const notes: string[] = []
    if (filteredArchived > 0) notes.push(`另有 ${filteredArchived} 条已沉底未展开（includeArchived=false）`)
    if (filteredSubject > 0) notes.push(`另有 ${filteredSubject} 条主体不符未展开`)
    if (corpus.truncated) notes.push('扫描被 maxScanRows 截断，窗口外的记忆本轮不参与（这是性能逃生口，不是召回裁剪）')

    this.counters.hits += hits.length
    this.counters.ms += elapsedMs

    const hitsById = new Map(hits.map(hit => [hit.id, hit]))
    return {
      result: {
        ok: true,
        query,
        at,
        hits,
        dropped: 0,
        scanned: corpus.scanned,
        candidates: candidateIds.length,
        fuse: this.settings.fuse,
        channels,
        weights: SPEC_WEIGHTS,
        normalizedBy,
        elapsedMs,
        ...(notes.length === 0 ? {} : { note: notes.join('；') }),
      },
      corpus,
      hitsById,
      query,
    }
  }

  /** 空结果（不可用 / 空查询）。 */
  private emptyResult(
    query: string,
    at: number,
    startedAt: number,
    reason: RecallUnavailableReason | undefined,
  ): RecallResult {
    return {
      ok: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
      query,
      at,
      hits: [],
      dropped: 0,
      scanned: 0,
      candidates: 0,
      fuse: this.settings.fuse,
      channels: [],
      weights: SPEC_WEIGHTS,
      normalizedBy: 0,
      elapsedMs: Math.max(0, this.now() - startedAt),
    }
  }

  /**
   * 读语料：分页全量，**排除封存**。
   *
   * 刻意不在查询里带 `state` 过滤：`FactQuery.state` 是单值，
   * 传 `active` 会连「沉底」一起排掉，而沉底项要不要参与是**单次请求**的决定
   * （`includeArchived`）。索引必须建在「非封存全量」上，否则同一份配置下
   * 两种请求会让索引来回重建。
   */
  private loadCorpus(): Corpus {
    const core = this.core
    if (core === undefined) return emptyCorpus()
    const records: MemoryRecordLike[] = []
    const byId = new Map<string, MemoryRecordLike>()
    const pageSize = this.settings.pageSize
    const maxRows = this.settings.maxScanRows
    let offset = 0
    let truncated = false
    let pages = 0

    for (;;) {
      if (pages >= MAX_PAGES) {
        truncated = true
        break
      }
      let page: readonly MemoryRecordLike[]
      try {
        page = core.listFacts({ offset, limit: pageSize, orderBy: 'created-at' })
      } catch (error) {
        this.lastErrorText = messageOf(error)
        this.log.warn('读取记忆语料失败（已返回已读到的 %d 条）：%s', records.length, messageOf(error))
        break
      }
      if (!Array.isArray(page) || page.length === 0) break
      pages += 1
      for (const record of page) {
        if (record === null || typeof record !== 'object') continue
        if (record.sealed) continue
        if (byId.has(record.id)) continue
        byId.set(record.id, record)
        records.push(record)
      }
      offset += page.length
      if (page.length < pageSize) break
      if (maxRows > 0 && offset >= maxRows) {
        truncated = true
        break
      }
    }

    return { records, byId, scanned: offset, truncated }
  }

  /**
   * 复用或重建索引。
   * @param corpus 语料。
   * @param at 时间戳。
   */
  private ensureIndex(corpus: Corpus, at: number): LexicalIndex {
    const cache = this.cache
    const ttl = this.settings.indexTtlMs
    if (cache !== undefined && cache.size === corpus.records.length && (ttl === 0 ? false : at - cache.builtAt <= ttl)) {
      return cache.index
    }
    const index = buildIndex(corpus.records, at)
    this.cache = { index, size: corpus.records.length, builtAt: at }
    return index
  }

  /**
   * 取图谱种子：二元组通道的前 N 条。
   * @param bigram 二元组通道命中。
   * @param override 请求级覆盖。
   */
  private pickSeeds(bigram: readonly RankedItem[], override: number | undefined): readonly string[] {
    const count = typeof override === 'number' && Number.isFinite(override) ? override : this.settings.graphSeeds
    if (count <= 0) return []
    return bigram.slice(0, count).map(item => item.id)
  }

  /**
   * 图谱因子：候选与种子的 1 跳最大边权。
   *
   * 优先用 O-015 的 `relatedness()`（一次调用算完所有候选）；
   * 它没实现批量面时退回逐种子 `neighbors()`，代价是 `候选数 × 种子数` 次调用，
   * 已写进 README 已知限制。
   * @param ids 候选 id。
   * @param seeds 种子 id。
   */
  private relatednessOf(ids: readonly string[], seeds: readonly string[]): ReadonlyMap<string, number> {
    const out = new Map<string, number>()
    const graph = this.graph
    if (graph === undefined || !graph.available || seeds.length === 0 || ids.length === 0) return out

    try {
      if (typeof graph.relatedness === 'function') {
        const map = graph.relatedness(ids, seeds, { minWeight: this.settings.graphMinWeight })
        for (const id of ids) {
          // 种子与自己没有「关联度」可言，留给 `factorsFor` 判空（见下）。
          if (seeds.includes(id)) continue
          const value = map[id]
          if (typeof value === 'number' && Number.isFinite(value)) out.set(id, Math.min(1, Math.max(0, value)))
        }
        return out
      }
      for (const seed of seeds) {
        const neighbors = graph.neighbors(seed, { minWeight: this.settings.graphMinWeight, includeSurreal: false })
        for (const neighbor of neighbors) {
          if (seeds.includes(neighbor.id)) continue
          if (!Number.isFinite(neighbor.weight)) continue
          const weight = Math.min(1, Math.max(0, neighbor.weight))
          const previous = out.get(neighbor.id)
          if (previous === undefined || weight > previous) out.set(neighbor.id, weight)
        }
      }
    } catch (error) {
      this.lastErrorText = messageOf(error)
      this.log.warn('读图谱关联度失败（图谱因子本轮退出归一化）：%s', messageOf(error))
    }
    return out
  }

  /**
   * 算一条记录的因子。
   * @param record 记忆。
   * @param at 时间戳。
   * @param paths 通道命中。
   * @param graphScore 图谱关联度（`undefined` = 不参与）。
   */
  private factorsFor(
    record: MemoryRecordLike,
    at: number,
    paths: readonly RecallPathHit[],
    graphScore: number | undefined,
  ): FactorInput {
    let bigramRaw: number | null = null
    let rareRaw: number | null = null
    let semantic: number | null = null
    for (const path of paths) {
      if (path.channel === 'bigram') bigramRaw = Math.max(bigramRaw ?? 0, path.raw)
      if (path.channel === 'rare') rareRaw = Math.max(rareRaw ?? 0, path.raw)
      if (path.channel === 'vector' && (semantic === null || path.raw > semantic)) semantic = path.raw
    }
    // 关键词取「BM25 优先、罕见词兜底」，**不相加**：两路是同一件事的两种看法，
    // 相加等于同一条证据算两遍，会把「只被罕见词命中」的条目抬得比「被 BM25 强命中」还高。
    const keywordRaw = bigramRaw ?? rareRaw ?? 0
    return {
      semantic,
      keyword: keywordFactorOf(keywordRaw, this.settings.bm25Half),
      graph: graphScore === undefined ? null : graphScore,
      importance: importanceOf(record),
      freshness: freshnessOf(record, at),
    }
  }

  /**
   * 取强度（内核提供 `strengthOf` 才有）。
   * @param record 记忆。
   * @param at 时间戳。
   */
  private strengthOf(record: MemoryRecordLike, at: number): number | null {
    const core = this.core
    if (core === undefined || typeof core.strengthOf !== 'function') return null
    try {
      const view = core.strengthOf(record, at)
      return typeof view?.strength === 'number' && Number.isFinite(view.strength) ? view.strength : null
    } catch {
      // 强度只是展示字段，算不出来不该让召回失败。
      return null
    }
  }
}

/** 空语料。 */
function emptyCorpus(): Corpus {
  return { records: [], byId: new Map(), scanned: 0, truncated: false }
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 推不可用原因。
 * @param core 记忆内核。
 * @param settings 配置。
 */
function deriveReason(core: MemoryCoreLike | undefined, settings: Config): RecallUnavailableReason | undefined {
  if (!settings.enable) return 'disabled'
  if (core === undefined) return 'no-core'
  if (!core.available) return 'core-unavailable'
  return undefined
}

