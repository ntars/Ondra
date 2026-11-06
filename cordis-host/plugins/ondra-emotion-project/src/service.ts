/**
 * 情感投影的门面。
 *
 * 这一层只做四件事：**拿状态 → 取模板 → 跑自检 → 出片段**。
 * 模板在 `types.ts`（唯一文案真源），护栏在 `guard.ts`（唯一判定），
 * 这里只把「可能失败的宿主调用」包住（C3 器官错误不得传播）。
 */

import { guardText } from './guard.js'
import { CONSTRAINT_LINE, STATES, TEMPLATES, isStateLike } from './types.js'
import type { Config } from './settings.js'
import type {
  ExpressLike,
  ExpressStateLike,
  GuardReport,
  LogLike,
  ProjectCounters,
  Projection,
  ProjectionFragment,
  ProjectRefusal,
  ProjectRequest,
  ProjectService,
  ProjectStats,
  ProjectUnavailableReason,
  TemplateSpec,
} from './types.js'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 造一个被拒绝的投影（所有字段一次写全，避免各处漏字段）。 */
function refused(refusal: ProjectRefusal, state?: ExpressStateLike): Projection {
  return Object.freeze({
    text: '',
    command: '',
    hint: '',
    constraint: CONSTRAINT_LINE,
    state,
    allowed: false,
    refusal,
  })
}

/** 一次状态解析的结果：状态 + 是否命中判据（后者定置信度）。 */
interface ResolvedState {
  /** 六态之一。 */
  readonly state: ExpressStateLike
  /** 是否命中显式判据（显式给的状态按命中算）。 */
  readonly matched: boolean
}

export class ProjectRepository implements ProjectService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ProjectUnavailableReason

  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  /** 六态服务的**延迟取值**：装载顺序不确定，构造时拿不到不代表以后拿不到。 */
  private readonly express: () => ExpressLike | undefined

  private counters: ProjectCounters = { projects: 0, refusals: 0, guards: 0, guardFailures: 0, expressErrors: 0 }
  private lastState: ExpressStateLike | undefined
  private lastError: string | undefined

  /**
   * @param settings 配置。
   * @param log 日志。
   * @param clock 时钟（测试可注入）。
   * @param express 六态服务的延迟取值。
   */
  constructor(
    settings: Config,
    log: LogLike,
    clock: () => number,
    express: () => ExpressLike | undefined,
  ) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.express = express
    this.available = settings.enable
    this.reason = settings.enable ? undefined : 'disabled'
  }

  /**
   * 产出一次投影。
   *
   * 四道拒绝闸，顺序不能换：
   * 1. 开关关掉；
   * 2. 用户明确问了数值（唯一例外，走 `/status`）；
   * 3. 拿不到状态；
   * 4. **模板自检不过**（有人改了文案带进数字/维度名）。
   *
   * 第 4 道不是防现在的模板（现在这六条都过），是防**将来有人改文案**。
   * 没有这道闸，改坏文案的表现是「她开始报数」，而没有任何一处报错。
   * @param request 请求。
   */
  project(request?: ProjectRequest): Projection {
    const now = request?.at ?? this.clock()

    if (!this.available) {
      return this.refuse('disabled', undefined)
    }
    if (request?.askedForNumbers === true) {
      return this.refuse('numbers-requested', undefined)
    }

    // 一次读取同时拿到「哪一态」与「是否命中判据」。分两次读会拿到两个时刻的快照，
    // 表现是「状态说雀跃、置信度按兜底给 0.5」，而两处都不报错。
    const resolved = this.resolveState(request, now)
    if (resolved === undefined) {
      return this.refuse('no-state', undefined)
    }

    const template = TEMPLATES[resolved.state]
    const text = `${template.command}${template.hint}`

    // 模板自检：自己的文案也要过护栏。过了才出片段。
    const report = this.guard(text)
    if (!report.pass) {
      this.lastError = `模板自检不过：${report.hits.map(hit => `${hit.kind}:${hit.text}`).join('、')}`
      this.log.error('状态 %s 的投影模板违反内感受铁律，本次不产出：%s', resolved.state, this.lastError)
      return this.refuse('template-violation', resolved.state)
    }

    const fragment: ProjectionFragment = Object.freeze({
      order: this.settings.projectionOrder,
      ttlMinutes: this.settings.projectionTtlMinutes,
      confidence: resolved.matched ? this.settings.confidenceMatched : this.settings.confidenceFallback,
      text,
      kind: 'project',
    })

    this.counters = { ...this.counters, projects: this.counters.projects + 1 }
    this.lastState = resolved.state
    this.lastError = undefined
    if (this.settings.verbose) {
      this.log.debug?.('情感投影：%s，排序 %d（尾部），置信度 %.2f', template.zh, fragment.order, fragment.confidence)
    }

    return Object.freeze({
      text,
      command: template.command,
      hint: template.hint,
      constraint: CONSTRAINT_LINE,
      state: resolved.state,
      allowed: true,
      fragment,
    })
  }

  /**
   * 护栏。**只用于投影与注入块，不扫对话正文**（见 `guard.ts` 文件头）。
   * @param text 待检文本。
   */
  guard(text: string): GuardReport {
    const report = guardText(text)
    this.counters = {
      ...this.counters,
      guards: this.counters.guards + 1,
      guardFailures: this.counters.guardFailures + (report.pass ? 0 : 1),
    }
    return report
  }

  /** 六态模板全集。 */
  templates(): readonly TemplateSpec[] {
    return Object.freeze(STATES.map(state => TEMPLATES[state]))
  }

  /** 取某一态的模板。 */
  templateOf(state: ExpressStateLike): TemplateSpec | undefined {
    if (!isStateLike(state)) return undefined
    return TEMPLATES[state]
  }

  /**
   * 一句话解释（面板用，**允许出现数字与状态名**）。
   * @param at 时刻。
   */
  describe(at?: number): string {
    const now = at ?? this.clock()
    if (!this.available) return '情感投影已关闭（配置 disabled）'
    const projection = this.project({ at: now })
    if (!projection.allowed) {
      return `不出投影（${projection.refusal ?? '未知原因'}）`
    }
    const state = projection.state
    if (state === undefined) return '不出投影（状态缺失）'
    const confidence = projection.fragment === undefined ? 0 : projection.fragment.confidence
    return `${TEMPLATES[state].zh}：${projection.text}（置信度 ${confidence.toFixed(2)}，排序 ${this.settings.projectionOrder} 尾部，存活 ${this.settings.projectionTtlMinutes} 分钟）`
  }

  /** 统计快照。 */
  stats(): ProjectStats {
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      hasExpress: this.expressValue() !== undefined,
      lastState: this.lastState,
      counters: Object.freeze({ ...this.counters }),
      lastError: this.lastError,
    })
  }

  /** 记一次拒绝并返回。 */
  private refuse(refusal: ProjectRefusal, state: ExpressStateLike | undefined): Projection {
    this.counters = { ...this.counters, refusals: this.counters.refusals + 1 }
    return refused(refusal, state)
  }

  /** 取六态服务实例（包一层 catch：`ctx.get` 本身不保证不抛）。 */
  private expressValue(): ExpressLike | undefined {
    try {
      return this.express()
    } catch {
      return undefined
    }
  }

  /**
   * 定状态：请求显式给了就用它，否则问 O-031。
   *
   * 显式给错（不在六态内）**直接拒绝**，不猜、不落默认——
   * 猜成「平静」会让调用方以为参数生效了，而她的语气其实完全不匹配。
   */
  private resolveState(request: ProjectRequest | undefined, at: number): ResolvedState | undefined {
    if (request?.state !== undefined) {
      return isStateLike(request.state) ? { state: request.state, matched: true } : undefined
    }
    const express = this.expressValue()
    if (express === undefined) return undefined
    try {
      const view = express.stateOf(at)
      if (!isStateLike(view.state)) {
        this.lastError = `六态服务返回了不认识的状态：${String(view.state)}`
        this.log.warn('%s（本次不出投影）', this.lastError)
        return undefined
      }
      return { state: view.state, matched: view.matched === true }
    } catch (error) {
      // C3：器官（六态）的错误不得传播。
      this.counters = { ...this.counters, expressErrors: this.counters.expressErrors + 1 }
      this.lastError = messageOf(error)
      this.log.warn('读六态失败（本次不出投影）：%s', this.lastError)
      return undefined
    }
  }
}
