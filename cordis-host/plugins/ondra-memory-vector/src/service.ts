/**
 * O-122 的服务门面：索引持有、三模式检索、同步与持久化。
 *
 * 三条铁律（写死在实现里）：
 *
 * 1. **只读记忆内核**。`sync()` 只调 `listFacts()`，绝不写 O-010 的任何状态。
 * 2. **降级到字面、不抛给消费方**。检索路径上的任何错误都转成「该路返回空 +
 *    `lastError` 记录」——O-014 的探测逻辑对 error 状态有自己的处理，本插件不越权抛。
 * 3. **不装定时器**。同步只在装载时（`autoSync`）与消费方显式调用 `sync()` 时发生；
 *    常驻轮询是零常驻纪律禁止的。
 */

import { buildIvf, IVF_MIN_DOCS, ivfSearch } from './ann.js'
import { cosineOf, fingerprintOf, hashEmbed } from './embed.js'
import { bigramsOf, HYBRID_RRF_K, literalScoreOf, rrfFuse } from './literal.js'
import { EMBED_DIM, MODE_THRESHOLD_LITERAL, MODE_THRESHOLD_VECTOR, VectorError } from './types.js'
import type {
  EffectiveMode,
  EmbedderLike,
  MemoryCoreLike,
  StorePortLike,
  StoreTableSpec,
  VectorHit,
  VectorMode,
  VectorService,
  VectorStats,
  VectorSyncResult,
} from './types.js'

/** 索引内一条文档。 */
interface DocEntry {
  /** 嵌入向量（随生效嵌入器维度走）。 */
  vector: Float64Array
  /** 字符 bigram 集合（字面路复用，不重复分词）。 */
  grams: Set<string>
  /** 文本 + lastSeenAt 指纹（同步增量比对用）。 */
  fingerprint: string
  /** 原文快照（重嵌 / 字面路调试用；索引即存原文，不额外复制到持久化层以外的地方）。 */
  text: string
}

/** 持久化表名（三个存储后端共用同一表结构）。 */
const DOC_TABLE = 'vector_doc'

/** 表声明（镜像 O-006 的 ColumnSpec / TableSpec 形状）。 */
const DOC_TABLE_SPEC: StoreTableSpec = {
  name: DOC_TABLE,
  columns: [
    { name: 'id', type: 'TEXT', notNull: true, primaryKey: true },
    { name: 'text', type: 'TEXT', notNull: true },
    { name: 'fp', type: 'TEXT', notNull: true },
    { name: 'dim', type: 'INTEGER', notNull: true },
    { name: 'vec', type: 'TEXT', notNull: true },
    { name: 'updated', type: 'INTEGER', notNull: true },
  ],
}

/** 单次同步的分页大小。 */
const SYNC_PAGE_SIZE = 500
/** 单次同步的总行数保险丝（防内核异常返回导致死循环）。 */
const SYNC_MAX_ROWS = 100_000

/** 检索默认返回上限。 */
const DEFAULT_LIMIT = 20

/** 把错误变成消息文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 向量检索服务实现。 */
export class VectorRepository implements VectorService {
  private readonly docs = new Map<string, DocEntry>()
  /** 向量池（与 `idPool` 一一对应；给 IVF 用连续数组）。 */
  private vectorPool: Float64Array[] = []
  private idPool: string[] = []
  /** IVF 索引；文档变更后置 null（懒重建）。 */
  private ivf: ReturnType<typeof buildIvf> = null

  private embedder: EmbedderLike | null = null
  private dim = EMBED_DIM
  private availability = true
  private unavailabilityReason: string | undefined
  private syncs = 0
  private searches = 0
  private reembeds = 0
  private lastError: string | null = null

  /**
   * @param core 记忆内核（软依赖，缺席时 `sync()` 不可用，只能手动 `upsert`）。
   * @param store 存储端口（软依赖，缺席时索引仅内存）。
   * @param mode 配置的模式。
   * @param probes IVF 探桶数。
   * @param persist 是否持久化索引。
   * @param onLog 日志回调（门面不持有 logger，避免循环依赖宿主对象）。
   */
  constructor(
    private readonly core: MemoryCoreLike | undefined,
    private readonly store: StorePortLike | undefined,
    // 配置的模式。与方法 mode() 同名会冲突，故取别名。
    private configuredMode: VectorMode,
    private readonly probes: number,
    private readonly persist: boolean,
    private readonly onLog: (level: 'info' | 'warn' | 'error', message: string, ...args: unknown[]) => void,
  ) {
    if (this.persist && this.store !== undefined) {
      try {
        this.store.ensureTable(DOC_TABLE_SPEC)
        this.loadPersisted()
      } catch (error) {
        this.lastError = messageOf(error)
        this.onLog('warn', `向量索引持久化初始化失败（退回纯内存索引）：%s`, messageOf(error))
      }
    }
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.availability
  }

  /** 不可用原因。 */
  get reason(): string | undefined {
    return this.unavailabilityReason
  }

  /* ---------------- 模式与检索 ---------------- */

  /** 当前生效分支（`auto` 按文档数实时判定；阈值是台账裁决④口径）。 */
  mode(): EffectiveMode {
    if (this.configuredMode !== 'auto') return this.configuredMode
    const total = this.docs.size
    if (total < MODE_THRESHOLD_LITERAL) return 'literal'
    if (total <= MODE_THRESHOLD_VECTOR) return 'hybrid'
    return 'vector'
  }

  /**
   * 向量检索（O-014 的消费入口）。按当前生效模式走对应路径；任何错误都降级为空列表。
   */
  search(text: string, options?: { readonly limit?: number }): readonly VectorHit[] {
    if (!this.availability) return []
    const limit = options?.limit !== undefined && options.limit > 0 ? Math.trunc(options.limit) : DEFAULT_LIMIT
    const effective = this.mode()
    try {
      this.searches += 1
      const hits = this.runSearch(text, effective, limit)
      return hits
    } catch (error) {
      this.lastError = messageOf(error)
      this.onLog('warn', '向量检索失败（返回空，语义因子将在 O-014 侧退出归一化）：%s', messageOf(error))
      return []
    }
  }

  /** 混合检索：恒走「字面 + 向量」RRF，不受 mode 配置影响。 */
  hybridSearch(text: string, options?: { readonly limit?: number }): readonly VectorHit[] {
    if (!this.availability) return []
    const limit = options?.limit !== undefined && options.limit > 0 ? Math.trunc(options.limit) : DEFAULT_LIMIT
    try {
      this.searches += 1
      return this.runHybrid(text, limit)
    } catch (error) {
      this.lastError = messageOf(error)
      this.onLog('warn', '混合检索失败（返回空）：%s', messageOf(error))
      return []
    }
  }

  /** 按模式分派。 */
  private runSearch(text: string, effective: EffectiveMode, limit: number): VectorHit[] {
    if (text === '') return []
    if (this.docs.size === 0) return []
    if (effective === 'literal') return this.runLiteral(text, limit)
    if (effective === 'hybrid') return this.runHybrid(text, limit)
    return this.runVector(text, limit)
  }

  /** 字面路：bigram 包含率。 */
  private runLiteral(text: string, limit: number): VectorHit[] {
    const queryGrams = bigramsOf(text)
    const scored: VectorHit[] = []
    for (const [id, doc] of this.docs) {
      const score = literalScoreOf(queryGrams, doc.grams)
      if (score > 0) scored.push({ id, score })
    }
    scored.sort((left, right) => right.score - left.score)
    return scored.length > limit ? scored.slice(0, limit) : scored
  }

  /** 混合路：字面 + 向量各取 2×limit，RRF 融合后归一到 0–1。 */
  private runHybrid(text: string, limit: number): VectorHit[] {
    const queryGrams = bigramsOf(text)
    const queryVector = this.embedOne(text)
    const wideLimit = limit * 2
    const literalList: { id: string; score: number }[] = []
    for (const [id, doc] of this.docs) {
      const score = literalScoreOf(queryGrams, doc.grams)
      if (score > 0) literalList.push({ id, score })
    }
    literalList.sort((left, right) => right.score - left.score)
    const literalTop = literalList.length > wideLimit ? literalList.slice(0, wideLimit) : literalList
    const vectorList: { id: string; score: number }[] = []
    if (queryVector !== null) {
      for (const [id, doc] of this.docs) {
        const score = cosineOf(queryVector, doc.vector)
        if (score > 0) vectorList.push({ id, score })
      }
      vectorList.sort((left, right) => right.score - left.score)
    }
    const vectorTop = vectorList.length > wideLimit ? vectorList.slice(0, wideLimit) : vectorList
    const fused = rrfFuse(literalTop, vectorTop)
    const maxScore = 2 / (HYBRID_RRF_K + 1)
    const hits: VectorHit[] = []
    for (const [id, raw] of fused) {
      hits.push({ id, score: Math.min(1, raw / maxScore) })
    }
    hits.sort((left, right) => right.score - left.score)
    return hits.length > limit ? hits.slice(0, limit) : hits
  }

  /** 向量路：> 阈值且有索引走 IVF，否则暴力。 */
  private runVector(text: string, limit: number): VectorHit[] {
    const queryVector = this.embedOne(text)
    if (queryVector === null) return this.runLiteral(text, limit)
    if (this.ivf === null && this.vectorPool.length >= IVF_MIN_DOCS) {
      this.ivf = buildIvf(this.vectorPool)
      if (this.ivf !== null) {
        this.onLog('info', 'IVF 索引已建：%d 桶 / %d 文档', this.ivf.centers.length, this.vectorPool.length)
      }
    }
    const scored: VectorHit[] = []
    if (this.ivf !== null) {
      for (const candidate of ivfSearch(this.ivf, this.vectorPool, queryVector, this.probes, limit)) {
        const id = this.idPool[candidate.index]
        scored.push({ id, score: Math.max(0, candidate.score) })
      }
    } else {
      for (const [id, doc] of this.docs) {
        const score = cosineOf(queryVector, doc.vector)
        if (score > 0) scored.push({ id, score })
      }
      scored.sort((left, right) => right.score - left.score)
      if (scored.length > limit) scored.length = limit
    }
    return scored
  }

  /** 嵌入单条查询。嵌入器抛错时返回 null（调用方退字面路）。 */
  private embedOne(text: string): Float64Array | null {
    if (text === '') return null
    if (this.embedder === null) return hashEmbed(text, this.dim)
    // 外部嵌入器：先判批长度再取下标（数组下标不产生 undefined，直接比较是 TS2367）。
    const batch = this.embedder.embed([text])
    if (batch.length === 0) return null
    const vector = batch[0]
    if (vector.length === 0) return null
    return vector
  }

  /* ---------------- 同步与写入 ---------------- */

  /**
   * 从记忆内核全量同步一次。指纹（文本 + lastSeenAt）没变的条目跳过，只重嵌变化的。
   * 内核缺席时直接返回（不算错误——「没数据源」是合法状态）。
   */
  sync(): VectorSyncResult {
    if (this.core === undefined || !this.core.available) {
      return { added: 0, updated: 0, removed: 0, total: this.docs.size }
    }
    let added = 0
    let updated = 0
    const seen = new Set<string>()
    try {
      this.syncs += 1
      let offset = 0
      while (offset < SYNC_MAX_ROWS) {
        const page = this.core.listFacts({ limit: SYNC_PAGE_SIZE, offset })
        if (page.length === 0) break
        for (const record of page) {
          if (record.id === '' || record.text === '') continue
          seen.add(record.id)
          const fingerprint = fingerprintOf(record.text, record.lastSeenAt)
          const existing = this.docs.get(record.id)
          if (existing !== undefined && existing.fingerprint === fingerprint) continue
          this.embedAndPut(record.id, record.text, fingerprint)
          if (existing === undefined) added += 1
          else updated += 1
        }
        if (page.length < SYNC_PAGE_SIZE) break
        offset += page.length
      }
    } catch (error) {
      this.lastError = messageOf(error)
      this.onLog('error', '向量索引同步失败（内存索引保持上一轮状态）：%s', messageOf(error))
      return { added, updated, removed: 0, total: this.docs.size }
    }
    // 移除内核里已不存在的条目。
    let removed = 0
    for (const id of [...this.docs.keys()]) {
      if (!seen.has(id)) {
        this.removeInternal(id)
        removed += 1
      }
    }
    this.rebuildPool()
    this.flushPersisted()
    return { added, updated, removed, total: this.docs.size }
  }

  /** 手动喂一条（记忆内核缺席时的兜底数据源）。 */
  upsert(id: string, text: string): void {
    if (id === '') throw new VectorError('bad-argument', 'id 不能为空')
    if (text === '') {
      this.remove(id)
      return
    }
    this.embedAndPut(id, text, fingerprintOf(text, 0))
    this.rebuildPool()
    this.persistOne(id)
  }

  /** 手动移除一条。 */
  remove(id: string): void {
    this.removeInternal(id)
    this.rebuildPool()
    this.persistRemove(id)
  }

  /** 索引内文档数。 */
  count(): number {
    return this.docs.size
  }

  /** 内部写入：嵌入 + 放入索引 + 池标记脏。 */
  private embedAndPut(id: string, text: string, fingerprint: string): void {
    const vector = this.embedder === null ? hashEmbed(text, this.dim) : this.embedOneForDoc(text)
    const entry: DocEntry = { vector, grams: bigramsOf(text), fingerprint, text }
    this.docs.set(id, entry)
    this.ivf = null
  }

  /** 文档批量嵌入（注入的外部嵌入器按批调用，减少调度开销）。 */
  private embedOneForDoc(text: string): Float64Array {
    if (this.embedder === null) return hashEmbed(text, this.dim)
    const batch = this.embedder.embed([text])
    if (batch.length === 0) {
      throw new VectorError('embed-failed', '外部嵌入器返回空结果')
    }
    return batch[0]
  }

  /** 移除（不动池，由调用方统一 rebuild）。 */
  private removeInternal(id: string): void {
    if (this.docs.delete(id)) this.ivf = null
  }

  /** 重建向量池（IVF 需要连续数组）。文档多时这是 O(n) 拷贝，只在写路径发生。 */
  private rebuildPool(): void {
    this.idPool = [...this.docs.keys()]
    this.vectorPool = this.idPool.map((id) => this.docs.get(id)?.vector ?? new Float64Array(this.dim))
    this.ivf = null
  }

  /* ---------------- 嵌入器管理 ---------------- */

  /**
   * 注入外部嵌入器。维度必须为正；注入后**全量重嵌**（维度变了旧向量全部作废）。
   * 探测失败时保留原嵌入器并抛错，绝不半换。
   */
  setEmbedder(embedder: EmbedderLike | null): void {
    if (embedder === null) {
      this.embedder = null
      this.dim = EMBED_DIM
      this.reembedAll()
      return
    }
    let probe: readonly Float64Array[]
    try {
      probe = embedder.embed(['维度探测'])
    } catch (error) {
      throw new VectorError('embed-failed', '外部嵌入器探测失败，保留原嵌入器', messageOf(error))
    }
    if (probe.length === 0 || probe[0].length === 0) {
      throw new VectorError('dim-mismatch', '外部嵌入器返回空向量，保留原嵌入器')
    }
    this.embedder = embedder
    this.dim = probe[0].length
    this.reembedAll()
  }

  /** 全量重嵌（嵌入器切换时）。失败则整包退回不可用——半新半旧的索引比空索引危险。 */
  private reembedAll(): void {
    const failed: string[] = []
    for (const [id, doc] of this.docs) {
      try {
        doc.vector = this.embedder === null ? hashEmbed(doc.text, this.dim) : this.embedOneForDoc(doc.text)
        this.reembeds += 1
      } catch (error) {
        failed.push(id)
        this.lastError = messageOf(error)
      }
    }
    for (const id of failed) this.docs.delete(id)
    this.rebuildPool()
    if (failed.length > 0) {
      this.onLog('error', '切换嵌入器时 %d 条重嵌失败，已从索引移除（原文仍在记忆内核）', failed.length)
    }
    this.flushPersisted()
  }

  /* ---------------- 持久化 ---------------- */

  /** 从存储端口加载已有向量（避免每次启动重嵌全量）。 */
  private loadPersisted(): void {
    if (this.store === undefined) return
    const rows = this.store.select(DOC_TABLE, { limit: SYNC_MAX_ROWS })
    for (const row of rows) {
      const id = row['id']
      const text = row['text']
      const fp = row['fp']
      const dim = row['dim']
      const raw = row['vec']
      if (typeof id !== 'string' || typeof text !== 'string' || typeof fp !== 'string') continue
      if (typeof dim !== 'number' || dim !== this.dim || typeof raw !== 'string') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (!Array.isArray(parsed) || parsed.length !== dim) continue
      const vector = new Float64Array(dim)
      let valid = true
      for (let index = 0; index < dim; index += 1) {
        const value = parsed[index]
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          valid = false
          break
        }
        vector[index] = value
      }
      if (!valid) continue
      this.docs.set(id, { vector, grams: bigramsOf(text), fingerprint: fp, text })
    }
    this.rebuildPool()
    if (this.docs.size > 0) {
      this.onLog('info', '已从存储加载 %d 条向量索引（维度 %d）', this.docs.size, this.dim)
    }
  }

  /** 单条持久化（失败只记日志——持久化是尽力而为，内存索引才是真源）。 */
  private persistOne(id: string): void {
    this.writeRow(id)
  }

  /** 全量刷盘（sync / 重嵌后）。 */
  private flushPersisted(): void {
    if (this.store === undefined || !this.persist) return
    for (const id of this.docs.keys()) this.writeRow(id)
  }

  /** 写一行向量到存储端口。 */
  private writeRow(id: string): void {
    if (this.store === undefined || !this.persist) return
    const doc = this.docs.get(id)
    if (doc === undefined) return
    try {
      this.store.upsert(DOC_TABLE, {
        id,
        text: doc.text,
        fp: doc.fingerprint,
        dim: this.dim,
        vec: JSON.stringify([...doc.vector]),
        updated: Date.now(),
      })
    } catch (error) {
      this.lastError = messageOf(error)
      this.onLog('warn', '向量索引持久化失败（内存索引不受影响）：%s', messageOf(error))
    }
  }

  /** 删一行向量。 */
  private persistRemove(id: string): void {
    if (this.store === undefined || !this.persist) return
    try {
      this.store.delete(DOC_TABLE, { id })
    } catch (error) {
      this.lastError = messageOf(error)
      this.onLog('warn', '向量索引删除持久化失败：%s', messageOf(error))
    }
  }

  /* ---------------- 统计与可用性 ---------------- */

  /** 标记不可用（只在装载期配置错误时发生；运行期错误一律走 lastError）。 */
  markUnavailable(reason: string): void {
    this.availability = false
    this.unavailabilityReason = reason
  }

  /** 运行期统计。 */
  stats(): VectorStats {
    return {
      available: this.availability,
      effectiveMode: this.mode(),
      configuredMode: this.configuredMode,
      docs: this.docs.size,
      dim: this.dim,
      embedder: this.embedder === null ? 'hash' : 'external',
      persisted: this.persist && this.store !== undefined,
      syncs: this.syncs,
      searches: this.searches,
      reembeds: this.reembeds,
      lastError: this.lastError,
    }
  }
}
