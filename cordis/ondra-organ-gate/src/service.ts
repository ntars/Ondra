/**
 * O-138 的门控实现：把纯计算（`gate.ts`）接到宿主上，只做三件有副作用的事。
 *
 * 1. **先撤再算。** 每一轮开始，先撤掉自己上一轮加的 `restrict`，再读 `schemas()`。
 *    顺序反了就是一个**不会报错的慢性 bug**：读到的是被自己削过的视图，
 *    于是「该给的」越算越少，某轮只给了两个工具之后再也回不来。
 * 2. **只摘已知的名字。** `restrict()` 对未知工具名抛错，所以名单必须来自
 *    `schemas()` 的返回值；一个拼错的前缀不该让整轮门控炸掉。
 * 3. **留痕可数。** 每次放弃都带原因码，每次命中都记规则 id。
 *    「没省」与「没算」长得一样的时候，任何调参都是蒙。
 *
 * 服务不装定时器、不注册工具、不写提示词——它只在一处出现：`agent/pre-step`。
 */

import type {
  AgentLike,
  GateDecision,
  GateMode,
  GatePlan,
  GateService,
  GateSkipReason,
  GateStats,
  GateUnavailableReason,
  IntentRule,
  LogLike,
  ScopedToolsLike,
  ToolSchemaLike,
} from './types.js'
import { ALWAYS_KEEP, DEFAULT_RULES, auditRules } from './rules.js'
import { planGate } from './gate.js'
import type { PlanInput } from './gate.js'
import { excerptOf } from './intent.js'
import type { Config } from './settings.js'

/** 服务依赖。全部现取，不在构造时快照。 */
export interface GateDeps {
  readonly settings: () => Config
  readonly log: LogLike
  readonly now: () => number
  /** 工具注册表在不在（`ctx.get('tools')`）。 */
  readonly toolsReady: () => boolean
}

/** 单个 agent 的门控状态。 */
interface AgentState {
  /** 上一次决策属于哪一轮。 */
  turn: number
  /** 上一次的决策。同一轮的中途步骤沿用它。 */
  decision?: GateDecision
  /** 撤销自己加的限制。 */
  lift?: () => void
}

/** 摘录长度（码位）。只进报告，不进提示词。 */
const EXCERPT_CHARS = 60

/**
 * 门控服务实现。
 *
 * **永不抛错**：所有对外方法内部 try/catch，失败一律按「不门控」处理。
 * 门控是优化，不是正确性的一部分——它挂了，对话必须照常进行。
 */
export class Gate implements GateService {
  private readonly deps: GateDeps
  private readonly rulesTable: readonly IntentRule[]
  private readonly states = new Map<object, AgentState>()
  /** 新的在前。 */
  private readonly history: GateDecision[] = []
  private readonly byReason: Record<string, number> = {}
  private readonly byRule: Record<string, number> = {}

  private steps = 0
  private planned = 0
  private enforcedCount = 0
  private skippedCount = 0
  private savedChars = 0
  private savedTokens = 0
  private disposed = false

  /**
   * @param deps 依赖。
   * @param rules 规则表（默认用内置表；传别的值便于对拍）。
   */
  constructor(deps: GateDeps, rules: readonly IntentRule[] = DEFAULT_RULES) {
    this.deps = deps
    this.rulesTable = rules
    const problems = auditRules(rules)
    if (problems.length > 0) {
      // 规则表有病与「这轮没命中」是两件事：前者会一直不命中，必须在启动时喊出来。
      deps.log.warn('规则表自检发现 %d 个问题：%s', problems.length, problems.join(' / '))
    }
  }

  get available(): boolean {
    return !this.disposed && this.deps.settings().mode !== 'off' && this.deps.toolsReady()
  }

  get reason(): GateUnavailableReason | undefined {
    if (this.disposed) return 'mode-off'
    if (this.deps.settings().mode === 'off') return 'mode-off'
    if (!this.deps.toolsReady()) return 'no-tools'
    return undefined
  }

  get mode(): GateMode {
    return this.deps.settings().mode
  }

  rules(): readonly IntentRule[] {
    return this.rulesTable
  }

  /**
   * 纯计算入口。不动状态，不加限制。
   * @param text 用户原话。
   * @param tools 工具 schema。
   */
  plan(text: string, tools: readonly ToolSchemaLike[]): GatePlan {
    return planGate(this.planInput(text, tools))
  }

  report(limit?: number): readonly GateDecision[] {
    const cap = limit === undefined ? this.deps.settings().reportLimit : Math.max(1, Math.trunc(limit))
    return Object.freeze(this.history.slice(0, cap))
  }

  last(): GateDecision | undefined {
    return this.history.length === 0 ? undefined : this.history[0]
  }

  stats(): GateStats {
    return Object.freeze({
      at: this.deps.now(),
      mode: this.mode,
      steps: this.steps,
      planned: this.planned,
      enforced: this.enforcedCount,
      skipped: this.skippedCount,
      savedChars: this.savedChars,
      savedTokens: this.savedTokens,
      byReason: Object.freeze({ ...this.byReason }),
      byRule: Object.freeze({ ...this.byRule }),
      agents: this.states.size,
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const state of this.states.values()) {
      this.lift(state, '卸载')
    }
    this.states.clear()
    this.history.length = 0
  }

  /**
   * 一步开始前的门控。**由 `agent/pre-step` 调用，永不抛错。**
   * @param agent 上游 agent。
   * @param turn 第几轮。
   * @param step 第几步。
   * @param text 本轮用户原话（已截断）。
   * @returns 本次决策；`off` 模式或已卸载时返回 undefined。
   */
  before(agent: unknown, turn: number, step: number, text: string): GateDecision | undefined {
    if (this.disposed) return undefined
    const settings = this.deps.settings()
    this.steps += 1
    if (settings.mode === 'off') return undefined
    if (typeof agent !== 'object' || agent === null) return undefined

    const state = this.stateOf(agent)

    // 同一轮的中途步骤：沿用本轮决定。重新算会把「中途没有用户消息」误判成
    // 「意图未知 → 全给」，等于门控只管第一句，后面又全放开。
    if (state.decision !== undefined && state.turn === turn) return state.decision

    this.lift(state, '新一轮重新计算')

    const tools = this.toolsOf(agent)
    if (tools === undefined) {
      return this.record(state, turn, step, text, this.plainSkip('no-scope', '拿不到 agent 作用域的 ctx.tools，本轮不门控'))
    }

    let schemas: readonly ToolSchemaLike[]
    try {
      schemas = tools.schemas(agent)
    } catch (error) {
      return this.record(
        state,
        turn,
        step,
        text,
        this.plainSkip('error', '读 schemas 失败，本轮不门控：' + textOf(error)),
      )
    }

    const plan = planGate(this.planInput(text, schemas))
    this.planned += 1
    for (const id of plan.matched) {
      this.byRule[id] = (this.byRule[id] ?? 0) + 1
    }

    let enforced = false
    if (settings.mode === 'enforce' && plan.applied) {
      try {
        const lift = tools.restrict({ deny: plan.denied })
        state.lift = typeof lift === 'function' ? lift : undefined
        enforced = true
      } catch (error) {
        // 没摘成就不许记成「摘了」：报告里的 applied 必须与真实动作一致。
        const failed: GatePlan = {
          ...plan,
          applied: false,
          skipped: 'error' as GateSkipReason,
          detail: '调 restrict 失败，本轮不门控：' + textOf(error) + '（原计划：' + plan.detail + '）',
        }
        return this.record(state, turn, step, text, failed)
      }
    }

    const decision: GateDecision = Object.freeze({
      ...plan,
      at: this.deps.now(),
      turn,
      step,
      excerpt: excerptOf(text, EXCERPT_CHARS),
      enforced,
    })

    this.remember(state, turn, decision)
    if (decision.applied) {
      this.savedChars += decision.charsBefore - decision.charsAfter
      this.savedTokens += decision.estTokensBefore - decision.estTokensAfter
    }
    if (enforced) this.enforcedCount += 1
    if (decision.skipped !== undefined) {
      this.skippedCount += 1
      this.byReason[decision.skipped] = (this.byReason[decision.skipped] ?? 0) + 1
    }

    if (settings.verbose) {
      this.deps.log.info(
        '第 %d 轮第 %d 步：%s（%s）',
        turn,
        step,
        decision.detail,
        decision.enforced ? '已生效' : decision.applied ? '只观察' : '未门控',
      )
    }
    return decision
  }

  /**
   * 一个 agent 消失了：撤掉它身上的限制并清状态。
   * @param agent 上游 agent。
   */
  forget(agent: unknown): void {
    if (typeof agent !== 'object' || agent === null) return
    const state = this.states.get(agent)
    if (state === undefined) return
    this.lift(state, 'agent 已销毁')
    this.states.delete(agent)
  }

  /**
   * 组装纯计算的入参。
   * @param text 用户原话。
   * @param tools 工具 schema。
   */
  private planInput(text: string, tools: readonly ToolSchemaLike[]): PlanInput {
    const settings = this.deps.settings()
    return {
      text,
      tools,
      rules: this.rulesTable,
      alwaysKeep: mergeKeep(ALWAYS_KEEP, settings.neverDeny),
      mode: settings.mode,
      minToolsToGate: settings.minToolsToGate,
      minKeepTools: settings.minKeepTools,
      maxDenyRatio: settings.maxDenyRatio,
      charsPerToken: settings.charsPerToken,
    }
  }

  /**
   * 取（或建）一个 agent 的状态。
   * @param agent 上游 agent。
   */
  private stateOf(agent: object): AgentState {
    let state = this.states.get(agent)
    if (state === undefined) {
      state = { turn: Number.NaN }
      this.states.set(agent, state)
    }
    return state
  }

  /**
   * 取 agent 作用域里的 `tools`。
   *
   * 必须经 `agent.ctx.tools` 取：上游用 `this.ctx` 判定作用域，
   * `ctx.get('tools')` 拿到的是未绑定的实例，在它上面 `restrict` 会被当成全局限制。
   * @param agent 上游 agent。
   */
  private toolsOf(agent: object): ScopedToolsLike | undefined {
    const scope = (agent as AgentLike).ctx
    if (scope === undefined || scope === null) return undefined
    const tools = scope.tools
    return tools === undefined ? undefined : tools
  }

  /**
   * 撤掉自己加的限制。
   * @param state 状态。
   * @param why 为什么撤（只进日志）。
   */
  private lift(state: AgentState, why: string): void {
    const lift = state.lift
    state.lift = undefined
    if (lift === undefined) return
    try {
      lift()
    } catch (error) {
      // 撤不掉就是「限制还在」，必须说出来：下一轮的计算会基于被削过的视图。
      this.deps.log.warn('撤销上一轮工具限制失败（%s）：%s', why, textOf(error))
    }
  }

  /**
   * 记一条决策。
   * @param state 状态。
   * @param turn 轮次。
   * @param decision 决策。
   */
  private remember(state: AgentState, turn: number, decision: GateDecision): void {
    state.turn = turn
    state.decision = decision
    this.history.unshift(decision)
    const cap = Math.max(1, this.deps.settings().reportLimit)
    while (this.history.length > cap) this.history.pop()
  }

  /**
   * 记一条「没门控」的决策。
   * @param state 状态。
   * @param turn 轮次。
   * @param step 步次。
   * @param text 用户原话。
   * @param plan 放弃计划。
   */
  private record(
    state: AgentState,
    turn: number,
    step: number,
    text: string,
    plan: GatePlan,
  ): GateDecision {
    const decision: GateDecision = Object.freeze({
      ...plan,
      at: this.deps.now(),
      turn,
      step,
      excerpt: excerptOf(text, EXCERPT_CHARS),
      enforced: false,
    })
    this.remember(state, turn, decision)
    this.skippedCount += 1
    this.byReason[plan.skipped ?? 'error'] = (this.byReason[plan.skipped ?? 'error'] ?? 0) + 1
    return decision
  }

  /**
   * 造一个「没有工具视图」的放弃计划。
   * @param reason 原因码。
   * @param detail 一句人话。
   */
  private plainSkip(reason: GateSkipReason, detail: string): GatePlan {
    return Object.freeze({
      matched: Object.freeze([] as string[]),
      families: Object.freeze([] as string[]),
      total: 0,
      kept: Object.freeze([] as string[]),
      denied: Object.freeze([] as string[]),
      charsBefore: 0,
      charsAfter: 0,
      estTokensBefore: 0,
      estTokensAfter: 0,
      applied: false,
      skipped: reason,
      detail,
    })
  }
}

/**
 * 合并两组「不许摘」的名字，去重。
 * @param base 内置保护名单。
 * @param extra 配置追加的名单。
 */
function mergeKeep(base: readonly string[], extra: readonly string[]): readonly string[] {
  const out: string[] = []
  for (const name of base) out.push(name)
  for (const name of extra) {
    if (!out.includes(name)) out.push(name)
  }
  return Object.freeze(out)
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
