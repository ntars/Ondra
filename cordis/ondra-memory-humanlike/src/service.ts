/**
 * 记忆拟人化的门面（**唯一对外实现** `HumanlikeService` 的类）。
 *
 * 三件事在这里收口：
 *
 * 1. **强度只问 O-010。** `dice()` / `channels()` / `cue()` 里的 R 全部来自
 *    `core.strengthOf()`。本插件一个 `Math.pow(0.5, …)` 都不写——第二份公式
 *    就是第二真源，改一次参数会有一半地方不生效，而且不报错。
 * 2. **扩散只问 O-015。** `ripple()` 把种子交给 `graph.diffuse()`，圈权重、
 *    `surreal` 排除、同条取最大分全部由它做。本插件只补正文与排序。
 * 3. **勾起的候选只问调用方。** 本插件不建索引、不做分词；`cue()` 的入参里
 *    没有「查询 → 结果」这一步（见 `types.ts` 文件头第 3 条）。
 *
 * 两处**如实报告的「做不到」**（不是缺陷，是上游契约缺口）：
 * - `CueResult.penaltyApplied` 恒为 `false`：内核没有「按系数压低 S」的接口，
 *   手册的「未中 → `S ×0.92`」本插件不硬做（用 `revise()` 顶替会顺手把 S ×1.3，
 *   方向正好相反，是更坏的结果）。
 * - `CueResult.unsink` 命中已沉底记忆时为 `'unsupported'`：内核没有 `unarchive()`。
 */

import {
  CHANNEL_PROFILES,
  HumanlikeError,
  MEMORY_CHANNELS,
} from './types.js'
import type {
  ChannelProfile,
  ChannelView,
  CueCandidateInput,
  CueEvaluation,
  CueOptions,
  CueResult,
  DiceOptions,
  DiceResult,
  GraphLike,
  HumanlikeCounters,
  HumanlikeIssue,
  HumanlikeService,
  HumanlikeStats,
  HumanlikeUnavailableReason,
  LogLike,
  MemoryChannel,
  MemoryCoreLike,
  MemoryRecordLike,
  RecallTrace,
  RippleItem,
  RippleOptions,
  RippleResult,
} from './types.js'
import type { Config } from './settings.js'
import { channelOfRecord, stampOf, summarizeChannels } from './channels.js'
import { bigrams, cueProbability, overlapRatio, sharedGramCount } from './cue.js'
import { buildDicePool, emptySkips, pickWeighted } from './dice.js'
import type { DicePool } from './dice.js'
import { arrangeRipple } from './ripple.js'
import { TraceStore } from './trace.js'

/** 问题列表上限（防止一个坏掉的库把内存吃干）。 */
const MAX_ISSUES = 20

/** 圈数夹紧。 */
function clampRings(value: number | undefined, fallback: number): number {
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(3, Math.max(1, base))
}

/** 记忆拟人化服务实现。 */
export class HumanlikeRepository implements HumanlikeService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: HumanlikeUnavailableReason

  private readonly core: MemoryCoreLike | undefined
  private readonly graph: GraphLike | undefined
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number
  private readonly trace: TraceStore
  private readonly issues: HumanlikeIssue[] = []

  private counters: HumanlikeCounters = Object.freeze({
    diceRuns: 0,
    cueRuns: 0,
    cueHits: 0,
    rippleRuns: 0,
    misses: 0,
  })

  /**
   * @param core 记忆内核；缺席则服务不可用。
   * @param graph 图谱服务；缺席只影响 `ripple()`。
   * @param settings 配置。
   * @param trace 记账。
   * @param log 日志。
   * @param now 时间源。
   */
  constructor(
    core: MemoryCoreLike | undefined,
    graph: GraphLike | undefined,
    settings: Config,
    trace: TraceStore,
    log: LogLike,
    now: () => number,
  ) {
    this.core = core
    this.graph = graph
    this.settings = settings
    this.trace = trace
    this.log = log
    this.now = now

    if (!settings.enable) {
      this.available = false
      this.reason = 'disabled'
    } else if (core === undefined) {
      this.available = false
      this.reason = 'no-core'
    } else if (!core.available) {
      this.available = false
      this.reason = 'core-unavailable'
    } else {
      this.available = true
      this.reason = undefined
    }

    if (this.reason === 'no-core') {
      this.pushIssue({ code: 'no-core', detail: '没有记忆内核（ondra-memory-core）：三条想起路径全部不可用' })
    } else if (this.reason === 'core-unavailable') {
      this.pushIssue({ code: 'core-unavailable', detail: '记忆内核在位但不可用（建表失败或端口已关）' })
    }
    if (graph === undefined || !graph.available) {
      this.pushIssue({ code: 'no-graph', detail: '没有图谱服务（ondra-memory-graph）：漫无目的联想不可用，另两条路径不受影响' })
    }
    if (!trace.persisted) {
      this.pushIssue({ code: 'trace-memory-only', detail: '未命中记账只存内存：进程重启后 miss_count 归零' })
    }
  }

  /* ------------------------------ 三通道视图 ------------------------------ */

  channels(at?: number): readonly ChannelView[] {
    const stamp = stampOf(at, this.now())
    if (!this.available) return this.emptyChannels()
    const { records, complete } = this.scanRecords(this.settings.scanLimit)
    if (!complete) {
      this.pushIssue({
        code: 'scan-truncated',
        detail: `扫描到 ${this.settings.scanLimit} 条上限，通道视图只覆盖前 ${this.settings.scanLimit} 条`,
      })
    }
    try {
      return summarizeChannels(records, record => this.strengthOf(record, stamp))
    } catch (error) {
      // C3 同型纪律：视图算不出来不该把异常抛给宿主（apply() 结尾会调 stats()，
      // 抛出去就是「插件加载失败」，而真正的原因只是某一条记录算不出强度）。
      this.log.warn('三通道聚合失败，本次返回空视图：%s', messageOf(error))
      this.pushIssue({ code: 'store-issue', detail: `三通道聚合失败：${messageOf(error)}` })
      return this.emptyChannels()
    }
  }

  channelOf(record: MemoryRecordLike): MemoryChannel {
    return channelOfRecord(record)
  }

  describe(channel: string): ChannelProfile | undefined {
    return (MEMORY_CHANNELS as readonly string[]).includes(channel)
      ? CHANNEL_PROFILES[channel as MemoryChannel]
      : undefined
  }

  /* ------------------------------ 固定回忆 ------------------------------ */

  dice(options?: DiceOptions): DiceResult {
    const at = stampOf(options?.at, this.now())
    if (!this.available) {
      return Object.freeze({
        ok: false,
        reason: this.reason,
        at,
        path: 'fixed' as const,
        picked: null,
        candidates: 0,
        skips: emptySkips(),
        totalWeight: 0,
        note: this.unavailableNote(),
      })
    }

    const { records, complete } = this.scanRecords(this.settings.scanLimit)
    let pool: DicePool
    try {
      pool = buildDicePool(
        records,
        at,
        this.settings,
        record => this.strengthOf(record, at),
        options?.includeArchived === true,
      )
    } catch (error) {
      this.log.warn('固定回忆建池失败：%s', messageOf(error))
      return Object.freeze({
        ok: false,
        at,
        path: 'fixed' as const,
        picked: null,
        candidates: 0,
        skips: emptySkips(),
        totalWeight: 0,
        note: `建池失败（${messageOf(error)}），这一轮抽不出来`,
      })
    }
    const random = typeof options?.random === 'function' ? options.random : Math.random
    const picked = pickWeighted(pool.candidates, random)

    this.counters = Object.freeze({ ...this.counters, diceRuns: this.counters.diceRuns + 1 })

    if (picked !== null) {
      // 「三种路径命中都调 reinforce()」（手册 §2.3）。加固走内核，本插件不写 S。
      try {
        this.core?.reinforce(picked.id, 'hit', at)
      } catch (error) {
        this.log.warn('固定回忆加固失败（%s）：%s', picked.id, messageOf(error))
      }
      this.trace.bump(picked.id, { dice: true, at })
    }

    const notes: string[] = []
    if (!complete) notes.push(`扫描到 ${this.settings.scanLimit} 条上限，池子只覆盖前 ${this.settings.scanLimit} 条`)
    if (pool.candidates.length === 0) {
      notes.push(
        `池子是空的（基线不够长 ${pool.skips.shortTerm} 条 / 强度不在区间 ${pool.skips.outOfBand} 条 / 最近想过 ${pool.skips.recent} 条 / 已沉底 ${pool.skips.archived} 条 / 已封存 ${pool.skips.sealed} 条）`,
      )
    }

    return Object.freeze({
      ok: true,
      at,
      path: 'fixed' as const,
      picked,
      candidates: pool.candidates.length,
      skips: pool.skips,
      totalWeight: pool.totalWeight,
      note: notes.length === 0 ? undefined : notes.join('；'),
    })
  }

  /* ------------------------------ 被话头勾起 ------------------------------ */

  cue(options: CueOptions): CueResult {
    const at = stampOf(options.at, this.now())
    if (!this.available) {
      return Object.freeze({
        ok: false,
        reason: this.reason,
        at,
        path: 'cue' as const,
        considered: 0,
        passed: 0,
        best: null,
        probability: 0,
        hit: false,
        reinforced: false,
        unsink: 'not-needed' as const,
        penaltyApplied: false as const,
        misses: 0,
        note: this.unavailableNote(),
      })
    }

    if (typeof options.text !== 'string') {
      throw new HumanlikeError('bad-request', 'cue() 的 text 必须是字符串')
    }
    if (!Array.isArray(options.candidates)) {
      throw new HumanlikeError('bad-request', 'cue() 的 candidates 必须是数组（通常来自 O-014 的 hits）')
    }

    const queryGrams = bigrams(options.text)
    const evaluations: CueEvaluation[] = []
    let considered = 0

    for (const candidate of options.candidates) {
      if (!isCandidate(candidate)) continue
      considered += 1
      const record = this.core?.getFact(candidate.id)
      // 内核里查不到（已被忘记）：不评估、不记账。忘掉的记忆不该因为候选里还留着它而复活。
      if (record === undefined) continue

      const text = record.text === '' ? candidate.text : record.text
      const textGrams = bigrams(text)
      const shared = sharedGramCount(queryGrams, textGrams)
      if (shared < this.settings.minSharedGrams) continue

      const strength = this.strengthOf(record, at).strength
      const overlap = overlapRatio(queryGrams, textGrams)
      evaluations.push({
        id: candidate.id,
        text,
        overlap,
        shared,
        strength,
        probability: cueProbability(overlap, strength, this.settings),
        archived: record.archived,
      })
    }

    // 概率最高的那条：并列时取 id 小的（全序，保证同一份数据两次调用结果一致）。
    let best: CueEvaluation | null = null
    for (const evaluation of evaluations) {
      if (best === null) {
        best = evaluation
        continue
      }
      if (evaluation.probability > best.probability) {
        best = evaluation
      } else if (evaluation.probability === best.probability && evaluation.id < best.id) {
        best = evaluation
      }
    }

    this.counters = Object.freeze({ ...this.counters, cueRuns: this.counters.cueRuns + 1 })

    if (best === null) {
      return Object.freeze({
        ok: true,
        at,
        path: 'cue' as const,
        considered,
        passed: 0,
        best: null,
        probability: 0,
        hit: false,
        reinforced: false,
        unsink: 'not-needed' as const,
        penaltyApplied: false as const,
        misses: 0,
        note:
          considered === 0
            ? '候选为空：勾起不自己检索，候选应由 O-014 的 hits 传入'
            : `没有候选与话头共享 ≥${this.settings.minSharedGrams} 个二元组，这一句没有勾起任何东西`,
      })
    }

    const random = typeof options.random === 'function' ? options.random : Math.random
    const raw = random()
    const roll = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0
    const hit = roll < best.probability

    let reinforced = false
    let unsink: 'done' | 'unsupported' | 'not-needed' = 'not-needed'
    let misses = 0

    if (hit) {
      try {
        this.core?.reinforce(best.id, 'hit', at)
        reinforced = true
      } catch (error) {
        this.log.warn('勾起加固失败（%s）：%s', best.id, messageOf(error))
      }
      this.counters = Object.freeze({ ...this.counters, cueHits: this.counters.cueHits + 1 })
      if (best.archived) {
        // 手册：「中 → 加固 + 从归档捞回」。捞回需要 `unarchive()`，内核没有。
        unsink = 'unsupported'
        this.pushIssue({
          code: 'unsink-unsupported',
          id: best.id,
          detail: '勾起了这条已沉底的记忆，但内核没有 unarchive()，捞不回来（只能加固，仍停在归档位）',
        })
      }
      misses = this.trace.read(best.id)?.missCount ?? 0
    } else {
      const trace = this.trace.bump(best.id, { miss: true, cue: true, at })
      misses = trace.missCount
      this.counters = Object.freeze({ ...this.counters, misses: this.counters.misses + 1 })
      // 手册：「未中 → missCount+1、S ×0.92」。前半做得到，后半没有接口。
      this.pushIssue({
        code: 'penalty-unsupported',
        detail: '手册的「未中 → S×0.92」需要内核提供按系数压低 S 的接口；本插件只记 miss_count，不改 S',
      })
    }

    return Object.freeze({
      ok: true,
      at,
      path: 'cue' as const,
      considered,
      passed: evaluations.length,
      best,
      probability: best.probability,
      hit,
      reinforced,
      unsink,
      penaltyApplied: false as const,
      misses,
      note: hit
        ? undefined
        : `概率 ${best.probability.toFixed(2)}，这一次没想起来（未命中计数 ${misses}）`,
    })
  }

  /* ------------------------------ 漫无目的联想 ------------------------------ */

  ripple(seed: string, options?: RippleOptions): RippleResult {
    const at = stampOf(options?.at, this.now())
    if (!this.available) {
      return Object.freeze({
        ok: false,
        reason: this.reason,
        at,
        path: 'ripple' as const,
        seed,
        ringsDone: 0,
        items: Object.freeze([]),
        note: this.unavailableNote(),
      })
    }
    if (typeof seed !== 'string' || seed === '') {
      throw new HumanlikeError('bad-request', 'ripple() 的 seed 必须是非空记忆 id')
    }
    if (this.graph === undefined || !this.graph.available) {
      return Object.freeze({
        ok: false,
        reason: 'no-graph' as const,
        at,
        path: 'ripple' as const,
        seed,
        ringsDone: 0,
        items: Object.freeze([]),
        note: '没有图谱服务：扩散不可用（另两条路径不受影响）',
      })
    }

    // 上一个 guard 已把 `this.graph` 收窄成非空，这里只取局部常量，
    // 不再判一次 undefined（那会触发「比较无重叠」，O-014 踩过同型的坑）。
    const graph = this.graph
    const maxRings = clampRings(options?.maxRings, this.settings.rippleRings)
    // 不传 minWeight：扩散门槛是 O-015 的配置（与 O-014 共用一个数），本插件不复制。
    const result = graph.diffuse([seed], { maxRings })

    const cache = new Map<string, MemoryRecordLike | undefined>()
    const lookup = (id: string): MemoryRecordLike | undefined => {
      if (!cache.has(id)) cache.set(id, this.core?.getFact(id))
      return cache.get(id)
    }

    const arranged = arrangeRipple(result, id => {
      const record = lookup(id)
      return record === undefined ? null : record.text
    })
    // 封存的记忆不参与回忆（手册 §2.4）。扩散是图谱面，不看记忆状态，所以这里补一刀。
    const visible = arranged.filter(item => {
      const record = lookup(item.id)
      return record === undefined || !record.sealed
    })

    this.counters = Object.freeze({ ...this.counters, rippleRuns: this.counters.rippleRuns + 1 })

    const dangling = visible.filter((item: RippleItem) => item.text === null).length
    const notes: string[] = []
    if (visible.length === 0) notes.push('这条记忆没有任何边，扩散为空')
    if (dangling > 0) notes.push(`有 ${dangling} 条边的另一端在内核里查不到（孤儿边），正文留空`)

    return Object.freeze({
      ok: true,
      at,
      path: 'ripple' as const,
      seed,
      ringsDone: result.ringsDone,
      items: Object.freeze(visible),
      note: notes.length === 0 ? undefined : notes.join('；'),
    })
  }

  /* ------------------------------ 记账与统计 ------------------------------ */

  traceOf(id: string): RecallTrace | undefined {
    return this.trace.read(id)
  }

  stats(): HumanlikeStats {
    let facts = 0
    if (this.available && this.core !== undefined) {
      try {
        facts = this.core.countFacts()
      } catch (error) {
        this.log.warn('统计记忆条数失败：%s', messageOf(error))
      }
    }
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      facts,
      channels: this.channels(),
      counters: this.counters,
      tracePersisted: this.trace.persisted,
      graphAvailable: this.graph !== undefined && this.graph.available,
      issues: Object.freeze([...this.issues]),
    })
  }

  /* ------------------------------ 内部 ------------------------------ */

  /**
   * 分页扫描记忆。
   *
   * 端口没有聚合面，只能分页；撞 `limit` 时返回 `complete=false`，
   * **不静默半扫**（半扫会让「池子是空的」这个结论变得不可信）。
   * @param limit 条数上限。
   */
  private scanRecords(limit: number): { records: MemoryRecordLike[]; complete: boolean } {
    const core = this.core
    if (core === undefined) return { records: [], complete: false }

    const records: MemoryRecordLike[] = []
    let offset = 0
    for (;;) {
      const page = core.listFacts({ limit: this.settings.pageSize, offset })
      records.push(...page)
      offset += page.length
      if (page.length < this.settings.pageSize) return { records, complete: true }
      if (records.length >= limit) {
        return { records: records.slice(0, limit), complete: false }
      }
    }
  }

  /** 取强度（唯一来源是 O-010）。 */
  private strengthOf(record: MemoryRecordLike, at: number): { strength: number; stabilityHours: number } {
    const view = this.core?.strengthOf(record, at)
    if (view === undefined) return { strength: 0, stabilityHours: record.stabilityHours }
    return { strength: view.strength, stabilityHours: view.stabilityHours }
  }

  /** 不可用时的空通道视图（保持三行，界面不必判空）。 */
  private emptyChannels(): readonly ChannelView[] {
    return Object.freeze(
      MEMORY_CHANNELS.map(channel =>
        Object.freeze({
          channel,
          count: 0,
          active: 0,
          archived: 0,
          sealed: 0,
          avgStrength: null,
          avgStabilityHours: null,
          sampleIds: Object.freeze([]),
          profile: CHANNEL_PROFILES[channel],
        }),
      ),
    )
  }

  /** 不可用的一句话。 */
  private unavailableNote(): string {
    if (this.reason === 'disabled') return '记忆拟人化已关闭（enable=false）'
    if (this.reason === 'no-core') return '没有记忆内核（ondra-memory-core）'
    if (this.reason === 'core-unavailable') return '记忆内核在位但不可用'
    if (this.reason === 'no-graph') return '没有图谱服务'
    return '不可用'
  }

  /** 记一条问题（同码同 id 只留一条，避免每次调用刷屏）。 */
  private pushIssue(issue: HumanlikeIssue): void {
    const exists = this.issues.some(item => item.code === issue.code && item.id === issue.id)
    if (exists) return
    if (this.issues.length >= MAX_ISSUES) {
      if (!this.issues.some(item => item.code === 'too-many-issues')) {
        this.issues.push({ code: 'too-many-issues', detail: `问题已超过 ${MAX_ISSUES} 条，后续同类不再记录` })
      }
      return
    }
    this.issues.push(issue)
  }
}

/** 取错误消息。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 判一个候选形状是否合法。 */
function isCandidate(value: unknown): value is CueCandidateInput {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record['id'] === 'string' && record['id'] !== '' && typeof record['text'] === 'string'
}
