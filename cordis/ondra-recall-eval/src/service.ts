/**
 * 评估的编排层：读题集 → 逐题召回 → 算指标 → 落盘。
 *
 * 本文件只做「顺序」与「边界」，数学在 `metrics.ts`，题集解析在 `evalset.ts`，
 * 文本渲染在 `report.ts`，文件在 `store.ts`。这一层薄到可以一眼看完，
 * 因为最容易出错的永远是「哪一步算错了该报错、哪一步该降级」。
 *
 * 四条贯穿全文件的规矩：
 *
 * 1. **同一轮所有题共用一个时间戳。**
 *    新鲜度因子是 `0.5^(Δt/S)`，逐题取 `Date.now()` 会让第 1 题与第 30 题
 *    差几十毫秒——单看无所谓，但两次跑若题序相同，差会累积成不同的分数，
 *    于是「同一份代码跑两遍得到两个数」。故入口取一次 `now()`，全轮沿用。
 *
 * 2. **不可判的题从不按 0 分算。** 剔除、报出来、进 `skipped`。
 *
 * 3. **落盘失败不影响出数。** 指标已经算完了，磁盘满了不该让人看不到结果。
 *
 * 4. **报告在算完那一刻就冻结。** 落盘之后不再往 `notes` 里推东西——
 *    冻结过的数组再 push 会直接抛 `TypeError`（ESM 严格模式），
 *    而那个错会从「写报告」变成「评估整轮失败」，是最难归因的一类。
 */

import {
  countKinds,
  countUnfilled,
  parseSet,
  resolveCases,
  TEMPLATE_MARK,
} from './evalset.js'
import {
  deltaOf,
  firstRankOf,
  flattenBlock,
  groupByKind,
  hitAtOf,
  metricBlockOf,
  recallAtOf,
  reciprocalRankOf,
} from './metrics.js'
import { renderMarkdown, summarizeBlock } from './report.js'
import { ReportStore } from './store.js'
import { EvalError } from './types.js'
import type {
  CaseResult,
  CompareResult,
  EngineSnapshot,
  EvalCaseSpec,
  EvalReport,
  EvalSetSpec,
  EvalStats,
  EvalUnavailableReason,
  LogLike,
  MemoryCoreLike,
  MemoryRecordLike,
  MetricBlock,
  MetricDelta,
  PathLayoutLike,
  RecallEvalService,
  RecallHitLike,
  RecallLike,
  RecallRequestLike,
  RecallResultLike,
  ReportBaseline,
  ReportRef,
  ResolvedCase,
  RunRequest,
  RunResult,
  SeedResult,
  SetInfo,
  SkippedCase,
} from './types.js'
import type { Config } from './settings.js'

/** 分页拉全库时的每页条数。 */
const PAGE = 500

/** 分页上限（防「内核忽略 offset」导致死循环）。 */
const MAX_ROWS = 200000

/** 种子模板里正文片段的长度。 */
const SEED_FRAGMENT = 10

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 截断文本。
 * @param text 原文。
 * @param max 最大字数。
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/**
 * 前若干条命中的 id。
 * @param hits 命中列表。
 * @param limit 最多记几条；`<=0` 表示全记。
 */
function hitIdsOf(hits: readonly RecallHitLike[], limit: number): readonly string[] {
  const cap = limit <= 0 ? hits.length : Math.min(limit, hits.length)
  const out: string[] = []
  for (let index = 0; index < cap; index += 1) {
    const hit = hits[index]
    if (hit !== undefined) out.push(hit.id)
  }
  return Object.freeze(out)
}

/**
 * 评估实现。
 *
 * 依赖三个服务，全部按「有就用、没有就降级」处理：
 * - `ondra-memory-recall`（**硬**）：没有它无法评估，服务以 `available=false` 注册；
 * - `ondra-memory-core`（软）：只用于「按正文找 id」，缺席时只认 `expectIds`；
 * - `ondra-path-layout`（软）：只用于落盘，缺席时报告只在内存里。
 */
export class RecallEval implements RecallEvalService {
  private readonly recall: RecallLike | undefined
  private readonly core: MemoryCoreLike | undefined
  private readonly store: ReportStore
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number

  private runs = 0
  private lastBaseline: ReportBaseline | null = null
  private lastRecall1: number | null = null
  private lastError: string | undefined

  /**
   * @param recall 召回服务；缺席则本插件不可用。
   * @param core 记忆内核；缺席则不能按正文解析真值。
   * @param paths 路径布局；缺席则不能落盘。
   * @param settings 配置。
   * @param log 日志。
   * @param now 取当前时间（注入以便「同一轮同一时刻」与将来测试）。
   */
  constructor(
    recall: RecallLike | undefined,
    core: MemoryCoreLike | undefined,
    paths: PathLayoutLike | undefined,
    settings: Config,
    log: LogLike,
    now: () => number,
  ) {
    this.recall = recall
    this.core = core
    this.store = new ReportStore(paths, log)
    this.settings = settings
    this.log = log
    this.now = now
  }

  /** 是否可用。 */
  get available(): boolean {
    if (!this.settings.enable) return false
    if (this.recall === undefined) return false
    return this.recall.available
  }

  /** 不可用原因。 */
  get reason(): EvalUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (this.recall === undefined) return 'no-recall'
    if (!this.recall.available) return 'recall-unavailable'
    return undefined
  }

  /**
   * 跑一次评估。
   * @param request 请求。
   */
  run(request?: RunRequest): RunResult {
    const unavailable = this.reason
    if (unavailable !== undefined) {
      const note = noteOfReason(unavailable)
      this.log.warn('检索评估未执行：%s', note)
      return Object.freeze({ ok: false, reason: unavailable, note })
    }
    const recall = this.recall
    if (recall === undefined) {
      return Object.freeze({ ok: false, reason: 'no-recall', note: noteOfReason('no-recall') })
    }

    const req = request ?? {}
    const setName = req.setName === undefined || req.setName === '' ? this.settings.setName : req.setName
    const startedAt = this.now()

    // 1. 题集。内存题集不读盘、不落盘（没有来处，也就没有归档的意义）。
    const inMemory = req.cases !== undefined
    const setPath = this.store.setPath(setName)
    let spec: EvalSetSpec
    try {
      if (inMemory) {
        spec = parseSet({ name: setName, cases: req.cases }, setName)
      } else {
        if (!this.store.available) {
          return Object.freeze({
            ok: false,
            reason: 'no-set',
            note: '没有路径服务（ondra-path-layout），读不到题集；可以在 run({ cases }) 里直接给题',
          })
        }
        if (!this.store.hasSet(setName)) {
          const note = `找不到题集「${setName}」（${setPath ?? 'user/eval/'}）。先用 seed() 生成一份待填模板，再逐条把问法改成你真会说的话。`
          this.log.warn('%s', note)
          return Object.freeze({ ok: false, reason: 'no-set', note })
        }
        spec = parseSet(this.store.readSetRaw(setName), setName)
      }
    } catch (error) {
      this.lastError = messageOf(error)
      if (error instanceof EvalError && error.code === 'bad-set') {
        this.log.error('题集不可用：%s', error.message)
        return Object.freeze({ ok: false, reason: 'bad-set', note: `题集有错：${error.message}` })
      }
      this.log.error('读题集失败：%s', messageOf(error))
      return Object.freeze({ ok: false, reason: 'no-set', note: `读题集失败：${messageOf(error)}` })
    }

    // 2. 真值落地。库容同时是报告里的一栏——它变了，指标就不可直接比。
    const corpus = this.corpusOf()
    const resolutions = resolveCases(spec.cases, {
      minFingerprintChars: this.settings.minFingerprintChars,
      corpus,
    })

    // 3. 逐题跑。`at` 全轮共用一个值（见文件头第 1 条）。
    const cases: CaseResult[] = []
    const skipped: SkippedCase[] = []
    let engine: EngineSnapshot | null = null

    for (const item of resolutions) {
      if (item.skip !== undefined) {
        skipped.push(item.skip)
        cases.push(this.placeholder(item.resolved, item.skip))
        continue
      }
      const resolved = item.resolved
      const caseStart = Date.now()
      let result: RecallResultLike
      try {
        result = recall.search(this.requestOf(resolved.query, startedAt, req.fuse))
      } catch (error) {
        // 一题抛错不该让整轮报废：记成 0 分题并在 note 里说明。
        this.log.warn('题目「%s」执行召回时抛错：%s', resolved.id, messageOf(error))
        cases.push({
          id: resolved.id,
          kind: resolved.kind,
          query: this.redact(resolved.query),
          expected: resolved.expected.length,
          resolution: resolved.resolution,
          match: resolved.match,
          hits: Object.freeze([]),
          firstRank: null,
          reciprocalRank: 0,
          recallAt: this.zeroAt(),
          hitAt: this.falseAt(),
          avoided: resolved.kind === 'fabricated' ? true : null,
          topScore: null,
          elapsedMs: Date.now() - caseStart,
          note: `召回抛错：${messageOf(error)}`,
        })
        continue
      }
      if (engine === null) engine = snapshotOf(result)
      cases.push(this.caseOf(resolved, result, Date.now() - caseStart))
    }

    // 4. 指标与基线。
    const grouped = groupByKind(cases)
    const overall = metricBlockOf(cases, this.settings.ks)
    const byKind = Object.freeze({
      real: metricBlockOf(grouped.real, this.settings.ks),
      paraphrase: metricBlockOf(grouped.paraphrase, this.settings.ks),
      fabricated: metricBlockOf(grouped.fabricated, this.settings.ks),
    })
    const unfilled = countUnfilled(spec.cases)
    const baseline = baselineOf(overall, unfilled, this.settings.minCases)
    const partialCount = cases.filter(item => item.match === 'partial').length
    const notes = this.notesOf(
      spec,
      overall,
      unfilled,
      skipped,
      engine,
      inMemory,
      corpus !== undefined,
      partialCount,
      req.notes,
    )

    const report: EvalReport = Object.freeze({
      version: 1 as const,
      generatedAt: startedAt,
      baseline,
      setName: spec.name ?? setName,
      corpus: Object.freeze({ size: corpus === undefined ? 0 : corpus.length }),
      engine: engine ?? emptyEngine(),
      ks: this.settings.ks,
      overall,
      byKind,
      cases: Object.freeze(cases),
      skipped: Object.freeze(skipped),
      notes: Object.freeze(notes),
      elapsedMs: Date.now() - startedAt,
    })

    // 5. 落盘。内存题集一律不落盘；写失败只告警（报告已冻结，不再改它）。
    let files: readonly string[] = Object.freeze([])
    let writeNote: string | undefined
    const shouldWrite = req.write ?? this.settings.writeReport
    if (inMemory) {
      writeNote = '内存题集：只在内存里出数，不落盘'
    } else if (shouldWrite) {
      const outcome = this.store.writeReport(report, renderMarkdown(report))
      if (outcome.ok) {
        files = outcome.files
        this.store.prune(spec.name ?? setName, this.settings.keepReports)
      } else {
        writeNote = `报告未落盘：${outcome.error ?? '未知原因'}`
        this.log.warn('%s', writeNote)
      }
    }

    this.runs += 1
    this.lastBaseline = baseline
    this.lastRecall1 = overall.recall['1'] ?? null
    this.log.info(
      '检索评估完成（%s）：%s，基线=%s，耗时 %d ms%s',
      spec.name,
      summarizeBlock(overall, this.settings.ks),
      baseline,
      report.elapsedMs,
      files.length > 0 ? `，已落盘 ${files.length} 个文件` : '',
    )
    if (baseline !== 'measured') {
      this.log.warn('这份报告不能直接用来调参：%s', baselineText(baseline))
    }

    const lead =
      baseline === 'measured'
        ? `跑完 ${overall.graded} 题，recall@1=${(overall.recall['1'] ?? 0).toFixed(3)}，MRR=${overall.mrr.toFixed(3)}`
        : `跑完但基线是 ${baseline}：${baselineText(baseline)}`
    return Object.freeze({
      ok: true,
      report,
      files,
      note: writeNote === undefined ? lead : `${lead}；${writeNote}`,
    })
  }

  /**
   * 与上一次对比。
   * @param report 本次报告；省略时比较「最近两份历史报告」。
   */
  compare(report?: EvalReport): CompareResult {
    const setName = report === undefined ? this.settings.setName : report.setName
    if (!this.store.available) {
      return failedCompare('no-store', '没有路径服务，读不到历史报告，无法对比')
    }
    const refs = this.store.list(setName)

    let before: EvalReport | undefined
    let after: EvalReport | undefined
    if (report === undefined) {
      // 比较「最近两份」：列表新的在前，故 [0] 是新的、[1] 是旧的。
      // 逐份读、跳过坏文件，避免「中间坏一份就整体不可比」。
      const readable = this.readAll(refs)
      after = readable[0]
      before = readable[1]
    } else {
      after = report
      before = this.pickPrevious(refs, report.generatedAt)
    }

    if (before === undefined) {
      return failedCompare('no-previous', '还没有可比的上一份报告。改一次参数跑一次，第二份之后才有对比。')
    }
    if (after === undefined) {
      return failedCompare('unreadable', '最近一份报告读不出来（JSON 坏了），无法对比')
    }

    const deltas: MetricDelta[] = []
    const beforeRows = new Map(flattenBlock(before.overall, before.ks).map(row => [row.key, row.value]))
    for (const row of flattenBlock(after.overall, after.ks)) {
      deltas.push(deltaOf(row.key, beforeRows.get(row.key) ?? null, row.value))
    }

    const sameEngine = engineKeyOf(before.engine) === engineKeyOf(after.engine)
    const sameCorpus = before.corpus.size === after.corpus.size
    const parts: string[] = []
    parts.push(sameEngine ? '参数快照相同——同一把尺子量了两遍' : '参数快照不同——差异可以归因到参数')
    if (!sameCorpus) parts.push(`库容 ${before.corpus.size} → ${after.corpus.size}，差异也可能只是库里多了/少了几条记忆`)

    return Object.freeze({
      ok: true,
      beforeAt: before.generatedAt,
      afterAt: after.generatedAt,
      sameEngine,
      sameCorpus,
      deltas: Object.freeze(deltas),
      note: parts.join('；'),
    })
  }

  /**
   * 从库里抽若干条记忆，生成**待填模板**。
   *
   * 刻意**不生成问法**：把正文原样当问法，`recall@1` 会接近 100%，
   * 因为查询与答案是同一串字。那不是评估，那是自欺。
   * @param setName 题集名。
   * @param size 抽几条。
   * @param force 已存在时是否覆盖。
   */
  seed(setName?: string, size?: number, force?: boolean): SeedResult {
    const name = setName === undefined || setName === '' ? this.settings.setName : setName
    if (!this.store.available) {
      return Object.freeze({ ok: false, path: null, cases: 0, note: '没有路径服务（ondra-path-layout），无法写题集' })
    }
    if (this.store.hasSet(name) && force !== true) {
      return Object.freeze({
        ok: false,
        path: this.store.setPath(name),
        cases: 0,
        note: `题集「${name}」已存在。确实要覆盖就 seed(name, size, true)——覆盖会丢掉你写过的问法`,
      })
    }
    const records = this.corpusOf()
    if (records === undefined || records.length === 0) {
      return Object.freeze({
        ok: false,
        path: null,
        cases: 0,
        note: '拿不到记忆（没有内核或库里是空的），无法生成模板',
      })
    }
    const want = size === undefined ? this.settings.seedSize : Math.max(1, Math.trunc(size))
    const picked: EvalCaseSpec[] = []
    for (const record of records) {
      if (picked.length >= want) break
      const fragment = record.text.trim().slice(0, SEED_FRAGMENT)
      if (fragment.length < this.settings.minFingerprintChars) continue
      picked.push({
        id: `t${String(picked.length + 1).padStart(2, '0')}`,
        kind: 'real',
        query: `${TEMPLATE_MARK}${fragment}`,
        expect: [fragment],
        note: `把 query 改写成你当时真的会说的一句话（删掉 ${TEMPLATE_MARK}）。真值指纹「${fragment}」别改，除非那条记忆正文变了`,
      })
    }
    if (picked.length === 0) {
      return Object.freeze({ ok: false, path: null, cases: 0, note: '库里的记忆都太短，凑不出可用指纹' })
    }
    const spec: EvalSetSpec = Object.freeze({ version: 1, name, cases: Object.freeze(picked) })
    try {
      const filePath = this.store.writeSet(name, spec)
      const note =
        `已生成 ${picked.length} 条待填模板（${filePath}）。` +
        '下一步：逐条把 query 改成你真会说的话，再补 5 道「编造题」（kind: fabricated，库里根本没有的事，用来测她会不会硬凑）。'
      this.log.info('%s', note)
      return Object.freeze({ ok: true, path: filePath, cases: picked.length, note })
    } catch (error) {
      this.lastError = messageOf(error)
      return Object.freeze({ ok: false, path: null, cases: 0, note: `写题集失败：${messageOf(error)}` })
    }
  }

  /**
   * 题集信息。
   * @param setName 题集名。
   */
  setInfo(setName?: string): SetInfo {
    const name = setName === undefined || setName === '' ? this.settings.setName : setName
    const emptyCounts = Object.freeze({ real: 0, paraphrase: 0, fabricated: 0 })
    if (!this.store.available) {
      return Object.freeze({
        name,
        path: null,
        exists: false,
        cases: 0,
        counts: emptyCounts,
        unfilled: 0,
        sufficient: false,
        note: '没有路径服务（ondra-path-layout），读不到题集',
      })
    }
    const path = this.store.setPath(name)
    if (!this.store.hasSet(name)) {
      return Object.freeze({
        name,
        path,
        exists: false,
        cases: 0,
        counts: emptyCounts,
        unfilled: 0,
        sufficient: false,
        note: `题集「${name}」还没建。先 seed() 生成待填模板。`,
      })
    }
    try {
      const spec = parseSet(this.store.readSetRaw(name), name)
      const counts = countKinds(spec.cases)
      const unfilled = countUnfilled(spec.cases)
      const graded = counts.real + counts.paraphrase
      return Object.freeze({
        name,
        path,
        exists: true,
        cases: spec.cases.length,
        counts,
        unfilled,
        sufficient: graded >= this.settings.minCases,
        ...(unfilled > 0 ? { note: `还有 ${unfilled} 道模板没改写，现在的指标不能用来调参` } : {}),
      })
    } catch (error) {
      return Object.freeze({
        name,
        path,
        exists: true,
        cases: 0,
        counts: emptyCounts,
        unfilled: 0,
        sufficient: false,
        note: `题集读不出来：${messageOf(error)}`,
      })
    }
  }

  /**
   * 历史报告。
   * @param setName 题集名。
   */
  reports(setName?: string): readonly ReportRef[] {
    const name = setName === undefined || setName === '' ? this.settings.setName : setName
    return this.store.list(name)
  }

  /** 统计快照。 */
  stats(): EvalStats {
    const reason = this.reason
    return Object.freeze({
      available: this.available,
      ...(reason === undefined ? {} : { reason }),
      canWrite: this.store.available,
      canResolveText: this.core !== undefined && this.core.available,
      setName: this.settings.setName,
      runs: this.runs,
      lastBaseline: this.lastBaseline,
      lastRecall1: this.lastRecall1,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    })
  }

  /* ---------------- 内部 ---------------- */

  /**
   * 组装召回请求。
   * @param text 问法（**原文**，不是脱敏后的）。
   * @param at 本轮统一时间戳。
   * @param fuse 融合模式覆盖。
   */
  private requestOf(text: string, at: number, fuse: string | undefined): RecallRequestLike {
    return fuse === undefined ? { text, at } : { text, at, fuse }
  }

  /**
   * 拉全库正文（只用来按指纹找 id）。
   *
   * 不用 `countFacts` 定循环次数：条数可能在翻页之间变化，用「本页为空」当终止条件
   * 更稳；另有 `MAX_ROWS` 兜住「内核忽略 offset」这种会让 while 永不结束的情况。
   */
  private corpusOf(): readonly MemoryRecordLike[] | undefined {
    const core = this.core
    if (core === undefined || !core.available) return undefined
    const out: MemoryRecordLike[] = []
    const seen = new Set<string>()
    let offset = 0
    while (offset < MAX_ROWS) {
      let page: readonly MemoryRecordLike[]
      try {
        page = core.listFacts({ limit: PAGE, offset })
      } catch (error) {
        this.log.warn('拉取记忆列表失败，本轮只能按 expectIds 解析真值：%s', messageOf(error))
        return undefined
      }
      if (page.length === 0) break
      for (const record of page) {
        if (seen.has(record.id)) continue
        seen.add(record.id)
        out.push(record)
      }
      if (page.length < PAGE) break
      offset += page.length
    }
    return Object.freeze(out)
  }

  /**
   * 把一次召回结果翻成一题结果。
   * @param resolved 解析后的题。
   * @param result 召回结果。
   * @param elapsedMs 该题耗时。
   */
  private caseOf(resolved: ResolvedCase, result: RecallResultLike, elapsedMs: number): CaseResult {
    const ids: string[] = []
    for (const hit of result.hits) ids.push(hit.id)
    const firstRank = firstRankOf(ids, resolved.expected)

    const recallAt: Record<string, number> = {}
    const hitAt: Record<string, boolean> = {}
    for (const k of this.settings.ks) {
      recallAt[String(k)] = recallAtOf(ids, resolved.expected, k)
      hitAt[String(k)] = hitAtOf(ids, resolved.expected, k)
    }

    const top = result.hits[0]
    const topScore = top === undefined ? null : top.score
    return {
      id: resolved.id,
      kind: resolved.kind,
      query: this.redact(resolved.query),
      expected: resolved.expected.length,
      resolution: resolved.resolution,
      match: resolved.match,
      hits: hitIdsOf(result.hits, this.settings.recordHits),
      firstRank,
      reciprocalRank: reciprocalRankOf(firstRank),
      recallAt: Object.freeze(recallAt),
      hitAt: Object.freeze(hitAt),
      avoided: resolved.kind === 'fabricated' ? this.avoidedOf(result.fuse, result.hits.length, topScore) : null,
      topScore,
      elapsedMs,
    }
  }

  /**
   * 编造题是否「没有硬凑」。
   *
   * `rrf` 模式下**强制**按「无命中」判：`score` 是 `1/(k+rank)`，
   * 只表达名次不表达置信度，给它设分水岭就是给无量纲的数编意义。
   * @param fuse 本轮融合模式（取自召回结果，不是猜的）。
   * @param hitCount 命中条数。
   * @param topScore 最高分。
   */
  private avoidedOf(fuse: string, hitCount: number, topScore: number | null): boolean {
    if (hitCount === 0) return true
    if (fuse === 'rrf') return false
    if (this.settings.fabricatedJudge !== 'score-floor') return false
    return (topScore ?? 0) < this.settings.fabricatedScoreFloor
  }

  /**
   * 脱敏问法（只影响进报告的那份，搜索用的仍是原文）。
   * @param query 原文。
   */
  private redact(query: string): string {
    if (!this.settings.redactQueries) return query
    return truncate(query, this.settings.queryMaxChars)
  }

  /** 全 0 的 recall 表。 */
  private zeroAt(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const k of this.settings.ks) out[String(k)] = 0
    return Object.freeze(out)
  }

  /** 全 false 的 hit 表。 */
  private falseAt(): Readonly<Record<string, boolean>> {
    const out: Record<string, boolean> = {}
    for (const k of this.settings.ks) out[String(k)] = false
    return Object.freeze(out)
  }

  /**
   * 被剔除题的占位结果。
   *
   * 它**不进任何分母**（`isGradable` 会挡掉），但必须留在 `cases` 里：
   * 报告要能回答「我明明写了 30 题，怎么只算了 24 题」。
   * @param resolved 解析后的题。
   * @param skip 剔除原因。
   */
  private placeholder(resolved: ResolvedCase, skip: SkippedCase): CaseResult {
    return {
      id: resolved.id,
      kind: resolved.kind,
      query: this.redact(resolved.query),
      expected: 0,
      resolution: skip.resolution,
      match: resolved.match,
      hits: Object.freeze([]),
      firstRank: null,
      reciprocalRank: 0,
      recallAt: this.zeroAt(),
      hitAt: this.falseAt(),
      avoided: null,
      topScore: null,
      elapsedMs: 0,
      note: skip.reason,
    }
  }

  /**
   * 逐份读取历史报告（跳过读不出的）。
   * @param refs 列表（新的在前）。
   */
  private readAll(refs: readonly ReportRef[]): readonly EvalReport[] {
    const out: EvalReport[] = []
    for (const ref of refs) {
      const report = this.store.readReport(ref.json)
      if (report !== undefined) out.push(report)
    }
    return Object.freeze(out)
  }

  /**
   * 取「比 `at` 更早的最近一份」。
   *
   * 不能直接取 `refs[0]`：本次报告可能刚写进去，那样就会拿自己跟自己比，
   * 全部 Δ 为 0 且看起来「毫无变化」——比报错更误导。
   * @param refs 列表（新的在前）。
   * @param at 基准时间戳。
   */
  private pickPrevious(refs: readonly ReportRef[], at: number): EvalReport | undefined {
    for (const ref of refs) {
      if (ref.generatedAt >= at) continue
      const report = this.store.readReport(ref.json)
      if (report !== undefined) return report
    }
    return undefined
  }

  /**
   * 组装报告里的提示。
   * @param spec 题集。
   * @param overall 整体指标。
   * @param unfilled 未改写题数。
   * @param skipped 被剔除的题。
   * @param engine 参数快照。
   * @param inMemory 是否内存题集。
   * @param corpusKnown 是否拿到了全库（能否按正文解析）。
   * @param partialCount 按子串匹配的题数。
   * @param extra 调用方附注。
   */
  private notesOf(
    spec: EvalSetSpec,
    overall: MetricBlock,
    unfilled: number,
    skipped: readonly SkippedCase[],
    engine: EngineSnapshot | null,
    inMemory: boolean,
    corpusKnown: boolean,
    partialCount: number,
    extra: readonly string[] | undefined,
  ): string[] {
    const notes: string[] = []
    notes.push('口径：recall@k 是「命中真值数 ÷ 真值总数」，hit@k 是「至少命中一条」，MRR 未命中记 0 并进分母。')
    if (unfilled > 0) {
      notes.push(`有 ${unfilled} 道题还是模板问法（带「${TEMPLATE_MARK}」或空问法），这份数字不能用来调参。`)
    }
    if (overall.graded < this.settings.minCases) {
      notes.push(`计入计分的只有 ${overall.graded} 题，少于手册要求的 ${this.settings.minCases} 题，结论只能参考。`)
    }
    if (skipped.length > 0) {
      notes.push(`${skipped.length} 道题被剔除（真值失效或不唯一）。**这不是召回失败**，是题目不可判，见「被剔除的题」。`)
    }
    if (partialCount > 0) {
      notes.push(
        `${partialCount} 道题的真值是按「片段包含」匹配上的，不是整条正文相等。` +
          '这类匹配可能认错（`28` 会命中 `1280`、`喜欢猫` 会命中 `不喜欢猫`），**它只会让数字偏高**。' +
          `把 expect 里的指纹写长（≥8 字）能消掉大部分。`,
      )
    }
    const fabricated = spec.cases.filter(item => (item.kind ?? 'real') === 'fabricated').length
    if (fabricated === 0) {
      notes.push('题集里没有编造题。补 5 道「库里根本没有的事」，才能测出她会不会为你没说过的话硬凑一条记忆。')
    }
    if (engine === null) {
      notes.push('这一轮一道题都没跑成，参数快照是空的。')
    } else if (engine.fuse === 'rrf') {
      notes.push('本轮 fuse=rrf：编造题只能按「有无命中」判（名次分没有置信度含义），fabricatedScoreFloor 不生效。')
    } else {
      notes.push(`本轮 fuse=${engine.fuse}：编造题判据 ${this.settings.fabricatedJudge}，分水岭 ${this.settings.fabricatedScoreFloor}。`)
    }
    if (!corpusKnown) {
      notes.push('没有记忆内核（或拉取失败），真值只能按 expectIds 解析；题集里写正文指纹的题会被剔除，库容记为 0。')
    }
    if (inMemory) notes.push('本轮用的是内存题集，报告没有落盘。')
    if (extra !== undefined) {
      for (const line of extra) notes.push(line)
    }
    return notes
  }
}

/** 不可用原因的中文说明。 */
export function noteOfReason(reason: EvalUnavailableReason): string {
  switch (reason) {
    case 'disabled':
      return '总开关关着（enable=false），评估不执行。'
    case 'no-recall':
      return '没有召回服务（ondra-memory-recall 未装载），没有可评估的对象。'
    case 'recall-unavailable':
      return '召回服务在位但不可用（多半是记忆内核没起来），先修召回再评估。'
    case 'no-set':
      return '找不到题集文件。'
    case 'bad-set':
      return '题集文件结构不对。'
    default:
      return '未知原因。'
  }
}

/** 基线状态的中文说明。 */
export function baselineText(baseline: ReportBaseline): string {
  switch (baseline) {
    case 'measured':
      return '可以用来判断改好了还是改坏了'
    case 'template-unfilled':
      return '题集里还有没改写的问法，不能用来调参'
    case 'insufficient':
      return '题数少于手册要求（20 题），结论只能参考'
    case 'empty-set':
      return '没有任何可判题，报告只有框架没有数字'
    default:
      return '未知基线。'
  }
}

/**
 * 判基线。
 *
 * 顺序不能换：`empty-set` 最狠（连数字都没有），其次才是「题没填」与「题太少」。
 * 反过来就会出现「一份只有模板题的报告被判成 insufficient」——
 * 那会让人以为「再补几道就有了」，其实补的也是模板。
 * @param overall 整体指标。
 * @param unfilled 未填题数。
 * @param minCases 最小题数。
 */
export function baselineOf(overall: MetricBlock, unfilled: number, minCases: number): ReportBaseline {
  // 「有没有任何可判题」= 有真值题（graded>0）或有编造题（avoidRate 非 null）。
  if (overall.graded === 0 && overall.avoidRate === null) return 'empty-set'
  if (unfilled > 0) return 'template-unfilled'
  if (overall.graded < minCases) return 'insufficient'
  return 'measured'
}

/** 空参数快照。 */
function emptyEngine(): EngineSnapshot {
  return Object.freeze({
    fuse: 'unknown',
    rrfK: null,
    bm25K1: null,
    bm25B: null,
    weights: Object.freeze({}),
    normalizedBy: null,
    channels: Object.freeze([]),
  })
}

/**
 * 从召回结果里抽参数快照。
 *
 * **只取结果里真的有的东西**：召回对外回传 `fuse` / `weights` / `normalizedBy` /
 * `channels`，本插件不去猜 O-014 的配置（那要 import 或读人家的配置文件，
 * 两条都是越界）。`rrfK` 等拿不到就写 `null`，报告里显示 `—` 而不是编一个数。
 * @param result 召回结果。
 */
function snapshotOf(result: RecallResultLike): EngineSnapshot {
  const channels = result.channels.map(item => `${item.channel}=${item.status}`)
  return Object.freeze({
    fuse: result.fuse,
    rrfK: null,
    bm25K1: null,
    bm25B: null,
    weights: Object.freeze({ ...result.weights }),
    normalizedBy: typeof result.normalizedBy === 'number' ? result.normalizedBy : null,
    channels: Object.freeze(channels),
  })
}

/**
 * 参数快照的比对键。
 *
 * 只把「会影响排序」的字段拼进来：`channels` 与 `normalizedBy` 每轮都可能不同
 * （某个通道这轮没命中），拿它们当「参数变了」会让每次对比都报「参数不同」。
 * @param engine 快照。
 */
function engineKeyOf(engine: EngineSnapshot): string {
  const weights = Object.keys(engine.weights)
    .sort()
    .map(key => `${key}=${engine.weights[key]}`)
    .join(',')
  return [engine.fuse, engine.rrfK, engine.bm25K1, engine.bm25B, weights].join('|')
}

/** 组一个失败对比。 */
function failedCompare(reason: 'no-store' | 'no-previous' | 'unreadable', note: string): CompareResult {
  return Object.freeze({
    ok: false,
    reason,
    sameEngine: false,
    sameCorpus: false,
    deltas: Object.freeze([]),
    note,
  })
}
