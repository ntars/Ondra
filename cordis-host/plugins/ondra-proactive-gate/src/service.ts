/**
 * 门控服务：把纯判定（`gate.ts`）与状态（`state.ts`）接起来。
 *
 * ## 三条纪律
 *
 * 1. **`gate()` 放行才记账**，`peek()` 一个字节都不改。
 *    面板每几秒刷一次额度，刷新若算「使用」，正在说的那场会被反复记账（§15-73）。
 * 2. **判定抛错不外溢**（§8.1 C3 的精神）。`evaluate()` 是纯算术，它抛错说明本插件有 bug；
 *    此时返回 `drop/internal-error` 并打 error 日志——「不知道能不能发」时**不发**，
 *    因为发出去的代价（封号）比少说一句大得多，而日志与 `stats().errors` 能让人看见。
 * 3. **零常驻**：不装定时器、不订阅事件、不持有 socket。所有时间从入参或 `now()` 取。
 */

import { countWithin, trimConversations, trimRecords } from './bucket.js'
import { evaluate, budgetOf } from './gate.js'
import { inWindow, parseHhmm } from './window.js'
import { readState, writeState, emptyState, compactState } from './state.js'
import type { Config as GateConfig } from './settings.js'
import type {
  BucketView,
  ClockLike,
  GateCode,
  GateName,
  GateRequest,
  GateService,
  GateSnapshot,
  GateState,
  GateStats,
  GateUnavailableReason,
  GateVerdict,
  LogLike,
  PathLike,
  RiskInput,
  RiskOutcome,
  SentRecord,
} from './types.js'
import { BACKOFF_SECONDS, FAIL_HITS, FAIL_MS, GATE_NAMES, HOUR_MS, MINUTE_MS, RISK_CODES } from './types.js'

/** 内部计数（可变，故不写成 readonly——§15-60）。 */
interface Counters {
  calls: number
  allowed: number
  deferred: number
  dropped: number
  byGate: Record<GateName, number>
  riskReports: number
  circuitOpens: number
  backoffs: number
  writes: number
  writeFailures: number
  errors: number
}

/** 造一份零计数。 */
function zeroCounters(): Counters {
  const byGate = {} as Record<GateName, number>
  for (const name of GATE_NAMES) byGate[name] = 0
  return {
    calls: 0,
    allowed: 0,
    deferred: 0,
    dropped: 0,
    byGate,
    riskReports: 0,
    circuitOpens: 0,
    backoffs: 0,
    writes: 0,
    writeFailures: 0,
    errors: 0,
  }
}

/** 风控文案的兜底模式。 */
const RISK_TEXT_RE =
  /(操作(过于|太)频繁|发送(过于)?频繁|风控|被限制|账号异常|rate\s*limit|too\s+many\s+requests|forbidden)/iu

/** 构造入参。 */
export interface GateOptions {
  /** 配置。 */
  readonly settings: GateConfig
  /** 日志。 */
  readonly log: LogLike
  /** 时钟（可缺席）。 */
  readonly clock: () => ClockLike | undefined
  /** 路径服务（可缺席）。 */
  readonly path: () => PathLike | undefined
  /** 当前时刻。 */
  readonly now: () => number
}

/** 两位补零。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 门控实现。 */
export class ProactiveGate implements GateService {
  private readonly settings: GateConfig
  private readonly log: LogLike
  private readonly clock: () => ClockLike | undefined
  private readonly path: () => PathLike | undefined
  private readonly now: () => number

  private state: GateState
  private file: string | undefined
  private persisted = false
  private warnedWrite = false
  private counters: Counters = zeroCounters()

  /**
   * @param options 依赖。
   */
  constructor(options: GateOptions) {
    this.settings = options.settings
    this.log = options.log
    this.clock = options.clock
    this.path = options.path
    this.now = options.now

    const stamp = this.now()
    const dayKey = this.dayKeyOf(stamp)
    this.file = this.resolveFile()
    const loaded = readState(this.file, dayKey)
    this.state = loaded === undefined ? emptyState(dayKey) : loaded
    this.persisted = loaded !== undefined && this.file !== undefined

    if (this.file === undefined) {
      this.log.warn(
        '没有路径服务（ondra-path-layout）：门控状态只在内存里，重启会清零——那等于「重启绕过防封」（§5.3-7）',
      )
    } else if (loaded === undefined) {
      this.log.info('门控状态文件还没有内容（首次启动或上次没写成功）：从空状态开始')
    }
  }

  /** 是否可用（只看总开关）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。只有「配置关掉」才算真的不可用。 */
  get reason(): GateUnavailableReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /**
   * 状态是否真的落盘。`false` 时重启会清零。
   *
   * 写成访问器而不是字段：它随每次落盘结果变化，字段会读到构造时的旧值。
   */
  get stored(): boolean {
    return this.persisted
  }

  /**
   * 判定一次投递。
   * @param request 请求。
   * @param at 时刻。
   */
  gate(request: GateRequest, at?: number): GateVerdict {
    const stamp = at ?? request.at ?? this.now()
    const dayKey = this.dayKeyOf(stamp)
    const minuteOfDay = this.minuteOfDayOf(stamp)
    this.counters.calls += 1

    let verdict: GateVerdict
    try {
      verdict = evaluate({
        settings: this.settings,
        state: this.state,
        request,
        at: stamp,
        minuteOfDay,
        dayKey,
      })
    } catch (error) {
      this.counters.errors += 1
      this.counters.dropped += 1
      this.counters.byGate.policy += 1
      this.log.error(
        '门控判定抛错，本条按「不发」处理（不知道能不能发时，不发比发出去安全）：%s',
        error instanceof Error ? error.message : String(error),
      )
      return this.internalErrorVerdict(request, stamp, dayKey)
    }

    if (verdict.action === 'send') {
      this.counters.allowed += 1
      this.commit(request, stamp, dayKey)
    } else if (verdict.action === 'defer') {
      this.counters.deferred += 1
    } else {
      this.counters.dropped += 1
    }
    this.counters.byGate[verdict.gate] += 1

    if (this.settings.verbose && verdict.action !== 'send') {
      this.log.debug?.('[%s] %s：%s', verdict.code, verdict.gate, verdict.detail)
    }
    return verdict
  }

  /**
   * 只读快照。
   * @param at 时刻。
   */
  peek(at?: number): GateSnapshot {
    const stamp = at ?? this.now()
    const dayKey = this.dayKeyOf(stamp)
    const minute = this.minuteOfDayOf(stamp)
    const budget = budgetOf(this.settings, this.state, { reason: 'active', text: '' }, stamp, dayKey)
    const sent = this.state.sent

    const minuteUsed = countWithin(sent, stamp, MINUTE_MS)
    const hourUsed = countWithin(sent, stamp, HOUR_MS)
    const dayUsed = this.state.dayKey === dayKey ? this.state.daySent : 0

    const minuteBucket: BucketView = Object.freeze({ used: minuteUsed, cap: this.settings.perMinute })
    const hourBucket: BucketView = Object.freeze({ used: hourUsed, cap: this.settings.perHour })
    const dayBucket: BucketView = Object.freeze({ used: dayUsed, cap: this.settings.perDay })

    return Object.freeze({
      at: stamp,
      budget,
      buckets: Object.freeze({ minute: minuteBucket, hour: hourBucket, day: dayBucket }),
      circuitOpen: this.state.openUntil > stamp,
      openUntil: this.state.openUntil,
      retryUntil: this.state.retryUntil,
      mutedUntil: this.state.mutedUntil,
      stored: this.persisted,
      tracked: sent.length,
      quietNow: this.inQuiet(minute, true),
      antiBanQuietNow: this.inQuiet(minute, false),
    })
  }

  /**
   * 风控回报。
   * @param input 回报内容。
   */
  reportRisk(input: RiskInput): RiskOutcome {
    const stamp = input.at ?? this.now()
    this.counters.riskReports += 1

    const recognized = this.recognize(input)
    if (recognized === 'none') {
      return Object.freeze({
        recognized: false,
        reason: 'none',
        hits: this.state.riskHits,
        tripped: false,
        openUntil: this.state.openUntil,
        retryAfterMs: 0,
      })
    }

    const hits = this.state.riskHits + 1
    const tripped = hits >= this.settings.circuitHits
    const openUntil = tripped ? stamp + this.settings.circuitMinutes * 60_000 : 0
    const step = Math.min(Math.max(0, hits - 1), BACKOFF_SECONDS.length - 1)
    const backoffSeconds = BACKOFF_SECONDS.at(step) ?? 1800
    const retryUntil = tripped ? openUntil : stamp + backoffSeconds * 1000

    this.apply(
      {
        ...this.state,
        // 熔断后把连击清零：解除后要再攒三次才会重新熔断。
        riskHits: tripped ? 0 : hits,
        openUntil,
        retryUntil,
      },
      stamp,
    )

    if (tripped) {
      this.counters.circuitOpens += 1
      this.log.error(
        '连续 %d 次风控命中 → 熔断 %d 分钟。被盯上时唯一正确的做法是完全闭嘴',
        this.settings.circuitHits,
        this.settings.circuitMinutes,
      )
    } else {
      this.counters.backoffs += 1
      this.log.warn('风控命中第 %d 次 → 退避 %d 秒', hits, backoffSeconds)
    }

    return Object.freeze({
      recognized: true,
      reason: recognized,
      hits: tripped ? 0 : hits,
      tripped,
      openUntil,
      retryAfterMs: retryUntil - stamp,
    })
  }

  /**
   * 发送成功。
   * @param at 时刻。
   */
  reportSuccess(at?: number): void {
    const stamp = at ?? this.now()
    if (
      this.state.riskHits === 0 &&
      this.state.retryUntil === 0 &&
      this.state.failHits === 0 &&
      this.state.failUntil === 0
    ) {
      return
    }
    this.apply(
      { ...this.state, riskHits: 0, retryUntil: 0, failHits: 0, failUntil: 0 },
      stamp,
    )
  }

  /**
   * 发送失败（非风控）。
   * @param at 时刻。
   */
  reportFailure(at?: number): RiskOutcome {
    const stamp = at ?? this.now()
    const hits = this.state.failHits + 1
    const tripped = hits >= FAIL_HITS
    const failUntil = tripped ? stamp + FAIL_MS : this.state.failUntil

    this.apply({ ...this.state, failHits: tripped ? 0 : hits, failUntil }, stamp)
    if (tripped) {
      this.log.warn('连续 %d 次发送失败 → 暂停 %d 分钟', FAIL_HITS, Math.round(FAIL_MS / 60_000))
    }

    return Object.freeze({
      recognized: false,
      reason: 'none',
      hits: tripped ? 0 : hits,
      tripped,
      openUntil: this.state.openUntil,
      retryAfterMs: Math.max(0, failUntil - stamp),
    })
  }

  /**
   * 一键静音。
   * @param ms 时长毫秒。
   * @param at 时刻。
   */
  mute(ms: number, at?: number): number {
    const stamp = at ?? this.now()
    const until = stamp + Math.max(0, Math.trunc(ms))
    this.apply({ ...this.state, mutedUntil: until }, stamp)
    return until
  }

  /** 取消静音。 */
  unmute(): void {
    if (this.state.mutedUntil === 0) return
    this.apply({ ...this.state, mutedUntil: 0 }, this.now())
  }

  /**
   * 人工复位：清熔断、退避、失败暂停。**不清当日已用**——那是事实，不是状态。
   * @param at 时刻。
   */
  reset(at?: number): void {
    const stamp = at ?? this.now()
    this.apply(
      { ...this.state, openUntil: 0, retryUntil: 0, failUntil: 0, riskHits: 0, failHits: 0 },
      stamp,
    )
  }

  /** 强制落盘。 */
  flush(): boolean {
    return this.persist()
  }

  /** 统计快照。 */
  stats(): GateStats {
    const stamp = this.now()
    const dayKey = this.dayKeyOf(stamp)
    return Object.freeze({
      calls: this.counters.calls,
      allowed: this.counters.allowed,
      deferred: this.counters.deferred,
      dropped: this.counters.dropped,
      byGate: Object.freeze({ ...this.counters.byGate }),
      riskReports: this.counters.riskReports,
      circuitOpens: this.counters.circuitOpens,
      backoffs: this.counters.backoffs,
      writes: this.counters.writes,
      writeFailures: this.counters.writeFailures,
      stored: this.persisted,
      tracked: this.state.sent.length,
      budget: budgetOf(this.settings, this.state, { reason: 'active', text: '' }, stamp, dayKey),
    })
  }

  /* ---------------------------- 内部 ---------------------------- */

  /** 判定抛错时的兜底结论。 */
  private internalErrorVerdict(request: GateRequest, at: number, dayKey: string): GateVerdict {
    const code: GateCode = 'internal-error'
    return {
      allowed: false,
      action: 'drop',
      gate: 'policy',
      code,
      detail: '门控内部错误：本条不发（详见 error 日志）',
      deferMs: 0,
      jitterMs: 0,
      stopUntil: this.state.openUntil > at ? this.state.openUntil : 0,
      budget: budgetOf(this.settings, this.state, request, at, dayKey),
      at,
    }
  }

  /** 记一次发送。 */
  private commit(request: GateRequest, at: number, dayKey: string): void {
    const sameDay = this.state.dayKey === dayKey
    const record: SentRecord = Object.freeze({ at, text: request.text })
    const sent = trimRecords([...this.state.sent, record], at)

    const table: Record<string, number> = { ...this.state.lastByConversation }
    const conversationId = request.conversationId
    if (conversationId !== undefined && conversationId !== '') {
      table[conversationId] = at
    }

    const isActive = request.reason === 'active'
    this.apply(
      {
        ...this.state,
        dayKey,
        dayCount: (sameDay ? this.state.dayCount : 0) + (isActive ? 1 : 0),
        daySent: (sameDay ? this.state.daySent : 0) + 1,
        sent,
        lastByConversation: trimConversations(table, at),
        // 回话/被叫意味着用户刚开口；主动发送不改变这个时刻。
        lastUserAt: isActive ? this.state.lastUserAt : at,
      },
      at,
    )
  }

  /** 落一份新状态并写盘。 */
  private apply(next: GateState, at: number): void {
    this.state = compactState(next, at)
    this.persist()
  }

  /** 写盘。失败只告警一次，不刷屏。 */
  private persist(): boolean {
    if (this.file === undefined) {
      this.persisted = false
      return false
    }
    const ok = writeState(this.file, this.state)
    if (ok) {
      this.counters.writes += 1
      this.persisted = true
      return true
    }
    this.counters.writeFailures += 1
    this.persisted = false
    if (!this.warnedWrite) {
      this.warnedWrite = true
      this.log.warn(
        '门控状态写盘失败（%s）：计数只在内存里，重启会清零——这等于「重启绕过防封」。后续同类失败不再重复告警',
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
      const file = path.fileIn('user', 'proactive-state.json')
      path.prepareFile(file)
      return file
    } catch (error) {
      this.log.warn(
        '门控状态文件不可用，退回纯内存：%s',
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

  /** 一天中的第几分钟。优先问 O-003。 */
  private minuteOfDayOf(at: number): number {
    const clock = this.clock()
    if (clock !== undefined) {
      try {
        return clock.minuteOfDay(at)
      } catch {
        // 同上。
      }
    }
    const date = new Date(at)
    return date.getHours() * 60 + date.getMinutes()
  }

  /**
   * 某一分钟是否落在某个窗口内（面板用）。
   *
   * **复用 `window.ts` 的同一套算术**：面板说「在静默里」而判定说「不在」，
   * 是最难查的一类不一致（§15-47 的同一教训）。
   */
  private inQuiet(minute: number, product: boolean): boolean {
    const start = parseHhmm(product ? this.settings.quietStart : this.settings.antiBanQuietStart)
    const end = parseHhmm(product ? this.settings.quietEnd : this.settings.antiBanQuietEnd)
    if (start === undefined || end === undefined) return false
    return inWindow(minute, start, end)
  }

  /** 认一次风控。 */
  private recognize(input: RiskInput): 'code' | 'text' | 'none' {
    if (typeof input.code === 'number' && RISK_CODES.includes(input.code)) return 'code'
    if (typeof input.text === 'string' && RISK_TEXT_RE.test(input.text)) return 'text'
    return 'none'
  }
}
