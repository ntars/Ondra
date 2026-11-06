/**
 * 关系阶段服务：把纯算术接到存储上。
 *
 * ## 三条铁律
 *
 * 1. **读操作不写库**。`view()` / `relation()` 把闭式衰减投影到当前时刻就返回，
 *    存储里仍是上次结算的样子。投影是精确的（`0.5^(dt/hl)` 可交换），
 *    所以「读一百次」与「读一次再写回去」结果一样，但前者不碰磁盘。
 *    面板每秒刷新时，这条差别就是「每秒一次写」与「零次写」。
 * 2. **阶段与关系值一次提交**。分两次写会出现「升阶成功、关系值失败」的中间态，
 *    而棘轮（只升不降）会让那个错误永远修不回来。
 * 3. **任何异常都不外抛**。本服务在对话主链路上被调用，
 *    为了算一个 0.06 的增量把整轮对话打断，是本末倒置。
 */

import { legacyOf, scaleOf } from './legacy.js'
import { applyPatch, clampDim, clampDims, daysOf, familiarityOf, minutesBetween, projectDims } from './relation.js'
import type { DimValues } from './relation.js'
import type { Config } from './settings.js'
import { probeAll, resolveStage, specOf } from './stages.js'
import type { GateContext } from './stages.js'
import type { RelationStore } from './store.js'
import {
  STAGES,
  STAGE_SPECS,
  type LogLike,
  type RelationPatch,
  type RelationState,
  type StageCounters,
  type StageExplanation,
  type StageGates,
  type StageId,
  type StageService,
  type StageSpec,
  type StageStats,
  type StageUnavailableReason,
  type StageView,
} from './types.js'

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 起始阶段：敌意。手册的七阶从它开始。 */
const START_STAGE: StageId = STAGES[0]

/** 内存里的完整状态（存储里那份 + 投影基准）。 */
interface Snapshot {
  /** 三维（对应 `settledAt` 那一刻）。 */
  readonly dims: DimValues
  /** 累计互动。 */
  readonly interactions: number
  /** 首次相遇时刻。 */
  readonly firstMetAt: number
  /** 棘轮底座。 */
  readonly stage: StageId
  /** 进入该阶的时刻。 */
  readonly stageEnteredAt: number
  /** `sacrifice` 标记。 */
  readonly sacrifice: boolean
  /** 上次结算时刻。 */
  readonly settledAt: number
}

/** 关系阶段仓库。 */
export class StageRepository implements StageService {
  private readonly settings: Config
  private readonly log: LogLike
  private readonly clock: () => number
  private readonly store: RelationStore | undefined
  private readonly fallbackReason: StageUnavailableReason | undefined

  private snap: Snapshot
  private counters: StageCounters = Object.freeze({
    adjusts: 0,
    stepClamped: 0,
    upgrades: 0,
    lockBlocked: 0,
    saves: 0,
  })
  private lastUpgradeAt = 0
  private lastStepClamped = false
  private lastError: string | undefined

  /**
   * @param settings 配置。
   * @param log 日志。
   * @param clock 时钟（测试可注入）。
   * @param store 状态表；缺席表示只在内存。
   * @param fallbackReason 建表失败之类的外部原因。
   */
  constructor(
    settings: Config,
    log: LogLike,
    clock: () => number,
    store: RelationStore | undefined,
    fallbackReason?: StageUnavailableReason,
  ) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.store = store
    this.fallbackReason = fallbackReason
    this.snap = this.freshSnapshot(clock())
    this.load()
  }

  /** 一份「全新关系」。 */
  private freshSnapshot(at: number): Snapshot {
    return {
      dims: Object.freeze({
        affection: 0.1,
        trust: 0.1,
        intimacy: 0,
      }),
      interactions: 0,
      firstMetAt: at,
      stage: START_STAGE,
      stageEnteredAt: at,
      sacrifice: false,
      settledAt: at,
    }
  }

  /**
   * 是否可用。
   *
   * **只看总开关**：没有存档时本插件照样能读能判（内存态），只是重启回到敌意。
   * 把「没有存储」也算成不可用，下游就会以为「关系阶段没装」而走另一套兜底——
   * 两套兜底一撞，界面上的阶段会在两轮之间来回跳。
   */
  get available(): boolean {
    return this.settings.enable
  }

  /** 降级原因（`undefined` 表示一切正常，有存储且在跑）。 */
  get reason(): StageUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    return this.fallbackReason
  }

  /** 读一次存档。读失败按「全新关系」处理。 */
  private load(): void {
    if (this.store === undefined) return
    const row = this.store.load()
    if (row === undefined) return
    const at = this.clock()
    const known = (STAGES as readonly string[]).includes(row.stage)
    const stage: StageId = known ? (row.stage as StageId) : START_STAGE
    if (!known) {
      this.log.warn('存档里的阶段名「%s」不认识，按敌意阶处理（原值不会被覆盖，下次写回时才会纠正）', row.stage)
    }
    this.snap = {
      dims: clampDims({
        affection: clampDim('affection', row.affection),
        trust: clampDim('trust', row.trust),
        intimacy: clampDim('intimacy', row.intimacy),
      }),
      interactions: Number.isFinite(row.interactions) && row.interactions > 0 ? Math.trunc(row.interactions) : 0,
      firstMetAt: row.firstMetAt > 0 ? row.firstMetAt : at,
      stage,
      stageEnteredAt: row.stageEnteredAt > 0 ? row.stageEnteredAt : at,
      sacrifice: row.sacrifice,
      settledAt: row.settledAt > 0 ? row.settledAt : at,
    }
  }

  /** 把当前快照写回存储。 */
  private persist(next: Snapshot, at: number): boolean {
    if (this.store === undefined) return false
    const saved = this.store.save({
      affection: next.dims.affection,
      trust: next.dims.trust,
      intimacy: next.dims.intimacy,
      interactions: next.interactions,
      firstMetAt: next.firstMetAt,
      stage: next.stage,
      stageEnteredAt: next.stageEnteredAt,
      sacrifice: next.sacrifice,
      settledAt: next.settledAt,
      updatedAt: at,
    })
    if (saved) {
      this.counters = { ...this.counters, saves: this.counters.saves + 1 }
      this.lastError = undefined
    } else {
      this.lastError = '写关系存档失败'
    }
    return saved
  }

  /** 把三维投影到 `at`（不写库）。 */
  private project(at: number): DimValues {
    const minutes = minutesBetween(this.snap.settledAt, at)
    return projectDims(this.snap.dims, minutes, this.settings.maxSettleHours * 60)
  }

  /** 七阶表。 */
  stages(): readonly StageSpec[] {
    return STAGES.map(id => STAGE_SPECS[id])
  }

  /** 关系四维快照（投影后，不写库）。 */
  relation(at?: number): RelationState {
    const now = at ?? this.clock()
    const dims = this.project(now)
    return Object.freeze({
      affection: dims.affection,
      trust: dims.trust,
      intimacy: dims.intimacy,
      familiarity: familiarityOf(this.snap.interactions),
      firstMetAt: this.snap.firstMetAt,
      interactions: this.snap.interactions,
      sacrifice: this.snap.sacrifice,
      days: daysOf(now, this.snap.firstMetAt),
      at: now,
    })
  }

  /** 判定上下文。 */
  private contextOf(at: number): GateContext {
    const rel = this.relation(at)
    return Object.freeze({
      days: rel.days,
      affection: rel.affection,
      trust: rel.trust,
      interactions: rel.interactions,
      sacrifice: rel.sacrifice,
    })
  }

  /**
   * 四闸状态。
   *
   * `time` 判的是**目标阶**的天数条件（没有目标时按通过）；
   * `monotonic` 恒为通过——本插件从不下调，棘轮在 `resolveStage()` 里已经生效；
   * `lock` 反映本次是否被锁挡住。
   * @param at 时刻。
   * @param locked 锁状态。
   */
  private gatesOf(at: number, locked: boolean): StageGates {
    const ctx = this.contextOf(at)
    const resolved = resolveStage(this.snap.stage, ctx)
    const target = resolved.target
    const denied = resolved.denied
    const judged = target ?? denied
    const judgedSpec = judged === undefined ? undefined : specOf(judged)
    const time = judgedSpec === undefined ? true : ctx.days >= judgedSpec.days
    const out: StageGates = {
      time,
      step: !this.lastStepClamped,
      monotonic: true,
      lock: !locked,
      missing: resolved.missing,
    }
    if (denied !== undefined) {
      return { ...out, denied }
    }
    return out
  }

  /** 阶段快照（只读）。 */
  view(at?: number, locked?: boolean): StageView {
    const now = at ?? this.clock()
    const isLocked = locked === true
    const base = this.snap.stage
    const spec = specOf(base)
    const rel = this.relation(now)
    const gates = this.gatesOf(now, isLocked)
    const effective: StageId = isLocked ? START_STAGE : base
    const view: StageView = {
      at: now,
      base,
      effective,
      overridden: isLocked && effective !== base,
      spec,
      enteredAt: this.snap.stageEnteredAt,
      days: rel.days,
      relation: rel,
      gates,
      legacy: legacyOf(base),
      scale: scaleOf(rel.affection),
      uiVisible: spec.uiVisible,
    }
    if (view.overridden) {
      return { ...view, overrideReason: 'conflict-lock' }
    }
    return view
  }

  /** 调整关系四维（唯一的关系写入口）。 */
  adjust(patch: RelationPatch, at?: number): RelationState {
    const now = at ?? this.clock()
    if (!this.settings.enable) return this.relation(now)
    try {
      const projected = this.project(now)
      const applied = applyPatch(projected, patch)
      this.lastStepClamped = applied.clamped
      if (applied.clamped) {
        this.counters = { ...this.counters, stepClamped: this.counters.stepClamped + 1 }
      }
      if (!applied.changed && !applied.clamped) {
        // 什么都没动：不写库、不记互动。空调用不该消耗一次「互动次数」。
        return this.relation(now)
      }
      const next: Snapshot = {
        dims: applied.values,
        interactions: this.snap.interactions + (applied.changed ? 1 : 0),
        firstMetAt: this.snap.firstMetAt,
        stage: this.snap.stage,
        stageEnteredAt: this.snap.stageEnteredAt,
        sacrifice: this.snap.sacrifice,
        settledAt: now,
      }
      this.snap = next
      this.persist(next, now)
      this.counters = { ...this.counters, adjusts: this.counters.adjusts + 1 }
      return this.relation(now)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('调整关系失败（按未调整处理）：%s', this.lastError)
      return this.relation(now)
    }
  }

  /** 结算：把闭式衰减固化下来。 */
  settle(idleMinutes?: number, at?: number): RelationState {
    const now = at ?? this.clock()
    if (!this.settings.enable) return this.relation(now)
    try {
      const threshold = idleMinutes ?? this.settings.idleSettleMinutes
      const minutes = minutesBetween(this.snap.settledAt, now)
      // 不足门槛就什么都不做：每轮结算等于每轮一次磁盘写。
      if (minutes < threshold) return this.relation(now)
      const next: Snapshot = {
        dims: this.project(now),
        interactions: this.snap.interactions,
        firstMetAt: this.snap.firstMetAt,
        stage: this.snap.stage,
        stageEnteredAt: this.snap.stageEnteredAt,
        sacrifice: this.snap.sacrifice,
        settledAt: now,
      }
      this.snap = next
      this.persist(next, now)
      if (this.settings.verbose) {
        this.log.info(
          '关系结算：间隔 %d 分钟，好感 %.2f / 信任 %.2f / 亲密 %.2f',
          Math.round(minutes),
          next.dims.affection,
          next.dims.trust,
          next.dims.intimacy,
        )
      }
      return this.relation(now)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('关系结算失败（保持原值）：%s', this.lastError)
      return this.relation(now)
    }
  }

  /** 置 `sacrifice` 标记。 */
  markSacrifice(value: boolean, at?: number): StageView {
    const now = at ?? this.clock()
    if (!this.settings.enable) return this.view(now)
    try {
      const next: Snapshot = {
        dims: this.project(now),
        interactions: this.snap.interactions,
        firstMetAt: this.snap.firstMetAt,
        stage: this.snap.stage,
        stageEnteredAt: this.snap.stageEnteredAt,
        sacrifice: value === true,
        settledAt: now,
      }
      this.snap = next
      this.persist(next, now)
      if (this.settings.verbose) {
        this.log.info('sacrifice 标记已置为 %s', value === true ? '真' : '假')
      }
      return this.view(now)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('置 sacrifice 标记失败（保持原值）：%s', this.lastError)
      return this.view(now)
    }
  }

  /** 判定一次升阶（唯一的阶段写入口）。 */
  observe(input?: { readonly locked?: boolean }, at?: number): StageView {
    const now = at ?? this.clock()
    const isLocked = input !== undefined && input.locked === true
    if (!this.settings.enable) return this.view(now, isLocked)
    try {
      const ctx = this.contextOf(now)
      const resolved = resolveStage(this.snap.stage, ctx)
      const target = resolved.target

      // 冲突锁：锁期间不升阶。底座一动不动，只是这一次不许走。
      if (isLocked) {
        if (target !== undefined) {
          this.counters = { ...this.counters, lockBlocked: this.counters.lockBlocked + 1 }
          if (this.settings.verbose) {
            this.log.info('冲突锁生效：本该升到「%s」，本次不升', specOf(target).zh)
          }
        }
        return this.view(now, true)
      }

      if (target === undefined) return this.view(now)

      const next: Snapshot = {
        dims: this.project(now),
        interactions: this.snap.interactions,
        firstMetAt: this.snap.firstMetAt,
        stage: target,
        stageEnteredAt: now,
        sacrifice: this.snap.sacrifice,
        settledAt: now,
      }
      const fromZh = specOf(this.snap.stage).zh
      this.snap = next
      this.persist(next, now)
      this.counters = { ...this.counters, upgrades: this.counters.upgrades + 1 }
      this.lastUpgradeAt = now
      if (this.settings.verbose) {
        this.log.info(
          '关系升阶：「%s」→「%s」（第 %d 天，好感 %.2f，信任 %.2f）',
          fromZh,
          specOf(target).zh,
          ctx.days,
          ctx.affection,
          ctx.trust,
        )
      }
      return this.view(now)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('升阶判定失败（保持原阶）：%s', this.lastError)
      return this.view(now, isLocked)
    }
  }

  /** 为什么现在是这一阶。 */
  explain(at?: number, locked?: boolean): StageExplanation {
    const now = at ?? this.clock()
    const isLocked = locked === true
    const ctx = this.contextOf(now)
    const rel = this.relation(now)
    const probes = probeAll(ctx).map(item => ({
      id: item.spec.id,
      zh: item.spec.zh,
      ok: item.probe.ok,
      missing: item.probe.missing,
    }))
    // 与 `observe()` 用**同一个**判定函数。曾经这里用的是「最低可达」的
    // `nextStageOf()`，于是出现「解释面板说下一阶是病态、实际 observe 直接跳到落定」——
    // 两套判定各说一套，用户看到的和系统做的不一样，而两边都不报错。
    const resolved = resolveStage(this.snap.stage, ctx)
    const next = resolved.target
    const base = this.snap.stage
    const effective: StageId = isLocked ? START_STAGE : base

    let note: string
    if (isLocked) {
      note = `冲突锁生效：对外按「${specOf(START_STAGE).zh}」处理，底座仍是「${specOf(base).zh}」`
    } else if (next !== undefined) {
      note = `可以升到「${specOf(next).zh}」——四闸都过了`
    } else if (base === STAGES[STAGES.length - 1]) {
      note = '已经在最高阶「落定」，不会再变'
    } else {
      // 报「最高那个没够着的阶」缺的第一条，而不是七阶里第一条缺失的。
      // 前者回答「离最远处还差什么」，后者会把「其实能跳过病态」误报成「卡在病态」。
      const deniedProbe = probes.find(p => p.id === resolved.denied)
      const top = deniedProbe?.missing.at(0) ?? '条件不足'
      const target = deniedProbe === undefined ? '' : `（目标「${deniedProbe.zh}」）`
      note = `停在「${specOf(base).zh}」${target}：${top}`
    }

    const out: StageExplanation = {
      at: now,
      base,
      effective,
      overridden: isLocked && effective !== base,
      days: rel.days,
      relation: rel,
      probes,
      note,
    }
    if (next !== undefined) {
      return { ...out, next }
    }
    return out
  }

  /** 统计快照。 */
  stats(): StageStats {
    const reason = this.reason
    const out: StageStats = {
      available: this.available,
      storeProvider: this.store === undefined ? 'none' : this.store.provider,
      base: this.snap.stage,
      days: daysOf(this.clock(), this.snap.firstMetAt),
      interactions: this.snap.interactions,
      lastUpgradeAt: this.lastUpgradeAt,
      counters: this.counters,
    }
    if (reason !== undefined) return { ...out, reason }
    if (this.lastError !== undefined) return { ...out, lastError: this.lastError }
    return out
  }
}
