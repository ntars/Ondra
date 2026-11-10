/**
 * 人格演化服务：把 `drift.ts` 的纯算接到「三张表 + 一次装载」上。
 *
 * ## 五条纪律
 *
 * 1. **当前值永远现算**。`viewOf()` 遍历日志求和，不缓存。
 *    缓存一次就等于给「她现在是什么样」造了第二真源，
 *    而回滚、夹紧、上限三者交错之后，两份值一定会分家。
 * 2. **`base` 只认第一次声明**。之后改声明里的 `base` 会被忽略并告警：
 *    历史增量是相对旧 base 记的，换 base 等于把「她被什么改变过」整段改味。
 * 3. **单次幅度先夹，再记账**。先夹后记，日志里的 `delta` 就是「真正提出去的要求」；
 *    上限那层的夹紧则体现在 `applied` 上。两层各自可观测，混在一起就说不清。
 * 4. **关闭时不装死也不撒谎**。`thresholdOf` 返回 `base`、`explainThreshold` 明说
 *    「人格演化已关闭」，而不是假装 drift 算过了。
 * 5. **异常不外抛**。本服务在装配提示词的路径上被调用，为一个数字打断整轮是本末倒置。
 */

import {
  clamp,
  driftProgress,
  effectiveThreshold,
  explainThreshold as buildThresholdView,
  maxDeltaOf,
  traitBounds,
  traitSentence,
  traitValueOf,
} from './drift.js'
import { MAX_INTERACTIONS } from './types.js'
import type { Config } from './settings.js'
import type { EvolveStore } from './store.js'
import type {
  DriftEntry,
  EvolveCounters,
  EvolveStats,
  EvolveUnavailableReason,
  LogLike,
  PersonaEvolveService,
  PersonaState,
  ThresholdView,
  TraitAdjustInput,
  TraitContribution,
  TraitDecl,
  TraitDelta,
  TraitExplanation,
  TraitSpec,
  TraitView,
} from './types.js'

/** 特质键的合法形状（§8.4 同一条正则：小写开头，字母数字下划线连字符）。 */
const KEY_RE = /^[a-z][a-z0-9_-]{1,63}$/

/** 判定「到顶」的容差（浮点比较不能直接用 `===`）。 */
const EPSILON = 1e-9

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * 内部可变的计数器形状。
 *
 * `EvolveCounters` 对外全是 `readonly`（快照语义），内部要累加，
 * 所以用映射类型把只读摘掉——**不是**再造一套字段名。
 */
type MutableCounters = { -readonly [K in keyof EvolveCounters]: number }

/** 计数器初值。 */
function zeroCounters(): MutableCounters {
  return {
    traits: 0,
    adjustments: 0,
    clamped: 0,
    rolledBack: 0,
    interactions: 0,
    explained: 0,
  }
}

/** 人格演化实现。 */
export class EvolveRepository implements PersonaEvolveService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  private readonly store: EvolveStore | undefined

  private readonly specs = new Map<string, TraitSpec>()
  private deltas: TraitDelta[] = []
  private count = 0
  private loaded = false
  private seq = 0
  private counters: MutableCounters = zeroCounters()
  private lastAdjustAt = 0
  private lastError: string | undefined

  /**
   * @param settings 配置。
   * @param log 日志。
   * @param clock 时钟（毫秒）。
   * @param store 三张表；缺席表示只在内存。
   */
  constructor(settings: Config, log: LogLike, clock: () => number, store: EvolveStore | undefined) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.store = store
  }

  /** 只看总开关：没有存储仍然可用（内存态），只是重启回到出厂。 */
  get available(): boolean {
    return this.settings.enable
  }

  /** 不可用原因（只有「配置关掉」这一种）。 */
  get reason(): EvolveUnavailableReason | undefined {
    return this.settings.enable ? undefined : 'disabled'
  }

  /* ---------------------------------------------------------------- *
   * 装载
   * ---------------------------------------------------------------- */

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (this.store === undefined) return
    for (const spec of this.store.loadTraits()) this.specs.set(spec.id, spec)
    this.deltas = [...this.store.loadDeltas()]
    this.count = this.store.loadInteractions()
    this.counters.traits = this.specs.size
  }

  /* ---------------------------------------------------------------- *
   * 特质
   * ---------------------------------------------------------------- */

  defineTrait(decl: TraitDecl): TraitView | undefined {
    const at = this.clock()
    try {
      this.ensureLoaded()
      const id = typeof decl?.id === 'string' ? decl.id.trim() : ''
      if (!KEY_RE.test(id)) {
        this.log.warn('特质键不合规（%s）：须匹配 %s', id, KEY_RE.source)
        return undefined
      }

      const min = Number.isFinite(decl.min) ? (decl.min as number) : 0
      const max = Number.isFinite(decl.max) ? (decl.max as number) : 1
      if (!(max > min)) {
        this.log.warn('特质 %s 的量程不合法（min %s / max %s）', id, min, max)
        return undefined
      }

      const existing = this.specs.get(id)
      if (existing !== undefined) {
        // base 只认第一次：历史增量是相对旧 base 记的。
        if (Math.abs(existing.base - decl.base) > EPSILON) {
          this.log.warn(
            '特质 %s 的基线已被忽略（出厂 %s，本次声明 %s）：换基线会让已有的 %d 条漂移全部改味',
            id,
            existing.base,
            decl.base,
            this.deltas.filter(item => item.trait === id).length,
          )
        }
        const updated = this.rebuildSpec(id, existing.base, min, max, decl)
        this.specs.set(id, updated)
        this.store?.saveTrait(updated, at)
        return this.viewOf(updated)
      }

      const base = clamp(decl.base, min, max)
      const spec = this.rebuildSpec(id, base, min, max, decl)
      this.specs.set(id, spec)
      this.store?.saveTrait(spec, at)
      this.counters.traits = this.specs.size
      if (this.settings.verbose) {
        this.log.info('登记特质 %s（出厂 %s，可动 ±%s）', id, spec.base, spec.maxDrift)
      }
      return this.viewOf(spec)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('登记特质失败：%s', this.lastError)
      return undefined
    }
  }

  /** 由声明与量程算出一个落定的 spec。 */
  private rebuildSpec(id: string, base: number, min: number, max: number, decl: TraitDecl): TraitSpec {
    const span = max - min
    const ratio =
      typeof decl.maxDriftRatio === 'number' && Number.isFinite(decl.maxDriftRatio) && decl.maxDriftRatio > 0
        ? decl.maxDriftRatio
        : this.settings.defaultTraitDriftRatio
    return Object.freeze({
      id,
      labelZh: typeof decl.labelZh === 'string' && decl.labelZh.trim().length > 0 ? decl.labelZh.trim() : id,
      base,
      min,
      max,
      maxDrift: clamp(span * ratio, 0, span),
    })
  }

  traits(): readonly TraitView[] {
    try {
      this.ensureLoaded()
      return Object.freeze(
        [...this.specs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(spec => this.viewOf(spec)),
      )
    } catch (error) {
      this.lastError = messageOf(error)
      return Object.freeze([])
    }
  }

  traitOf(id: string): TraitView | undefined {
    try {
      this.ensureLoaded()
      const spec = this.specs.get(id)
      return spec === undefined ? undefined : this.viewOf(spec)
    } catch (error) {
      this.lastError = messageOf(error)
      return undefined
    }
  }

  /** 某特质的未回滚增量之和（`source` 只为「替换日志后对比」服务，默认当前日志）。 */
  private sumOf(trait: string, source: readonly TraitDelta[]): { readonly sum: number; readonly entries: number } {
    let sum = 0
    let entries = 0
    for (const item of source) {
      if (item.trait !== trait || item.rolledBack) continue
      sum += item.delta
      entries += 1
    }
    return { sum, entries }
  }

  /**
   * 视图。
   *
   * `source` 允许传一份「假设的日志」，唯一用途是 `adjust()` 里对比「写入前 / 写入后」
   * 以便说出这次到底推动了几个点。**不复用 `this.deltas` 之外的持久化状态**，
   * 所以不存在第二份「当前值」。
   * @param spec 特质。
   * @param source 日志源。
   */
  private viewOf(spec: TraitSpec, source: readonly TraitDelta[] = this.deltas): TraitView {
    const { sum, entries } = this.sumOf(spec.id, source)
    const value = traitValueOf(spec, sum)
    const { floor, ceiling } = traitBounds(spec)
    const headroom = ceiling - value
    return Object.freeze({
      id: spec.id,
      labelZh: spec.labelZh,
      base: spec.base,
      value,
      drift: value - spec.base,
      floor,
      ceiling,
      maxDrift: spec.maxDrift,
      headroom,
      saturated: headroom <= EPSILON,
      entries,
    })
  }

  adjust(input: TraitAdjustInput, at?: number): TraitView | undefined {
    const now = at ?? this.clock()
    try {
      this.ensureLoaded()
      if (!this.settings.enable) return undefined

      const spec = this.specs.get(input.trait)
      if (spec === undefined) {
        this.log.warn('调整了没登记的特质（%s）：先 defineTrait 再用', input.trait)
        return undefined
      }
      const raw = Number.isFinite(input.delta) ? input.delta : 0
      if (raw === 0) return this.viewOf(spec)

      const cap = maxDeltaOf(spec, this.settings.maxDeltaRatio)
      const delta = clamp(raw, -cap, cap)
      if (Math.abs(delta - raw) > EPSILON) {
        this.counters.clamped += 1
        if (this.settings.verbose) {
          this.log.info('单次调整超限（%s → %s），已夹到量程的 %s', raw, delta, this.settings.maxDeltaRatio)
        }
      }

      const entry: TraitDelta = Object.freeze({
        id: this.nextId(now),
        trait: spec.id,
        delta,
        reason: typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim() : '未说明',
        source: typeof input.source === 'string' && input.source.trim().length > 0 ? input.source.trim() : 'unknown',
        at: now,
        rolledBack: false,
      })

      const staged = [...this.deltas, entry]
      const previous = this.deltas
      this.deltas = staged
      if (this.store !== undefined && !this.store.insertDelta(entry)) {
        this.deltas = previous
        return undefined
      }

      this.counters.adjustments += 1
      this.lastAdjustAt = now
      // 默认顺手记一次互动：一次真实交流既改变了特质，也算「相处了一次」。
      if (input.countInteraction !== false) this.noteInteraction(1, now)

      const after = this.viewOf(spec)
      if (this.settings.verbose) {
        const applied = after.value - this.viewOf(spec, previous).value
        this.log.info('特质 %s %s%s（%s）', spec.id, delta > 0 ? '+' : '', round3(delta), entry.reason)
        if (Math.abs(applied - delta) > EPSILON) {
          this.log.info('特质 %s 已到漂移上限，本次实际只推动了 %s', spec.id, round3(applied))
        }
      }
      return after
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('调整特质失败：%s', this.lastError)
      return undefined
    }
  }

  /* ---------------------------------------------------------------- *
   * 互动与阈值
   * ---------------------------------------------------------------- */

  noteInteraction(n?: number, at?: number): number {
    const now = at ?? this.clock()
    try {
      this.ensureLoaded()
      const add = Number.isFinite(n) ? Math.max(0, Math.trunc(n as number)) : 1
      if (add === 0) return this.count
      this.count = Math.min(MAX_INTERACTIONS, this.count + add)
      this.counters.interactions += add
      this.store?.saveInteractions(this.count, now)
      return this.count
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('记互动失败：%s', this.lastError)
      return this.count
    }
  }

  interactions(): number {
    this.ensureLoaded()
    return this.count
  }

  thresholdOf(_key: string, base: number): number {
    this.ensureLoaded()
    if (!this.settings.enable) return Number.isFinite(base) ? base : 0
    return effectiveThreshold(base, this.count)
  }

  explainThreshold(key: string, base: number): ThresholdView {
    try {
      this.ensureLoaded()
      const label = typeof key === 'string' && key.length > 0 ? key : 'threshold'
      if (!this.settings.enable) {
        const safeBase = Number.isFinite(base) ? base : 0
        return Object.freeze({
          key: label,
          base: safeBase,
          interactions: this.count,
          progress: 0,
          factor: 1,
          effective: safeBase,
          rise: 0,
          saturated: false,
          headroom: safeBase * 0.6,
          sentence: `「${label}」的阈值：人格演化已关闭，仍按出厂 ${safeBase} 判。`,
        })
      }
      this.counters.explained += 1
      return buildThresholdView(label, base, this.count)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('解释阈值失败：%s', this.lastError)
      const safeBase = Number.isFinite(base) ? base : 0
      return Object.freeze({
        key: typeof key === 'string' ? key : 'threshold',
        base: safeBase,
        interactions: 0,
        progress: 0,
        factor: 1,
        effective: safeBase,
        rise: 0,
        saturated: false,
        headroom: 0,
        sentence: '阈值解释失败，按出厂值处理。',
      })
    }
  }

  /* ---------------------------------------------------------------- *
   * 日志与回滚
   * ---------------------------------------------------------------- */

  driftLog(options?: { readonly includeRolledBack?: boolean; readonly limit?: number }): readonly TraitDelta[] {
    try {
      this.ensureLoaded()
      const include = options?.includeRolledBack === true
      const picked = this.deltas.filter(item => include || !item.rolledBack)
      picked.sort((a, b) => b.at - a.at)
      const limit = options?.limit ?? picked.length
      return Object.freeze(picked.slice(0, Math.max(0, limit)))
    } catch (error) {
      this.lastError = messageOf(error)
      return Object.freeze([])
    }
  }

  explainTrait(id: string, limit?: number): TraitExplanation | undefined {
    try {
      this.ensureLoaded()
      const spec = this.specs.get(id)
      if (spec === undefined) return undefined

      const picked = this.deltas.filter(item => item.trait === id && !item.rolledBack)
      // 逐条算「实际推动了多少」：夹紧不可逆，所以必须按当时的累计值算，
      // 不能拿「最终值 − 基线」平摊。
      let running = 0
      const all: TraitContribution[] = []
      for (const item of picked) {
        const before = traitValueOf(spec, running)
        running += item.delta
        const after = traitValueOf(spec, running)
        all.push(
          Object.freeze({
            id: item.id,
            at: item.at,
            intended: item.delta,
            applied: after - before,
            reason: item.reason,
          }),
        )
      }
      const cap = limit ?? 8
      const view = this.viewOf(spec)
      return Object.freeze({
        trait: view,
        contributions: Object.freeze(all.slice(-Math.max(1, cap))),
        sentence: traitSentence(spec, view.value, picked.length),
      })
    } catch (error) {
      this.lastError = messageOf(error)
      return undefined
    }
  }

  rollback(entryId: string): boolean {
    try {
      this.ensureLoaded()
      const index = this.deltas.findIndex(item => item.id === entryId)
      if (index < 0) return false
      const target = this.deltas.at(index)
      if (target === undefined || target.rolledBack) return false

      if (this.store !== undefined && !this.store.markRolledBack(entryId)) return false
      const next = [...this.deltas]
      next[index] = Object.freeze({ ...target, rolledBack: true })
      this.deltas = next
      this.counters.rolledBack += 1
      if (this.settings.verbose) {
        this.log.info('回滚了一条漂移（%s，%s）', target.trait, target.reason)
      }
      return true
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('回滚失败：%s', this.lastError)
      return false
    }
  }

  rollbackTrait(traitId: string): number {
    try {
      this.ensureLoaded()
      const pending = this.deltas.filter(item => item.trait === traitId && !item.rolledBack)
      if (pending.length === 0) return 0
      if (this.store !== undefined) {
        const done = this.store.markRollbackTrait(traitId)
        if (done === 0) return 0
      }
      this.deltas = this.deltas.map(item =>
        item.trait === traitId && !item.rolledBack ? Object.freeze({ ...item, rolledBack: true }) : item,
      )
      this.counters.rolledBack += pending.length
      if (this.settings.verbose) {
        this.log.info('特质 %s 整条回滚，撤销 %d 条', traitId, pending.length)
      }
      return pending.length
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('整特质回滚失败：%s', this.lastError)
      return 0
    }
  }

  /* ---------------------------------------------------------------- *
   * 装配与统计
   * ---------------------------------------------------------------- */

  personaState(): PersonaState {
    try {
      this.ensureLoaded()
      const traits: Record<string, number> = {}
      for (const spec of this.specs.values()) traits[spec.id] = this.viewOf(spec).value
      const log: DriftEntry[] = []
      for (const item of this.deltas) {
        if (item.rolledBack) continue
        log.push(Object.freeze({ at: item.at, trait: item.trait, delta: item.delta, reason: item.reason }))
      }
      log.sort((a, b) => a.at - b.at)
      return Object.freeze({ traits: Object.freeze(traits), driftLog: Object.freeze(log) })
    } catch (error) {
      this.lastError = messageOf(error)
      return Object.freeze({ traits: Object.freeze({}), driftLog: Object.freeze([]) })
    }
  }

  stats(): EvolveStats {
    this.ensureLoaded()
    const { factor } = driftProgress(this.count)
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      storeProvider: this.store?.provider ?? 'none',
      interactions: this.count,
      factor,
      driftEntries: this.deltas.length,
      lastAdjustAt: this.lastAdjustAt,
      counters: Object.freeze({ ...this.counters }),
      lastError: this.lastError,
    })
  }

  /** 生成主键。 */
  private nextId(at: number): string {
    for (;;) {
      this.seq += 1
      const id = `d-${Math.trunc(at).toString(36)}-${this.seq.toString(36)}`
      if (!this.deltas.some(item => item.id === id)) return id
    }
  }
}

/** 三位小数（只给日志用）。 */
function round3(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1000) / 1000
}
