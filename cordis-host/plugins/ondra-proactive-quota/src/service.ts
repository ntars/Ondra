/**
 * 额度服务：把纯判定（`rules.ts`）与状态（`state.ts`）接起来。
 *
 * ## 四条纪律
 *
 * 1. **`plan()` 一个字节都不改**（§15-73）。面板每几秒刷一次「她此刻愿不愿意说」，
 *    刷一次若算「说过」，间隔闸会被面板自己刷满，而她永远没话说、原因还查不出来。
 *    只有 `commit()` / `noteUserSpoke()` / `mute()` 写盘。
 * 2. **绝不调用 O-042 的 `gate()`。** 那是「能发吗」的判定，调用它会消耗额度与冷却。
 *    本插件只调它的 `peek()`（只读）与 `mute()`（用户主动按的开关）。
 * 3. **额度衰减不在本插件算。** 我们把未衰减的档位额度与沉默天数交给 O-042，
 *    由它 `budgetOf()` 算一次（见 `rules.silentDaysBetween` 注释）。
 * 4. **零常驻**：不装定时器、不订阅事件。所有时间从入参或 `now()` 取。
 *
 * ## 内部错误为什么「放行」而不是「拦下」
 *
 * 判定是纯算术，它抛错说明本插件有 bug。此时两个方向都有代价：
 *
 * - 拦下 → 一次 bug 让她从此一句话都不主动说，而且**没有任何界面提示**
 *   （症状是「她好像不怎么找我了」，没人会去查一个叫 quota 的插件）；
 * - 放行 → 最多多说一条，防封与内容的硬闸仍在 O-042 手里，风险可控。
 *
 * 手册 §8.1 C3 要求「异常转 degraded 返回空」——对一个**限制型**服务来说，
 * 「返回空」就是「不施加限制」。故这里放行，同时 `stats().errors` 与 error 日志
 * 把这件事显形。与 O-042 的选择刻意相反：那边放行的代价是封号。
 */

import {
  decide,
  giveUpDrawOf,
  intervalOf,
  quotaFor,
  retreatOf,
  shouldGiveUp,
  silentDaysBetween,
} from './rules.js'
import { readState, writeState, emptyState } from './state.js'
import type { Config as QuotaConfig } from './settings.js'
import { MINUTE_MS, PLAN_GATES, STATE_FILE_NAME } from './types.js'
import type {
  ClockLike,
  CommitOptions,
  CommitOutcome,
  GateLike,
  GateSnapshotLike,
  IntervalView,
  LogLike,
  MuteOutcome,
  PathLike,
  PlanGate,
  QuotaPatch,
  QuotaPlan,
  QuotaRequest,
  QuotaService,
  QuotaState,
  QuotaStats,
  QuotaUnavailableReason,
  QuotaView,
  StreakView,
} from './types.js'

/** 内部计数（可变，故不写成 readonly——§15-60）。 */
interface Counters {
  calls: number
  allowed: number
  retreats: number
  deferred: number
  dropped: number
  gaveUp: number
  byGate: Record<PlanGate, number>
  marks: number
  userSpoke: number
  writes: number
  writeFailures: number
  errors: number
}

/** 造一份零计数。 */
function zeroCounters(): Counters {
  const byGate = {} as Record<PlanGate, number>
  for (const name of PLAN_GATES) byGate[name] = 0
  return {
    calls: 0,
    allowed: 0,
    retreats: 0,
    deferred: 0,
    dropped: 0,
    gaveUp: 0,
    byGate,
    marks: 0,
    userSpoke: 0,
    writes: 0,
    writeFailures: 0,
    errors: 0,
  }
}

/** 构造入参。 */
export interface QuotaOptions {
  /** 配置。 */
  readonly settings: QuotaConfig
  /** 日志。 */
  readonly log: LogLike
  /** 时钟（可缺席）。 */
  readonly clock: () => ClockLike | undefined
  /** 路径服务（可缺席）。 */
  readonly path: () => PathLike | undefined
  /** O-042 门控（可缺席）。 */
  readonly gate: () => GateLike | undefined
  /** 当前时刻。 */
  readonly now: () => number
}

/** 两位补零。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 夹到 0–1。外部给的抽签值可能越界，越界会让「放弃率」形同虚设。 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 一次判定所需的三份视图（**同一时刻算一次**，不在各处重算）。 */
interface Views {
  readonly quota: QuotaView
  readonly interval: IntervalView
  readonly streak: StreakView
  readonly mutedUntil: number
}

/** 额度实现。 */
export class ProactiveQuota implements QuotaService {
  private readonly settings: QuotaConfig
  private readonly log: LogLike
  private readonly clock: () => ClockLike | undefined
  private readonly path: () => PathLike | undefined
  private readonly gate: () => GateLike | undefined
  private readonly now: () => number

  private state: QuotaState = emptyState()
  private file: string | undefined
  private persisted = false
  private warnedWrite = false
  private warnedSnapshot = false
  private counters: Counters = zeroCounters()

  /**
   * @param options 依赖。
   */
  constructor(options: QuotaOptions) {
    this.settings = options.settings
    this.log = options.log
    this.clock = options.clock
    this.path = options.path
    this.gate = options.gate
    this.now = options.now

    this.file = this.resolveFile()
    const loaded = readState(this.file)
    if (loaded === undefined) {
      if (this.file !== undefined) {
        this.log.info('未读到主动节律存档（首次启动或存档已损坏）：按空状态开始')
      }
    } else {
      this.state = loaded
      this.persisted = true
    }
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): QuotaUnavailableReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /** 状态是否真的落盘。 */
  get stored(): boolean {
    return this.persisted
  }

  /**
   * 判一次「此刻愿不愿意说」。
   * @param request 请求。
   * @param at 时刻。
   */
  plan(request: QuotaRequest = {}, at?: number): QuotaPlan {
    const stamp = at ?? request.at ?? this.now()
    this.counters.calls += 1
    try {
      // 日键只取一次：两次取在跨零点那几毫秒里可能落在不同的日子，
      // 于是「退场按今天算、抽签按昨天算」，且两边都不报错。
      const dayKey = this.dayKeyOf(stamp)
      const snapshot = this.snapshotAt(stamp)
      const views = this.viewsAt(stamp, snapshot, dayKey)
      const draw =
        typeof request.draw === 'number' && Number.isFinite(request.draw)
          ? clamp01(request.draw)
          : giveUpDrawOf(dayKey, request.topicKey ?? '', stamp, views.interval.intervalMs)
      const giveUp = shouldGiveUp(this.settings.giveUpRate, draw)
      const result = decide({
        settings: this.settings,
        quota: views.quota,
        interval: views.interval,
        streak: views.streak,
        mutedUntil: views.mutedUntil,
        giveUp,
        at: stamp,
      })

      this.counters.byGate[result.gate] += 1
      if (result.action === 'defer') {
        this.counters.deferred += 1
      } else if (result.allow) {
        this.counters.allowed += 1
        if (result.action === 'retreat') this.counters.retreats += 1
      } else {
        this.counters.dropped += 1
      }
      // 只统计「真的因为抽签而没说」的次数：抽到放弃但另有更硬的拒因（静音/额度）
      // 时不算她的性格，那是别的闸干的。
      if (result.code === 'give-up') this.counters.gaveUp += 1

      if (this.settings.verbose && !result.allow) {
        this.log.debug?.(
          '主动节律：%s（%s）→ %s',
          result.code,
          result.gate,
          result.action,
        )
      }
      return result
    } catch (error) {
      this.counters.errors += 1
      this.log.error(
        '主动节律判定内部错误，本条放行（防封与内容闸仍在 ondra-proactive-gate）：%s',
        error instanceof Error ? error.message : String(error),
      )
      return this.degradedPlan(stamp)
    }
  }

  /**
   * 今日额度视图。
   * @param at 时刻。
   */
  quota(at?: number): QuotaView {
    const stamp = at ?? this.now()
    return this.viewsAt(stamp, this.snapshotAt(stamp)).quota
  }

  /**
   * 间隔视图。
   * @param at 时刻。
   */
  interval(at?: number): IntervalView {
    return intervalOf(this.settings, this.state, at ?? this.now())
  }

  /**
   * 连续无回应视图。
   * @param at 时刻。
   */
  streak(at?: number): StreakView {
    const stamp = at ?? this.now()
    return this.viewsAt(stamp, this.snapshotAt(stamp)).streak
  }

  /**
   * 交给 O-042 的两个覆盖值。
   *
   * **只给未衰减的额度**：衰减由 O-042 算，给它一个已经减半的数会被再减一次。
   * @param at 时刻。
   */
  patch(at?: number): QuotaPatch {
    const stamp = at ?? this.now()
    const base = quotaFor(this.settings)
    const silentDays = this.silentDaysAt(stamp, this.snapshotAt(stamp))
    if (silentDays === undefined) return Object.freeze({ dailyQuota: base })
    return Object.freeze({ dailyQuota: base, silentDays })
  }

  /**
   * 记账：她真的发出去了一条。
   * @param options 是否退场句。
   * @param at 时刻。
   */
  commit(options: CommitOptions = {}, at?: number): CommitOutcome {
    const stamp = at ?? this.now()
    const dayKey = this.dayKeyOf(stamp)
    const retreat = options.retreat === true
    const usedToday = this.state.retreatDayKey === dayKey ? this.state.retreatDayCount : 0
    const next: QuotaState = Object.freeze({
      ...this.state,
      lastProactiveAt: stamp,
      proactiveSinceUser: this.state.proactiveSinceUser + 1,
      // 只有退场句才动当日退场计数：普通主动消息不该吃掉「今天那句告别」。
      retreatDayKey: retreat ? dayKey : this.state.retreatDayKey,
      retreatDayCount: retreat ? usedToday + 1 : this.state.retreatDayCount,
    })
    this.apply(next)
    this.counters.marks += 1
    return Object.freeze({
      at: stamp,
      sinceUser: next.proactiveSinceUser,
      retreatDayCount: retreat ? usedToday + 1 : usedToday,
    })
  }

  /**
   * 上报「用户开口了」。
   * @param at 时刻。
   */
  noteUserSpoke(at?: number): void {
    const stamp = at ?? this.now()
    this.apply(
      Object.freeze({
        ...this.state,
        lastUserAt: stamp,
        proactiveSinceUser: 0,
      }),
    )
    this.counters.userSpoke += 1
  }

  /**
   * 一键静音（§5.7）。
   * @param ms 时长（毫秒）。
   * @param at 时刻。
   */
  mute(ms: number, at?: number): MuteOutcome {
    const stamp = at ?? this.now()
    const span = Math.max(0, Math.trunc(ms))
    const until = span > 0 ? stamp + span : 0
    const gate = this.gate()
    if (gate !== undefined) {
      try {
        const applied = gate.mute(span, stamp)
        return Object.freeze({ until: applied, via: 'gate' })
      } catch (error) {
        // 转发失败不当作成功：退回自己记，并让别人看得见。
        this.log.warn(
          '把静音转发给 ondra-proactive-gate 失败，改为本地记录：%s',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    this.apply(Object.freeze({ ...this.state, mutedUntil: until }))
    return Object.freeze({ until, via: 'self' })
  }

  /**
   * 取消静音。两边都清：只清一边会留下「面板说没静音、判定说静音」。
   */
  unmute(): void {
    const gate = this.gate()
    if (gate !== undefined) {
      try {
        gate.unmute()
      } catch (error) {
        this.log.warn(
          '取消静音转发给 ondra-proactive-gate 失败：%s',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    if (this.state.mutedUntil !== 0) {
      this.apply(Object.freeze({ ...this.state, mutedUntil: 0 }))
    }
  }

  /** 强制落盘。 */
  flush(): boolean {
    return this.persist()
  }

  /** 统计快照。 */
  stats(): QuotaStats {
    const stamp = this.now()
    return Object.freeze({
      calls: this.counters.calls,
      allowed: this.counters.allowed,
      retreats: this.counters.retreats,
      deferred: this.counters.deferred,
      dropped: this.counters.dropped,
      gaveUp: this.counters.gaveUp,
      byGate: Object.freeze({ ...this.counters.byGate }),
      marks: this.counters.marks,
      userSpoke: this.counters.userSpoke,
      writes: this.counters.writes,
      writeFailures: this.counters.writeFailures,
      errors: this.counters.errors,
      stored: this.persisted,
      quota: this.viewsAt(stamp, this.snapshotAt(stamp)).quota,
    })
  }

  /* ---------------------------- 内部 ---------------------------- */

  /**
   * 三份视图。**同一时刻只算一次**：分开算会让「面板说还剩 1 条、判定说没了」
   * 这种不一致在跨零点那几秒里出现（§15-26）。
   * @param at 时刻。
   * @param snapshot O-042 只读快照（可能缺席）。
   */
  private viewsAt(at: number, snapshot: GateSnapshotLike | undefined, dayKey?: string): Views {
    const key = dayKey ?? this.dayKeyOf(at)
    const base = quotaFor(this.settings)
    const quota: QuotaView =
      snapshot === undefined
        ? Object.freeze({
            profile: this.settings.profile,
            base,
            effective: base,
            used: 0,
            remaining: base,
            source: 'local' as const,
          })
        : Object.freeze({
            profile: this.settings.profile,
            base,
            effective: snapshot.budget.quota,
            used: snapshot.budget.used,
            remaining: snapshot.budget.remaining,
            source: 'gate' as const,
          })

    const silentDays = this.silentDaysAt(at, snapshot)
    const retreatInfo = retreatOf(this.settings, this.state, silentDays, key)
    const streak: StreakView = Object.freeze({
      sinceUser: this.state.proactiveSinceUser,
      silentDays,
      retreat: retreatInfo.retreat,
      retreatLeft: retreatInfo.retreatLeft,
    })

    return {
      quota,
      interval: intervalOf(this.settings, this.state, at),
      streak,
      // 两边取较晚者：`mute()` 转发失败时本地记录还在，不能被「上游没有静音」抹掉。
      // 取晚=偏安静，与用户按静音的本意一致。
      mutedUntil: Math.max(
        snapshot === undefined ? 0 : snapshot.mutedUntil,
        this.state.mutedUntil,
      ),
    }
  }

  /**
   * 连续沉默天数：先用自己的记录（它更新），拿不到再问 O-042。
   * @param at 时刻。
   * @param snapshot O-042 只读快照。
   */
  private silentDaysAt(at: number, snapshot: GateSnapshotLike | undefined): number | undefined {
    const own = silentDaysBetween(at, this.state.lastUserAt)
    if (own !== undefined) return own
    return snapshot?.budget.silentDays
  }

  /**
   * 读 O-042 的只读快照。抛错按「没有」处理（C3：错误不外传）。
   * @param at 时刻。
   */
  private snapshotAt(at: number): GateSnapshotLike | undefined {
    const gate = this.gate()
    if (gate === undefined) return undefined
    try {
      return gate.peek(at)
    } catch (error) {
      if (!this.warnedSnapshot) {
        this.warnedSnapshot = true
        this.log.warn(
          '读取 ondra-proactive-gate 快照失败，本插件按「拿不到日计数」降级（后续同类失败不再重复告警）：%s',
          error instanceof Error ? error.message : String(error),
        )
      }
      return undefined
    }
  }

  /** 内部错误的兜底结论（放行，见文件头）。 */
  private degradedPlan(at: number): QuotaPlan {
    const base = quotaFor(this.settings)
    const quota: QuotaView = Object.freeze({
      profile: this.settings.profile,
      base,
      effective: base,
      used: 0,
      remaining: base,
      source: 'local' as const,
    })
    const interval: IntervalView = Object.freeze({
      lastAt: this.state.lastProactiveAt,
      sinceMs: 0,
      remainMs: 0,
      intervalMs: Math.max(0, Math.trunc(this.settings.minIntervalMinutes)) * MINUTE_MS,
    })
    const streak: StreakView = Object.freeze({
      sinceUser: this.state.proactiveSinceUser,
      silentDays: undefined,
      retreat: false,
      retreatLeft: 0,
    })
    return Object.freeze({
      allow: true,
      action: 'send' as const,
      gate: 'pass' as const,
      code: 'internal-error' as const,
      detail: '节律判定内部错误：本条放行（详见 error 日志）',
      deferMs: 0,
      quota,
      streak,
      interval,
      giveUp: false,
      retreat: false,
      at,
    })
  }

  /** 落一份新状态并写盘。 */
  private apply(next: QuotaState): void {
    this.state = next
    this.persist()
  }

  /** 写盘。失败只告警一次，不刷屏。 */
  private persist(): boolean {
    if (this.file === undefined) {
      this.persisted = false
      return false
    }
    if (writeState(this.file, this.state)) {
      this.counters.writes += 1
      this.persisted = true
      return true
    }
    this.counters.writeFailures += 1
    this.persisted = false
    if (!this.warnedWrite) {
      this.warnedWrite = true
      this.log.warn(
        '主动节律状态写盘失败（%s）：间隔与退场计数只在内存里，重启后会重复开口。后续同类失败不再重复告警',
        this.file,
      )
    }
    return false
  }

  /** 解析状态文件路径。 */
  private resolveFile(): string | undefined {
    const path = this.path()
    if (path === undefined) return undefined
    try {
      const file = path.fileIn('user', STATE_FILE_NAME)
      path.prepareFile(file)
      return file
    } catch (error) {
      this.log.warn(
        '主动节律状态文件不可用，退回纯内存：%s',
        error instanceof Error ? error.message : String(error),
      )
      return undefined
    }
  }

  /** 自然日键。优先问 O-003。 */
  private dayKeyOf(at: number): string {
    const clock = this.clock()
    if (clock !== undefined) {
      try {
        return clock.dayKey(at)
      } catch {
        // 时钟坏了退回本机时区，不因此不判定。
      }
    }
    const date = new Date(at)
    return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
  }
}
