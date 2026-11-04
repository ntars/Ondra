/**
 * 口头禅池与会话账本。
 *
 * ## 为什么池子要「不够就不插」
 *
 * 手册 §4.2 有一句判词：「口头禅池是静态的会让人设僵化」。池子只有 3 条时，
 * 她会在两轮之内把三条全用一遍，第三轮开始重复——用户看到的不是「有口癖」，
 * 是「复读机」。所以 `ready` 不到 12 条时 `apply()` **一个字都不插**，
 * 并在 `marks` 里留一条 `habit-no-pool`，让面板能解释「为什么没口癖」。
 *
 * ## 为什么按六态分档、不跨档借用
 *
 * 手册只说「按情绪分档」，没给档名。这里直接用 O-031 的六态，不另造一套
 * 「高/中/低」——两套情绪词并存，同一句话会被两处判定，然后两边都「看起来对」。
 * 跨档借用（炸毛时用困档的口头禅）会让语气和人设打架，所以**只在通用档兜底**，
 * 通用档也没有时就不插。
 *
 * ## 单场计数为什么在内存
 *
 * 「单场」= 一次会话。落盘会让重启后的第一句话就带着上一场用剩的额度，
 * 而用户感知是「刚开新对话她就又在重复那句」。
 */

import { MAX_HABIT_CHARS, isStateLike } from './types.js'
import type { ExpressStateLike, HabitEntry, HabitEntryInput, HabitPlacement } from './types.js'

/** 段内的标点。注册时剥掉——`insertHabit()` 自己会补逗号。 */
const TRAILING_PUNCT = /[，,、。！？…～!?~\s]+$/g

/** 判一个值是不是合法插入位。 */
function isPlacement(value: unknown): value is HabitPlacement {
  return value === 'prefix' || value === 'suffix' || value === 'any'
}

/** 归一化的结果。 */
export interface NormalizedPool {
  readonly entries: readonly HabitEntry[]
  readonly dropped: number
  readonly issues: readonly string[]
}

/**
 * 归一化一批口头禅。**永不抛错**：坏条目逐条丢弃并说明原因。
 * @param inputs 原始条目。
 * @param maxSize 池子上限（超出部分丢弃）。
 */
export function normalizeEntries(inputs: readonly HabitEntryInput[], maxSize: number): NormalizedPool {
  const entries: HabitEntry[] = []
  const issues: string[] = []
  const seenText = new Set<string>()
  const seenId = new Set<string>()
  let dropped = 0

  for (const [index, input] of inputs.entries()) {
    if (typeof input !== 'object' || input === null) {
      dropped += 1
      issues.push('第 ' + String(index + 1) + ' 条不是对象，已丢弃')
      continue
    }
    const rawText = typeof input.text === 'string' ? input.text : ''
    const text = rawText.trim().replace(TRAILING_PUNCT, '').trim()
    if (text === '') {
      dropped += 1
      issues.push('第 ' + String(index + 1) + ' 条正文为空，已丢弃')
      continue
    }
    if (Array.from(text).length > MAX_HABIT_CHARS) {
      dropped += 1
      issues.push('「' + text + '」超过 ' + String(MAX_HABIT_CHARS) + ' 字，已丢弃（口头禅不是台词）')
      continue
    }
    if (seenText.has(text)) {
      dropped += 1
      issues.push('「' + text + '」重复，已丢弃')
      continue
    }

    let states: readonly ExpressStateLike[] | undefined
    if (Array.isArray(input.states)) {
      const filtered = input.states.filter(isStateLike)
      const unique = Array.from(new Set(filtered))
      if (unique.length !== input.states.length) {
        issues.push(
          '「' + text + '」有 ' + String(input.states.length - unique.length) + ' 个重复或无法识别的状态名，已忽略',
        )
      }
      // 全被过滤掉 → 退化成通用条目（**不是**丢弃：条目本身还是好的）。
      states = unique.length > 0 ? unique : undefined
    }

    const placement: HabitPlacement = isPlacement(input.placement) ? input.placement : 'any'

    let id = typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : 'h' + String(index + 1)
    if (seenId.has(id)) {
      const next = 'h' + String(index + 1)
      issues.push('id「' + id + '」重复，已改用「' + next + '」')
      id = next
    }

    seenText.add(text)
    seenId.add(id)
    entries.push(Object.freeze({ id, text, states, placement }))
  }

  if (entries.length > maxSize) {
    const extra = entries.length - maxSize
    dropped += extra
    issues.push('超出上限 ' + String(maxSize) + ' 条，已丢弃后 ' + String(extra) + ' 条')
    return Object.freeze({ entries: Object.freeze(entries.slice(0, maxSize)), dropped, issues: Object.freeze(issues) })
  }
  return Object.freeze({ entries: Object.freeze(entries), dropped, issues: Object.freeze(issues) })
}

/**
 * 抽一条口头禅。
 * @param entries 池内条目。
 * @param state 当前六态（未知则只用通用档）。
 * @param used 本场已用过的 id。
 * @param rng 随机源。
 * @returns 抽不到时 `undefined`（**不跨档借用**）。
 */
export function pickHabit(
  entries: readonly HabitEntry[],
  state: ExpressStateLike | undefined,
  used: ReadonlySet<string>,
  rng: () => number,
): HabitEntry | undefined {
  const candidates = entries.filter(entry => !used.has(entry.id))
  if (candidates.length === 0) return undefined
  const exact =
    state === undefined
      ? []
      : candidates.filter(entry => entry.states !== undefined && entry.states.includes(state))
  const generic = candidates.filter(entry => entry.states === undefined)
  const pool = exact.length > 0 ? exact : generic
  if (pool.length === 0) return undefined
  const index = Math.min(pool.length - 1, Math.floor(rng() * pool.length))
  return pool[index]
}

/** 一场的账。 */
export interface SessionState {
  /** 本场已用口头禅次数。 */
  count: number
  /** 本场已用过的口头禅 id（同一条不重复）。 */
  used: Set<string>
  /** 本场已发出的条数（贴纸闸门计距用）。 */
  messages: number
  /** 上次贴纸时的条数；`null` 表示本场还没贴过。 */
  lastStickerAt: number | null
  /** 最后活动时刻（LRU 淘汰用）。 */
  at: number
}

/**
 * 会话账本。**纯内存、有上限、不装定时器**。
 *
 * 上限 200 场：超过就淘汰最久没动的。淘汰的代价只是「那场口头禅额度归零」，
 * 比无限增长把内存吃光好。
 */
export class SessionLedger {
  private readonly map = new Map<string, SessionState>()

  private readonly cap: number

  constructor(cap: number) {
    this.cap = cap
  }

  /** 取（必要时建）一场的账。 */
  touch(sessionId: string, at: number): SessionState {
    const existing = this.map.get(sessionId)
    if (existing !== undefined) {
      existing.at = at
      return existing
    }
    const fresh: SessionState = { count: 0, used: new Set<string>(), messages: 0, lastStickerAt: null, at }
    this.map.set(sessionId, fresh)
    this.evict()
    return fresh
  }

  /**
   * 只读取一场的账，**不建、不动 LRU**。
   *
   * 与 `touch()` 分开是硬要求：面板每几秒刷一次贴纸闸门，
   * 若刷新也算「活动」，正在聊的那场会被反复置顶，别的场永远轮不到淘汰。
   * @param sessionId 会话 id。
   */
  peek(sessionId: string): SessionState | undefined {
    return this.map.get(sessionId)
  }

  /** 开一场（口头禅次数与已用集合归零，条数与贴纸位置保留）。 */
  begin(sessionId: string, at: number): void {
    const state = this.touch(sessionId, at)
    state.count = 0
    state.used.clear()
  }

  /** 当前场数。 */
  size(): number {
    return this.map.size
  }

  /** 淘汰最久没动的一场。 */
  private evict(): void {
    if (this.map.size <= this.cap) return
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, state] of this.map) {
      if (state.at < oldestAt) {
        oldestAt = state.at
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) this.map.delete(oldestKey)
  }
}
