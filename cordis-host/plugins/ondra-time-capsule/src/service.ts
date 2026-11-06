/**
 * 时间胶囊服务的实现：**封存期结构性不可读 + 开启时真源搬家**。
 *
 * 全部上游依赖都是**取值函数**（`() => ctx.get(...)`）：晚装载能自愈，早卸载立刻反映。
 *
 * 一条贯穿全文件的纪律：**任何上游缺席都不抛错**。
 * 胶囊坏了不该让对话链受任何影响；写不进记忆库时宁可「没开成」，
 * 也不许把本地正文抹掉（§13.4 第 1 问）。
 */

import { calendarOf, openAtAfterDays } from './calendar.js'
import type { Calendar } from './calendar.js'
import {
  checkHoldDays,
  checkText,
  deriveTitle,
  makeId,
  normalizeText,
  sortForList,
  stateOf,
  viewOf,
} from './capsule.js'
import { emptyArchive, readArchive, writeArchive } from './store.js'
import { CapsuleError, MIN_HOLD_DAYS, STATE_FILE } from './types.js'
import type {
  CapsuleArchive,
  CapsuleInput,
  CapsuleRecord,
  CapsuleStats,
  CapsuleUnavailableReason,
  CapsuleView,
  ClockLike,
  LogLike,
  MemoryCoreLike,
  OpenOutcome,
  PathLike,
  TimeCapsuleService,
} from './types.js'
import type { Config } from './settings.js'

/** 服务依赖。全部是取值函数：任何一项随时可能变成 `undefined`。 */
export interface TimeCapsuleDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-002 路径（软；缺席时只在内存）。 */
  readonly path: () => PathLike | undefined
  /** O-003 时钟（软；缺席退回本机时区）。 */
  readonly clock: () => ClockLike | undefined
  /** O-010 记忆内核（软；缺席时开启会失败，但胶囊仍可写、可看）。 */
  readonly core: () => MemoryCoreLike | undefined
  /** 系统时间兜底。 */
  readonly now: () => number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 时间胶囊服务。 */
export class TimeCapsule implements TimeCapsuleService {
  readonly #deps: TimeCapsuleDeps

  /** 内存态：路径缺席时的兜底，也是落盘失败后的最新真值。 */
  #archive: CapsuleArchive = emptyArchive()

  /** 存档文件绝对路径；`undefined` 表示只在内存。 */
  #file: string | undefined

  /** 是否已试过读盘。 */
  #loaded = false

  /** 累计建了多少颗。 */
  #created = 0

  /** 累计开成功多少颗。 */
  #opened = 0

  /** 写记忆失败次数。 */
  #writeFailures = 0

  /** 存档读写失败次数。 */
  #storeFailures = 0

  /** 同一毫秒内的序号（防 id 撞）。 */
  #seq = 0

  /**
   * @param deps 依赖。
   */
  constructor(deps: TimeCapsuleDeps) {
    this.#deps = deps
    const path = deps.path()
    if (path !== undefined) {
      try {
        this.#file = path.fileIn('user', STATE_FILE)
      } catch (error) {
        deps.log.warn('拼胶囊存档路径失败，状态只在内存：%s', messageOf(error))
        this.#file = undefined
      }
    } else if (deps.settings.verbose) {
      deps.log.info('路径服务未装载：胶囊只在内存，重启后未开封的信会丢（README §8 限制 1）')
    }
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): CapsuleUnavailableReason | undefined {
    return this.#deps.settings.enable ? undefined : 'disabled'
  }

  /** 当前日历。每次现取：上游晚装载能立刻反映。 */
  #calendar(): Calendar {
    return calendarOf(this.#deps.clock())
  }

  /**
   * 读盘一次（惰性）。
   *
   * 刻意不在构造里读：构造期上游可能还没就绪，而且装载期做磁盘 IO 会拖慢启动。
   */
  #ensureLoaded(): void {
    if (this.#loaded) return
    this.#loaded = true
    const result = readArchive(this.#file)
    this.#archive = result.archive
    if (result.issue !== undefined) {
      this.#storeFailures += 1
      this.#deps.log.warn('%s', result.issue)
    }
  }

  /** 落盘一次。失败只记数打日志，不抛——磁盘问题不该让一次读操作失败。 */
  #persist(): void {
    if (this.#file === undefined) return
    try {
      writeArchive(this.#file, this.#archive)
    } catch (error) {
      this.#storeFailures += 1
      this.#deps.log.warn('写胶囊存档失败（内存中的状态仍是最新的）：%s', messageOf(error))
    }
  }

  /** 换成新存档并落盘。 */
  #commit(capsules: readonly CapsuleRecord[]): void {
    this.#archive = Object.freeze({ version: this.#archive.version, capsules: Object.freeze(capsules) })
    this.#persist()
  }

  /**
   * 封一颗胶囊。
   * @param input 入参。
   * @param at 参照时刻。
   */
  create(input: CapsuleInput, at?: number): CapsuleView {
    this.#assertEnabled()
    this.#ensureLoaded()

    const calendar = this.#calendar()
    const now = at ?? this.#deps.now()

    const text = normalizeText(input.text)
    const textIssue = checkText(text, this.#deps.settings.maxTextChars)
    if (textIssue !== undefined) {
      throw new CapsuleError(textIssue.code, textIssue.message)
    }

    if (this.#archive.capsules.length >= this.#deps.settings.maxCapsules) {
      throw new CapsuleError(
        'too-many',
        `胶囊已经 ${this.#archive.capsules.length} 颗，到了上限 ${this.#deps.settings.maxCapsules}。请先开一批或删几颗未开封的。`,
      )
    }

    const openAt = this.#resolveOpenAt(input, now, calendar)

    let id = ''
    for (;;) {
      id = makeId(now, this.#seq)
      this.#seq += 1
      if (!this.#archive.capsules.some(item => item.id === id)) break
    }

    const record: CapsuleRecord = Object.freeze({
      id,
      title: (input.title ?? '').slice(0, 40),
      text,
      openAt,
      createdAt: now,
      openedAt: 0,
      factId: null,
    })

    this.#created += 1
    this.#commit([...this.#archive.capsules, record])
    return viewOf(record, now, calendar)
  }

  /**
   * 算出开封日，并做两道校验。
   * @param input 入参。
   * @param now 现在。
   * @param calendar 日历。
   */
  #resolveOpenAt(input: CapsuleInput, now: number, calendar: Calendar): number {
    const hasOpenAt = typeof input.openAt === 'number' && Number.isFinite(input.openAt)
    const hasAfterDays = typeof input.afterDays === 'number' && Number.isFinite(input.afterDays)

    if (hasOpenAt && hasAfterDays) {
      throw new CapsuleError('bad-input', 'openAt 与 afterDays 只能给一个：一个是日期，一个是天数，同时给说不清按哪个算。')
    }
    if (!hasOpenAt && !hasAfterDays) {
      throw new CapsuleError('bad-input', `请给 openAt（开封日时间戳）或 afterDays（多少天后），至少封 ${MIN_HOLD_DAYS} 天。`)
    }

    if (hasAfterDays) {
      const days = Math.trunc(input.afterDays as number)
      const issue = checkHoldDays(days)
      if (issue !== undefined) throw new CapsuleError('bad-date', issue)
      return openAtAfterDays(days, now, calendar)
    }

    const openAt = Math.trunc(input.openAt as number)
    const span = calendar.daysBetween(now, openAt)
    const issue = checkHoldDays(span)
    if (issue !== undefined) throw new CapsuleError('bad-date', issue)
    // 用「那一天的 00:00」为准，不保留用户传进来的时分：胶囊按自然日开。
    return calendar.startOfDay(openAt)
  }

  /** 全部胶囊。 */
  list(at?: number): readonly CapsuleView[] {
    this.#ensureLoaded()
    const calendar = this.#calendar()
    const now = at ?? this.#deps.now()
    return [...this.#archive.capsules].sort(sortForList).map(record => viewOf(record, now, calendar))
  }

  /** 今天（及更早）可以开的胶囊。 */
  due(at?: number): readonly CapsuleView[] {
    this.#ensureLoaded()
    const calendar = this.#calendar()
    const now = at ?? this.#deps.now()
    return this.#archive.capsules
      .filter(record => record.openedAt === 0 && stateOf(record, now, calendar) === 'due')
      .sort(sortForList)
      .map(record => viewOf(record, now, calendar))
  }

  /**
   * 拆开一颗胶囊。
   * @param id 胶囊 id。
   * @param at 时刻。
   */
  open(id: string, at?: number): OpenOutcome {
    this.#assertEnabled()
    this.#ensureLoaded()

    const calendar = this.#calendar()
    const now = at ?? this.#deps.now()
    const record = this.#archive.capsules.find(item => item.id === id)
    if (record === undefined) {
      throw new CapsuleError('not-found', `找不到胶囊 ${id}。`)
    }
    if (record.openedAt > 0) {
      throw new CapsuleError('already-opened', `这颗胶囊已经开过了（记忆 id：${record.factId ?? '未知'}）。`)
    }
    if (!isDueNow(record, now, calendar)) {
      const left = calendar.daysBetween(now, record.openAt)
      throw new CapsuleError('not-due', `还没到开封那天，还差 ${left} 天。胶囊刻意不给「现在就开」的口子——那就成便签了。`)
    }

    // 正文只在本插件里有一份。开的时候先试着交进记忆库。
    const core = this.#deps.core()
    if (core === undefined || !core.available) {
      this.#writeFailures += 1
      return Object.freeze({
        id,
        text: record.text,
        opened: false,
        factId: null,
        openedAt: 0,
        hint: '记忆服务不可用，这颗胶囊暂时开不了。信仍完好地留在本地，下次再开即可——不会丢。',
      })
    }

    let factId: string
    try {
      const created = core.addFact({
        kind: 'episode',
        category: 'self',
        text: record.text,
        summary: (
          record.title !== '' ? record.title : deriveTitle(record.text)
        ).slice(0, 60),
        subject: 'self',
        at: now,
      })
      factId = created.id
    } catch (error) {
      this.#writeFailures += 1
      this.#deps.log.warn('胶囊正文写入记忆失败（本地正文未动，可重试）：%s', messageOf(error))
      return Object.freeze({
        id,
        text: record.text,
        opened: false,
        factId: null,
        openedAt: 0,
        hint: '写记忆库失败，这颗胶囊暂时开不了。本地正文一个字都没动，下次再开即可。',
      })
    }

    // 写成功了才抹本地正文——顺序反了，一旦写失败信就没了。
    this.#opened += 1
    this.#commit(
      this.#archive.capsules.map(item =>
        item.id === id
          ? Object.freeze({ ...item, text: '', openedAt: now, factId })
          : item,
      ),
    )

    return Object.freeze({ id, text: record.text, opened: true, factId, openedAt: now })
  }

  /**
   * 删一颗胶囊。
   * @param id 胶囊 id。
   * @param confirmation 确认令牌。
   */
  drop(id: string, confirmation: { readonly confirm: 'drop' }): boolean {
    this.#assertEnabled()
    this.#ensureLoaded()
    if (confirmation === null || typeof confirmation !== 'object' || confirmation.confirm !== 'drop') {
      throw new CapsuleError('confirmation-required', '删除不可逆（未开封的信只有这一份副本），必须传 { confirm: "drop" }。')
    }
    const exists = this.#archive.capsules.some(item => item.id === id)
    if (!exists) return false
    this.#commit(this.#archive.capsules.filter(item => item.id !== id))
    return true
  }

  /** 统计快照。 */
  stats(): CapsuleStats {
    this.#ensureLoaded()
    const calendar = this.#calendar()
    const now = this.#deps.now()
    let locked = 0
    let due = 0
    let opened = 0
    for (const record of this.#archive.capsules) {
      const state = stateOf(record, now, calendar)
      if (state === 'locked') locked += 1
      else if (state === 'due') due += 1
      else opened += 1
    }
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      stored: this.#file !== undefined,
      provider: this.#file === undefined ? 'memory' : 'json',
      counts: Object.freeze({ locked, due, opened, total: this.#archive.capsules.length }),
      created: this.#created,
      openedCount: this.#opened,
      writeFailures: this.#writeFailures,
      storeFailures: this.#storeFailures,
    })
  }

  /** 关掉时所有写方法都拒；读方法照常（让人还能看到自己写过什么）。 */
  #assertEnabled(): void {
    if (!this.#deps.settings.enable) {
      throw new CapsuleError('disabled', '时间胶囊已关闭（enable=false）。已有胶囊不会被删，重新打开即可继续。')
    }
  }
}

/** 是否已到开封日。 */
function isDueNow(record: CapsuleRecord, now: number, calendar: Calendar): boolean {
  return calendar.dayNumber(now) >= calendar.dayNumber(record.openAt)
}
