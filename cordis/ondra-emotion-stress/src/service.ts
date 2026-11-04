/**
 * 应激倍率服务：把纯算术接到「读一次情绪」上。
 *
 * ## 三条纪律
 *
 * 1. **只读情绪，不写情绪**（C1）。结构对位里刻意没有 `feel` / `setAxis`，
 *    所以「顺手把皮质醇调高一点」在类型层面就写不出来。
 * 2. **异常不外抛**（C3）。本插件在检索排序的临界路径上被调用，
 *    为了算一个倍率把整轮召回打断是本末倒置。出错时返回**恒等倍率**（×1/×1），
 *    即「这一次不改变任何排序」——这是唯一一个「什么都不做」的正确退化。
 * 3. **不装定时器**。片段到期由拼装方按 `ttlMinutes` 丢弃；
 *    本插件只管「此刻该不该有这段」，不管「什么时候撤掉」。
 */

import { buildDirective } from './directive.js'
import type { Config } from './settings.js'
import { BAND_ZH, DEFAULT_CORTISOL } from './types.js'
import { multiplierAt, pickMultiplier, rankOf, weightOfItem } from './stress.js'
import type {
  EmotionLike,
  LogLike,
  PromptFragment,
  StressCounters,
  StressItem,
  StressMultiplier,
  StressRanking,
  StressService,
  StressStats,
  StressUnavailableReason,
} from './types.js'

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 恒等倍率：读不到、算错、关掉时都用它。 */
const IDENTITY = multiplierAt(DEFAULT_CORTISOL, 'baseline')

/** 应激倍率服务实现。 */
export class StressRepository implements StressService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  private readonly emotion: () => EmotionLike | undefined

  private counters: StressCounters = Object.freeze({
    multiplies: 0,
    reweights: 0,
    directives: 0,
    crisisSamples: 0,
  })
  private lastCortisol = -1
  private lastBand: StressMultiplier['band'] | undefined = undefined
  private lastError: string | undefined

  /**
   * @param settings 配置。
   * @param log 日志。
   * @param clock 时钟（测试可注入）。
   * @param emotion 情绪服务的**延迟取值**：装载顺序不确定，构造时拿到 `undefined`
   *   不代表永远没有。每次用前现取，才能自愈。
   */
  constructor(settings: Config, log: LogLike, clock: () => number, emotion: () => EmotionLike | undefined) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.emotion = emotion
  }

  /** 是否可用。**只看总开关**（没有情绪服务是降级，不是没装）。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因。 */
  get reason(): StressUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    return undefined
  }

  /**
   * 决定这一次用哪个皮质醇值。
   *
   * 优先级：调用方显式给值 → 情绪服务读数 → 出厂基线。
   * 显式值排第一，是因为**对照与回放**必须能复现：「同样的皮质醇，倍率应该一样」，
   * 而实时读数每次都不同，回放就没法对拍。
   * @param explicit 调用方给的值。
   * @param at 时刻。
   */
  private resolveCortisol(explicit: number | undefined, at: number): { value: number; source: StressMultiplier['source'] } {
    if (explicit !== undefined && Number.isFinite(explicit)) {
      return { value: explicit, source: 'caller' }
    }
    const emotion = this.emotion()
    if (emotion === undefined) {
      return { value: DEFAULT_CORTISOL, source: 'baseline' }
    }
    const state = emotion.state(at)
    const raw = state.hormones['cortisol']
    if (raw === undefined || !Number.isFinite(raw)) {
      // 情绪服务在，但没这个键：按基线处理，并留一条 warn 让人知道是「缺字段」而不是「很平静」。
      this.log.warn('情绪快照里没有 cortisol 字段，按基线 %d 处理（倍率不改变排序）', DEFAULT_CORTISOL)
      return { value: DEFAULT_CORTISOL, source: 'baseline' }
    }
    return { value: raw, source: 'emotion' }
  }

  /** 取倍率。 */
  multiplierOf(cortisol?: number, at?: number): StressMultiplier {
    const now = at ?? this.clock()
    if (!this.settings.enable) return IDENTITY
    try {
      const resolved = this.resolveCortisol(cortisol, now)
      const multipliers = multiplierAt(resolved.value, resolved.source)
      this.lastCortisol = multipliers.cortisol
      this.lastBand = multipliers.band
      this.counters = { ...this.counters, multiplies: this.counters.multiplies + 1 }
      if (multipliers.band === 'crisis') {
        this.counters = { ...this.counters, crisisSamples: this.counters.crisisSamples + 1 }
      }
      this.lastError = undefined
      return multipliers
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('取应激倍率失败，按恒等倍率（×1）处理：%s', this.lastError)
      return IDENTITY
    }
  }

  /** 单条权重。 */
  weightOf(item: StressItem, at?: number): number {
    return weightOfItem(item, this.multiplierOf(undefined, at))
  }

  /** 重排（只改顺序，不改内容）。 */
  reweight<T extends StressItem>(items: readonly T[], at?: number): StressRanking<T> {
    const multipliers = this.multiplierOf(undefined, at)
    try {
      const ranking = rankOf(items, multipliers)
      this.counters = { ...this.counters, reweights: this.counters.reweights + 1 }
      if (this.settings.verbose && items.length > 0) {
        const top = ranking.items.at(0)
        this.log.debug?.(
          '应激重排：%d 条，皮质醇 %d（%s），危机 ×%.2f / 日常 ×%.2f，首条「%s」',
          items.length,
          multipliers.cortisol,
          BAND_ZH[multipliers.band],
          multipliers.crisis,
          multipliers.daily,
          top === undefined ? '—' : top.id,
        )
      }
      return ranking
    } catch (error) {
      // 排序失败也要「原样返回、一条不丢」：宁可这次顺序不变，也不能少条目。
      this.lastError = messageOf(error)
      this.log.warn('应激重排失败，按原顺序返回（不丢条目）：%s', this.lastError)
      const untouched = items.map(item => {
        const merged: T & { readonly weight: number; readonly multiplier: number } = {
          ...item,
          weight: weightOfItem(item, multipliers),
          multiplier: pickMultiplier(multipliers, item.class),
        }
        return Object.freeze(merged)
      })
      return Object.freeze({ items: Object.freeze(untouched), multipliers, dropped: 0 as const })
    }
  }

  /** 行为指令（仅危机档）。 */
  directive(at?: number): PromptFragment | undefined {
    const multipliers = this.multiplierOf(undefined, at)
    try {
      const fragment = buildDirective(multipliers, this.settings)
      if (fragment === undefined) return undefined
      this.counters = { ...this.counters, directives: this.counters.directives + 1 }
      if (this.settings.verbose) {
        this.log.info('皮质醇 %d（%s）：已产出应激行为指令，排序键 %d', multipliers.cortisol, BAND_ZH[multipliers.band], fragment.order)
      }
      return fragment
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('构造应激指令失败（本次不注入）：%s', this.lastError)
      return undefined
    }
  }

  /** 一句话解释（面板用，允许出现数字）。 */
  explain(cortisol?: number): string {
    const multipliers = this.multiplierOf(cortisol)
    const sourceZh =
      multipliers.source === 'emotion' ? '情绪服务读数' : multipliers.source === 'caller' ? '调用方给定' : '出厂基线'
    return `皮质醇 ${multipliers.cortisol}（${BAND_ZH[multipliers.band]}，${sourceZh}）→ 危机类 ×${multipliers.crisis.toFixed(2)} / 日常类 ×${multipliers.daily.toFixed(2)}`
  }

  /** 统计快照。 */
  stats(): StressStats {
    const emotionAvailable = this.emotion() !== undefined
    const out: StressStats = {
      available: this.available,
      cortisolSource: emotionAvailable ? 'emotion' : 'baseline',
      lastCortisol: this.lastCortisol,
      lastBand: this.lastBand,
      counters: this.counters,
    }
    const reason = this.reason
    if (reason !== undefined) return { ...out, reason }
    if (this.lastError !== undefined) return { ...out, lastError: this.lastError }
    return out
  }
}
