/**
 * 打字执行服务：把 O-038 的计划变成真实的时间线。
 *
 * ## 三个不变量
 *
 * 1. **同一会话同时只有一轮在跑。** 新一轮进来先顶掉旧的（`superseded`），
 *    否则旧回复可能在新回复之后到达——顺序错乱比少发一条严重。
 * 2. **取消一定落到「不再发下一条」**，不会出现「已经取消但第 3 条还是发出去了」。
 *    做法是每一步之间都重新检查一次，而不是只在开头检查。
 * 3. **`run()` 永不抛出。** 异常写进返回值，调用方只需看 `error`。
 *
 * ## 为什么不自己做限流与重试
 *
 * 每个通道的语义不同（QQ 被动回复要带 `msg_id`、微信客服有 48 小时窗口、
 * 飞书要先回 200 再异步）。限流与重试归各适配器，本插件只管「按计划等、按顺序发」。
 */

import type { Config } from './settings.js'
import { sleep } from './runner.js'
import type { TimerSet } from './runner.js'
import type {
  LogLike,
  RhythmPlanLike,
  RhythmServiceLike,
  TypingEvent,
  TypingHandlers,
  TypingOptions,
  TypingPhase,
  TypingResult,
  TypingSchedule,
  TypingService,
  TypingStats,
  TypingStep,
} from './types.js'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 服务的外部依赖（全部用取值函数：上游晚装载能自愈，早卸载立刻反映）。 */
export interface TypingDeps {
  readonly settings: Config
  readonly log: LogLike
  /** O-038 节奏服务。 */
  readonly rhythm: () => RhythmServiceLike | undefined
  /** 当前时刻。 */
  readonly now: () => number
}

/** 一轮执行的内部状态。 */
interface RunState {
  readonly conversationId: string
  /** 被 `cancel()` 或外部 signal 取消。 */
  aborted: boolean
  /** 被同会话的下一轮顶掉。 */
  superseded: boolean
  /** 当前对外阶段。 */
  phase: TypingPhase
  /** 内部取消信号（`sleep` 靠它立刻结束）。 */
  readonly controller: AbortController
  /** 本轮的定时器。 */
  readonly timers: TimerSet
  /** 计划总条数。 */
  readonly total: number
}

/** 统计计数器。 */
interface Counters {
  runs: number
  sent: number
  aborted: number
  superseded: number
  degraded: number
  failed: number
  elapsedTotal: number
}

/** 打字执行服务实现。 */
export class Typing implements TypingService {
  private readonly deps: TypingDeps

  /** 正在跑的会话。 */
  private readonly active = new Map<string, RunState>()

  /** 阶段监听器（O-041 用）。 */
  private readonly listeners = new Set<(event: TypingEvent) => void>()

  private readonly counters: Counters = {
    runs: 0,
    sent: 0,
    aborted: 0,
    superseded: 0,
    degraded: 0,
    failed: 0,
    elapsedTotal: 0,
  }

  constructor(deps: TypingDeps) {
    this.deps = deps
  }

  /** 只看配置开关：本插件对 O-038 是可选依赖，所以可用等于开着。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 关闭是唯一不可用原因。 */
  get reason(): 'disabled' | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /**
   * 节奏服务是否在位。
   *
   * 每次现问，不缓存：O-038 可能在运行中被卸载，缓存一份会让面板一直显示
   * 「已就绪」而实际每轮都在降级。
   */
  get rhythmReady(): boolean {
    const rhythm = this.deps.rhythm()
    return rhythm !== undefined && rhythm.available !== false
  }

  /**
   * 只排时间线，不执行。**永不抛出**。
   * @param text 正文。
   * @param options 执行选项（只用到会话 id / 时刻 / 表达档）。
   */
  schedule(text: string, options?: TypingOptions): TypingSchedule {
    const settings = this.deps.settings
    const conversationId = this.idOf(options)
    const body = typeof text === 'string' ? text : ''

    if (!settings.enable) {
      return this.oneShot(conversationId, body, 'disabled', '插件已关闭：一次性整段发出（不模拟打字）')
    }
    if (body.trim() === '') {
      return {
        conversationId,
        steps: [],
        totalMs: 0,
        source: 'oneshot',
        degraded: 'empty-text',
        notes: ['没有正文，不出时间线'],
      }
    }

    const rhythm = this.deps.rhythm()
    if (rhythm === undefined || rhythm.available === false) {
      return this.oneShot(conversationId, body, 'no-rhythm', '节奏服务未装载：一次性整段发出（不模拟打字）')
    }

    let plan: RhythmPlanLike
    try {
      plan = rhythm.plan({ text: body, at: options?.at, style: options?.style })
    } catch (error) {
      if (settings.verbose) {
        this.deps.log.warn('取节奏计划失败（已退回一次性整段发出）：%s', messageOf(error))
      }
      return this.oneShot(conversationId, body, 'rhythm-error', '节奏计划失败：一次性整段发出')
    }

    // 空串不排进时间线：外部节奏实现若返回空条，会变成一个「空气泡」——
    // 用户看到一条什么都没有的消息，而日志里一切正常。
    const source = (Array.isArray(plan.messages) ? plan.messages : []).filter(
      item => typeof item.text === 'string' && item.text.trim() !== '',
    )
    if (source.length === 0) {
      return this.oneShot(conversationId, body, 'empty-text', '节奏服务返回空计划：一次性整段发出')
    }

    const wake = options?.justWoke === true ? Math.max(0, settings.wakeBufferMs) : 0
    const steps: TypingStep[] = []
    let totalMs = 0

    for (const item of source) {
      const index = steps.length
      const pauseMs = typeof item.pauseMs === 'number' && Number.isFinite(item.pauseMs) ? item.pauseMs : 0
      const delayMs = typeof item.delayMs === 'number' && Number.isFinite(item.delayMs) ? item.delayMs : 0
      // 首条额外加「刚醒缓冲」：她刚醒，看到消息到开始打字要多花一点时间。
      const waitMs = Math.max(0, Math.round(delayMs + pauseMs + (index === 0 ? wake : 0)))
      const longPause = pauseMs > 0
      steps.push({
        index,
        text: item.text,
        waitMs,
        // 长停顿期间报 paused：走神时不该显示「正在输入」。
        phase:
          index === 0
            ? 'thinking'
            : longPause && pauseMs >= settings.longPauseThresholdMs
              ? 'paused'
              : 'typing',
        longPause,
      })
      totalMs += waitMs
    }

    const notes: string[] = ['按节奏服务分 ' + String(steps.length) + ' 条，共 ' + String(totalMs) + 'ms']
    if (wake > 0) notes.push('刚醒缓冲 +' + String(wake) + 'ms（只加在首条）')

    return {
      conversationId,
      steps,
      totalMs,
      source: 'rhythm',
      degraded: null,
      notes,
    }
  }

  /**
   * 跑一条时间线。**永不抛出**。
   * @param text 正文。
   * @param handlers 发送与阶段回调。
   * @param options 执行选项。
   */
  async run(text: string, handlers: TypingHandlers, options?: TypingOptions): Promise<TypingResult> {
    const started = this.deps.now()
    try {
      return await this.execute(text, handlers, options, started)
    } catch (failure) {
      // 兜底必须包住**整段**，不能只包住发送循环：
      // `schedule()` 里要问 O-038 要计划，那个取值函数抛错时，
      // 只包循环的写法会让调用方拿到一个 rejection——而契约写着「永不抛出」。
      const error = messageOf(failure)
      this.counters.runs += 1
      this.counters.failed += 1
      if (this.deps.settings.verbose) {
        this.deps.log.error('执行打字时间线时异常（已吞掉，不让调用方崩）：%s', error)
      }
      return {
        conversationId: this.idOf(options),
        sent: 0,
        total: 0,
        aborted: false,
        superseded: false,
        degraded: 'rhythm-error',
        elapsedMs: Math.max(0, Math.round(this.deps.now() - started)),
        error,
      }
    }
  }

  /**
   * 真正执行的那一段。`run()` 只负责兜住它抛出的任何东西。
   * @param text 正文。
   * @param handlers 发送与阶段回调。
   * @param options 执行选项。
   * @param started 开始时刻（算耗时用）。
   */
  private async execute(
    text: string,
    handlers: TypingHandlers,
    options: TypingOptions | undefined,
    started: number,
  ): Promise<TypingResult> {
    const schedule = this.schedule(text, options)
    const conversationId = schedule.conversationId

    // 同会话的上一轮先顶掉：旧回复晚到比少发一条更糟。
    const previous = this.active.get(conversationId)
    if (previous !== undefined) {
      previous.superseded = true
      this.stop(previous)
    }

    const state: RunState = {
      conversationId,
      aborted: false,
      superseded: false,
      phase: 'idle',
      controller: new AbortController(),
      timers: new Set(),
      total: schedule.steps.length,
    }
    this.active.set(conversationId, state)

    const external = options?.signal
    const onExternalAbort = (): void => {
      state.aborted = true
      this.stop(state)
    }
    if (external !== undefined) {
      if (external.aborted) {
        state.aborted = true
      } else {
        external.addEventListener('abort', onExternalAbort, { once: true })
      }
    }

    let sent = 0
    let error: string | undefined

    try {
      for (const step of schedule.steps) {
        // 每一步之前都查一次：只在开头查，取消之后还会把剩下的发完。
        if (this.stopped(state)) break
        this.emit(state, handlers, step.phase, step.index)
        await sleep(step.waitMs, state.controller.signal, state.timers)
        if (this.stopped(state)) break
        try {
          await handlers.send(step.text, step.index)
          sent += 1
        } catch (failure) {
          // 发送失败通常意味着通道坏了，继续发剩下的只会把错误放大。
          error = messageOf(failure)
          break
        }
      }
    } catch (failure) {
      error = messageOf(failure)
    } finally {
      if (external !== undefined) external.removeEventListener('abort', onExternalAbort)
      // 只有「这一轮仍然是该会话的当前轮」才报 idle：
      // 被顶掉的那一轮如果也报 idle，O-041 会在新一轮的「正在输入」中途收到一次 idle。
      const current = this.active.get(conversationId) === state
      if (current) this.emit(state, handlers, 'idle', schedule.steps.length)
      this.stop(state)
      if (current) this.active.delete(conversationId)
    }

    const elapsedMs = Math.max(0, Math.round(this.deps.now() - started))
    this.counters.runs += 1
    this.counters.sent += sent
    this.counters.elapsedTotal += elapsedMs
    if (state.aborted) this.counters.aborted += 1
    if (state.superseded) this.counters.superseded += 1
    if (schedule.degraded !== null) this.counters.degraded += 1
    if (error !== undefined) this.counters.failed += 1

    if (error !== undefined && this.deps.settings.verbose) {
      this.deps.log.warn('第 %d 条发送失败（本轮终止，已发 %d 条）：%s', sent + 1, sent, error)
    }
    if (schedule.degraded !== null && schedule.degraded !== 'empty-text' && this.deps.settings.verbose) {
      this.deps.log.info('本轮降级（%s）：%s', schedule.degraded, schedule.notes.join('；'))
    }

    const result: TypingResult = {
      conversationId,
      sent,
      total: schedule.steps.length,
      aborted: state.aborted,
      superseded: state.superseded,
      degraded: schedule.degraded,
      elapsedMs,
    }
    return error === undefined ? result : { ...result, error }
  }

  /**
   * 取消在跑的一轮。
   * @param conversationId 省略则取消全部。
   */
  cancel(conversationId?: string): boolean {
    if (conversationId === undefined) {
      let any = false
      for (const state of this.active.values()) {
        state.aborted = true
        this.stop(state)
        any = true
      }
      return any
    }
    const state = this.active.get(conversationId)
    if (state === undefined) return false
    state.aborted = true
    this.stop(state)
    return true
  }

  /**
   * 读当前阶段。
   * @param conversationId 会话 id，省略用默认值。
   */
  phaseOf(conversationId?: string): TypingPhase {
    const id = conversationId ?? this.deps.settings.conversationId
    return this.active.get(id)?.phase ?? 'idle'
  }

  /**
   * 订阅阶段事件。
   * @param listener 监听器。
   */
  subscribe(listener: (event: TypingEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 统计快照。 */
  stats(): TypingStats {
    const c = this.counters
    return {
      runs: c.runs,
      sent: c.sent,
      aborted: c.aborted,
      superseded: c.superseded,
      degraded: c.degraded,
      failed: c.failed,
      active: this.active.size,
      avgElapsedMs: c.runs > 0 ? Math.round(c.elapsedTotal / c.runs) : 0,
    }
  }

  /**
   * 卸载时的收尾：取消全部在跑的轮次、清空监听器。
   *
   * 必须在 `ctx.effect` 的 disposer 里调用——否则插件卸载后定时器还在跑，
   * 回调会对着已经不存在的通道发消息。
   */
  dispose(): void {
    this.cancel()
    this.listeners.clear()
  }

  /** 会话 id：入参优先，其次配置默认值。 */
  private idOf(options?: TypingOptions): string {
    const raw = options?.conversationId
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
    return this.deps.settings.conversationId
  }

  /** 这一轮是否该停（取消、顶掉、内部信号任一为真）。 */
  private stopped(state: RunState): boolean {
    return state.aborted || state.superseded || state.controller.signal.aborted
  }

  /** 停一轮：先 abort（让 `sleep` 立刻结束），再清定时器。顺序不能反。 */
  private stop(state: RunState): void {
    if (!state.controller.signal.aborted) state.controller.abort()
    for (const handle of state.timers) {
      clearTimeout(handle)
    }
    state.timers.clear()
  }

  /** 报一次阶段。监听器与回调都包 try/catch：一个坏监听器不能拖死发送循环。 */
  private emit(state: RunState, handlers: TypingHandlers, phase: TypingPhase, index: number): void {
    state.phase = phase
    const event: TypingEvent = {
      conversationId: state.conversationId,
      phase,
      index,
      total: state.total,
      at: this.deps.now(),
    }

    if (this.deps.settings.emitPhaseEvents) {
      for (const listener of [...this.listeners]) {
        try {
          listener(event)
        } catch (error) {
          if (this.deps.settings.verbose) {
            this.deps.log.debug?.('阶段监听器抛错（已忽略）：%s', messageOf(error))
          }
        }
      }
    }

    if (handlers.phase !== undefined) {
      try {
        handlers.phase(event)
      } catch (error) {
        if (this.deps.settings.verbose) {
          this.deps.log.debug?.('阶段回调抛错（已忽略）：%s', messageOf(error))
        }
      }
    }
  }

  /** 降级：一条消息直接发，不做任何等待。 */
  private oneShot(
    conversationId: string,
    body: string,
    degraded: 'disabled' | 'no-rhythm' | 'rhythm-error' | 'empty-text',
    note: string,
  ): TypingSchedule {
    const text = typeof body === 'string' ? body : ''
    const steps: TypingStep[] =
      text.trim() === ''
        ? []
        : [{ index: 0, text, waitMs: 0, phase: 'thinking', longPause: false }]
    return {
      conversationId,
      steps,
      totalMs: 0,
      source: 'oneshot',
      degraded,
      notes: [note],
    }
  }
}
