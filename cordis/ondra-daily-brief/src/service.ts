/**
 * 简报服务的实现：**只读投影 + 逐段降级，不落盘、不推送、不装定时器**。
 *
 * 全部上游依赖都是**取值函数**（`() => ctx.get(...)`）：晚装载能自愈，早卸载立刻反映。
 *
 * ## 一条贯穿全文件的纪律
 *
 * **任何上游缺席或抛错都不外溢**。一段取不到，只让那一段变成 `not-available`，
 * 另外两段照常出——早上第一屏整片空白，比「少一段」糟得多，
 * 而且空白会被误读成「今天没什么事」（C3：器官错误不得传播）。
 *
 * ## 为什么 `brief()` 是异步的
 *
 * 天气是网络请求（O-047 `facts()` 返回 `Promise`）。为了让 `brief()` 变同步而在这里
 * 缓存一份天气，等于自己养第二份天气真源——这正是 O-047 明令禁止的事。
 * 天气那一段永远只等它该等的那一次，并且**失败不抛**。
 *
 * ## 落盘
 *
 * **没有**。简报是「此刻的投影」，它没有需要跨重启保留的内容。
 * `ack()` 只记在内存里：重启后今天这份会重新变成「没认领」，
 * 代价是一句提示多出现一次，比写一个新文件便宜。
 */

import { carryItemOf, dueItemOf, summaryOf } from './aggregate.js'
import type { CarryCandidate, DueCandidate } from './aggregate.js'
import { ambientItemOf } from './ambient.js'
import { BRIEF_SLOTS, BriefError, SLOT_SPECS } from './types.js'
import type {
  AckView,
  BriefClock,
  BriefItem,
  BriefStats,
  BriefUnavailableReason,
  ClockLike,
  DailyBrief as DailyBriefView,
  DailyBriefService,
  DateFactsLike,
  LiveLike,
  LogLike,
  MemoryCoreLike,
  PromiseRecordLike,
  ProspectiveLike,
  ReminderLike,
  SlotSpec,
  TodoLike,
  WeatherFactsLike,
  WeatherLike,
} from './types.js'
import type { Config } from './settings.js'

/** 一天的毫秒数（只在本机时区兜底时用）。 */
const DAY_MS = 86_400_000

/** 服务依赖。全部是取值函数：任何一项随时可能变成 `undefined`。 */
export interface DailyBriefDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** O-003 时钟（软；缺席退回本机时区）。 */
  readonly clock: () => ClockLike | undefined
  /** O-016 承诺与待办（软；缺席时前两段读不到）。 */
  readonly prospective: () => ProspectiveLike | undefined
  /** O-010 记忆内核（软；只用来核对一条承诺背后的记忆是否还在）。 */
  readonly core: () => MemoryCoreLike | undefined
  /** O-046 日期事实（软；缺席时「外面」那段只剩天气）。 */
  readonly live: () => LiveLike | undefined
  /** O-047 天气（软；缺席时「外面」那段只剩节气）。 */
  readonly weather: () => WeatherLike | undefined
  /** 系统时间兜底。 */
  readonly now: () => number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 本机时区的自然日键。时钟缺席时才走这里。 */
function localDayKey(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 本机时区的 `HH:MM`。 */
function localHhmm(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 本机时区的自然日序号（同一自然日内恒定，跨一天 +1）。 */
function localDayNumber(at: number): number {
  const date = new Date(at)
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

/** 全兜底时刻运算：时钟服务缺席时用。 */
const LOCAL_CLOCK: BriefClock = Object.freeze({
  dayKey: localDayKey,
  hhmm: localHhmm,
  daysBetween: (a: number, b: number) => localDayNumber(b) - localDayNumber(a),
})

/** 晨间简报服务。 */
export class DailyBrief implements DailyBriefService {
  readonly #deps: DailyBriefDeps

  /** 累计生成份数。 */
  #built = 0

  /** 累计降级次数。 */
  #degraded = 0

  /** 本次进程里最后认领的自然日键。 */
  #ackedDayKey: string | undefined

  /** 本次进程里最后一次认领的时刻。 */
  #ackedAt = 0

  /** 最近一次降级的说明。 */
  #lastIssue: string | undefined

  /** 已经提示过的降级点（同一条只报一次，免得每出一份简报都刷屏）。 */
  readonly #noted = new Set<string>()

  /**
   * @param deps 依赖。
   */
  constructor(deps: DailyBriefDeps) {
    this.#deps = deps
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.#deps.settings.enable
  }

  /** 不可用原因。 */
  get reason(): BriefUnavailableReason | undefined {
    return this.available ? undefined : 'disabled'
  }

  /** 三段说明书。 */
  sections(): readonly SlotSpec[] {
    return Object.freeze(BRIEF_SLOTS.map(slot => SLOT_SPECS[slot]))
  }

  /**
   * 出简报。
   * @param at 时刻，省略取现在。
   */
  async brief(at?: number): Promise<DailyBriefView> {
    this.#assertEnabled()
    const stamp = this.#atOf(at)
    const clock = this.#clock()
    const dayKey = clock.dayKey(stamp)

    // 顺序即优先级：有时限的承诺 > 昨天没说完的事 > 外面。
    const items: BriefItem[] = [
      this.#promiseItem(stamp, clock),
      this.#carryItem(stamp, clock),
    ]

    // 有人就是不看天气。关掉只是少一段，不影响前两段。
    if (this.#deps.settings.includeAmbient) {
      items.push(await this.#ambientItem(stamp))
    }

    this.#built += 1
    return Object.freeze({
      dayKey,
      at: stamp,
      items: Object.freeze(items),
      acked: this.#ackedDayKey === dayKey,
      summary: summaryOf(items),
    })
  }

  /**
   * 认领今天这份。
   * @param at 时刻，省略取现在。
   */
  ack(at?: number): AckView {
    this.#assertEnabled()
    const stamp = this.#atOf(at)
    const dayKey = this.#clock().dayKey(stamp)
    if (this.#ackedDayKey === dayKey) {
      // 重复认领不改时刻：外壳多渲染一次不该把「几点看过」往后推。
      return Object.freeze({ dayKey, ackedAt: this.#ackedAt, repeat: true })
    }
    this.#ackedDayKey = dayKey
    this.#ackedAt = stamp
    return Object.freeze({ dayKey, ackedAt: stamp, repeat: false })
  }

  /** 统计快照。 */
  stats(): BriefStats {
    const reason = this.reason
    const ackedDayKey = this.#ackedDayKey
    const lastIssue = this.#lastIssue
    return Object.freeze({
      available: this.available,
      built: this.#built,
      degraded: this.#degraded,
      ...(reason === undefined ? {} : { reason }),
      ...(ackedDayKey === undefined ? {} : { ackedDayKey }),
      ...(lastIssue === undefined ? {} : { lastIssue }),
    })
  }

  /** 现在。时钟缺席退回系统时间。 */
  #now(): number {
    const clock = this.#deps.clock()
    if (clock === undefined) return this.#deps.now()
    try {
      const stamp = clock.now()
      return Number.isFinite(stamp) && stamp > 0 ? Math.trunc(stamp) : this.#deps.now()
    } catch (error) {
      this.#degrade('clock.now', `时钟取值失败，退回系统时间：${messageOf(error)}`)
      return this.#deps.now()
    }
  }

  /** 时刻运算适配：优先走 O-003，缺席或抛错退回本机时区。 */
  #clock(): BriefClock {
    const clock = this.#deps.clock()
    if (clock === undefined) {
      this.#note('ondra-clock', '时钟服务未装载：自然日与时刻按这台机器的时区算')
      return LOCAL_CLOCK
    }
    return Object.freeze({
      dayKey: (at: number) => this.#viaText(() => clock.dayKey(at), () => localDayKey(at), 'clock.dayKey'),
      hhmm: (at: number) => this.#viaText(() => clock.hhmm(at), () => localHhmm(at), 'clock.hhmm'),
      daysBetween: (a: number, b: number) =>
        this.#viaNumber(
          () => clock.daysBetween(a, b),
          () => localDayNumber(b) - localDayNumber(a),
          'clock.daysBetween',
        ),
    })
  }

  /** 取一段文本；拿不到合法值就用兜底，并记一次降级。 */
  #viaText(primary: () => string, fallback: () => string, what: string): string {
    try {
      const value = primary()
      if (typeof value !== 'string' || value === '') throw new Error('返回值不是合法文本')
      return value
    } catch (error) {
      this.#degrade(what, `${what} 调用失败，退回本机时区：${messageOf(error)}`)
      return fallback()
    }
  }

  /** 取一个数字；非有限数用兜底，并记一次降级。 */
  #viaNumber(primary: () => number, fallback: () => number, what: string): number {
    try {
      const value = primary()
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('返回值不是合法数字')
      return value
    } catch (error) {
      this.#degrade(what, `${what} 调用失败，退回本机时区：${messageOf(error)}`)
      return fallback()
    }
  }

  /** 承诺那一段。 */
  #promiseItem(at: number, clock: BriefClock): BriefItem {
    const open = this.#readOpen(at)
    if (open === null) return dueItemOf(null, false, clock, at)
    return dueItemOf(this.#pickDue(open), true, clock, at)
  }

  /** 悬着的事那一段。 */
  #carryItem(at: number, clock: BriefClock): BriefItem {
    const todos = this.#readTodos()
    if (todos === null) return carryItemOf(null, false, at)
    const candidate = this.#pickCarry(todos, clock, at)
    return carryItemOf(candidate, true, at)
  }

  /** 外面那一段。 */
  async #ambientItem(at: number): Promise<BriefItem> {
    const live = this.#readLiveFacts(at)
    const weather = await this.#readWeatherFacts(at)
    return ambientItemOf(live, weather)
  }

  /**
   * 挑出今天该点名的承诺：**尊重上游的排序**（`listOpen()` 已按紧迫度倒序），
   * 本插件只跳过无期限的那些。
   * @param open 未结算的承诺。
   */
  #pickDue(open: readonly ReminderLike[]): DueCandidate | null {
    for (const item of open) {
      const promise = item.promise
      if (!Number.isFinite(promise.dueAt) || promise.dueAt <= 0) continue
      // 被遗忘权优先：主人可以在 O-103 里把这条记忆删掉，删掉的事不该在第二天早上被报到脸上。
      if (!this.#allowedToMention(promise)) continue
      return Object.freeze({
        id: promise.id,
        text: promise.text,
        dueAt: promise.dueAt,
        graceUntil: promise.graceUntil,
      })
    }
    return null
  }

  /**
   * 这条承诺还能不能提。
   *
   * 只在「记忆内核在位、且这条承诺确实挂着一个记忆 id」时才核对；
   * 核对不了就照常提——**读不到不构成删除的证据**，宁可多提一条，不可误吞一条。
   * @param promise 承诺。
   */
  #allowedToMention(promise: PromiseRecordLike): boolean {
    const factId = promise.factId
    if (typeof factId !== 'string' || factId === '') return true
    const core = this.#deps.core()
    if (core === undefined || !core.available) return true
    try {
      const found = core.getFact(factId)
      if (found !== undefined && found !== null) return true
      this.#degrade('core.getFact', `承诺「${promise.id}」对应的记忆已经被删掉，简报不再点名它`)
      return false
    } catch (error) {
      this.#degrade('core.getFact', `核对记忆是否还在时失败，这一条照常提：${messageOf(error)}`)
      return true
    }
  }

  /**
   * 挑出「昨天没说完的那一件」。
   *
   * 两个条件：不是今天才记下的（晨间简报说的是「新的一天」，不是当天流水），
   * 且没被勾掉。挑**最早会过期**的那条——今天不动就没了的那一件，
   * 比最老的那一件更该在今天被想起。
   * @param todos 待办。
   * @param clock 时刻运算。
   * @param at 现在。
   */
  #pickCarry(todos: readonly TodoLike[], clock: BriefClock, at: number): CarryCandidate | null {
    const today = clock.dayKey(at)
    let picked: TodoLike | null = null
    for (const todo of todos) {
      if (todo.done) continue
      if (typeof todo.text !== 'string' || todo.text.trim() === '') continue
      if (clock.dayKey(todo.lastMentionedAt) === today) continue
      if (picked === null) {
        picked = todo
        continue
      }
      const mine = Number.isFinite(todo.expiresAt) ? todo.expiresAt : Number.MAX_SAFE_INTEGER
      const held = Number.isFinite(picked.expiresAt) ? picked.expiresAt : Number.MAX_SAFE_INTEGER
      if (mine < held) picked = todo
    }
    if (picked === null) return null
    return Object.freeze({
      id: picked.id,
      text: picked.text,
      expiresAt: Number.isFinite(picked.expiresAt) ? picked.expiresAt : 0,
    })
  }

  /** 读未结算的承诺。读不到返回 `null`（`null` = 这一段读不到，不是「没有」）。 */
  #readOpen(at: number): readonly ReminderLike[] | null {
    const prospective = this.#deps.prospective()
    if (prospective === undefined) {
      this.#note('ondra-memory-prospective', '承诺服务未装载：承诺与悬着的事这两段今天读不到')
      return null
    }
    if (!prospective.available) {
      this.#note('ondra-memory-prospective', '承诺服务在位但不可用：承诺与悬着的事这两段今天读不到')
      return null
    }
    try {
      const open = prospective.listOpen(at)
      if (!Array.isArray(open)) {
        this.#degrade('listOpen()', '承诺服务返回的不是数组，按读不到处理')
        return null
      }
      return open
    } catch (error) {
      this.#degrade('listOpen()', `读未结算承诺失败，承诺这一段按读不到处理：${messageOf(error)}`)
      return null
    }
  }

  /** 读待办。读不到返回 `null`。 */
  #readTodos(): readonly TodoLike[] | null {
    const prospective = this.#deps.prospective()
    if (prospective === undefined) {
      // 与 `#readOpen()` 共用同一个提示键：两段都缺时只打一行，不重复刷屏。
      this.#note('ondra-memory-prospective', '承诺服务未装载：承诺与悬着的事这两段今天读不到')
      return null
    }
    if (!prospective.available) {
      this.#note('ondra-memory-prospective', '承诺服务在位但不可用：承诺与悬着的事这两段今天读不到')
      return null
    }
    try {
      const todos = prospective.listTodos()
      if (!Array.isArray(todos)) {
        this.#degrade('listTodos()', '承诺服务返回的待办不是数组，按读不到处理')
        return null
      }
      return todos
    } catch (error) {
      this.#degrade('listTodos()', `读待办失败，悬着的事这一段按读不到处理：${messageOf(error)}`)
      return null
    }
  }

  /** 读日期事实。读不到返回 `null`。 */
  #readLiveFacts(at: number): DateFactsLike | null {
    const live = this.#deps.live()
    if (live === undefined) {
      this.#note('ondra-live', '日期事实服务未装载：「外面」那段今天只有天气')
      return null
    }
    if (!live.available) {
      this.#note('ondra-live', '日期事实服务在位但不可用：「外面」那段今天只有天气')
      return null
    }
    try {
      // 上游签名说是 `DateFacts`，但不同版本的形状会漂；先按 unknown 验一遍再认。
      const facts: unknown = live.facts(at)
      if (typeof facts !== 'object' || facts === null) {
        this.#degrade('live.facts()', '日期事实返回的不是对象，按读不到处理')
        return null
      }
      return facts as DateFactsLike
    } catch (error) {
      this.#degrade('live.facts()', `读日期事实失败，「外面」那段今天只有天气：${messageOf(error)}`)
      return null
    }
  }

  /** 读天气。读不到返回 `null`。**永不抛出**：天气的失败只是少一句。 */
  async #readWeatherFacts(at: number): Promise<WeatherFactsLike | null> {
    const weather = this.#deps.weather()
    if (weather === undefined) {
      this.#note('ondra-weather', '天气服务未装载：「外面」那段今天只有节气与节日')
      return null
    }
    if (!weather.available) {
      this.#note('ondra-weather', '天气服务在位但用不了（多半是没填坐标）：「外面」那段今天只有节气与节日')
      return null
    }
    try {
      const facts = await weather.facts(at)
      return facts ?? null
    } catch (error) {
      this.#degrade('weather.facts()', `取天气失败，「外面」那段今天只有节气与节日：${messageOf(error)}`)
      return null
    }
  }

  /** 记一次降级：计数 + 留一句话给 `stats()`。日志由 `#note` 控制是否刷屏。 */
  #degrade(where: string, detail: string): void {
    this.#degraded += 1
    this.#lastIssue = detail
    this.#note(where, detail)
  }

  /** 同一个降级点只打一行日志（第一行最有用，后面的会被淹没）。 */
  #note(key: string, detail: string): void {
    if (this.#noted.has(key)) return
    this.#noted.add(key)
    if (!this.#deps.settings.verbose) return
    this.#deps.log.warn(`${detail}（同一个降级点只提示一次）`)
  }

  /** 把关掉时一律拒（读也不行——`available=false` 就该一致）。 */
  #assertEnabled(): void {
    if (!this.#deps.settings.enable) {
      throw new BriefError('disabled', '晨间简报已关闭（enable=false）。重新打开即可继续。')
    }
  }

  /** 校验时刻入参。非法一律抛 `bad-request`，不悄悄改成现在。 */
  #atOf(given: number | undefined): number {
    const at = given === undefined ? this.#now() : given
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) {
      throw new BriefError('bad-request', `时刻必须是正的有限数（毫秒时间戳），收到：${String(given)}`)
    }
    return Math.trunc(at)
  }
}
