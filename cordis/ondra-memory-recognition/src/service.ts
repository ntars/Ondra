/**
 * `RecognitionService` 的实现。
 *
 * 状态只有四份，全部在内存、全部可从内核重算：
 *
 * | 状态 | 用途 | 谁能改 |
 * |---|---|---|
 * | `entries` | 索引条目（含 slug / 触发词 / 二元组） | 只在 `rebuild()` 里整批替换 |
 * | `index` | 三种查找入口（id / slug / 触发词） | 跟着 `entries` 一起换 |
 * | `block` | 索引正文与元数据 | 同上 |
 * | 计数器 | 统计与自检 | 各方法自增 |
 *
 * 没有定时器、没有文件、没有数据库句柄——这是刻意的（B6 域的零常驻气质）：
 * 一个「每次 query 都要全量扫一遍记忆库」的分支，如果还带一个后台重建定时器，
 * 那就是「空闲时也在读库」。改成「谁查谁检查过期」，执行时机才确定。
 */

import { buildIndex } from './index-block.js'
import type { BuildOptions, BuildResult } from './index-block.js'
import { indexEntries, matchEntries, mergeHits, walkLinks } from './match.js'
import type { EntryIndex, MatchHit } from './match.js'
import { pickWithModel } from './pick.js'
import type { Config } from './settings.js'
import { bigramsOf, normalizeText } from './text.js'
import { NAME_RE, RecognitionError } from './types.js'
import type {
  BlockOptions,
  IndexBlock,
  IndexEntry,
  LlmGatewayLike,
  LogLike,
  MemoryCoreLike,
  MemoryRecordLike,
  RecognitionExplanation,
  RecognitionHit,
  RecognitionIndexState,
  RecognitionOutcome,
  RecognitionService,
  RecognitionStats,
  RecognitionUnavailableReason,
  RecognizeOptions,
  SearchOptions,
} from './types.js'

/** 分页扫描的硬上限（防御：畸形内核返回永远满页时不会死循环）。 */
const MAX_SCAN_ROWS = 200000

/**
 * 索引服务的实现。
 *
 * 构造函数接受**可能缺席**的内核与网关：缺席不是构造失败，而是 `available=false`。
 * 这样下游能区分「没装本插件」与「装了但内核不可用」——后者应该出现在自检报告里。
 */
export class RecognitionRepository implements RecognitionService {
  private readonly core: MemoryCoreLike | undefined
  private readonly gateway: LlmGatewayLike | undefined
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number

  private entries: readonly IndexEntry[] = []
  private index: EntryIndex = indexEntries([])
  private blockText = ''
  private blockRevision = ''
  private blockOmitted = 0
  private blockTokens = 0
  private blockChars = 0
  private builtAt = 0
  private counted = -1
  /** 上一次构建的块文本（判「新块是否以旧块为前缀」用）。 */
  private previousText = ''
  /** 本次构建相对上一次是否重写了中间部分。 */
  private rebuiltFlag = false

  private searches = 0
  private hits = 0
  private picks = 0
  private pickFailures = 0
  private hallucinated = 0
  private rebuilds = 0
  private lastError: string | undefined

  /**
   * @param core 记忆内核（可能缺席）。
   * @param gateway 模型网关（可能缺席）。
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   */
  constructor(
    core: MemoryCoreLike | undefined,
    gateway: LlmGatewayLike | undefined,
    settings: Config,
    log: LogLike,
    now: () => number,
  ) {
    this.core = core
    this.gateway = gateway
    this.settings = settings
    this.log = log
    this.now = now
  }

  /** 是否可用。 */
  get available(): boolean {
    if (this.settings.enable !== true) return false
    if (this.core === undefined) return false
    return this.core.available === true
  }

  /** 不可用原因。 */
  get reason(): RecognitionUnavailableReason | undefined {
    if (this.settings.enable !== true) return 'disabled'
    if (this.core === undefined) return 'no-core'
    if (this.core.available !== true) return 'core-unavailable'
    return undefined
  }

  /**
   * 同步识别（确定性命中）。
   * @param text 当前来信。
   * @param options 选项。
   */
  search(text: string, options?: SearchOptions): readonly RecognitionHit[] {
    if (!this.available) return []
    const limit = typeof options?.limit === 'number' && options.limit > 0 ? Math.trunc(options.limit) : 200
    try {
      const query = normalizeText(text)
      if (query === '') return []
      this.ensureIndex()
      const grams = bigramsOf(query)
      const direct = matchEntries(this.entries, query, grams, this.settings.minScore)
      // 游走参数：圈数 0 时 walkLinks 直接返回空，不额外分支。
      const walked = walkLinks(this.index, direct, {
        minScore: this.settings.minScore,
        maxSeeds: this.settings.maxSeeds,
        maxRing: this.settings.maxRing,
        limit,
      })
      const merged = mergeHits(direct, walked, limit)
      this.searches += 1
      this.hits += merged.length
      return merged.map(hit => ({ id: hit.id, score: hit.score }))
    } catch (error) {
      // C3：分支错误不得传播。返回空数组，让 O-014 把这条通道标成 `error`。
      this.lastError = messageOf(error)
      this.log.warn('recognition 同步识别失败（本轮该通道退出融合，其余通道照跑）：%s', this.lastError)
      return []
    }
  }

  /**
   * 异步识别（整索引进 prompt + 小模型挑 slug）。
   * @param text 当前来信（原文，不归一化——模型读原文更准）。
   * @param options 选项。
   */
  async recognize(text: string, options?: RecognizeOptions): Promise<RecognitionOutcome> {
    const startedAt = this.now()
    const emptyBlock = { entries: 0, omitted: 0, revision: '', estTokens: 0 }
    const base = {
      query: typeof text === 'string' ? text : '',
      hits: [] as readonly RecognitionHit[],
      picked: 0,
      hallucinated: 0,
      block: emptyBlock,
      elapsedMs: 0,
    }
    if (this.settings.enable !== true) {
      return { ...base, ok: false, reason: 'pick-disabled', note: '总开关关着', elapsedMs: this.now() - startedAt }
    }
    if (!this.available) {
      return {
        ...base,
        ok: false,
        reason: 'service-unavailable',
        note: `记忆内核不可用（${this.reason ?? '未知原因'}）`,
        elapsedMs: this.now() - startedAt,
      }
    }
    if (this.settings.pickEnabled === 'off') {
      return {
        ...base,
        ok: false,
        reason: 'pick-disabled',
        note: '配置里关掉了小模型那一路（pickEnabled=off）：只有同步的确定性识别',
        elapsedMs: this.now() - startedAt,
      }
    }

    // 元数据在 try 外先取一次：失败分支也要能告诉调用方「这一版索引是什么样」，
    // 否则「没调上模型」和「索引是空的」在返回值里长得一模一样。
    let meta = { entries: 0, omitted: 0, revision: '', estTokens: 0 }
    try {
      this.ensureIndex()
      meta = { entries: this.entries.length, omitted: this.blockOmitted, revision: this.blockRevision, estTokens: this.blockTokens }
      if (this.gateway === undefined) {
        return {
          ...base,
          ok: false,
          reason: 'no-gateway',
          block: meta,
          note: '没有模型网关（ondra-llm-gateway）：小模型这一路走不通，只剩同步识别',
          elapsedMs: this.now() - startedAt,
        }
      }
      const outcome = await pickWithModel({
        gateway: this.gateway,
        blockText: this.blockText,
        blockMeta: meta,
        index: this.index,
        query: typeof text === 'string' ? text : '',
        maxTokens: typeof options?.maxTokens === 'number' ? options.maxTokens : this.settings.pickMaxTokens,
        temperature: this.settings.pickTemperature,
        timeoutMs: typeof options?.timeoutMs === 'number' ? options.timeoutMs : this.settings.pickTimeoutMs,
        limit: typeof options?.limit === 'number' && options.limit > 0 ? options.limit : 200,
        signal: options?.signal,
      })
      this.picks += 1
      if (!outcome.ok) this.pickFailures += 1
      this.hallucinated += outcome.hallucinated
      return outcome
    } catch (error) {
      // `pickWithModel` 自己已经兜了一层，这里兜的是「调用它之前」的错
      // （例如 `ensureIndex` 抛）。两层都留，是因为它们的失败原因不同。
      this.picks += 1
      this.pickFailures += 1
      this.lastError = messageOf(error)
      this.log.warn('recognition 小模型识别失败：%s', this.lastError)
      return { ...base, block: meta, ok: false, reason: 'pick-failed', note: this.lastError, elapsedMs: this.now() - startedAt }
    }
  }

  /**
   * 取索引块（稳定前缀）。
   * @param options `since` 为调用方手上那一版的 revision。
   */
  indexBlock(options?: BlockOptions): IndexBlock {
    if (!this.available) {
      return {
        text: '',
        revision: '',
        entries: 0,
        omitted: 0,
        chars: 0,
        estTokens: 0,
        builtAt: this.builtAt,
        unchanged: options?.since === '' && this.blockRevision === '',
        rebuilt: false,
      }
    }
    try {
      this.ensureIndex()
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('取索引块时重建失败，返回上一版：%s', this.lastError)
    }
    const unchanged = typeof options?.since === 'string' && options.since === this.blockRevision
    return {
      text: unchanged ? '' : this.blockText,
      revision: this.blockRevision,
      entries: this.entries.length,
      omitted: this.blockOmitted,
      chars: unchanged ? 0 : this.blockChars,
      estTokens: unchanged ? 0 : this.blockTokens,
      builtAt: this.builtAt,
      unchanged,
      rebuilt: this.rebuiltFlag,
    }
  }

  /** 索引状态。 */
  indexState(): RecognitionIndexState {
    const ageMs = this.builtAt === 0 ? 0 : Math.max(0, this.now() - this.builtAt)
    return {
      entries: this.entries.length,
      omitted: this.blockOmitted,
      builtAt: this.builtAt,
      ageMs,
      // 「从没建过」也算过期：否则第一次 `search()` 之前调 `indexState()`
      // 会得到 `stale:false` 而 `entries:0`，界面会显示「索引正常，空」。
      stale: this.builtAt === 0 || ageMs > this.settings.indexTtlMs,
      revision: this.blockRevision,
      estTokens: this.blockTokens,
    }
  }

  /**
   * 解释某一条。
   * @param id 记忆 id。
   * @param text 查询文本。
   */
  explain(id: string, text: string): RecognitionExplanation {
    if (typeof id !== 'string' || !NAME_RE.test(id)) {
      throw new RecognitionError('bad-request', `id「${String(id)}」不匹配 ${NAME_RE.source}`)
    }
    if (!this.available) {
      return { id, indexed: false, found: false, via: null, reason: `服务不可用（${this.reason ?? '未知原因'}）` }
    }
    // C3：解释接口是最可能被人拿来「查到底怎么回事」的地方，它自己抛错就等于
    // 把「查不清」变成「查不了」。整段兜住，出错时说清是「构建索引时出错」。
    try {
      this.ensureIndex()
    } catch (error) {
      this.lastError = messageOf(error)
      return {
        id,
        indexed: false,
        found: false,
        via: null,
        reason: `重建索引时出错，以下判断不可靠：${this.lastError}`,
      }
    }
    const entry = this.entries.find(item => item.id === id)
    if (entry === undefined) {
      // 区分三种「读不到」：封存（永不可见）、沉底（配置排除）、超预算。
      return {
        id,
        indexed: false,
        found: false,
        via: null,
        reason: this.absenceReason(id),
      }
    }
    const query = normalizeText(text)
    if (query === '') {
      return { id, indexed: true, slug: entry.slug, found: false, via: null, reason: '查询为空：无话头时「按层发牌」归 O-018，不归本插件' }
    }
    const grams = bigramsOf(query)
    const direct = matchEntries(this.entries, query, grams, this.settings.minScore)
    const walked = walkLinks(this.index, direct, {
      minScore: this.settings.minScore,
      maxSeeds: this.settings.maxSeeds,
      maxRing: this.settings.maxRing,
      limit: 200,
    })
    const merged: readonly MatchHit[] = mergeHits(direct, walked, Math.max(1, this.entries.length))
    const hit = merged.find(item => item.id === id)
    if (hit === undefined) {
      const best = this.bestExplanation(entry, grams)
      return { id, indexed: true, slug: entry.slug, found: false, via: null, reason: best }
    }
    return {
      id,
      indexed: true,
      slug: entry.slug,
      found: true,
      score: hit.score,
      via: hit.via,
      reason: `以 ${viaLabel(hit.via)} 认出来，分 ${hit.score.toFixed(2)}`,
    }
  }

  /** 统计快照。 */
  stats(): RecognitionStats {
    return {
      available: this.available,
      reason: this.reason,
      index: this.indexState(),
      searches: this.searches,
      hits: this.hits,
      picks: this.picks,
      pickFailures: this.pickFailures,
      hallucinated: this.hallucinated,
      rebuilds: this.rebuilds,
      lastError: this.lastError,
    }
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  /** 建索引参数（从配置派生，不另存一份）。 */
  private buildOptions(): BuildOptions {
    return {
      maxEntries: this.settings.maxEntries,
      indexBudgetTokens: this.settings.indexBudgetTokens,
      entryCharLimit: this.settings.entryCharLimit,
      triggersPerEntry: this.settings.triggersPerEntry,
      includeArchived: this.settings.includeArchived,
    }
  }

  /**
   * 需要时重建索引。
   *
   * 两条触发条件：**从没建过**、**过期**、**条数变了**。第三条是必需的：
   * 内核不提供写事件，只靠 TTL 会让「刚记住的事」在 5 分钟内认不出来，
   * 而「刚说完就忘」是这类产品最刺眼的失败。
   */
  private ensureIndex(): void {
    if (!this.available) return
    const count = this.countActive()
    const age = this.builtAt === 0 ? Number.POSITIVE_INFINITY : this.now() - this.builtAt
    if (this.builtAt !== 0 && count === this.counted && age <= this.settings.indexTtlMs) return
    this.rebuild(count)
  }

  /** 当前应进索引的条数（只用来判「变了没有」，不做业务判断）。 */
  private countActive(): number {
    if (this.core === undefined) return 0
    try {
      return this.core.countFacts(this.settings.includeArchived ? {} : { state: 'active' })
    } catch (error) {
      this.lastError = messageOf(error)
      // 数不出来时返回 -1：`-1 !== counted` 会触发重建，而重建失败会在下一层被兜住。
      // 返回 0 会让「库里有 800 条但数不出来」被误判成「空库」。
      return -1
    }
  }

  /** 全量拉取（分页），按 id 去重防「倒序分页 + 并发写」造成的重复行。 */
  private collect(): readonly MemoryRecordLike[] {
    if (this.core === undefined) return []
    const out = new Map<string, MemoryRecordLike>()
    const pageSize = Math.max(50, this.settings.pageSize)
    let offset = 0
    while (offset < MAX_SCAN_ROWS) {
      const page = this.core.listFacts({
        ...(this.settings.includeArchived ? {} : { state: 'active' as const }),
        limit: pageSize,
        offset,
        orderBy: 'created-at',
      })
      if (page.length === 0) break
      for (const record of page) {
        if (typeof record.id !== 'string' || record.id === '') continue
        if (!out.has(record.id)) out.set(record.id, record)
      }
      if (page.length < pageSize) break
      offset += pageSize
    }
    return [...out.values()]
  }

  /** 重建。 */
  private rebuild(count: number): void {
    if (this.core === undefined) return
    const result: BuildResult = buildIndex(this.collect(), this.buildOptions())
    // 「新块是否以旧块为前缀」在**重建这一刻**判一次并记下：
    // 之后 `indexBlock()` 可能被调很多次，`previousText` 早已被覆盖。
    this.rebuiltFlag = this.previousText !== '' && !result.text.startsWith(this.previousText)
    this.previousText = result.text
    this.entries = result.entries
    this.index = indexEntries(this.entries)
    this.blockText = result.text
    this.blockRevision = result.revision
    this.blockOmitted = result.omitted
    this.blockTokens = result.estTokens
    this.blockChars = result.chars
    this.builtAt = this.now()
    this.counted = count
    this.rebuilds += 1
    if (result.omitted > 0) {
      this.log.warn(
        '索引装不下全部记忆：进 %d 条，%d 条未进（预算 %d token / 上限 %d 条）。未进的条数不进索引块，由调用方决定怎么讲',
        result.entries.length,
        result.omitted,
        this.settings.indexBudgetTokens,
        this.settings.maxEntries,
      )
    }
    if (result.skipped.sealed > 0) {
      // 封存被排除是**正确行为**，但这行日志值得留：它是「为什么这条记忆从不被认出」的答案。
      this.log.debug?.('封存记忆 %d 条不进索引（手册 §2.4：封存不参与回忆，本插件无开关）', result.skipped.sealed)
    }
  }

  /** 某条不在索引里的原因（`explain` 用）。 */
  private absenceReason(id: string): string {
    if (this.core === undefined) return '记忆内核缺席'
    try {
      const record = this.core.getFact(id)
      if (record === undefined) return '内核里没有这条记忆（id 不存在）'
      if (record.sealed === true) return '这条已封存：封存永不参与回忆，也不进索引（无开关）'
      if (record.archived === true && !this.settings.includeArchived) {
        return '这条已沉底：默认不进索引（includeArchived=true 可改，但那样沉底的记忆会重新被认出）'
      }
      if (typeof record.text !== 'string' || record.text.trim() === '') return '这条正文为空，无法生成识别入口'
      return '这条在库里但没进索引：多半是被条数上限或 token 预算挡在外面了（看 stats().index.omitted）'
    } catch (error) {
      return `查这条时出错：${messageOf(error)}`
    }
  }

  /** 给「没认出」一个具体原因（而不是一句「没命中」）。 */
  private bestExplanation(entry: IndexEntry, grams: ReadonlySet<string>): string {
    let shared = 0
    for (const gram of entry.grams) {
      if (grams.has(gram)) shared += 1
    }
    if (shared === 0) return '与查询没有任何共享二元组，触发词也不沾边——这是「确实无关」，不是「被挡住」'
    return `与查询共享 ${shared} 个二元组但重合比不够（门槛 ${this.settings.minScore}）：有词面联系，只是太弱`
  }
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** `via` 的中文说法。 */
function viaLabel(via: MatchHit['via']): string {
  if (via === 'slug') return 'slug 精确命中'
  if (via === 'trigger') return '触发词'
  if (via === 'gram') return '二元组重合'
  return '[[links]] 邻域游走'
}
