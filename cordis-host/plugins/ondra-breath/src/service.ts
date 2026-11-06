/**
 * 「正在输入」与呼吸感服务的实现。
 *
 * ## 本文件只做三件事
 *
 * 1. 把 O-039 的阶段翻成「该不该显示」（`presence.ts` 一张表）；
 * 2. 在单日额度内挑一个呼吸感动作（`quota.ts` 一本账）；
 * 3. 把两者串起来并记账。
 *
 * ## 明确不做
 *
 * - **不发消息**：`take()` 只返回「哪一句」，发送归通道层。
 * - **不画界面**：`presence()` 只回 `show: boolean`，指示器归 O-085+。
 * - **不装定时器**：额度靠访问时懒换日，跨零点不需要唤醒。
 * - **不缓存阶段**：`phaseOf()` 每次现问。缓存会让「她已经打完了、
 *   指示器还亮着」这种状态多停留一整个轮次。
 */

import { hidden, normalizePhase, presenceOf } from './presence.js'
import { BreathLedger, localDayKey, quotaOf } from './quota.js'
import type { Config } from './settings.js'
import { HANDBOOK_ACTION, HARD_MAX_ACTIONS } from './types.js'
import type {
  ActionRegistration,
  BreathAction,
  BreathActionInput,
  BreathDecision,
  BreathEvent,
  BreathQuota,
  BreathService,
  BreathStats,
  BreathTakeRequest,
  ClockLike,
  LogLike,
  PresenceView,
  TypingServiceLike,
} from './types.js'

/** 默认会话 id（调用方不传时）。 */
const DEFAULT_CONVERSATION = 'default'

/** 手册那条动作的 id（稳定，供 `exclude` 与用量查询）。 */
const HANDBOOK_ACTION_ID = 'handbook-lazy-stretch'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 把动作正文规整成「带全角括号的一段」。
 *
 * 手册的例子是「（伸了个懒腰）」——括号是动作的一部分，不是排版。
 * 少一边括号会让它在正文里读成旁白而不是动作。
 * @param text 原始正文。
 */
export function normalizeActionText(text: string): string {
  let out = text.trim()
  if (out === '') return ''
  if (!out.startsWith('（')) out = '（' + out
  if (!out.endsWith('）')) out = out + '）'
  return out
}

/** 服务的外部依赖（全部用取值函数：上游晚装载能自愈，早卸载立刻反映）。 */
export interface BreathDeps {
  readonly settings: Config
  readonly log: LogLike
  /** O-039 打字执行层。 */
  readonly typing: () => TypingServiceLike | undefined
  /** O-003 时间服务。 */
  readonly clock: () => ClockLike | undefined
  /** 当前时刻。 */
  readonly now: () => number
}

/** 统计计数器（唯一的可变状态）。 */
interface Counters {
  takes: number
  allowed: number
  deniedQuota: number
  deniedDuplicate: number
  typingErrors: number
}

/** 呼吸感服务实现。 */
export class Breath implements BreathService {
  private readonly deps: BreathDeps

  private readonly ledger = new BreathLedger()

  /** 动作表（手册那条永远在第 0 位）。 */
  private actionList: BreathAction[] = []

  /** 自定义动作的自增序号（避免 id 撞车）。 */
  private nextCustomId = 1

  private readonly counters: Counters = {
    takes: 0,
    allowed: 0,
    deniedQuota: 0,
    deniedDuplicate: 0,
    typingErrors: 0,
  }

  constructor(deps: BreathDeps) {
    this.deps = deps
    this.actionList = [
      Object.freeze({ id: HANDBOOK_ACTION_ID, text: HANDBOOK_ACTION, origin: 'handbook' as const }),
    ]
    this.appendActions(deps.settings.extraActions.map(text => ({ text })))
  }

  /** 只看配置开关。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 关闭是唯一不可用原因。 */
  get reason(): 'disabled' | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /** 打字执行层此刻是否在位（现问，不缓存）。 */
  get typingReady(): boolean {
    return this.deps.typing() !== undefined
  }

  /** 此刻该不该显示「正在输入」。 */
  presence(conversationId?: string): PresenceView {
    const id = conversationId ?? DEFAULT_CONVERSATION
    const settings = this.deps.settings
    if (!settings.enable || !settings.presenceEnabled) return hidden(id, 'disabled')

    const typing = this.deps.typing()
    if (typing === undefined) return hidden(id, 'no-typing')

    try {
      return presenceOf(normalizePhase(typing.phaseOf(id)), id)
    } catch (error) {
      this.counters.typingErrors += 1
      if (settings.verbose) {
        this.deps.log.warn('读打字阶段失败（按不显示处理）：%s', messageOf(error))
      }
      return hidden(id, 'no-typing')
    }
  }

  /** 订阅阶段变化。 */
  subscribe(listener: (event: BreathEvent) => void): () => void {
    const settings = this.deps.settings
    if (!settings.enable || !settings.presenceEnabled) return () => {}
    const typing = this.deps.typing()
    if (typing === undefined) {
      // 不重试：重试需要常驻定时器，而零常驻是硬约束。
      if (settings.verbose) this.deps.log.info('打字执行层未装载：本次订阅不生效（不重试）')
      return () => {}
    }
    try {
      const disposer = typing.subscribe(event => {
        // 监听器抛错绝不能冒进发送循环（O-039 的同一约束）。
        try {
          if (!this.deps.settings.enable) return
          const view = presenceOf(normalizePhase(event.phase), event.conversationId)
          const payload: BreathEvent = { ...view, at: event.at }
          listener(Object.freeze(payload))
        } catch (error) {
          this.deps.log.warn('阶段监听器抛错（已忽略）：%s', messageOf(error))
        }
      })
      // 上游若返回了非函数（老版本/骨架实现），包一层空函数——
      // 否则调用方按契约调 disposer 会当场抛「不是函数」。
      return typeof disposer === 'function' ? disposer : () => {}
    } catch (error) {
      this.deps.log.warn('订阅打字阶段失败：%s', messageOf(error))
      return () => {}
    }
  }

  /** 全部动作。 */
  actions(): readonly BreathAction[] {
    return Object.freeze([...this.actionList])
  }

  /** 注册/追加动作。**永不抛错**。 */
  registerActions(actions: readonly BreathActionInput[]): ActionRegistration {
    return this.appendActions(Array.isArray(actions) ? actions : [])
  }

  /** 今天还剩几次（只读）。 */
  peek(at?: number): BreathQuota {
    return this.snapshotOf(this.dayKeyOf(this.atOf(at)))
  }

  /** `peek()` 的别名。 */
  daily(at?: number): BreathQuota {
    return this.peek(at)
  }

  /** 取一次动作（消耗额度）。 */
  take(request?: BreathTakeRequest): BreathDecision {
    const settings = this.deps.settings
    const at = this.atOf(request?.at)
    const dayKey = this.dayKeyOf(at)
    const rng = typeof request?.rng === 'function' ? request.rng : Math.random
    this.counters.takes += 1

    if (!settings.enable || !settings.breathEnabled) {
      const off: BreathDecision = { allowed: false, reason: 'disabled', quota: this.snapshotOf(dayKey) }
      return Object.freeze(off)
    }

    const current = this.snapshotOf(dayKey)
    if (current.used >= current.cap) {
      this.counters.deniedQuota += 1
      if (settings.verbose) {
        this.deps.log.info('今日呼吸感动作已用完（%d/%d）', current.used, current.cap)
      }
      const full: BreathDecision = { allowed: false, reason: 'quota', quota: current }
      return Object.freeze(full)
    }

    if (this.actionList.length === 0) {
      const none: BreathDecision = { allowed: false, reason: 'no-action', quota: current }
      return Object.freeze(none)
    }

    const excluded = new Set(request?.exclude ?? [])
    const candidates = this.actionList.filter(action => {
      if (excluded.has(action.id)) return false
      if (!settings.sameActionOncePerDay) return true
      return this.ledger.usedOfOn(action.id, dayKey) === 0
    })

    if (candidates.length === 0) {
      this.counters.deniedDuplicate += 1
      if (settings.verbose) {
        this.deps.log.info('每个呼吸感动作今天都用过了，本次不给')
      }
      const dup: BreathDecision = { allowed: false, reason: 'duplicate-action', quota: current }
      return Object.freeze(dup)
    }

    const index = Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))
    const chosen = candidates[index]
    this.ledger.ensure(dayKey)
    this.ledger.record(chosen.id)
    this.counters.allowed += 1

    const granted: BreathDecision = {
      allowed: true,
      reason: 'ok',
      action: chosen,
      text: chosen.text,
      quota: this.snapshotOf(dayKey),
    }
    return Object.freeze(granted)
  }

  /** 统计快照。 */
  stats(): BreathStats {
    return Object.freeze({
      takes: this.counters.takes,
      allowed: this.counters.allowed,
      deniedQuota: this.counters.deniedQuota,
      deniedDuplicate: this.counters.deniedDuplicate,
      days: this.ledger.dayCount(),
      actions: this.actionList.length,
      typingErrors: this.counters.typingErrors,
    })
  }

  /* ---------------- 内部 ---------------- */

  /** 时刻兜底。 */
  private atOf(value: number | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : this.deps.now()
  }

  /** 自然日键：优先问 O-003，缺席才用本机时区。 */
  private dayKeyOf(at: number): string {
    const clock = this.deps.clock()
    if (clock !== undefined) {
      try {
        const key = clock.dayKey(at)
        if (typeof key === 'string' && key !== '') return key
      } catch (error) {
        if (this.deps.settings.verbose) {
          this.deps.log.warn('取自然日键失败（退回本机时区）：%s', messageOf(error))
        }
      }
    }
    return localDayKey(at)
  }

  /** 组装额度快照。 */
  private snapshotOf(dayKey: string): BreathQuota {
    const settings = this.deps.settings
    const used = this.ledger.usedOn(dayKey)
    const usages = this.actionList.map(action =>
      Object.freeze({
        id: action.id,
        text: action.text,
        used: this.ledger.usedOfOn(action.id, dayKey),
      }),
    )
    // 「还能给几个」：同动作每日一次时，今天用过的动作不再算可给。
    const available = this.actionList.filter(
      action => !settings.sameActionOncePerDay || this.ledger.usedOfOn(action.id, dayKey) === 0,
    ).length
    const remaining = Math.min(settings.dailyCap - used, available)
    return quotaOf(dayKey, used, settings.dailyCap, remaining, Object.freeze(usages))
  }

  /** 追加动作（构造期与 `registerActions` 共用）。 */
  private appendActions(inputs: readonly BreathActionInput[]): ActionRegistration {
    const issues: string[] = []
    let dropped = 0
    try {
      for (const input of inputs) {
        if (typeof input !== 'object' || input === null) {
          dropped += 1
          issues.push('有一条不是对象，已丢弃')
          continue
        }
        const text = normalizeActionText(typeof input.text === 'string' ? input.text : '')
        if (text === '' || text === '（）') {
          dropped += 1
          issues.push('有一条正文为空，已丢弃')
          continue
        }
        if (this.actionList.some(action => action.text === text)) {
          dropped += 1
          issues.push('「' + text + '」重复，已丢弃')
          continue
        }
        if (this.actionList.length >= HARD_MAX_ACTIONS) {
          dropped += 1
          issues.push('超出上限 ' + String(HARD_MAX_ACTIONS) + ' 条，已丢弃「' + text + '」')
          continue
        }
        let id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : ''
        if (id === '' || this.actionList.some(action => action.id === id)) {
          id = 'custom-' + String(this.nextCustomId)
          this.nextCustomId += 1
        }
        this.actionList.push(Object.freeze({ id, text, origin: 'custom' as const }))
      }
      if (dropped > 0 && this.deps.settings.verbose) {
        this.deps.log.warn('呼吸感动作丢弃了 %d 条：%s', dropped, issues.join('；'))
      }
      return Object.freeze({ ok: true, size: this.actionList.length, dropped, issues: Object.freeze(issues) })
    } catch (error) {
      this.deps.log.error('注册呼吸感动作失败：%s', messageOf(error))
      return Object.freeze({
        ok: false,
        size: this.actionList.length,
        dropped,
        issues: Object.freeze([messageOf(error)]),
      })
    }
  }
}
