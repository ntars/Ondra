/**
 * 衰减服务：把「什么时候该复习」「现在暗到什么程度」接到 O-010 的记忆内核上。
 * **只经服务键调用，不 import 源码**。
 *
 * 三条实现纪律：
 *
 * 1. **强度一律问 O-010。** 本文件没有一处 `Math.pow(0.5, ...)`——那是
 *    `core.strengthOf()` 的事。第二份公式就是第二真源：改一次参数会有一半地方
 *    不生效，而且**不报错**。
 * 2. **归档一律问 O-010。** `archiveDue()` 的 30/90 天窗口在 O-010 一处定义，
 *    本插件只负责在合适的时机调它，绝不自己写 `archived=1`。
 * 3. **复习成功才算加固。** `grade < 3` 是「没想起来」，这时候还去
 *    `reinforce('hit')` 等于奖励一次失败——那条记忆会变得更牢，而她其实想不起来。
 */

import { clarityOf as clarityAt } from './decay.js'
import type { ReviewRow, ReviewStore } from './review-store.js'
import type { Config } from './settings.js'
import { PASS_GRADE, clampGrade, efAfter, initialEf, intervalHoursOf } from './sm2.js'
import { DecayError } from './types.js'
import type {
  ClarityView,
  DecayCounters,
  DecayReport,
  DecayService,
  DecayStats,
  DecayUnavailableReason,
  FadedItem,
  LogLike,
  MemoryCoreLike,
  MemoryRecordLike,
  ReviewItem,
  ReviewOutcome,
} from './types.js'

/** 一小时的毫秒数。 */
const HOUR_MS = 3600000

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 衰减实现。 */
export class DecayRepository implements DecayService {
  private readonly core: MemoryCoreLike | undefined
  private readonly reviewStore: ReviewStore | undefined
  private readonly storePresent: boolean
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number

  private lastErrorText: string | undefined
  private lastScanStamp = 0

  private readonly counters: {
    scans: number
    reviews: number
    lapses: number
    initialized: number
    archived: number
  } = { scans: 0, reviews: 0, lapses: 0, initialized: 0, archived: 0 }

  /**
   * @param core 记忆内核（可能缺席）。
   * @param reviewStore 复习计划仓库（可能缺席）。
   * @param storePresent 存储端口是否在位（用来区分 `no-store` 与 `schema-failed`）。
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   */
  constructor(
    core: MemoryCoreLike | undefined,
    reviewStore: ReviewStore | undefined,
    storePresent: boolean,
    settings: Config,
    log: LogLike,
    now: () => number,
  ) {
    this.core = core
    this.reviewStore = reviewStore
    this.storePresent = storePresent
    this.settings = settings
    this.log = log
    this.now = now
  }

  /** 是否可用。 */
  get available(): boolean {
    if (!this.settings.enable) return false
    if (this.core === undefined || !this.core.available) return false
    if (this.reviewStore === undefined || !this.reviewStore.available) return false
    return true
  }

  /** 不可用原因。 */
  get reason(): DecayUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (this.core === undefined) return 'no-core'
    if (!this.core.available) return 'core-unavailable'
    if (!this.storePresent) return 'no-store'
    if (this.reviewStore === undefined || !this.reviewStore.available) return 'schema-failed'
    return undefined
  }

  /* ---------------------------- 清晰度 ---------------------------- */

  clarityOf(strength: number): ClarityView {
    return clarityAt(strength, this.settings.clearAbove, this.settings.fadedAbove)
  }

  clarityOfRecord(record: MemoryRecordLike, at?: number): ClarityView {
    const core = this.core
    if (core === undefined || !core.available) return clarityAt(0, this.settings.clearAbove, this.settings.fadedAbove)
    const stamp = typeof at === 'number' ? at : this.now()
    try {
      const view = core.strengthOf(record, stamp)
      return clarityAt(view.strength, this.settings.clearAbove, this.settings.fadedAbove)
    } catch (error) {
      this.lastErrorText = messageOf(error)
      this.log.warn('算强度失败（按「已模糊」显示）：%s', messageOf(error))
      return clarityAt(0, this.settings.clearAbove, this.settings.fadedAbove)
    }
  }

  /* ---------------------------- 复习 ---------------------------- */

  dueForReview(at?: number, limit?: number): readonly ReviewItem[] {
    const core = this.core
    const store = this.reviewStore
    if (core === undefined || !core.available || store === undefined || !store.available) return []
    const stamp = typeof at === 'number' ? at : this.now()
    const take = typeof limit === 'number' && limit > 0 ? limit : this.settings.maxReviewBatch

    const items: ReviewItem[] = []
    for (const row of store.due(stamp, take)) {
      const record = core.getFact(row.id)
      // 孤儿计划：记忆已被忘记（`forget()` 会连行一起删，但崩溃或跨库复制会留下）。
      // 这里顺手清掉——留着会让「该复习了」永远清不完。
      if (record === undefined) {
        store.remove(row.id)
        continue
      }
      // 沉底与封存的不排复习：手册里这两类「不参与主动回忆」，
      // 给它们排复习等于偷偷把它们捞回主动位。
      if (record.archived || record.sealed) continue
      let strength = 0
      try {
        strength = core.strengthOf(record, stamp).strength
      } catch (error) {
        this.lastErrorText = messageOf(error)
      }
      items.push(
        Object.freeze({
          id: row.id,
          dueAt: row.dueAt,
          overdueHours: Math.max(0, (stamp - row.dueAt) / HOUR_MS),
          ef: row.ef,
          reps: row.reps,
          lapses: row.lapses,
          strength,
          category: record.category,
          text: record.text,
        }),
      )
    }
    return Object.freeze(items)
  }

  review(id: string, grade: number, at?: number): ReviewOutcome {
    const core = this.core
    const store = this.reviewStore
    if (core === undefined || !core.available) {
      throw new DecayError('core-unavailable', `记忆内核不可用（${this.reason ?? '未知原因'}），无法记录复习`)
    }
    if (store === undefined || !store.available) {
      throw new DecayError('no-store', '复习计划表不可用，无法记录复习')
    }
    const record = core.getFact(id)
    if (record === undefined) {
      throw new DecayError('bad-request', `找不到记忆 ${id}（可能已被忘记）`, id)
    }

    const stamp = typeof at === 'number' ? at : this.now()
    const existing = store.get(id) ?? this.initialRow(record, stamp)
    const q = clampGrade(grade)
    const ef = efAfter(existing.ef, q)
    const lapsed = q < PASS_GRADE
    const reps = lapsed ? 0 : existing.reps + 1
    const lapses = lapsed ? existing.lapses + 1 : existing.lapses
    const intervalHours = intervalHoursOf(reps, existing.intervalHours, ef, this.settings.maxIntervalDays * 24)
    const dueAt = stamp + intervalHours * HOUR_MS

    store.put({
      id,
      ef,
      reps,
      lapses,
      intervalHours,
      lastReviewAt: stamp,
      dueAt,
      grade: q,
      createdAt: existing.createdAt,
    })

    // 只有「想起来了」才加固。`grade < 3` 时去 `reinforce('hit')`，
    // 等于给一次失败发奖励——那条记忆会变得更牢，而她其实想不起来。
    let reinforced = false
    if (!lapsed) {
      try {
        core.reinforce(id, 'hit', stamp)
        reinforced = true
      } catch (error) {
        this.lastErrorText = messageOf(error)
        this.log.warn('复习加固失败（复习计划已更新，强度未变）：%s', messageOf(error))
      }
    }

    this.counters.reviews += 1
    if (lapsed) this.counters.lapses += 1

    return Object.freeze({
      id,
      grade: q,
      ef,
      reps,
      lapses,
      intervalHours,
      dueAt,
      lapsed,
      reinforced,
    })
  }

  /* ---------------------------- 扫描 ---------------------------- */

  scan(at?: number): DecayReport {
    const stamp = typeof at === 'number' ? at : this.now()
    this.lastScanStamp = stamp
    this.counters.scans += 1

    const bands = { clear: 0, faded: 0, blur: 0 }
    const faded: FadedItem[] = []
    let scanned = 0
    let initialized = 0
    let deferred = 0
    let truncated = false

    const core = this.core
    const store = this.reviewStore
    const storeReady = store !== undefined && store.available
    // 一次查询拿全部「已有计划」的 id：逐条 get() 会变成 N 次单行查询，
    // 而扫描可能被对话链调用，N=3000 时那点延迟会被用户看见。
    // 复制成可变副本：下面本轮内新排的计划要往里 add（ids() 返回的是只读视图）。
    const planned = new Set<string>(
      storeReady && store !== undefined
        ? store.ids(this.settings.maxScanRows * 2)
        : [],
    )

    if (core !== undefined && core.available) {
      let records: readonly MemoryRecordLike[] = []
      try {
        records = core.listFacts({ state: 'active', limit: this.settings.maxScanRows })
      } catch (error) {
        this.lastErrorText = messageOf(error)
        this.log.warn('扫描取记录失败（本轮跳过，下一轮再试）：%s', messageOf(error))
      }
      scanned = records.length
      truncated = records.length >= this.settings.maxScanRows

      for (const record of records) {
        let strength = 0
        let stabilityHours = record.stabilityHours
        let remainingHours = 0
        try {
          const view = core.strengthOf(record, stamp)
          strength = view.strength
          stabilityHours = view.stabilityHours
          remainingHours = view.remainingHours
        } catch (error) {
          // 单条算不出强度不该让整轮扫描失败：跳过它，继续看下一条。
          this.lastErrorText = messageOf(error)
          continue
        }

        const clarity = clarityAt(strength, this.settings.clearAbove, this.settings.fadedAbove)
        bands[clarity.band] += 1
        if (clarity.band === 'blur') {
          faded.push(
            Object.freeze({
              id: record.id,
              strength,
              band: clarity.band,
              stabilityHours,
              remainingHours,
              category: record.category,
            }),
          )
        }

        if (storeReady && store !== undefined && !planned.has(record.id)) {
          if (initialized >= this.settings.maxInitPerScan) {
            deferred += 1
            continue
          }
          store.put(this.initialRow(record, stamp))
          planned.add(record.id)
          initialized += 1
        }
      }
    }

    // 最暗的排在最前：成长面板与夜巡清单都要「先看快没了的」。
    faded.sort((a, b) => a.strength - b.strength)

    // 归档**只调 O-010**：30/90 天窗口在那里定义，本插件不复制第二份。
    let archived: readonly string[] = []
    if (core !== undefined && core.available) {
      try {
        archived = core.archiveDue(stamp)
        this.counters.archived += archived.length
      } catch (error) {
        this.lastErrorText = messageOf(error)
        this.log.warn('归档扫描失败（记忆未丢，只是没沉底）：%s', messageOf(error))
      }
    }

    const dueReviews = storeReady && store !== undefined ? store.countDue(stamp) : 0
    this.counters.initialized += initialized

    if (archived.length > 0) {
      this.log.info('已沉底 %d 条（只忘不删，仍可按类翻到）', archived.length)
    }
    if (deferred > 0) {
      this.log.info('还有 %d 条没建复习计划（受 maxInitPerScan 限流，下一轮继续）', deferred)
    }

    return Object.freeze({
      at: stamp,
      scanned,
      initialized,
      deferred,
      dueReviews,
      faded: Object.freeze(faded),
      archived,
      bands: Object.freeze({ ...bands }),
      truncated,
    })
  }

  archive(at?: number): readonly string[] {
    const core = this.core
    if (core === undefined || !core.available) return []
    const stamp = typeof at === 'number' ? at : this.now()
    try {
      const archived = core.archiveDue(stamp)
      this.counters.archived += archived.length
      return archived
    } catch (error) {
      this.lastErrorText = messageOf(error)
      this.log.warn('归档失败（记忆未丢，只是没沉底）：%s', messageOf(error))
      return []
    }
  }

  /* ---------------------------- 统计 ---------------------------- */

  stats(): DecayStats {
    const counters: DecayCounters = Object.freeze({ ...this.counters })
    const core = this.core
    const store = this.reviewStore
    const storeReady = store !== undefined && store.available
    const stamp = this.now()

    const base: DecayStats = {
      available: this.available,
      coreProvider: core === undefined ? 'none' : core.stats().provider,
      reviews: storeReady && store !== undefined ? store.count() : 0,
      dueNow: storeReady && store !== undefined ? store.countDue(stamp) : 0,
      lastScanAt: this.lastScanStamp,
      counters,
    }
    const reason = this.reason
    const withReason: DecayStats = reason === undefined ? base : { ...base, reason }
    return this.lastErrorText === undefined
      ? Object.freeze(withReason)
      : Object.freeze({ ...withReason, lastError: this.lastErrorText })
  }

  /* ---------------------------- 内部实现 ---------------------------- */

  /**
   * 造一条初始计划：`due_at = 现在`（立刻到期）。
   *
   * 为什么不设成「5 分钟后」：存量库第一次扫描时，所有记忆的 `last_seen_at` 都
   * 可能是几个月前，把它们的首次复习排到「5 分钟后」与「立刻」没有区别；
   * 而新写入的记忆本来就不该在写入那一刻就被复习——它的 `created_at` 就是刚发生的事。
   * 统一「立刻到期」，再由 `maxInitPerScan` 限流，行为最简单也最好解释。
   * @param record 记忆。
   * @param at 时刻。
   */
  private initialRow(record: MemoryRecordLike, at: number): ReviewRow {
    return {
      id: record.id,
      // 初值来自 O-010 的基线 S（已含类别/显著度/唤醒度/通道），不复制 11 类表。
      ef: initialEf(record.stabilityBaseHours),
      reps: 0,
      lapses: 0,
      intervalHours: 0,
      lastReviewAt: at,
      dueAt: at,
      grade: -1,
      createdAt: at,
    }
  }
}
