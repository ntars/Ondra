/**
 * 做梦的门面（**唯一对外实现** `DreamService` 的类）。
 *
 * 四件事在这里收口：
 *
 * 1. **分支只选一次。** `mode` 在构造时定死，运行期不变（§14.2「分支由配置选择，
 *    互不共享可变状态」）。`run()` 发现入参的 `mode` 与配置不一致时返回
 *    `mode-mismatch`，**不偷偷按配置跑**——那会让调用方以为「我传的 surreal 生效了」。
 * 2. **可用性按分支算。** `gate` 没有模型网关就是不可用（它只负责「拒」，不负责「想」）；
 *    `lightweight` 没有模型也照跑（那是它存在的理由）；`surreal` 没有模型只少梦话。
 * 3. **权重只算不存。** 卡片的 `0.5^(闲置小时/168)` 是闭式函数，算一次与算一百次一样。
 *    存一份就会出现「库里写着 0.42、算出来 0.31」两个答案。
 * 4. **归档是算出来的。** `cards()` 不写库（读接口写库是最容易被忽视的一类副作用）。
 */

import { GateBranch } from './branches/gate.js'
import { LightweightBranch } from './branches/lightweight.js'
import { SurrealBranch } from './branches/surreal.js'
import { dateKey } from './quote.js'
import { toDreamCard } from './store.js'
import { DreamError } from './types.js'
import type {
  BranchContext,
  CardRow,
  DedupeLike,
  DreamBranch,
  DreamCard,
  DreamCounters,
  DreamInput,
  DreamIssue,
  DreamLogEntry,
  DreamLogPort,
  DreamMode,
  DreamReport,
  DreamService,
  DreamStats,
  DreamTalk,
  DreamUnavailableReason,
  GatewayLike,
  GraphLike,
  LogLike,
  MemoryCoreLike,
  SnapshotLike,
} from './types.js'
import type { Config } from './settings.js'

/** 问题列表上限。 */
const MAX_ISSUES = 20

/** 历史条数的默认上限。 */
const DEFAULT_HISTORY = 20

/** 做梦服务实现。 */
export class DreamRepository implements DreamService {
  /** 是否可用。 */
  readonly available: boolean
  /** 不可用原因。 */
  readonly reason?: DreamUnavailableReason
  /** 当前分支。 */
  readonly mode: DreamMode

  private readonly branch: DreamBranch
  private readonly context: BranchContext
  private readonly log: LogLike
  private readonly now: () => number
  private readonly issues: DreamIssue[] = []

  private counters: DreamCounters = Object.freeze({
    runs: 0,
    facts: 0,
    rejected: 0,
    cards: 0,
    talk: 0,
    edges: 0,
  })

  /**
   * @param core 记忆内核。
   * @param gateway 模型网关。
   * @param graph 图谱。
   * @param dedupe 判重。
   * @param snapshot 快照。
   * @param store 记账端口。
   * @param settings 配置。
   * @param log 日志。
   * @param now 时间源。
   */
  constructor(
    core: MemoryCoreLike | undefined,
    gateway: GatewayLike | undefined,
    graph: GraphLike | undefined,
    dedupe: DedupeLike | undefined,
    snapshot: SnapshotLike | undefined,
    store: DreamLogPort,
    settings: Config,
    log: LogLike,
    now: () => number,
  ) {
    this.log = log
    this.now = now
    this.mode = settings.mode

    const modelOk = gateway !== undefined && gateway.available
    const coreOk = core !== undefined && core.available

    if (!settings.enable) {
      this.available = false
      this.reason = 'disabled'
    } else if (core === undefined) {
      this.available = false
      this.reason = 'no-core'
    } else if (!coreOk) {
      this.available = false
      this.reason = 'core-unavailable'
    } else if (settings.mode === 'gate' && !modelOk) {
      // 闸式做梦没有模型就什么都做不了：四道闸只负责拒，不负责想。
      this.available = false
      this.reason = 'no-model'
    } else {
      this.available = true
      this.reason = undefined
    }

    if (this.reason === 'no-core') {
      this.pushIssue({ code: 'no-core', detail: '没有记忆内核（ondra-memory-core）：三个分支都做不了' })
    } else if (this.reason === 'core-unavailable') {
      this.pushIssue({ code: 'core-unavailable', detail: '记忆内核在位但不可用（建表失败或端口已关）' })
    } else if (this.reason === 'no-model') {
      this.pushIssue({
        code: 'no-model',
        detail: '闸式做梦需要模型网关（ondra-llm-gateway）：没有它就只能拒、不能想。想零模型调用请把 mode 改成 lightweight',
      })
    }

    if (!modelOk) {
      this.pushIssue({
        code: 'no-model',
        detail: '没有模型网关：闸式分支不可用、荒诞分支没有梦话、轻量分支不受影响',
      })
    }
    if (!store.available) {
      this.pushIssue({ code: 'no-store', detail: '没有存储端口：做梦记账、梦话与卡片都不落盘' })
    }
    if (graph === undefined || !graph.available) {
      this.pushIssue({ code: 'no-graph', detail: '没有图谱服务：荒诞联想建不了边（另两个分支不受影响）' })
    }
    if (dedupe === undefined || !dedupe.available) {
      this.pushIssue({
        code: 'no-dedupe',
        detail: '没有判重服务（ondra-memory-dream 的重复拒降级为「同批去重 + 墓碑」）：不自己写包含度阈值，那是第二把尺子',
      })
    }

    this.branch = settings.mode === 'lightweight' ? new LightweightBranch() : settings.mode === 'surreal' ? new SurrealBranch() : new GateBranch()

    this.context = {
      core,
      gateway,
      graph,
      dedupe,
      snapshot,
      store,
      settings,
      log,
      now,
      report: issue => this.pushIssue(issue),
    }
  }

  /* ------------------------------ 做梦 ------------------------------ */

  /**
   * 做一场梦。
   * @param input 入参。
   */
  async run(input: DreamInput): Promise<DreamReport> {
    assertInput(input)
    const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : this.now()
    const date = dateKey(at)
    const mode = input.mode

    if (mode !== this.mode) {
      // 不偷偷按配置跑：那会让调用方以为「我传的 surreal 生效了」。
      return Object.freeze({
        ok: false,
        reason: 'mode-mismatch' as const,
        mode: this.mode,
        at,
        date,
        candidates: 0,
        written: Object.freeze([]),
        rejected: Object.freeze([]),
        cards: Object.freeze([]),
        talk: Object.freeze([]),
        edges: 0,
        backup: 'skipped' as const,
        logged: false,
        note: `入参分支是 ${mode}，但配置的分支是 ${this.mode}（分支在装载时定死，运行期不切）`,
      })
    }

    if (!this.available) {
      return Object.freeze({
        ok: false,
        reason: this.reason,
        mode: this.mode,
        at,
        date,
        candidates: 0,
        written: Object.freeze([]),
        rejected: Object.freeze([]),
        cards: Object.freeze([]),
        talk: Object.freeze([]),
        edges: 0,
        backup: 'skipped' as const,
        logged: false,
        note: this.unavailableNote(),
      })
    }

    let report: DreamReport
    try {
      report = await this.branch.run(input, at, this.context)
    } catch (error) {
      // C3 同型纪律：分支异常不往上抛（它跑在夜间任务里，抛出去没人接）。
      const message = error instanceof Error ? error.message : String(error)
      this.pushIssue({ code: 'gateway-failed', detail: `分支异常已拦下：${message}` })
      this.log.error('做梦分支异常（%s）：%s', this.mode, message)
      return Object.freeze({
        ok: false,
        reason: 'core-unavailable' as const,
        mode: this.mode,
        at,
        date,
        candidates: 0,
        written: Object.freeze([]),
        rejected: Object.freeze([]),
        cards: Object.freeze([]),
        talk: Object.freeze([]),
        edges: 0,
        backup: 'failed' as const,
        logged: false,
        note: `分支异常，这一晚没做梦（${message}）`,
      })
    }

    this.counters = Object.freeze({
      runs: this.counters.runs + 1,
      facts: this.counters.facts + report.written.length,
      rejected: this.counters.rejected + report.rejected.length,
      cards: this.counters.cards + report.cards.length,
      talk: this.counters.talk + report.talk.length,
      edges: this.counters.edges + report.edges,
    })

    return report
  }

  /* ------------------------------ 梦话 ------------------------------ */

  talk(): readonly DreamTalk[] {
    return this.context.store.pendingTalk()
  }

  consume(ids: readonly string[], at?: number): number {
    const stamp = typeof at === 'number' && Number.isFinite(at) ? at : this.now()
    return this.context.store.consumeTalk(ids, stamp)
  }

  /* ------------------------------ 卡片 ------------------------------ */

  cards(at?: number): readonly DreamCard[] {
    const stamp = typeof at === 'number' && Number.isFinite(at) ? at : this.now()
    const halfLife = this.context.settings.cardHalfLifeHours
    const floor = this.context.settings.cardArchiveWeight

    const rows = this.context.store.listCards()
    const cards = rows.map((row: CardRow) => {
      const weight = cardWeight(row, stamp, halfLife)
      return toDreamCard(row, weight, weight < floor)
    })

    // 权重降序 → 创建时间降序 → id 升序（三级全序，界面刷新不换序）。
    cards.sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight
      if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt
      return left.id < right.id ? -1 : 1
    })

    return Object.freeze(cards)
  }

  useCard(id: string, at?: number): boolean {
    const stamp = typeof at === 'number' && Number.isFinite(at) ? at : this.now()
    return this.context.store.useCard(id, stamp)
  }

  /* ------------------------------ 记账与统计 ------------------------------ */

  history(limit?: number): readonly DreamLogEntry[] {
    const size = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : DEFAULT_HISTORY
    return this.context.store.recentDreams(size)
  }

  stats(): DreamStats {
    const cards = this.cards()
    let facts = 0
    if (this.context.core !== undefined && this.context.core.available) {
      try {
        facts = this.context.core.countFacts()
      } catch (error) {
        this.log.warn('统计记忆条数失败：%s', error instanceof Error ? error.message : String(error))
      }
    }

    const dedupe = this.context.dedupe
    return Object.freeze({
      available: this.available,
      reason: this.reason,
      mode: this.mode,
      counters: this.counters,
      facts,
      pendingTalk: this.talk().length,
      liveCards: cards.filter(card => !card.archived).length,
      dedupeGate: dedupe !== undefined && dedupe.available ? 'service' : 'local',
      snapshotAvailable: this.context.snapshot !== undefined && this.context.snapshot.available,
      graphAvailable: this.context.graph !== undefined && this.context.graph.available,
      issues: Object.freeze([...this.issues]),
    })
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 不可用的一句话。 */
  private unavailableNote(): string {
    if (this.reason === 'disabled') return '记忆做梦已关闭（enable=false）'
    if (this.reason === 'no-core') return '没有记忆内核（ondra-memory-core）'
    if (this.reason === 'core-unavailable') return '记忆内核在位但不可用'
    if (this.reason === 'no-model') return '闸式做梦需要模型网关（ondra-llm-gateway），当前不可用'
    return '不可用'
  }

  /** 记一条问题（同码同 id 只留一条，避免每次调用刷屏）。 */
  private pushIssue(issue: DreamIssue): void {
    const exists = this.issues.some(item => item.code === issue.code && item.id === issue.id)
    if (exists) return
    if (this.issues.length >= MAX_ISSUES) {
      if (!this.issues.some(item => item.code === 'too-many-issues')) {
        this.issues.push({ code: 'too-many-issues', detail: `问题已超过 ${MAX_ISSUES} 条，后续同类不再记录` })
      }
      return
    }
    this.issues.push(issue)
  }
}

/**
 * 卡片权重：`0.5^(闲置小时 / 半衰期)`。
 *
 * 闲置起点是「最近一次被用到」，没用过就退回创建时刻。
 * **不存库**：闭式函数算一次与算一百次结果一样（O-013 已经踩过「存游标」的坑）。
 * @param row 卡片行。
 * @param at 时间戳。
 * @param halfLifeHours 半衰期（小时）。
 */
export function cardWeight(row: CardRow, at: number, halfLifeHours: number): number {
  const start = row.lastUsedAt > 0 ? row.lastUsedAt : row.createdAt
  const idleHours = Math.max(0, (at - start) / 3_600_000)
  const halfLife = halfLifeHours > 0 ? halfLifeHours : 168
  return Math.pow(0.5, idleHours / halfLife)
}

/** 判一个入参是不是做梦入参（服务入口用，避免把 `undefined` 传进分支）。 */
export function assertInput(input: DreamInput): void {
  if (typeof input !== 'object' || input === null) {
    throw new DreamError('bad-request', 'run() 的入参必须是对象')
  }
  // 先取成 unknown 再判：`DreamInput` 是判别联合，直接在条件里排除全部 mode 会把 input 收窄成 never。
  const mode: unknown = input.mode
  if (mode !== 'gate' && mode !== 'surreal' && mode !== 'lightweight') {
    throw new DreamError('bad-request', `run() 的 mode 必须是 gate / surreal / lightweight，收到「${String(mode)}」`)
  }
}
