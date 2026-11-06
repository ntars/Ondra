/**
 * 门面：把判定、票据、执行、审计串成**一条单步通道**。
 *
 * ## 这一层唯一的职责是「不让任何一步绕过另一个」
 *
 * 单独看每个部件都是对的：`policy` 判风险、`loop` 发票与限频、`audit` 记账、
 * `runner` 干活。但只要有第二个入口（比如工具处理器自己调 `runner.act`），
 * 六道闸门里总有一两道会被绕过，而且**不会有任何报错**。
 *
 * 所以本层把所有路径收成两条：
 *
 * ```
 * plan()  → 只判定（可被否决）        ← 工具、界面、L3 都走这条
 * act()   → 只执行已有票（一次即焚）  ← 只有已批准或免确认的票能过
 * ```
 *
 * 工具处理器就是「plan → 需要票就交票 / 不需要就立刻 act」这个固定句式，
 * 没有别的写法。
 *
 * ## 为什么 `approve()` 不在工具表里
 *
 * 三档审批的意义是「人点头」。如果模型能自己调 `approve`，
 * 那道闸门就退化成一次自问自答——而日志里会写着「已确认」，
 * 排查时完全看不出问题（纪律 31：防绕过的判定不能带一个可被写入方控制的字段）。
 * 本包因此**不提供 `gui-approve` 工具**，`approve()` 只在服务对象上，
 * 由宿主/界面在用户点击后调用。
 *
 * ## 一条容易被忽略的计数口径
 *
 * 失败的动作**也计入预算**。否则「点失败→重试」就是一条绕过每日预算的免费通道，
 * 而失败往往比成功更密集（坐标不对时它会一直失败）。
 */

import { AuditTrail } from './audit.js'
import { StepLoop } from './loop.js'
import { describeObservation, normalizeObservation } from './observe.js'
import { quantize } from './policy.js'
import { NoRunner, runnerReady } from './runner.js'
import { descriptorOf, keyOfArgs, pointOfArgs, textOfArgs, toolKeyOf } from './tools.js'
import type { AuditDraft } from './audit.js'
import type { Config } from './settings.js'
import {
  COORD_GRID,
  OBSERVE_TIMEOUT_MS,
  ACT_TIMEOUT_MS,
  TIMEOUT_CEIL,
  TIMEOUT_FLOOR,
  TOOL_NAMES,
} from './types.js'
import type {
  ActCode,
  ActResult,
  ActionKind,
  AuditEntry,
  AuditSink,
  ClockLike,
  GuiReason,
  GuiService,
  GuiStats,
  GuiStatus,
  GuiRunner,
  LogLike,
  Observation,
  ObserveResult,
  PathLike,
  RunnerResult,
  StepDecision,
  StepPlan,
  StepRequest,
  ToolDescriptor,
  ToolRegistrar,
  ToolResult,
} from './types.js'

/** 计数的可变形状（接口上的字段是只读的，这里做一次映射，字段名一字不改）。 */
type MutableStats = { -readonly [K in keyof GuiStats]: number }

/**
 * 全零计数。
 */
function zeroStats(): MutableStats {
  return {
    plans: 0,
    blocked: 0,
    confirmations: 0,
    approved: 0,
    rejected: 0,
    acts: 0,
    ok: 0,
    failed: 0,
    timeouts: 0,
    noRunner: 0,
    observed: 0,
    observeFailed: 0,
    throttled: 0,
    budgetHit: 0,
    auditFailed: 0,
  }
}

/** 门面依赖。 */
export interface GuiAgentDeps {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 现在（毫秒）。 */
  readonly now: () => number
  /** 自然日键；拿不到返回空串。 */
  readonly dayKey: () => string
  /** 路径服务（审计落盘用）。 */
  readonly path: () => PathLike | undefined
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 夹一次超时。
 * @param value 调用方给的值。
 * @param fallback 配置里的默认值。
 */
function clampTimeout(value: number | undefined, fallback: number): number {
  const base = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(TIMEOUT_CEIL, Math.max(TIMEOUT_FLOOR, base))
}

/** 出厂超时（毫秒）。字段名与 `Config` 一致，值取 `types.js` 的出厂常量。 */
export const DEFAULT_TIMEOUTS = Object.freeze({
  observeTimeoutMs: OBSERVE_TIMEOUT_MS,
  actTimeoutMs: ACT_TIMEOUT_MS,
})

/**
 * 带超时地等一个**不会 reject** 的后端结果。
 *
 * 后端实现被要求「不抛错」，但外部实现总会抛。这里先把它折成 `RunnerResult`，
 * 再和定时器赛跑：赛输的那一方仍然会被接住（`settled` 已有 catch），
 * 不会产生 unhandledRejection（O-060 踩过的坑）。
 * @param work 后端调用。
 * @param ms 超时。
 * @returns 结果；超时返回 `null`。
 */
async function runWithTimeout<T>(work: Promise<RunnerResult<T>>, ms: number): Promise<RunnerResult<T> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled: Promise<RunnerResult<T>> = work.catch(
    (error: unknown): RunnerResult<T> => ({ ok: false, reason: 'failed', detail: textOf(error) }),
  )
  const guard = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    const winner = await Promise.race([settled, guard])
    return winner
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 「没有观察」时的判定。
 * @param now 现在。
 * @param action 动作。
 */
function noObservationDecision(now: number, action: ActionKind): StepDecision {
  return {
    allowed: false,
    risk: 'blocked',
    requiresConfirm: false,
    code: 'no-observation',
    reason: `想${action === 'observe' ? '观察' : '操作'}，但还没有看过屏幕：没有坐标就没有可判定的东西。`,
    hint: '先调一次 gui-observe：它会给屏幕尺寸、前台应用与表单状态。',
    app: 'unknown',
    at: now,
  }
}

/** 图形界面操作服务。 */
export class GuiAgentService implements GuiService {
  private readonly deps: GuiAgentDeps
  private readonly loop: StepLoop
  private readonly auditTrail: AuditTrail
  private runner: GuiRunner
  private disposers: readonly (() => void)[] = Object.freeze([] as readonly (() => void)[])
  private last: Observation | null = null
  private readonly counters: MutableStats = zeroStats()

  constructor(deps: GuiAgentDeps) {
    this.deps = deps
    this.loop = new StepLoop({
      settings: deps.settings,
      now: deps.now,
      dayKey: deps.dayKey,
      log: deps.log,
    })
    this.auditTrail = new AuditTrail({
      keep: deps.settings.auditKeep,
      fileEnabled: deps.settings.auditFile,
      path: deps.path,
      log: deps.log,
    })
    this.runner = new NoRunner()
  }

  /** 开关开着没有。 */
  get available(): boolean {
    return this.deps.settings.enable
  }

  /** 不能用的原因。 */
  get reason(): GuiReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    return this.ready ? undefined : 'no-runner'
  }

  /** 后端就绪没有。 */
  get ready(): boolean {
    return runnerReady(this.runner)
  }

  /** 开着的工具描述。 */
  descriptors(): readonly ToolDescriptor[] {
    return Object.freeze(this.deps.settings.enabledTools.map(key => descriptorOf(key, this.deps.settings)))
  }

  /**
   * 调一个工具。**永不抛错**。
   * @param tool 工具名。
   * @param args 参数。
   */
  async invoke(tool: string, args?: unknown): Promise<ToolResult> {
    const key = toolKeyOf(tool)
    if (key === undefined) {
      return {
        ok: false,
        tool,
        code: 'bad-arg',
        text: `没有这个工具：${tool}`,
        detail: '工具名不认识。',
        hint: `可用的是 ${Object.values(TOOL_NAMES).join(' / ')}。`,
      }
    }
    if (!this.deps.settings.enabledTools.includes(key)) {
      return {
        ok: false,
        tool,
        code: 'disabled',
        text: `${tool} 没有打开。`,
        detail: '这个能力在 enabled-tools 里没开。',
        hint: '要开就在配置的 enabled-tools 里加上它；出厂只开了 observe。',
      }
    }
    try {
      return await this.runTool(key, tool, args)
    } catch (error) {
      this.counters.failed += 1
      return {
        ok: false,
        tool,
        code: 'failed',
        text: '这一步没有做成。',
        detail: textOf(error),
      }
    }
  }

  /**
   * 看一眼。
   * @param timeoutMs 超时（可选）。
   */
  async observe(timeoutMs?: number): Promise<ObserveResult> {
    const started = this.deps.now()
    if (!this.deps.settings.enable) {
      return {
        ok: false,
        observation: null,
        detail: '图形界面自动化是关着的。',
        hint: '打开 enable 之后会先只允许观察。',
        elapsedMs: 0,
      }
    }
    if (!this.ready) {
      this.counters.noRunner += 1
      return {
        ok: false,
        observation: null,
        detail: '没有可用的后端，看不到屏幕。',
        hint: '装一个实现 GuiRunner 的端口并 useRunner() 接进来。',
        elapsedMs: this.deps.now() - started,
      }
    }
    const ms = clampTimeout(timeoutMs, this.deps.settings.observeTimeoutMs)
    const result = await runWithTimeout(this.runner.observe(ms), ms)
    const elapsed = this.deps.now() - started
    if (result === null) {
      this.counters.timeouts += 1
      this.counters.observeFailed += 1
      return {
        ok: false,
        observation: null,
        detail: `后端在 ${ms} 毫秒内没有返回画面。`,
        hint: '检查屏幕录制权限；未授权时截屏会卡住而不是报错。',
        elapsedMs: elapsed,
      }
    }
    if (!result.ok) {
      this.counters.observeFailed += 1
      return {
        ok: false,
        observation: null,
        detail: result.detail,
        hint: result.reason === 'no-runner' ? '装一个实现 GuiRunner 的端口并 useRunner() 接进来。' : undefined,
        elapsedMs: elapsed,
      }
    }
    const observation = normalizeObservation(result.data, started)
    if (observation === null) {
      this.counters.observeFailed += 1
      return {
        ok: false,
        observation: null,
        detail: '后端给了画面，但缺少可用的屏幕尺寸，坐标无从换算。',
        hint: '让后端补上 screen.width / screen.height（必须都是正数）。',
        elapsedMs: elapsed,
      }
    }
    this.last = observation
    this.counters.observed += 1
    const draft: AuditDraft = {
      at: observation.at,
      action: 'observe',
      risk: 'readonly',
      code: 'ok',
      app: observation.foreground.app,
      elapsedMs: elapsed,
      ...(observation.screenshotBytes === undefined ? {} : { bytes: observation.screenshotBytes }),
    }
    this.auditTrail.record(draft)
    return {
      ok: true,
      observation,
      detail: `看到 ${observation.foreground.app}（${observation.screen.width}×${observation.screen.height}）。`,
      elapsedMs: elapsed,
    }
  }

  /**
   * 规划一步（只判定）。
   * @param request 请求。
   */
  plan(request: StepRequest): StepPlan {
    this.counters.plans += 1
    const observation = request.observation ?? this.last
    if (observation === null) {
      this.counters.blocked += 1
      return { decision: noObservationDecision(this.deps.now(), request.action), ticket: null }
    }
    const plan = this.loop.plan(request, observation, this.ready)
    if (!plan.decision.allowed) {
      this.counters.blocked += 1
      if (plan.decision.code === 'step-cooldown') this.counters.throttled += 1
      if (plan.decision.code === 'budget-exhausted') this.counters.budgetHit += 1
    } else if (plan.decision.requiresConfirm) {
      this.counters.confirmations += 1
    }
    if (this.deps.settings.verbose) {
      this.deps.log.info(
        '判定：%s → %s（风险 %s）',
        request.action,
        plan.decision.code,
        plan.decision.risk,
      )
    }
    return plan
  }

  /**
   * 批准一张票（**只给宿主/界面**）。
   * @param ticketId 票号。
   */
  approve(ticketId: string): boolean {
    const before = this.loop.peek(ticketId)
    const ok = this.loop.approve(ticketId)
    if (ok && before !== undefined && before.status === 'pending') this.counters.approved += 1
    return ok
  }

  /**
   * 否决一张票。
   * @param ticketId 票号。
   */
  deny(ticketId: string): boolean {
    const ok = this.loop.deny(ticketId)
    if (ok) this.counters.rejected += 1
    return ok
  }

  /**
   * 执行一张票（**一次即焚**）。
   * @param ticketId 票号。
   */
  async act(ticketId: string): Promise<ActResult> {
    const started = this.deps.now()
    const taken = this.loop.take(ticketId)
    if (!taken.ok) {
      this.counters.failed += 1
      return {
        ok: false,
        code: taken.code === 'ticket-expired' ? 'ticket-expired' : 'no-ticket',
        detail:
          taken.code === 'ticket-expired'
            ? '这张票已经过期了。'
            : '没有这张票（可能已经用过一次，或根本没签发过）。',
        hint: '重新规划一步拿新票：每张票只能用一次，失败也不退。',
        elapsedMs: this.deps.now() - started,
        auditId: '',
      }
    }

    const record = taken.record
    if (record.status !== 'approved') {
      this.counters.failed += 1
      return {
        ok: false,
        action: record.action,
        code: 'not-approved',
        detail: '这张票还在等用户确认，不能执行。',
        hint: '把票号交给界面，等用户点头；模型没有批准通道。',
        elapsedMs: this.deps.now() - started,
        auditId: '',
      }
    }

    const budget = this.loop.budget()
    if (budget.left <= 0) {
      this.counters.budgetHit += 1
      this.counters.failed += 1
      return {
        ok: false,
        action: record.action,
        code: 'budget-exhausted',
        detail: '今天的动作预算用完了。',
        hint: '等明天或调大 daily-budget；也可以把这一步交回给用户自己点。',
        elapsedMs: this.deps.now() - started,
        auditId: '',
      }
    }

    const wait = this.loop.cooldownLeft()
    if (wait > 0) {
      this.counters.throttled += 1
      this.counters.failed += 1
      return {
        ok: false,
        action: record.action,
        code: 'cooldown',
        detail: `距上一次动作太近，还要等 ${Math.ceil(wait)} 毫秒。`,
        hint: '等一下再规划：连点风暴最容易点错。',
        elapsedMs: this.deps.now() - started,
        auditId: '',
      }
    }

    if (!this.ready) {
      this.counters.noRunner += 1
      this.counters.failed += 1
      return {
        ok: false,
        action: record.action,
        code: 'no-runner',
        detail: '后端已经不在位了。',
        hint: '装一个实现 GuiRunner 的端口并 useRunner() 接进来。',
        elapsedMs: this.deps.now() - started,
        auditId: '',
      }
    }

    const request = record.request
    const result = await runWithTimeout(
      this.runner.act(
        {
          action: record.action,
          ...(request.point === undefined ? {} : { point: request.point }),
          ...(request.text === undefined ? {} : { text: request.text }),
          ...(request.key === undefined ? {} : { key: request.key }),
        },
        this.deps.settings.actTimeoutMs,
      ),
      this.deps.settings.actTimeoutMs,
    )

    const at = this.deps.now()
    const elapsed = at - started
    // 失败也记：预算与限频保护的是「这台机器被敲了多少下」，不是「成了几下」。
    this.loop.noteAct(at)
    this.counters.acts += 1

    let ok = false
    let code: ActCode = 'ok'
    let detail = ''
    let hint: string | undefined
    if (result === null) {
      code = 'timeout'
      detail = `后端在 ${this.deps.settings.actTimeoutMs} 毫秒内没有回应。`
      hint = '先 observe 一次确认权限与画面；连续超时就把这一步交回给用户。'
      this.counters.timeouts += 1
      this.counters.failed += 1
    } else if (!result.ok) {
      code = result.reason === 'no-runner' ? 'no-runner' : 'failed'
      detail = result.detail
      hint = '这一步没有生效；换一种方式（比如让用户自己点）比反复重试安全。'
      this.counters.failed += 1
      if (code === 'no-runner') this.counters.noRunner += 1
    } else {
      ok = true
      detail = result.data.detail
      this.counters.ok += 1
    }

    const draft: AuditDraft = {
      at,
      action: record.action,
      risk: record.risk,
      code,
      app: record.app,
      elapsedMs: elapsed,
      ...(record.zone === undefined ? {} : { zone: record.zone }),
      ...(request.point === undefined ? {} : { point: quantize(request.point, COORD_GRID) }),
      ...(request.text === undefined ? {} : { textChars: request.text.length }),
      ...(request.key === undefined ? {} : { key: request.key }),
    }
    const auditId = this.auditTrail.record(draft)
    if (this.auditTrail.counters().failed > this.counters.auditFailed) {
      this.counters.auditFailed = this.auditTrail.counters().failed
    }

    const out: ActResult = {
      ok,
      action: record.action,
      code,
      detail,
      ...(hint === undefined ? {} : { hint }),
      elapsedMs: elapsed,
      auditId,
    }
    return out
  }

  /** 最近一次观察。 */
  lastObservation(): Observation | null {
    return this.last
  }

  /**
   * 审计（倒序）。
   * @param limit 条数。
   */
  audit(limit?: number): readonly AuditEntry[] {
    return this.auditTrail.list(limit)
  }

  /**
   * 换后端。
   * @param runner 后端或 `null`（`null` 会装回 `NoRunner`）。
   */
  useRunner(runner: GuiRunner | null): void {
    this.runner = runner === null ? new NoRunner() : runner
  }

  /**
   * 换注册器（`null` 会撤掉已注册的全部工具）。
   * @param registrar 注册器或 `null`。
   */
  useRegistrar(registrar: ToolRegistrar | null): void {
    this.disposeTools()
    if (registrar === null) return
    const registered: (() => void)[] = []
    for (const key of this.deps.settings.enabledTools) {
      try {
        registered.push(
          registrar(descriptorOf(key, this.deps.settings), args => this.invoke(TOOL_NAMES[key], args)),
        )
      } catch (error) {
        this.deps.log.warn('注册工具 %s 失败：%s', TOOL_NAMES[key], textOf(error))
      }
    }
    this.disposers = Object.freeze(registered)
  }

  /**
   * 换审计出口。
   * @param sink 端口或 `null`。
   */
  useAuditSink(sink: AuditSink | null): void {
    this.auditTrail.useSink(sink)
  }

  /** 现状。 */
  status(): GuiStatus {
    const budget = this.loop.budget()
    const audit = this.auditTrail.counters()
    const reason = this.reason
    return {
      enabled: this.deps.settings.enable,
      available: this.deps.settings.enable && this.ready,
      ready: this.ready,
      ...(reason === undefined ? {} : { reason }),
      runner: this.runner.id,
      apps: this.deps.settings.appAllowList,
      zones: this.deps.settings.dangerZones.map(zone => zone.id),
      tools: this.deps.settings.enabledTools,
      pending: this.loop.pending(),
      budgetLeft: budget.left,
      budgetScope: budget.scope,
      audit: audit.mode,
    }
  }

  /** 计数。 */
  stats(): GuiStats {
    return { ...this.counters }
  }

  /**
   * 撤掉全部已注册工具（幂等）。
   */
  dispose(): void {
    this.disposeTools()
  }

  /**
   * 按能力键分派工具。
   * @param key 能力键。
   * @param tool 工具名。
   * @param args 参数。
   */
  private async runTool(key: keyof typeof TOOL_NAMES, tool: string, args: unknown): Promise<ToolResult> {
    if (key === 'observe') {
      const result = await this.observe()
      if (!result.ok || result.observation === null) {
        return {
          ok: false,
          tool,
          code: 'failed',
          text: result.detail,
          detail: result.detail,
          ...(result.hint === undefined ? {} : { hint: result.hint }),
        }
      }
      return {
        ok: true,
        tool,
        code: 'ok',
        text: describeObservation(result.observation),
        detail: result.detail,
      }
    }

    let request: StepRequest
    if (key === 'click') {
      const point = pointOfArgs(args)
      if (point === undefined) {
        return {
          ok: false,
          tool,
          code: 'bad-arg',
          text: '缺坐标。',
          detail: 'x / y 必须是数字。',
          hint: '先 gui-observe 拿到屏幕尺寸，再按截图里的位置给 x、y。',
        }
      }
      request = { action: 'click', point }
    } else if (key === 'type') {
      const text = textOfArgs(args)
      if (text === undefined) {
        return {
          ok: false,
          tool,
          code: 'bad-arg',
          text: '缺文本。',
          detail: 'text 必须是字符串。',
          hint: '输入框得先被选中（可以先 gui-click 一次），本工具不会替你点。',
        }
      }
      request = { action: 'type', text }
    } else {
      const name = keyOfArgs(args)
      if (name === undefined) {
        return {
          ok: false,
          tool,
          code: 'bad-arg',
          text: '缺键名。',
          detail: 'key 必须是字符串。',
          hint: '键名例如 enter / escape / tab / cmd-s。',
        }
      }
      request = { action: 'key', key: name }
    }

    const plan = this.plan(request)
    if (!plan.decision.allowed || plan.ticket === null) {
      return {
        ok: false,
        tool,
        code: plan.decision.code,
        text: plan.decision.reason,
        detail: plan.decision.reason,
        ...(plan.decision.hint === undefined ? {} : { hint: plan.decision.hint }),
      }
    }
    if (plan.decision.requiresConfirm) {
      return {
        ok: false,
        tool,
        code: 'need-confirm',
        text: `这一步需要用户确认，已生成确认票 ${plan.ticket.id}，**还没有执行**。`,
        detail: plan.decision.reason,
        hint: '把票号交给界面等用户点头；确认后由界面调用 act，你不要重复请求同一动作。',
        ticket: plan.ticket.id,
      }
    }

    const result = await this.act(plan.ticket.id)
    return {
      ok: result.ok,
      tool,
      code: result.code,
      text: result.ok ? `已执行（${result.elapsedMs} 毫秒）。` : `没有执行：${result.detail}`,
      detail: result.detail,
      ...(result.hint === undefined ? {} : { hint: result.hint }),
      auditId: result.auditId,
    }
  }

  /**
   * 撤掉已注册的工具（幂等）。
   */
  private disposeTools(): void {
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        // 撤除失败不影响后续：注册器自己会处理重复撤除。
      }
    }
    this.disposers = Object.freeze([] as readonly (() => void)[])
  }
}

/** 供入口复用：把「时钟缺失」收成取值函数。 */
export function clockAccess(ctxClock: ClockLike | undefined): { now: () => number; dayKey: () => string } {
  const now = (): number => (ctxClock === undefined ? Date.now() : ctxClock.now())
  const dayKey = (): string => {
    if (ctxClock === undefined) return ''
    const fn = ctxClock.dayKey
    if (typeof fn !== 'function') return ''
    try {
      return fn.call(ctxClock)
    } catch {
      return ''
    }
  }
  return { now, dayKey }
}
