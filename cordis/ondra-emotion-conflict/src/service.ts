/**
 * 冲突锁服务：把 `rules.ts` 的判定接到「读一次情绪 + 存一张表」上。
 *
 * ## 四条纪律
 *
 * 1. **只读情绪，不写情绪**（C1）。结构对位里刻意没有 `setAxis` / `comfort`，
 *    所以「顺手把张力调低」在类型层面写不出来。所有数值都以建议形式带出去。
 * 2. **判定只走 `resolveStatus()`**。`explain()` 与 `behavior()` 不各判一次——
 *    第 31 轮的教训是「两套判据都不报错，只是面板说的和系统做的不一样」。
 * 3. **异常不外抛**（C3）。本服务在对话主链路上被调用，为了一句话把整轮打断是本末倒置。
 * 4. **读操作不写库**。`status()` / `behavior()` / `explain()` 只投影；
 *    只有 `enter()` / `signal()` / `release()` 才落盘。面板每秒刷新时这条差别是
 *    「每秒一次写」与「零次写」。
 */

import {
  buildDirective,
  enterSuggestion,
  resolveStatus,
  releaseSuggestion,
  withEnter,
  withRelease,
  withSignal,
} from './rules.js'
import type { EnterSuggestion, MoodGate, ReleaseSuggestion } from './rules.js'
import type { Config } from './settings.js'
import type { ConflictStore, RawConflictRow } from './store.js'
import {
  MOOD_CEILING,
  POSITIVE_STREAK,
  REASON_ZH,
  RELEASE_TENSION_MAX,
  TENSION_ADD,
  type ConflictBehavior,
  type ConflictCounters,
  type ConflictEntry,
  type ConflictLock,
  type ConflictReading,
  type ConflictReason,
  type ConflictRelease,
  type ConflictService,
  type ConflictSignalResult,
  type ConflictStats,
  type ConflictStatus,
  type ConflictUnavailableReason,
  type EmotionLike,
  type LogLike,
  type PromptFragment,
  type ReleaseBy,
  type SignalKind,
} from './types.js'

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 出厂基线读数（与 O-026 的基线一致：张力 0、心情 0.5、皮质醇 20）。 */
const BASELINE_READING: ConflictReading = Object.freeze({
  tension: 0,
  mood: 0.5,
  stress: 0.2,
  source: 'baseline',
})

/** 空锁。 */
function emptyLock(): ConflictLock {
  return Object.freeze({
    locked: false,
    reason: undefined,
    since: 0,
    moodAtLock: undefined,
    tensionAtLock: undefined,
    positiveStreak: 0,
    releases: 0,
  })
}

/** 冲突锁仓库（业务层）。 */
export class ConflictRepository implements ConflictService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  private readonly emotion: () => EmotionLike | undefined
  private readonly store: ConflictStore | undefined
  private readonly fallbackReason: ConflictUnavailableReason | undefined

  private lock: ConflictLock
  private counters: ConflictCounters = Object.freeze({
    enters: 0,
    duplicates: 0,
    releases: 0,
    refusedByMood: 0,
    refusedByStreak: 0,
    apologies: 0,
    directives: 0,
  })
  private lastError: string | undefined

  /**
   * @param settings 配置。
   * @param log 日志。
   * @param clock 时钟（测试可注入）。
   * @param emotion 情绪服务的延迟取值（装载顺序不确定，构造时拿不到不代表以后拿不到）。
   * @param store 状态表；缺席表示只在内存。
   * @param fallbackReason 建表失败之类的外部原因。
   */
  constructor(
    settings: Config,
    log: LogLike,
    clock: () => number,
    emotion: () => EmotionLike | undefined,
    store: ConflictStore | undefined,
    fallbackReason?: ConflictUnavailableReason,
  ) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.emotion = emotion
    this.store = store
    this.fallbackReason = fallbackReason
    this.lock = emptyLock()
    this.load()
  }

  /** 是否可用。**只看总开关**（没有存储是降级，不是没装）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): ConflictUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    return this.fallbackReason
  }

  /** 读一次存档。读失败按「没锁」处理。 */
  private load(): void {
    if (this.store === undefined) return
    const row: RawConflictRow | undefined = this.store.load()
    if (row === undefined) return
    const reason = this.reasonOf(row.reason)
    if (row.locked && reason === undefined) {
      this.log.warn('存档里的锁原因「%s」不认识，按「没锁」处理（下次写入时才纠正）', row.reason)
      return
    }
    this.lock = Object.freeze({
      locked: row.locked && reason !== undefined,
      reason: row.locked ? reason : undefined,
      since: row.locked ? row.since : 0,
      moodAtLock: row.moodAtLock,
      tensionAtLock: row.tensionAtLock,
      positiveStreak: Math.max(0, Math.trunc(row.positiveStreak)),
      releases: Math.max(0, Math.trunc(row.releases)),
    })
  }

  /** 把存档里的原因字符串收窄成 `ConflictReason`。 */
  private reasonOf(raw: string): ConflictReason | undefined {
    if (raw === 'negation' || raw === 'blame' || raw === 'coldness' || raw === 'threshold') return raw
    return undefined
  }

  /** 落盘。 */
  private persist(at: number): boolean {
    if (this.store === undefined) return false
    const ok = this.store.save(this.lock, at)
    if (ok) {
      this.lastError = undefined
    } else {
      this.lastError = '写冲突锁存档失败'
    }
    return ok
  }

  /**
   * 读一次情绪。
   *
   * 缺字段**不按 0 补**：`mood` 补 0 会被判成「心情极差」，
   * 于是一次读失败就让解锁闸永远过不去——那是伪造情绪（§3.2 同一条理由）。
   * 缺字段整体退回基线，并把 `source` 标成 `baseline`，闸门随之变成 `unknown`（放行）。
   * @param at 时刻。
   */
  private reading(at: number): ConflictReading {
    const emotion = this.emotion()
    if (emotion === undefined) return BASELINE_READING
    try {
      const state = emotion.state(at)
      const tension = state.axes['tension']
      const mood = state.axes['mood']
      if (tension === undefined || mood === undefined || !Number.isFinite(tension) || !Number.isFinite(mood)) {
        this.log.warn('情绪快照缺 tension 或 mood，按基线读数处理（心情闸放行）')
        return BASELINE_READING
      }
      const cortisol = state.hormones['cortisol']
      const stress = cortisol === undefined || !Number.isFinite(cortisol) ? BASELINE_READING.stress : cortisol / 100
      return Object.freeze({
        tension: Math.min(1, Math.max(0, tension)),
        mood: Math.min(1, Math.max(0, mood)),
        stress: Math.min(1, Math.max(0, stress)),
        source: 'emotion',
      })
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('读情绪失败，按基线读数处理：%s', this.lastError)
      return BASELINE_READING
    }
  }

  /** 当前状态（唯一判定入口）。 */
  status(at?: number): ConflictStatus {
    const now = at ?? this.clock()
    return resolveStatus({
      lock: this.lock,
      reading: this.reading(now),
      at: now,
      enabled: this.settings.enable,
    })
  }

  /** 一次冲突事件进锁。 */
  enter(reason: ConflictReason, at?: number): ConflictEntry {
    const now = at ?? this.clock()
    if (!this.settings.enable) {
      return this.entryOf('disabled', reason, now)
    }
    try {
      const before = this.status(now)
      if (this.lock.locked) {
        // 同一次吵架被判定十次，张力只加一次。手册说的是「一次冲突 +0.15」。
        this.counters = { ...this.counters, duplicates: this.counters.duplicates + 1 }
        if (this.settings.verbose) {
          this.log.debug?.('冲突锁已在（%s），本次不重复加压', before.note)
        }
        return this.entryOf('already', reason, now)
      }
      this.lock = withEnter(this.lock, reason, before.reading, now)
      this.persist(now)
      this.counters = { ...this.counters, enters: this.counters.enters + 1 }
      if (this.settings.verbose) {
        this.log.info(
          '冲突锁已建立（%s）：张力 %.2f → 建议 +%.2f、心情压到 ≤%.2f',
          REASON_ZH[reason],
          before.reading.tension,
          TENSION_ADD,
          MOOD_CEILING,
        )
      }
      return this.entryOf('entered', reason, now)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('建立冲突锁失败（按未进锁处理）：%s', this.lastError)
      return this.entryOf('disabled', reason, now)
    }
  }

  /** 组装进锁结果。 */
  private entryOf(outcome: ConflictEntry['outcome'], reason: ConflictReason, at: number): ConflictEntry {
    const suggestion: EnterSuggestion = enterSuggestion(outcome)
    return Object.freeze({
      status: this.status(at),
      outcome,
      reason,
      applied: false as const,
      applyPath: 'set-axis' as const,
      tensionAdd: suggestion.tensionAdd,
      moodCeiling: suggestion.moodCeiling,
    })
  }

  /** 一条关系信号。 */
  signal(kind: SignalKind, at?: number): ConflictSignalResult {
    const now = at ?? this.clock()
    if (!this.settings.enable) {
      return Object.freeze({ status: this.status(now), kind, streak: this.lock.positiveStreak })
    }
    try {
      if (kind === 'apology') {
        this.counters = { ...this.counters, apologies: this.counters.apologies + 1 }
      }
      const next = withSignal(this.lock, kind)
      if (next !== this.lock) {
        this.lock = next
        this.persist(now)
      }
      // 致歉立即解锁；正向信号数够了且心情回升也解锁。
      // 判「锁着没有」用的是**对外生效**的锁（含阈值派生），不是存储里那个：
      // 用存储的那份，会漏掉「张力越线锁着、但没人明确说过『你错了』」这一整类情形，
      // 表现是哄两句也没用、面板上却显示「没锁」。
      //
      // 但**自动解锁只发生在存储锁上**：阈值派生的锁不是一次事件，没有「和解」这个动作，
      // 它只能等张力自己降下去。否则每凑够两个正向信号就会解锁一次，
      // 「和解次数」这个计数会被刷成几十，而实际一次架都没吵完。
      const status = this.status(now)
      const shouldRelease =
        kind === 'apology' || (kind === 'positive' && this.lock.locked && status.canRelease)
      if (shouldRelease) {
        const release = this.release(kind === 'apology' ? 'apology' : 'positives', now)
        return Object.freeze({ status: release.status, kind, streak: this.lock.positiveStreak, release })
      }
      if (kind === 'positive' && this.settings.verbose) {
        this.log.info(
          '收到正向信号 %d/%d（心情闸 %s）',
          this.lock.positiveStreak,
          POSITIVE_STREAK,
          gateZh(status.moodGate),
        )
      }
      return Object.freeze({ status, kind, streak: this.lock.positiveStreak })
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('处理关系信号失败（状态不变）：%s', this.lastError)
      return Object.freeze({ status: this.status(now), kind, streak: this.lock.positiveStreak })
    }
  }

  /** 显式解锁（只有手册给出的两条路）。 */
  release(by: ReleaseBy, at?: number): ConflictRelease {
    const now = at ?? this.clock()
    if (!this.settings.enable) {
      return this.releaseOf('disabled', by, now)
    }
    try {
      const before = this.status(now)
      if (!before.locked) {
        return this.releaseOf('not-locked', by, now)
      }
      if (by === 'positives') {
        // 两条同时成立才叫「哄好了」：信号够数 + 心情真的回升。
        // 只数信号会出现「她嘴上说没事，心里还堵着」被当成和好。
        if (before.positiveStreak < POSITIVE_STREAK) {
          return this.refuseOf(now, by, 'streak-short')
        }
        if (before.moodGate === 'low') {
          return this.refuseOf(now, by, 'mood-not-risen')
        }
      }
      // 阈值派生的锁没有「和解事件」：不改状态、不落盘、不计数，
      // 但建议照给——`tensionMax` 才是真能把阈值压下去的那一条。
      // 若在这里也走一遍 `withRelease()`，`releases` 会被「张力高但没人吵架」的日子刷满。
      if (!this.lock.locked) {
        if (this.settings.verbose) {
          this.log.info('阈值派生的锁没有和解事件：只回建议，不改状态（张力需自行回落）')
        }
        return this.releaseOf('released', by, now)
      }

      this.lock = withRelease(this.lock)
      this.persist(now)
      this.counters = { ...this.counters, releases: this.counters.releases + 1 }
      if (this.settings.verbose) {
        const after = this.status(now)
        this.log.info(
          '冲突锁已解除（%s）：建议把张力压到 ≤%.2f%s',
          by === 'apology' ? '致歉' : '连续正向信号',
          RELEASE_TENSION_MAX,
          after.locked ? '；但张力仍越线，行为后果继续生效' : '',
        )
      }
      return this.releaseOf('released', by, now)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('解锁失败（保持锁着）：%s', this.lastError)
      return this.releaseOf('refused', by, now)
    }
  }

  /** 组装解锁结果。 */
  private releaseOf(outcome: ConflictRelease['outcome'], by: ReleaseBy, at: number): ConflictRelease {
    const suggestion: ReleaseSuggestion = releaseSuggestion(by)
    return Object.freeze({
      status: this.status(at),
      outcome,
      by,
      applied: false as const,
      applyPath: 'set-axis' as const,
      tensionMax: suggestion.tensionMax,
      comfortSuggested: outcome === 'released' ? suggestion.comfortSuggested : false,
    })
  }

  /** 组装「被拒」结果。 */
  private refuseOf(
    at: number,
    by: ReleaseBy,
    because: NonNullable<ConflictRelease['refusedBecause']>,
  ): ConflictRelease {
    if (because === 'mood-not-risen') {
      this.counters = { ...this.counters, refusedByMood: this.counters.refusedByMood + 1 }
    } else {
      this.counters = { ...this.counters, refusedByStreak: this.counters.refusedByStreak + 1 }
    }
    if (this.settings.verbose) {
      this.log.info('解锁被拒（%s）：%s', by === 'apology' ? '致歉' : '正向信号', because)
    }
    return Object.freeze({
      status: this.status(at),
      outcome: 'refused' as const,
      by,
      applied: false as const,
      applyPath: 'set-axis' as const,
      tensionMax: 0,
      comfortSuggested: false,
      refusedBecause: because,
    })
  }

  /** 行为后果。 */
  behavior(at?: number): ConflictBehavior {
    const status = this.status(at)
    if (!status.locked) {
      return Object.freeze({ locked: false, coquetry: true, proactive: true, brevity: 'normal' })
    }
    return Object.freeze({ locked: true, coquetry: false, proactive: false, brevity: 'short' })
  }

  /** 行为指令（锁着时才有）。 */
  directive(at?: number): PromptFragment | undefined {
    const now = at ?? this.clock()
    try {
      const fragment = buildDirective(this.status(now), this.settings)
      if (fragment === undefined) return undefined
      this.counters = { ...this.counters, directives: this.counters.directives + 1 }
      if (this.settings.verbose) {
        this.log.info('冲突锁生效：已产出行为指令，排序键 %d', fragment.order)
      }
      return fragment
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('构造冲突指令失败（本次不注入）：%s', this.lastError)
      return undefined
    }
  }

  /** 一句话解释（面板用，允许出现数字）。 */
  explain(at?: number): string {
    const status = this.status(at)
    if (!status.locked) return `没有冲突锁（${status.note}）`
    const parts: string[] = [status.note]
    if (status.stored && status.positiveStreak > 0) {
      parts.push(`正向信号 ${status.positiveStreak}/${POSITIVE_STREAK}`)
    }
    if (status.moodGate === 'unknown') parts.push('心情闸放行（读不到情绪）')
    return parts.join('；')
  }

  /** 统计快照。 */
  stats(): ConflictStats {
    const status = this.status()
    const out: ConflictStats = {
      available: this.available,
      storeProvider: this.store === undefined ? 'none' : this.store.provider,
      locked: status.locked,
      stored: status.stored,
      since: status.since,
      releases: this.lock.releases,
      counters: this.counters,
      readingSource: status.reading.source,
    }
    const reason = this.reason
    if (reason !== undefined) return { ...out, reason }
    if (this.lastError !== undefined) return { ...out, lastError: this.lastError }
    return out
  }
}

/** 心情闸的中文名（只给日志）。 */
function gateZh(gate: MoodGate): string {
  if (gate === 'pass') return '已回升'
  if (gate === 'low') return '未回升'
  return '读不到'
}
