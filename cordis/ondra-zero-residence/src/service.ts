/**
 * 零常驻的四个动作 —— **本包唯一的实现**。
 *
 * ## 顺序是死的：写盘 → 入账 → 交指针
 *
 * 手册要求「压缩前状态先写 SQLite」。所以 `compact()` 里任何一步失败都必须在
 * **交出指针之前**返回拒绝。写不进去还交指针，就是把一条通向空处的链接塞进上下文：
 * 三十分钟后模型问「刚才那个文件叫什么」，账上是有的、库里是空的，而**没有任何报错**。
 *
 * ## 为什么 `observe` 也要把指针算出来
 *
 * 因为迁移期唯一能回答问题的是数字：「如果压，能省多少」。所以 `observe` 走完全部
 * 计算、返回真指针文本，只在两个地方不动手：不写库、不入账。返回值里
 * `advisory` 为真，调用方据此知道「这不许用」。
 *
 * ## 指针就是缓存的生命线
 *
 * §8.5 的第 1 条是「会话内冻结前缀」。零常驻会在**用户回合边界**上改写一次前缀，
 * 这是它付的代价；但如果每次改写的指针都不同，就不是「改一次」而是「每轮都改」，
 * 缓存直接归零。所以 `planFor()` 先算指纹、再看账本：同一段正文第二次来，
 * 拿回**同一个 id、同一个指针字符串**，这一段前缀就不再变。
 */

import {
  baseIdOf,
  charsOf,
  chunkText,
  fnv1a64,
  idCandidateOf,
  idOfPointer,
  pointerOf,
} from './pointer.js'
import { ZrLedger } from './ledger.js'
import type { ZrEntry } from './ledger.js'
import { ZrStoreAdapter } from './store.js'
import { expandText, verifyRecord } from './recover.js'
import type { ZrResolver } from './recover.js'
import type { Config } from './settings.js'
import type {
  ZrCompactInput,
  ZrCompactOutcome,
  ZrExpandOutcome,
  ZrExternalSource,
  ZrLedgerView,
  ZrPreview,
  ZrRecallFailure,
  ZrRecallOutcome,
  ZrRecallSource,
  ZrRefusal,
  ZrService,
  ZrSpanKind,
  ZrStats,
  LogLike,
  StorePortLike,
} from './types.js'

/** 依赖注入：全部现取，不在构造时快照。 */
export interface ZrDeps {
  /** 当前配置。 */
  settings(): Config
  /** 日志。 */
  log: LogLike
  /** 时刻。 */
  now(): number
  /** 存储端口（可能缺席，也可能还没打开）。 */
  store(): StorePortLike | undefined
}

/** 当次压缩里的一段计划。 */
interface SpanPlan {
  readonly id: string
  readonly chunk: string
  /** 账本里已经有同 id 同内容 → 复用，不重复写。 */
  readonly reuse: boolean
}

/**
 * 把异常折成一句文本。
 * @param error 异常。
 */
function textOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** 零常驻服务。 */
export class ZeroResidence implements ZrService {
  // 账本实例。与方法 ledger() 同名会冲突，故取别名。
  private readonly book: ZrLedger
  private readonly adapters = new WeakMap<StorePortLike, ZrStoreAdapter>()
  private readonly sources: ZrExternalSource[] = []
  private hydrated = false
  private readonly reasons = new Map<string, number>()
  private calls = 0
  private committed = 0
  private refused = 0
  private pointers = 0
  private savedChars = 0
  private chars = 0
  private recalls = 0
  private recallMisses = 0
  private mismatches = 0
  private expands = 0
  private unresolved = 0
  private storeErrors = 0

  /**
   * @param deps 依赖。
   */
  constructor(private readonly deps: ZrDeps) {
    this.book = new ZrLedger(deps.settings().maxRecords)
  }

  /** 当前模式。 */
  get mode(): ZrService['mode'] {
    return this.deps.settings().mode
  }

  /** 不可用原因。 */
  get reason(): 'off' | 'no-store' | undefined {
    const settings = this.deps.settings()
    if (settings.mode === 'off') return 'off'
    if (settings.requireDurable && this.port() === undefined) return 'no-store'
    return undefined
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.reason === undefined
  }

  /**
   * 取存储端口。**每次都现取**：装载顺序由用户配置决定，快照会让「后打开的库」永远看不到。
   */
  private port(): StorePortLike | undefined {
    const port = this.deps.store()
    if (port === undefined) return undefined
    if (port.state !== 'open') return undefined
    return port
  }

  /** 取适配器（按端口实例缓存，端口换了就重建）。 */
  private adapter(): ZrStoreAdapter | undefined {
    const port = this.port()
    if (port === undefined) return undefined
    const cached = this.adapters.get(port)
    if (cached !== undefined) return cached
    const created = new ZrStoreAdapter(port)
    this.adapters.set(port, created)
    return created
  }

  /**
   * 懒加载索引。**只读元数据，不读正文。**
   *
   * 失败时按空账本继续：库里已有的记录仍能按 id 恢复（`recall` 直接查库），
   * 只是 `ledger()` 会显得空。这比「读不出来就整个服务不可用」好得多。
   */
  private ensureHydrated(): void {
    if (this.hydrated) return
    this.hydrated = true
    const adapter = this.adapter()
    if (adapter === undefined) return
    try {
      let dropped = 0
      for (const record of adapter.index()) {
        // 容量被调小过时，库里会比账本上限多：多出来的不淘汰、也不假装看不见。
        if (!this.book.put({ ...record })) dropped += 1
      }
      if (dropped > 0) {
        this.deps.log.warn('库里有 %d 条记录超出当前账本上限（%d），本次只载入前 %d 条：它们仍可按 id 恢复', dropped, this.book.limit, this.book.size)
      }
    } catch (error) {
      this.deps.log.warn('读取零常驻账本失败（按空账本继续；已入账的指针仍可按 id 恢复）：%s', textOf(error))
    }
  }

  /** 记一次拒绝原因。 */
  private note(reason: ZrRefusal): void {
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1)
  }

  /** 造一个拒绝结果。 */
  private refuse(
    reason: ZrRefusal,
    note: string,
    numbers?: { readonly charsIn: number; readonly charsOut: number; readonly pointers: readonly string[]; readonly ids: readonly string[] },
  ): ZrCompactOutcome {
    this.refused += 1
    this.note(reason)
    return {
      ok: false,
      reason,
      pointers: numbers?.pointers ?? [],
      ids: numbers?.ids ?? [],
      charsIn: numbers?.charsIn ?? 0,
      charsOut: numbers?.charsOut ?? 0,
      savedChars: numbers === undefined ? 0 : Math.max(0, numbers.charsIn - numbers.charsOut),
      records: 0,
      durable: false,
      advisory: false,
      note,
    }
  }

  /**
   * 给一段正文找 id。**同一段正文永远得到同一个 id**（撞号除外）。
   * @param sessionId 会话 id。
   * @param chunk 正文片段。
   */
  private planFor(sessionId: string, chunk: string): SpanPlan | undefined {
    const fnv = fnv1a64(chunk)
    const chars = charsOf(chunk)
    const base = baseIdOf(sessionId, chunk)
    for (let n = 1; n <= 64; n += 1) {
      const id = idCandidateOf(base, n)
      const existing = this.book.get(id)
      if (existing === undefined) return { id, chunk, reuse: false }
      if (existing.sessionId === sessionId && existing.fnv === fnv && existing.chars === chars) {
        return { id, chunk, reuse: true }
      }
      // 同 id 不同内容：48 位指纹撞号。换下一个后缀，绝不复用。
    }
    return undefined
  }

  /**
   * `zr_fast`：纯预览。**不写盘、不入账、不改任何计数。**
   * @param text 正文。
   * @param kind 片段种类。
   */
  fast(text: string, kind?: ZrSpanKind, sessionId?: string): ZrPreview {
    const settings = this.deps.settings()
    const charsIn = charsOf(text)
    if (kind !== undefined && kind !== 'resident') {
      return { spans: 0, pointers: [], charsIn, charsOut: 0, savedChars: 0, viable: false, reason: 'protected' }
    }
    if (text.trim() === '') {
      return { spans: 0, pointers: [], charsIn, charsOut: 0, savedChars: 0, viable: false, reason: 'empty' }
    }
    // 预览**不碰账本**：`fast()` 的全部意义是「谁都不用为这次调用付代价」。
    // 传了会话就按会话算 id（与真压逐字相同），没传就落占位 id。
    const scope = sessionId?.trim() ?? ''
    const chunks = chunkText(text, settings.maxSpanChars)
    const pointers: string[] = []
    for (const chunk of chunks) {
      const chars = charsOf(chunk)
      pointers.push(pointerOf(idCandidateOf(baseIdOf(scope, chunk), 1), chars))
    }
    const charsOut = pointers.reduce((sum, pointer) => sum + charsOf(pointer), 0)
    const savedChars = Math.max(0, charsIn - charsOut)
    const viable = savedChars >= settings.minSavingsChars
    return {
      spans: chunks.length,
      pointers,
      charsIn,
      charsOut,
      savedChars,
      viable,
      reason: viable ? undefined : 'too-short',
    }
  }

  /**
   * `zr_compact`：真压。**永不抛出。**
   * @param input 入参。
   */
  compact(input: ZrCompactInput): ZrCompactOutcome {
    this.calls += 1
    try {
      return this.doCompact(input)
    } catch (error) {
      this.deps.log.warn('零常驻压缩出错，已按「不压」处理：%s', textOf(error))
      return this.refuse('error', `压缩过程出错，本轮不压：${textOf(error)}`)
    }
  }

  /**
   * 压缩主体。
   * @param input 入参。
   */
  private doCompact(input: ZrCompactInput): ZrCompactOutcome {
    const settings = this.deps.settings()
    if (settings.mode === 'off') return this.refuse('off', '零常驻关着（mode=off）')
    if (input.kind !== undefined && input.kind !== 'resident') {
      return this.refuse(
        'protected',
        `「${input.kind}」不入账：人格、世界书、边界禁令就是被冻结的稳定段本身，遮掉等于改人`,
      )
    }
    if (!input.atUserTurnBoundary) {
      return this.refuse(
        'not-boundary',
        '不在用户回合边界上：中途重写前缀会把这一轮的缓存全部作废（§8.5-3）',
      )
    }
    const sessionId = input.sessionId.trim()
    if (sessionId === '') return this.refuse('no-session', '没有会话 id：跨会话共用账本会让恢复指错人')

    const text = input.text
    if (text.trim() === '') return this.refuse('empty', '正文是空的，没有可压的东西')

    this.ensureHydrated()

    const chunks = chunkText(text, settings.maxSpanChars)
    const plans: SpanPlan[] = []
    for (const chunk of chunks) {
      const plan = this.planFor(sessionId, chunk)
      if (plan === undefined) {
        return this.refuse('id-exhausted', '同一段正文的 64 个候选 id 全被占用，放弃本条（不猜）')
      }
      plans.push(plan)
    }

    const charsIn = charsOf(text)
    const pointers = plans.map(plan => pointerOf(plan.id, charsOf(plan.chunk)))
    const ids = plans.map(plan => plan.id)
    const charsOut = pointers.reduce((sum, pointer) => sum + charsOf(pointer), 0)
    const savedChars = Math.max(0, charsIn - charsOut)

    if (settings.mode === 'observe') {
      this.savedChars += savedChars
      this.refused += 1
      this.note('observe')
      return {
        ok: false,
        reason: 'observe',
        pointers,
        ids,
        charsIn,
        charsOut,
        savedChars,
        records: 0,
        durable: false,
        advisory: true,
        note: `只算不干：这一压可省 ${savedChars} 字（${charsIn} → ${charsOut}），未写盘、未入账`,
      }
    }

    if (savedChars < settings.minSavingsChars) {
      return this.refuse('too-short', `省下的 ${savedChars} 字不够 ${settings.minSavingsChars} 字的门槛（指针本身也要占字）`, {
        charsIn, charsOut, pointers, ids,
      })
    }

    const fresh = plans.filter(plan => !plan.reuse)
    if (!this.book.canHold(fresh.length)) {
      return this.refuse(
        'ledger-full',
        `账本只剩 ${this.book.limit - this.book.size} 条，本次要新增 ${fresh.length} 条：拒收，不淘汰旧记录`,
        { charsIn, charsOut, pointers, ids },
      )
    }

    const adapter = this.adapter()
    if (settings.requireDurable && adapter === undefined) {
      return this.refuse(
        'no-store',
        '没有可用的存储后端，而配置要求「压缩前状态先写 SQLite」：不交指针（写不进去的指针等于丢失）',
        { charsIn, charsOut, pointers, ids },
      )
    }

    const at = input.at ?? this.deps.now()
    const baseOrdinal = this.book.nextOrdinal(sessionId)
    const entries: ZrEntry[] = fresh.map((plan, index) => ({
      id: plan.id,
      sessionId,
      ordinal: baseOrdinal + index,
      chars: charsOf(plan.chunk),
      fnv: fnv1a64(plan.chunk),
      createdAt: at,
      // 没有存储后端时正文只能留在内存，并明确标 durable=false。
      text: adapter === undefined ? plan.chunk : undefined,
    }))

    if (adapter !== undefined && entries.length > 0) {
      try {
        adapter.putMany(entries)
      } catch (error) {
        this.storeErrors += 1
        return this.refuse(
          'store-error',
          `写库失败，本轮不交指针：${textOf(error)}`,
          { charsIn, charsOut, pointers, ids },
        )
      }
    }

    for (const entry of entries) {
      // 容量在上面已经预检过；这里再判一次是因为 put() 是唯一的写入点，
      // 「预检通过但写不进去」这种自相矛盾的状态不该被静默放过。
      if (!this.book.put(entry)) {
        this.deps.log.warn('账本写入被拒（容量），记录 %s 未入索引：它的指针本轮已经发出', entry.id)
      }
    }

    this.committed += 1
    this.pointers += pointers.length
    this.savedChars += savedChars
    this.chars += entries.reduce((sum, entry) => sum + entry.chars, 0)

    const note = fresh.length === plans.length
      ? `已压 ${plans.length} 段：${charsIn} → ${charsOut} 字（省 ${savedChars}）${adapter === undefined ? '，未落盘（require-durable 已关）' : ''}`
      : `已压 ${plans.length} 段（其中 ${plans.length - fresh.length} 段复用已有记录）：${charsIn} → ${charsOut} 字（省 ${savedChars}）`

    if (settings.verbose) {
      this.deps.log.info('零常驻：%s（会话 %s）', note, sessionId)
    }

    return {
      ok: true,
      pointers,
      ids,
      charsIn,
      charsOut,
      savedChars,
      records: entries.length,
      durable: adapter !== undefined,
      advisory: false,
      note,
    }
  }

  /**
   * `zr_recall`：取回原文。**永不抛出。**
   * @param idOrPointer 指针或裸 id。
   * @param sessionId 会话 id（外部源需要；省略时从账本推）。
   */
  recall(idOrPointer: string, sessionId?: string): ZrRecallOutcome {
    this.recalls += 1
    try {
      return this.doRecall(idOrPointer, sessionId)
    } catch (error) {
      this.recallMisses += 1
      this.deps.log.warn('零常驻恢复出错：%s', textOf(error))
      return { ok: false, reason: 'source-error', verified: false }
    }
  }

  /**
   * 恢复主体。
   * @param idOrPointer 指针或裸 id。
   * @param sessionId 会话 id。
   */
  private doRecall(idOrPointer: string, sessionId?: string): ZrRecallOutcome {
    const id = idOfPointer(idOrPointer)
    if (id === undefined) {
      this.recallMisses += 1
      return { ok: false, reason: 'bad-id', verified: false }
    }
    this.ensureHydrated()

    let record = this.book.get(id)
    let text: string | undefined
    let source: ZrRecallSource | undefined

    if (record !== undefined && record.text !== undefined) {
      text = record.text
      source = 'ledger'
    }

    if (text === undefined) {
      const adapter = this.adapter()
      if (adapter !== undefined) {
        try {
          const stored = adapter.textOf(id)
          if (stored !== undefined) {
            text = stored
            source = 'store'
          }
          if (record === undefined) record = adapter.recordOf(id)
        } catch (error) {
          this.deps.log.warn('从存储取正文失败（继续试外部源）：%s', textOf(error))
        }
      }
    }

    if (text === undefined) {
      for (let index = this.sources.length - 1; index >= 0; index -= 1) {
        const read = this.sources[index]
        try {
          const got = read(id, sessionId ?? record?.sessionId ?? '')
          if (got !== undefined) {
            text = got
            source = 'external'
            break
          }
        } catch (error) {
          this.recallMisses += 1
          this.deps.log.warn('外部恢复源抛错：%s', textOf(error))
          return { ok: false, reason: 'source-error', verified: false }
        }
      }
    }

    if (text === undefined) {
      this.recallMisses += 1
      return { ok: false, reason: 'not-found', verified: false }
    }

    let verified = false
    let reason: ZrRecallFailure | undefined
    if (record !== undefined) {
      const check = this.deps.settings().verifyOnRecall ? verifyRecord(record, text) : 'ok'
      verified = check === 'ok'
      if (!verified) {
        this.mismatches += 1
        reason = 'mismatch'
      }
    }
    // record 缺失时无法校验：`verified` 保持 false，但正文照给——事实留下，判断交出去。

    return { ok: true, reason, text, verified, source }
  }

  /**
   * `zr_ledger`：列账（不含正文）。
   * @param sessionId 会话 id；省略为全部。
   */
  ledger(sessionId?: string): ZrLedgerView {
    this.ensureHydrated()
    const entries = this.book.list(sessionId)
    return {
      sessionId: sessionId ?? null,
      records: entries.length,
      chars: this.book.charsOf(sessionId),
      capacity: this.book.limit,
      recent: entries.slice(0, 20),
    }
  }

  /**
   * 展开正文里的指针。换不回来的原样保留并计数。
   * @param text 可能带指针的正文。
   * @param sessionId 会话 id。
   */
  expand(text: string, sessionId?: string): ZrExpandOutcome {
    this.expands += 1
    const resolver: ZrResolver = (id, _chars) => {
      const got = this.doRecall(id, sessionId)
      if (!got.ok || got.text === undefined) return undefined
      return { text: got.text, verified: got.verified }
    }
    try {
      const outcome = expandText(text, resolver)
      this.unresolved += outcome.unresolved
      return outcome
    } catch (error) {
      this.deps.log.warn('展开指针出错（原样返回）：%s', textOf(error))
      return { text, pointers: 0, resolved: 0, unresolved: 0, mismatched: 0 }
    }
  }

  /**
   * 挂一个外部恢复源。**返回卸载函数。**
   * @param source 恢复源。
   */
  attachSource(source: ZrExternalSource): () => void {
    this.sources.push(source)
    return () => {
      const index = this.sources.indexOf(source)
      if (index >= 0) this.sources.splice(index, 1)
    }
  }

  /** 统计。 */
  stats(): ZrStats {
    const settings = this.deps.settings()
    const byReason: Record<string, number> = {}
    for (const [key, value] of this.reasons) byReason[key] = value
    return {
      at: this.deps.now(),
      mode: settings.mode,
      available: this.available,
      reason: this.reason,
      records: this.book.size,
      capacity: this.book.limit,
      chars: this.chars,
      pointers: this.pointers,
      savedChars: this.savedChars,
      calls: this.calls,
      committed: this.committed,
      refused: this.refused,
      byReason,
      recalls: this.recalls,
      recallMisses: this.recallMisses,
      mismatches: this.mismatches,
      expands: this.expands,
      unresolved: this.unresolved,
      storeErrors: this.storeErrors,
      durable: this.adapter() !== undefined,
      external: this.sources.length > 0,
    }
  }

  /** 卸载：清内存账本。幂等。 */
  dispose(): void {
    this.book.clear()
    this.sources.length = 0
    this.reasons.clear()
    this.hydrated = false
  }
}
