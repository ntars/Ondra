/**
 * 信任读数服务的实现：**只读投影，不落盘，不写上游**。
 *
 * 全部上游依赖都是**取值函数**（`() => ctx.get(...)`）：晚装载能自愈，早卸载立刻反映。
 *
 * 一条贯穿全文件的纪律：**任何上游缺席或抛错都不外溢**。
 * 一个读数的取值失败，只让那一项变成 `unknown`，其余照常出表——
 * 大盘挂一片红比「少一项」糟得多（C3：器官错误不得传播，本插件按同一条纪律办）。
 */

import {
  countOf,
  memoryReadingOf,
  promiseReadingOf,
  relationReadingOf,
  summaryOf,
} from './readings.js'
import { READING_IDS, READING_SPECS, TrustError } from './types.js'
import type {
  AuditLike,
  ClockLike,
  LogLike,
  MemoryCoreLike,
  ProspectiveLike,
  ReadingId,
  ReadingSpec,
  StageLike,
  TrustBoard,
  TrustDashboardService,
  TrustReading,
  TrustStats,
  TrustUnavailableReason,
} from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。全部是取值函数：任何一项随时可能变成 `undefined`。 */
export interface TrustDashboardDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-028 关系阶段（软；缺席时前三项读不到）。 */
  readonly stage: () => StageLike | undefined
  /** O-021 承诺（软；缺席时履约率读不到）。 */
  readonly prospective: () => ProspectiveLike | undefined
  /** O-010 记忆内核（软；缺席时记忆存量读不到）。 */
  readonly core: () => MemoryCoreLike | undefined
  /** O-017 遗忘审计（软；缺席时钉子数读不到，但存量照出）。 */
  readonly audit: () => AuditLike | undefined
  /** O-003 时钟（软；缺席退回系统时间）。 */
  readonly clock: () => ClockLike | undefined
  /** 系统时间兜底。 */
  readonly now: () => number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 信任读数服务。 */
export class TrustDashboard implements TrustDashboardService {
  readonly #deps: TrustDashboardDeps

  /** 累计出表次数。 */
  #built = 0

  /** 累计上游调用失败次数。 */
  #degraded = 0

  /**
   * @param deps 依赖。
   */
  constructor(deps: TrustDashboardDeps) {
    this.#deps = deps
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): TrustUnavailableReason | undefined {
    return this.#deps.settings.enable ? undefined : 'disabled'
  }

  /** 五项说明书。 */
  specs(): readonly ReadingSpec[] {
    return Object.freeze(READING_IDS.map(id => READING_SPECS[id]))
  }

  /**
   * 出表。
   * @param at 时刻。
   */
  board(at?: number): TrustBoard {
    this.#assertEnabled()
    const now = at ?? this.#now()

    const readings: TrustReading[] = []
    const missing: string[] = []

    // 1. 关系三项：一次取值供三项用，避免三次调用拿到三个不同时刻的快照。
    const relation = this.#readRelation(now)
    for (const id of ['trust', 'intimacy', 'familiarity'] as const) {
      readings.push(relationReadingOf(id, relation))
    }
    if (relation === undefined) missing.push('ondra-emotion-stage')

    // 2. 履约率。
    const promiseStats = this.#readPromiseStats()
    readings.push(promiseReadingOf(promiseStats))
    if (promiseStats === undefined) missing.push('ondra-memory-prospective')

    // 3. 记忆存量（可关）。
    if (this.#deps.settings.includeMemoryCover) {
      const active = this.#readActiveCount()
      const pinned = this.#readPinCount()
      readings.push(memoryReadingOf(active, pinned))
      if (active === null) missing.push('ondra-memory-core')
      if (pinned === null) missing.push('ondra-memory-audit')
    }

    const known = readings.filter(item => item.value !== null).length
    this.#built += 1

    return Object.freeze({
      at: now,
      readings: Object.freeze(readings),
      counts: Object.freeze({ known, unknown: readings.length - known, total: readings.length }),
      // 去重且保持「先缺先列」：同一服务只报一次。
      missing: Object.freeze([...new Set(missing)]),
      summary: summaryOf(readings, [...new Set(missing)]),
    })
  }

  /**
   * 取一项。
   * @param id 项 id。
   * @param at 时刻。
   */
  readingOf(id: ReadingId, at?: number): TrustReading {
    if (!(READING_IDS as readonly string[]).includes(id)) {
      throw new TrustError('no-such-reading', `没有「${String(id)}」这一项读数。可选：${READING_IDS.join(' / ')}。`)
    }
    const board = this.board(at)
    const found = board.readings.find(item => item.id === id)
    if (found === undefined) {
      // 走到这里只可能是 `includeMemoryCover=false` 关掉了那一项。
      throw new TrustError('no-such-reading', `「${id}」这一项被配置关掉了（include-memory-cover=false）。`)
    }
    return found
  }

  /** 统计快照。 */
  stats(): TrustStats {
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      built: this.#built,
      degraded: this.#degraded,
    })
  }

  /** 现在。时钟缺席退回系统时间。 */
  #now(): number {
    const clock: ClockLike | undefined = this.#deps.clock()
    if (clock === undefined) return this.#deps.now()
    try {
      return clock.now()
    } catch (error) {
      this.#degraded += 1
      if (this.#deps.settings.verbose) this.#deps.log.warn('时钟调用失败，退回系统时间：%s', messageOf(error))
      return this.#deps.now()
    }
  }

  /**
   * 读关系快照。**失败一次就整块返回 `undefined`**，不拼半个对象。
   *
   * 拼半个对象的后果：信任读到了、亲密没读到，而 `ratioOf(undefined)` 会变成 `null`，
   * 界面上三项里两项空着一项有值——看起来像「亲密和熟悉都是 0」。
   */
  #readRelation(at: number): ReturnType<StageLike['relation']> | undefined {
    const stage = this.#deps.stage()
    if (stage === undefined || !stage.available) return undefined
    try {
      const relation = stage.relation(at)
      // 逐字段验一遍：上游给了个 `NaN` 也要当读不到，不能在界面上画出一根 NaN 的柱子。
      if (
        ratioOk(relation.trust) === null ||
        ratioOk(relation.intimacy) === null ||
        ratioOk(relation.familiarity) === null
      ) {
        this.#degraded += 1
        this.#deps.log.warn('关系服务返回的快照字段不合法，三项读数按读不到处理')
        return undefined
      }
      return relation
    } catch (error) {
      this.#degraded += 1
      this.#deps.log.warn('读关系快照失败，前三项按读不到处理：%s', messageOf(error))
      return undefined
    }
  }

  /** 读承诺统计。 */
  #readPromiseStats(): ReturnType<ProspectiveLike['stats']> | undefined {
    const prospective = this.#deps.prospective()
    if (prospective === undefined || !prospective.available) return undefined
    try {
      return prospective.stats()
    } catch (error) {
      this.#degraded += 1
      this.#deps.log.warn('读承诺统计失败，履约率按读不到处理：%s', messageOf(error))
      return undefined
    }
  }

  /** 读活跃记忆条数。 */
  #readActiveCount(): number | null {
    const core = this.#deps.core()
    if (core === undefined || !core.available) return null
    try {
      return countOf(core.countFacts({ state: 'active' }))
    } catch (error) {
      this.#degraded += 1
      this.#deps.log.warn('统计活跃记忆失败：%s', messageOf(error))
      return null
    }
  }

  /** 读钉子条数。 */
  #readPinCount(): number | null {
    const audit = this.#deps.audit()
    if (audit === undefined || !audit.available) return null
    try {
      return audit.pinned().length
    } catch (error) {
      this.#degraded += 1
      this.#deps.log.warn('读钉子清单失败：%s', messageOf(error))
      return null
    }
  }

  /** 关掉时一律拒（读也不行——`available=false` 就该一致）。 */
  #assertEnabled(): void {
    if (!this.#deps.settings.enable) {
      throw new TrustError('disabled', '信任读数已关闭（enable=false）。重新打开即可继续。')
    }
  }
}

/** 有限数或 `null`（比例专用，只判合法性不夹范围）。 */
function ratioOk(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}
