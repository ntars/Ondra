/**
 * O-132 的宿主实现：装载拓扑、能力门控、能量会计、反馈仲裁、提示词拼装、遥测。
 *
 * ## 五条关键实现裁决
 *
 * 1. **门面在注册时一次性冻结，不随宿主状态变化重建。** 器官手里握着的是同一个对象；
 *    若每次 `facade()` 都造新的，器官在自己 `apply()` 里闭包住的那个门面会与
 *    「宿主当前看到的门面」不是同一个，`unregister` 之后还能用——那是最难查的泄漏。
 *    失效靠 `alive` 标记：摘掉之后任何调用都抛「已卸载」。
 * 2. **`consume()` 永远可用，`state()` 要求有效回执。** 付能量是义务不是权限。
 *    `enforceReceipt=false` 时 `state()` 放行，但**仍要求先 consume 过一次**——
 *    迁移期可以免扣钱，但不能免掉「申请过」这件事，否则 C2 的空壳连形状都没有。
 * 3. **`flush()` 里先清队列再应用。** 反过来的话，`apply` 过程中器官又提了新提议
 *    （很常见：感知到变化顺手提一笔），这些新提议会被同一次 flush 二次处理。
 * 4. **`tick()` / `toolResult()` 逐个 try/catch，对应器官转 `degraded`。** C3 的要点是
 *    「错误不得传播」而不是「错误不得记录」——转 `degraded` 是唯一能让面板说清
 *    「这个器官哑了」的办法。
 * 5. **本包不装任何定时器。** `tick()` 由宿主调度（谁需要就谁调），
 *    这正是「零常驻」的含义；装了定时器，一个没人用的宿主也在偷偷烧 CPU。
 */

import type {
  Capability,
  CapabilityGrant,
  ChargeMode,
  Disposer,
  EmotionView,
  EnergyReceipt,
  FeedbackDelta,
  FeedbackQueueResult,
  FeedbackReport,
  FeedbackTarget,
  GapProposalResult,
  LogLike,
  OrganFacade,
  OrganGapInput,
  OrganHostReason,
  OrganHostService,
  EmotionSourceLike,
  EnergySourceLike,
  GapPoolLike,
  OrganCounters,
  ToolsRegistryLike,
  OrganKv,
  OrganManifest,
  OrganPromptDraft,
  OrganRegistration,
  OrganSnapshot,
  OrganStateView,
  OrganStats,
  OrganToolSpec,
  PromptAssembly,
  PromptOptions,
  TickReport,
  ToolResultReport,
  ToolResultView,
} from './types.js'
import {
  CAPABILITY_SET,
  CapabilityDeniedError,
  GAP_SOURCES,
  KEY_RE,
  OrganManifestError,
  PerceptionDeniedError,
  ReceiptRequiredError,
} from './types.js'
import type { AttributedDraft } from './prompt.js'
import { assemble } from './prompt.js'
import { applyBuckets, bucketize, enqueue } from './arbitrate.js'
import type { PendingDelta } from './arbitrate.js'
import { failedCharge, normalizeCost, quoteEnergy } from './energy.js'
import type { Config } from './settings.js'
import { deniedCapabilitiesOf } from './settings.js'

/** O-026 的结构对位子集（只读三个字段）。 */

/** 一个器官在宿主里的全部记录。 */
interface OrganRecord {
  readonly manifest: OrganManifest
  readonly grant: CapabilityGrant
  /** 门面在注册时造一次并冻结（见文件头第 1 条）。 */
  facade: OrganFacade
  readonly counters: Mutable<OrganCounters>
  state: OrganSnapshot['state']
  lastReceipt?: EnergyReceipt
  /** 卸载标记：摘掉之后任何门面调用都拒绝。 */
  alive: boolean
  /** 器官自己的键值空间。 */
  readonly store: Map<string, unknown>
  /** 待撤销：监听、工具、kv 清理。 */
  readonly disposers: Disposer[]
  /** 提示词申报器。 */
  readonly promptProviders: Set<(at: number) => readonly OrganPromptDraft[]>
  /** 心跳处理器。 */
  readonly tickHandlers: Set<(at: number) => void>
  /** 工具结果处理器。 */
  readonly toolHandlers: Set<(result: ToolResultView) => void>
}

/** 把 `readonly` 去掉（计数要在内部累加）。 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** 计数器初值。 */
function zeroCounters(): Mutable<OrganCounters> {
  return {
    receipts: 0,
    denied: 0,
    starved: 0,
    partial: 0,
    shadow: 0,
    fragments: 0,
    droppedFragments: 0,
    proposals: 0,
    appliedDeltas: 0,
    clampedDeltas: 0,
    droppedDeltas: 0,
    ticks: 0,
    toolResults: 0,
    errors: 0,
    capabilityDenied: 0,
  }
}

/** 服务的依赖注入。 */
export interface OrganHostDeps {
  /** 读当前配置（每次现取，便于热更新）。 */
  readonly settings: () => Config
  /** 日志。 */
  readonly log: LogLike
  /** 取情绪快照；缺席返回 `undefined`。 */
  readonly emotion: () => EmotionSourceLike | undefined
  /** 取能量源；缺席返回 `undefined`。 */
  readonly energySource: () => EnergySourceLike | undefined
  /** 取缺口池；缺席返回 `undefined`。 */
  readonly gap: () => GapPoolLike | undefined
  /** 取宿主工具注册表；缺席返回 `undefined`。 */
  readonly tools: () => ToolsRegistryLike | undefined
  /** 现取时刻。 */
  readonly now: () => number
}

/** 宿主实现。 */
export class OrganHost implements OrganHostService {
  private readonly organs = new Map<string, OrganRecord>()
  // 反馈目标表实例。与方法 targets() 同名会冲突，故取别名。
  private readonly targetMap = new Map<string, FeedbackTarget>()
  private readonly sources = new Map<string, (at: number) => unknown>()
  private readonly signals = new Map<string, Set<(payload: unknown, from: string) => void>>()
  private queue: PendingDelta[] = []
  private readonly counters = {
    receipts: 0,
    denied: 0,
    starved: 0,
    fragments: 0,
    droppedFragments: 0,
    flushes: 0,
    appliedDeltas: 0,
    clampedDeltas: 0,
    droppedDeltas: 0,
    sinkErrors: 0,
    signals: 0,
  }
  private disposed = false

  constructor(private readonly deps: OrganHostDeps) {}

  get available(): boolean {
    return !this.disposed && this.deps.settings().enable
  }

  get reason(): OrganHostReason | undefined {
    return this.available ? undefined : 'disabled'
  }

  get chargeMode(): ChargeMode {
    return this.deps.settings().chargeMode
  }

  /* ------------------------------ 注册 ------------------------------ */

  register(manifest: OrganManifest): OrganRegistration {
    const settings = this.deps.settings()
    if (!settings.enable || this.disposed) {
      return { accepted: false, id: textOf(manifest?.id), reason: 'disabled', detail: '宿主总开关关着，或已卸载' }
    }

    const id = manifest?.id
    if (typeof id !== 'string' || !KEY_RE.test(id)) {
      return {
        accepted: false,
        id: textOf(id),
        reason: 'bad-id',
        detail: '器官 id 必须匹配 ^[a-z][a-z0-9_-]{1,63}$（§8.4）',
      }
    }
    if (this.organs.has(id)) {
      return { accepted: false, id, reason: 'duplicate', detail: '同 id 的器官已经注册过，先 unregister' }
    }

    // 清单校验：先在本地拦，不把坏清单落进表里再让下游猜。
    try {
      assertManifest(manifest)
    } catch (error) {
      if (error instanceof OrganManifestError) {
        return { accepted: false, id, reason: 'bad-manifest', detail: error.message }
      }
      return { accepted: false, id, reason: 'bad-manifest', detail: textOf(error) }
    }

    // 能力：声明 ∖ 全局黑名单。
    const denied = deniedCapabilitiesOf(settings.deniedCapabilities)
    const deniedSet = new Set<string>(denied)
    const granted: Capability[] = []
    const refused: Capability[] = []
    for (const capability of manifest.capabilities) {
      if (!CAPABILITY_SET.has(capability)) {
        return {
          accepted: false,
          id,
          reason: 'unknown-capability',
          detail: '能力「' + String(capability) + '」不在白名单里（default-deny，§8.1）',
        }
      }
      if (deniedSet.has(capability)) refused.push(capability)
      else granted.push(capability)
    }
    // 重复声明去重（器官作者手滑不该变成两次授权）。
    const uniqueGranted = Object.freeze([...new Set(granted)])

    const at = this.deps.now()
    const grant: CapabilityGrant = Object.freeze({
      organId: id,
      granted: uniqueGranted,
      denied: Object.freeze([...new Set(refused)]),
      at,
    })

    const record: OrganRecord = {
      manifest,
      grant,
      // 占位只为满足类型；下面立刻用真门面覆盖（门面需要 record 本身，先有鸡后有蛋）。
      facade: undefined as unknown as OrganFacade,
      counters: zeroCounters(),
      state: 'ready',
      alive: true,
      store: new Map<string, unknown>(),
      disposers: [],
      promptProviders: new Set(),
      tickHandlers: new Set(),
      toolHandlers: new Set(),
    }

    // 门面在注册时冻结：见文件头第 1 条。
    record.facade = this.buildFacade(record)
    this.organs.set(id, record)

    const dispose: Disposer = () => {
      this.unregister(id)
    }

    if (grant.denied.length > 0) {
      this.deps.log.warn('器官「%s」有 %d 项能力被宿主策略拒绝：%s', id, grant.denied.length, grant.denied.join('、'))
    }
    this.deps.log.info(
      '器官「%s」v%s 已装载：能力 %d 项，报价 %d（模式 %s）',
      id,
      manifest.version,
      grant.granted.length,
      normalizeCost(manifest.energy.cost),
      settings.chargeMode,
    )

    return { accepted: true, id, facade: record.facade, grant, dispose }
  }

  unregister(id: string): boolean {
    const record = this.organs.get(id)
    if (record === undefined) return false
    record.alive = false
    for (const dispose of record.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        // 撤销器抛错不影响摘除：摘掉才是目的。
        this.deps.log.warn('器官「%s」的撤销器抛错（已忽略）：%s', id, textOf(error))
      }
    }
    record.store.clear()
    record.promptProviders.clear()
    record.tickHandlers.clear()
    record.toolHandlers.clear()
    this.organs.delete(id)
    // 队列里它的提议一起丢：器官都没了，提议的出处也查不到了。
    const before = this.queue.length
    this.queue = this.queue.filter(item => item.organId !== id)
    const removed = before - this.queue.length
    this.deps.log.info('器官「%s」已卸载，丢弃它 %d 条未提交提议', id, removed)
    return true
  }

  has(id: string): boolean {
    return this.organs.has(id)
  }

  ids(): readonly string[] {
    return Object.freeze([...this.organs.keys()].sort())
  }

  facade(id: string): OrganFacade | undefined {
    return this.organs.get(id)?.facade
  }

  grantOf(id: string): CapabilityGrant | undefined {
    return this.organs.get(id)?.grant
  }

  /* ---------------------------- 反馈目标 ---------------------------- */

  useFeedbackTarget(target: FeedbackTarget): Disposer {
    const key = typeof target?.key === 'string' ? target.key : ''
    if (!KEY_RE.test(key)) {
      this.deps.log.warn('反馈目标键「%s」不合规，拒绝登记', key)
      return () => {}
    }
    if (typeof target.apply !== 'function') {
      this.deps.log.warn('反馈目标「%s」没有 apply，拒绝登记', key)
      return () => {}
    }
    if (this.targetMap.has(key)) {
      // 不覆盖：覆盖会让先登记者的写入悄悄落到别人家里。
      this.deps.log.warn('反馈目标「%s」已被登记，本次不覆盖（先撤销旧的）', key)
      return () => {}
    }
    this.targetMap.set(key, target)
    return () => {
      if (this.targetMap.get(key) === target) this.targetMap.delete(key)
    }
  }

  targets(): readonly string[] {
    return Object.freeze([...this.targetMap.keys()].sort())
  }

  useStateSource(id: string, read: (at: number) => unknown): Disposer {
    if (!KEY_RE.test(id)) {
      this.deps.log.warn('状态源 id「%s」不合规，拒绝登记', id)
      return () => {}
    }
    if (this.sources.has(id)) {
      this.deps.log.warn('状态源「%s」已被登记，本次不覆盖', id)
      return () => {}
    }
    this.sources.set(id, read)
    return () => {
      if (this.sources.get(id) === read) this.sources.delete(id)
    }
  }

  /* ---------------------------- 反馈仲裁 ---------------------------- */

  feedback(organId: string, deltas: readonly FeedbackDelta[]): FeedbackQueueResult {
    const settings = this.deps.settings()
    const record = this.organs.get(organId)
    if (record === undefined) {
      // 没注册的器官提建议：不收，但也不抛（随时可能被卸载）。
      return {
        queued: 0,
        rejected: Object.freeze(deltas.map(item => ({ target: textOf(item?.target), reason: 'bad-target' as const }))),
      }
    }
    const result = enqueue(organId, deltas, Math.max(0, settings.maxPending - this.queue.length))
    this.queue.push(...result.accepted)
    if (result.rejected.length > 0) {
      record.counters.droppedDeltas += result.rejected.length
      this.counters.droppedDeltas += result.rejected.length
    }
    return { queued: result.queued, rejected: result.rejected }
  }

  flush(reason = 'manual'): FeedbackReport {
    const at = this.deps.now()
    // 先清再应用：见文件头第 3 条。
    const pending = this.queue
    this.queue = []

    const buckets = bucketize(pending)
    const shaped = applyBuckets(buckets, this.targetMap)

    this.counters.flushes += 1
    this.counters.appliedDeltas += shaped.applied
    this.counters.clampedDeltas += shaped.clamped
    this.counters.droppedDeltas += shaped.dropped
    this.counters.sinkErrors += shaped.sinkErrors
    const droppedNoSink = shaped.items.filter(item => item.outcome === 'no-sink').length

    // 计数回写到参与的器官（按 by 归属，一条记录可能算给多个器官）。
    for (const item of shaped.items) {
      for (const organId of item.by) {
        const record = this.organs.get(organId)
        if (record === undefined) continue
        if (item.outcome === 'applied' || item.outcome === 'clamped') {
          if (item.outcome === 'clamped') record.counters.clampedDeltas += 1
          else record.counters.appliedDeltas += 1
        } else {
          record.counters.droppedDeltas += 1
        }
      }
    }

    if (droppedNoSink > 0) {
      this.deps.log.warn(
        '反馈有 %d 个目标没有持有者（已丢弃）：%s',
        droppedNoSink,
        shaped.items.filter(item => item.outcome === 'no-sink').map(item => item.target).join('、'),
      )
    }
    if (shaped.sinkErrors > 0) {
      this.deps.log.error('反馈有 %d 个目标的持有者抛错（已丢弃本条，不重试）', shaped.sinkErrors)
    }

    return {
      at,
      reason,
      targets: buckets.size,
      applied: shaped.applied,
      clamped: shaped.clamped,
      dropped: shaped.dropped,
      items: shaped.items,
    }
  }

  /* ---------------------------- 提示词拼装 ---------------------------- */

  prompt(options: PromptOptions = {}): PromptAssembly {
    const settings = this.deps.settings()
    const at = this.deps.now()
    const drafts: AttributedDraft[] = []
    const failedProviders: string[] = []

    for (const record of this.organs.values()) {
      for (const provider of record.promptProviders) {
        try {
          const list = provider(at)
          if (!Array.isArray(list)) {
            failedProviders.push(record.manifest.id)
            continue
          }
          for (const draft of list) {
            drafts.push({ organId: record.manifest.id, spec: record.manifest.prompt, draft })
          }
        } catch (error) {
          // C3：器官抛错不得传播。
          record.counters.errors += 1
          record.state = 'degraded'
          failedProviders.push(record.manifest.id)
          this.deps.log.warn('器官「%s」取提示词片段时抛错（已转 degraded）：%s', record.manifest.id, textOf(error))
        }
      }
    }

    const output = assemble({
      drafts,
      at,
      minConfidence: options.minConfidence ?? settings.minConfidence,
      maxFragments: options.maxFragments ?? settings.maxFragments,
      maxCharsPerFragment: settings.maxCharsPerFragment,
      failedProviders,
    })

    // 每个器官自己的片段计数（成功注入 / 被丢）。
    for (const item of output.fragments) {
      const record = this.organs.get(item.organId)
      if (record !== undefined) record.counters.fragments += 1
    }
    for (const item of output.dropped) {
      const record = this.organs.get(item.organId)
      if (record !== undefined) record.counters.droppedFragments += 1
    }
    this.counters.fragments += output.fragments.length
    this.counters.droppedFragments += output.dropped.length

    if (settings.verbose) {
      this.deps.log.info(
        '拼装提示词：采纳 %d 片 / 丢弃 %d 片，共 %d 字',
        output.fragments.length,
        output.dropped.length,
        output.chars,
      )
    }

    return {
      at,
      text: output.text,
      fragments: output.fragments,
      dropped: output.dropped,
      chars: output.chars,
    }
  }

  /* ---------------------------- 广播 ---------------------------- */

  tick(at = this.deps.now()): TickReport {
    let called = 0
    let failed = 0
    for (const record of this.organs.values()) {
      for (const handler of record.tickHandlers) {
        called += 1
        try {
          handler(at)
          record.counters.ticks += 1
        } catch (error) {
          failed += 1
          record.counters.errors += 1
          record.state = 'degraded'
          this.deps.log.warn('器官「%s」的心跳处理器抛错（已吞掉，转 degraded）：%s', record.manifest.id, textOf(error))
        }
      }
    }
    return { at, organs: this.organs.size, called, failed }
  }

  toolResult(result: ToolResultView): ToolResultReport {
    let called = 0
    let failed = 0
    for (const record of this.organs.values()) {
      for (const handler of record.toolHandlers) {
        called += 1
        try {
          handler(result)
          record.counters.toolResults += 1
        } catch (error) {
          failed += 1
          record.counters.errors += 1
          record.state = 'degraded'
          this.deps.log.warn('器官「%s」的工具结果处理器抛错（已吞掉）：%s', record.manifest.id, textOf(error))
        }
      }
    }
    return { at: this.deps.now(), called, failed }
  }

  signal(signal: string, payload?: unknown): number {
    const set = this.signals.get(signal)
    this.counters.signals += 1
    if (set === undefined) return 0
    let delivered = 0
    for (const handler of set) {
      try {
        handler(payload, 'host')
        delivered += 1
      } catch (error) {
        // 一个听众抛错不影响其他听众。
        this.deps.log.warn('信号「%s」的听众抛错（已忽略）：%s', signal, textOf(error))
      }
    }
    return delivered
  }

  on(signal: string, fn: (payload: unknown, from: string) => void): Disposer {
    if (!KEY_RE.test(signal)) {
      this.deps.log.warn('信号名「%s」不合规，拒绝监听', signal)
      return () => {}
    }
    let set = this.signals.get(signal)
    if (set === undefined) {
      set = new Set()
      this.signals.set(signal, set)
    }
    const target = set
    target.add(fn)
    return () => {
      target.delete(fn)
      if (target.size === 0) this.signals.delete(signal)
    }
  }

  /* ---------------------------- 遥测 ---------------------------- */

  stats(): OrganStats {
    // degraded 现数不累加：同一器官两次抛错只该算一次，累加器对不平。
    let degraded = 0
    for (const record of this.organs.values()) {
      if (record.state === 'degraded') degraded += 1
    }
    return {
      at: this.deps.now(),
      chargeMode: this.chargeMode,
      organs: this.organs.size,
      receipts: this.counters.receipts,
      denied: this.counters.denied,
      starved: this.counters.starved,
      degraded,
      fragments: this.counters.fragments,
      droppedFragments: this.counters.droppedFragments,
      flushes: this.counters.flushes,
      appliedDeltas: this.counters.appliedDeltas,
      clampedDeltas: this.counters.clampedDeltas,
      droppedDeltas: this.counters.droppedDeltas,
      sinkErrors: this.counters.sinkErrors,
      signals: this.counters.signals,
      targets: this.targetMap.size,
      pending: this.queue.length,
    }
  }

  snapshot(): readonly OrganSnapshot[] {
    const out: OrganSnapshot[] = []
    for (const id of this.ids()) {
      const record = this.organs.get(id)!
      out.push({
        id,
        version: record.manifest.version,
        title: record.manifest.title,
        state: record.state,
        grant: record.grant,
        lastReceipt: record.lastReceipt,
        counters: Object.freeze({ ...record.counters }),
      })
    }
    return Object.freeze(out)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const id of [...this.organs.keys()]) this.unregister(id)
    this.targetMap.clear()
    this.sources.clear()
    this.signals.clear()
    this.queue = []
  }

  /* ---------------------------- 内部 ---------------------------- */

  /**
   * 判一项能力，没有就抛（default-deny）。
   * @param record 器官记录。
   * @param capability 能力名。
   * @param method 方法名（只进日志）。
   */
  private need(record: OrganRecord, capability: Capability, method: string): void {
    if (record.grant.granted.includes(capability)) return
    record.counters.capabilityDenied += 1
    this.deps.log.warn(
      '器官「%s」调用 %s() 被拒：没有能力「%s」',
      record.manifest.id,
      method,
      capability,
    )
    throw new CapabilityDeniedError(record.manifest.id, capability)
  }

  /**
   * 造门面。**只放十个成员**（手册 §8.1 逐字）。
   * @param record 器官记录。
   */
  private buildFacade(record: OrganRecord): OrganFacade {
    // 保留 `this` 别名：下面 kv / log / 门面都用**方法简写**，简写里的 `this`
    // 指向那个对象字面量而不是本服务，所以必须把这层的 `this` 先存下来。
    // oxlint-disable-next-line typescript/no-this-alias
    const host = this
    const id = record.manifest.id

    const assertAlive = (): void => {
      if (!record.alive) throw new Error('器官「' + id + '」已卸载：门面不可再用')
    }

    const kv: OrganKv = {
      get<T = unknown>(key: string): T | undefined {
        assertAlive()
        return record.store.get(key) as T | undefined
      },
      set(key: string, value: unknown): boolean {
        assertAlive()
        const limit = host.deps.settings().kvLimit
        if (!record.store.has(key) && record.store.size >= limit) {
          // 到上限不淘汰别人的键：悄悄删数据比写不进去糟（同 O-007 的口径）。
          return false
        }
        record.store.set(key, value)
        return true
      },
      delete(key: string): boolean {
        assertAlive()
        return record.store.delete(key)
      },
      keys(): readonly string[] {
        assertAlive()
        return Object.freeze([...record.store.keys()].sort())
      },
      get size(): number {
        return record.store.size
      },
    }

    const log: LogLike = {
      info(message: string, ...args: readonly unknown[]): void {
        recordLog(host.deps.log, 'info', record.manifest.id, message, args)
      },
      warn(message: string, ...args: readonly unknown[]): void {
        recordLog(host.deps.log, 'warn', record.manifest.id, message, args)
      },
      error(message: string, ...args: readonly unknown[]): void {
        recordLog(host.deps.log, 'error', record.manifest.id, message, args)
      },
    }

    return {
      id,
      grant: record.grant,

      state(): OrganStateView {
        assertAlive()
        host.need(record, 'state.read', 'state')
        const settings = host.deps.settings()
        const receipt = record.lastReceipt
        if (settings.enforceReceipt) {
          if (receipt === undefined) throw new ReceiptRequiredError(id, 'missing')
          if (receipt.denied) throw new PerceptionDeniedError(id)
          if (host.deps.now() >= receipt.expiresAt) throw new ReceiptRequiredError(id, 'expired')
        } else if (receipt === undefined) {
          // 免扣钱，但不免「申请过」：见文件头第 2 条。
          throw new ReceiptRequiredError(id, 'missing')
        }

        const at = host.deps.now()
        const emotion = host.deps.emotion()
        let emotionView: EmotionView | undefined
        if (emotion !== undefined) {
          try {
            const snap = emotion.state(at)
            // 浅拷贝 + 冻结：器官拿不到持有者的对象引用（C1 第一道物理防线）。
            emotionView = {
              at: snap.at,
              axes: Object.freeze({ ...snap.axes }),
              labels: Object.freeze({ ...snap.labels }),
            }
          } catch (error) {
            host.deps.log.warn('读情绪快照失败（本次不给 emotion）：%s', textOf(error))
          }
        }

        const values: Record<string, unknown> = {}
        for (const [sourceId, read] of host.sources) {
          try {
            values[sourceId] = read(at)
          } catch (error) {
            // 一个源坏了不该让整份状态读不出来。
            values[sourceId] = undefined
            host.deps.log.warn('状态源「%s」读取失败：%s', sourceId, textOf(error))
          }
        }

        return { at, emotion: emotionView, values: Object.freeze(values) }
      },

      consume(units?: number): EnergyReceipt {
        assertAlive()
        const settings = host.deps.settings()
        const at = host.deps.now()
        const requested = normalizeCost(units === undefined ? record.manifest.energy.cost : units)
        const source = host.deps.energySource()
        let remaining: number | undefined
        if (source !== undefined && settings.chargeMode === 'additive') {
          try {
            remaining = source.energy(at).energy
          } catch (error) {
            // 读不到剩余就当没有能量源：不假装饥饿（见 energy.ts 文件头）。
            remaining = undefined
            host.deps.log.warn('读能量失败，本次按「没有能量源」处理：%s', textOf(error))
          }
        }

        let quote = quoteEnergy({ requested, remaining, mode: settings.chargeMode })

        // 真扣：只有 additive 且确实要扣时才动别人的状态。
        if (quote.charged > 0 && source !== undefined && remaining !== undefined) {
          try {
            source.feed(-quote.charged, at)
            // 回执里的「剩余」必须是扣后值：报扣前值会让下一个器官高估预算。
            remaining = Math.max(0, remaining - quote.charged)
          } catch (error) {
            quote = failedCharge(quote)
            host.deps.log.warn('扣能量失败（本次感知按未付款处理）：%s', textOf(error))
          }
        }

        const receipt: EnergyReceipt = Object.freeze({
          organId: id,
          requested,
          charged: quote.charged,
          remaining,
          state: quote.state,
          denied: quote.denied,
          mode: settings.chargeMode,
          reason: quote.reason,
          at,
          expiresAt: at + settings.receiptTtlMs,
        })

        record.lastReceipt = receipt
        record.counters.receipts += 1
        host.counters.receipts += 1
        if (quote.denied) {
          record.counters.denied += 1
          host.counters.denied += 1
        }
        if (quote.state === 'starved') {
          record.counters.starved += 1
          host.counters.starved += 1
        }
        if (quote.state === 'partial') record.counters.partial += 1
        if (quote.state === 'shadow') record.counters.shadow += 1

        if (quote.state === 'starved') {
          // 饥饿降级是特性不是故障（§8.2）：日志要说「累了」，不说「坏了」。
          host.deps.log.warn('器官「%s」饿了：本次感知被拒（denied），必须放弃', id)
        } else if (quote.state === 'partial') {
          host.deps.log.info('器官「%s」只付得起 %d / %d：请缩小本次感知范围', id, quote.charged, requested)
        }

        return receipt
      },

      emit(signalName: string, payload?: unknown): void {
        assertAlive()
        host.need(record, 'emit', 'emit')
        host.signal(signalName, payload)
      },

      proposeGap(input: OrganGapInput): GapProposalResult {
        assertAlive()
        host.need(record, 'gap.propose', 'proposeGap')
        const gap = host.deps.gap()
        if (gap === undefined) return { accepted: false, reason: 'no-service' }
        const source = input?.source
        if (typeof source !== 'string' || !(GAP_SOURCES as readonly string[]).includes(source)) {
          // 三源是闭合集，不许加 `todo`（O-129 的口径）。给别的值一律拒收，不猜。
          host.deps.log.warn('器官「%s」提缺口用了未知来源「%s」：拒收', id, textOf(source))
          return { accepted: false, reason: 'bad-source' }
        }
        record.counters.proposals += 1
        try {
          const result = gap.open({ text: input.text, source, query: input.query, note: input.note })
          if (!result.accepted) return { accepted: false, reason: 'refused' }
          return { accepted: true, id: result.gap?.id }
        } catch (error) {
          host.deps.log.warn('器官「%s」提缺口时 O-129 抛错：%s', id, textOf(error))
          return { accepted: false, reason: 'threw' }
        }
      },

      onToolResult(fn: (result: ToolResultView) => void): Disposer {
        assertAlive()
        host.need(record, 'tool.result', 'onToolResult')
        record.toolHandlers.add(fn)
        const dispose = (): void => {
          record.toolHandlers.delete(fn)
        }
        record.disposers.push(dispose)
        return dispose
      },

      onTick(fn: (at: number) => void): Disposer {
        assertAlive()
        host.need(record, 'tick', 'onTick')
        record.tickHandlers.add(fn)
        const dispose = (): void => {
          record.tickHandlers.delete(fn)
        }
        record.disposers.push(dispose)
        return dispose
      },

      registerTool(tool: OrganToolSpec): Disposer {
        assertAlive()
        host.need(record, 'tool.register', 'registerTool')
        const tools = host.deps.tools()
        if (tools === undefined) {
          host.deps.log.warn('器官「%s」想注册工具，但宿主没有 tools 服务：跳过', id)
          return () => {}
        }
        const toolName = typeof tool?.name === 'string' ? tool.name : ''
        if (!KEY_RE.test(toolName)) {
          // 工具名不合规，模型侧会直接拒绝（§8.4 事故教训）：本地先拦。
          host.deps.log.warn('器官「%s」想注册的工具名「%s」不合规：拒绝', id, toolName)
          return () => {}
        }
        try {
          const dispose = tools.register({
            name: toolName,
            description: tool.description,
            parameters: tool.parameters,
            execute: tool.execute,
          })
          const wrapped = (): void => {
            try {
              dispose()
            } catch (error) {
              host.deps.log.warn('器官「%s」的工具撤销器抛错：%s', id, textOf(error))
            }
          }
          record.disposers.push(wrapped)
          return wrapped
        } catch (error) {
          host.deps.log.warn('器官「%s」注册工具「%s」失败：%s', id, toolName, textOf(error))
          return () => {}
        }
      },

      onPrompt(fn: (at: number) => readonly OrganPromptDraft[]): Disposer {
        assertAlive()
        host.need(record, 'prompt.fragment', 'onPrompt')
        record.promptProviders.add(fn)
        const dispose = (): void => {
          record.promptProviders.delete(fn)
        }
        record.disposers.push(dispose)
        return dispose
      },

      kv,
      log,
    }
  }
}

/**
 * 器官自己打日志时的包装：加命名空间、吞掉日志本身的错误。
 * @param base 宿主日志。
 * @param level 级别。
 * @param organId 器官 id。
 * @param message 正文。
 * @param args 参数。
 */
function recordLog(
  base: LogLike,
  level: 'info' | 'warn' | 'error',
  organId: string,
  message: string,
  args: readonly unknown[],
): void {
  try {
    base[level]('器官「' + organId + '」：' + message, ...args)
  } catch {
    // 日志写不出去不该把器官的调用路径搞崩。
  }
}

/**
 * 校验清单（注册期）。
 * @param manifest 清单。
 */
function assertManifest(manifest: OrganManifest): void {
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new OrganManifestError('version', '必须是非空字符串')
  }
  if (!Array.isArray(manifest.capabilities)) {
    throw new OrganManifestError('capabilities', '必须是数组（可以空，但不能省）')
  }
  const energy = manifest.energy
  if (energy === undefined || typeof energy !== 'object') {
    throw new OrganManifestError('energy', '必须给出报价单（C2 要求器官为自己的感知付能量）')
  }
  if (typeof energy.cost !== 'number' || !Number.isFinite(energy.cost) || energy.cost < 0 || energy.cost > 100) {
    throw new OrganManifestError('energy.cost', '必须是 0–100 的有限数')
  }
  const prompt = manifest.prompt
  if (prompt !== undefined) {
    if (typeof prompt.order !== 'number' || !Number.isFinite(prompt.order)) {
      throw new OrganManifestError('prompt.order', '必须是有限数')
    }
    if (prompt.ttlMs !== undefined && (typeof prompt.ttlMs !== 'number' || !Number.isFinite(prompt.ttlMs) || prompt.ttlMs <= 0)) {
      throw new OrganManifestError('prompt.ttlMs', '给就必须是正数（省略表示不过期）')
    }
    if (prompt.confidence !== undefined && (typeof prompt.confidence !== 'number' || !Number.isFinite(prompt.confidence))) {
      throw new OrganManifestError('prompt.confidence', '给就必须是 0–1 的有限数')
    }
  }
}

/**
 * 把任意值折成一句文本。
 * @param value 值。
 */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  return String(value)
}
