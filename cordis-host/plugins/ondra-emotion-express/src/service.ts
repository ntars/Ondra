/**
 * 六态表达的门面。
 *
 * 这一层只做三件事：**读情绪 → 判定 → 出三档参数**。
 * 判定本身在 `judge.ts`（纯函数），系数在 `specs.ts`（纯数据），
 * 这里只负责把「可能失败的宿主调用」包住（C3 器官错误不得传播）。
 */

import {
  BASELINE_ENERGY,
  BASELINE_MOOD,
  BASELINE_TENSION,
  clampAxes,
  resolveState,
} from './judge.js'
import { PARTICLES_ZH, PUNCT_ZH, RHYTHM_SPECS, SHAPE_ZH, VOLUME_ZH, promptStyleOf, rhythmOf, ttsOf } from './specs.js'
import { STATE_ZH } from './types.js'
import type { Config } from './settings.js'
import type {
  EmotionLike,
  ExpressCounters,
  ExpressInput,
  ExpressProfile,
  ExpressService,
  ExpressState,
  ExpressStats,
  ExpressUnavailableReason,
  ExpressView,
  LogLike,
  PromptStyle,
  RhythmProfile,
  TtsProfile,
} from './types.js'

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 从可能不完整的快照里取一个数；不是有限数就返回 `undefined`，交给夹紧层补基线。 */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export class ExpressRepository implements ExpressService {
  /** 是否可用（只看总开关）。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: ExpressUnavailableReason

  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  /** 情绪服务的**延迟取值**：装载顺序不确定，构造时拿不到不代表以后拿不到。 */
  private readonly emotion: () => EmotionLike | undefined

  private counters: ExpressCounters = { reads: 0, profiles: 0, emotionErrors: 0 }
  private lastState: ExpressState | undefined
  private lastMatched = false
  private lastError: string | undefined

  /**
   * @param settings 配置。
   * @param log 日志。
   * @param clock 时钟（测试可注入）。
   * @param emotion 情绪服务的延迟取值。
   */
  constructor(
    settings: Config,
    log: LogLike,
    clock: () => number,
    emotion: () => EmotionLike | undefined,
  ) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.emotion = emotion
    this.available = settings.enable
    this.reason = settings.enable ? undefined : 'disabled'
  }

  /**
   * 判定当前状态。
   *
   * 关掉总开关时**不读情绪、直接给平静**：这是「关掉就等于不改变任何表达」，
   * 而不是「照样判、只是日志少一行」——后者会让用户以为开关没生效。
   * @param at 时刻。
   */
  stateOf(at?: number): ExpressView {
    const now = at ?? this.clock()
    this.counters = { ...this.counters, reads: this.counters.reads + 1 }

    if (!this.available) {
      return this.record({
        state: 'calm',
        zh: STATE_ZH.calm,
        mood: BASELINE_MOOD,
        energy: BASELINE_ENERGY,
        tension: BASELINE_TENSION,
        source: 'baseline',
        matched: false,
      })
    }

    const emotion = this.emotion()
    if (emotion === undefined) {
      return this.record(this.baselineView())
    }

    try {
      const snapshot = emotion.state(now)
      const axes = snapshot.axes
      return this.record(this.viewOf({
        mood: numberOrUndefined(axes['mood']),
        energy: numberOrUndefined(axes['energy']),
        tension: numberOrUndefined(axes['tension']),
      }, 'emotion'))
    } catch (error) {
      // C3：器官（情绪）的错误不得传播。读数抛错就退回基线，并记一笔。
      this.counters = { ...this.counters, emotionErrors: this.counters.emotionErrors + 1 }
      this.lastError = messageOf(error)
      this.log.warn('读情绪快照失败（本次按出厂基线判定）：%s', this.lastError)
      return this.record(this.baselineView())
    }
  }

  /**
   * 纯判定：给三个数，出状态。**不读情绪服务**。
   *
   * 总开关关掉时这里**照常判**——它是面板与测试用的镜子，
   * 不是表达出口。把开关也套在它上面，会让「关掉之后面板显示什么」
   * 变成一个无法回答的问题。
   * @param input 三个维度。
   */
  classify(input: ExpressInput): ExpressView {
    return this.record(this.viewOf(input, 'caller'))
  }

  /** 取完整表达档（推荐入口：一次判定，三处取用）。 */
  profileOf(at?: number): ExpressProfile {
    const view = this.stateOf(at)
    this.counters = { ...this.counters, profiles: this.counters.profiles + 1 }
    const profile: ExpressProfile = Object.freeze({
      view,
      prompt: promptStyleOf(view.state),
      rhythm: rhythmOf(view.state),
      tts: ttsOf(view.state),
    })
    if (this.settings.verbose) {
      this.log.debug?.('六态：%s（%s）', STATE_ZH[view.state], view.matched ? '命中判据' : '空档兜底')
    }
    return profile
  }

  /** 提示词侧参数。 */
  prompt(at?: number): PromptStyle {
    return promptStyleOf(this.stateOf(at).state)
  }

  /** 节奏侧参数。 */
  rhythm(at?: number): RhythmProfile {
    return rhythmOf(this.stateOf(at).state)
  }

  /** 语音侧参数。 */
  tts(at?: number): TtsProfile {
    return ttsOf(this.stateOf(at).state)
  }

  /**
   * 一句话解释（面板用，**允许出现数字**）。
   * @param at 时刻。
   */
  describe(at?: number): string {
    const view = this.stateOf(at)
    const spec = RHYTHM_SPECS[view.state]
    const parts: string[] = []
    parts.push(
      `${STATE_ZH[view.state]}（mood ${view.mood.toFixed(2)} / energy ${view.energy.toFixed(0)} / tension ${view.tension.toFixed(2)}，${view.matched ? '命中判据' : '空档兜底'}）`,
    )
    parts.push(`数值来源：${this.sourceText(view.source)}`)
    if (spec.speechRateDelta !== undefined) {
      parts.push(`语速 ${spec.speechRateDelta > 0 ? '+' : ''}${Math.round(spec.speechRateDelta * 100)}%`)
    } else if (spec.tempo === 'slow') {
      parts.push('语速偏慢（手册未给百分比）')
    }
    if (spec.proactivePaused) parts.push('主动发言暂停')
    else if (spec.proactiveQuotaDelta !== 0) parts.push(`主动额度 ${spec.proactiveQuotaDelta > 0 ? '+' : ''}${spec.proactiveQuotaDelta}`)
    parts.push(SHAPE_ZH[spec.sentenceShape])
    parts.push(PUNCT_ZH[spec.punctuation])
    parts.push(PARTICLES_ZH[spec.particles])
    if (spec.volume === 'low') parts.push(VOLUME_ZH.low)
    if (!spec.readAloud) parts.push('不朗读')
    if (spec.silenceBias) parts.push('倾向静默')
    return parts.join('；')
  }

  /** 统计快照。 */
  stats(): ExpressStats {
    const emotion = this.safeProbe()
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      source: emotion ? 'emotion' : 'baseline',
      lastState: this.lastState,
      lastMatched: this.lastMatched,
      counters: Object.freeze({ ...this.counters }),
      lastError: this.lastError,
    })
  }

  /** 探一下情绪服务在不在（**不调 `state()`**，免得为了统计而结算一次情绪）。 */
  private safeProbe(): boolean {
    try {
      return this.emotion() !== undefined
    } catch {
      return false
    }
  }

  /** 出厂基线视图（mood 0.5 / energy 60 / tension 0 → 平静）。 */
  private baselineView(): ExpressView {
    return this.viewOf({
      mood: BASELINE_MOOD,
      energy: BASELINE_ENERGY,
      tension: BASELINE_TENSION,
    }, 'baseline')
  }

  /** 由三个维度组出一个视图。 */
  private viewOf(input: ExpressInput, source: ExpressView['source']): ExpressView {
    const axes = clampAxes(input)
    const resolved = resolveState(axes)
    return {
      state: resolved.state,
      zh: STATE_ZH[resolved.state],
      mood: axes.mood,
      energy: axes.energy,
      tension: axes.tension,
      source,
      matched: resolved.matched,
    }
  }

  /** 记下最近一次判定，并返回它（避免每个分支都写一遍赋值）。 */
  private record(view: ExpressView): ExpressView {
    this.lastState = view.state
    this.lastMatched = view.matched
    if (this.lastError !== undefined && view.source === 'emotion') this.lastError = undefined
    return view
  }

  /** 来源的中文说明。 */
  private sourceText(source: ExpressView['source']): string {
    if (source === 'emotion') return '情绪服务'
    if (source === 'caller') return '调用方给定'
    return '出厂基线（未接情绪服务）'
  }
}
