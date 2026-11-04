/**
 * 编排：把「今天是哪一天」「记忆库里有什么」「哪条算那年今日」拧在一起。
 *
 * ## 三条纪律
 *
 * 1. **降级不抛错**（器官 ABI 的 C3 精神）：记忆内核抛错、图谱抛错、强度算不出来，
 *    一律降级成空结果 + 一条 `issues`，绝不让异常穿出到对话链。
 *    「那年今日」挂了最多是这块不出现，不该让整轮对话失败。
 * 2. **冻结的是选择，不是读数。** 同一天内选哪几条恒定（前缀缓存要的就是这个），
 *    而强度 R 与清晰度话术每次按当前时间重算——否则面板与注入会各说一套。
 * 3. **记账只记一次。** `take()` 对同一条记忆一天只加固一次，
 *    靠 `accounted` 落盘保证，不靠调用方自觉。
 *
 * ## 为什么「今天」要从 `dayKey` 出发而不是从 `parts` 出发
 *
 * `dayKey` 是本插件对外出示的那一天（状态文件、视图、日志都用它）。
 * 如果把「今天的年月日」从 `parts` 取、把「记忆的年月日」从 `parts` 取，
 * 这两次取时区一致；但状态文件里存的是 `dayKey`，判「是不是同一天」时
 * 又要拿 `parts` 拼一次——拼法只要有一处不同（前导零、月份进位），
 * 就会出现「每一天都被判成新的一天」，于是天天重算、天天重新记账。
 * 故本文件只在**最外层**取一次 `parts`，此后全部以 `dayKey` 为准。
 */

import { dayKeyAt, dayNumberOf, elapsedMs, parseDayKey } from './calendar.js'
import type { Candidate, ScanOutput } from './pick.js'
import { scan, select } from './pick.js'
import type { Config } from './settings.js'
import type { OnThisDayState } from './store.js'
import { emptyState, isFrozenFor, readState, writeState } from './store.js'
import { SHELF_ZH, STATE_VERSION } from './types.js'
import type {
  ClarityViewLike,
  ClockLike,
  DecayLike,
  GraphLike,
  LogLike,
  MemoryCoreLike,
  MemoryRecordLike,
  OnThisDayItem,
  OnThisDayReason,
  OnThisDayService,
  OnThisDayStats,
  OnThisDayTake,
  OnThisDayView,
  OnThisDayWhy,
} from './types.js'

/** 构造服务的入参。 */
export interface OnThisDayDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 时间服务。 */
  readonly clock: ClockLike | undefined
  /** 记忆内核。 */
  readonly core: MemoryCoreLike | undefined
  /** 衰减与清晰度。 */
  readonly decay: DecayLike | undefined
  /** 图谱（只用于「同一件事」去重）。 */
  readonly graph: GraphLike | undefined
  /** 状态文件绝对路径；`undefined` 表示纯内存。 */
  readonly file: string | undefined
}

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 把未知值夹成 0–1 的数。 */
function unitOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000))
}

/** 空视图。 */
function emptyView(
  dayKey: string,
  reason: OnThisDayReason | undefined,
  issues: readonly string[],
  frozen: boolean,
): OnThisDayView {
  return Object.freeze({
    dayKey,
    items: Object.freeze([]),
    dropped: 0,
    scanned: 0,
    truncated: false,
    frozen,
    available: reason === undefined,
    reason,
    issues,
  })
}

/** 「那年今日」服务的实现。 */
export class OnThisDay implements OnThisDayService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: ClockLike | undefined
  private readonly core: MemoryCoreLike | undefined
  private readonly decay: DecayLike | undefined
  private readonly graph: GraphLike | undefined
  private readonly file: string | undefined

  /** 状态只在第一次用到时读盘，之后以内存为准。 */
  private state: OnThisDayState | undefined
  /** 状态是否真的写成功过。 */
  private wroteOk = false

  private lookups = 0
  private computes = 0
  private takes = 0
  private accountedTotal = 0
  private lastScanned = 0
  private lastComputeMs = 0
  private truncatedRuns = 0
  private failures = 0

  constructor(deps: OnThisDayDeps) {
    this.settings = deps.settings
    this.log = deps.log
    this.clock = deps.clock
    this.core = deps.core
    this.decay = deps.decay
    this.graph = deps.graph
    this.file = deps.file
  }

  /* ------------------------------ 只读属性 ------------------------------ */

  get available(): boolean {
    return this.reason === undefined
  }

  get reason(): OnThisDayReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (this.core === undefined) return 'no-memory'
    if (!this.core.available) return 'memory-unavailable'
    return undefined
  }

  get clockReady(): boolean {
    return this.clock !== undefined
  }

  get memoryReady(): boolean {
    return this.core !== undefined && this.core.available
  }

  get stored(): boolean {
    return this.file !== undefined && this.wroteOk
  }

  /* -------------------------------- 查询 -------------------------------- */

  /** 现在的时刻。**唯一的时间入口**：`Date.now()` 只在这里出现一次。 */
  private now(at: number | undefined): number {
    if (typeof at === 'number' && Number.isFinite(at)) return at
    if (this.clock !== undefined) {
      try {
        const value = this.clock.now()
        if (typeof value === 'number' && Number.isFinite(value)) return value
      } catch {
        // 时钟的 now() 抛错就退回系统时间：这一块挂了不该让「今天」不存在。
      }
    }
    return Date.now()
  }

  /** 读状态（懒加载一次）。 */
  private load(): OnThisDayState {
    if (this.state !== undefined) return this.state
    const loaded = readState(this.file)
    if (loaded === undefined) {
      this.state = emptyState()
      // 有路径却读不到，说明是首次运行或存档坏了；两者都按「没算过」处理。
      return this.state
    }
    this.state = loaded
    this.wroteOk = this.file !== undefined
    return this.state
  }

  /** 写状态。 */
  private save(state: OnThisDayState): void {
    this.state = state
    const ok = writeState(this.file, state)
    if (ok) this.wroteOk = true
    if (!ok && this.file !== undefined && this.settings.verbose) {
      this.log.warn('那年今日的状态没写进磁盘：今天内会重复计算与重复记账')
    }
  }

  /**
   * 把冻结项还原成完整条目。
   *
   * 每一步都单独兜住：某一条的记忆被 `forget()` 了、强度算不出来、
   * 清晰度服务挂了，都只是这一条降级，不影响其他几条。
   * @param state 冻结点。
   * @param now 时刻。
   * @param dayKey 自然日键。
   */
  private hydrate(state: OnThisDayState, now: number, dayKey: string): OnThisDayView {
    const core = this.core
    if (core === undefined) return emptyView(dayKey, 'no-memory', Object.freeze([]), true)

    const items: OnThisDayItem[] = []
    const issues: string[] = [...state.issues]
    for (const frozen of state.items) {
      let record: MemoryRecordLike | undefined
      try {
        record = core.getFact(frozen.memoryId)
      } catch (error) {
        issues.push('取记忆「' + frozen.memoryId + '」失败：' + messageOf(error))
        continue
      }
      // 已被遗忘（`forget()` 或合并掉了）：静默少一条，不报错。
      if (record === undefined) continue
      items.push(this.buildItem(frozen.memoryId, frozen.shelf, frozen.daysAgo, frozen.yearsAgo, frozen.leapFolded, record, now, issues))
    }

    return Object.freeze({
      dayKey,
      items: Object.freeze(items),
      dropped: state.dropped,
      scanned: state.scanned,
      truncated: state.truncated,
      frozen: true,
      available: true,
      issues: Object.freeze(issues.slice(0, 8)),
    })
  }

  /**
   * 组装一条条目。
   * @param memoryId 记忆 id。
   * @param shelf 档位。
   * @param daysAgo 日历差。
   * @param yearsAgo 年数。
   * @param leapFolded 是否闰日折叠。
   * @param record 记忆记录。
   * @param now 时刻。
   * @param issues 问题收集器。
   */
  private buildItem(
    memoryId: string,
    shelf: OnThisDayItem['shelf'],
    daysAgo: number,
    yearsAgo: number,
    leapFolded: boolean,
    record: MemoryRecordLike,
    now: number,
    issues: string[],
  ): OnThisDayItem {
    let retention: number | null = null
    try {
      const core = this.core as MemoryCoreLike
      retention = unitOf(core.strengthOf(record, now).strength)
    } catch (error) {
      // 强度算不出来不影响「这条该被想起来」，只是清晰度话术会缺。
      issues.push('算不出「' + memoryId + '」的强度：' + messageOf(error))
    }

    let clarity: ClarityViewLike | null = null
    if (this.decay !== undefined) {
      try {
        const view = this.decay.clarityOfRecord(record, now)
        if (typeof view === 'object' && view !== null && typeof view.band === 'string') {
          clarity = Object.freeze({
            band: view.band,
            phrase: typeof view.phrase === 'string' ? view.phrase : '',
            strength: unitOf(view.strength) ?? 0,
          })
        }
      } catch (error) {
        issues.push('取不到「' + memoryId + '」的清晰度：' + messageOf(error))
      }
    }

    return Object.freeze({
      memoryId,
      shelf,
      category: record.category,
      text: record.text,
      createdAt: record.createdAt,
      timesSaid: record.timesSaid,
      revisions: record.revisions,
      salience: record.salience,
      daysAgo,
      yearsAgo,
      leapFolded,
      retention,
      clarity,
      archived: record.archived === true,
    })
  }

  /**
   * 真算一次：扫库、判档、去重、排序、截断，然后落冻结。
   * @param now 时刻。
   * @param dayKey 自然日键。
   * @param today 今天（已拆好）。
   * @param todayNumber 今天的日历日序号。
   */
  private compute(
    today: { readonly year: number; readonly month: number; readonly day: number },
    todayNumber: number,
    now: number,
    dayKey: string,
  ): OnThisDayView {
    const core = this.core
    if (core === undefined) return emptyView(dayKey, 'no-memory', Object.freeze([]), false)

    const issues: string[] = []
    const startedAt = Date.now()
    let scanned = 0
    let truncated = false
    let candidates: readonly Candidate[] = []

    try {
      const output: ScanOutput = scan({
        core,
        clock: this.clock,
        settings: this.settings,
        today,
        todayNumber,
      })
      scanned = output.scanned
      truncated = output.truncated
      candidates = output.candidates
    } catch (error) {
      this.failures += 1
      const note = '扫描记忆库失败，这一块今天不出现：' + messageOf(error)
      this.log.warn(note)
      return emptyView(dayKey, undefined, Object.freeze([note]), false)
    }

    if (truncated) {
      this.truncatedRuns += 1
      issues.push(
        '只扫了 ' + String(scanned) + ' 条就到上限，更早的周年可能漏（可调 scanLimit）',
      )
    }

    const picked = select({
      candidates,
      cap: this.settings.cap,
      graph: this.graph,
      graphDedupe: this.settings.graphDedupe,
      issues,
    })

    const items: OnThisDayItem[] = []
    for (const candidate of picked.picked) {
      items.push(
        this.buildItem(
          candidate.record.id,
          candidate.shelf,
          candidate.daysAgo,
          candidate.yearsAgo,
          candidate.leapFolded,
          candidate.record,
          now,
          issues,
        ),
      )
    }

    this.computes += 1
    this.lastScanned = scanned
    this.lastComputeMs = elapsedMs(startedAt, Date.now())

    const previous = this.load()
    const frozen: OnThisDayState = Object.freeze({
      version: STATE_VERSION,
      dayKey,
      items: Object.freeze(
        picked.picked.map(item =>
          Object.freeze({
            memoryId: item.record.id,
            shelf: item.shelf,
            daysAgo: item.daysAgo,
            yearsAgo: item.yearsAgo,
            leapFolded: item.leapFolded,
          }),
        ),
      ),
      dropped: picked.dropped,
      scanned,
      truncated,
      issues: Object.freeze(issues.slice(0, 8)),
      // `frozenAt` 就是「算过了」的凭据（见 `isFrozenFor`）。
      //
      // **一行都没扫到就不冻结**：装载期记忆库可能还没开好（或退回了空的内存兜底），
      // 这时扫到 0 条并不说明「今天真的没有旧事」。冻下去的结果是这块整天空白，
      // 而且第二天才会自愈——没有任何报错，日志里还写着「就绪」。
      // 只有「确实看过库」（`scanned > 0`）才值得把结论固定一整天。
      frozenAt: this.settings.freezePerDay && scanned > 0 ? now : 0,
      // 换天则清零；同一天重算（关掉冻结时）保留已有记账，否则会被重复加固。
      accounted: previous.dayKey === dayKey ? previous.accounted : Object.freeze([]),
    })
    this.save(frozen)

    if (this.settings.verbose && frozen.issues.length > 0) {
      for (const issue of frozen.issues) this.log.warn('那年今日：%s', issue)
    }

    return Object.freeze({
      dayKey,
      items: Object.freeze(items),
      dropped: picked.dropped,
      scanned,
      truncated,
      frozen: false,
      available: true,
      issues: frozen.issues,
    })
  }

  /**
   * 今天的「那年今日」。**不记账**。
   * @param at 时刻；省略取现在。
   */
  today(at?: number): OnThisDayView {
    this.lookups += 1
    const reason = this.reason
    if (reason !== undefined) return emptyView('', reason, Object.freeze([]), false)

    const now = this.now(at)
    const dayKey = dayKeyAt(now, this.clock)
    if (dayKey === undefined) return emptyView('', 'bad-day-key', Object.freeze([]), false)
    const today = parseDayKey(dayKey)
    if (today === undefined) return emptyView(dayKey, 'bad-day-key', Object.freeze([]), false)

    const state = this.load()
    if (isFrozenFor(state, dayKey)) return this.hydrate(state, now, dayKey)

    return this.compute(today, dayNumberOf(today), now, dayKey)
  }

  /**
   * 取走今天的「那年今日」并记账。
   * @param at 时刻；省略取现在。
   */
  take(at?: number): OnThisDayTake {
    const view = this.today(at)
    if (!view.available) return Object.freeze({ ...view, accounted: Object.freeze([]) })
    if (view.items.length === 0) return Object.freeze({ ...view, accounted: Object.freeze([]) })

    const core = this.core
    if (core === undefined) return Object.freeze({ ...view, accounted: Object.freeze([]) })

    const now = this.now(at)
    const state = this.load()
    const pending = view.items.filter(item => !state.accounted.includes(item.memoryId))
    if (pending.length === 0) return Object.freeze({ ...view, accounted: Object.freeze([]) })

    if (!this.settings.reinforceOnTake) {
      // 开关关掉就真的什么都不记：返回空数组，别谎报「记过了」。
      return Object.freeze({ ...view, accounted: Object.freeze([]) })
    }

    const ids = pending.map(item => item.memoryId)
    try {
      core.markSeen(ids, now)
    } catch (error) {
      this.log.warn('标记「已带出」失败（加固照常做）：%s', messageOf(error))
    }

    const done: string[] = []
    for (const id of ids) {
      try {
        core.reinforce(id, 'mention', now)
        done.push(id)
      } catch (error) {
        // 单条加固失败不影响其他条：这一年她至少还会提它一次。
        this.log.warn('加固记忆「%s」失败：%s', id, messageOf(error))
      }
    }

    this.takes += 1
    this.accountedTotal += done.length

    if (done.length > 0) {
      const merged: string[] = [...state.accounted]
      for (const id of done) if (!merged.includes(id)) merged.push(id)
      this.save(Object.freeze({ ...state, accounted: Object.freeze(merged) }))
    }

    return Object.freeze({ ...view, accounted: Object.freeze(done) })
  }

  /**
   * 解释某条为什么被选中。
   * @param memoryId 记忆 id。
   * @param at 时刻；省略取现在。
   */
  explain(memoryId: string, at?: number): OnThisDayWhy | undefined {
    const view = this.today(at)
    const item = view.items.find(entry => entry.memoryId === memoryId)
    if (item === undefined) return undefined
    const state = this.load()

    const pieces: string[] = [
      SHELF_ZH[item.shelf] + '：' + String(item.daysAgo) + ' 个自然日前写下',
    ]
    if (item.yearsAgo > 0) pieces.push('整 ' + String(item.yearsAgo) + ' 年')
    if (item.leapFolded) pieces.push('2 月 29 日折叠到 2 月 28 日')
    if (item.archived) pieces.push('已归档（只忘不删，正好该忽然想起）')
    if (item.retention !== null) pieces.push('强度 ' + item.retention.toFixed(2))
    if (item.clarity !== null) pieces.push('清晰度 ' + item.clarity.band)

    return Object.freeze({
      memoryId,
      shelf: item.shelf,
      detail: pieces.join('，'),
      daysAgo: item.daysAgo,
      leapFolded: item.leapFolded,
      retention: item.retention,
      accounted: state.accounted.includes(memoryId),
    })
  }

  /**
   * 丢掉今天的冻结点与记账。
   * @param at 时刻；省略取现在。
   */
  reset(at?: number): void {
    const now = this.now(at)
    const dayKey = dayKeyAt(now, this.clock) ?? ''
    this.save(emptyState(''))
    this.log.info('那年今日：冻结点与记账已清空（原为 %s），下次查询会重算', dayKey)
  }

  /** 运行计数。 */
  stats(): OnThisDayStats {
    const state = this.state
    return Object.freeze({
      available: this.available,
      lookups: this.lookups,
      computes: this.computes,
      takes: this.takes,
      // 存档里已记过账的条数也要算进来：进程重启后 `accountedTotal` 归零，
      // 只报内存计数会让面板显示「今天一条都没记过」，而记忆明明已经被加固过。
      accounted: state === undefined ? this.accountedTotal : Math.max(this.accountedTotal, state.accounted.length),
      lastScanned: this.lastScanned,
      lastComputeMs: this.lastComputeMs,
      truncatedRuns: this.truncatedRuns,
      failures: this.failures,
    })
  }
}
