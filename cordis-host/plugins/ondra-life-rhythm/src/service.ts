/**
 * 生活与作息服务。
 *
 * ## 两个入口，一条时间轴
 *
 * ```
 * tick()   ── 结算能量 → 判能不能活动 → 活动 + 留笔记 → 落盘
 * energy() ── 只结算能量（面板与提示词要读数时用）
 * ```
 *
 * `plan()` 是**纯读**：它算出「现在该干什么」但不记账。这样面板可以每几秒
 * 问一次「她这会儿在干嘛」，而不会因为问得多就把活动次数刷上去。
 *
 * ## 为什么 `energy()` 这个「读」会写盘
 *
 * 能量是时间积分，不往前结算就永远停在上次的数。但写盘不是无条件的：
 * 只有真的走过至少一段（5 分钟）才落盘，所以 5 分钟内的重复读一次磁盘都不碰。
 * 这是本插件唯一一处「读操作写盘」，写在 README 的隔离五问里。
 *
 * ## 冻结期间时间照走
 *
 * 解冻后不能把冻结期间整段补算回来——那等于没冻结。做法是：冻结时仍然推进
 * `settledAt`，但不改能量。代价是「冻结期间的睡眠不计入睡醒缓冲」，这正确：
 * 急停时她不是在睡觉，是停着。
 */

import {
  MAX_INTERESTS,
  emptyState,
  readState,
  writeState,
} from './store.js'
import type { LifeState } from './store.js'
import {
  SEED_INTERESTS,
  WEIGHT_CEIL,
  WEIGHT_FLOOR,
  WEIGHT_GROW,
  buildInterest,
  noteTextOf,
  pickActivity,
  retentionOf,
  viewOf,
} from './activities.js'
import { asleepOf, clampEnergy, rateOf, settleEnergy, takeBuffer } from './energy.js'
import type { EnergyState } from './energy.js'
import { slotOf } from './seed.js'
import { DEEP_BELOW, LATE_END_MINUTE, NATURAL_CAP, SLEEP_BUFFER_TEXT, STATE_FILE } from './types.js'
import type { Config } from './settings.js'
import type {
  ActivityKind,
  ActivityPlan,
  ClockLike,
  EnergyView,
  Interest,
  InterestView,
  LifeBrief,
  LifeNote,
  LifeReason,
  LifeService,
  LifeStats,
  LogLike,
  PathLike,
  PlanReason,
  TickResult,
} from './types.js'

/** 服务依赖。全部用取值函数或不可变对象，避免持有会变的上游句柄。 */
export interface LifeDeps {
  readonly settings: Config
  readonly log: LogLike
  /** 时间服务；缺席时能量不结算、活动不排（`no-clock`）。 */
  readonly clock: ClockLike | undefined
  /** 路径服务；缺席时纯内存（`stored=false`）。 */
  readonly path: PathLike | undefined
  /** 心情读数（0–1）；读不到返回 `undefined`，按中性处理。 */
  readonly mood: () => number | undefined
  /** 当前时刻（时钟缺席时的兜底）。 */
  readonly now: () => number
}

/** 生活与作息服务实现。 */
export class Life implements LifeService {
  private readonly deps: LifeDeps
  private state: LifeState
  private readonly file: string | undefined
  private storedFlag: boolean

  constructor(deps: LifeDeps) {
    this.deps = deps
    const at = deps.now()
    this.file = this.resolveFile(deps.path)

    const loaded = readState(this.file, at, deps.settings.maxNotes)
    this.storedFlag = loaded !== undefined
    const base = loaded ?? emptyState(at)
    // 出厂兴趣只在「一份都没有」时补：一份坏条目都不剩时才重建，
    // 否则会把她长出来的兴趣覆盖回出厂八个。
    this.state =
      base.interests.length > 0
        ? base
        : Object.freeze({
            ...base,
            interests: Object.freeze(SEED_INTERESTS.map(seed => buildInterest(seed, at, 'seed'))),
          })
  }

  /**
   * 解析状态文件路径。路径服务抛错时退回纯内存（不让插件因此装载失败）。
   * @param path 路径服务。
   */
  private resolveFile(path: PathLike | undefined): string | undefined {
    if (path === undefined) return undefined
    try {
      const file = path.fileIn('user', STATE_FILE)
      // `prepareFile()` 会把父目录收到 0700、文件收到 0600 并确保存在。
      path.prepareFile(file)
      return file
    } catch (error) {
      this.deps.log.warn('状态文件不可用，退回纯内存（重启后她会忘记今天干了什么）：%s', String(error))
      return undefined
    }
  }

  get available(): boolean {
    return this.deps.settings.enable && this.deps.clock !== undefined
  }

  get reason(): LifeReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    if (this.deps.clock === undefined) return 'no-clock'
    return undefined
  }

  get clockReady(): boolean {
    return this.deps.clock !== undefined
  }

  get stored(): boolean {
    return this.storedFlag
  }

  settle(at?: number): EnergyView {
    const moment = this.atOf(at)
    const clock = this.deps.clock
    if (!this.deps.settings.enableEnergy || clock === undefined) {
      // 不算能量，但**时间戳照旧前移**：否则下次打开能量时会把关闭期间整段补算回来，
      // 症状是「关了一周能量，一打开她满血」。这里只推时间、一分能量都不给。
      this.pinSettled(moment)
      return this.viewOf(moment, 0, false)
    }

    const result = settleEnergy(this.state.energy, moment, {
      lateNightOf: epoch => clock.minuteOfDay(epoch) < LATE_END_MINUTE,
    })
    if (result.slices > 0) {
      this.state = Object.freeze({ ...this.state, energy: result.state })
      this.commit()
    }
    return this.viewOf(moment, result.slices, result.truncated)
  }

  /**
   * 只把 `settledAt` 推到 `moment`，能量原样不动。
   * @param moment 目标时刻。
   */
  private pinSettled(moment: number): void {
    if (moment <= this.state.energy.settledAt) return
    this.state = Object.freeze({
      ...this.state,
      energy: Object.freeze({ ...this.state.energy, settledAt: moment }),
    })
    this.commit()
  }

  energy(at?: number): EnergyView {
    return this.settle(at)
  }

  feed(delta: number, at?: number): EnergyView {
    const moment = this.atOf(at)
    // 先结算再喂：否则「上次结算到现在」这段恢复会加在喂完之后，一次喂食能多出半格。
    const before = this.settle(moment)
    // 能量系统关着时不记账：关掉一个系统却还能改它的读数，面板会显示一个「活动的」数字。
    if (!this.deps.settings.enableEnergy) return before
    if (!Number.isFinite(delta)) return before
    const next = clampEnergy(before.energy + delta)
    this.state = Object.freeze({
      ...this.state,
      energy: Object.freeze({ ...this.state.energy, energy: next }),
    })
    this.commit()
    return this.viewOf(moment, 0, false)
  }

  freeze(at?: number): EnergyView {
    const moment = this.atOf(at)
    const before = this.settle(moment)
    if (this.state.energy.frozen) return before
    this.state = Object.freeze({
      ...this.state,
      energy: Object.freeze({ ...this.state.energy, frozen: true, frozenAt: moment }),
    })
    this.commit()
    return this.viewOf(moment, 0, false)
  }

  unfreeze(at?: number): EnergyView {
    const moment = this.atOf(at)
    if (!this.state.energy.frozen) {
      this.settle(moment)
      return this.viewOf(moment, 0, false)
    }
    // **先把冻结期间的时钟推到现在**再解冻：冻结时积分不动能量只推进时间，
    // 若跳过这一步，解冻后的第一次结算会把整段冻结按清醒速率补回来——等于没冻。
    this.settle(moment)
    this.state = Object.freeze({
      ...this.state,
      energy: Object.freeze({ ...this.state.energy, frozen: false, frozenAt: 0 }),
    })
    this.commit()
    return this.viewOf(moment, 0, false)
  }

  asleep(at?: number): boolean {
    return this.settle(at).asleep
  }

  takeSleepBuffer(at?: number): string | undefined {
    const moment = this.atOf(at)
    this.settle(moment)
    if (!this.state.energy.bufferPending) return undefined
    const taken = takeBuffer(this.state.energy)
    this.state = Object.freeze({ ...this.state, energy: taken.state })
    this.commit()
    return SLEEP_BUFFER_TEXT
  }

  peekSleepBuffer(): string | undefined {
    return this.state.energy.bufferPending ? SLEEP_BUFFER_TEXT : undefined
  }

  plan(at?: number): ActivityPlan {
    const moment = this.atOf(at)
    const empty = { at: moment, slot: '', explore: false } as const

    if (!this.deps.settings.enable) return { ...empty, reason: 'disabled' }
    const clock = this.deps.clock
    if (clock === undefined) return { ...empty, reason: 'no-clock' }

    const every = this.deps.settings.activityEveryMinutes
    const slot = slotOf(clock.dayKey(moment), clock.minuteOfDay(moment), every)

    // 休息时段优先于冷却：夜里她说「刚隔了 45 分钟」听起来像还能干活，而事实是她该睡了。
    if (clock.withinWindow(this.deps.settings.restStart, this.deps.settings.restEnd, moment)) {
      return { at: moment, slot, explore: false, reason: 'resting' }
    }

    // 同一槽只做一次：冷却闸在时钟被回拨、或间隔配置被调小之后会失效，
    // 槽号是「这一格已经用过了」的独立证据（这也是 `lastSlot` 唯一的读点）。
    if (this.state.lastSlot === slot) {
      return { at: moment, slot, explore: false, reason: 'cooldown' }
    }

    const gapMs = every * 60_000
    if (this.state.lastActivityAt > 0 && moment - this.state.lastActivityAt < gapMs) {
      return { at: moment, slot, explore: false, reason: 'cooldown' }
    }

    const picked = pickActivity(this.state.interests, {
      at: moment,
      mood: this.deps.mood(),
      moodLowThreshold: this.deps.settings.moodLowThreshold,
      exploreRate: this.deps.settings.exploreRate,
      halfLifeHours: this.deps.settings.interestDecayHours,
      slot,
    })
    if (picked === undefined) return { at: moment, slot, explore: false, reason: 'no-interests' }

    return {
      at: moment,
      slot,
      explore: picked.explore,
      interest: picked.interest,
      kind: picked.kind,
      minutes: picked.minutes,
      reason: 'ok',
    }
  }

  interests(at?: number): readonly InterestView[] {
    const moment = this.atOf(at)
    const halfLife = this.deps.settings.interestDecayHours
    return Object.freeze(
      this.state.interests
        .map(item => viewOf(item, moment, halfLife))
        .sort((left, right) => right.effectiveWeight - left.effectiveWeight),
    )
  }

  tick(at?: number): TickResult {
    const moment = this.atOf(at)
    const energy = this.settle(moment)
    const plan = this.plan(moment)

    const interest = plan.interest
    const kind = plan.kind
    const reason: PlanReason = plan.reason
    if (reason !== 'ok' || interest === undefined || kind === undefined) {
      return { at: moment, energy, reason }
    }

    const note = this.makeNote(moment, plan, kind, interest.label)
    this.applyActivity(moment, plan)
    this.state = Object.freeze({
      ...this.state,
      notes: Object.freeze([note, ...this.state.notes].slice(0, this.deps.settings.maxNotes)),
    })
    this.commit()

    return { at: moment, energy: this.viewOf(moment, 0, false), started: plan, note, reason: 'ok' }
  }

  notes(limit = 10): readonly LifeNote[] {
    const size = Math.max(1, Math.trunc(limit))
    return Object.freeze(this.state.notes.slice(0, size))
  }

  brief(at?: number, windowMinutes = 1440): LifeBrief {
    const moment = this.atOf(at)
    const span = Math.max(1, Math.trunc(windowMinutes)) * 60_000
    const from = moment - span
    // 存档里新的在前，摘要要按时间正序读起来才顺。
    const picked = this.state.notes.filter(note => note.at >= from && note.at <= moment).reverse()

    const clock = this.deps.clock
    const text = picked
      .map(note => {
        if (clock === undefined) return note.text
        const minute = clock.minuteOfDay(note.at)
        const hh = String(Math.floor(minute / 60)).padStart(2, '0')
        const mm = String(minute % 60).padStart(2, '0')
        return hh + ':' + mm + ' ' + note.text
      })
      .join('；')

    return Object.freeze({ from, to: moment, notes: Object.freeze(picked), text })
  }

  react(id: string, reaction: 'like' | 'meh', at?: number): LifeNote | undefined {
    const moment = this.atOf(at)
    const index = this.state.notes.findIndex(note => note.id === id)
    if (index < 0) return undefined

    const old = this.state.notes[index]
    const updated: LifeNote = Object.freeze({ ...old, source: 'react', reacted: reaction })
    const notes = this.state.notes.slice()
    notes[index] = updated

    // 回应即反馈：喜欢就加权，无感就减权。系数比「做完一次」小，
    // 免得一次点头把三天的半衰抵消掉。
    const factor = reaction === 'like' ? 1.1 : 0.85
    const interests = this.state.interests.map(item =>
      item.label === old.label ? this.reweight(item, factor, moment) : item,
    )

    this.state = Object.freeze({ ...this.state, notes: Object.freeze(notes), interests: Object.freeze(interests) })
    this.commit()
    return updated
  }

  stats(): LifeStats {
    return Object.freeze({
      activities: this.state.activities,
      explored: this.state.explored,
      notes: this.state.notes.length,
      interests: this.state.interests.length,
      energy: this.state.energy.energy,
      frozen: this.state.energy.frozen,
      stored: this.storedFlag,
    })
  }

  /**
   * 改一条兴趣的权重并刷新「上次碰它」。
   * @param interest 原兴趣。
   * @param factor 乘数。
   * @param at 时刻。
   */
  private reweight(interest: Interest, factor: number, at: number): Interest {
    const weight = Math.round(Math.min(WEIGHT_CEIL, Math.max(WEIGHT_FLOOR, interest.weight * factor)) * 1000) / 1000
    return Object.freeze({ ...interest, weight, lastAt: at })
  }

  /**
   * 记一次活动：涨权重、计数、推进「上次活动时刻」。
   * @param moment 时刻。
   * @param plan 已判定的计划。
   */
  private applyActivity(moment: number, plan: ActivityPlan): void {
    const target = plan.interest
    const interests = this.state.interests.slice()

    if (plan.explore && target !== undefined) {
      // 探索出的兴趣第一次就算「碰过一次」：权重从 1 起，`times` 记 1。
      const created = buildInterest({ label: target.label, tag: target.tag }, moment, 'explored')
      const bumped: Interest = Object.freeze({ ...created, weight: 1, lastAt: moment, times: 1 })
      if (!interests.some(item => item.id === bumped.id) && interests.length < MAX_INTERESTS) {
        interests.push(bumped)
      }
    } else if (target !== undefined) {
      const index = interests.findIndex(item => item.id === target.id)
      if (index >= 0) {
        const grown = this.reweight(interests[index], WEIGHT_GROW, moment)
        interests[index] = Object.freeze({ ...grown, times: interests[index].times + 1 })
      }
    }

    this.state = Object.freeze({
      ...this.state,
      interests: Object.freeze(interests),
      lastActivityAt: moment,
      lastSlot: plan.slot,
      activities: this.state.activities + 1,
      explored: this.state.explored + (plan.explore ? 1 : 0),
    })
  }

  /**
   * 造一条笔记。id 由「时刻 + 槽号」组成：同槽重复调用会得到同一个 id，
   * `react()` 因此不会指错。
   * @param moment 时刻。
   * @param plan 计划（只用到槽号）。
   * @param kind 已判定的类别。
   * @param label 已判定的兴趣名。
   */
  private makeNote(moment: number, plan: ActivityPlan, kind: ActivityKind, label: string): LifeNote {
    return Object.freeze({
      id: String(moment) + '-' + plan.slot,
      at: moment,
      kind,
      label,
      text: noteTextOf(kind, label),
      retention: retentionOf(kind),
      source: 'activity' as const,
    })
  }

  /** 写盘。路径缺席或写失败时 `stored=false`，调用方与面板据此说「重启会丢」。 */
  private commit(): void {
    this.storedFlag = writeState(this.file, this.state)
  }

  /**
   * 统一时刻入参。非有限值一律退回时钟/系统时间——一个 `NaN` 传进来
   * 会让 `settledAt` 变成 NaN，之后每次结算都返回同一个 NaN，且不报错。
   * @param at 入参时刻。
   */
  private atOf(at: number | undefined): number {
    if (typeof at === 'number' && Number.isFinite(at)) return at
    const clock = this.deps.clock
    return clock === undefined ? this.deps.now() : clock.now()
  }

  /**
   * 组一个能量视图。
   * @param at 时刻。
   * @param slices 本次走过的段数。
   * @param truncated 是否截断。
   */
  private viewOf(at: number, slices: number, truncated: boolean): EnergyView {
    const state: EnergyState = this.state.energy
    const clock = this.deps.clock
    const canSettle = this.deps.settings.enableEnergy && clock !== undefined
    const lateNight = canSettle ? clock.minuteOfDay(at) < LATE_END_MINUTE : false
    return Object.freeze({
      energy: state.energy,
      at,
      asleep: canSettle ? asleepOf(state.energy, lateNight) : false,
      deepSleep: canSettle && state.energy < DEEP_BELOW,
      lateNight,
      frozen: state.frozen,
      // 不能结算时速率报 0：报「+0.2/min」而实际不动，是面板上最难发现的那类谎。
      ratePerMin: canSettle ? rateOf(state.energy, lateNight, state.frozen) : 0,
      cap: NATURAL_CAP,
      slices,
      truncated,
    })
  }
}
