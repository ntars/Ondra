/**
 * 反射弧与链路结晶 —— **全部零模型调用**。
 *
 * ## 两条学习通道，各自只有一句话
 *
 * 1. **反射**：同一个工具因为同一个原因失败到第 3 次，就写一条
 *    `R-auto-<cause>-<tool>`。它不执行任何动作（本包没有执行权），
 *    它只是一个**记录在案的事实**：这条路走不通，而且是这个原因。
 * 2. **结晶**：跨器官（至少两个不同工具）的 ≥3 步成功链，重复 2 次，
 *    记成一条 skill 候选。它也不执行，只是把「原来可以这么走」留下。
 *
 * ## 为什么「没有归因」不能当成 `unknown`
 *
 * 八类里确实有 `unknown`，但那是**归因器判过之后的结论**。O-139 缺席时本包
 * 什么都不知道，写一条 `R-auto-unknown-xxx` 就是把「我不知道」当成「原因不明」记下来，
 * 而这条假规则会一直留在账上，将来所有消费方都把它当成一条真病因。
 * 所以走 `unclassified` 计数并收手。
 *
 * ## 为什么本包不喂器官宿主
 *
 * `onToolResult` 的喂食者是 O-139，且**只有一个**（见 O-139 README 的已知限制 7）。
 * 本包只是同一个事件上的第二个**观察者**，读同样的结果、记自己的账，不碰器官。
 * 两个观察者同时读一份冻结的结果是安全的；两个喂食者就不安全了。
 */

import { ChainTracker } from './chain.js'
import { Crystallizer } from './skill.js'
import type { CrystallizeOptions } from './skill.js'
import { keyIsPlain, reflexIdOf, reflexKeyOf } from './naming.js'
import { ReflexStore } from './store.js'
import type { Config } from './settings.js'
import type {
  AttribLike,
  ChainSummary,
  LogLike,
  ReflexReason,
  ReflexRule,
  ReflexService,
  ReflexStats,
  SkillCandidate,
  StorePortLike,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js'

/** 依赖注入：全部现取，不在构造时快照。 */
export interface ReflexDeps {
  settings(): Config
  log: LogLike
  now(): number
  /** O-139；缺席即 `available=false`。 */
  attrib(): AttribLike | undefined
  /** 存储端口（可能缺席，也可能没打开）。 */
  store(): StorePortLike | undefined
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
 * 判一个值是不是普通对象。
 * @param value 任意值。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析一段 JSON；坏了解析不出来就返回 undefined（计入 `badRows`，不抛）。
 * @param text JSON 文本。
 */
function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 把一行 JSON 读成反射规则。字段不全就返回 undefined——**不补默认值**：
 * 补出来的 `hits: 0` 会让一条已经成立的规则看起来还没到门槛。
 * @param value 解析后的对象。
 */
function asRule(value: Record<string, unknown>): ReflexRule | undefined {
  const id = value['id']
  const key = value['key']
  const keySafe = value['keySafe']
  const cause = value['cause']
  const tool = value['tool']
  const hits = value['hits']
  const firstAt = value['firstAt']
  const lastAt = value['lastAt']
  const hint = value['hint']
  const hintSource = value['hintSource']
  if (typeof id !== 'string' || typeof key !== 'string' || typeof keySafe !== 'boolean') return undefined
  if (typeof cause !== 'string' || typeof tool !== 'string') return undefined
  if (typeof hits !== 'number' || typeof firstAt !== 'number' || typeof lastAt !== 'number') return undefined
  if (typeof hint !== 'string') return undefined
  if (hintSource !== 'attrib' && hintSource !== 'none') return undefined
  return { id, key, keySafe, cause, tool, hits, firstAt, lastAt, hint, hintSource }
}

/**
 * 把一行 JSON 读成候选。
 * @param value 解析后的对象。
 */
function asCandidate(value: Record<string, unknown>): SkillCandidate | undefined {
  const slug = value['slug']
  const signature = value['signature']
  const steps = value['steps']
  const repeats = value['repeats']
  const organs = value['organs']
  const firstAt = value['firstAt']
  const lastAt = value['lastAt']
  if (typeof slug !== 'string' || typeof signature !== 'string') return undefined
  if (!Array.isArray(steps) || steps.some(step => typeof step !== 'string')) return undefined
  if (typeof repeats !== 'number' || typeof organs !== 'number') return undefined
  if (typeof firstAt !== 'number' || typeof lastAt !== 'number') return undefined
  return {
    slug,
    signature,
    steps: Object.freeze(steps as string[]),
    repeats,
    organs,
    firstAt,
    lastAt,
  }
}

/** 反射服务。 */
export class Reflex implements ReflexService {
  private readonly chains = new ChainTracker()
  private readonly crystallizer = new Crystallizer()
  // 反射表实例。与方法 rules() 同名会冲突，故取别名。
  private readonly table = new Map<string, ReflexRule>()
  private readonly counts = new Map<string, number>()
  private readonly stores = new WeakMap<StorePortLike, ReflexStore>()
  private hydrated = false

  private results = 0
  private successes = 0
  private failures = 0
  private unnamed = 0
  private unclassified = 0
  private unshaped = 0
  private formed = 0
  private refusedRules = 0
  private chainCount = 0
  private shortChains = 0
  private singleOrgan = 0
  private firstSight = 0
  private candidateFormed = 0
  private candidateRefused = 0
  private orphanSteps = 0
  private storeErrors = 0
  private badRows = 0

  /**
   * @param deps 依赖。
   */
  constructor(private readonly deps: ReflexDeps) {}

  /** 不可用原因。 */
  get reason(): ReflexReason | undefined {
    if (!this.deps.settings().enable) return 'disabled'
    const attrib = this.deps.attrib()
    if (attrib === undefined || !attrib.available) return 'no-attrib'
    return undefined
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.reason === undefined
  }

  /**
   * 取落盘适配器。`persist` 关掉或后端不可用就返回 undefined。
   */
  private adapter(): ReflexStore | undefined {
    if (!this.deps.settings().persist) return undefined
    const port = this.deps.store()
    if (port === undefined || port.state !== 'open') return undefined
    const cached = this.stores.get(port)
    if (cached !== undefined) return cached
    const created = new ReflexStore(port)
    this.stores.set(port, created)
    return created
  }

  /** 懒加载：把库里已有的反射与候选读回来，好让计数接着走。 */
  private ensureHydrated(): void {
    if (this.hydrated) return
    this.hydrated = true
    const store = this.adapter()
    if (store === undefined) return
    try {
      for (const row of store.rows()) {
        const parsed = parseJson(row.payload)
        if (parsed === undefined) {
          this.badRows += 1
          continue
        }
        if (row.kind === 'rule') {
          const rule = asRule(parsed)
          if (rule === undefined) {
            this.badRows += 1
            continue
          }
          this.table.set(rule.key, rule)
          this.counts.set(rule.key, rule.hits)
          continue
        }
        if (row.kind === 'chain') {
          const candidate = asCandidate(parsed)
          if (candidate === undefined) {
            this.badRows += 1
            continue
          }
          this.crystallizer.restore(candidate)
        }
      }
    } catch (error) {
      this.deps.log.warn('读取反射账本失败（按空账本继续）：%s', textOf(error))
    }
  }

  /**
   * 结晶门槛（每次现算，配置改了立刻生效）。
   */
  private crystallizeOptions(): CrystallizeOptions {
    const settings = this.deps.settings()
    return {
      minSteps: settings.chainMinSteps,
      minTools: settings.chainMinTools,
      minRepeats: settings.chainRepeats,
      signatureSteps: settings.signatureSteps,
      maxCandidates: settings.maxCandidates,
    }
  }

  /**
   * 从 O-139 取处方文字。取不到就留空——**处方不是本包该编的东西**。
   * @param attrib 归因服务。
   * @param cause 归因。
   */
  private hintOf(attrib: AttribLike, cause: string): { readonly text: string; readonly source: 'attrib' | 'none' } {
    try {
      const prescription = attrib.prescription(cause)
      if (prescription !== undefined && prescription.hint !== '') {
        return { text: prescription.hint, source: 'attrib' }
      }
    } catch (error) {
      this.deps.log.warn('取处方失败（反射照写，处方留空）：%s', textOf(error))
    }
    return { text: '', source: 'none' }
  }

  /**
   * 记一次（工具×因）失败，够了就写反射。
   * @param tool 工具名。
   * @param cause 归因。
   * @param at 时刻。
   */
  private countReflex(tool: string, cause: string, at: number): void {
    const settings = this.deps.settings()
    const attrib = this.deps.attrib()
    const key = reflexKeyOf(cause, tool)
    const hits = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, hits)

    const existing = this.table.get(key)
    if (existing !== undefined) {
      // 上一次成型时 O-139 可能还没装载，处方留空；这次补上（只补空，不覆盖已有文字）。
      let hint = existing.hint
      let hintSource = existing.hintSource
      if (hint === '' && attrib !== undefined) {
        const fresh = this.hintOf(attrib, cause)
        if (fresh.source === 'attrib') {
          hint = fresh.text
          hintSource = fresh.source
        }
      }
      const updated: ReflexRule = { ...existing, hits, lastAt: at, hint, hintSource }
      this.table.set(key, updated)
      this.persist('rule', key, updated, at)
      return
    }
    if (hits < settings.reflexThreshold) return

    if (this.table.size >= settings.maxReflexes) {
      // 满了就拒收新规则并计数：淘汰旧规则会让一条长期有效的反射悄悄消失。
      this.refusedRules += 1
      this.deps.log.warn('反射账本已满（%d 条），不再写新规则：%s', settings.maxReflexes, key)
      return
    }

    const id = reflexIdOf(cause, tool)
    const hint = attrib === undefined ? { text: '', source: 'none' as const } : this.hintOf(attrib, cause)
    const rule: ReflexRule = {
      id,
      key,
      keySafe: keyIsPlain(id, key),
      cause,
      tool,
      hits,
      firstAt: at,
      lastAt: at,
      hint: hint.text,
      hintSource: hint.source,
    }
    this.table.set(key, rule)
    this.formed += 1
    this.persist('rule', key, rule, at)
    if (settings.verbose) {
      this.deps.log.info('写出反射 %s（同工具×同因第 %d 次）', id, hits)
    }
  }

  /**
   * 结算一条走完的链。
   * @param summary 链快照。
   */
  private settle(summary: ChainSummary): void {
    this.chainCount += 1
    const outcome = this.crystallizer.add(summary, this.crystallizeOptions())
    if (outcome.verdict === 'short') {
      this.shortChains += 1
      return
    }
    if (outcome.verdict === 'single-organ') {
      this.singleOrgan += 1
      return
    }
    if (outcome.verdict === 'full') {
      this.candidateRefused += 1
      return
    }
    if (outcome.verdict === 'first-sight') this.firstSight += 1
    const candidate = outcome.candidate
    if (candidate === undefined) return
    this.persist('chain', candidate.slug, candidate, summary.lastAt)
    if (outcome.formed) {
      this.candidateFormed += 1
      if (this.deps.settings().verbose) {
        this.deps.log.info(
          '结晶出一条 skill 候选：%s（%d 步 / %d 个器官 / 第 %d 次）',
          candidate.slug,
          candidate.steps.length,
          candidate.organs,
          candidate.repeats,
        )
      }
    }
  }

  /**
   * 落盘一条记录。失败只计数，**不影响内存状态**：反射是建议性的，
   * 写不进库不该让它当场消失。
   * @param kind `rule` 或 `chain`。
   * @param id 主键。
   * @param payload 记录。
   * @param at 时刻。
   */
  private persist(kind: 'rule' | 'chain', id: string, payload: ReflexRule | SkillCandidate, at: number): void {
    const store = this.adapter()
    if (store === undefined) return
    try {
      store.put(id, kind, JSON.stringify(payload), at)
    } catch (error) {
      this.storeErrors += 1
      this.deps.log.warn('反射状态写入失败（内存里仍然记着）：%s', textOf(error))
    }
  }

  /**
   * 喂一个工具结果。
   * @param execution 上游 `ToolExecution` 子集。
   * @param result 上游 `ToolExecutionResult` 子集。
   */
  observe(execution: unknown, result: unknown): void {
    try {
      this.doObserve(execution, result)
    } catch (error) {
      // 本包挂在工具返回的临界路径上：坏了不能影响工具结果本身。
      this.deps.log.warn('反射处理出错（已忽略，不影响工具结果）：%s', textOf(error))
    }
  }

  /**
   * 观测主体。
   * @param execution 上游执行记录。
   * @param result 上游结果。
   */
  private doObserve(execution: unknown, result: unknown): void {
    const settings = this.deps.settings()
    // 关掉连链都不走：`enable=false` 却还在攒候选，等于开关只关了一半。
    if (!settings.enable) return

    this.results += 1
    if (!isRecord(execution)) {
      this.unnamed += 1
      return
    }
    const exec = execution as ToolExecutionLike
    const tool = typeof exec.name === 'string' ? exec.name : ''
    if (tool === '') {
      this.unnamed += 1
      return
    }

    this.ensureHydrated()

    const at = this.deps.now()
    const res = isRecord(result) ? (result as ToolResultLike) : undefined
    if (res === undefined) {
      // 结果不是对象：既不能算成功也不能算失败（会把一条没走过的路记进链）。
      this.unnamed += 1
      return
    }
    if (typeof res.isError !== 'boolean' && res.error === undefined) {
      // 形状反常：与 O-139 同口径按成功走，但必须能被看见。
      this.unshaped += 1
    }
    const agent = exec.agent

    if (res.isError !== true) {
      this.successes += 1
      if (this.chains.agentKeyOf(agent) === undefined) this.orphanSteps += 1
      const finished = this.chains.step(agent, tool, at, settings.chainGapMs, settings.maxChainSteps)
      for (const summary of finished) this.settle(summary)
      return
    }

    this.failures += 1
    for (const summary of this.chains.cut(agent)) this.settle(summary)

    const attrib = this.deps.attrib()
    if (attrib === undefined || !attrib.available) {
      this.unclassified += 1
      return
    }

    const code = res.error?.info?.code
    const message = res.error?.message
    let cause = ''
    try {
      cause = attrib.classify({ tool, code, message }).cause
    } catch (error) {
      this.unclassified += 1
      this.deps.log.warn('归因抛错（本次不计入反射）：%s', textOf(error))
      return
    }
    if (typeof cause !== 'string' || cause === '') {
      this.unclassified += 1
      return
    }
    this.countReflex(tool, cause, at)
  }

  /** 全部反射（新的在前）。 */
  rules(): readonly ReflexRule[] {
    this.ensureHydrated()
    const list = [...this.table.values()]
    list.sort((a, b) => b.lastAt - a.lastAt)
    return list
  }

  /**
   * 某一条反射。
   * @param tool 工具名。
   * @param cause 归因。
   */
  ruleOf(tool: string, cause: string): ReflexRule | undefined {
    this.ensureHydrated()
    return this.table.get(reflexKeyOf(cause, tool))
  }

  /** 全部候选。 */
  candidates(): readonly SkillCandidate[] {
    this.ensureHydrated()
    return this.crystallizer.list()
  }

  /** 统计。 */
  stats(): ReflexStats {
    return {
      at: this.deps.now(),
      available: this.available,
      reason: this.reason,
      results: this.results,
      successes: this.successes,
      failures: this.failures,
      unnamed: this.unnamed,
      unclassified: this.unclassified,
      unshaped: this.unshaped,
      rules: this.table.size,
      formed: this.formed,
      refusedRules: this.refusedRules,
      chains: this.chainCount,
      shortChains: this.shortChains,
      singleOrgan: this.singleOrgan,
      firstSight: this.firstSight,
      candidates: this.crystallizer.size,
      candidateRefused: this.candidateRefused,
      orphanSteps: this.orphanSteps,
      storeErrors: this.storeErrors,
      badRows: this.badRows,
      persisted: this.adapter() !== undefined,
    }
  }

  /** 卸载：清账本。幂等。 */
  dispose(): void {
    this.table.clear()
    this.counts.clear()
    this.crystallizer.clear()
    this.chains.clear()
    this.hydrated = false
  }
}
