/**
 * 爬楼服务：积压入库、排清单、确认推进游标。
 *
 * ## 为什么 `plan()` 不改游标
 *
 * 排完清单不等于清单交出去了。发送可能失败（通道断、被 O-042 门控拦、
 * 用户恰好切走）。自动推进的后果是那几条**永远没人再提**，而且不报错——
 * 主人只会觉得「她好像漏看了」。所以分成 `plan()` 与 `commit()` 两步。
 *
 * ## 为什么内存里不排序、取件时才排
 *
 * 通道重推的顺序不可信（有的平台先推新的）。入库时按 `at` 插到正确位置，
 * 取件时再按组轮转，两处各管一件事，谁都不用猜对方的状态。
 */

import type { Config } from './settings.js'
import { buildLines, composeText, fingerprintOf, normalizeItem } from './digest.js'
import { keyOf, readState, splitKey, writeState, SEEN_PER_GROUP, STATE_VERSION } from './state.js'
import type { GroupCursor } from './state.js'
import type {
  BacklogItem,
  ClimbCounters,
  ClimbReason,
  ClimbService,
  ClimbStats,
  ClockLike,
  DigestLine,
  DigestPlan,
  IngestOutcome,
  LogLike,
  PathLike,
  PendingGroup,
  PlanInput,
} from './types.js'

/** 游标存档的文件名（落在 `user/` 下）。 */
export const STATE_FILE_NAME = 'climb-state.json'

/** 同时记住几份计划。超了丢最旧的：一份计划活不过一轮。 */
const PLANS_MAX = 8

/** 面板最多列几个群。 */
const PENDING_VIEW_MAX = 64

/** 游标最多记多少个群（超出时留最近读过的）。 */
const CURSORS_MAX = 128

/** 内部可变的计数。对外只出冻结快照。 */
interface MutableCounters {
  ingested: number
  duplicate: number
  rejected: number
  expired: number
  planned: number
  committed: number
  overflowed: number
  writeFailed: number
}

/** 一份待确认的计划。 */
interface PlanRecord {
  readonly at: number
  readonly lines: readonly DigestLine[]
}

/** 构造入参。依赖全部用取值函数：上游晚装载时能自愈。 */
export interface ClimbOptions {
  readonly settings: Config
  readonly log: LogLike
  readonly clock: () => ClockLike | undefined
  readonly path: () => PathLike | undefined
  readonly now: () => number
}

/** 空计划。 */
function emptyPlan(at: number, id: string, reason: ClimbReason): DigestPlan {
  return Object.freeze({
    id,
    at,
    lines: Object.freeze([]),
    groups: Object.freeze([]),
    chars: 0,
    folded: 0,
    expired: 0,
    wake: false,
    reason,
    text: '',
  })
}

/** 把一条插进按时刻升序的队列。同时刻的排在后面（保持到达顺序）。 */
function insertSorted(queue: BacklogItem[], item: BacklogItem): void {
  let index = queue.length
  while (index > 0) {
    // `index > 0` 保证这一项存在。
    if (queue[index - 1].at <= item.at) break
    index -= 1
  }
  queue.splice(index, 0, item)
}

/** 已读指纹只留最近若干条。 */
function trimSeen(seen: Set<string>): void {
  while (seen.size > SEEN_PER_GROUP) {
    const first = seen.values().next()
    if (first.done === true) break
    seen.delete(first.value)
  }
}

/** 爬楼服务。 */
export class Climb implements ClimbService {
  private readonly deps: ClimbOptions
  private readonly settings: Config
  private readonly pendingByGroup = new Map<string, BacklogItem[]>()
  private readonly seenByGroup = new Map<string, Set<string>>()
  private readonly cursors = new Map<string, number>()
  private readonly plans = new Map<string, PlanRecord>()
  private readonly counters: MutableCounters = {
    ingested: 0,
    duplicate: 0,
    rejected: 0,
    expired: 0,
    planned: 0,
    committed: 0,
    overflowed: 0,
    writeFailed: 0,
  }

  private planSeq = 0
  // 游标是否落盘。与 getter stored 同名会冲突，故取别名。
  private storedFlag = false
  private disposed = false

  constructor(options: ClimbOptions) {
    this.deps = options
    this.settings = options.settings
    this.hydrate()
  }

  /** 是否可用。 */
  get available(): boolean {
    return !this.disposed
  }

  /** 游标是否真的落盘。 */
  get stored(): boolean {
    return this.storedFlag
  }

  /** 从存档恢复游标与已读指纹。 */
  private hydrate(): void {
    if (!this.settings.persistCursor) return
    const file = this.stateFile()
    if (file === undefined) return
    const state = readState(file)
    for (const [key, cursor] of Object.entries(state.groups)) {
      this.cursors.set(key, cursor.lastSeenAt)
      this.seenByGroup.set(key, new Set(cursor.seenIds))
    }
    this.storedFlag = true
  }

  /** 存档绝对路径；拿不到返回 `undefined`。 */
  private stateFile(): string | undefined {
    const path = this.deps.path()
    if (path === undefined) return undefined
    try {
      return path.fileIn('user', STATE_FILE_NAME)
    } catch {
      return undefined
    }
  }

  /** 取某个群的队列（没有就造一个）。 */
  private queueOf(key: string): BacklogItem[] {
    const existing = this.pendingByGroup.get(key)
    if (existing !== undefined) return existing
    const created: BacklogItem[] = []
    this.pendingByGroup.set(key, created)
    return created
  }

  /** 取某个群的已读集合（没有就造一个）。 */
  private seenOf(key: string): Set<string> {
    const existing = this.seenByGroup.get(key)
    if (existing !== undefined) return existing
    const created = new Set<string>()
    this.seenByGroup.set(key, created)
    return created
  }

  /** 待补读总条数。 */
  private pendingCount(): number {
    let total = 0
    for (const queue of this.pendingByGroup.values()) total += queue.length
    return total
  }

  /** 入库。 */
  ingest(items: readonly unknown[]): IngestOutcome {
    const pending = this.pendingCount()
    if (this.disposed) return { accepted: 0, duplicate: 0, rejected: 0, pending }
    if (!Array.isArray(items)) return { accepted: 0, duplicate: 0, rejected: 0, pending }
    if (!this.settings.enable) {
      return { accepted: 0, duplicate: 0, rejected: items.length, pending }
    }

    const now = this.deps.now()
    let accepted = 0
    let duplicate = 0
    let rejected = 0

    for (const raw of items) {
      const item = normalizeItem(raw, { maxChars: this.settings.maxCharsPerItem, now })
      if (item === undefined) {
        rejected += 1
        if (this.settings.verbose) this.deps.log.debug?.('爬楼拒收一条：结构不合法或正文为空')
        continue
      }

      // 私聊积压默认不接：私聊消息走正常回合，补读清单对它没有意义。
      // 计入 rejected 而不是悄悄丢掉，是为了让面板答得出「为什么这条没进」。
      if (item.chatKind === 'private' && !this.settings.includePrivateBacklog) {
        rejected += 1
        if (this.settings.verbose) {
          this.deps.log.debug?.('爬楼跳过一条私聊消息（include-private-backlog 关闭）')
        }
        continue
      }

      const key = keyOf(item.chatKind, item.groupId)
      const fingerprint = fingerprintOf(item)
      const cursor = this.cursors.get(key) ?? 0
      // 严格小于：游标只保证「比它早的都读过」，同一毫秒的另一条要靠指纹判。
      if (item.at < cursor) {
        duplicate += 1
        continue
      }

      const seen = this.seenOf(key)
      if (seen.has(fingerprint)) {
        duplicate += 1
        continue
      }

      const queue = this.queueOf(key)
      if (queue.some(entry => fingerprintOf(entry) === fingerprint)) {
        duplicate += 1
        continue
      }

      if (queue.length >= this.settings.maxPendingPerGroup) {
        queue.shift()
        this.counters.overflowed += 1
        this.deps.log.warn(
          '群 %s 的待补读超过上限 %d 条，已挤掉最旧的一条（补读不是存档，超出部分只能放弃）',
          item.groupId,
          this.settings.maxPendingPerGroup,
        )
      }

      insertSorted(queue, item)
      accepted += 1
    }

    this.counters.ingested += accepted
    this.counters.duplicate += duplicate
    this.counters.rejected += rejected
    return { accepted, duplicate, rejected, pending: this.pendingCount() }
  }

  /** 排一份清单。 */
  plan(input?: PlanInput): DigestPlan {
    const at = this.deps.now()
    const planId = `${at.toString(36)}-${(this.planSeq += 1).toString(36)}`
    if (this.disposed) return emptyPlan(at, planId, 'disabled')
    if (!this.settings.enable) return emptyPlan(at, planId, 'disabled')

    const chatKind = input?.chatKind === 'group' ? 'group' : 'private'
    // 群里不贴清单：积压是主人没看见的话，不是群里该被复读的话。
    if (chatKind === 'group') return emptyPlan(at, planId, 'group-only')
    if (this.pendingCount() === 0) return emptyPlan(at, planId, 'no-backlog')

    const cutoff = at - this.settings.maxAgeHours * 3_600_000
    const candidates: BacklogItem[] = []
    let expired = 0
    let skipped = 0

    for (const [key, queue] of [...this.pendingByGroup.entries()]) {
      const split = splitKey(key)
      if (split === undefined) continue
      if (split.chatKind === 'private' && !this.settings.includePrivateBacklog) continue

      const cursor = this.cursors.get(key) ?? 0
      const seen = this.seenByGroup.get(key)
      const keep: BacklogItem[] = []

      for (const item of queue) {
        if (item.at < cursor) {
          skipped += 1
          continue
        }
        if (seen !== undefined && seen.has(fingerprintOf(item))) {
          skipped += 1
          continue
        }
        if (item.at < cutoff) {
          expired += 1
          continue
        }
        keep.push(item)
      }

      if (keep.length === 0) this.pendingByGroup.delete(key)
      else if (keep.length !== queue.length) this.pendingByGroup.set(key, keep)
      candidates.push(...keep)
    }

    this.counters.expired += expired

    if (candidates.length === 0) {
      const reason: ClimbReason = expired > 0 || skipped > 0 ? 'all-seen' : 'no-backlog'
      return Object.freeze({ ...emptyPlan(at, planId, reason), expired })
    }

    // 群太多时先照顾「最旧一条更早」的群：那个群压得最久。
    const byKey = new Map<string, BacklogItem[]>()
    for (const item of candidates) {
      const key = keyOf(item.chatKind, item.groupId)
      const bucket = byKey.get(key)
      if (bucket === undefined) byKey.set(key, [item])
      else bucket.push(item)
    }
    const queues = [...byKey.values()]
      .sort((left, right) => (left[0]?.at ?? 0) - (right[0]?.at ?? 0))
      .slice(0, this.settings.maxGroups)

    const wanted = input?.maxItems
    const maxItems =
      typeof wanted === 'number' && Number.isFinite(wanted)
        ? Math.min(this.settings.maxItemsPerDigest, Math.max(1, Math.trunc(wanted)))
        : this.settings.maxItemsPerDigest

    const built = buildLines(queues.flat(), {
      maxItems,
      maxChars: this.settings.maxDigestChars,
      showGroupId: this.settings.showGroupId,
      parts: epoch => this.deps.clock()?.parts(epoch),
    })

    const reason: ClimbReason = built.lines.length > 0 ? 'ok' : 'too-long'
    const groups = [...new Set(built.lines.map(line => line.groupId))]
    const plan: DigestPlan = Object.freeze({
      id: planId,
      at,
      lines: built.lines,
      groups: Object.freeze(groups),
      chars: built.chars,
      folded: built.folded,
      expired,
      wake: built.lines.length > 0,
      reason,
      text: composeText(built.lines),
    })

    if (built.lines.length > 0) {
      this.plans.set(planId, { at, lines: built.lines })
      while (this.plans.size > PLANS_MAX) {
        const oldest = this.plans.keys().next()
        if (oldest.done === true) break
        this.plans.delete(oldest.value)
      }
      this.counters.planned += 1
    }

    return plan
  }

  /** 确认清单已交出去，推进游标。 */
  commit(planId: string): boolean {
    if (this.disposed) return false
    const record = this.plans.get(planId)
    if (record === undefined) return false

    const lastAt = new Map<string, number>()
    const fps = new Map<string, Set<string>>()
    for (const line of record.lines) {
      const previous = lastAt.get(line.key) ?? 0
      if (line.at > previous) lastAt.set(line.key, line.at)
      const set = fps.get(line.key)
      if (set === undefined) fps.set(line.key, new Set([line.fingerprint]))
      else set.add(line.fingerprint)
    }

    for (const [key, fingerprints] of fps) {
      const queue = this.pendingByGroup.get(key)
      let remaining: readonly BacklogItem[] = []
      if (queue !== undefined) {
        remaining = queue.filter(item => !fingerprints.has(fingerprintOf(item)))
        if (remaining.length === 0) this.pendingByGroup.delete(key)
        else this.pendingByGroup.set(key, [...remaining])
      }

      const seen = this.seenOf(key)
      for (const fingerprint of fingerprints) seen.add(fingerprint)
      trimSeen(seen)

      // 游标只能推到「剩下最旧那条」之前。直接推到本轮最大值会把
      // 「同一批里没装下的那几条」永久判成已读——它们比最大值早，
      // 却从来没被交出去。这是本轮自查抓到的唯一一个会真丢消息的 bug。
      const committedMax = lastAt.get(key) ?? 0
      const nextAt = remaining.length > 0 ? remaining[0].at : 0
      const target = nextAt > 0 ? Math.min(committedMax, nextAt - 1) : committedMax
      const cursor = this.cursors.get(key) ?? 0
      this.cursors.set(key, Math.max(cursor, target))
    }

    this.plans.delete(planId)
    this.counters.committed += 1
    this.trimCursors()
    this.persist()
    return true
  }

  /** 游标与已读集合不能无界增长：只留最近读过的若干群。 */
  private trimCursors(): void {
    if (this.cursors.size <= CURSORS_MAX) return
    const ranked = [...this.cursors.entries()].sort((left, right) => right[1] - left[1])
    const keep = new Set(ranked.slice(0, CURSORS_MAX).map(([key]) => key))
    for (const key of [...this.cursors.keys()]) {
      if (keep.has(key)) continue
      this.cursors.delete(key)
      this.seenByGroup.delete(key)
    }
  }

  /** 各群积压视图。 */
  pending(): readonly PendingGroup[] {
    const out: PendingGroup[] = []
    for (const [key, queue] of this.pendingByGroup) {
      if (queue.length === 0) continue
      const split = splitKey(key)
      if (split === undefined) continue
      // 上面已跳过空队列。
      const first = queue[0]
      const last = queue[queue.length - 1]
      out.push(
        Object.freeze({
          groupId: split.groupId,
          groupName: first.groupName !== undefined && first.groupName !== '' ? first.groupName : split.groupId,
          chatKind: split.chatKind,
          count: queue.length,
          oldestAt: first.at,
          newestAt: last.at,
        }),
      )
    }
    out.sort((left, right) => left.oldestAt - right.oldestAt)
    return Object.freeze(out.slice(0, PENDING_VIEW_MAX))
  }

  /** 现状快照。 */
  stats(): ClimbStats {
    let lastPlanAt = 0
    for (const record of this.plans.values()) {
      if (record.at > lastPlanAt) lastPlanAt = record.at
    }
    const counters: ClimbCounters = Object.freeze({ ...this.counters })
    return Object.freeze({
      available: !this.disposed,
      stored: this.storedFlag,
      pending: this.pendingCount(),
      groups: this.pendingByGroup.size,
      lastPlanAt,
      counters,
    })
  }

  /** 清掉积压与游标。 */
  reset(groupId?: string): void {
    if (this.disposed) return
    if (groupId === undefined) {
      this.pendingByGroup.clear()
      this.seenByGroup.clear()
      this.cursors.clear()
      this.plans.clear()
      this.persist()
      return
    }

    for (const key of [...this.pendingByGroup.keys()]) {
      const split = splitKey(key)
      if (split !== undefined && split.groupId === groupId) this.pendingByGroup.delete(key)
    }
    for (const key of [...this.seenByGroup.keys()]) {
      const split = splitKey(key)
      if (split !== undefined && split.groupId === groupId) this.seenByGroup.delete(key)
    }
    for (const key of [...this.cursors.keys()]) {
      const split = splitKey(key)
      if (split !== undefined && split.groupId === groupId) this.cursors.delete(key)
    }
    this.persist()
  }

  /** 卸载。 */
  dispose(): void {
    this.disposed = true
    this.pendingByGroup.clear()
    this.seenByGroup.clear()
    this.cursors.clear()
    this.plans.clear()
  }

  /** 把游标写盘。**永不抛错**。 */
  private persist(): void {
    if (!this.settings.persistCursor) return
    const path = this.deps.path()
    if (path === undefined) {
      this.storedFlag = false
      return
    }

    try {
      path.ensure('user')
      const file = path.fileIn('user', STATE_FILE_NAME)
      const groups: Record<string, GroupCursor> = {}
      for (const [key, lastSeenAt] of this.cursors) {
        const seen = this.seenByGroup.get(key)
        const seenIds = seen === undefined ? [] : [...seen].slice(-SEEN_PER_GROUP)
        groups[key] = { lastSeenAt, seenIds }
      }
      const ok = writeState(file, { version: STATE_VERSION, groups })
      if (!ok) {
        this.counters.writeFailed += 1
        this.deps.log.warn('爬楼游标写盘失败：重启后会把已经说过的积压再说一遍')
      }
      this.storedFlag = ok
    } catch (error) {
      this.counters.writeFailed += 1
      this.storedFlag = false
      this.deps.log.warn('爬楼游标写盘抛错：%s', error instanceof Error ? error.message : String(error))
    }
  }
}
