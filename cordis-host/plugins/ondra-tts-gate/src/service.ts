/**
 * 闸门服务：判定 + 记账。
 *
 * ## 为什么依赖是「取服务的函数」而不是服务本身
 *
 * `apply(ctx)` 执行时，O-026 / O-031 / O-050 可能都还没装载（宿主不保证顺序）。
 * 装载时把 `undefined` 存进字段，此后永远是 `undefined`——症状是
 * 「情绪服务明明装了，闸门却一直按无情绪降级」，而日志里只有一句装载期的告警。
 * 因此每次判定都现取一次：`ctx.get` 是一次 Map 查表，代价可以忽略。
 *
 * ## 为什么 `decide()` 不计数
 *
 * 面板每开一次就要预览「这句话会不会念」，若预览也进 `stats()`，
 * 面板上的「拦下 N 次」会随开关面板的次数增长。
 * 计数只属于真实发生的那一次 `admit()`。
 *
 * ## 为什么被拦下也要把 `streak` 报出来
 *
 * 「连续两条」是一条容易被误解的规则：用户看到「刚才明明只说了两条」
 * 却再也没出声，需要一个能读到的数。`streak` 就是这个数，
 * 面板上显示「连读 2 / 上限 2」比显示一句解释有用。
 */

import { emotionReason, cooldownReason, charCount, intensityOf, lengthReason, rateOf, streakReason } from './gate.js'
import { hasEmotive } from './lexicon.js'
import type { Config } from './settings.js'
import type {
  DegradedReason,
  EmotionLike,
  ExpressLike,
  GateDecision,
  GateOptions,
  GateReason,
  GateService,
  GateStats,
  LogLike,
  TtsLike,
} from './types.js'

/** 服务依赖。三个 `() => ...` 都是**现取**，不缓存服务句柄。 */
export interface GateDeps {
  readonly settings: Config
  readonly log: LogLike
  /** 当前时刻（走 O-003）。 */
  readonly now: () => number
  readonly emotion: () => EmotionLike | undefined
  readonly express: () => ExpressLike | undefined
  readonly tts: () => TtsLike | undefined
}

/** 判定的中间态（内部用，不对外）。 */
interface Draft {
  readonly speak: boolean
  readonly reason: GateReason
  readonly chars: number
  readonly intensity?: number
  readonly emotive: boolean
  readonly rate?: number
  readonly volume?: 'normal' | 'low'
  readonly degraded: readonly DegradedReason[]
  readonly sinceLastMs?: number
  readonly at: number
}

/** 取一个 0–1 的数（不是有限数就当没有）。 */
function numOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

/** 闸门服务实现。 */
export class Gate implements GateService {
  private readonly deps: GateDeps

  private lastSpokenAt = 0
  private streak = 0

  private decisions = 0
  private spoken = 0
  private readonly blocked = new Map<GateReason, number>()
  private lastReason: GateReason | undefined

  constructor(deps: GateDeps) {
    this.deps = deps
  }

  get available(): boolean {
    return this.deps.settings.enable
  }

  get reason(): 'disabled' | undefined {
    return this.deps.settings.enable ? undefined : 'disabled'
  }

  /* ---------------------------------------------------------------- *
   * 判定
   * ---------------------------------------------------------------- */

  decide(text: string, options: GateOptions = {}): GateDecision {
    return this.shape(this.draft(text, options))
  }

  admit(text: string, options: GateOptions = {}): GateDecision {
    const decision = this.draft(text, options)
    this.decisions += 1
    this.lastReason = decision.reason

    if (decision.speak) {
      this.spoken += 1
      this.lastSpokenAt = decision.at
      this.streak += 1
    } else {
      // 任何一个「不出声」都打断连读：被频控拦下的那一条并没有念出来。
      this.streak = 0
      this.blocked.set(decision.reason, (this.blocked.get(decision.reason) ?? 0) + 1)
      if (this.deps.settings.verbose) {
        this.deps.log.debug('语音未放行（%s，%d 字）', decision.reason, decision.chars)
      }
    }

    return this.shape(decision)
  }

  /** 判定本体（**纯**：只读配置、只读服务、不动计数）。 */
  private draft(text: string, options: GateOptions): Draft {
    const settings = this.deps.settings
    const at = options.at ?? this.deps.now()
    const sinceLastMs = this.lastSpokenAt === 0 ? undefined : at - this.lastSpokenAt

    if (!settings.enable) return this.draftOf({ at, sinceLastMs, speak: false, reason: 'disabled' })

    const tts = this.deps.tts()
    if (tts === undefined || !tts.available) {
      return this.draftOf({ at, sinceLastMs, speak: false, reason: 'unavailable' })
    }

    // 净化走 O-050 的同一份实现（有就用，没有按原文）。不在这里另写一份。
    const cleaned = typeof tts.speakable === 'function' ? tts.speakable(text) : String(text ?? '')
    const chars = charCount(cleaned)
    const emotive = hasEmotive(cleaned)

    const tooShortOrLong = lengthReason(chars, settings)
    if (tooShortOrLong !== undefined) {
      return this.draftOf({ at, sinceLastMs, speak: false, reason: tooShortOrLong, chars, emotive })
    }

    const degraded: DegradedReason[] = []

    // 六态：炸毛不朗读（手册 §3.2），顺带把语速与音量带出去。
    let rate: number | undefined
    let volume: 'normal' | 'low' | undefined
    const express = this.deps.express()
    if (express === undefined) {
      degraded.push('no-express')
    } else {
      try {
        const profile = express.tts(at)
        if (profile.readAloud === false) {
          return this.draftOf({ at, sinceLastMs, speak: false, reason: 'harsh', chars, emotive, degraded })
        }
        rate = rateOf(profile.speechRateDelta)
        volume = profile.volume
      } catch {
        // 表达服务抛错不该让「不出声」变成「整条链路挂掉」：按缺数据降级。
        degraded.push('no-express')
      }
    }

    // 情绪强度。缺数据时**不拦**（见 types.ts 文件头：两种失败方向是刻意的）。
    let intensity: number | undefined
    const emotion = this.deps.emotion()
    if (emotion === undefined) {
      degraded.push('no-emotion')
    } else {
      try {
        const snapshot = emotion.state(at)
        const mood = numOf(snapshot.normalized['mood'])
        const energy = numOf(snapshot.normalized['energy'])
        if (mood !== undefined && energy !== undefined) intensity = intensityOf(mood, energy)
        else degraded.push('no-emotion')
      } catch {
        degraded.push('no-emotion')
      }
    }

    const flat = emotionReason(intensity, emotive, settings)
    if (flat !== undefined) {
      return this.draftOf({ at, sinceLastMs, speak: false, reason: flat, chars, intensity, emotive, rate, volume, degraded })
    }

    const cooling = cooldownReason(sinceLastMs, settings)
    if (cooling !== undefined) {
      return this.draftOf({ at, sinceLastMs, speak: false, reason: cooling, chars, intensity, emotive, rate, volume, degraded })
    }

    const capped = streakReason(this.streak, settings)
    if (capped !== undefined) {
      return this.draftOf({ at, sinceLastMs, speak: false, reason: capped, chars, intensity, emotive, rate, volume, degraded })
    }

    return this.draftOf({
      at,
      sinceLastMs,
      speak: true,
      reason: 'ok',
      chars,
      intensity,
      emotive,
      rate,
      volume,
      degraded,
    })
  }

  /** 组一份中间态（默认值集中在一处，避免八处各写一遍空字段）。 */
  private draftOf(input: {
    readonly at: number
    readonly sinceLastMs?: number
    readonly speak: boolean
    readonly reason: GateReason
    readonly chars?: number
    readonly intensity?: number
    readonly emotive?: boolean
    readonly rate?: number
    readonly volume?: 'normal' | 'low'
    readonly degraded?: readonly DegradedReason[]
  }): Draft {
    return {
      speak: input.speak,
      reason: input.reason,
      chars: input.chars ?? 0,
      intensity: input.intensity,
      emotive: input.emotive ?? false,
      rate: input.rate,
      volume: input.volume,
      degraded: input.degraded ?? [],
      sinceLastMs: input.sinceLastMs,
      at: input.at,
    }
  }

  /** 中间态 → 对外结果（补上当前的 `streak`）。 */
  private shape(draft: Draft): GateDecision {
    return Object.freeze({
      speak: draft.speak,
      reason: draft.reason,
      chars: draft.chars,
      intensity: draft.intensity,
      emotive: draft.emotive,
      streak: this.streak,
      rate: draft.rate,
      volume: draft.volume,
      degraded: Object.freeze([...draft.degraded]),
      sinceLastMs: draft.sinceLastMs,
      at: draft.at,
    })
  }

  /* ---------------------------------------------------------------- *
   * 维护
   * ---------------------------------------------------------------- */

  reset(): void {
    this.lastSpokenAt = 0
    this.streak = 0
  }

  stats(): GateStats {
    // 逐条搬进普通对象再冻结：`Object.fromEntries` 回来的是字符串索引签名，
    // 与 `Partial<Record<GateReason, number>>` 只是「恰好能对上」，不是同一个东西。
    const blocked: Partial<Record<GateReason, number>> = {}
    for (const [reason, count] of this.blocked) blocked[reason] = count
    return Object.freeze({
      decisions: this.decisions,
      spoken: this.spoken,
      blocked: Object.freeze(blocked),
      streak: this.streak,
      lastReason: this.lastReason,
      lastSpokenAt: this.lastSpokenAt,
    })
  }
}
