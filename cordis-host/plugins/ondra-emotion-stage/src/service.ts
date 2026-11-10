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
import { describeStageDrift, driftedStages } from './thresholds.js'
import type { StageDriftReport, ThresholdDrift } from './thresholds.js'
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
    touches: 0,
    stepClamped: 0,
    upgrades: 0,
    lockBlocked: 0,
    saves: 0,
  })
  private lastUpgradeAt = 0
  private lastStepClamped = false
  private lastError: string | undefined
  /**
   * 阈值漂移的**延迟取值**。
   *
   * 返回 `undefined` = 没装 / 已关 / 取不到，三者对判定意义相同：用出厂表。
   * 刻意不缓存：系数是「当前互动次数」的函数，冻一次她相处十年还按第一天的门槛判。
   */
  private readonly drift: () => ThresholdDrift | undefined
  /** 最近一次判定实际用了哪张表（面板与诊断读）。 */
  private lastDrift: StageDriftReport = Object.freeze({
    asked: 0,
    applied: Object.freeze([]),
    rejected: Object.freeze([]),
  })

  /**
   * @param settings 配置。
   * @param log 日志。
   * @param clock 时钟（测试可注入）。
   * @param store 状态表；缺席表示只在内存。
   * @param fallbackReason 建表失败之类的外部原因。
   * @param drift 阈值漂移函数的延迟取值（省略即永不漂）。
   */
  constructor(
    settings: Config,
    log: LogLike,
    clock: () => number,
    store: RelationStore | undefined,
    fallbackReason?: StageUnavailableReason,
    drift?: () => ThresholdDrift | undefined,
  ) {
    this.settings = settings
    this.log = log
    this.clock = clock
    this.store = store
    this.fallbackReason = fallbackReason
    this.drift = drift ?? ((): ThresholdDrift | undefined => undefined)
    this.snap = this.freshSnapshot(clock())
    this.load()
  }

  /**
   * 这一轮要用的七阶表（漂移后）。
   *
   * 每次判定现算一次：`driftedStages()` 是纯函数，成本是十来条乘法，
   * 比任何缓存机制都便宜，也不会有「缓存过期」这种只有半夜才发作的缺陷。
   *
   * 它**不写 `lastDrift`**——「判定真的用了这张表」这件事必须由
   * `resolveStage()` 的 `drifted` 回答，见 `noteDrift()`。
   * @returns 判据表（没接漂移时就是 `STAGE_SPECS` 本身）。
   */
  private specTable(): { readonly specs: Readonly<Record<StageId, StageSpec>>; readonly report: StageDriftReport } {
    let drift: ThresholdDrift | undefined
    try {
      drift = this.drift()
    } catch {
      drift = undefined
    }
    const out = driftedStages(drift)
    return out
  }

  /**
   * 记下「这次判定实际用了哪张表」。
   *
   * 判据是判定函数自己报的 `usedDrifted`。若它说没用漂移表，
   * 就把 `applied` 清空——保留 `asked` 是有意的：它证明调用发生过，
   * 与「根本没接上」是两回事，混在一起会让下次排查走错方向。
   * @param report 这一轮算出来的报告。
   * @param usedDrifted 判定函数是否真的用了漂移表。
   */
  private noteDrift(report: StageDriftReport, usedDrifted: boolean): void {
    this.lastDrift = usedDrifted
      ? report
      : Object.freeze({ asked: report.asked, applied: Object.freeze([]), rejected: Object.freeze([]) })
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
    const table = this.specTable()
    const resolved = resolveStage(this.snap.stage, ctx, table.specs)
    this.noteDrift(table.report, resolved.drifted)
    const specs = table.specs
    const target = resolved.target
    const denied = resolved.denied
    const judged = target ?? denied
    const judgedSpec = judged === undefined ? undefined : specOf(judged, specs)
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

  /**
   * 记一次互动（**唯一的互动计数入口**）。
   *
   * ## 为什么计数必须与「关系位移」分开
   *
   * 此前 `interactions` 只在 `adjust()` 里、且仅当某一维真的动了才 +1。
   * 于是它记的是「关系被推动过几次」，而非「说过几句话」。两者的差距
   * 不是一点：一轮平常的问候（好感没动）算 0 次，一次争执（好感掉 0.06）
   * 算 1 次。拿这个数去推 `familiarity = min(1, n / 5000)`，
   * 等于说「吵五百次架我们就很熟了」。
   *
   * 更糟的是它让熟悉度**永远停在 0**：`adjust()` 全仓零调用方（见
   * `cordis-host/src/relation.ts` 的文件头），所以 `n` 从来是 0，
   * 而 0 是「陌生人」这个合法取值——没有任何一处会说「我断了」。
   *
   * ## 为什么不在 `adjust()` 里补 +1 就完事
   *
   * 那样一轮里既调了 `touch()` 又调了 `adjust()` 就会 +2。计数的口径必须
   * **只有一处**，且必须与「一轮对话」一一对应。故 `adjust()` 从此不计数，
   * 只负责把 Δ 应用进三维。
   *
   * @param at 时刻。
   */
  touch(at?: number): RelationState {
    const now = at ?? this.clock()
    if (!this.settings.enable) return this.relation(now)
    try {
      const next: Snapshot = {
        dims: this.project(now),
        interactions: this.snap.interactions + 1,
        firstMetAt: this.snap.firstMetAt,
        stage: this.snap.stage,
        stageEnteredAt: this.snap.stageEnteredAt,
        sacrifice: this.snap.sacrifice,
        settledAt: now,
      }
      this.snap = next
      this.persist(next, now)
      this.counters = { ...this.counters, touches: this.counters.touches + 1 }
      return this.relation(now)
    } catch (error) {
      this.lastError = messageOf(error)
      this.log.warn('记互动失败（按未记处理）：%s', this.lastError)
      return this.relation(now)
    }
  }

  /** 调整关系四维（唯一的关系写入口）。**不计数**——计数归 `touch()`。 */
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
        // 什么都没动：不写库。空调用不该落一次盘。
        return this.relation(now)
      }
      const next: Snapshot = {
        dims: applied.values,
        interactions: this.snap.interactions,
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
      const table = this.specTable()
      const resolved = resolveStage(this.snap.stage, ctx, table.specs)
      this.noteDrift(table.report, resolved.drifted)
      const specs = table.specs
      const target = resolved.target

      // 冲突锁：锁期间不升阶。底座一动不动，只是这一次不许走。
      if (isLocked) {
        if (target !== undefined) {
          this.counters = { ...this.counters, lockBlocked: this.counters.lockBlocked + 1 }
          if (this.settings.verbose) {
            this.log.info('冲突锁生效：本该升到「%s」，本次不升', specOf(target, specs).zh)
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
    const table = this.specTable()
    const specs = table.specs
    const probes = probeAll(ctx, specs).map(item => ({
      id: item.spec.id,
      zh: item.spec.zh,
      ok: item.probe.ok,
      missing: item.probe.missing,
    }))
    // 与 `observe()` 用**同一个**判定函数。曾经这里用的是「最低可达」的
    // `nextStageOf()`，于是出现「解释面板说下一阶是病态、实际 observe 直接跳到落定」——
    // 两套判定各说一套，用户看到的和系统做的不一样，而两边都不报错。
    const resolved = resolveStage(this.snap.stage, ctx, specs)
    this.noteDrift(table.report, resolved.drifted)
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
    /*
     * 诊断报的是**此刻**的漂移情况，不是「上次判定时」的。
     *
     * 这里刻意重新算一遍而不是复用 `lastDrift`：那个字段的意义是
     * 「最近一次判定实际用了哪张表」，而诊断要回答的是「现在装着的这套
     * 系数会把门槛漂到哪」。两者在「还没人判过」时差别最大——
     * 复用 `lastDrift` 会得到 `asked: 0`，看起来像「漂移没接上」，
     * 而实际上接线是好的，只是这一轮还没判。
     */
    let nowDrift: StageDriftReport
    try {
      nowDrift = driftedStages(this.drift()).report
    } catch {
      nowDrift = this.lastDrift
    }

    const out: StageStats = {
      available: this.available,
      storeProvider: this.store === undefined ? 'none' : this.store.provider,
      base: this.snap.stage,
      days: daysOf(this.clock(), this.snap.firstMetAt),
      interactions: this.snap.interactions,
      lastUpgradeAt: this.lastUpgradeAt,
      counters: this.counters,
      drift: Object.freeze({
        asked: nowDrift.asked,
        applied: nowDrift.applied,
        rejected: nowDrift.rejected,
        sentence: describeStageDrift(nowDrift),
      }),
      /*
       * 「最近一次判定实际用了哪张表」。
       *
       * 与 `drift`（现算）并排才能分辨「接线断了」与「这一轮还没判」：
       * 只留现算值时，把 `resolveStage(..., specs)` 改回不传表，
       * 它照样显示「已漂 9 条」——反向验证当场抓到过一次。
       */
      lastDrift: Object.freeze({
        asked: this.lastDrift.asked,
        applied: this.lastDrift.applied,
        rejected: this.lastDrift.rejected,
        sentence: describeStageDrift(this.lastDrift),
      }),
    }
    if (reason !== undefined) return { ...out, reason }
    if (this.lastError !== undefined) return { ...out, lastError: this.lastError }
    return out
  }
}
