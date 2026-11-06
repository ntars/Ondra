/**
 * 服务实现：把「上报 → 记录 → 判定 → 视图」四段串起来。
 *
 * 这一层只做三件容易出错的事，别的都不做：
 * 1. **容量兜底**（`maxChannels`）：通道 id 是外部给的，不设上限就是让别人填内存；
 * 2. **合法性与降级**：非法上报丢弃并计数，任何入口都不抛错；
 * 3. **来源标注**：`live / restored / log-port / none` 必须如实反映，
 *    否则面板会把「上次退出前的记录」当成「刚刚的心跳」。
 */

import type { ChannelRecord, Thresholds, Verdict } from './probe.js'
import {
  applyEvent,
  emptyRecord,
  evaluate,
  isChannelId,
  toHealth,
  worstOf,
} from './probe.js'
import type { RecordStore } from './store.js'
import { expectMsOf } from './settings.js'
import type { Config } from './settings.js'
import type {
  ChannelEvent,
  ChannelHealth,
  ChannelHealthService,
  EventCounters,
  HealthReason,
  HealthState,
  HealthStats,
  HealthSummary,
  LogFeedLike,
  LogLike,
} from './types.js'
import { HEALTH_REASON_ZH, channelNamespace, isEvidenceKind } from './types.js'

/** 构造服务所需的依赖。 */
export interface ServiceDeps {
  /** 已补全的配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 时钟（毫秒）。 */
  readonly now: () => number
  /** 记录存储。 */
  readonly store: RecordStore
}

/** 空计数。 */
const EMPTY_COUNTS: EventCounters = Object.freeze({
  inbound: 0,
  outbound: 0,
  errors: 0,
  reconnects: 0,
})

/** 服务的实现。 */
export class HealthProbe implements ChannelHealthService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number
  private readonly store: RecordStore
  private readonly records = new Map<string, ChannelRecord>()
  private readonly labels = new Map<string, string>()
  private feed: LogFeedLike | null = null
  private reported = 0
  private accepted = 0
  private rejected = 0
  private evicted = 0
  private disposed = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: ServiceDeps) {
    this.settings = deps.settings
    this.log = deps.log
    this.now = deps.now
    this.store = deps.store
    this.restore()
  }

  /** 装载期把磁盘上的记录读回来。读不到不是错误（第一次启动就是这样）。 */
  private restore(): void {
    let restored: readonly ChannelRecord[] = []
    try {
      restored = this.store.loadAll()
    } catch {
      restored = []
    }
    for (const record of restored) {
      this.records.set(record.channelId, record)
      this.labels.set(record.channelId, record.label)
    }
    if (restored.length > 0) {
      this.log.info('从磁盘恢复 %d 个通道的探针记录（只用于说明「上次活到几时」）', restored.length)
    }
  }

  get available(): boolean {
    return this.settings.enable
  }

  get reason(): 'disabled' | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  get logPort(): boolean {
    return this.feed !== null
  }

  /** 取判定阈值。 */
  private thresholdsFor(channelId: string): Thresholds {
    return {
      now: this.now(),
      expectMs: expectMsOf(this.settings, channelId),
      staleFactor: this.settings.staleFactor,
      errorWindowMs: this.settings.errorWindowMs,
      reconnectLimit: this.settings.reconnectLimit,
    }
  }

  register(channelId: string, label?: string): boolean {
    if (!isChannelId(channelId)) {
      this.log.warn('通道 id「%s」不合规（必须是 ^[a-z][a-z0-9_-]{1,63}$），已忽略', channelId)
      return false
    }
    const existed = this.records.has(channelId)
    if (label !== undefined && label !== '') this.labels.set(channelId, label)
    if (!existed) {
      const record = emptyRecord(channelId, label ?? channelId, this.now())
      this.records.set(channelId, record)
      // 不标脏：只登记不产生记录文件，否则面板一打开就为每个通道留一个空文件。
      this.store.put(record, false)
    }
    return !existed
  }

  report(event: ChannelEvent | readonly ChannelEvent[]): number {
    if (this.disposed) return 0
    const list: readonly ChannelEvent[] = Array.isArray(event)
      ? (event as readonly ChannelEvent[])
      : [event as ChannelEvent]

    let accepted = 0
    for (const item of list) {
      this.reported += 1
      if (!this.settings.enable) {
        this.rejected += 1
        continue
      }
      if (!isChannelId(item.channelId) || !isEvidenceKind(item.kind)) {
        this.rejected += 1
        continue
      }
      const at = typeof item.at === 'number' && Number.isFinite(item.at) ? item.at : this.now()
      const current = this.ensureRecord(item.channelId)
      const next = applyEvent(current, item, at)
      this.records.set(item.channelId, next)
      this.store.put(next, true)
      accepted += 1
      this.accepted += 1
      if (this.settings.verbose) {
        this.log.info('%s ← %s（%s）', item.channelId, item.kind, item.detail ?? '无说明')
      }
    }
    return accepted
  }

  /**
   * 取记录；没有就造一条，并处理容量上限。
   * @param channelId 通道 id（已校验）。
   */
  private ensureRecord(channelId: string): ChannelRecord {
    const existing = this.records.get(channelId)
    if (existing !== undefined) return existing

    if (this.records.size >= this.settings.maxChannels) this.evictOne()
    const record = emptyRecord(channelId, this.labels.get(channelId) ?? channelId, this.now())
    this.records.set(channelId, record)
    return record
  }

  /** 淘汰最久没动静的一个通道（从没上报过的优先）。 */
  private evictOne(): void {
    let victimId = ''
    let victimAt = Number.POSITIVE_INFINITY
    for (const [channelId, record] of this.records) {
      const at = record.lastEventAt === null ? Number.NEGATIVE_INFINITY : record.lastEventAt
      if (at < victimAt) {
        victimAt = at
        victimId = channelId
      }
    }
    if (victimId === '') return
    this.records.delete(victimId)
    this.evicted += 1
    this.log.warn(
      '通道探针已达上限 %d 个，淘汰最久没动静的「%s」（记录文件保留，下次上报会重新读入）',
      this.settings.maxChannels,
      victimId,
    )
  }

  /**
   * 借日志端口补一条「活着」的证据。
   *
   * 只在**没有任何别的证据**时才用：日志是间接痕迹，比上报弱一档。
   * 读端口本身包 try/catch——端口的实现是别人的，它抛错不能连累面板。
   * @param record 当前记录。
   */
  private refreshFromFeed(record: ChannelRecord): ChannelRecord {
    if (this.feed === null) return record
    try {
      const entries = this.feed.tailNamespace(channelNamespace(record.channelId), 1)
      const newest = entries[entries.length - 1]
      if (newest === undefined || !Number.isFinite(newest.at)) return record
      if (record.lastEventAt !== null && newest.at <= record.lastEventAt) return record
      return applyEvent(
        record,
        { channelId: record.channelId, kind: 'heartbeat', at: newest.at, detail: '来自日志命名空间' },
        newest.at,
      )
    } catch {
      return record
    }
  }

  probe(channelId: string): ChannelHealth {
    const now = this.now()
    let record = this.records.get(channelId)
    if (record === undefined) {
      record = this.refreshFromFeed(
        emptyRecord(channelId, this.labels.get(channelId) ?? channelId, now),
      )
    } else {
      record = this.refreshFromFeed(record)
    }

    const thresholds = this.thresholdsFor(channelId)
    const verdict: Verdict = this.settings.enable
      ? evaluate(record, thresholds)
      : { state: 'unknown', reason: 'disabled', detail: HEALTH_REASON_ZH.disabled }
    return toHealth(record, verdict, thresholds, this.logPort)
  }

  probeAll(): readonly ChannelHealth[] {
    return this.orderedIds().map(channelId => this.probe(channelId))
  }

  summary(): HealthSummary {
    const all = this.probeAll()
    const byState: Record<HealthState, number> = {
      ok: 0,
      degraded: 0,
      stale: 0,
      down: 0,
      unknown: 0,
    }
    for (const health of all) byState[health.state] += 1
    return {
      at: this.now(),
      total: all.length,
      byState: Object.freeze(byState),
      worst: worstOf(all.map(health => health.state)),
      logPort: this.logPort,
      channels: all.map(health => health.channelId),
    }
  }

  /** 按「最后活动从新到旧」排 id；从没活动的排最后（按 id 字典序，稳定可对拍）。 */
  private orderedIds(): readonly string[] {
    const ids = [...this.records.keys()]
    return ids.sort((left, right) => {
      const a = this.records.get(left)?.lastEventAt ?? null
      const b = this.records.get(right)?.lastEventAt ?? null
      if (a === null && b === null) return left < right ? -1 : left > right ? 1 : 0
      if (a === null) return 1
      if (b === null) return -1
      if (a === b) return left < right ? -1 : left > right ? 1 : 0
      return b - a
    })
  }

  channels(): readonly string[] {
    return this.orderedIds()
  }

  forget(channelId: string): boolean {
    const existed = this.records.delete(channelId)
    this.labels.delete(channelId)
    this.store.forget(channelId)
    return existed
  }

  attachLogFeed(feed: LogFeedLike): () => void {
    this.feed = feed
    this.log.info('已接上日志端口：没有任何上报的通道会借日志命名空间补一条「活着」的证据')
    return (): void => {
      if (this.feed === feed) this.feed = null
    }
  }

  flush(): void {
    this.store.flush()
  }

  stats(): HealthStats {
    const storeStats = this.store.stats()
    return {
      reported: this.reported,
      accepted: this.accepted,
      rejected: this.rejected,
      evicted: this.evicted,
      restored: storeStats.restored,
      persisted: storeStats.persisted,
      writeFailures: storeStats.writeFailures,
      channels: this.records.size,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.flush()
    this.records.clear()
    this.labels.clear()
    this.feed = null
  }

  /** 只读的「被盯着的通道数」，给 index 打日志用。 */
  size(): number {
    return this.records.size
  }

  /** 空计数（供面板占位用）。 */
  static emptyCounts(): EventCounters {
    return EMPTY_COUNTS
  }
}

/** 判定原因的中文说法再导出一次，省得调用方各自翻译。 */
export function reasonText(reason: HealthReason): string {
  return HEALTH_REASON_ZH[reason]
}
