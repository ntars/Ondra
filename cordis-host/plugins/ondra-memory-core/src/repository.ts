/**
 * 仓库层：把「契约」落到「存储端口」上。**只做表级 CRUD**，不用原始 SQL。
 *
 * 为什么不用 `raw`：一旦用上 FTS5 或自定义 SQL，本插件就绑死 SQLite，
 * `ondra-store-memory` 立刻失效，而「数据库坏了也要能说话」正是 O-007 存在的理由。
 * 代价（没有全文索引、聚合要靠取样）写进 README「已知限制」。
 *
 * 两处容易写错、已经踩过的坑，写在这里防回去：
 *
 * 1. **`stability_hours` 存基线，不存当前值。**
 *    当前 S 每次读都按 `times_said` / `hits` 重算。存当前值的后果不是「数字不准」，
 *    而是「被反复提起衰减更慢」这条规则**永远不生效**——写死的数字不会自己变。
 *
 * 2. **`times_said` 写入时是 0，不是 1。**
 *    手册的提及因子 `min(15, 3×(1+ln(1+n)))/3` 在 n=0 时恰好是 1.0。
 *    若把「写入那一次」也算进去，每条新记忆都白拿 1.69 倍，
 *    因子的零点就永远用不上，等于把公式的上半段砍掉。
 *    「被反复提起」说的是**重复**，第一次不算重复。
 */

import { createHash } from 'node:crypto'
import { MEMORY_TABLES, TABLE_FACT, TABLE_RAW, TABLE_TOMBSTONE } from './schema.js'
import type { Config } from './settings.js'
import {
  REVISE_BOOST,
  archiveAfterHours,
  charCount,
  clampArousal,
  clampSalience,
  fadeHours,
  isImportant,
  scoreText,
  stabilityOf,
  strengthAt,
} from './stability.js'
import {
  MEMORY_CATEGORIES,
  MEMORY_CHANNELS,
  MEMORY_ID_RE,
  MEMORY_KINDS,
  MemoryError,
} from './types.js'
import type {
  EvidenceRef,
  FactInput,
  FactQuery,
  FilterLike,
  LogLike,
  MemoryCategory,
  MemoryChannel,
  MemoryCoreService,
  MemoryIssue,
  MemoryKind,
  MemoryRecord,
  MemoryStats,
  MemoryUnavailableReason,
  RawRecord,
  RowLike,
  SelectQueryLike,
  StoreLike,
  StrengthView,
  TurnInput,
} from './types.js'

/** 统计取样条数（平均显著度按最近这么多条估）。 */
const STATS_SAMPLE_ROWS = 500

/** 问题列表上限（防内存无界增长）。 */
const MAX_ISSUES = 200

/** 一天的毫秒数。 */
const DAY_MS = 86400000

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 读一个数字字段。 */
function numOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 读一个整数字段。 */
function intOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

/** 读一个字符串字段。 */
function strOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 判一个值是不是 11 类之一。 */
function asCategory(value: unknown): MemoryCategory | undefined {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value)
    ? (value as MemoryCategory)
    : undefined
}

/** 判一个值是不是五类之一。 */
function asKind(value: unknown): MemoryKind | undefined {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
    ? (value as MemoryKind)
    : undefined
}

/** 判一个值是不是三通道之一。 */
function asChannel(value: unknown): MemoryChannel | undefined {
  return typeof value === 'string' && (MEMORY_CHANNELS as readonly string[]).includes(value)
    ? (value as MemoryChannel)
    : undefined
}

/**
 * 正文摘要：去掉所有空白后的 SHA-256 前 32 位。
 *
 * 去空白是刻意的：同一句话换个排版（多一个空格、多一个换行）不该被当成两条，
 * 否则「合并时不许复活」会因为排版差异而漏掉。**标点保留**——标点承载语气，
 * 「我不去」和「我不去？」是两件事。
 * @param text 正文。
 */
export function digestOf(text: string): string {
  const normalized = text.replace(/\s+/g, '')
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 32)
}

/** 记忆内核的实现。 */
export class MemoryRepository implements MemoryCoreService {
  private readonly store: StoreLike
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number

  private ready = false
  private unavailable: MemoryUnavailableReason | undefined
  private issues: MemoryIssue[] = []
  private issueDropped = false
  private seq = 0

  private readonly counters = {
    turns: 0,
    facts: 0,
    revisions: 0,
    forgotten: 0,
    sealed: 0,
    reinforced: 0,
  }

  /**
   * @param store 存储端口（两个后端之一）。
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   */
  constructor(store: StoreLike, settings: Config, log: LogLike, now: () => number) {
    this.store = store
    this.settings = settings
    this.log = log
    this.now = now
  }

  /** 是否可用。**端口关闭也算不可用**——否则会出现「stats 说可用、一写就抛 closed」。 */
  get available(): boolean {
    return this.ready && this.store.state !== 'closed'
  }

  /** 不可用原因。 */
  get reason(): MemoryUnavailableReason | undefined {
    if (this.store.state === 'closed') return 'closed'
    return this.unavailable
  }

  /**
   * 建表（幂等）。**由 `apply()` 调一次**，不装定时器、不等「启动完成」——
   * 插件装载顺序不确定，定时器跑在第几个插件之后是运气。
   * @returns 本次发现的问题。
   */
  ensure(): readonly MemoryIssue[] {
    const found: MemoryIssue[] = []
    for (const spec of MEMORY_TABLES) {
      try {
        const result = this.store.ensureTable(spec)
        for (const issue of result.issues) {
          found.push({
            code: 'store-issue',
            detail: `${issue.table}${issue.column === undefined ? '' : '.' + issue.column}：${issue.detail}`,
          })
        }
      } catch (error) {
        found.push({ code: 'ensure-failed', detail: `建表 ${spec.name} 失败：${messageOf(error)}` })
      }
    }
    for (const issue of found) this.pushIssue(issue)

    const failed = found.some(issue => issue.code === 'ensure-failed')
    this.ready = !failed
    this.unavailable = failed ? 'schema-failed' : undefined
    return found
  }

  /* ------------------------------ 写入 ------------------------------ */

  appendTurn(input: TurnInput): RawRecord {
    this.assertReady()
    if (typeof input.turnId !== 'string' || input.turnId.trim() === '') {
      throw new MemoryError('bad-argument', 'turnId 不能为空')
    }
    if (typeof input.text !== 'string' || input.text.trim() === '') {
      throw new MemoryError('empty-text', '原文不能为空')
    }
    const at = typeof input.at === 'number' ? input.at : this.now()
    const id = `r-${this.suffix(input.text, at)}`
    const meta = input.meta ?? {}
    const row: RowLike = {
      id,
      turn_id: input.turnId,
      role: input.role,
      text: input.text,
      created_at: at,
      meta: JSON.stringify(meta),
    }
    const facts = input.facts ?? []

    // 同一事务：原文与提炼要么一起在，要么一起不在。
    // 「原文在、事实不在」的半截状态最麻烦——查不到原因，因为没有任何一步报错。
    this.store.transaction(() => {
      this.store.insert(TABLE_RAW, row)
      for (const fact of facts) this.writeFact(fact, id, at)
    })

    this.counters.turns += 1
    return Object.freeze({
      id,
      turnId: input.turnId,
      role: input.role,
      text: input.text,
      createdAt: at,
      meta: Object.freeze({ ...meta }),
    })
  }

  addFact(input: FactInput): MemoryRecord {
    this.assertReady()
    const at = typeof input.at === 'number' ? input.at : this.now()
    let record: MemoryRecord | undefined
    this.store.transaction(() => {
      record = this.writeFact(input, input.rawId, at)
    })
    if (record === undefined) {
      // 事务体一定会赋值；这里只是让类型收窄，同时把「没写进去」变成显式错误。
      throw new MemoryError('write-failed', '事实写入未产生记录')
    }
    return record
  }

  /* ------------------------------ 读取 ------------------------------ */

  getFact(id: string): MemoryRecord | undefined {
    if (typeof id !== 'string' || id === '') return undefined
    try {
      const row = this.store.get(TABLE_FACT, { id })
      return row === undefined ? undefined : this.toRecord(row)
    } catch (error) {
      this.log.warn('读取记忆 %s 失败：%s', id, messageOf(error))
      return undefined
    }
  }

  listFacts(query?: FactQuery): readonly MemoryRecord[] {
    const ids = query?.ids
    if (ids !== undefined && ids.length === 0) return []
    try {
      const rows = this.store.select(TABLE_FACT, this.toSelect(query))
      return rows.map(row => this.toRecord(row))
    } catch (error) {
      this.log.warn('查询记忆失败：%s', messageOf(error))
      return []
    }
  }

  countFacts(query?: FactQuery): number {
    try {
      const where = this.toWhere(query)
      return this.store.count(TABLE_FACT, where.length === 0 ? undefined : where)
    } catch (error) {
      this.log.warn('统计记忆失败：%s', messageOf(error))
      return 0
    }
  }

  /* ---------------------------- 四态删除 ---------------------------- */

  revise(id: string, newText: string, at?: number): MemoryRecord {
    this.assertReady()
    const row = this.requireRow(id)
    const stamp = typeof at === 'number' ? at : this.now()
    const text = this.cutText(String(newText ?? '').trim(), this.settings.maxTextChars, 'text-truncated', id)
    if (text === '') throw new MemoryError('empty-text', '订正后的正文不能为空')

    const mult = numOf(row['stability_mult'], 1)
    const patch: RowLike = {
      text,
      old_text: strOf(row['text']),
      revisions: intOf(row['revisions'], 0) + 1,
      // 订正 = 她重新想过这件事，所以 S ×1.3（复利：改两次是 1.69 倍）。
      stability_mult: Math.max(1e-6, mult) * REVISE_BOOST,
      last_seen_at: stamp,
    }
    this.store.update(TABLE_FACT, { id }, patch)
    this.counters.revisions += 1
    return this.toRecord({ ...row, ...patch })
  }

  forget(id: string, reason: string): boolean {
    this.assertReady()
    const row = this.store.get(TABLE_FACT, { id })
    if (row === undefined) return false

    const text = strOf(row['text']) ?? ''
    const digest = digestOf(text)
    const at = this.now()
    if (digest === digestOf('')) {
      // 空正文的墓碑没有意义：它挡不住任何东西，只会让「不许复活」的判定变成空转。
      this.pushIssue({ code: 'digest-empty', id, detail: '正文为空，未写墓碑（空摘要无法用于防复活）' })
    }

    this.store.transaction(() => {
      this.store.insert(TABLE_TOMBSTONE, {
        id: `t-${this.suffix(text, at)}`,
        fact_id: id,
        digest,
        // 只留残文，不留全文：用户要求忘记，就不该在另一张表里留一份可读副本。
        text: [...text].slice(0, 200).join(''),
        reason,
        deleted_at: at,
      })
      this.store.delete(TABLE_FACT, { id })
    })
    this.counters.forgotten += 1
    return true
  }

  seal(id: string, at?: number): MemoryRecord {
    this.assertReady()
    const row = this.requireRow(id)
    const stamp = typeof at === 'number' ? at : this.now()
    // **刻意不动 `archived`**：封存与归档是两个独立位。封存一条已沉底的记忆，
    // 不该顺手把它捞回活跃态——那会让「沉底」变成可被一次封存撤销的动作。
    const patch: RowLike = { sealed: 1, last_seen_at: stamp }
    this.store.update(TABLE_FACT, { id }, patch)
    this.counters.sealed += 1
    return this.toRecord({ ...row, ...patch })
  }

  archiveDue(at?: number): readonly string[] {
    this.assertReady()
    const stamp = typeof at === 'number' ? at : this.now()
    const { archiveNormalDays, archiveImportantDays, importantSalience, maxSelectRows } = this.settings
    const normalCut = stamp - archiveAfterHours(false, archiveNormalDays, archiveImportantDays) * 3600000
    const importantCut = stamp - archiveAfterHours(true, archiveNormalDays, archiveImportantDays) * 3600000

    // 两个窗口分开查：`important` 是按显著度派生的，不是独立列。
    // 一条 `salience` 过滤就能把两档拆开，比加一列 `important` 更不容易漂移
    // （加了列就得在每次改显著度时同步它，忘一次就永久错档）。
    const groups: readonly { readonly cut: number; readonly salience: FilterLike }[] = [
      { cut: normalCut, salience: { column: 'salience', op: 'lt', value: importantSalience } },
      { cut: importantCut, salience: { column: 'salience', op: 'gte', value: importantSalience } },
    ]

    const archived: string[] = []
    try {
      for (const group of groups) {
        const rows = this.store.select(TABLE_FACT, {
          // **刻意不排除 `sealed`**：手册 §2.4 的原话是「封存（不主动注入、不参与回忆，
          // 按类检索仍可能翻到，到期只归档）」——封存不等于免于归档，两者是独立位。
          where: [
            { column: 'archived', op: 'eq', value: 0 },
            { column: 'last_seen_at', op: 'lte', value: group.cut },
            group.salience,
          ],
          orderBy: [{ column: 'last_seen_at', direction: 'asc' }],
          limit: maxSelectRows,
        })
        for (const row of rows) {
          const id = strOf(row['id'])
          if (id === null) continue
          // 只沉底，不删：`archived=1` 之后仍能被按类检索翻到，只是不再占主动位。
          this.store.update(TABLE_FACT, { id }, { archived: 1 })
          archived.push(id)
        }
      }
    } catch (error) {
      // 沉底失败不是致命：记忆还在，只是还占着主动位。下次再扫。
      this.log.warn('归档扫描失败（记忆未丢，只是没沉底）：%s', messageOf(error))
    }
    if (archived.length > 0) {
      this.log.info('已沉底 %d 条超过归档窗口的记忆（只忘不删）', archived.length)
    }
    return Object.freeze(archived)
  }

  /* ------------------------------ 加固 ------------------------------ */

  reinforce(id: string, kind: 'mention' | 'hit', at?: number): MemoryRecord {
    this.assertReady()
    const row = this.requireRow(id)
    const stamp = typeof at === 'number' ? at : this.now()
    const patch: RowLike =
      kind === 'hit'
        ? { hits: intOf(row['hits'], 0) + 1, last_hit_at: stamp, last_seen_at: stamp }
        : { times_said: intOf(row['times_said'], 0) + 1, last_seen_at: stamp }
    this.store.update(TABLE_FACT, { id }, patch)
    this.counters.reinforced += 1
    return this.toRecord({ ...row, ...patch })
  }

  markSeen(ids: readonly string[], at?: number): number {
    if (ids.length === 0) return 0
    const stamp = typeof at === 'number' ? at : this.now()
    let changed = 0
    this.store.transaction(() => {
      for (const id of ids) {
        try {
          changed += this.store.update(TABLE_FACT, { id }, { last_seen_at: stamp })
        } catch (error) {
          // 单条失败不该让整批回滚：注入已经发生了，标记失败只是「下次还会被当成没带出过」。
          this.log.warn('标记已带出失败（%s）：%s', id, messageOf(error))
        }
      }
    })
    return changed
  }

  /* ------------------------------ 视图 ------------------------------ */

  strengthOf(record: MemoryRecord, at?: number): StrengthView {
    const stamp = typeof at === 'number' ? at : this.now()
    const elapsedHours = Math.max(0, stamp - record.lastSeenAt) / 3600000
    const floor = this.settings.floorWeight
    const strength = strengthAt(record.stabilityHours, elapsedHours, floor)
    const totalHours = fadeHours(record.stabilityHours, floor)
    return Object.freeze({
      stabilityHours: record.stabilityHours,
      strength,
      remainingHours: Math.max(0, totalHours - elapsedHours),
      fadedAt: record.lastSeenAt + totalHours * 3600000,
    })
  }

  dueForResurfacing(days?: number, limit?: number): readonly MemoryRecord[] {
    const window = typeof days === 'number' && days > 0 ? days : this.settings.resurfaceDays
    const take = Math.min(
      this.settings.maxSelectRows,
      Math.max(1, typeof limit === 'number' && limit > 0 ? Math.trunc(limit) : 1),
    )
    const cutoff = this.now() - window * DAY_MS
    try {
      const rows = this.store.select(TABLE_FACT, {
        where: [
          { column: 'archived', op: 'eq', value: 0 },
          { column: 'sealed', op: 'eq', value: 0 },
          { column: 'last_seen_at', op: 'lte', value: cutoff },
        ],
        // 最久没被带出的优先：这才是「忽然想起」的样子。
        orderBy: [{ column: 'last_seen_at', direction: 'asc' }],
        limit: take,
      })
      return rows.map(row => this.toRecord(row))
    } catch (error) {
      this.log.warn('取最低曝光候选失败：%s', messageOf(error))
      return []
    }
  }

  tombstoned(text: string): boolean {
    const digest = digestOf(text)
    if (digest === digestOf('')) return false
    try {
      return this.store.count(TABLE_TOMBSTONE, [{ column: 'digest', op: 'eq', value: digest }]) > 0
    } catch (error) {
      // 判不了就说「没被忘记」——宁可复活一条，也不要因为查不了而把整批写入挡掉。
      this.log.warn('查墓碑失败，按「未被忘记」处理：%s', messageOf(error))
      return false
    }
  }

  stats(): MemoryStats {
    const sample = this.sampleFacts()
    const avgSalience =
      sample.length === 0 ? 0 : sample.reduce((sum, record) => sum + record.salience, 0) / sample.length

    return Object.freeze({
      available: this.ready,
      reason: this.unavailable,
      provider: this.store.provider,
      tables: Object.freeze({
        raw: this.safeCount(TABLE_RAW),
        fact: this.safeCount(TABLE_FACT),
        tombstone: this.safeCount(TABLE_TOMBSTONE),
      }),
      states: Object.freeze({
        active: this.countFacts({ state: 'active' }),
        archived: this.countFacts({ state: 'archived' }),
        sealed: this.countFacts({ state: 'sealed' }),
      }),
      avgSalience,
      counters: Object.freeze({ ...this.counters }),
      issues: Object.freeze(this.issues.slice(-20)),
    })
  }

  /* ---------------------------- 内部实现 ---------------------------- */

  /**
   * 写一条事实（**事务内**，不自开事务）。
   *
   * 独立成私有方法而不是内联：`appendTurn` 与 `addFact` 两条路径必须走**同一段**
   * 打分/算寿命逻辑，否则「同事务写入」和「异步补写」会算出两个 S。
   */
  private writeFact(input: FactInput, rawId: string | undefined, at: number): MemoryRecord {
    const rawText = typeof input.text === 'string' ? input.text.trim() : ''
    if (rawText === '') throw new MemoryError('empty-text', '事实正文不能为空')

    const id = this.idForFact(input.id, rawText, at)
    const text = this.cutText(rawText, this.settings.maxTextChars, 'text-truncated', id)
    const summary =
      input.summary === undefined
        ? null
        : this.cutText(String(input.summary).trim(), this.settings.maxSummaryChars, 'summary-truncated', id)

    const category = asCategory(input.category)
    if (category === undefined) {
      this.pushIssue({
        code: 'bad-category',
        id,
        detail: `类别「${String(input.category)}」不在 11 类里，已按 misc 处理（寿命基线 20 小时）`,
      })
    }
    const kind = asKind(input.kind)
    if (kind === undefined) {
      this.pushIssue({ code: 'bad-kind', id, detail: `种类「${String(input.kind)}」不在五类里，已按 fact 处理` })
    }
    const finalCategory = category ?? 'misc'
    const finalKind = kind ?? 'fact'
    const channel = asChannel(input.channel) ?? this.settings.defaultChannel

    const salience =
      input.salience === undefined
        ? this.settings.scoreOnWrite
          ? scoreText(text, { category: finalCategory, longTermBaseHours: this.settings.longTermBaseHours })
          : 50
        : clampSalience(input.salience)
    const arousal = clampArousal(input.arousal)

    const stability = stabilityOf({
      category: finalCategory,
      channel,
      salience,
      arousal,
      timesSaid: 0,
      hits: 0,
      channelAnchorDays: this.settings.channelAnchorDays,
    })

    const row: RowLike = {
      id,
      kind: finalKind,
      category: finalCategory,
      channel,
      text,
      summary,
      subject: input.subject ?? null,
      salience,
      arousal,
      // 存**基线**，见文件头第 1 条。
      stability_hours: stability.hours,
      stability_mult: 1,
      // 写入那一次不算「被反复提起」，见文件头第 2 条。
      times_said: 0,
      hits: 0,
      revisions: 0,
      created_at: at,
      last_seen_at: at,
      last_hit_at: null,
      archived: 0,
      sealed: 0,
      source_raw_id: rawId ?? null,
      old_text: null,
      evidence: JSON.stringify(input.evidence ?? []),
    }

    this.store.insert(TABLE_FACT, row)
    this.counters.facts += 1
    return this.toRecord(row)
  }

  /**
   * 行 → 视图。**当前 S 在这里重算**（基线 × 提及因子 × 命中因子 × 订正倍数）。
   *
   * 这是本文件唯一允许算 S 的地方之一（另一处是 `writeFact`），
   * 别处一律调 `stabilityOf()`，不许自己拼公式。
   */
  private toRecord(row: RowLike): MemoryRecord {
    const category = asCategory(row['category']) ?? 'misc'
    const channel = asChannel(row['channel']) ?? this.settings.defaultChannel
    const kind = asKind(row['kind']) ?? 'fact'
    const salience = clampSalience(row['salience'])
    const arousal = clampArousal(row['arousal'])
    const timesSaid = Math.max(0, intOf(row['times_said'], 0))
    const hits = Math.max(0, intOf(row['hits'], 0))
    const rawMult = numOf(row['stability_mult'], 1)
    const mult = rawMult > 0 ? rawMult : 1

    const current = stabilityOf({
      category,
      channel,
      salience,
      arousal,
      timesSaid,
      hits,
      channelAnchorDays: this.settings.channelAnchorDays,
    })

    return Object.freeze({
      id: strOf(row['id']) ?? '',
      kind,
      category,
      channel,
      text: strOf(row['text']) ?? '',
      summary: strOf(row['summary']),
      subject: strOf(row['subject']),
      salience,
      arousal,
      stabilityBaseHours: numOf(row['stability_hours'], current.baseHours),
      stabilityMult: mult,
      stabilityHours: current.hours * mult,
      timesSaid,
      hits,
      revisions: Math.max(0, intOf(row['revisions'], 0)),
      createdAt: intOf(row['created_at'], 0),
      lastSeenAt: intOf(row['last_seen_at'], 0),
      lastHitAt: typeof row['last_hit_at'] === 'number' ? row['last_hit_at'] : null,
      archived: intOf(row['archived'], 0) === 1,
      sealed: intOf(row['sealed'], 0) === 1,
      important: isImportant(salience, this.settings.importantSalience),
      sourceRawId: strOf(row['source_raw_id']),
      oldText: strOf(row['old_text']),
      evidence: this.parseEvidence(row['evidence']),
    })
  }

  /** 解析引文 JSON；坏数据按空数组（一条坏引文不该让整条记忆读不出来）。 */
  private parseEvidence(value: unknown): readonly EvidenceRef[] {
    if (typeof value !== 'string' || value === '') return []
    try {
      const parsed: unknown = JSON.parse(value)
      if (!Array.isArray(parsed)) return []
      const out: EvidenceRef[] = []
      for (const item of parsed) {
        if (typeof item !== 'object' || item === null) continue
        const record = item as Record<string, unknown>
        const source = strOf(record['source'])
        const quote = strOf(record['quote'])
        if (source === null || quote === null) continue
        const index = record['messageIndex']
        out.push(
          typeof index === 'number'
            ? { source, quote, messageIndex: index }
            : { source, quote },
        )
      }
      return Object.freeze(out)
    } catch {
      return []
    }
  }

  /** 把查询条件翻成端口能吃的形状。 */
  private toWhere(query?: FactQuery): FilterLike[] {
    const where: FilterLike[] = []
    if (query === undefined) return where
    if (query.category !== undefined) where.push({ column: 'category', op: 'eq', value: query.category })
    if (query.kind !== undefined) where.push({ column: 'kind', op: 'eq', value: query.kind })
    if (query.channel !== undefined) where.push({ column: 'channel', op: 'eq', value: query.channel })
    if (query.subject !== undefined) where.push({ column: 'subject', op: 'eq', value: query.subject })
    if (query.ids !== undefined) where.push({ column: 'id', op: 'in', value: [...query.ids] })

    // 三个状态刻意分开判：`sealed` 与 `archived` 可以同时成立（封存到期后会归档），
    // 压成一个 eq 就会漏掉「已封存且已归档」的那批。
    if (query.state === 'active') {
      where.push({ column: 'archived', op: 'eq', value: 0 })
      where.push({ column: 'sealed', op: 'eq', value: 0 })
    } else if (query.state === 'archived') {
      where.push({ column: 'archived', op: 'eq', value: 1 })
    } else if (query.state === 'sealed') {
      where.push({ column: 'sealed', op: 'eq', value: 1 })
    }
    return where
  }

  /** 查询语句。`limit` 一律被 `maxSelectRows` 夹紧——这是内存保护，不是召回预算。 */
  private toSelect(query?: FactQuery): SelectQueryLike {
    const where = this.toWhere(query)
    const limit = Math.min(
      this.settings.maxSelectRows,
      Math.max(1, typeof query?.limit === 'number' ? Math.trunc(query.limit) : this.settings.maxSelectRows),
    )
    const orderBy =
      query?.orderBy === 'last-seen'
        ? [{ column: 'last_seen_at', direction: 'asc' as const }]
        : query?.orderBy === 'salience'
          ? [{ column: 'salience', direction: 'desc' as const }]
          : [{ column: 'created_at', direction: 'desc' as const }]

    const select: SelectQueryLike = { where, orderBy, limit }
    if (typeof query?.offset === 'number' && query.offset > 0) {
      return { ...select, offset: Math.trunc(query.offset) }
    }
    return select
  }

  /** 取一行，取不到抛 `not-found`（写路径要它，读路径用 `getFact` 返回 undefined）。 */
  private requireRow(id: string): RowLike {
    if (typeof id !== 'string' || id === '') throw new MemoryError('bad-argument', '记忆 id 不能为空')
    const row = this.store.get(TABLE_FACT, { id })
    if (row === undefined) {
      throw new MemoryError('not-found', `找不到记忆 ${id}（可能已被忘记）`, id)
    }
    return row
  }

  /** 生成或校验 id。 */
  private idForFact(given: string | undefined, text: string, at: number): string {
    if (typeof given === 'string' && MEMORY_ID_RE.test(given)) return given
    if (given !== undefined) {
      this.pushIssue({
        code: 'bad-id',
        detail: `传入的 id「${given}」不匹配 ^[a-z][a-z0-9_-]{1,63}$，已改用自动 id`,
      })
    }
    return `m-${this.suffix(text, at)}`
  }

  /** 生成一个短后缀（确定性，便于对拍：同一文本 + 同一时刻 + 同一序号 → 同一 id）。 */
  private suffix(text: string, at: number): string {
    this.seq += 1
    const digest = createHash('sha256').update(`${text}|${at}|${this.seq}`, 'utf8').digest('hex')
    return digest.slice(0, 12)
  }

  /** 按码点截断，超长记 issue（截断不是静默——issue 会进 `stats()`）。 */
  private cutText(
    text: string,
    max: number,
    code: 'text-truncated' | 'summary-truncated',
    id: string,
  ): string {
    const total = charCount(text)
    if (total <= max) return text
    this.pushIssue({ code, id, detail: `文本 ${total} 字超过上限 ${max} 字，已截断（拒绝写入等于这条记忆彻底消失）` })
    return [...text].slice(0, max).join('')
  }

  /** 记一条问题（有上限，超了只记一次）。 */
  private pushIssue(issue: MemoryIssue): void {
    if (this.issues.length >= MAX_ISSUES) {
      if (!this.issueDropped) {
        this.issueDropped = true
        this.issues.push({ code: 'too-many-issues', detail: `问题已超过 ${MAX_ISSUES} 条，后续不再记录` })
      }
      return
    }
    this.issues.push(issue)
  }

  /** 安全计数（表还没建好时返回 0，不抛）。 */
  private safeCount(table: string): number {
    try {
      return this.store.count(table)
    } catch {
      return 0
    }
  }

  /** 取样一批事实（给平均显著度用）。 */
  private sampleFacts(): readonly MemoryRecord[] {
    try {
      const rows = this.store.select(TABLE_FACT, {
        orderBy: [{ column: 'created_at', direction: 'desc' }],
        limit: STATS_SAMPLE_ROWS,
      })
      return rows.map(row => this.toRecord(row))
    } catch {
      return []
    }
  }

  /** 端口/建表状态守卫。 */
  private assertReady(): void {
    if (this.store.state === 'closed') {
      this.unavailable = 'closed'
      throw new MemoryError('closed', '存储端口已关闭，记忆内核不可写')
    }
    if (!this.ready) {
      this.unavailable = this.unavailable ?? 'schema-failed'
      throw new MemoryError('no-store', `记忆内核不可用：${this.unavailable ?? '未知原因'}`)
    }
  }
}
