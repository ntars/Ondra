/**
 * 缺口池服务：把 `drive.ts` 的纯算接到「一张表 + 两个邻座读数」上。
 *
 * ## 五条纪律
 *
 * 1. **不累加，只派生**。每次 `tensionOf()` 重算，绝不在内存里维护「当前张力」。
 * 2. **闭合只认 open**。已闭合的再闭合一次返回 `closed: false`，不报错——
 *    上游的重试比报错常见（网络重发、面板连点）。
 * 3. **外发判定一律 fail-closed**。能量读不到、时钟读不到「现在是几点」时，
 *    `dueForWake` 说「不唤醒」而不是「大概可以」。
 *    判错一次「可以唤醒」的代价是她半夜给你发一条莫名其妙的消息。
 * 4. **休眠只补那时已存在的条目**。`pause()` 不记「水位」，
 *    它就地改所有 open 行的 `pausedMs`——之后新建的行自然不带这份补偿。
 * 5. **异常不外抛**。本服务在每轮对话与每个 tick 上被调用，
 *    为了一个统计数字把整轮打断是本末倒置（C3 的同一条道理）。
 */

import {
  buildFailureText,
  classifySourceQuery,
  cooldownLeft,
  detectUnsure,
  isDreamWindow,
  judgeDream,
  judgeWake,
  normalizeForCompare,
  similarity,
  tensionOf,
  toView,
  truncate,
} from './drive.js'
import { BUMP_STEP, MAX_TENSION, SIMILARITY_THRESHOLD, TRUNCATE_CHARS, WAKE_TENSION } from './types.js'
import type { Config } from './settings.js'
import { EMPTY_WAKE_STATE } from './store.js'
import type { GapStore, WakeState } from './store.js'
import type {
  ClockLike,
  FailureKind,
  DreamDecision,
  DreamInput,
  DriveGap,
  DriveGapService,
  EmotionLike,
  GapCloseResult,
  GapCounters,
  GapDetection,
  GapInput,
  GapOpenResult,
  GapRefusalCode,
  GapStats,
  GapStatus,
  GapSummary,
  GapUnavailableReason,
  GapView,
  LogLike,
  PromptFragment,
  RecheckResult,
  WakeDecision,
  WakeInput,
} from './types.js'
import { GAP_SOURCES, GAP_FRAGMENT_TEXT } from './types.js'

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 内部可变的计数器形状。
 *
 * `GapCounters` 对外全是 `readonly`（快照语义），内部要累加，
 * 所以用映射类型把只读摘掉——**不是**再造一套字段名。
 */
type MutableCounters = { -readonly [K in keyof GapCounters]: number }

/** 计数器初值。 */
function zeroCounters(): MutableCounters {
  return {
    opened: 0,
    merged: 0,
    closed: 0,
    wakePassed: 0,
    delivered: 0,
    refusedFull: 0,
    pausedMs: 0,
  }
}

/** 缺口池实现。 */
export class GapRepository implements DriveGapService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  private readonly emotion: () => EmotionLike | undefined
  private readonly clockService: () => ClockLike | undefined
  private readonly store: GapStore | undefined

  /** 运行期真源。`loaded` 之前为空，第一次用到时从库里灌一次。 */
  private readonly rows = new Map<string, DriveGap>()
  private loaded = false
  private wake: WakeState
  private counters: MutableCounters = zeroCounters()
  private seq = 0
  private lastError: string | undefined

  /**
   * @param settings 配置。
   * @param log 日志。
   * @param clock 时钟（毫秒）。
   * @param emotion 情绪服务的延迟取值（装载顺序不确定）。
   * @param clockService 时钟服务的延迟取值（只用来判深夜窗口）。
   * @param store 池表；缺席表示只在内存。
   */
  constructor(
    settings: Config,
    log: LogLike,
    clock: () => number,
    emotion: () => EmotionLike | undefined,
    clockService: () => ClockLike | undefined,
    store: GapStore | undefined,
  ) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.emotion = emotion
    this.clockService = clockService
    this.store = store
    this.wake = EMPTY_WAKE_STATE
  }

  /** 只看总开关：没有存储仍然可用（内存态），只是重启全丢。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因（只有「配置关掉」这一种）。 */
  get reason(): GapUnavailableReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /* ---------------------------------------------------------------- *
   * 读取侧
   * ---------------------------------------------------------------- */

  /**
   * 惰性灌一次。
   *
   * 放在读取里而不是构造函数里：构造时库还没准备好是常态（O-006 可能后面才装载），
   * 而构造函数里读失败一次就再也不读了。
   */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (this.store === undefined) return
    for (const gap of this.store.loadAll()) {
      this.rows.set(gap.id, gap)
    }
    this.wake = this.store.loadWake()
  }

  /** 全部 open，按张力降序（同张力时早创建的在前）。 */
  private openSorted(at: number): DriveGap[] {
    this.ensureLoaded()
    const open: DriveGap[] = []
    for (const gap of this.rows.values()) {
      if (gap.status === 'open') open.push(gap)
    }
    open.sort((a, b) => {
      const diff = tensionOf(b, at) - tensionOf(a, at)
      if (diff !== 0) return diff
      return a.createdAt - b.createdAt
    })
    return open
  }

  /** 写一条到库并同步内存。 */
  private persist(gap: DriveGap): void {
    this.rows.set(gap.id, gap)
    this.store?.update(gap.id, rowPatch(gap))
  }

  /** 新增一行。 */
  private persistNew(gap: DriveGap): boolean {
    this.rows.set(gap.id, gap)
    if (this.store === undefined) return true
    const ok = this.store.insert(gap)
    if (!ok) this.rows.delete(gap.id)
    return ok
  }

  /* ---------------------------------------------------------------- *
   * 三源
   * ---------------------------------------------------------------- */

  detect(text: string): GapDetection | undefined {
    if (!this.settings.enable) return undefined
    try {
      return detectUnsure(text)
    } catch (error) {
      this.lastError = messageOf(error)
      return undefined
    }
  }

  open(input: GapInput, at?: number): GapOpenResult {
    const now = at ?? this.clock()
    const refused = (refusal: GapRefusalCode): GapOpenResult => Object.freeze({ accepted: false, created: false, bumped: false, refusal })
    if (!this.settings.enable) return refused('disabled')

    try {
      this.ensureLoaded()
      if (!GAP_SOURCES.includes(input.source)) return refused('bad-source')

      const query = classifySourceQuery(input.source, input.query)
      let text = truncate(typeof input.text === 'string' ? input.text : '', TRUNCATE_CHARS)
      // 请求失败这一类：正文缺省由本插件按分类代写。
      // 理由：同类的两次失败必须长得一模一样，否则「按分类归并」会在比对那一步就断。
      if (text.length === 0 && input.source === 'request-failed') {
        text = buildFailureText(query as FailureKind)
      }
      // 只剩标点的「。。。」不该占一条执念：它既不携带信息，也会参与判重。
      if (text.length === 0 || normalizeForCompare(text).length === 0) return refused('empty-text')
      const open = this.openSorted(now)

      // ① 有归并键的来源（工具查空 / 请求失败）**只按键归并，绝不走相似度**。
      //    理由：这两类的正文是模板生成的（`搜索「X」没有结果`、`请求失败：网络断了`），
      //    模板前缀会让任何两句话都有 0.6 以上的相似度——
      //    「查天气」和「查股票」会被并成一条，「网络断了」和「等太久了」也会。
      //    这不是阈值调高能解决的：**分母里塞了非内容成分**（纪律 #24）。
      if (query.length > 0) {
        const same = open.find(gap => gap.source === input.source && gap.query === query)
        if (same !== undefined) return this.bump(same, now)
        return this.create(input, text, query, open.length, now)
      }

      // ② 没有键的来源（她自己没答上来）才按正文相似度判重，取最高分那条。
      let best: DriveGap | undefined
      let bestScore = 0
      for (const gap of open) {
        const score = similarity(text, gap.text)
        if (score > bestScore) {
          bestScore = score
          best = gap
        }
      }
      if (best !== undefined && bestScore >= SIMILARITY_THRESHOLD) return this.bump(best, now)

      return this.create(input, text, query, open.length, now)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('开缺口失败：%s', this.lastError)
      return refused('store-unavailable')
    }
  }

  /**
   * 新建一条（两条路径共用：有权归并、无权相似度）。
   * @param input 入参。
   * @param text 正文（已截断、已非空）。
   * @param query 归并键。
   * @param openCount 当前 open 条数。
   * @param now 时刻。
   */
  private create(input: GapInput, text: string, query: string, openCount: number, now: number): GapOpenResult {
    const refused = (refusal: GapRefusalCode): GapOpenResult =>
      Object.freeze({ accepted: false, created: false, bumped: false, refusal })

    if (openCount >= this.settings.maxOpen) {
      this.counters.refusedFull += 1
      this.log.warn('缺口池已满（%d 条），拒收新执念：%s', openCount, text)
      return refused('pool-full')
    }

    // 先标注再冻结：`Object.freeze({... status: 'open' ...})` 会把 `status` 拓成 `string`，
    // 与 `GapStatus` 不兼容（TS2322）。标注让字面量在上下文里定型。
    const fresh: DriveGap = {
      id: this.nextId(now),
      text,
      source: input.source,
      query,
      status: 'open',
      base: clampFloat(input.base, this.settings.baseTension, 0, MAX_TENSION),
      ratePerHour: clampFloat(input.ratePerHour, this.settings.tensionPerHour, 0, 20),
      relief: 0,
      bump: 0,
      pausedMs: 0,
      createdAt: now,
      closedAt: 0,
      closedSiblings: 0,
      picks: 0,
      lastPickedAt: 0,
    }
    const gap = Object.freeze(fresh)
    if (!this.persistNew(gap)) return refused('store-unavailable')

    this.counters.opened += 1
    if (this.settings.verbose) {
      this.log.info('开了一条执念（%s）：%s', gap.source, gap.text)
    }
    return Object.freeze({ accepted: true, created: true, bumped: false, gap: toView(gap, now) })
  }

  /** 判重命中：只加压，不动正文（「它先被想起来，说明它才是原始表述」）。 */
  private bump(target: DriveGap, now: number): GapOpenResult {
    const next: DriveGap = Object.freeze({ ...target, bump: target.bump + BUMP_STEP })
    this.persist(next)
    this.counters.merged += 1
    if (this.settings.verbose) {
      this.log.info('并入已有执念（张力 +%d）：%s', BUMP_STEP, target.text)
    }
    return Object.freeze({
      accepted: true,
      created: false,
      bumped: true,
      gap: toView(next, now),
      similarTo: target.id,
    })
  }

  /* ---------------------------------------------------------------- *
   * 闭合与缓解
   * ---------------------------------------------------------------- */

  close(id: string, at?: number): GapCloseResult {
    const now = at ?? this.clock()
    try {
      this.ensureLoaded()
      const target = this.rows.get(id)
      if (target === undefined || target.status !== 'open') {
        return Object.freeze({ closed: false, closedIds: Object.freeze([]), closedSiblings: 0 })
      }

      const siblings: DriveGap[] = []
      for (const gap of this.rows.values()) {
        if (gap.status !== 'open' || gap.id === id) continue
        if (similarity(target.text, gap.text) >= SIMILARITY_THRESHOLD) siblings.push(gap)
      }

      const closedIds: string[] = []
      const closedTarget: DriveGap = Object.freeze({
        ...target,
        status: 'closed' as GapStatus,
        closedAt: now,
        closedSiblings: siblings.length,
      })
      this.persist(closedTarget)
      closedIds.push(closedTarget.id)

      for (const sibling of siblings) {
        const closed: DriveGap = Object.freeze({
          ...sibling,
          status: 'closed' as GapStatus,
          closedAt: now,
          closedSiblings: 0,
        })
        this.persist(closed)
        closedIds.push(closed.id)
      }

      this.counters.closed += closedIds.length
      if (this.settings.verbose) {
        this.log.info('闭合执念 %s，连坐 %d 条：%s', id, siblings.length, target.text)
      }
      return Object.freeze({
        closed: true,
        closedIds: Object.freeze(closedIds),
        closedSiblings: siblings.length,
      })
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('闭合执念失败：%s', this.lastError)
      return Object.freeze({ closed: false, closedIds: Object.freeze([]), closedSiblings: 0 })
    }
  }

  relieve(id: string, amount: number, at?: number): GapView | undefined {
    const now = at ?? this.clock()
    try {
      this.ensureLoaded()
      const gap = this.rows.get(id)
      if (gap === undefined || gap.status !== 'open') return undefined
      if (!Number.isFinite(amount) || amount <= 0) return toView(gap, now)
      const next: DriveGap = Object.freeze({ ...gap, relief: clampFloat(gap.relief + amount, gap.relief, 0, MAX_TENSION) })
      this.persist(next)
      return toView(next, now)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('缓解执念失败：%s', this.lastError)
      return undefined
    }
  }

  pause(ms: number, at?: number): number {
    const now = at ?? this.clock()
    if (!Number.isFinite(ms) || ms <= 0) return 0
    try {
      this.ensureLoaded()
      let touched = 0
      for (const gap of this.openSorted(now)) {
        this.persist(Object.freeze({ ...gap, pausedMs: gap.pausedMs + Math.trunc(ms) }))
        touched += 1
      }
      this.wake = Object.freeze({
        lastWakeAt: this.wake.lastWakeAt,
        pauses: this.wake.pauses + 1,
        pausedTotalMs: this.wake.pausedTotalMs + Math.trunc(ms),
      })
      this.store?.saveWake(this.wake, now)
      this.counters.pausedMs += Math.trunc(ms) * touched
      if (touched > 0 && this.settings.verbose) {
        this.log.info('休眠记账：%d 条执念各扣掉 %s 分钟', touched, Math.round(ms / 60000))
      }
      return touched
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('休眠记账失败：%s', this.lastError)
      return 0
    }
  }

  /* ---------------------------------------------------------------- *
   * 查询
   * ---------------------------------------------------------------- */

  list(options?: { readonly status?: GapStatus; readonly limit?: number; readonly at?: number }): readonly GapView[] {
    const now = options?.at ?? this.clock()
    try {
      this.ensureLoaded()
      const status = options?.status ?? 'open'
      const picked: DriveGap[] = []
      for (const gap of this.rows.values()) {
        if (gap.status === status) picked.push(gap)
      }
      picked.sort((a, b) => tensionOf(b, now) - tensionOf(a, now))
      const limit = options?.limit ?? picked.length
      return Object.freeze(picked.slice(0, Math.max(0, limit)).map(gap => toView(gap, now)))
    } catch (error) {
      this.lastError = messageOf(error)
      return Object.freeze([])
    }
  }

  get(id: string, at?: number): GapView | undefined {
    const now = at ?? this.clock()
    try {
      this.ensureLoaded()
      const gap = this.rows.get(id)
      return gap === undefined ? undefined : toView(gap, now)
    } catch (error) {
      this.lastError = messageOf(error)
      return undefined
    }
  }

  highestTension(at?: number): GapView | undefined {
    const now = at ?? this.clock()
    try {
      const top = this.openSorted(now).at(0)
      return top === undefined ? undefined : toView(top, now)
    } catch (error) {
      this.lastError = messageOf(error)
      return undefined
    }
  }

  /* ---------------------------------------------------------------- *
   * 唤醒 / 做梦 / 复核
   * ---------------------------------------------------------------- */

  dueForWake(input?: WakeInput): WakeDecision {
    const decision = this.evaluateWake(input)
    if (decision.wake) this.counters.wakePassed += 1
    /*
     * 说一次「为什么没叫醒」。
     *
     * ## 为什么这一行必须存在（本轮修的真缺陷）
     *
     * 现场症状是：库里四条执念张力 105–286 全过唤醒线 80，而主动链每 15 分钟
     * 一行 `content-empty`「正文为空」。这个组合说不通——张力过线就该有由头，
     * 有由头就不该「正文为空」。
     *
     * 断点在 `dueForWake()` 与 `dueForDream()` 都**不打日志**：它返回
     * `wake:false` 时不写任何东西，于是「张力过了但能量不够」「闲置太短」
     * 「在冷却期」这三种截然不同的原因，在日志里全是「没有候选」。
     * 排查的人只能一层层读源码去猜，而这已经是第八次绕回同一处。
     *
     * 判据用插件自己的 `blockedBy`，一个字都不另写。
     *
     * ## 为什么只在 `verbose` 时打
     *
     * `dueForWake` 是每个 tick 都调的（面板刷新、主动链、做梦链）。
     * 无条件打会把 `debug.log` 冲成一片噪声，真正要看的那一行反而被顶掉。
     * `verbose` 默认 true（见 `settings.ts`），但用户可以关。
     */
    if (!decision.wake && this.settings.verbose) {
      this.log.debug?.(
        '唤醒判定：不叫醒（%s）· 张力 %s · 能量 %s · 闲置 %s 分钟 · 距上次唤醒 %s 分钟',
        String(decision.blockedBy ?? 'unknown'),
        String(decision.checks.tension),
        decision.checks.energy === undefined ? '读不到' : String(decision.checks.energy),
        String(decision.checks.idleMinutes),
        Number.isFinite(decision.checks.sinceWakeMinutes)
          ? String(Math.round(decision.checks.sinceWakeMinutes))
          : '从未',
      )
    } else if (decision.wake && this.settings.verbose) {
      this.log.info?.(
        '唤醒判定：叫醒（张力 %s 过线 %s）· 能量 %s · 闲置 %s 分钟',
        String(decision.checks.tension),
        String(WAKE_TENSION),
        decision.checks.energy === undefined ? '读不到' : String(decision.checks.energy),
        String(decision.checks.idleMinutes),
      )
    }
    return decision
  }

  /**
   * 唤醒判定本体（**不计数**）。
   *
   * 单独抽出来的唯一理由：`summary()` 也要判一次「现在该不该唤醒」，
   * 若它调 `dueForWake`，面板每刷新一次就白记一次「通过」，
   * 而 `wakePassed` 是拿来判断「唤醒条件是不是设得太松」的——
   * 被面板刷高的计数会让这个判断永久失效。
   */
  private evaluateWake(input?: WakeInput): WakeDecision {
    const now = input?.at ?? this.clock()
    try {
      this.ensureLoaded()
      const top = this.openSorted(now).at(0)
      const energy = this.resolveEnergy(input?.energy, now)
      const sinceWakeMinutes =
        this.wake.lastWakeAt > 0 ? Math.max(0, (now - this.wake.lastWakeAt) / 60_000) : Number.POSITIVE_INFINITY
      const checks = Object.freeze({
        tension: top === undefined ? 0 : tensionOf(top, now),
        energy,
        idleMinutes: input?.idleMinutes ?? 0,
        sinceWakeMinutes,
        cooldownLeftMinutes: cooldownLeft(this.wake.lastWakeAt, now),
      })
      const decision = judgeWake(checks, this.settings.enable, top !== undefined)
      return Object.freeze({ ...decision, gap: top === undefined ? undefined : toView(top, now) })
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('唤醒判定失败，按不唤醒处理：%s', this.lastError)
      const failed: WakeDecision = {
        wake: false,
        checks: { tension: 0, energy: undefined, idleMinutes: 0, sinceWakeMinutes: 0, cooldownLeftMinutes: 0 },
        blockedBy: 'no-open-gap',
      }
      return Object.freeze(failed)
    }
  }

  markDelivered(id: string, at?: number): boolean {
    const now = at ?? this.clock()
    try {
      this.ensureLoaded()
      const gap = this.rows.get(id)
      if (gap === undefined || gap.status !== 'open') return false
      this.persist(Object.freeze({ ...gap, picks: gap.picks + 1, lastPickedAt: now }))
      this.wake = Object.freeze({ ...this.wake, lastWakeAt: now })
      this.store?.saveWake(this.wake, now)
      this.counters.delivered += 1
      return true
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('记投递失败：%s', this.lastError)
      return false
    }
  }

  dueForDream(input?: DreamInput): DreamDecision {
    const now = input?.at ?? this.clock()
    try {
      this.ensureLoaded()
      const top = this.openSorted(now).at(0)
      const checks = Object.freeze({
        energy: this.resolveEnergy(input?.energy, now),
        idleMinutes: input?.idleMinutes ?? 0,
        deepNight: this.resolveDeepNight(now),
      })
      const decision = judgeDream(checks, this.settings.enable, top !== undefined)
      return Object.freeze({ ...decision, gap: top === undefined ? undefined : toView(top, now) })
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('做梦判定失败，按不入梦处理：%s', this.lastError)
      const failed: DreamDecision = {
        dream: false,
        checks: { energy: undefined, idleMinutes: 0, deepNight: false },
        blockedBy: 'no-open-gap',
      }
      return Object.freeze(failed)
    }
  }

  recheck(id: string, at?: number): RecheckResult {
    const now = at ?? this.clock()
    try {
      this.ensureLoaded()
      const gap = this.rows.get(id)
      if (gap === undefined) {
        const missing: RecheckResult = { state: 'missing', tension: 0 }
        return Object.freeze(missing)
      }
      if (gap.status === 'open') {
        const alive: RecheckResult = { state: 'open', tension: tensionOf(gap, now) }
        return Object.freeze(alive)
      }

      // 闭合了但要回答「是不是被合并到别处了」——用了「取代者」这个说法，
      // 是为了让 O-042 能把 replacedFrom 写出来，而不是只报一句 cancelled。
      let best: DriveGap | undefined
      let bestScore = 0
      for (const other of this.rows.values()) {
        if (other.status !== 'open') continue
        const score = similarity(gap.text, other.text)
        if (score > bestScore) {
          bestScore = score
          best = other
        }
      }
      const replacedBy = best !== undefined && bestScore >= SIMILARITY_THRESHOLD ? best.id : undefined
      const gone: RecheckResult = { state: 'closed', tension: 0, replacedBy }
      return Object.freeze(gone)
    } catch (error) {
      this.lastError = messageOf(error)
      const failed: RecheckResult = { state: 'missing', tension: 0 }
      return Object.freeze(failed)
    }
  }

  /* ---------------------------------------------------------------- *
   * 片段与汇总
   * ---------------------------------------------------------------- */

  fragment(at?: number): PromptFragment | undefined {
    const now = at ?? this.clock()
    try {
      const top = this.highestTension(now)
      if (top === undefined) return undefined
      return Object.freeze({
        order: this.settings.fragmentOrder,
        ttlMinutes: this.settings.fragmentTtlMinutes,
        // 置信度就是强度本身：不另设一个「够不够格进提示词」的阈值。
        // §8.1 的拼装本来就按 confidence 过滤，第二个阈值会与它打架。
        confidence: Math.min(1, Math.max(0, top.tension / MAX_TENSION)),
        text: GAP_FRAGMENT_TEXT,
        kind: 'drive' as const,
      })
    } catch (error) {
      this.lastError = messageOf(error)
      return undefined
    }
  }

  summary(input?: WakeInput): GapSummary {
    const now = input?.at ?? this.clock()
    try {
      this.ensureLoaded()
      let open = 0
      let closed = 0
      for (const gap of this.rows.values()) {
        if (gap.status === 'open') open += 1
        else closed += 1
      }
      const top = this.openSorted(now).at(0)
      const decision = this.evaluateWake({ energy: input?.energy, idleMinutes: input?.idleMinutes, at: now })
      return Object.freeze({
        open,
        closed,
        highestTension: top === undefined ? 0 : tensionOf(top, now),
        highestId: top === undefined ? undefined : top.id,
        wake: decision.wake,
        lastWakeAt: this.wake.lastWakeAt,
      })
    } catch (error) {
      this.lastError = messageOf(error)
      return Object.freeze({ open: 0, closed: 0, highestTension: 0, wake: false, lastWakeAt: 0 })
    }
  }

  prune(olderThanDays?: number, at?: number): number {
    const now = at ?? this.clock()
    const days = olderThanDays ?? this.settings.closedRetainDays
    try {
      this.ensureLoaded()
      const cutoff = now - days * 86_400_000
      const doomed: string[] = []
      for (const gap of this.rows.values()) {
        if (gap.status === 'closed' && gap.closedAt > 0 && gap.closedAt < cutoff) doomed.push(gap.id)
      }
      if (doomed.length === 0) return 0
      const removed = this.store?.remove(doomed) ?? doomed.length
      for (const id of doomed) this.rows.delete(id)
      return removed
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('清理闭合行失败：%s', this.lastError)
      return 0
    }
  }

  stats(): GapStats {
    this.ensureLoaded()
    let open = 0
    let closed = 0
    const now = this.clock()
    let highest = 0
    for (const gap of this.rows.values()) {
      if (gap.status === 'open') {
        open += 1
        highest = Math.max(highest, tensionOf(gap, now))
      } else {
        closed += 1
      }
    }
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      storeProvider: this.store?.provider ?? 'none',
      open,
      closed,
      highestTension: highest,
      lastWakeAt: this.wake.lastWakeAt,
      counters: Object.freeze({ ...this.counters }),
      lastError: this.lastError,
    })
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  /** 能量读数：显式给优先，其次问 O-026，都没有返回 `undefined`（判定侧按 fail-closed 处理）。 */
  private resolveEnergy(explicit: number | undefined, at: number): number | undefined {
    if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit
    const emotion = this.emotion()
    if (emotion === undefined) return undefined
    try {
      const state = emotion.state(at)
      const energy = state.axes['energy']
      return typeof energy === 'number' && Number.isFinite(energy) ? energy : undefined
    } catch (error) {
      this.lastError = messageOf(error)
      return undefined
    }
  }

  /**
   * 是否落在梦境窗口。
   *
   * 有时钟服务就按时钟（产品时区）判；没有就退回本机时区。
   * 退回本机时区是**有意的降级**：宁可在一个可能偏的时区里做梦，
   * 也好过因为缺一个服务就永远不做梦（那会让 `dueForDream` 变成假开关）。
   */
  private resolveDeepNight(at: number): boolean {
    const clock = this.clockService()
    if (clock !== undefined) {
      try {
        return isDreamWindow(clock.parts(at).hour)
      } catch (error) {
        this.lastError = messageOf(error)
      }
    }
    return isDreamWindow(new Date(at).getHours())
  }

  /** 生成主键。同一毫秒内用序号避免撞码。 */
  private nextId(at: number): string {
    for (;;) {
      this.seq += 1
      const id = `g-${Math.trunc(at).toString(36)}-${this.seq.toString(36)}`
      if (!this.rows.has(id)) return id
    }
  }
}

/** 缺口 → 需要回写的列（不含主键）。 */
function rowPatch(gap: DriveGap): Record<string, unknown> {
  return {
    text: gap.text,
    source: gap.source,
    query: gap.query,
    status: gap.status,
    base: gap.base,
    rate_per_hour: gap.ratePerHour,
    relief: gap.relief,
    bump: gap.bump,
    paused_ms: Math.trunc(gap.pausedMs),
    closed_at: Math.trunc(gap.closedAt),
    closed_siblings: Math.trunc(gap.closedSiblings),
    picks: Math.trunc(gap.picks),
    last_picked_at: Math.trunc(gap.lastPickedAt),
  }
}

/** 夹一个浮点。 */
function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}
