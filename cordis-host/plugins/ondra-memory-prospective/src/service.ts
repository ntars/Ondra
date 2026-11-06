/**
 * 承诺与待办的门面（**唯一对外实现** `ProspectiveService` 的类）。
 *
 * 三件事在这里收口，别处不许再写一遍：
 *
 * 1. **承诺进记忆、待办不进。** `remember()` 会调 `core.addFact()` 写一条
 *    `category = 'promise'`（8000 小时基线）的记忆，然后落本表；
 *    `addTodo()` **一次都不碰记忆内核**。这是手册 §2.8 与语料 §17 的分界，
 *    也是本插件最重要的一条边界。
 * 2. **结算只出建议。** `settle()` 返回 `{ delta, applied: false }`。
 *    关系域归 O-026，它自己决定要不要采纳、要不要按单次上限 0.06 夹紧。
 * 3. **上限是拒绝，不是淘汰。** 承诺 20 条、待办 3 条，满了**拒绝新建并报出来**。
 *    删一条承诺等于替用户决定哪件事不重要；这与核心池上限 32「满了直接拒绝」
 *    是同一条纪律。
 *
 * 降级口径（写死在这里，防止下一轮有人顺手改成抛错）：
 * - 存储端口缺席 / 建表失败 / 端口已关闭 → `available = false`，**所有接口**降级为空结果；
 * - 记忆内核缺席 → `available` 仍为 `true`（待办照常工作），但 `promiseWritable = false`，
 *   `remember()` 抛 `no-core`。把两件事混成一个 `available` 会让
 *   「待办也不能用了」这种假象传出去。
 */

import {
  PROMISE_CATEGORY,
  ProspectiveError,
} from './types.js'
import type {
  ClockLike,
  DetectedItem,
  LogLike,
  MemoryCoreLike,
  PromiseRecord,
  ProspectiveCounters,
  ProspectiveIssue,
  ProspectiveService,
  ProspectiveStats,
  ProspectiveUnavailableReason,
  RelationshipDelta,
  ReminderItem,
  Settlement,
  SettleOutcome,
  StoreLike,
  TodoRecord,
} from './types.js'
import { RELATIONSHIP_DELTAS } from './settings.js'
import type { Config } from './settings.js'
import { detectIn, overlapScore, saysDone, stripTodoMarkers } from './extract.js'
import { compareUrgency, hoursLeftOf, urgencyOf } from './urgency.js'
import { ProspectiveStore } from './store.js'

/** 一天的毫秒数（只用于闲置 / 过期窗口换算）。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 问题列表上限（防止一个坏掉的库把内存吃干）。 */
const MAX_ISSUES = 20

/** 「说做好了」时判定「相关的那条待办」的相似度门槛。 */
const DONE_MATCH_THRESHOLD = 0.5

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 承诺与待办仓库。 */
export class ProspectiveRepository implements ProspectiveService {
  private readonly store: ProspectiveStore | undefined
  private readonly core: MemoryCoreLike | undefined
  private readonly settings: Config
  private readonly now: () => number
  private readonly clock: ClockLike | undefined

  /** 建表结果：`undefined` = 还没试过。 */
  private storeReady: boolean | undefined = undefined

  private readonly issues: ProspectiveIssue[] = []

  private counters: {
    detected: number
    promises: number
    todos: number
    kept: number
    broken: number
    expired: number
    reminded: number
  } = { detected: 0, promises: 0, todos: 0, kept: 0, broken: 0, expired: 0, reminded: 0 }

  /** 待办主键的进程内序号（同一毫秒内连写两条也不会撞）。 */
  private todoSeq = 0

  /**
   * @param store 存储端口；`undefined` 表示端口缺席。
   * @param core 记忆内核；`undefined` 表示缺席（承诺写不进记忆）。
   * @param settings 配置。
   * @param log 日志。
   * @param now 取当前时刻（测试可注入）。
   * @param clock 时钟服务（只用于日历日算术）。
   */
  constructor(
    store: StoreLike | undefined,
    core: MemoryCoreLike | undefined,
    settings: Config,
    log: LogLike,
    now: () => number,
    clock: ClockLike | undefined,
  ) {
    this.store = store === undefined ? undefined : new ProspectiveStore(store, log)
    this.core = core
    this.settings = settings
    this.now = now
    this.clock = clock
  }

  /** 建两张表。由入口在 `ctx.effect` 里调一次。 */
  ready(): boolean {
    if (this.store === undefined) {
      this.storeReady = false
      return false
    }
    this.storeReady = this.store.ensure()
    return this.storeReady
  }

  /** 是否可用（承诺与待办**都**能工作）。 */
  get available(): boolean {
    if (!this.settings.enable) return false
    if (this.store === undefined) return false
    return this.storeReady === true
  }

  /** 不可用原因。 */
  get reason(): ProspectiveUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (this.store === undefined) return 'no-store'
    if (this.storeReady === false) return 'schema-failed'
    return undefined
  }

  /** 承诺能不能写（记忆内核在位才行）。 */
  get promiseWritable(): boolean {
    return this.core !== undefined
  }

  /**
   * 记一条问题（最多 20 条，超出后只留一条「太多」的提示）。
   * @param issue 问题。
   */
  private note(issue: ProspectiveIssue): void {
    if (this.issues.length >= MAX_ISSUES) {
      if (!this.issues.some(item => item.code === 'too-many-issues')) {
        this.issues.push({ code: 'too-many-issues', detail: '问题太多，后续只记这一条' })
      }
      return
    }
    this.issues.push(issue)
  }

  /**
   * 断言可用，否则抛。
   * @param code 错误码。
   */
  private assertUsable(code: 'no-store' | 'closed' = 'no-store'): void {
    if (this.store === undefined) throw new ProspectiveError(code, '没有可用存储端口：承诺与待办无法落盘')
    if (this.storeReady === false) throw new ProspectiveError(code, '建表失败：承诺与待办无法落盘')
    if (!this.settings.enable) throw new ProspectiveError(code, '插件总开关已关闭')
  }

  /* ----------------------------- 抽取 ----------------------------- */

  /**
   * 从一句话里认承诺 / 待办（纯函数）。
   * @param text 原文。
   * @param at 参照时刻。
   */
  detect(text: string, at?: number): readonly DetectedItem[] {
    const base = at ?? this.now()
    this.counters.detected += 1
    return detectIn(text, base, {
      minChars: this.settings.extractMinChars,
      maxChars: this.settings.extractMaxChars,
      soonHours: this.settings.soonHours,
      clock: this.clock,
    })
  }

  /* ----------------------------- 承诺 ----------------------------- */

  /**
   * 记一条承诺：锁原文 → 写记忆（`category=promise`）→ 落本表。
   * @param text 原文。
   * @param options 显式到期时刻与写入时刻。
   */
  remember(text: string, options?: { readonly dueAt?: number; readonly at?: number }): PromiseRecord {
    this.assertUsable()
    const at = options?.at ?? this.now()
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') throw new ProspectiveError('bad-argument', '承诺正文不能为空')
    if (this.core === undefined) {
      throw new ProspectiveError('no-core', '没有记忆内核（ondra-memory-core）：承诺无法进记忆，故不写')
    }

    // 上限先查，再算到期：算完才发现写不进去，等于白算一次。
    const openCount = this.storeCountOpenPromises()
    if (openCount >= this.settings.maxPromises) {
      this.note({
        code: 'promise-full',
        detail: `承诺已满 ${this.settings.maxPromises} 条，拒绝新建。先结算或清理，不淘汰旧的。`,
      })
      throw new ProspectiveError(
        'promise-full',
        `承诺已满 ${this.settings.maxPromises} 条：请先结算或清理，本插件不会自动淘汰旧承诺`,
      )
    }

    // 到期时刻：显式给的优先；否则按时间词解析；都推不出来就是无期限（0）。
    //
    // 这里必须区分「没给」与「给了 0」：`dueAt: 0` 是调用方**明确要求无期限**
    // （例如「我答应你以后不再熬夜」），若把它当成「没给」而去做时间词解析，
    // 一句带「明天」的正文就会覆盖调用方的显式意图。
    let dueAt = 0
    let timeWord = ''
    if (options?.dueAt === undefined) {
      const detected = detectIn(body, at, {
        minChars: this.settings.extractMinChars,
        maxChars: this.settings.extractMaxChars,
        soonHours: this.settings.soonHours,
        clock: this.clock,
      })
      for (const item of detected) {
        if (item.kind !== 'promise') continue
        dueAt = item.dueAt ?? 0
        timeWord = item.timeWord ?? ''
        break
      }
    } else {
      dueAt = options.dueAt > 0 ? options.dueAt : 0
    }

    // 写记忆：`category=promise` 让 O-010 用 8000 小时基线算寿命。
    // **不写 summary**：摘要会漂移，而「我说过什么」被改写是第一眼能看出来的。
    const fact = this.core.addFact({
      kind: 'fact',
      category: PROMISE_CATEGORY,
      text: body,
      subject: 'user',
      salience: this.settings.promiseSalience,
      arousal: this.settings.promiseArousal,
      evidence: [{ source: 'USER', quote: body }],
      at,
    })

    const remindAt = dueAt > 0 ? dueAt - this.settings.remindAheadHours * 60 * 60 * 1000 : 0
    const graceUntil = dueAt > 0 ? dueAt + this.settings.graceHours * 60 * 60 * 1000 : 0
    const record: PromiseRecord = {
      id: `p-${fact.id}`,
      factId: fact.id,
      text: body,
      dueAt,
      remindAt,
      graceUntil,
      state: 'open',
      createdAt: at,
      settledAt: 0,
      remindedAt: 0,
      timeWord,
    }
    try {
      this.storePutPromise(record)
    } catch (error) {
      // 记忆已经写进去了，本表没写成：这是一条「只进记忆、不进清单」的承诺，
      // 必须让人看见——否则它会永远不提醒、也永远结算不了。
      this.note({
        code: 'store-issue',
        id: record.id,
        detail: `承诺已写入记忆但未进清单（${messageOf(error)}）：它不会提醒，需要人工处理`,
      })
      throw new ProspectiveError('write-failed', '承诺清单写入失败', messageOf(error))
    }
    this.counters.promises += 1
    return record
  }

  /**
   * 结算一条承诺。**只出关系增量建议，不写情绪**。
   * @param id 承诺 id。
   * @param outcome 履约 / 违约。
   * @param at 时间戳。
   */
  settle(id: string, outcome: Settlement, at?: number): SettleOutcome {
    this.assertUsable()
    const stamp = at ?? this.now()
    const current = this.promiseOf(id)
    if (current === undefined) throw new ProspectiveError('not-found', `承诺 ${id} 不存在`, id)
    if (current.state !== 'open') {
      throw new ProspectiveError('bad-state', `承诺 ${id} 已是 ${current.state}，不能重复结算`, current.state)
    }
    const next: PromiseRecord = { ...current, state: outcome, settledAt: stamp }
    this.storePatchPromise(id, { state: outcome, settledAt: stamp })
    if (outcome === 'kept') this.counters.kept += 1
    else this.counters.broken += 1
    const delta: RelationshipDelta = RELATIONSHIP_DELTAS[outcome]
    return { promise: next, delta, applied: false }
  }

  /**
   * 到期提醒候选：`remindAt ≤ now < graceUntil` 且未结算。
   * @param at 时间戳。
   */
  dueForReminder(at?: number): readonly ReminderItem[] {
    if (!this.available) return []
    const stamp = at ?? this.now()
    const rows = this.storeSelectPromises({
      where: [
        { column: 'state', op: 'eq', value: 'open' },
        { column: 'remind_at', op: 'gt', value: 0 },
        { column: 'remind_at', op: 'lte', value: stamp },
        { column: 'grace_until', op: 'gt', value: stamp },
      ],
      orderBy: [{ column: 'due_at', direction: 'asc' }],
      limit: this.settings.maxScanRows,
    })
    const items = rows.map(row => this.toReminder(row, stamp))
    items.sort(compareUrgency)
    // **不在这里 +1**：`stats()` 也会调本方法，读一次统计就涨一次计数是假数据。
    // 真正「提醒了一次」由 `markReminded()` 记。
    return items
  }

  /**
   * 逾期未结算：过了宽限期仍是 `open` 的承诺。
   * @param at 时间戳。
   */
  overdue(at?: number): readonly PromiseRecord[] {
    if (!this.available) return []
    const stamp = at ?? this.now()
    return this.storeSelectPromises({
      where: [
        { column: 'state', op: 'eq', value: 'open' },
        { column: 'due_at', op: 'gt', value: 0 },
        { column: 'grace_until', op: 'lte', value: stamp },
      ],
      orderBy: [{ column: 'due_at', direction: 'asc' }],
      limit: this.settings.maxScanRows,
    })
  }

  /**
   * 标记「已提醒过」（防重复提醒；存在库里而不是内存里，重启不丢）。
   * @param id 承诺 id。
   * @param at 时间戳。
   */
  markReminded(id: string, at?: number): number {
    this.counters.reminded += 1
    return this.storePatchPromise(id, { remindedAt: at ?? this.now() })
  }

  /* ----------------------------- 待办 ----------------------------- */

  /**
   * 记一条待办（**不写记忆**）。
   * @param text 原文。
   * @param at 时间戳。
   */
  addTodo(text: string, at?: number): TodoRecord {
    this.assertUsable()
    const stamp = at ?? this.now()
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') throw new ProspectiveError('bad-argument', '待办正文不能为空')

    const open = this.storeCountTodos([{ column: 'done', op: 'eq', value: 0 }])
    if (open >= this.settings.maxTodos) {
      this.note({
        code: 'todo-full',
        detail: `待办已满 ${this.settings.maxTodos} 条，拒绝新建。先完成或清理，不淘汰旧的。`,
      })
      throw new ProspectiveError(
        'todo-full',
        `待办已满 ${this.settings.maxTodos} 条：请先完成或清理（手册 §2.8 的上限就是 3 条）`,
      )
    }

    this.todoSeq += 1
    const record: TodoRecord = {
      id: `t-${stamp.toString(36)}-${this.todoSeq.toString(36)}`,
      text: body,
      createdAt: stamp,
      lastMentionedAt: stamp,
      expiresAt: stamp + this.settings.todoIdleDays * DAY_MS,
      done: false,
    }
    this.storeInsertTodo(record)
    this.counters.todos += 1
    return record
  }

  /**
   * 完成一条待办。
   * @param id 待办 id。
   * @param at 时间戳。
   */
  completeTodo(id: string, at?: number): TodoRecord {
    this.assertUsable()
    const current = this.todoOf(id)
    if (current === undefined) throw new ProspectiveError('not-found', `待办 ${id} 不存在`, id)
    const stamp = at ?? this.now()
    this.storePatchTodo(id, { done: true, lastMentionedAt: stamp })
    return { ...current, done: true, lastMentionedAt: stamp }
  }

  /**
   * 按一句话找「相关的那条待办」并完成它（手册 §2.8）。
   * @param text 原文。
   * @param at 时间戳。
   */
  completeByText(text: string, at?: number): TodoRecord | undefined {
    if (!this.available) return undefined
    if (!saysDone(text)) return undefined
    const open = this.listTodos()
    if (open.length === 0) return undefined
    let best: TodoRecord | undefined
    let bestScore = 0
    for (const todo of open) {
      // 比之前先剥掉待办开头的标记词（「记得」不是内容）：不剥的话，
      // 分母被两个与内容无关的字撑大，`牛奶买好了` 这种自然说法会拿不到分。
      const score = overlapScore(stripTodoMarkers(todo.text), text)
      if (score > bestScore) {
        bestScore = score
        best = todo
      }
    }
    // 找不到足够像的就什么都不做：宁可漏删（人还能自己清），不可错删。
    // 只报「做好了」而不提内容的句子（`做好了，不错`）会停在这一步——
    // 它可能指任何一件事，猜一条去删是最不该做的事。
    if (best === undefined || bestScore < DONE_MATCH_THRESHOLD) return undefined
    return this.completeTodo(best.id, at)
  }

  /**
   * 删一条待办。
   * @param id 待办 id。
   */
  dropTodo(id: string): boolean {
    if (!this.available) return false
    return this.storeDeleteTodo(id) > 0
  }

  /**
   * 待办被重新提起（刷新 3 天计时）。
   * @param id 待办 id。
   * @param at 时间戳。
   */
  touchTodo(id: string, at?: number): TodoRecord {
    this.assertUsable()
    const current = this.todoOf(id)
    if (current === undefined) throw new ProspectiveError('not-found', `待办 ${id} 不存在`, id)
    const stamp = at ?? this.now()
    const expiresAt = stamp + this.settings.todoIdleDays * DAY_MS
    this.storePatchTodo(id, { lastMentionedAt: stamp, expiresAt })
    return { ...current, lastMentionedAt: stamp, expiresAt }
  }

  /* ----------------------------- 清理 ----------------------------- */

  /**
   * 清理：过宽限期 3 天仍 `open` 的承诺转 `expired`；超期未完成的待办删掉；
   * 已完成的待办行一并清掉（它们留着只为了能被查一次）。
   * @param at 时间戳。
   */
  expire(at?: number): { readonly promises: number; readonly todos: number } {
    if (!this.available) return { promises: 0, todos: 0 }
    const stamp = at ?? this.now()
    let promises = 0
    let todos = 0

    // 1) 承诺：`grace_until + expireGraceDays` 之后仍未结算 → expired。
    const cutoff = stamp - this.settings.expireGraceDays * DAY_MS
    const stale = this.storeSelectPromises({
      where: [
        { column: 'state', op: 'eq', value: 'open' },
        { column: 'due_at', op: 'gt', value: 0 },
        { column: 'grace_until', op: 'lte', value: cutoff },
      ],
      orderBy: [{ column: 'grace_until', direction: 'asc' }],
      limit: this.settings.maxScanRows,
    })
    for (const record of stale) {
      this.storePatchPromise(record.id, { state: 'expired', settledAt: stamp })
      promises += 1
    }

    // 2) 孤儿承诺：事实被 `forget()` 了，承诺还在清单里 → 转 expired 并报出来。
    //    不清掉的话，界面上会出现一条「点进去什么都没有」的承诺。
    const stillOpen = this.storeSelectPromises({
      where: [{ column: 'state', op: 'eq', value: 'open' }],
      limit: this.settings.maxScanRows,
    })
    if (this.core !== undefined) {
      for (const record of stillOpen) {
        if (this.core.getFact(record.factId) !== undefined) continue
        this.storePatchPromise(record.id, { state: 'expired', settledAt: stamp })
        this.note({ code: 'not-found', id: record.id, detail: '承诺对应的记忆已被忘记，承诺转 expired' })
        promises += 1
      }
    }

    // 3) 待办：过期的删掉；已完成的行也删掉（它们没有二次用途）。
    for (const todo of this.storeSelectTodos({ limit: this.settings.maxScanRows })) {
      if (todo.done || todo.expiresAt <= stamp) {
        todos += this.storeDeleteTodo(todo.id)
      }
    }

    this.counters.expired += promises
    return { promises, todos }
  }

  /* ----------------------------- 读取 ----------------------------- */

  /**
   * 反向权重（紧迫度）。
   * @param record 承诺。
   * @param at 时间戳。
   */
  urgencyOf(record: PromiseRecord, at?: number): number {
    return urgencyOf({
      dueAt: record.dueAt,
      state: record.state,
      at: at ?? this.now(),
      horizonDays: this.settings.urgencyHorizonDays,
      floor: this.settings.urgencyFloor,
    })
  }

  /**
   * 取一条承诺。
   * @param id 承诺 id。
   */
  promiseOf(id: string): PromiseRecord | undefined {
    if (!this.available) return undefined
    return this.storeGetPromise(id)
  }

  /**
   * 取一条待办。
   * @param id 待办 id。
   */
  todoOf(id: string): TodoRecord | undefined {
    if (!this.available) return undefined
    return this.storeGetTodo(id)
  }

  /**
   * 未结算的承诺（按紧迫度倒序）。**这是注入块 ①【说好的事】的取材端**。
   * @param at 时间戳。
   */
  listOpen(at?: number): readonly ReminderItem[] {
    if (!this.available) return []
    const stamp = at ?? this.now()
    const rows = this.storeSelectPromises({
      where: [{ column: 'state', op: 'eq', value: 'open' }],
      orderBy: [{ column: 'due_at', direction: 'asc' }],
      limit: this.settings.maxScanRows,
    })
    const items = rows.map(row => this.toReminder(row, stamp))
    items.sort(compareUrgency)
    return items
  }

  /** 未完成的待办（按创建时间正序）。 */
  listTodos(): readonly TodoRecord[] {
    if (!this.available) return []
    return this.storeSelectTodos({
      where: [{ column: 'done', op: 'eq', value: 0 }],
      orderBy: [{ column: 'created_at', direction: 'asc' }],
      limit: this.settings.maxTodos,
    })
  }

  /** 统计快照。 */
  stats(): ProspectiveStats {
    const openPromises = this.countPromisesByState('open')
    const kept = this.countPromisesByState('kept')
    const broken = this.countPromisesByState('broken')
    const expired = this.countPromisesByState('expired')
    const openTodos = this.storeCountTodos([{ column: 'done', op: 'eq', value: 0 }])
    const doneTodos = this.storeCountTodos([{ column: 'done', op: 'eq', value: 1 }])
    const counters: ProspectiveCounters = { ...this.counters }
    return {
      available: this.available,
      reason: this.reason,
      provider: this.store === undefined ? 'none' : this.store.provider,
      promises: {
        open: openPromises,
        kept,
        broken,
        expired,
        total: this.storeCountPromises(),
      },
      todos: {
        open: openTodos,
        done: doneTodos,
        total: this.storeCountTodos(),
      },
      dueSoon: this.available ? this.dueForReminder().length : 0,
      overdue: this.available ? this.overdue().length : 0,
      promiseWritable: this.promiseWritable,
      counters,
      issues: [...this.issues],
    }
  }

  /* --------------------------- 内部小工具 --------------------------- */

  /**
   * 把承诺转成提醒项。
   * @param record 承诺。
   * @param stamp 当前时刻。
   */
  private toReminder(record: PromiseRecord, stamp: number): ReminderItem {
    const urgency = this.urgencyOf(record, stamp)
    const hoursLeft = hoursLeftOf(record.dueAt, stamp)
    return {
      promise: record,
      hoursLeft,
      urgency,
      inGrace: record.dueAt > 0 && record.dueAt <= stamp,
    }
  }

  /**
   * 数各状态的承诺。
   * @param state 状态。
   */
  private countPromisesByState(state: string): number {
    return this.storeCountPromises([{ column: 'state', op: 'eq', value: state }])
  }

  /** 未结算承诺条数。 */
  private storeCountOpenPromises(): number {
    return this.storeCountPromises([{ column: 'state', op: 'eq', value: 'open' }])
  }

  /* 下面这几个薄包装把「store 可能缺席」收在一处，避免每个方法都写一遍 `?.`。
     端口缺席时返回空值而不是抛错：读操作降级为空，写操作由 `assertUsable()` 拦。 */

  private storeGetPromise(id: string): PromiseRecord | undefined {
    return this.store?.getPromise(id)
  }

  private storePutPromise(record: PromiseRecord): void {
    this.store?.putPromise(record)
  }

  private storePatchPromise(id: string, patch: Partial<PromiseRecord>): number {
    return this.store?.patchPromise(id, patch) ?? 0
  }

  private storeSelectPromises(query?: Parameters<ProspectiveStore['selectPromises']>[0]): PromiseRecord[] {
    return this.store?.selectPromises(query) ?? []
  }

  private storeCountPromises(where?: Parameters<ProspectiveStore['countPromises']>[0]): number {
    return this.store?.countPromises(where) ?? 0
  }

  private storeGetTodo(id: string): TodoRecord | undefined {
    return this.store?.getTodo(id)
  }

  private storeInsertTodo(record: TodoRecord): void {
    this.store?.insertTodo(record)
  }

  private storePatchTodo(id: string, patch: Partial<TodoRecord>): number {
    return this.store?.patchTodo(id, patch) ?? 0
  }

  private storeDeleteTodo(id: string): number {
    return this.store?.deleteTodo(id) ?? 0
  }

  private storeSelectTodos(query?: Parameters<ProspectiveStore['selectTodos']>[0]): TodoRecord[] {
    return this.store?.selectTodos(query) ?? []
  }

  private storeCountTodos(where?: Parameters<ProspectiveStore['countTodos']>[0]): number {
    return this.store?.countTodos(where) ?? 0
  }
}

