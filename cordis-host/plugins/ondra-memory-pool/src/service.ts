/**
 * 八池的门面（**唯一对外实现** `PoolService` 的类）。
 *
 * 四件事在这里收口，别处不许再写一遍：
 *
 * 1. **池表只有一份。** 三列数值全部来自 `pools.ts` 的 `POOL_PRESETS`，
 *    本文件一个规范数字都不写。
 * 2. **分类不猜。** 认不出标签 → 海马体 + `unclassified`，并记一条线索。
 *    线索的「写满 N 次升级人审」是**跨会话**的，所以必须落表，不能只放内存。
 * 3. **时间轴只出时刻，不出权重。** 见 `types.ts` 文件头第 1 条。
 * 4. **不改 `memory_fact` 任何一列。** 时钟（`createdAt` / `lastSeenAt`）只读。
 *
 * 一条刻意的「不做」：`emotion` 是单槽池，但本插件**不替调用方顶替上一条**。
 * `assign()` 照常写入并把同池其它成员通过 `slotHolders()` 暴露出来，
 * 由调用方决定归档谁——替用户删掉上一条情绪，等于替他改写「我刚刚是什么心情」。
 */

import { DAY_MS, POOL_PRESETS, classifyByLabels, isPermanent, presetOf, timelineOfPreset } from './pools.js'
import { PoolStore, digestOf } from './store.js'
import type { Config } from './settings.js'
import { PoolError, TABLE_HINT, TABLE_POOL } from './types.js'
import type {
  AssignInput,
  InjectionEligibility,
  LogLike,
  MemoryCoreLike,
  MemoryRecordLike,
  PoolAssignment,
  PoolClassify,
  PoolClock,
  PoolDueItem,
  PoolHint,
  PoolId,
  PoolIssue,
  PoolPreset,
  PoolService,
  PoolStats,
  PoolTimeline,
  PoolUnavailableReason,
  StoreLike,
} from './types.js'

/** 问题列表上限（防止一个坏掉的库把内存吃干）。 */
const MAX_ISSUES = 20

/** 升级线索清单的返回上限（人工定池是一次性动作，不需要一次列两千条）。 */
const ESCALATION_LIST_LIMIT = 200

/** 一小时的毫秒数。 */
const HOUR_MS = 3600000

/** 截断预览（按码点切，不切坏中文与表情）。 */
function previewOf(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`
}

/** 八池仓库。 */
export class PoolRepository implements PoolService {
  /** 存储面（刻意不叫 `pools`：接口上 `pools()` 是同名方法，字段撞上会编译失败）。 */
  private readonly poolStore: PoolStore | undefined
  private readonly core: MemoryCoreLike | undefined
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number

  /** 建表结果：`undefined` = 还没试过。 */
  private storeReady: boolean | undefined = undefined

  private readonly issues: PoolIssue[] = []

  private counters: {
    assigned: number
    fellBack: number
    reassigned: number
    coreRejected: number
  } = { assigned: 0, fellBack: 0, reassigned: 0, coreRejected: 0 }

  /**
   * @param store 存储端口；`undefined` 表示缺席（池归属无处可放）。
   * @param core 记忆内核；`undefined` 表示缺席（只能判池，算不了时间轴）。
   * @param settings 配置。
   * @param log 日志。
   * @param now 取当前时刻（注入以便对拍）。
   */
  constructor(
    store: StoreLike | undefined,
    core: MemoryCoreLike | undefined,
    settings: Config,
    log: LogLike,
    now: () => number,
  ) {
    this.poolStore = store === undefined ? undefined : new PoolStore(store, log)
    this.core = core
    this.settings = settings
    this.log = log
    this.now = now
  }

  /** 建表。由入口在 `ctx.effect` 里调一次。 */
  ready(): boolean {
    if (this.poolStore === undefined) {
      this.storeReady = false
      return false
    }
    this.storeReady = this.poolStore.ensure()
    return this.storeReady
  }

  /** 是否可用（池分类与时间轴都要存储）。 */
  get available(): boolean {
    if (!this.settings.enable) return false
    return this.storeReady === true
  }

  /** 不可用原因。 */
  get reason(): PoolUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (this.poolStore === undefined) return 'no-store'
    if (this.storeReady === false) return 'schema-failed'
    return undefined
  }

  /**
   * 记一条问题（最多 20 条，超出后只留一条「太多」的提示）。
   * @param issue 问题。
   */
  private note(issue: PoolIssue): void {
    if (this.issues.length >= MAX_ISSUES) {
      if (!this.issues.some(item => item.code === 'too-many-issues')) {
        this.issues.push({ code: 'too-many-issues', detail: '问题过多，仅保留前 20 条' })
      }
      return
    }
    this.issues.push(issue)
  }

  /** {@inheritDoc PoolService.pools} */
  pools(): readonly PoolPreset[] {
    return POOL_PRESETS
  }

  /** {@inheritDoc PoolService.poolOf} */
  poolOf(poolId: string): PoolPreset | undefined {
    return presetOf(poolId)
  }

  /** {@inheritDoc PoolService.classify} */
  classify(input: AssignInput): PoolClassify {
    return classifyByLabels(input.pool, input.labels ?? [])
  }

  /** {@inheritDoc PoolService.assign} */
  assign(input: AssignInput): PoolAssignment {
    if (!this.available || this.poolStore === undefined) {
      throw new PoolError(this.reason ?? 'no-store', '八池服务不可用，无法分配池')
    }
    const factId = input.factId
    if (typeof factId !== 'string' || factId.trim() === '') {
      throw new PoolError('bad-argument', '分配池必须给记忆 id')
    }

    const judged = classifyByLabels(input.pool, input.labels ?? [])
    const preset = presetOf(judged.pool)
    if (preset === undefined) {
      this.note({ code: 'bad-pool', factId, detail: `未知池：${judged.pool}` })
      throw new PoolError('bad-pool', `未知池：${judged.pool}`)
    }

    // legacy 池（`skill`）默认不接受**自动**分配：那一行的口径本身存疑
    // （手册注「README 写 60，代码 90」）。人工 `reassign` 不受此限——人有最终解释权。
    if (!preset.assignable && !this.settings.allowLegacySkill) {
      this.note({
        code: 'not-assignable',
        factId,
        detail: `池 ${judged.pool} 是 legacy 行，不接受自动分配（人工改池请用 reassign）`,
      })
      throw new PoolError('not-assignable', `池 ${judged.pool} 不接受自动分配`, 'legacy 行，只用于读回旧数据')
    }

    this.assertCoreRoom(judged.pool, factId)

    const at = input.at ?? this.now()
    const record: PoolAssignment = {
      factId,
      pool: judged.pool,
      assignedAt: at,
      source: judged.source,
      unclassified: judged.unclassified,
      matchedLabel: judged.matchedLabel,
      note: (input.note ?? '').trim(),
    }

    if (!this.poolStore.put(record)) {
      throw new PoolError('write-failed', '写池归属失败', `记忆 ${factId} → 池 ${judged.pool}`)
    }

    this.counters.assigned += 1
    if (judged.unclassified) {
      this.counters.fellBack += 1
      this.noteUnclassified(input.text ?? '', at)
      this.log.warn(
        '标签一个都没认出（%s），按手册「不猜」落海马体并打「未归类」',
        judged.unknownLabels.length > 0 ? judged.unknownLabels.join(' / ') : '空标签',
      )
    }

    return record
  }

  /**
   * 核心池上限检查。**两个入口（`assign` / `reassign`）共用同一处判定**——
   * 上限不能因为入口不同而失效，否则它形同虚设。
   * @param pool 目标池。
   * @param factId 记忆 id。
   */
  private assertCoreRoom(pool: PoolId, factId: string): void {
    if (pool !== 'core') return
    if (this.poolStore === undefined) return
    const existing = this.poolStore.get(factId)
    if (existing?.pool === 'core') return
    if (this.poolStore.countInPool('core') < this.settings.coreCap) return

    this.counters.coreRejected += 1
    this.note({
      code: 'core-full',
      factId,
      detail: `核心池已满（${this.settings.coreCap} 条），拒绝写入。原则类内容请写进 AGENTS.md`,
    })
    throw new PoolError(
      'core-full',
      `核心池已满（上限 ${this.settings.coreCap} 条）`,
      '核心是不可衰减的那一层，满了不淘汰旧的——删一条核心等于替用户决定「你不该是自己」',
    )
  }

  /**
   * 记一条「未归类」线索，并在达到阈值时升级为「需人工定池」。
   *
   * 手册 §2.5：「同一句重复写满 3 次 → 升级『需人工定池』」。
   * 只放内存的话，进程一重启「写满 3 次」就永远凑不够——所以必须落表。
   * @param text 正文。
   * @param at 时刻。
   */
  private noteUnclassified(text: string, at: number): void {
    if (this.poolStore === undefined) return
    const digest = digestOf(text)
    if (digest === digestOf('')) {
      // 空正文没有可比的键：写进去会让所有空文本挤成同一行，制造假的「重复 3 次」。
      this.note({ code: 'bad-fact-id', detail: '未归类线索的正文为空，未记账（空摘要会让所有空文本挤成一条）' })
      return
    }

    const existing = this.poolStore.getHint(digest)
    if (existing === undefined && this.poolStore.countHints() >= this.settings.hintCap) {
      // 到上限**拒绝新建**，不淘汰旧的——淘汰会让「写满 3 次」永远凑不够。
      this.note({
        code: 'hint-truncated',
        detail: `未归类线索已达上限 ${this.settings.hintCap} 条，本次未记账。请先跑一轮人工定池`,
      })
      return
    }

    const attempts = (existing?.attempts ?? 0) + 1
    const escalated = attempts >= this.settings.escalateAfter
    const hint: PoolHint = {
      digest,
      preview: previewOf(text, this.settings.previewChars),
      attempts,
      escalated,
      firstAt: existing?.firstAt ?? at,
      lastAt: at,
    }
    if (!this.poolStore.putHint(hint)) {
      this.note({ code: 'store-issue', detail: `未归类线索写不进去（${digest.slice(0, 8)}…）` })
      return
    }
    if (escalated && existing?.escalated !== true) {
      this.log.warn('同一句已漏归类 %d 次，升级为「需人工定池」：%s', attempts, hint.preview)
    }
  }

  /** {@inheritDoc PoolService.reassign} */
  reassign(factId: string, pool: PoolId | string, note: string, at?: number): PoolAssignment {
    if (!this.available || this.poolStore === undefined) {
      throw new PoolError(this.reason ?? 'no-store', '八池服务不可用，无法改池')
    }
    if (typeof factId !== 'string' || factId.trim() === '') {
      throw new PoolError('bad-argument', '改池必须给记忆 id')
    }
    const preset = presetOf(pool)
    if (preset === undefined) {
      this.note({ code: 'bad-pool', factId, detail: `未知池：${String(pool)}` })
      throw new PoolError('bad-pool', `未知池：${String(pool)}`)
    }

    // 人工改池**允许**进 legacy 池（人有最终解释权），但 core 上限照样守。
    this.assertCoreRoom(preset.id, factId)

    const record: PoolAssignment = {
      factId,
      pool: preset.id,
      assignedAt: at ?? this.now(),
      source: 'manual',
      // 人工定池 = 已经有人管过了，所以永远不是「未归类」。
      unclassified: false,
      matchedLabel: preset.id,
      note: note.trim(),
    }
    if (!this.poolStore.put(record)) {
      throw new PoolError('write-failed', '改池失败', `记忆 ${factId} → 池 ${preset.id}`)
    }
    this.counters.reassigned += 1
    return record
  }

  /** {@inheritDoc PoolService.assignOf} */
  assignOf(factId: string): PoolAssignment | undefined {
    return this.poolStore?.get(factId)
  }

  /** {@inheritDoc PoolService.unassign} */
  unassign(factId: string): boolean {
    return this.poolStore?.remove(factId) ?? false
  }

  /**
   * 取一条记忆的时钟（只读 `createdAt` / `lastSeenAt`）。
   *
   * 内核缺席时返回 `undefined`——**不拿 `assignedAt` 顶替**。
   * 顶替的后果是「一条三年前的核心事实被当成刚分配」，宽限重新计一遍，
   * 而这类错不会有任何报错。
   * @param factId 记忆 id。
   */
  private clockOf(factId: string): PoolClock | undefined {
    if (this.core === undefined || !this.core.available) return undefined
    const record: MemoryRecordLike | undefined = this.core.getFact(factId)
    if (record === undefined) return undefined
    return { id: record.id, createdAt: record.createdAt, lastSeenAt: record.lastSeenAt }
  }

  /**
   * 三段天级时间轴的锚点：最近一次被带出，为 0 时退回写入时刻。
   *
   * 与 O-010 的「新鲜度锚点 `lastHitAt ?? createdAt`」是**两个不同的锚点**，不要混：
   * 那一条答「还亮不亮」，这一条答「还占不占主动位」。
   * @param clock 时钟。
   */
  private anchorOf(clock: PoolClock): number {
    return clock.lastSeenAt > 0 ? clock.lastSeenAt : clock.createdAt
  }

  /** {@inheritDoc PoolService.timelineOf} */
  timelineOf(factId: string, at?: number): PoolTimeline | undefined {
    const assignment = this.poolStore?.get(factId)
    if (assignment === undefined) return undefined
    const preset = presetOf(assignment.pool)
    if (preset === undefined) return undefined

    const clock = this.clockOf(factId)
    if (clock === undefined) {
      // 内核缺席或记忆已被真删：只报「归属在，时钟拿不到」，**不编一个锚点**。
      this.log.debug?.('算时间轴时拿不到记忆时钟（%s）：内核缺席或记录已删', factId)
      return undefined
    }

    // 锚点只算一次（纯函数但没必要算两遍，且两遍会让人怀疑它有时序依赖）。
    const anchorAt = this.anchorOf(clock)
    const axis = timelineOfPreset(preset, anchorAt, at ?? this.now())
    return {
      factId,
      pool: preset.id,
      anchorAt,
      guardUntil: axis.guardUntil,
      firstHalfLifeAt: axis.firstHalfLifeAt,
      archiveAt: axis.archiveAt,
      ageDays: axis.ageDays,
      halfLives: axis.halfLives,
      phase: axis.phase,
    }
  }

  /** {@inheritDoc PoolService.eligibleForInjection} */
  eligibleForInjection(factId: string, at?: number): InjectionEligibility {
    const assignment = this.poolStore?.get(factId)
    if (assignment === undefined) {
      // 没登记过池 → **默认放行**。八池是「分层」不是「准入名单」；
      // 把未登记当拒绝，会让升级前写入的全部老记忆突然不进注入。
      return { eligible: true, pool: null, reason: 'no-assignment' }
    }
    const preset = presetOf(assignment.pool)
    if (preset === undefined) {
      return { eligible: true, pool: null, reason: 'no-assignment' }
    }
    if (!preset.injectable) {
      // 海马体「永不注入」是硬性质，不受任何配置影响。
      return { eligible: false, pool: preset.id, reason: 'hippocampus-never' }
    }
    const timeline = this.timelineOf(factId, at)
    if (timeline !== undefined && timeline.phase === 'archive-due') {
      // 到归档时刻就不再进主动位；记忆本体还在，按类检索仍能翻到。
      return { eligible: false, pool: preset.id, reason: 'archive-due' }
    }
    // 时钟拿不到时**默认放行**：宁可多注入一条，也不因内核缺席让全部记忆停摆。
    return { eligible: true, pool: preset.id, reason: 'ok' }
  }

  /** {@inheritDoc PoolService.dueForArchive} */
  dueForArchive(poolId?: PoolId | string, at?: number): readonly PoolDueItem[] {
    if (this.poolStore === undefined) return []
    if (this.core === undefined || !this.core.available) return []

    const wanted = poolId === undefined ? undefined : presetOf(poolId)?.id
    const stamp = at ?? this.now()
    const out: PoolDueItem[] = []
    // 一次取回全量再筛，不逐条 `getFact()`：端口没有 JOIN，但也不该为每条记忆发两次查询。
    for (const assignment of this.poolStore.all(this.settings.dueScanLimit)) {
      if (wanted !== undefined && assignment.pool !== wanted) continue
      const preset = presetOf(assignment.pool)
      if (preset === undefined) continue
      if (isPermanent(preset)) continue
      const clock = this.clockOf(assignment.factId)
      if (clock === undefined) continue
      const archiveAt = this.anchorOf(clock) + preset.archiveDays * DAY_MS
      if (stamp < archiveAt) continue
      out.push({
        factId: assignment.factId,
        pool: preset.id,
        archiveAt,
        overdueHours: (stamp - archiveAt) / HOUR_MS,
      })
    }
    // 逾期越久越靠前：夜巡清单的顺序要稳定且有意义。
    return out.sort((left, right) => right.overdueHours - left.overdueHours)
  }

  /** {@inheritDoc PoolService.slotHolders} */
  slotHolders(poolId: PoolId | string): readonly string[] {
    const preset = presetOf(poolId)
    if (preset === undefined || !preset.singleSlot || this.poolStore === undefined) return []
    // 单槽池正常只该有一条；多取几条是为了让「历史遗留的多条」能被看见并人工清理。
    return this.poolStore.idsInPool(preset.id, this.settings.pageSize)
  }

  /** {@inheritDoc PoolService.escalations} */
  escalations(): readonly PoolHint[] {
    return this.poolStore?.escalated(ESCALATION_LIST_LIMIT) ?? []
  }

  /** {@inheritDoc PoolService.resolveHint} */
  resolveHint(digest: string): boolean {
    return this.poolStore?.removeHint(digest) ?? false
  }

  /** {@inheritDoc PoolService.stats} */
  stats(): PoolStats {
    const provider = this.poolStore?.provider ?? 'none'
    const clockAvailable = this.core !== undefined && this.core.available
    if (!this.available || this.poolStore === undefined) {
      return {
        available: false,
        reason: this.reason ?? 'no-store',
        provider,
        assigned: 0,
        byPool: {},
        core: { count: 0, cap: this.settings.coreCap },
        unclassified: 0,
        escalations: 0,
        clockAvailable,
        counters: this.counters,
        issues: this.issues,
      }
    }

    const grouped = this.poolStore.groupByPool(this.settings.dueScanLimit)
    const total = Object.values(grouped.byPool).reduce<number>((sum, value) => sum + (value ?? 0), 0)
    const coreCount = grouped.byPool['core'] ?? 0
    if (coreCount > this.settings.coreCap) {
      // 只报不删：超过上限说明历史数据或人工改池把上限撑破了，界面要能看见。
      this.note({
        code: 'core-full',
        detail: `核心池现有 ${coreCount} 条，已超过上限 ${this.settings.coreCap} 条（历史数据，不自动淘汰）`,
      })
    }
    if (!grouped.complete) {
      this.log.warn('池统计可能不完整：撞到扫描上限 %d 条', this.settings.dueScanLimit)
    }

    return {
      available: true,
      provider,
      assigned: total,
      byPool: grouped.byPool,
      core: { count: coreCount, cap: this.settings.coreCap },
      unclassified: this.poolStore.countUnclassified(),
      escalations: this.poolStore.countEscalated(),
      clockAvailable,
      counters: this.counters,
      issues: this.issues,
    }
  }
}

/** 把各池条数打成人话（入口日志用）。 */
export function poolSummaryOf(stats: PoolStats): string {
  const parts = Object.entries(stats.byPool)
    .filter(([, value]) => (value ?? 0) > 0)
    .map(([pool, value]) => `${pool} ${value}`)
  return parts.length === 0 ? '空' : parts.join(' / ')
}

/** 两张表的表名（入口日志与自检要能报到「哪两张表」）。 */
export const POOL_TABLE_NAMES: readonly string[] = Object.freeze([TABLE_POOL, TABLE_HINT])
