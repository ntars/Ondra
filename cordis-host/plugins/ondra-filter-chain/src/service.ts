/**
 * 过滤服务：把九步纯函数串成一条链，并把「谁在位」变成可读的降级。
 *
 * ## 五条纪律
 *
 * 1. **`run()` 永不抛出**（C3）。它挂在「她说完一句话、还没发出去」这条路径上，
 *    抛一次就是「她打了字又删掉」，用户看到的是「没反应」。
 * 2. **每一步各自 try/catch**。某一步坏了只跳过这一步，剩下的照跑——
 *    过滤是减法，少减一刀比整段丢掉好。
 * 3. **`text` 为空就是空**。删空时 `ok=false` + `needsRegenerate=true`，
 *    **不编一句「嗯…」顶上**：那是本插件在替她说话。
 * 4. **长度上限只在 `effectiveMaxChars()` 一处算**。情绪收紧（困 / 炸毛）也在这里，
 *    散到两步去算就会出现「报告说 400、实际裁到 240」。
 * 5. **评审失败不算失败**。任何异常都归 `degraded` 放行，并把原因写进 `reason`。
 */

import { detectAnchors } from './anchors.js'
import { PASSES } from './passes.js'
import type { PassEnv, PassOutcome } from './passes.js'
import { buildReviewMessages, parseFeedback, parseScore, verdictOf } from './review.js'
import { cleanText } from './text.js'
import type { Config } from './settings.js'
import { STEP_IDS, STEP_SPECS } from './types.js'
import type {
  AnchorInput,
  AnchorReport,
  BoundaryLike,
  ChainResult,
  ExpressLike,
  FilterInput,
  FilterReason,
  FilterService,
  FilterStats,
  GatewayLike,
  LogLike,
  PassHit,
  PersonaLike,
  ReviewInput,
  ReviewOutcome,
  StageLike,
  StepId,
  StepResult,
  StepSpec,
} from './types.js'

/** 构造入参。 */
export interface FilterOptions {
  /** 配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 上游取值函数（每次现取，上游晚装载能自愈）。 */
  readonly persona: () => PersonaLike | undefined
  /** 阶段。 */
  readonly stage: () => StageLike | undefined
  /** 表达（困 / 炸毛时收紧长度）。 */
  readonly express: () => ExpressLike | undefined
  /** 模型网关（评审用）。 */
  readonly gateway: () => GatewayLike | undefined
  /** 当前时刻。 */
  readonly now: () => number
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 过滤服务实现。 */
export class Filter implements FilterService {
  /** 配置。 */
  private readonly settings: Config
  /** 日志。 */
  private readonly log: LogLike
  /** 上游。 */
  private readonly persona: () => PersonaLike | undefined
  /** 阶段。 */
  private readonly stage: () => StageLike | undefined
  /** 表达。 */
  private readonly express: () => ExpressLike | undefined
  /** 网关。 */
  private readonly gateway: () => GatewayLike | undefined
  /** 时钟。 */
  private readonly now: () => number
  /** 每轮的评审计数。 */
  private readonly rounds = new Map<string, number>()
  /** 过滤次数。 */
  private runs = 0
  /** 上一次摘了几句。 */
  private lastRemoved = 0
  /** 上一次是否需重生成。 */
  private lastNeedsRegenerate = false
  /** 评审次数。 */
  private reviews = 0
  /** 判为 steer 的次数。 */
  private steers = 0
  /** 因轮次上限被拒的次数。 */
  private roundLimited = 0

  constructor(options: FilterOptions) {
    this.settings = options.settings
    this.log = options.log
    this.persona = options.persona
    this.stage = options.stage
    this.express = options.express
    this.gateway = options.gateway
    this.now = options.now
  }

  /** 是否可用（只受总开关影响）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): FilterReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /** 九步声明。 */
  steps(): readonly StepSpec[] {
    return STEP_SPECS
  }

  /** 跑九步。 */
  run(input: FilterInput): ChainResult {
    const at = input.at ?? this.now()
    const original = cleanText(input.text)
    const started = Date.now()
    if (!this.settings.enable) {
      return this.result(original, original, [], [], undefined, false, false, this.settings.maxChars, started)
    }
    const env = this.envOf(input, at)
    let current = original
    const steps: StepResult[] = []
    const hits: PassHit[] = []
    let blockedBy: StepId | undefined
    let hardCut = false
    for (const id of STEP_IDS) {
      const before = current
      let outcome: PassOutcome
      try {
        outcome = PASSES[id](current, env)
      } catch (error) {
        // 单步失败只跳过这一步：过滤是减法，少减一刀不影响能不能发。
        this.log.warn('过滤第 %s 步异常（已跳过）：%s', id, messageOf(error))
        outcome = Object.freeze({ text: current, removed: 0, hits: Object.freeze([]) })
      }
      current = outcome.text
      if (outcome.hardCut === true) hardCut = true
      for (const hit of outcome.hits) hits.push(hit)
      steps.push(
        Object.freeze({
          step: id,
          beforeChars: before.length,
          afterChars: current.length,
          changed: current !== before,
          removed: outcome.removed,
          hits: outcome.hits,
        }),
      )
      if (blockedBy === undefined && current.length < this.settings.minChars) blockedBy = id
    }
    const needsRegenerate = current.length < this.settings.minChars
    this.runs += 1
    this.lastRemoved = hits.length
    this.lastNeedsRegenerate = needsRegenerate
    return this.result(
      original,
      needsRegenerate ? '' : current,
      steps,
      hits,
      blockedBy,
      needsRegenerate,
      hardCut,
      env.maxChars,
      started,
    )
  }

  /** 锚点检测。 */
  anchors(input: AnchorInput): AnchorReport {
    try {
      return detectAnchors(input)
    } catch (error) {
      this.log.warn('锚点检测异常（已跳过）：%s', messageOf(error))
      return Object.freeze({ hits: Object.freeze([]), agreementStreak: 0 })
    }
  }

  /** 事后评审。 */
  async review(input: ReviewInput): Promise<ReviewOutcome> {
    const turnId = input.turnId ?? 'default'
    const done = this.rounds.get(turnId) ?? 0
    const next = done + 1
    if (!this.settings.reviewEnabled) {
      return Object.freeze({
        ok: false,
        verdict: 'degraded',
        feedback: '',
        round: next,
        reason: 'disabled',
      })
    }
    if (next > this.settings.reviewMaxRounds) {
      this.roundLimited += 1
      return Object.freeze({
        ok: false,
        verdict: 'round-limit',
        feedback: '',
        round: next,
        reason: 'max-rounds',
      })
    }
    const gateway = this.gateway()
    if (gateway === undefined || !gateway.available) {
      return Object.freeze({
        ok: false,
        verdict: 'degraded',
        feedback: '',
        round: next,
        reason: 'no-gateway',
      })
    }
    this.rounds.set(turnId, next)
    this.reviews += 1
    try {
      const request = {
        messages: buildReviewMessages(input.text, input.userText ?? ''),
        temperature: this.settings.reviewTemperature,
        maxTokens: 200,
        purpose: 'filter-review',
        ...(this.settings.reviewSource.length > 0 ? { source: this.settings.reviewSource } : {}),
      }
      const completion = await gateway.complete(request)
      const score = parseScore(completion.text)
      if (score === undefined) {
        return Object.freeze({
          ok: false,
          verdict: 'degraded',
          feedback: '',
          round: next,
          reason: 'unparsable',
        })
      }
      const verdict = verdictOf(score, this.settings.reviewThreshold)
      if (verdict === 'steer') this.steers += 1
      return Object.freeze({
        ok: true,
        score,
        verdict,
        feedback: verdict === 'steer' ? parseFeedback(completion.text) : '',
        round: next,
      })
    } catch (error) {
      // 评审是增强，不是闸门。它挂了，她照样说话。
      this.log.warn('评审调用失败（放行）：%s', messageOf(error))
      return Object.freeze({
        ok: false,
        verdict: 'degraded',
        feedback: '',
        round: next,
        reason: messageOf(error),
      })
    }
  }

  /** 重置某一轮的计数。 */
  resetTurn(turnId: string): void {
    this.rounds.delete(turnId)
  }

  /** 统计快照。 */
  stats(): FilterStats {
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      runs: this.runs,
      lastRemoved: this.lastRemoved,
      lastNeedsRegenerate: this.lastNeedsRegenerate,
      reviews: this.reviews,
      steers: this.steers,
      roundLimited: this.roundLimited,
      sources: this.sourcesOf(),
    })
  }

  /** 拼结果。 */
  private result(
    original: string,
    text: string,
    steps: readonly StepResult[],
    hits: readonly PassHit[],
    blockedBy: StepId | undefined,
    needsRegenerate: boolean,
    hardCut: boolean,
    maxChars: number,
    started: number,
  ): ChainResult {
    const base: ChainResult = {
      ok: !needsRegenerate && text.length > 0,
      text,
      originalChars: original.length,
      finalChars: text.length,
      steps: Object.freeze([...steps]),
      hits: Object.freeze([...hits]),
      needsRegenerate,
      hardCut,
      maxChars,
      elapsedMs: Date.now() - started,
    }
    return Object.freeze(blockedBy === undefined ? base : { ...base, blockedBy })
  }

  /**
   * 四个上游现在到底在不在位。**每次调用都现取**，不缓存。
   *
   * ## 为什么不能留一份「上一次运行时的快照」
   *
   * 九步里第 3 / 4 / 5 步与第 9 步的上限，分别依赖人格内核、阶段、表达档与网关。
   * 这四项缺一个，对应的那一步就静默不命中——而「不命中」与「没中」在界面上
   * 长得一模一样。所以面板必须能回答「现在缺谁」。
   *
   * 之前这里是 `sourceMap`：一份在 `envOf()` 里写、在 `stats()` 里读的快照。
   * 它的致命处不是写错值，而是**`runs` 为 0 时四项全是构造初值 `false`**——
   * 打开面板看到的是一片红，结论是「谁都不在」，而实际上插件全装好了，
   * 只是还没人说过一句话。读者据此会去查一个不存在的装载问题。
   *
   * 这与上一轮 `gateway` 那处是同一个病：**数据不是没采到，是采在了另一条路上**。
   * 上一轮只把 `gateway` 一项改成现取，其余三项仍然留着快照；本轮把快照整个删掉。
   *
   * ## 为什么判 `available` 而不是判「服务存在」
   *
   * 四个服务在「装了但不可用」时照样有对象（人格内核缺人设包、阶段缺快照），
   * 此时对应步骤同样不生效。判存在会把「装了但空转」报成在位，等于换一种撒谎。
   */
  private sourcesOf(): FilterStats['sources'] {
    const persona = this.persona()
    const stage = this.stage()
    const express = this.express()
    const gateway = this.gateway()
    return Object.freeze({
      persona: persona !== undefined && persona.available,
      stage: stage !== undefined && stage.available,
      express: express !== undefined && express.available,
      gateway: gateway !== undefined && gateway.available,
    })
  }

  /** 拼一步执行时能看到的环境。 */
  private envOf(input: FilterInput, at: number): PassEnv {
    const persona = this.persona()
    let boundaries: readonly BoundaryLike[] = []
    if (persona !== undefined && persona.available) {
      try {
        boundaries = persona.boundaries()
      } catch (error) {
        this.log.warn('取硬约束失败（硬红线这一步不生效）：%s', messageOf(error))
      }
    }
    let cautions: readonly string[] = []
    if (input.relation !== undefined && persona !== undefined && persona.available) {
      try {
        const variant = persona.variant(input.relation)
        if (variant !== undefined) cautions = variant.cautions
      } catch (error) {
        this.log.warn('取关系分寸失败（关系越线这一步不生效）：%s', messageOf(error))
      }
    }
    return Object.freeze({
      settings: this.settings,
      at,
      boundaries,
      cautions,
      stageOrder: input.stageOrder ?? this.stageOrderOf(at),
      recent: input.recent ?? [],
      userText: input.userText ?? '',
      maxChars: input.maxChars ?? this.effectiveMaxChars(at),
    })
  }

  /** 当前阶序；拿不到就是 `undefined`（阶段越线不生效）。 */
  private stageOrderOf(at: number): number | undefined {
    const stage = this.stage()
    if (stage === undefined || !stage.available) return undefined
    try {
      return stage.view(at).spec.order
    } catch (error) {
      this.log.warn('取阶段失败（阶段越线这一步不生效）：%s', messageOf(error))
      return undefined
    }
  }

  /**
   * 生效的长度上限（**唯一解析点**）。
   *
   * 困（`silenceBias`）与炸毛（`proactivePaused`）时收紧到 0.6 / 0.7。
   * 手册 §3.2 只说这两档「话少」，没给系数——系数自定，登记待裁决。
   * @param at 时刻。
   */
  private effectiveMaxChars(at: number): number {
    const base = this.settings.maxChars
    if (!this.settings.emotionShrink) return base
    const express = this.express()
    if (express === undefined || !express.available) return base
    try {
      const profile = express.profileOf(at)
      if (profile.rhythm.silenceBias) return Math.max(20, Math.floor(base * 0.6))
      if (profile.rhythm.proactivePaused) return Math.max(20, Math.floor(base * 0.7))
      return base
    } catch (error) {
      this.log.warn('取表达档失败（长度上限用默认值）：%s', messageOf(error))
      return base
    }
  }
}
