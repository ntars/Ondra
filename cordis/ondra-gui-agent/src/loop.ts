/**
 * 单步决策环的**状态机**：预算、限频、票的签发与作废。
 *
 * ## 「单步」不是一句口号，是三个结构约束
 *
 * 1. **一次只判一个动作**：`plan()` 只接一个 `StepRequest`，没有 `steps: []` 这种批量入口。
 *    批量入口一定会被用来「一次规划十步然后连着执行」——那就不是单步了。
 * 2. **票一次即焚**：`take()` 取出即从表里删除。同一张票不可能执行两次；
 *    失败也不退票（退票会让「点一次失败了，再点一次」变成绕过限频的通道）。
 * 3. **票里锁着请求**：批准的是「那一下点击（x, y）」，不是「点击」这个能力。
 *    批准之后调用方换不了目标——换目标必须重新规划、重新拿票。
 *
 * ## 为什么预算与限频在这里，不在 `policy.ts`
 *
 * `policy.ts` 是纯函数，同样的输入永远同样的输出；预算与限频带状态。
 * 两者混在一起，就会出现「同样的请求，面板说可以、执行说超预算」——
 * 而这两句话来自同一个函数，排查时会怀疑是随机数。
 *
 * ## 时钟不给 `dayKey` 时的退路
 *
 * 预算按自然日重置要靠 O-003 的 `dayKey()`。上游若给了精简时钟（只有 `now`），
 * 本包**不自己算自然日**（时区与跨零点会错，§18.5 的教训），
 * 而是把口径退化成「按进程累计」并由 `status().budgetScope` 如实报出去。
 */

import type { Config } from './settings.js'
import type { LogLike, Observation, StepDecision, StepPlan, StepRequest, StepTicket, TicketStatus } from './types.js'
import { decide } from './policy.js'

/** 一张票的内部记录（请求锁在里面，对外不暴露）。 */
export interface TicketRecord {
  /** 票号。 */
  readonly id: string
  /** 动作。 */
  readonly action: StepTicket['action']
  /** 风险。 */
  readonly risk: StepTicket['risk']
  /** 签发时刻。 */
  readonly issuedAt: number
  /** 过期时刻。 */
  readonly expiresAt: number
  /** 被批准的那一条请求（事后不可替换）。 */
  readonly request: StepRequest
  /** 判定时的前台应用（审计要用：批准的是「在谁身上点」）。 */
  readonly app: string
  /** 命中的危险区（没有则不写）。 */
  readonly zone?: string
  /** 当前状态。 */
  status: TicketStatus
}

/** 取票结果。 */
export type TakeResult =
  | { readonly ok: true; readonly record: TicketRecord }
  | { readonly ok: false; readonly code: 'no-ticket' | 'ticket-expired' }

/** 预算视图。 */
export interface BudgetView {
  /** 预算所属的自然日键（`session` 口径时为空串）。 */
  readonly day: string
  /** 已用次数。 */
  readonly used: number
  /** 剩余次数。 */
  readonly left: number
  /** 口径。 */
  readonly scope: 'day' | 'session'
}

/** 状态机依赖。 */
export interface LoopDeps {
  /** 配置。 */
  readonly settings: Config
  /** 现在（毫秒）。 */
  readonly now: () => number
  /** 自然日键；拿不到就返回空串。 */
  readonly dayKey: () => string
  /** 日志。 */
  readonly log: LogLike
}

/**
 * 把判定换一个结论（保留 app / at / risk 之外的原值）。
 * @param base 原判定。
 * @param code 新原因码。
 * @param risk 新风险。
 * @param reason 新说明。
 * @param hint 新指路。
 */
function override(
  base: StepDecision,
  code: StepDecision['code'],
  risk: StepDecision['risk'],
  reason: string,
  hint?: string,
): StepDecision {
  const next: StepDecision = {
    allowed: false,
    risk,
    requiresConfirm: false,
    code,
    reason,
    app: base.app,
    at: base.at,
  }
  return hint === undefined ? next : { ...next, hint }
}

/** 单步决策环。 */
export class StepLoop {
  private readonly deps: LoopDeps
  /** 上一次真实动作的时刻（0 = 还没动过）。 */
  private lastActAt = 0
  /** 当前预算周期内已用次数。 */
  private used = 0
  /** 当前预算周期对应的日键。 */
  private budgetDay = ''
  /** 票号自增。 */
  private seq = 0
  /** 未结票。 */
  private readonly tickets = new Map<string, TicketRecord>()

  constructor(deps: LoopDeps) {
    this.deps = deps
  }

  /**
   * 规划一步（只判定，不动手）。
   * @param request 请求。
   * @param observation 已解析的观察。
   * @param runnerReady 后端就绪没有。
   */
  plan(request: StepRequest, observation: Observation, runnerReady: boolean): StepPlan {
    const now = this.deps.now()
    this.purge(now)

    const decision = decide({ request, observation, now, settings: this.deps.settings, runnerReady })
    if (!decision.allowed) return { decision, ticket: null }

    // 预算：先查，免得发一张注定用不掉的票。
    const budget = this.budget()
    if (budget.left <= 0) {
      return {
        decision: override(
          decision,
          'budget-exhausted',
          'blocked',
          `今天的动作预算（${this.deps.settings.dailyBudget} 次）用完了。`,
          budget.scope === 'day'
            ? '等明天，或把 daily-budget 调大；也可以把这一步交回给用户自己点。'
            : '本次运行的动作预算用完了（时钟没给自然日键，预算只能按进程累计）；重开应用或调大 daily-budget。',
        ),
        ticket: null,
      }
    }

    // 限频只约束「动」，不约束「看」：看一眼不该被节流。
    if (request.action !== 'observe' && this.lastActAt > 0) {
      const wait = this.deps.settings.stepIntervalMs - (now - this.lastActAt)
      if (wait > 0) {
        return {
          decision: override(
            decision,
            'step-cooldown',
            'blocked',
            `距上一次动作不到 ${this.deps.settings.stepIntervalMs} 毫秒，还要等 ${Math.ceil(wait)} 毫秒。`,
            '等一下再规划：连点风暴既容易点错，也最容易被系统当成异常行为。',
          ),
          ticket: null,
        }
      }
    }

    const id = this.nextId(now)
    const status: TicketStatus = decision.requiresConfirm ? 'pending' : 'approved'
    const record: TicketRecord = {
      id,
      action: request.action,
      risk: decision.risk,
      issuedAt: now,
      expiresAt: now + Math.max(1_000, this.deps.settings.confirmTtlMs),
      request,
      app: decision.app,
      ...(decision.zone === undefined ? {} : { zone: decision.zone }),
      status,
    }
    this.tickets.set(id, record)
    if (this.deps.settings.verbose) {
      this.deps.log.info(
        '规划：%s 风险=%s 结论=%s 票=%s（%s）',
        request.action,
        decision.risk,
        decision.code,
        id,
        status === 'pending' ? '待确认' : '可直接执行',
      )
    }
    return { decision, ticket: this.ticketOf(record) }
  }

  /**
   * 批准一张票。
   *
   * **只给宿主/界面调用**：模型侧没有 `approve` 工具，也没有对应的服务暴露在工具表里。
   * @param id 票号。
   */
  approve(id: string): boolean {
    const record = this.tickets.get(id)
    if (record === undefined) return false
    if (record.expiresAt <= this.deps.now()) {
      this.tickets.delete(id)
      return false
    }
    if (record.status === 'approved') return true
    record.status = 'approved'
    return true
  }

  /**
   * 否决一张票（直接销毁）。
   * @param id 票号。
   */
  deny(id: string): boolean {
    return this.tickets.delete(id)
  }

  /**
   * 取票并销毁（一次即焚）。过期的票也一并销毁。
   * @param id 票号。
   */
  take(id: string): TakeResult {
    const record = this.tickets.get(id)
    if (record === undefined) return { ok: false, code: 'no-ticket' }
    this.tickets.delete(id)
    if (record.expiresAt <= this.deps.now()) return { ok: false, code: 'ticket-expired' }
    return { ok: true, record }
  }

  /**
   * 看一眼票（不销毁）。用于面板显示与幂等判断。
   * @param id 票号。
   */
  peek(id: string): StepTicket | undefined {
    const record = this.tickets.get(id)
    if (record === undefined) return undefined
    return this.ticketOf(record)
  }

  /**
   * 记一次真实动作（推进限频与预算）。
   * @param at 动作时刻。
   */
  noteAct(at: number): void {
    this.lastActAt = at
    this.used += 1
  }

  /**
   * 距下一次可动作还要等多少毫秒（0 = 现在就能动）。
   *
   * `plan()` 与 `act()` 都查这一个函数：从拿到票到真正执行之间可能已经过去几秒，
   * 中间若又发生过一次动作，执行前必须再挡一次——否则「规划→等确认→执行」
   * 这条长路径就成了绕过限频的通道。
   */
  cooldownLeft(): number {
    if (this.lastActAt <= 0) return 0
    const left = this.deps.settings.stepIntervalMs - (this.deps.now() - this.lastActAt)
    return left > 0 ? left : 0
  }

  /**
   * 当前预算。
   */
  budget(): BudgetView {
    const day = this.deps.dayKey()
    const scope: 'day' | 'session' = day === '' ? 'session' : 'day'
    if (scope === 'day' && day !== this.budgetDay) {
      this.budgetDay = day
      this.used = 0
    }
    const left = Math.max(0, this.deps.settings.dailyBudget - this.used)
    return { day: scope === 'day' ? day : '', used: this.used, left, scope }
  }

  /** 待确认票数（已过期的先清掉）。 */
  pending(): number {
    this.purge(this.deps.now())
    let count = 0
    for (const record of this.tickets.values()) {
      if (record.status === 'pending') count += 1
    }
    return count
  }

  /** 清掉过期票，返回清掉的条数。 */
  purge(now: number): number {
    let removed = 0
    for (const [id, record] of this.tickets) {
      if (record.expiresAt <= now) {
        this.tickets.delete(id)
        removed += 1
      }
    }
    return removed
  }

  /**
   * 内部记录 → 对外票形状。
   * @param record 内部记录。
   */
  private ticketOf(record: TicketRecord): StepTicket {
    return {
      id: record.id,
      action: record.action,
      risk: record.risk,
      status: record.status,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
    }
  }

  /**
   * 生成票号。同一毫秒内连开两张也不会撞（自增序号打头）。
   * @param now 现在。
   */
  private nextId(now: number): string {
    this.seq += 1
    return `g${this.seq.toString(36)}-${now.toString(36)}`
  }
}
