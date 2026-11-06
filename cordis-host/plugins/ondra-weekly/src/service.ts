/**
 * 周报骨架服务的实现：**只读投影，不落盘，不写上游，不装定时器**。
 *
 * 全部上游依赖都是**取值函数**（`() => ctx.get(...)`）：晚装载能自愈，早卸载立刻反映。
 *
 * 一条贯穿全文件的纪律：**任何上游缺席或抛错都不外溢**。
 * 一个段取不到，只让那一段变成 `not-available`，其余三段照常出骨架——
 * 一份只有三段、但标清缺了谁的骨架，比一份整页「读不到」的周报有用得多
 * （C3：器官错误不得传播，本插件按同一条纪律办）。
 */

import {
  diaryRefsInRange,
  diarySectionOf,
  isQuiet,
  messageOf,
  momentSectionOf,
  promiseSectionOf,
  quietSectionOf,
  summaryOf,
  tallyOf,
} from './skeleton.js'
import type { DiaryMaterial, MomentsMaterial, PromiseMaterial } from './skeleton.js'
import { WeeklyError } from './types.js'
import type {
  ClockLike,
  DiaryLike,
  LogLike,
  MemoryCoreLike,
  ProspectiveLike,
  WeeklyDraft,
  WeeklyRange,
  WeeklySection,
  WeeklyService,
  WeeklyStats,
  WeeklyUnavailableReason,
} from './types.js'
import { dayKeyInRange, windowOf, withinRange } from './window.js'
import type { Config } from './settings.js'

/** 服务依赖。全部是取值函数：任何一项随时可能变成 `undefined`。 */
export interface WeeklyDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-003 时钟（软；缺席退回本机时区）。 */
  readonly clock: () => ClockLike | undefined
  /** O-010 记忆内核（软；缺席时「留下的事」读不到）。 */
  readonly core: () => MemoryCoreLike | undefined
  /** O-021 承诺（软；缺席时「悬着的事」读不到）。 */
  readonly prospective: () => ProspectiveLike | undefined
  /** O-045 日记（软；缺席时「她自己写的」读不到）。 */
  readonly diary: () => DiaryLike | undefined
  /** 系统时间兜底。 */
  readonly now: () => number
}

/** 一次取数的结果：段 + 需要点名缺席的上游。 */
interface Built {
  readonly range: WeeklyRange
  readonly sections: readonly WeeklySection[]
}

/** 非负整数；非法值返回 `null`（**不返回 0**）。 */
function nonNegative(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.trunc(value)
}

/** 周报骨架服务。 */
export class Weekly implements WeeklyService {
  readonly #deps: WeeklyDeps

  /** 累计出骨架次数。 */
  #built = 0

  /** 累计上游调用失败次数。 */
  #degraded = 0

  /** 时钟降级只告警一次：否则每次 `range()` 都刷一行，日志会被淹掉。 */
  #clockWarned = false

  /**
   * @param deps 依赖。
   */
  constructor(deps: WeeklyDeps) {
    this.#deps = deps
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): WeeklyUnavailableReason | undefined {
    return this.#deps.settings.enable ? undefined : 'disabled'
  }

  /**
   * 取窗口。
   * @param at 参照时刻。
   */
  range(at?: number): WeeklyRange {
    this.#assertEnabled()
    const now = this.#now(at)
    const range = windowOf(now, this.#deps.settings.windowDays, this.#clock())

    // 时钟在、但窗口没用上它 → 说明时钟自己算错了或抛了错。这是降级，要留痕。
    if (!range.clock && this.#deps.clock() !== undefined) {
      this.#degraded += 1
      if (!this.#clockWarned) {
        this.#clockWarned = true
        this.#deps.log.warn('时钟算不出日界，窗口退回本机时区（可能差一天）；后续同类降级不再逐次告警')
      }
    }
    return range
  }

  /**
   * 取四段骨架。
   * @param at 参照时刻。
   */
  sections(at?: number): readonly WeeklySection[] {
    return this.#build(at).sections
  }

  /**
   * 出骨架。
   * @param at 参照时刻。
   */
  draft(at?: number): WeeklyDraft {
    const { range, sections } = this.#build(at)
    const business = sections.filter(item => item.id !== 'quiet')
    const quiet = isQuiet(business)
    const missing = this.#missingOf(sections)
    this.#built += 1

    return Object.freeze({
      at: range.to,
      range,
      sections: Object.freeze([...sections]),
      tally: tallyOf(sections),
      missing: Object.freeze(missing),
      quiet,
      summary: summaryOf(range, sections, quiet, missing),
    })
  }

  /** 统计快照。 */
  stats(): WeeklyStats {
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      built: this.#built,
      degraded: this.#degraded,
    })
  }

  /** 造一次骨架。**一次 `draft()` 只取一遍上游**，四段看到的是同一时刻。 */
  #build(at?: number): Built {
    const range = this.range(at)
    const max = this.#deps.settings.maxItemsPerSection

    const moments = momentSectionOf(this.#readMoments(range), max)
    const promises = promiseSectionOf(this.#readPromises(range.to), max)
    const diary = diarySectionOf(this.#readDiary(range), max)
    const quiet = quietSectionOf([moments, promises, diary])

    return { range, sections: Object.freeze([moments, promises, diary, quiet]) }
  }

  /** 从四段的 `sources` 里反推缺席的上游：该服务一次都没读到过才算缺席。 */
  #missingOf(sections: readonly WeeklySection[]): readonly string[] {
    const seen = new Map<string, boolean>()
    for (const section of sections) {
      for (const source of section.sources) {
        seen.set(source.service, (seen.get(source.service) ?? false) || source.ok)
      }
    }
    return [...seen].filter(([, ok]) => !ok).map(([service]) => service)
  }

  /** 现在。时钟缺席或抛错退回系统时间。 */
  #now(at?: number): number {
    if (at !== undefined) {
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
        throw new WeeklyError('bad-request', '参照时刻必须是正的有限数（毫秒时间戳）。')
      }
      return at
    }
    const clock = this.#clock()
    if (clock === undefined) return this.#deps.now()
    try {
      return clock.now()
    } catch (error) {
      this.#degraded += 1
      if (this.#deps.settings.verbose) this.#deps.log.warn('时钟调用失败，退回系统时间：%s', messageOf(error))
      return this.#deps.now()
    }
  }

  /** 取时钟。 */
  #clock(): ClockLike | undefined {
    return this.#deps.clock()
  }

  /** 读「这周留下的事」。 */
  #readMoments(range: WeeklyRange): MomentsMaterial {
    const core = this.#deps.core()
    if (core === undefined || !core.available) {
      return { present: false, facts: [], count: 0, exact: false }
    }
    const limit = this.#deps.settings.scanLimit
    try {
      const raw = core.listFacts({ state: 'active', limit, orderBy: 'created-at' })
      const facts = raw.filter(item => withinRange(item.createdAt, range))
      // 扫描回满不一定代表被截断：只要扫到了比窗口更早的一条，就说明窗口内已经取全。
      const exact = raw.length < limit || raw.some(item => item.createdAt < range.from)
      return { present: true, facts, count: facts.length, exact }
    } catch (error) {
      this.#degraded += 1
      this.#deps.log.warn('读记忆列表失败，「这周留下的事」按读不到处理：%s', messageOf(error))
      return { present: false, facts: [], count: 0, exact: false }
    }
  }

  /** 读「这周悬着的事」。 */
  #readPromises(at: number): PromiseMaterial {
    const prospective = this.#deps.prospective()
    if (prospective === undefined || !prospective.available) {
      return { present: false, open: 0, overdue: 0, items: [], readItems: false }
    }
    try {
      const stats = prospective.stats()
      const open = nonNegative(stats.promises.open)
      const overdue = nonNegative(stats.overdue)
      if (open === null || overdue === null) {
        this.#degraded += 1
        this.#deps.log.warn('承诺统计返回的条数不合法，「这周悬着的事」按读不到处理')
        return { present: false, open: 0, overdue: 0, items: [], readItems: false }
      }

      // 原话单独取：失败时条数仍然可信，只是列不出原文。
      let items: readonly string[] = []
      let readItems = false
      try {
        items = prospective.listOpen(at).map(item => item.promise.text)
        readItems = true
      } catch (error) {
        this.#degraded += 1
        this.#deps.log.warn('读未结算承诺清单失败，只报条数不列原话：%s', messageOf(error))
      }
      return { present: true, open, overdue, items, readItems }
    } catch (error) {
      this.#degraded += 1
      this.#deps.log.warn('读承诺统计失败，「这周悬着的事」按读不到处理：%s', messageOf(error))
      return { present: false, open: 0, overdue: 0, items: [], readItems: false }
    }
  }

  /** 读「她自己写的」。 */
  #readDiary(range: WeeklyRange): DiaryMaterial {
    const diary = this.#deps.diary()
    if (diary === undefined || !diary.available) {
      return { present: false, count: 0, exact: false, titles: [], readEntries: false }
    }
    const limit = this.#deps.settings.scanLimit
    try {
      const refs = diary.list(limit)
      const inRange = diaryRefsInRange(refs, key => dayKeyInRange(key, range))
      const wanted = inRange.slice(0, this.#deps.settings.maxItemsPerSection)

      // 只有要展示的那几篇才读正文标题：整窗十几篇全读一遍是白花 IO。
      const titles: string[] = []
      let readEntries = true
      for (const ref of wanted) {
        try {
          const entry = diary.entry(ref.dayKey)
          if (entry === undefined) {
            readEntries = false
            titles.push(ref.dayKey)
          } else {
            titles.push(entry.title.length > 0 ? entry.title : ref.dayKey)
          }
        } catch (error) {
          readEntries = false
          this.#degraded += 1
          titles.push(ref.dayKey)
          this.#deps.log.warn('读日记「%s」失败，只有日期没有标题：%s', ref.dayKey, messageOf(error))
        }
      }
      return {
        present: true,
        count: inRange.length,
        // 同记忆段：扫到比窗口更早的一篇，就说明窗口内已经取全。
        exact: refs.length < limit || refs.some(ref => ref.dayKey < range.fromKey),
        titles,
        readEntries,
      }
    } catch (error) {
      this.#degraded += 1
      this.#deps.log.warn('读日记列表失败，「她自己写的」按读不到处理：%s', messageOf(error))
      return { present: false, count: 0, exact: false, titles: [], readEntries: false }
    }
  }

  /** 关掉时一律拒（读也不行——`available=false` 就该一致）。 */
  #assertEnabled(): void {
    if (!this.#deps.settings.enable) {
      throw new WeeklyError('disabled', '周报骨架已关闭（enable=false）。重新打开即可继续。')
    }
  }
}
