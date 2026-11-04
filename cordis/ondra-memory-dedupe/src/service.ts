/**
 * 判重服务：把「判定」接到 O-010 的记忆内核上。**只经服务键调用，不 import 源码**。
 *
 * 三条实现纪律：
 *
 * 1. **本插件从不调模型。** 手册 §2.2 的「候选 ≤5 条才交模型」在这里只落成
 *    **闸门**（`maxCandidates`）：把灰区标成 `needsModel`，把候选截到 5 条，
 *    真正发请求的是调用方（O-011 的异步链路 / O-033）。理由是提示词与解析
 *    在 O-011 已经有一份，再造一份就是第二真源。
 * 2. **合并走 `revise()`，不走 `forget()`。** 见 `types.ts` 文件头第 3 条。
 * 3. **任何失败都降级、不抛给对话链。** 判重挂在写入路径上，抛一个错会让
 *    「她记住了一句话」变成「回复失败」——这个代价远大于多存一条重复。
 *    唯一会抛的是「服务根本不可用」（`DedupeError`），那是调用方主动选择的结果。
 */

import { byRankDesc, isSlotReplacement, judge as decide } from './judge.js'
import type { DedupeLog } from './log.js'
import { bigramsOf, containmentOf, effectiveChars, freshCountOf, normalizeForCompare, noveltyOf } from './similarity.js'
import type { Config } from './settings.js'
import { DedupeError } from './types.js'
import type {
  DedupeCandidate,
  DedupeCounters,
  DedupeGroup,
  DedupeOutcome,
  DedupeRequest,
  DedupeService,
  DedupeStats,
  DedupeUnavailableReason,
  DedupeVerdict,
  LogLike,
  MemoryCoreLike,
  MemoryRecordLike,
} from './types.js'

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 一条参与比对的记录（内部用，避免每轮重复归一化）。 */
interface Prepared {
  readonly record: MemoryRecordLike
  readonly normalized: string
  readonly grams: ReadonlySet<string>
}

/** 判重实现。 */
export class DedupeRepository implements DedupeService {
  private readonly core: MemoryCoreLike | undefined
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number
  private readonly logStore: DedupeLog | undefined

  private lastErrorText: string | undefined

  private readonly counters: {
    judged: number
    settled: number
    added: number
    merged: number
    appended: number
    dropped: number
    conflicts: number
  } = { judged: 0, settled: 0, added: 0, merged: 0, appended: 0, dropped: 0, conflicts: 0 }

  /**
   * @param core 记忆内核（可能缺席）。
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   * @param logStore 决策日志（缺席时判重照常，只是事后查不到裁决记录）。
   */
  constructor(
    core: MemoryCoreLike | undefined,
    settings: Config,
    log: LogLike,
    now: () => number,
    logStore: DedupeLog | undefined,
  ) {
    this.core = core
    this.settings = settings
    this.log = log
    this.now = now
    this.logStore = logStore
  }

  /** 是否可用。 */
  get available(): boolean {
    if (!this.settings.enable) return false
    if (this.core === undefined) return false
    return this.core.available
  }

  /** 不可用原因。 */
  get reason(): DedupeUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (this.core === undefined) return 'no-core'
    if (!this.core.available) return 'core-unavailable'
    return undefined
  }

  /* ------------------------------ 候选 ------------------------------ */

  candidates(text: string, limit?: number): readonly DedupeCandidate[] {
    const core = this.core
    if (core === undefined || !core.available) return []
    const normalized = normalizeForCompare(typeof text === 'string' ? text : '')
    const newGrams = bigramsOf(normalized)
    if (newGrams.size === 0) return []

    const take = Math.min(
      this.settings.maxCandidates,
      Math.max(1, typeof limit === 'number' && limit > 0 ? Math.trunc(limit) : this.settings.maxCandidates),
    )

    let records: readonly MemoryRecordLike[] = []
    try {
      // 只比活跃记忆：沉底的与封存的不该被「新写入」合并——
      // 那等于给一条已经退出主动位的记忆续命，而这个续命动作没有任何人批准过。
      records = core.listFacts({ state: 'active', limit: this.settings.candidatePool })
    } catch (error) {
      this.lastErrorText = messageOf(error)
      this.log.warn('取判重候选失败（本次按「无候选」处理，直接新建）：%s', messageOf(error))
      return []
    }

    const out: DedupeCandidate[] = []
    for (const record of records) {
      const oldNormalized = normalizeForCompare(record.text)
      if (oldNormalized === '') continue
      const grams = bigramsOf(oldNormalized)
      const containment = containmentOf(newGrams, grams)
      // 槽位替换与包含度是两条独立信号：`我28岁` / `我30岁` 的包含度是 0，
      // 只用包含度收候选，这类冲突永远进不了视野。
      const slotMatch = isSlotReplacement(oldNormalized, normalized, this.settings.slotCoverage, this.settings.maxSlotChars)
      if (containment < this.settings.mergeThreshold && !slotMatch) continue
      out.push(
        Object.freeze({
          id: record.id,
          containment,
          novelty: noveltyOf(newGrams, grams),
          freshGrams: freshCountOf(newGrams, grams),
          slotMatch,
          text: record.text,
          category: record.category,
          kind: record.kind,
          subject: record.subject,
          timesSaid: record.timesSaid,
          revisions: record.revisions,
          createdAt: record.createdAt,
        }),
      )
    }

    out.sort(byRankDesc)
    return Object.freeze(out.slice(0, take))
  }

  /* ------------------------------ 判定 ------------------------------ */

  judge(request: DedupeRequest): DedupeVerdict {
    this.counters.judged += 1
    const text = typeof request.text === 'string' ? request.text : ''
    const chars = effectiveChars(text)

    let tombstoned = false
    if (this.core !== undefined && this.core.available && chars > 0) {
      try {
        tombstoned = this.core.tombstoned(text)
      } catch (error) {
        // 查不了墓碑时按「未被忘记」处理：宁可复活一条，也不要因为查不了而把整批写入挡掉。
        this.lastErrorText = messageOf(error)
        this.log.warn('查墓碑失败，按「未被忘记」处理：%s', messageOf(error))
        tombstoned = false
      }
    }

    return decide({
      request,
      candidates: this.candidates(text),
      tombstoned,
      chars,
      settings: this.settings,
    })
  }

  /* ------------------------------ 落库 ------------------------------ */

  settle(request: DedupeRequest): DedupeOutcome {
    const verdict = this.judge(request)
    const at = typeof request.at === 'number' ? request.at : this.now()
    const core = this.core
    if (core === undefined || !core.available) {
      throw new DedupeError('no-core', `记忆内核不可用（${this.reason ?? '未知原因'}），判重无法落库`)
    }

    let written = false
    let record: MemoryRecordLike | undefined

    try {
      switch (verdict.action) {
        case 'add': {
          record = this.write(core, request, at)
          written = true
          this.counters.added += 1
          break
        }
        case 'merge': {
          const targetId = verdict.targetId
          if (targetId === undefined) break
          // 合并 = 改主条。`revise()` 会把旧正文存进 `oldText`，所以「取较长者」
          // 并没有丢信息；而 `forget()` 会写墓碑，那等于宣称「用户要求忘记」。
          record = core.revise(targetId, verdict.mergedText ?? request.text, at)
          this.counters.merged += 1
          break
        }
        case 'append': {
          const targetId = verdict.targetId
          if (targetId === undefined) break
          core.reinforce(targetId, 'mention', at)
          this.counters.appended += 1
          break
        }
        case 'drop': {
          const targetId = verdict.targetId
          // 复述也是「又被提起了一次」——这正是提及因子该涨的时候。
          if (targetId !== undefined) core.reinforce(targetId, 'mention', at)
          this.counters.dropped += 1
          break
        }
        case 'conflict': {
          this.counters.conflicts += 1
          const targetId = verdict.targetId
          if (this.settings.conflictPolicy === 'seal-old' && targetId !== undefined) {
            // 双时态事实的等价动作：旧值退出活跃位（仍可按类检索翻到），新值成为唯一活跃值。
            core.seal(targetId, at)
          }
          // 默认策略下照常写入新条：判成冲突就「不写」，一次误判就等于丢一条真事实。
          record = this.write(core, request, at)
          written = true
          break
        }
        default: {
          break
        }
      }
    } catch (error) {
      this.lastErrorText = messageOf(error)
      this.log.warn('判重落库失败（本次按「没记住」处理，不阻断对话）：%s', messageOf(error))
    }

    const logged = this.logStore !== undefined
      ? this.logStore.append({
          at,
          action: verdict.action,
          targetId: verdict.targetId ?? null,
          text: typeof request.text === 'string' ? request.text : '',
          containment: verdict.containment,
          reason: verdict.reasons.join('；'),
          written,
        })
      : false

    this.counters.settled += 1
    if (verdict.action === 'conflict') {
      this.log.info('判重报出冲突（策略 %s）：%s', this.settings.conflictPolicy, verdict.reasons.join('；'))
    }

    const outcome: DedupeOutcome = { verdict, written, logged }
    return record === undefined ? Object.freeze(outcome) : Object.freeze({ ...outcome, record })
  }

  /* ---------------------------- 存量扫描 ---------------------------- */

  /**
   * 存量疑似重复（**只报告，不改内容**）。
   *
   * 手册 §2.7 的「无损自动 + 有损人审」：合并是有损的（要选主条、要改写正文），
   * 所以这里只出清单。O(n²) 比对，`maxScanRows` 默认 300。
   * @param limit 参与比对的条数。
   */
  scan(limit?: number): readonly DedupeGroup[] {
    const core = this.core
    if (core === undefined || !core.available) return []
    const take = Math.min(
      this.settings.maxScanRows,
      Math.max(2, typeof limit === 'number' && limit > 0 ? Math.trunc(limit) : this.settings.maxScanRows),
    )

    let records: readonly MemoryRecordLike[] = []
    try {
      records = core.listFacts({ state: 'active', limit: take })
    } catch (error) {
      this.lastErrorText = messageOf(error)
      this.log.warn('存量扫描取记录失败：%s', messageOf(error))
      return []
    }

    const items: Prepared[] = []
    for (const record of records) {
      const normalized = normalizeForCompare(record.text)
      if ([...normalized].length < this.settings.minCompareChars) continue
      items.push({ record, normalized, grams: bigramsOf(normalized) })
    }

    const parent = items.map((_, index) => index)
    const find = (index: number): number => {
      let cursor = index
      while (parent[cursor] !== cursor) {
        const next = parent[cursor] as number
        parent[cursor] = parent[next] as number
        cursor = next
      }
      return cursor
    }
    const union = (a: number, b: number): void => {
      const rootA = find(a)
      const rootB = find(b)
      if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
    }

    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const left = items[i] as Prepared
        const right = items[j] as Prepared
        if (containmentOf(left.grams, right.grams) >= this.settings.mergeThreshold) union(i, j)
      }
    }

    const buckets = new Map<number, number[]>()
    for (let index = 0; index < items.length; index += 1) {
      const root = find(index)
      const bucket = buckets.get(root)
      if (bucket === undefined) buckets.set(root, [index])
      else bucket.push(index)
    }

    const groups: DedupeGroup[] = []
    for (const indexes of buckets.values()) {
      if (indexes.length < 2) continue
      // 锚点取最早写入的那条：它是原始表述，后写入的是复述（`created_at` 升序）。
      indexes.sort((a, b) => (items[a] as Prepared).record.createdAt - (items[b] as Prepared).record.createdAt)
      const anchorIndex = indexes[0] as number
      const anchor = items[anchorIndex] as Prepared
      const members: DedupeCandidate[] = []
      let maxContainment = 0
      for (const index of indexes) {
        const item = items[index] as Prepared
        const containment = index === anchorIndex ? 1 : containmentOf(anchor.grams, item.grams)
        if (containment > maxContainment) maxContainment = containment
        members.push(
          Object.freeze({
            id: item.record.id,
            containment,
            novelty: noveltyOf(item.grams, anchor.grams),
            freshGrams: freshCountOf(item.grams, anchor.grams),
            slotMatch: isSlotReplacement(
              anchor.normalized,
              item.normalized,
              this.settings.slotCoverage,
              this.settings.maxSlotChars,
            ),
            text: item.record.text,
            category: item.record.category,
            kind: item.record.kind,
            subject: item.record.subject,
            timesSaid: item.record.timesSaid,
            revisions: item.record.revisions,
            createdAt: item.record.createdAt,
          }),
        )
      }
      groups.push(
        Object.freeze({
          anchorId: anchor.record.id,
          members: Object.freeze(members),
          maxContainment,
        }),
      )
    }

    groups.sort((a, b) => b.maxContainment - a.maxContainment)
    if (groups.length > 0) {
      this.log.info('存量扫描发现 %d 组疑似重复（只报告，不改内容）', groups.length)
    }
    return Object.freeze(groups)
  }

  /* ------------------------------ 统计 ------------------------------ */

  stats(): DedupeStats {
    const counters: DedupeCounters = Object.freeze({ ...this.counters })
    const logRows = this.logStore === undefined ? 0 : this.logStore.count()
    const base: DedupeStats = {
      available: this.available,
      coreProvider: this.core === undefined ? 'none' : this.core.stats().provider,
      logging: this.logStore !== undefined && this.logStore.available,
      logRows,
      counters,
    }
    const reason = this.reason
    const withReason: DedupeStats = reason === undefined ? base : { ...base, reason }
    return this.lastErrorText === undefined
      ? Object.freeze(withReason)
      : Object.freeze({ ...withReason, lastError: this.lastErrorText })
  }

  /* ---------------------------- 内部实现 ---------------------------- */

  /**
   * 写入新条。
   *
   * `kind` / `category` 的兜底值（`fact` / `misc`）与 O-010 的缺省**必须一致**：
   * 传 `undefined` 会让 O-010 记一条 `bad-kind` issue（它把「没写」也当成「给错」），
   * 而 issue 会一路进 `stats()`，让健康面板天天报警。这条同步纪律写进 README。
   */
  private write(core: MemoryCoreLike, request: DedupeRequest, at: number): MemoryRecordLike {
    return core.addFact({
      text: request.text,
      kind: request.kind ?? 'fact',
      category: request.category ?? 'misc',
      subject: request.subject,
      channel: request.channel,
      summary: request.summary,
      salience: request.salience,
      arousal: request.arousal,
      rawId: request.rawId,
      evidence: request.evidence,
      at,
    })
  }
}
