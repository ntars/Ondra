/**
 * 决策日志服务：收一条、说成人话、按天读、显式清理。
 *
 * ## 为什么写盘失败不回滚内存
 *
 * 磁盘满、权限不对时，这一条仍然在内存环里：面板还能看到「刚刚这一轮为什么」。
 * 回滚的代价是「连看都看不到」，而不回滚的代价只是「重启后没了」——
 * 追查一个刚发生的问题，前者更致命。
 *
 * ## 为什么 `explain()` 先查环再查当天文件
 *
 * 环里是最近的（跨天也在），当天文件是「重启之后、环被清空」时的补位。
 * 只查环，重启后第一次追问会答「找不到」；只查文件，跨天的那一条又要读两个文件。
 */

import { join } from 'node:path'
import type { Config } from './settings.js'
import {
  appendEntry,
  dayFileName,
  pruneDays,
  readDay,
  LOG_DIR,
} from './store.js'
import { explainOf, normalizeTrace } from './trace.js'
import type {
  ClockLike,
  ExplainView,
  LogLike,
  NarrativeLogService,
  PathLike,
  RecordResult,
  TraceCounters,
  TraceEntry,
  TraceQuery,
  TraceStats,
} from './types.js'

/** 日期键的形状。**只认这一种**。 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 一天有多少毫秒。 */
const DAY_MS = 86_400_000

/** 内部可变的计数。对外只出冻结快照。 */
interface MutableCounters {
  recorded: number
  rejected: number
  writeFailed: number
  pruned: number
}

/** 构造入参。依赖全部用取值函数：上游晚装载时能自愈。 */
export interface NarrativeLogOptions {
  readonly settings: Config
  readonly log: LogLike
  readonly clock: () => ClockLike | undefined
  readonly path: () => PathLike | undefined
  readonly now: () => number
}

/** 两位补零。 */
function pad(value: number): string {
  return String(Math.max(0, Math.trunc(value))).padStart(2, '0')
}

/** 本机时区的日期键（没有 O-003 时的退路）。 */
function localDayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 决策日志服务。 */
export class NarrativeLog implements NarrativeLogService {
  private readonly deps: NarrativeLogOptions
  private readonly settings: Config
  private readonly ring: TraceEntry[] = []
  private readonly counters: MutableCounters = {
    recorded: 0,
    rejected: 0,
    writeFailed: 0,
    pruned: 0,
  }

  private seq = 0
  private disposed = false
  /** `undefined` = 还没试过写盘。 */
  private writeState: boolean | undefined

  constructor(options: NarrativeLogOptions) {
    this.deps = options
    this.settings = options.settings
  }

  /** 是否可用。 */
  get available(): boolean {
    return !this.disposed
  }

  /** 是否真的在写盘。没试过时按「路径服务在不在」预估。 */
  get stored(): boolean {
    if (this.writeState !== undefined) return this.writeState
    return this.settings.enable && this.deps.path() !== undefined
  }

  /** 日志目录路径（不创建）。没有路径服务时是空串。 */
  private dirPath(): string {
    const path = this.deps.path()
    if (path === undefined) return ''
    try {
      return path.fileIn('user', LOG_DIR)
    } catch {
      return ''
    }
  }

  /** 确保日志目录存在，返回其路径。**只在写盘与清理之前调用**（读操作不该建目录）。 */
  private ensureDir(): string | undefined {
    const path = this.deps.path()
    if (path === undefined) return undefined
    try {
      return path.ensure('user', LOG_DIR)
    } catch (error) {
      if (this.settings.verbose) {
        this.deps.log.warn('决策日志目录建不出来：%s', error instanceof Error ? error.message : String(error))
      }
      return undefined
    }
  }

  /** 某个时刻属于哪一天。 */
  private dayKeyOf(at: number): string {
    const clock = this.deps.clock()
    return clock === undefined ? localDayKey(at) : clock.dayKey(at)
  }

  /** 写一条到盘上。返回是否成功与失败原因。 */
  private writeEntry(
    entry: TraceEntry,
  ): { readonly stored: boolean; readonly reason?: 'no-store' | 'write-failed'; readonly message?: string } {
    const path = this.deps.path()
    const dir = this.ensureDir()
    if (path === undefined || dir === undefined) {
      this.writeState = false
      return {
        stored: false,
        reason: 'no-store',
        message: '没有可用的日志目录（路径服务未装载或建目录失败）',
      }
    }

    const file = join(dir, dayFileName(this.dayKeyOf(entry.at)))
    try {
      path.prepareFile(file)
      appendEntry(file, entry)
      this.writeState = true
      return { stored: true }
    } catch (error) {
      this.writeState = false
      this.counters.writeFailed += 1
      const message = error instanceof Error ? error.message : String(error)
      this.deps.log.warn('决策日志写盘失败（这一条只在内存里）：%s', message)
      return { stored: false, reason: 'write-failed', message }
    }
  }

  /** 记一条。 */
  record(input: unknown): RecordResult {
    if (this.disposed) {
      return { ok: false, stored: false, reason: 'invalid', message: '服务已卸载' }
    }
    if (!this.settings.enable) {
      return { ok: false, stored: false, reason: 'disabled', message: '决策日志已关闭（enable=false）' }
    }

    const entry = normalizeTrace(input, {
      now: this.deps.now(),
      seq: (this.seq += 1),
      maxExcerptChars: this.settings.maxExcerptChars,
      maxFactors: this.settings.maxFactors,
      maxGates: this.settings.maxGates,
      maxRefs: this.settings.maxRefs,
      maskSensitive: this.settings.maskSensitive,
      storeExcerpt: this.settings.storeExcerpt,
    })

    if (entry === undefined) {
      this.counters.rejected += 1
      if (this.settings.verbose) {
        this.deps.log.debug?.('决策日志拒收一条：一个可用字段都没有，或结构不是对象')
      }
      return {
        ok: false,
        stored: false,
        reason: 'invalid',
        message: '这一条没有可用字段（chosen / factors / gates / refs / excerpt / note 全空）',
      }
    }

    this.ring.push(entry)
    while (this.ring.length > this.settings.maxEntries) this.ring.shift()
    this.counters.recorded += 1

    const written = this.writeEntry(entry)
    if (written.stored) return { ok: true, id: entry.id, stored: true }
    return {
      ok: true,
      id: entry.id,
      stored: false,
      reason: written.reason ?? 'write-failed',
      message: written.message,
    }
  }

  /** 按回合 id 解释。 */
  explain(turnId: string): ExplainView | undefined {
    if (this.disposed) return undefined
    const wanted = String(turnId).slice(0, 64)
    if (wanted === '') return undefined

    for (const entry of [...this.ring].reverse()) {
      if (entry.turnId === wanted) {
        return Object.freeze({ entry, sentence: explainOf(entry) })
      }
    }

    const dir = this.dirPath()
    if (dir === '') return undefined
    const today = readDay(join(dir, dayFileName(this.dayKeyOf(this.deps.now()))))
    for (const entry of [...today].reverse()) {
      if (entry.turnId === wanted) {
        return Object.freeze({ entry, sentence: explainOf(entry) })
      }
    }
    return undefined
  }

  /** 最近若干条，新的在前。 */
  recent(query?: TraceQuery): readonly TraceEntry[] {
    if (this.disposed) return Object.freeze([])
    const wanted = query?.limit
    const limit =
      typeof wanted === 'number' && Number.isFinite(wanted)
        ? Math.min(this.settings.maxEntries, Math.max(1, Math.trunc(wanted)))
        : this.settings.maxEntries

    const out: TraceEntry[] = []
    for (const entry of [...this.ring].reverse()) {
      if (out.length >= limit) break
      if (query?.conversationId !== undefined && entry.conversationId !== query.conversationId) continue
      if (query?.producer !== undefined && entry.producer !== query.producer) continue
      if (typeof query?.since === 'number' && Number.isFinite(query.since) && entry.at < query.since) continue
      out.push(entry)
    }
    return Object.freeze(out)
  }

  /** 读某一天的文件。 */
  read(dayKey: string): readonly TraceEntry[] {
    if (this.disposed) return Object.freeze([])
    if (!DAY_RE.test(dayKey)) return Object.freeze([])
    const dir = this.dirPath()
    if (dir === '') return Object.freeze([])
    return readDay(join(dir, dayFileName(dayKey)))
  }

  /** 说成人话。 */
  why(entry: TraceEntry): string {
    return explainOf(entry)
  }

  /** 清掉早于保留期的文件。 */
  prune(): number {
    if (this.disposed) return 0
    const dir = this.ensureDir()
    if (dir === undefined) return 0

    const cutoff = this.dayKeyOf(this.deps.now() - this.settings.retentionDays * DAY_MS)
    const removed = pruneDays(dir, cutoff)
    this.counters.pruned += removed
    if (removed > 0) {
      this.deps.log.info('决策日志清理：删掉 %d 个早于 %s 的文件', removed, cutoff)
    }
    return removed
  }

  /** 现状快照。 */
  stats(): TraceStats {
    const counters: TraceCounters = Object.freeze({ ...this.counters })
    return Object.freeze({
      available: !this.disposed,
      stored: this.stored,
      entries: this.ring.length,
      capacity: this.settings.maxEntries,
      dir: this.dirPath(),
      counters,
    })
  }

  /** 卸载。 */
  dispose(): void {
    this.disposed = true
    this.ring.length = 0
  }
}
