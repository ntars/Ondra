/**
 * 门面：**两阶段记账 + 释放已见**。
 *
 * ```
 *   begin(req)
 *     ├─ 嗅压缩（读 O-033 计数器，单会话才动手）
 *     ├─ 同会话旧未决批次作废（一轮只能有一个未决批次）
 *     ├─ 账本 → seen 集合 → O-036 装箱
 *     └─ 出 DedupeBatch（文本 + 待记账键）
 *
 *   commit(batchId)   ── 真发出去了 → 记账
 *   discard(batchId)  ── 没发出去   → 不留痕
 *   release(reason)   ── 压缩/换会话 → 账本清空（**同时作废该会话的未决批次**）
 * ```
 *
 * ## 三条最容易写错的
 *
 * 1. **`release()` 必须先把该会话的未决批次作废。** 忘了这一步的后果很安静：
 *    压缩释放之后紧跟一次 `commit()`（那一轮本来就该提交），把压缩前的 id 又记回去，
 *    释放白做——而日志里两条都写着成功。
 *
 * 2. **同会话只留一个未决批次。** 一轮同时只有一个回合在跑（O-033 的 `busy` 门），
 *    所以同会话出现第二个 `begin()` 只能说明上一个回合没走完、也没 `discard`。
 *    此时旧批次**不可能再被正当地提交**（它那轮的上下文已经不在了），留着只会
 *    让一次迟到的 `commit()` 把没发出去的东西记成「说过了」。故直接作废并计数。
 *
 * 3. **降级走「放行」不走「半块」。** 装箱抛错时 `text` 为空、`state = 'degraded'`，
 *    调用方会走原路径整块注入。宁可这轮多花 8000 字重复一遍，也不能因为
 *    「去重器坏了」让她这轮什么都想不起来——**多花字是钱，忘事是产品**。
 */

import { LedgerBook, idsOfKey, keyOfId } from './ledger.js'
import type { Config } from './settings.js'
import { conversationKey } from './settings.js'
import type {
  BatchState,
  BeginRequest,
  CommitFailure,
  CommitOutcome,
  DedupeBatch,
  DedupeReason,
  DedupeService,
  DedupeStats,
  DiscardOutcome,
  LedgerSnapshot,
  LogLike,
  ReleaseOutcome,
  ReleaseReason,
  RenderedLike,
  Sources,
} from './types.js'

/** 服务依赖。 */
export interface DedupeDeps {
  /** 生效配置。 */
  readonly settings: Config
  /** 日志。 */
  readonly log: LogLike
  /** 上游取值函数（每次现取，能自愈）。 */
  readonly sources: Sources
  /** 当前时刻（注入便于对拍）。 */
  readonly now: () => number
}

/** 未决批次。 */
interface PendingBatch {
  readonly conversationId: string
  readonly keys: readonly string[]
  readonly at: number
}

/**
 * 可达计数器。
 *
 * 刻意**不加 `readonly`**：写成 `Readonly<Counters>` 再 `+=` 会直接 TS2540，
 * 而那类错在括号/结构检查里完全看不出来（见 O-123 的教训）。
 */
interface Counters {
  commits: number
  injected: number
  suppressed: number
  emptyTurns: number
  releases: number
  superseded: number
  degraded: number
  ambiguousCompactions: number
  lastAt: number
}

/** 嗅压缩的结果。 */
type CompactionSignal =
  | { readonly kind: 'none' }
  | { readonly kind: 'released'; readonly released: number }
  | { readonly kind: 'ambiguous' }

/** 取错误消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 去重（保持首次出现顺序）。 */
function uniqueKeys(ids: readonly string[]): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const key = keyOfId(id)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

/** 造一个「没起作用」的空批次（`bypassed` / `degraded` 共用形状）。 */
export function idleBatch(
  conversationId: string,
  state: BatchState,
  note: string,
): DedupeBatch {
  return Object.freeze({
    batchId: 0,
    conversationId,
    state,
    text: '',
    chars: 0,
    ids: Object.freeze([]) as readonly string[],
    keys: Object.freeze([]) as readonly string[],
    suppressed: 0,
    dropped: 0,
    overBudget: false,
    firstOfSession: false,
    digest: '',
    released: null,
    note,
  })
}

/** 注入去重服务实现。 */
export class Dedupe implements DedupeService {
  private readonly book: LedgerBook
  private readonly pending = new Map<number, PendingBatch>()
  private readonly counters: Counters = {
    commits: 0,
    injected: 0,
    suppressed: 0,
    emptyTurns: 0,
    releases: 0,
    superseded: 0,
    degraded: 0,
    ambiguousCompactions: 0,
    lastAt: 0,
  }

  private nextBatchId = 1
  /** 上一次看到的压缩计数；`undefined` = 还没建立基线。 */
  private lastCompactions: number | undefined

  /** @param deps 依赖。 */
  constructor(private readonly deps: DedupeDeps) {
    this.book = new LedgerBook(deps.settings.maxSeenPerConversation, deps.settings.maxConversations)
  }

  /** 是否可用（每次现取）。 */
  get available(): boolean {
    return this.reason === undefined
  }

  /** 不可用原因。 */
  get reason(): DedupeReason | undefined {
    if (!this.deps.settings.enable) return 'disabled'
    const inject = this.deps.sources.inject()
    if (inject === undefined) return 'no-inject'
    if (!inject.available) return 'inject-disabled'
    return undefined
  }

  /**
   * 一轮开始。**永不抛出**：任何异常都转成 `degraded`（C3）。
   * @param request 入参。
   */
  begin(request?: BeginRequest): DedupeBatch {
    const at = request?.at ?? this.deps.now()
    const conversationId = conversationKey(request?.conversationId, this.deps.settings.defaultConversation)
    this.counters.lastAt = at

    const blocked = this.reason
    if (blocked !== undefined) {
      // 放行到底：调用方拿到 bypassed 就走原路径（整块注入）。这里不记账——
      // 记账等于「假装拦住了」，而实际上那轮正文是调用方自己整块拼的。
      return idleBatch(conversationId, 'bypassed', blocked)
    }

    try {
      // 1. 嗅压缩（必须在摊 seen 之前：压缩的语义就是「账本作废」）。
      const signal = this.observeCompaction()
      let released: ReleaseReason | null = null
      if (signal.kind === 'released') released = 'compaction'

      // 2. 取账本（没有就建）。
      const ledger = this.book.get(conversationId, at)
      const firstOfSession = ledger.size === 0

      // 3. 同会话旧未决批次作废（见文件头第 2 条）。
      this.supersede(conversationId)

      // 4. 摊 seen：一个记账键可能对应两个 id（`fact:` → `mem:` + `pin:`）。
      const seen = new Set<string>()
      for (const key of ledger.keys()) {
        for (const id of idsOfKey(key)) seen.add(id)
      }

      // 5. 装箱。取回来立刻按结构对位用，缺 plan 就按降级处理。
      const inject = this.deps.sources.inject()
      if (inject === undefined) return idleBatch(conversationId, 'bypassed', 'no-inject')
      const rendered: RenderedLike = inject.render({
        query: request?.query ?? '',
        at,
        budgetChars: request?.budgetChars,
        seen,
      })
      const plan = rendered.plan
      if (plan === undefined || !Array.isArray(plan.ids)) {
        this.counters.degraded += 1
        return idleBatch(conversationId, 'degraded', 'plan-missing')
      }

      // 6. 只认装进去的 id：`dropped` 没进上下文，记了就是永久静默删掉。
      const ids = plan.ids.filter(id => typeof id === 'string' && id !== '')
      const keys = uniqueKeys(ids)
      const suppressed = Array.isArray(plan.suppressed) ? plan.suppressed.length : 0
      const dropped = Array.isArray(plan.dropped) ? plan.dropped.length : 0
      this.counters.suppressed += suppressed

      const state: BatchState = ids.length === 0 ? 'nothing-new' : 'fresh'
      // 「只推增量」的落点：没新东西就一个字都不发，绝不发只有标题的空段。
      const text = state === 'fresh' ? rendered.text : ''
      if (state === 'nothing-new') this.counters.emptyTurns += 1

      const batchId = this.registerPending(conversationId, keys, at)
      const note =
        state === 'nothing-new'
          ? suppressed > 0
            ? 'all-seen'
            : 'empty-sources'
          : undefined

      if (this.deps.settings.verbose && released !== null) {
        this.deps.log.info(
          '识别到上下文压缩：%s 的已见已释放（%d 条），本轮整块重注',
          conversationId,
          signal.kind === 'released' ? signal.released : 0,
        )
      }

      return Object.freeze({
        batchId,
        conversationId,
        state,
        text,
        // `chars` 必须与 `text` 同源：`nothing-new` 时 text 是空串而 O-036 的
        // `rendered.chars` 仍是整段长度，照抄会让调用方按 3000 字去排预算、实际发 0 字。
        chars: text.length,
        ids: Object.freeze(ids),
        keys: Object.freeze(keys),
        suppressed,
        dropped,
        overBudget: plan.overBudget === true,
        firstOfSession,
        digest: typeof plan.digest === 'string' ? plan.digest : '',
        released,
        note,
      })
    } catch (error) {
      // C3：器官错误不得传播。降级 = 本轮不拦，调用方整块注入。
      this.counters.degraded += 1
      if (this.deps.settings.verbose) {
        this.deps.log.warn('注入去重本轮降级（调用方应整块注入）：%s', messageOf(error))
      }
      return idleBatch(conversationId, 'degraded', 'begin-error')
    }
  }

  /**
   * 记账。
   * @param batchId 批次号。
   * @param conversationId 可选：传了就核对归属，防串台。
   */
  commit(batchId: number, conversationId?: string): CommitOutcome {
    const pending = this.pending.get(batchId)
    if (pending === undefined) {
      return { ok: false, reason: 'stale', conversationId: conversationId ?? this.deps.settings.defaultConversation, added: 0, skipped: 0, evicted: 0 }
    }
    if (conversationId !== undefined && conversationId !== pending.conversationId) {
      // 不回滚、不删除：这个批次仍属于它自己的会话，误传的调用方不该毁掉它。
      return { ok: false, reason: 'mismatch', conversationId: pending.conversationId, added: 0, skipped: 0, evicted: 0 }
    }
    this.pending.delete(batchId)
    const at = this.deps.now()
    const ledger = this.book.get(pending.conversationId, at)
    const outcome = ledger.addAll(pending.keys, at)
    this.counters.commits += 1
    this.counters.injected += outcome.added
    return {
      ok: true,
      conversationId: pending.conversationId,
      added: outcome.added,
      skipped: outcome.skipped,
      evicted: outcome.evicted,
    }
  }

  /**
   * 作废一个未决批次（那一轮没发出去）。
   * @param batchId 批次号。
   */
  discard(batchId: number): DiscardOutcome {
    const existed = this.pending.delete(batchId)
    return existed ? { ok: true } : { ok: false, reason: 'stale' as CommitFailure }
  }

  /**
   * 释放一个会话的已见。
   * @param reason 原因。
   * @param conversationId 会话；省略取默认会话。
   */
  release(reason: ReleaseReason, conversationId?: string): ReleaseOutcome {
    const target = conversationKey(conversationId, this.deps.settings.defaultConversation)
    const released = this.book.release(target)
    // 清账本与作废批次**必须成对**：只清账本不清批次的话，
    // 那一轮的迟到 `commit()` 会把刚释放的键原样记回去，释放白做而且不报错。
    const discarded = this.dropPending(target)
    this.counters.releases += 1
    if (this.deps.settings.verbose) {
      this.deps.log.info('释放已见（%s）：%s 共 %d 条，作废未决批次 %d 个', reason, target, released, discarded)
    }
    return { conversationId: target, reason, released, discarded }
  }

  /**
   * 释放全部会话的已见。
   * @param reason 原因。
   */
  releaseAll(reason: ReleaseReason): ReleaseOutcome {
    const released = this.book.releaseAll()
    const discarded = this.dropPending(undefined)
    this.counters.releases += 1
    if (this.deps.settings.verbose) {
      this.deps.log.info('释放全部已见（%s）：共 %d 条，作废未决批次 %d 个', reason, released, discarded)
    }
    return { conversationId: null, reason, released, discarded }
  }

  /**
   * 让指定条目下次可以再出现。
   *
   * 用途只有两个，都不是「优化」：用户明说「你再说一遍那个」；
   * 记忆被改写（`revise`）后旧内容不该再算「说过了」。
   * 记账键按族收敛，所以传 `mem:x` 也能摘掉以 `pin:x` 记下的那一条。
   * @param ids 条目 id。
   * @param conversationId 会话；省略取默认会话。
   */
  resurface(ids: readonly string[], conversationId?: string): number {
    const target = conversationKey(conversationId, this.deps.settings.defaultConversation)
    const ledger = this.book.peek(target)
    if (ledger === undefined) return 0
    let removed = 0
    for (const id of ids) {
      if (ledger.drop(keyOfId(id))) removed += 1
    }
    return removed
  }

  /**
   * 账本快照。
   * @param conversationId 会话；省略取默认会话。
   */
  snapshot(conversationId?: string): LedgerSnapshot {
    const target = conversationKey(conversationId, this.deps.settings.defaultConversation)
    const ledger = this.book.peek(target)
    return {
      conversationId: target,
      seenCount: ledger === undefined ? 0 : ledger.size,
      capacity: this.deps.settings.maxSeenPerConversation,
      recent: ledger === undefined ? [] : ledger.recent(20),
      pending: this.countPending(target),
      evicted: ledger === undefined ? 0 : ledger.evicted,
      releases: ledger === undefined ? 0 : ledger.releases,
    }
  }

  /** 累计统计。 */
  stats(): DedupeStats {
    const reason = this.reason
    return {
      available: reason === undefined,
      reason,
      conversations: this.book.count(),
      totalSeen: this.book.totalSeen(),
      capacity: this.deps.settings.maxSeenPerConversation,
      commits: this.counters.commits,
      injected: this.counters.injected,
      suppressed: this.counters.suppressed,
      emptyTurns: this.counters.emptyTurns,
      releases: this.counters.releases,
      evictions: this.book.totalEvicted(),
      superseded: this.counters.superseded,
      degraded: this.counters.degraded,
      ambiguousCompactions: this.counters.ambiguousCompactions,
      lastAt: this.counters.lastAt,
    }
  }

  /* ---------------- 内部 ---------------- */

  /**
   * 登记未决批次，并保证数量有上限。
   * @param conversationId 会话。
   * @param keys 记账键。
   * @param at 时刻。
   */
  private registerPending(conversationId: string, keys: readonly string[], at: number): number {
    const batchId = this.nextBatchId
    this.nextBatchId += 1
    this.pending.set(batchId, { conversationId, keys, at })
    const cap = this.deps.settings.maxPendingBatches
    while (this.pending.size > cap) {
      const oldest = this.pending.keys().next()
      if (oldest.done === true) break
      this.pending.delete(oldest.value)
      this.counters.superseded += 1
    }
    return batchId
  }

  /**
   * 作废同会话的全部未决批次。
   * @param conversationId 会话。
   * @returns 作废几个。
   */
  private supersede(conversationId: string): number {
    let removed = 0
    for (const [batchId, pending] of Array.from(this.pending.entries())) {
      if (pending.conversationId !== conversationId) continue
      this.pending.delete(batchId)
      removed += 1
    }
    if (removed > 0) this.counters.superseded += removed
    return removed
  }

  /**
   * 作废未决批次。`undefined` 表示全部会话。
   * @param conversationId 会话。
   */
  private dropPending(conversationId: string | undefined): number {
    let removed = 0
    for (const [batchId, pending] of Array.from(this.pending.entries())) {
      if (conversationId !== undefined && pending.conversationId !== conversationId) continue
      this.pending.delete(batchId)
      removed += 1
    }
    return removed
  }

  /**
   * 某个会话有几个未决批次。
   * @param conversationId 会话。
   */
  private countPending(conversationId: string): number {
    let n = 0
    for (const pending of this.pending.values()) {
      if (pending.conversationId === conversationId) n += 1
    }
    return n
  }

  /**
   * 嗅「上下文被压缩了」。
   *
   * 只读 O-033 的 `stats().compactions`（单调计数器），**不改它、不 import 它**。
   *
   * 三条纪律：
   * 1. **计数器回退当作「服务重载」**，重建基线、不释放——进程重启后计数器归零，
   *    若按增量判就会算出一个负数，谁都不该在那上面做决定。
   * 2. **多会话时不做自动释放**（`ambiguous`）。全局计数器分不清是谁压的，
   *    猜错的代价是别的会话被重复注入——正是本插件要消灭的东西。
   * 3. **拿不到就当嗅不到。** 读一个统计数失败不能影响记账。
   */
  private observeCompaction(): CompactionSignal {
    if (!this.deps.settings.autoDetectCompaction) return { kind: 'none' }
    const dialogue = this.deps.sources.dialogue()
    if (dialogue === undefined) {
      this.lastCompactions = undefined
      return { kind: 'none' }
    }
    let snapshot: { readonly compactions?: number; readonly conversations?: number } | undefined
    try {
      snapshot = dialogue.stats()
    } catch (error) {
      this.lastCompactions = undefined
      if (this.deps.settings.verbose) {
        this.deps.log.warn('读取对话统计失败，本轮不嗅压缩：%s', messageOf(error))
      }
      return { kind: 'none' }
    }
    const count = snapshot?.compactions
    if (typeof count !== 'number' || !Number.isFinite(count)) {
      this.lastCompactions = undefined
      return { kind: 'none' }
    }
    if (this.lastCompactions === undefined || count <= this.lastCompactions) {
      this.lastCompactions = count
      return { kind: 'none' }
    }
    this.lastCompactions = count

    const live = snapshot?.conversations
    if (typeof live === 'number' && live > 1) {
      this.counters.ambiguousCompactions += 1
      if (this.deps.settings.verbose) {
        this.deps.log.info(
          '检测到压缩，但同时有 %d 个会话：分不清是谁压的，不自动释放已见',
          live,
        )
      }
      return { kind: 'ambiguous' }
    }
    const outcome = this.releaseAll('compaction')
    return { kind: 'released', released: outcome.released }
  }
}
