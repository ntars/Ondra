/**
 * 情绪内核的实现。
 *
 * ## 三条实现纪律
 *
 * 1. **状态只在这里改。** 下游拿到的快照是冻结的副本；想让她变，必须回调
 *    `feel()` / `setAxis()` / `comfort()`。这不是洁癖——情绪一旦能从外面直接写，
 *    「她为什么突然不开心」这个问题就永远查不出来了。
 * 2. **结算只发生在读之前。** 没有定时器、没有 tick。`state()` 一进来先补算
 *    从上次结算到现在的时间差。理由与 O-013 同：闭式函数，算一次和算一百次
 *    结果一样，那就不该让「app 开多久」影响结果。
 * 3. **不可用也要能跑。** 存储没了就退化成纯内存，配置关了就给基线。
 *    任何一条路都不抛异常——情绪内核挂掉会让整条对话链拿不到状态，
 *    而那是最难查的失败形态：她不回话，日志里什么都没有。
 */

import { settleLabels, applyLabels, cloneLabels, dominantOf, emptyLabels, parseLabels } from './labels.js'
import { settlePool, applyHormone, createPool, parsePool, crossedStress, SEROTONIN_CROSS_PENALTY } from './hormones.js'
import type { HormonePool } from './hormones.js'
import { axisDelta, clampAxis, elapsedMinutes, hormoneDelta, settleAxis, MAX_HORMONE_STEP } from './pad.js'
import type { Config } from './settings.js'
import { DEFAULT_TEMPERAMENT, EmotionError, AXES, AXIS_SPEC } from './types.js'
import type {
  Axis,
  EmotionCounters,
  EmotionService,
  EmotionSnapshot,
  EmotionStats,
  EmotionUnavailableReason,
  FeelingInput,
  Label,
  LogLike,
  Temperament,
} from './types.js'
import type { StateStore } from './store.js'
import { parseJson } from './store.js'

/** 安慰时情绪回升的幅度（手册 §3.2：「只降 0.08，保留一点嘴硬」）。 */
export const COMFORT_STEP = 0.08

/** 安慰时被压下去的负面标签。 */
const NEGATIVE_LABELS: readonly Label[] = ['anger', 'sadness', 'fear', 'hurt', 'anxiety']

/** 六维的一把副本。 */
function cloneAxes(source: Readonly<Record<Axis, number>>): Record<Axis, number> {
  const out = {} as Record<Axis, number>
  for (const axis of AXES) out[axis] = source[axis]
  return out
}

/** 基线六维。 */
function baselineAxes(): Record<Axis, number> {
  const out = {} as Record<Axis, number>
  for (const axis of AXES) out[axis] = AXIS_SPEC[axis].baseline
  return out
}

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 情绪内核实现。 */
export class EmotionRepository implements EmotionService {
  readonly available: boolean
  readonly reason: EmotionUnavailableReason | undefined

  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number
  private readonly stateStore: StateStore | undefined

  private axes: Record<Axis, number>
  private labels: Record<Label, number>
  private pool: HormonePool
  private temperamentValue: Temperament

  /** 上次结算时刻（0 表示还没结算过，首次读不补算历史）。 */
  private settledAt = 0
  private lastSaveAt = 0
  private lastErrorText: string | undefined

  private readonly counters: {
    settles: number
    feelings: number
    comforts: number
    inflicted: number
    saves: number
    crossings: number
  } = { settles: 0, feelings: 0, comforts: 0, inflicted: 0, saves: 0, crossings: 0 }

  /**
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   * @param stateStore 状态仓库（可能缺席）。
   * @param reason 降级原因（可能没有）。
   */
  constructor(settings: Config, log: LogLike, now: () => number, stateStore: StateStore | undefined, reason: EmotionUnavailableReason | undefined) {
    this.settings = settings
    this.log = log
    this.now = now
    this.stateStore = stateStore
    this.reason = reason
    this.available = settings.enable

    this.temperamentValue = DEFAULT_TEMPERAMENT
    this.axes = baselineAxes()
    this.labels = emptyLabels()
    this.pool = createPool(this.temperamentValue)
  }

  /* ---------------------------------------------------------------- *
   * 结算
   * ---------------------------------------------------------------- */

  /**
   * 惰性结算到指定时刻。
   *
   * 顺序不能换：**先算六维，再用六维去算化学池**——
   * 血清素的 recover 规则要读 `energy > 80` 和 `tension < 0.7`，
   * 用结算前的能量去判，会出现「刚睡醒能量 78、这一格按不恢复算」的错位。
   *
   * @param at 目标时刻。
   */
  private settle(at: number): void {
    if (!this.settings.enable) return
    if (this.settledAt === 0) {
      // 首次读：只记时间，不补算。否则一个全新的存档会被「从 1970 年到现在」结算一次。
      this.settledAt = at
      return
    }
    const dt = elapsedMinutes(this.settledAt, at, this.settings.maxSettleMinutes)
    if (!(dt > 0)) {
      this.settledAt = at
      return
    }

    for (const axis of AXES) {
      this.axes[axis] = settleAxis(axis, this.axes[axis], dt, this.temperamentValue)
    }
    this.labels = settleLabels(this.labels, dt, this.temperamentValue)

    this.pool = settlePool(this.pool, dt, this.axes.energy, this.axes.tension, this.temperamentValue)

    this.settledAt = at
    this.counters.settles += 1
  }

  /**
   * 改一个激素，并在**皮质醇越过应激阈值的那一刻**补上血清素的一次性扣除。
   *
   * 为什么跨越判定必须在这里、而不是在结算里：结算开始时皮质醇已经在线上，
   * `wasStressed` 一上来就是 true，跨越永远检测不到。手册 §3.9 写这条规则时的
   * 理由正是「只按分钟抽则 `set_state` 后立刻看不出变化，像坏了」——
   * 那句话说的就是「一次性扣必须发生在设值的那一刻」。
   *
   * @param name 激素名。
   * @param delta 增量（已夹过上限）。
   * @returns 是否生效。
   */
  private shiftHormone(name: string, delta: number): boolean {
    const temperament = this.temperamentValue
    const before = this.pool.values['cortisol'] ?? 20
    const next = applyHormone(this.pool, name, delta, temperament)
    if (next === undefined) return false
    this.pool = next

    if (name === 'cortisol') {
      const after = this.pool.values['cortisol'] ?? 0
      if (crossedStress(before, after)) {
        this.counters.crossings += 1
        const drained = applyHormone(this.pool, 'serotonin', -SEROTONIN_CROSS_PENALTY, temperament)
        if (drained !== undefined) this.pool = drained
        this.log.debug?.('皮质醇越过应激阈值，血清素一次性扣除 %d', SEROTONIN_CROSS_PENALTY)
      }
    }
    return true
  }

  /* ---------------------------------------------------------------- *
   * 快照
   * ---------------------------------------------------------------- */

  /** 组装一份冻结的快照。 */
  private snapshot(): EmotionSnapshot {
    const axes = cloneAxes(this.axes)
    const normalized = {} as Record<Axis, number>
    for (const axis of AXES) {
      const spec = AXIS_SPEC[axis]
      normalized[axis] = spec.max === 1 ? axes[axis] : axes[axis] / spec.max
    }
    return Object.freeze({
      at: this.settledAt,
      axes: Object.freeze(axes),
      labels: Object.freeze(cloneLabels(this.labels)),
      hormones: Object.freeze({ ...this.pool.values }),
      temperament: this.temperamentValue,
      normalized: Object.freeze(normalized),
      dominant: dominantOf(this.labels),
      tensionHigh: axes.tension > this.settings.tensionHighThreshold,
    })
  }

  /** @inheritdoc */
  state(at?: number): EmotionSnapshot {
    const moment = at ?? this.now()
    if (!this.settings.enable) return this.snapshot()
    this.settle(moment)
    return this.snapshot()
  }

  /* ---------------------------------------------------------------- *
   * 事件
   * ---------------------------------------------------------------- */

  /** @inheritdoc */
  feel(input: FeelingInput, at?: number): EmotionSnapshot {
    const moment = at ?? this.now()
    if (!this.settings.enable) return this.snapshot()
    this.settle(moment)

    if (input.pleasure !== undefined) this.axes.pleasure = clampAxis('pleasure', this.axes.pleasure + axisDelta(input.pleasure))
    if (input.arousal !== undefined) this.axes.arousal = clampAxis('arousal', this.axes.arousal + axisDelta(input.arousal))
    if (input.dominance !== undefined) this.axes.dominance = clampAxis('dominance', this.axes.dominance + axisDelta(input.dominance))
    if (input.mood !== undefined) this.axes.mood = clampAxis('mood', this.axes.mood + axisDelta(input.mood, 0.5))
    if (input.tension !== undefined) this.axes.tension = clampAxis('tension', this.axes.tension + axisDelta(input.tension))
    if (input.energy !== undefined) {
      const step = Math.max(-MAX_HORMONE_STEP, Math.min(MAX_HORMONE_STEP, input.energy))
      this.axes.energy = clampAxis('energy', this.axes.energy + step)
    }

    this.labels = applyLabels(this.labels, input.labels)

    if (input.hormones !== undefined) {
      for (const [name, raw] of Object.entries(input.hormones)) {
        if (typeof raw !== 'number') continue
        if (!this.shiftHormone(name, hormoneDelta(raw))) {
          this.log.warn('激素「%s」没能生效（名字不合法或已超过 %d 种上限）', name, 12)
        }
      }
    }

    this.settledAt = moment
    this.counters.feelings += 1
    return this.snapshot()
  }

  /** @inheritdoc */
  comfort(at?: number): EmotionSnapshot {
    const moment = at ?? this.now()
    if (!this.settings.enable) return this.snapshot()
    this.settle(moment)

    // 「只降 0.08」不是抠门，是保留嘴硬：一句对不起就把情绪清零，
    // 那不叫被安慰，那叫开关。手册 §3.2 原话：「保留一点『嘴硬』」。
    this.axes.pleasure = clampAxis('pleasure', this.axes.pleasure + COMFORT_STEP)
    this.axes.mood = clampAxis('mood', this.axes.mood + COMFORT_STEP)
    this.axes.arousal = clampAxis('arousal', this.axes.arousal - COMFORT_STEP / 2)
    this.axes.tension = clampAxis('tension', this.axes.tension - COMFORT_STEP)

    const patched: Partial<Record<Label, number>> = {}
    for (const label of NEGATIVE_LABELS) {
      if ((this.labels[label] ?? 0) > 0) patched[label] = -(COMFORT_STEP / 0.12)
    }
    this.labels = applyLabels(this.labels, patched)

    this.settledAt = moment
    this.counters.comforts += 1
    return this.snapshot()
  }

  /** @inheritdoc */
  setAxis(axis: Axis, value: number, at?: number): EmotionSnapshot {
    if (!AXIS_SPEC[axis]) throw new EmotionError('bad-request', `未知的情绪维度：${String(axis)}`)
    const moment = at ?? this.now()
    if (!this.settings.enable) return this.snapshot()
    this.settle(moment)
    this.axes[axis] = clampAxis(axis, value)
    this.settledAt = moment
    return this.snapshot()
  }

  /** @inheritdoc */
  inflict(name: string, delta: number, at?: number): boolean {
    const moment = at ?? this.now()
    if (!this.settings.enable) return false
    this.settle(moment)
    if (!this.shiftHormone(name, hormoneDelta(delta))) return false
    this.settledAt = moment
    this.counters.inflicted += 1
    return true
  }

  /** @inheritdoc */
  setTemperament(patch: Partial<Temperament>, at?: number): Temperament {
    const moment = at ?? this.now()
    const merged: Temperament = {
      sensitivity: clampRange(patch.sensitivity, 0.5, 2, this.temperamentValue.sensitivity),
      resilience: clampRange(patch.resilience, 0.5, 2, this.temperamentValue.resilience),
      enthusiasm: clampRange(patch.enthusiasm, 20, 80, this.temperamentValue.enthusiasm),
      metabolism: clampRange(patch.metabolism, 0.5, 2, this.temperamentValue.metabolism),
    }
    this.settle(moment)
    this.temperamentValue = Object.freeze(merged)
    return this.temperamentValue
  }

  /** @inheritdoc */
  temperament(): Temperament {
    return this.temperamentValue
  }

  /* ---------------------------------------------------------------- *
   * 存读档
   * ---------------------------------------------------------------- */

  /** @inheritdoc */
  save(at?: number): boolean {
    const moment = at ?? this.now()
    if (!this.settings.enable) return false
    this.settle(moment)
    const store = this.stateStore
    if (store === undefined) {
      this.lastErrorText = 'no-store'
      return false
    }
    const ok = store.save({
      axes: this.axes,
      labels: this.labels,
      hormones: this.pool.values,
      dynamic: this.pool.dynamic,
      temperament: this.temperamentValue,
      settledAt: this.settledAt,
      updatedAt: moment,
    })
    if (ok) {
      this.lastSaveAt = moment
      this.counters.saves += 1
      this.lastErrorText = undefined
      if (this.settings.verboseSave) this.log.info('情绪已落盘（结算于 %d）', this.settledAt)
    } else {
      this.lastErrorText = 'write-failed'
    }
    return ok
  }

  /**
   * @inheritdoc
   *
   * 读档时**不结算**：存档里的时刻就是状态所属的时刻，
   * 补算发生在下一次 `state()`。这样「读档」和「看她现在怎么样」是两件事，
   * 排查时能分清「存档里是这样」和「现在应该是这样」。
   */
  load(at?: number): EmotionSnapshot {
    const moment = at ?? this.now()
    const store = this.stateStore
    if (store === undefined || !this.settings.enable) return this.snapshot()

    const row = store.load()
    if (row === undefined) {
      // 没有存档：从基线开始，不覆盖「首次结算」的语义。
      this.axes = baselineAxes()
      this.labels = emptyLabels()
      this.pool = createPool(this.temperamentValue)
      this.settledAt = moment
      return this.snapshot()
    }

    try {
      this.temperamentValue = parseTemperament(parseJson(row.temperament, {}), this.temperamentValue)
      this.axes = parseAxes(parseJson(row.axes, {}))
      this.labels = parseLabels(parseJson(row.labels, {}))
      this.pool = parsePool(parseJson(row.hormones, {}), parseJson(row.dynamic, []), this.temperamentValue)
      this.settledAt = Number.isFinite(row.settledAt) && row.settledAt > 0 ? row.settledAt : moment
      this.lastErrorText = undefined
    } catch (error) {
      this.lastErrorText = messageOf(error)
      this.log.warn('解析情绪存档失败，退回基线：%s', messageOf(error))
    }
    return this.snapshot()
  }

  /** @inheritdoc */
  stats(): EmotionStats {
    return {
      available: this.available,
      reason: this.reason,
      storeProvider: this.stateStore === undefined ? 'none' : 'configured',
      dynamicHormones: this.pool.dynamic.length,
      lastSettleAt: this.settledAt,
      lastSaveAt: this.lastSaveAt,
      counters: { ...this.counters } as EmotionCounters,
      lastError: this.lastErrorText,
    }
  }
}

/** 夹一个带默认值的数。 */
function clampRange(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 解析存档里的六维。
 *
 * **缺字段按基线补，不按 0 补**（手册 §3.2）。这条规则看着小，
 * 但它是「旧存档兼容」与「伪造情绪」的分界线：补 0 会让升级过的人
 * 一开 app 就看到一个「极度烦躁」的她。
 * @param raw 存档里的原始值。
 */
export function parseAxes(raw: unknown): Record<Axis, number> {
  const out = baselineAxes()
  if (typeof raw !== 'object' || raw === null) return out
  const record = raw as Record<string, unknown>
  for (const axis of AXES) {
    const value = record[axis]
    if (typeof value === 'number' && Number.isFinite(value)) out[axis] = clampAxis(axis, value)
  }
  return out
}

/** 解析存档里的气质四旋钮。 */
export function parseTemperament(raw: unknown, fallback: Temperament): Temperament {
  if (typeof raw !== 'object' || raw === null) return fallback
  const record = raw as Record<string, unknown>
  return Object.freeze({
    sensitivity: clampRange(record['sensitivity'] as number | undefined, 0.5, 2, fallback.sensitivity),
    resilience: clampRange(record['resilience'] as number | undefined, 0.5, 2, fallback.resilience),
    enthusiasm: clampRange(record['enthusiasm'] as number | undefined, 20, 80, fallback.enthusiasm),
    metabolism: clampRange(record['metabolism'] as number | undefined, 0.5, 2, fallback.metabolism),
  })
}
