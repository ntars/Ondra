/**
 * 遗忘审计的门面（**唯一对外实现** `AuditService` 的类）。
 *
 * 四件事在这里收口，别处不许再写一遍：
 *
 * 1. **解释不重算。** 强度、剩余时间、掉到地板的时刻全部来自
 *    `core.strengthOf()`；本插件只把它的返回值与记录字段翻译成人话。
 * 2. **话术不复制。** 三档话术调 `decay.clarityOf(strength)`（O-013 的唯一真源）。
 *    O-013 缺席时 `clarity` 为 `undefined`——**宁可不说话术，也不自算阈值**。
 * 3. **删除经内核。** `forget` / `seal` / `revise` 都走 O-010 的服务方法，
 *    本插件只额外做两件 O-010 不管的事：清钉子、清孤儿边。
 * 4. **钉住靠 `markSeen()` 续命，不靠改表。**
 *    `archiveDue()` 是批量无差别沉底，没有「按 id 沉底」的接口。
 *    钉住项本来就每轮都进注入，故在归档前先 `markSeen(pinned)` 把它们标成
 *    「刚被带出」——这是符合语义的做法，而不是绕过规则。
 *    万一续命失效（钉住项仍被沉底），`ArchiveReport.pinnedSunk` 会把它列出来并告警。
 */

import { AuditError, DELETION_MODES } from './types.js'
import type {
  ArchiveReport,
  AuditCounters,
  AuditIssue,
  AuditReport,
  AuditService,
  AuditStats,
  AuditUnavailableReason,
  DecayLike,
  DeletionModeDoc,
  ExplainView,
  FadingItem,
  ForgetOutcome,
  GraphLike,
  LogLike,
  MemoryCoreLike,
  MemoryRecordLike,
  MemoryStateLike,
  PinRecord,
  StoreLike,
} from './types.js'
import type { Config } from './settings.js'
import { categoryLabel, previewOf, reasonsOf } from './explain.js'
import { PinStore } from './store.js'

/** 问题列表上限（防止一个坏掉的库把内存吃干）。 */
const MAX_ISSUES = 20

/** 最低曝光候选的条数上限（报告用；「补 1 条」的决定权在 O-036）。 */
const RESURFACE_LIST_LIMIT = 20

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 承诺与待办仓库。 */
export class AuditRepository implements AuditService {
  private readonly pins: PinStore | undefined
  private readonly core: MemoryCoreLike | undefined
  private readonly decay: DecayLike | undefined
  private readonly graph: GraphLike | undefined
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number

  /** 建表结果：`undefined` = 还没试过。 */
  private storeReady: boolean | undefined = undefined

  private readonly issues: AuditIssue[] = []

  private counters: {
    explained: number
    pinned: number
    unpinned: number
    forgotten: number
    sealed: number
    revised: number
    archivedScans: number
  } = { explained: 0, pinned: 0, unpinned: 0, forgotten: 0, sealed: 0, revised: 0, archivedScans: 0 }

  /**
   * @param store 存储端口；`undefined` 表示端口缺席（钉子无处可放）。
   * @param core 记忆内核；`undefined` 表示缺席（解释与删除都做不了）。
   * @param decay 衰减服务（只借话术）；`undefined` 表示缺席。
   * @param graph 图谱服务（只借清孤儿边）；`undefined` 表示缺席。
   * @param settings 配置。
   * @param log 日志。
   * @param now 取当前时刻（测试可注入）。
   */
  constructor(
    store: StoreLike | undefined,
    core: MemoryCoreLike | undefined,
    decay: DecayLike | undefined,
    graph: GraphLike | undefined,
    settings: Config,
    log: LogLike,
    now: () => number,
  ) {
    this.pins = store === undefined ? undefined : new PinStore(store, log)
    this.core = core
    this.decay = decay
    this.graph = graph
    this.settings = settings
    this.log = log
    this.now = now
  }

  /** 建钉子表。由入口在 `ctx.effect` 里调一次。 */
  ready(): boolean {
    if (this.pins === undefined) {
      this.storeReady = false
      return false
    }
    this.storeReady = this.pins.ensure()
    return this.storeReady
  }

  /** 是否可用（解释与删除都要内核；钉子还要存储）。 */
  get available(): boolean {
    if (!this.settings.enable) return false
    if (this.core === undefined || !this.core.available) return false
    return this.storeReady === true
  }

  /** 不可用原因。**内核优先**：它缺席时存储再好也没用。 */
  get reason(): AuditUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (this.core === undefined || !this.core.available) return 'no-core'
    if (this.pins === undefined) return 'no-store'
    if (this.storeReady === false) return 'schema-failed'
    return undefined
  }

  /**
   * 记一条问题（最多 20 条，超出后只留一条「太多」的提示）。
   * @param issue 问题。
   */
  private note(issue: AuditIssue): void {
    if (this.issues.length >= MAX_ISSUES) {
      if (!this.issues.some(item => item.code === 'too-many-issues')) {
        this.issues.push({ code: 'too-many-issues', detail: '问题太多，后续只记这一条' })
      }
      return
    }
    this.issues.push(issue)
  }

  /** 断言可删可改（内核 + 存储都在位）。 */
  private assertUsable(): MemoryCoreLike {
    if (!this.settings.enable) throw new AuditError('closed', '插件总开关已关闭')
    if (this.core === undefined) throw new AuditError('no-core', '没有记忆内核（ondra-memory-core）：无法解释或删除记忆')
    if (!this.core.available) throw new AuditError('no-core', '记忆内核不可用（未建表或端口已关闭）')
    if (this.pins === undefined) throw new AuditError('no-store', '没有可用存储端口：钉子无处可放')
    if (this.storeReady === false) throw new AuditError('no-store', '建钉子表失败')
    return this.core
  }

  /** 推断记忆状态（三态）。 */
  private stateOf(record: MemoryRecordLike): MemoryStateLike {
    if (record.sealed) return 'sealed'
    if (record.archived) return 'archived'
    return 'active'
  }

  /* ----------------------------- 解释 ----------------------------- */

  /**
   * 解释一条记忆为什么变成现在这样。
   * @param id 记忆 id。
   * @param at 时间戳。
   */
  explain(id: string, at?: number): ExplainView | undefined {
    if (!this.available) return undefined
    const core = this.core
    if (core === undefined) return undefined
    const stamp = at ?? this.now()
    const record = core.getFact(id)
    if (record === undefined) return undefined

    this.counters.explained += 1
    // 强度与剩余时间**只能来自内核**：这里重算一遍就是第二份公式。
    const strength = core.strengthOf(record, stamp)
    // 话术**只能来自 O-013**：这里复制一份阈值，产品调参时一半界面会说旧口径。
    const clarity = this.decay === undefined ? undefined : this.decay.clarityOf(strength.strength)
    const pinned = this.isPinned(id)
    const reasons = reasonsOf({
      record,
      strength: strength.strength,
      remainingHours: strength.remainingHours,
      pinned,
      at: stamp,
      fadingWindowMs: this.settings.fadingDays * 24 * 60 * 60 * 1000,
    })

    const base: ExplainView = {
      id: record.id,
      text: record.text,
      kind: record.kind,
      category: record.category,
      channel: record.channel,
      state: this.stateOf(record),
      pinned,
      important: record.important,
      salience: record.salience,
      arousal: record.arousal,
      timesSaid: record.timesSaid,
      hits: record.hits,
      revisions: record.revisions,
      baseHours: record.stabilityBaseHours,
      currentHours: record.stabilityHours,
      strength: strength.strength,
      remainingHours: strength.remainingHours,
      fadedAt: strength.fadedAt,
      reasons,
    }
    // `clarity` 是可选的：缺 O-013 时**不写这个键**，而不是写一个 `undefined`。
    // 写 `undefined` 会让 `'clarity' in view` 为真，调用方误以为话术存在。
    return clarity === undefined ? base : { ...base, clarity }
  }

  /* ----------------------------- 钉子 ----------------------------- */

  /**
   * 钉住一条（上限见 `pinCap`，手册默认 8）。
   * @param id 记忆 id。
   * @param note 备注。
   * @param at 时间戳。
   */
  pin(id: string, note?: string, at?: number): PinRecord {
    const core = this.assertUsable()
    const stamp = at ?? this.now()
    const record = core.getFact(id)
    if (record === undefined) throw new AuditError('not-found', `记忆 ${id} 不存在`, id)

    const existing = this.isPinned(id)
    if (!existing) {
      const current = this.pins === undefined ? 0 : this.pins.count()
      if (current >= this.settings.pinCap) {
        this.note({
          code: 'pin-full',
          detail: `钉子已满 ${this.settings.pinCap} 条，拒绝新建。先拔一根，本插件不会自动淘汰。`,
        })
        throw new AuditError(
          'pin-full',
          `钉子已满 ${this.settings.pinCap} 条（手册 §2.6 的上限就是 8）：请先拔掉一根，本插件不会替你决定哪件事可以忘`,
        )
      }
    }

    const rawNote = typeof note === 'string' ? note.trim() : ''
    const clipped = rawNote.length > this.settings.pinNoteMaxChars
    if (clipped) {
      this.note({ code: 'store-issue', id, detail: `钉子备注超过 ${this.settings.pinNoteMaxChars} 字，已截断` })
    }
    const pin: PinRecord = {
      id,
      pinnedAt: stamp,
      note: Array.from(rawNote).slice(0, this.settings.pinNoteMaxChars).join(''),
    }
    this.pins?.put(pin)
    this.counters.pinned += 1
    return pin
  }

  /**
   * 拔钉。
   * @param id 记忆 id。
   */
  unpin(id: string): boolean {
    if (this.pins === undefined) return false
    const removed = this.pins.remove(id) > 0
    if (removed) this.counters.unpinned += 1
    return removed
  }

  /**
   * 是否被钉住（**O-013 衰减时读它**）。
   * @param id 记忆 id。
   */
  isPinned(id: string): boolean {
    if (this.pins === undefined) return false
    return this.pins.get(id) !== undefined
  }

  /** 全部钉子（按钉住时间正序）。 */
  pinned(): readonly PinRecord[] {
    if (this.pins === undefined) return []
    return this.pins.all()
  }

  /* ----------------------------- 删除 ----------------------------- */

  /**
   * 忘记：真删并写墓碑，随后清钉子与孤儿边。
   * @param id 记忆 id。
   * @param reason 原因（写进墓碑）。
   */
  forget(id: string, reason: string): ForgetOutcome {
    const core = this.assertUsable()
    const why = typeof reason === 'string' ? reason.trim() : ''
    // 墓碑没有原因，以后就没人能解释「这条为什么没了」。宁可拒绝，也不写一条无字墓碑。
    if (why === '') throw new AuditError('bad-argument', '忘记必须给原因：墓碑里没有原因，以后没人能解释它为什么没了')

    const forgotten = core.forget(id, why)
    if (forgotten) this.counters.forgotten += 1

    // 清钉子：不清的话，界面上会出现一根「钉在空气里」的钉子。
    const pinRemoved = this.unpin(id)

    // 清孤儿边：O-015 缺席时**不假装清过了**，`edgesCleared` 会如实为 false。
    const edgesCleared = this.graph !== undefined
    let edgesRemoved = 0
    if (this.graph !== undefined) {
      try {
        edgesRemoved = this.graph.forgetOf(id)
      } catch (error) {
        this.note({ code: 'store-issue', id, detail: `清孤儿边失败（${messageOf(error)}）：边可能还在图谱里` })
      }
    }

    if (!forgotten) {
      this.note({ code: 'not-found', id, detail: '记忆内核说没有这条记忆，忘记未生效' })
    }
    return { forgotten, pinRemoved, edgesRemoved, edgesCleared }
  }

  /**
   * 封存：不主动注入、不参与回忆，按类检索仍可能翻到。
   * @param id 记忆 id。
   * @param at 时间戳。
   */
  seal(id: string, at?: number): MemoryRecordLike {
    const core = this.assertUsable()
    const record = core.seal(id, at ?? this.now())
    this.counters.sealed += 1
    return record
  }

  /**
   * 订正：留 `oldText`、`revisions+1`、`S×1.3`。
   * @param id 记忆 id。
   * @param text 新正文。
   * @param at 时间戳。
   */
  revise(id: string, text: string, at?: number): MemoryRecordLike {
    const core = this.assertUsable()
    const body = typeof text === 'string' ? text.trim() : ''
    if (body === '') throw new AuditError('bad-argument', '订正后的正文不能为空')
    const record = core.revise(id, body, at ?? this.now())
    this.counters.revised += 1
    return record
  }

  /** 四种删除模式的说明书（含 `sink` 为何没有方法）。 */
  deletionModes(): readonly DeletionModeDoc[] {
    return DELETION_MODES
  }

  /* ----------------------------- 扫描 ----------------------------- */

  /**
   * 审计扫描：**只出清单，不改内容**（手册 §2.7「无损自动 + 有损人审」）。
   * @param at 时间戳。
   */
  scan(at?: number): AuditReport {
    const stamp = at ?? this.now()
    const empty: AuditReport = {
      at: stamp,
      scanned: 0,
      complete: true,
      states: { active: 0, archived: 0, sealed: 0 },
      fading: [],
      resurfaceDue: [],
      pins: 0,
      issues: [...this.issues],
    }
    if (!this.available) return empty
    const core = this.core
    if (core === undefined) return empty

    const fading: FadingItem[] = []
    const states = { active: 0, archived: 0, sealed: 0 }
    const fadingHours = this.settings.fadingDays * 24
    let scanned = 0
    let complete = true

    // 分页扫：端口没有聚合面，也没有「按剩余时间排序」的能力。
    for (let offset = 0; offset < this.settings.scanLimit; offset += this.settings.pageSize) {
      const page = core.listFacts({
        limit: Math.min(this.settings.pageSize, this.settings.scanLimit - offset),
        offset,
        orderBy: 'created-at',
      })
      if (page.length === 0) break
      for (const record of page) {
        scanned += 1
        states[this.stateOf(record)] += 1
        // 沉底与封存的不算「快淡了」：它们已经不占主动位，再列出来只会淹没真清单。
        if (record.archived || record.sealed) continue
        const view = core.strengthOf(record, stamp)
        if (view.remainingHours > fadingHours) continue
        fading.push({
          id: record.id,
          preview: previewOf(record.text, this.settings.previewChars),
          category: categoryLabel(record.category),
          strength: view.strength,
          remainingHours: view.remainingHours,
          pinned: this.isPinned(record.id),
        })
      }
      if (page.length < this.settings.pageSize) break
      if (scanned >= this.settings.scanLimit) {
        complete = false
        break
      }
    }
    if (!complete) {
      this.note({
        code: 'scan-truncated',
        detail: `扫描撞到上限 ${this.settings.scanLimit} 条：清单不完整，别把它当成全量结论`,
      })
    }

    // 快淡了的按「剩余更少」排前：清单要能直接照着做，不是一堆无序 id。
    fading.sort((a, b) => a.remainingHours - b.remainingHours)

    let resurfaceDue: readonly string[] = []
    try {
      resurfaceDue = core.dueForResurfacing(this.settings.resurfaceDays, RESURFACE_LIST_LIMIT).map(item => item.id)
    } catch (error) {
      this.note({ code: 'store-issue', detail: `读最低曝光候选失败：${messageOf(error)}` })
    }

    return {
      at: stamp,
      scanned,
      complete,
      states,
      fading,
      resurfaceDue,
      pins: this.pins === undefined ? 0 : this.pins.count(),
      issues: [...this.issues],
    }
  }

  /**
   * 归档扫描：把超过窗口的记忆沉底；钉住的先续命。
   * @param at 时间戳。
   */
  archive(at?: number): ArchiveReport {
    const empty: ArchiveReport = { at: at ?? this.now(), sunk: [], pinnedKept: [], pinnedSunk: [] }
    if (!this.available) return empty
    const core = this.core
    if (core === undefined) return empty
    const stamp = at ?? this.now()

    const pinnedIds = this.pinned().map(pin => pin.id)
    // 先续命：`archiveDue()` 是批量无差别沉底，没有「按 id 沉底」的接口。
    // 钉住项本来就每轮都进注入（八块装配 ② 是常驻段），故标成「刚被带出」符合语义。
    if (pinnedIds.length > 0) {
      try {
        core.markSeen(pinnedIds, stamp)
      } catch (error) {
        // 续命失败不阻断归档，但必须报出来——否则钉住会静默失效。
        this.note({ code: 'store-issue', detail: `钉住项续命失败（${messageOf(error)}）：它们可能被一并沉底` })
      }
    }

    let sunk: readonly string[] = []
    try {
      sunk = core.archiveDue(stamp)
    } catch (error) {
      this.note({ code: 'store-issue', detail: `归档扫描失败：${messageOf(error)}` })
      return { ...empty, at: stamp }
    }
    this.counters.archivedScans += 1

    const pinnedSet = new Set(pinnedIds)
    const pinnedSunk = sunk.filter(id => pinnedSet.has(id))
    const pinnedKept = pinnedIds.filter(id => !pinnedSunk.includes(id))
    if (pinnedSunk.length > 0) {
      // 这条一旦出现，说明「续命」这条路失效了（例如内核换了实现）。
      // 不静默：钉住的意义就是「永不遗忘」，被沉底等于承诺失效。
      for (const id of pinnedSunk) {
        this.note({ code: 'pinned-sunk', id, detail: '钉住项仍被沉底：续命未生效，请检查 markSeen 是否被内核忽略' })
      }
      this.log.warn('归档把 %d 条钉住项也沉底了：钉住失效，需要人工看一眼', pinnedSunk.length)
    }

    return { at: stamp, sunk, pinnedKept, pinnedSunk }
  }

  /** 统计快照。 */
  stats(): AuditStats {
    const core = this.core
    let facts = 0
    if (core !== undefined && core.available) {
      try {
        facts = core.countFacts()
      } catch (error) {
        this.note({ code: 'store-issue', detail: `数记忆条数失败：${messageOf(error)}` })
      }
    }
    const counters: AuditCounters = { ...this.counters }
    return {
      available: this.available,
      reason: this.reason,
      provider: this.pins === undefined ? 'none' : this.pins.provider,
      pins: this.pins === undefined ? 0 : this.pins.count(),
      pinCap: this.settings.pinCap,
      facts,
      clarityAvailable: this.decay !== undefined,
      graphAvailable: this.graph !== undefined,
      counters,
      issues: [...this.issues],
    }
  }
}

