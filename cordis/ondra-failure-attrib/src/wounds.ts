/**
 * 伤口账本。三个判定全在这里，一个都不许挪到别处。
 *
 * ## 1. 伤口按「工具」记，不按「工具×因」记
 *
 * 手册：「伤口只在该器官下次成功时才闭合」——主体是器官，映射到工具层就是工具。
 * 一个工具同时因为两个原因失败，仍然是「这个工具现在不好使」一件事，
 * 它不该长出两个伤口、各自等一次成功。
 *
 * 但**每个原因的次数分开记**（`byCause`）：O-144 的反射弧判据是
 * 「同工具 × 同因失败 3 次」，合并计数会把两个不同的病因凑成 3 次，
 * 于是写出一条 `R-auto-unknown-<tool>` 的假反射。
 *
 * ## 2. 只在「同一个工具成功」时闭合
 *
 * 不是超时闭合，不是「过了就好」，也不是「别的工具成功了」。
 * 超时闭合会让一个一直坏着的工具看起来自愈了——那正是「静默降级」的变种。
 *
 * ## 3. 5 分钟未闭合标 chronic，然后停止空转
 *
 * 手册逐字。`sweep()` 只做标记，**不发通知、不重试、不写提示词**：
 * chronic 的意思是「别试了，等人」，不是「再试一次」。
 *
 * ## 账本满时不淘汰
 *
 * 到上限就拒绝新伤口并计数（`refused`）。淘汰最老的伤口会让 chronic 记录
 * 悄悄消失——那等于把证据删了，而报告上一切正常。
 */

import type { Cause, HealedWound, Wound, WoundStats } from './types.js'

/** 可变伤口（内部用；对外一律给冻结快照）。 */
interface MutableWound {
  tool: string
  cause: Cause
  openedAt: number
  lastAt: number
  failures: number
  byCause: Record<string, number>
  chronic: boolean
  chronicAt?: number
}

/**
 * 冻结一份伤口快照。
 * @param wound 内部伤口。
 */
function snapshot(wound: MutableWound): Wound {
  return Object.freeze({
    tool: wound.tool,
    cause: wound.cause,
    openedAt: wound.openedAt,
    lastAt: wound.lastAt,
    failures: wound.failures,
    byCause: Object.freeze({ ...wound.byCause }),
    chronic: wound.chronic,
    chronicAt: wound.chronicAt,
  })
}

/** 账本。 */
export class WoundBook {
  private readonly book = new Map<string, MutableWound>()
  /** 已闭合历史，新的在前。 */
  private readonly history: HealedWound[] = []

  private healedCount = 0
  private healedMsTotal = 0
  private chronicHealedCount = 0
  private refusedCount = 0

  private readonly maxOpen: () => number
  private readonly maxHistory: () => number

  /**
   * @param maxOpen 未闭合伤口上限（函数形式：配置可变）。
   * @param maxHistory 已闭合历史保留条数。
   */
  constructor(maxOpen: () => number, maxHistory: () => number) {
    this.maxOpen = maxOpen
    this.maxHistory = maxHistory
  }

  /**
   * 记一次失败：没有伤口就开一个，有就加深。
   * @param tool 工具名。
   * @param cause 归因。
   * @param at 时刻。
   * @returns 伤口快照；账本满且是新工具时返回 undefined（并计 `refused`）。
   */
  open(tool: string, cause: Cause, at: number): Wound | undefined {
    const existing = this.book.get(tool)
    if (existing !== undefined) {
      existing.cause = cause
      existing.lastAt = at
      existing.failures += 1
      existing.byCause[cause] = (existing.byCause[cause] ?? 0) + 1
      return snapshot(existing)
    }
    const limit = this.maxOpen()
    if (this.book.size >= limit) {
      this.refusedCount += 1
      return undefined
    }
    const fresh: MutableWound = {
      tool,
      cause,
      openedAt: at,
      lastAt: at,
      failures: 1,
      byCause: { [cause]: 1 },
      chronic: false,
    }
    this.book.set(tool, fresh)
    return snapshot(fresh)
  }

  /**
   * 记一次成功：闭合该工具的伤口。
   * @param tool 工具名。
   * @param at 时刻。
   * @returns 被闭合的伤口（没有伤口就是 undefined）。
   */
  close(tool: string, at: number): Wound | undefined {
    const wound = this.book.get(tool)
    if (wound === undefined) return undefined
    this.book.delete(tool)
    const openMs = Math.max(0, at - wound.openedAt)
    this.healedCount += 1
    this.healedMsTotal += openMs
    if (wound.chronic) this.chronicHealedCount += 1
    const closed: HealedWound = Object.freeze({
      ...snapshot(wound),
      closedAt: at,
      openMs,
    })
    this.history.unshift(closed)
    const cap = Math.max(1, this.maxHistory())
    while (this.history.length > cap) this.history.pop()
    return snapshot(wound)
  }

  /**
   * 检查超时：把该标 chronic 的标上。
   * @param at 时刻。
   * @param chronicAfterMs 多久没闭合算 chronic。
   * @returns 本次新标 chronic 的伤口。
   */
  sweep(at: number, chronicAfterMs: number): readonly Wound[] {
    const fresh: Wound[] = []
    for (const wound of this.book.values()) {
      if (wound.chronic) continue
      if (at - wound.openedAt < chronicAfterMs) continue
      wound.chronic = true
      wound.chronicAt = at
      fresh.push(snapshot(wound))
    }
    return Object.freeze(fresh)
  }

  /** 未闭合伤口（按最近失败时刻降序）。 */
  list(): readonly Wound[] {
    const all = [...this.book.values()].map(snapshot)
    all.sort((left, right) => right.lastAt - left.lastAt)
    return Object.freeze(all)
  }

  /**
   * 某个工具的伤口。
   * @param tool 工具名。
   */
  of(tool: string): Wound | undefined {
    const wound = this.book.get(tool)
    return wound === undefined ? undefined : snapshot(wound)
  }

  /**
   * 已闭合历史。
   * @param limit 最多几条。
   */
  healed(limit: number): readonly HealedWound[] {
    return Object.freeze(this.history.slice(0, Math.max(1, Math.trunc(limit))))
  }

  /** 统计。 */
  stats(): WoundStats {
    let chronic = 0
    for (const wound of this.book.values()) {
      if (wound.chronic) chronic += 1
    }
    return Object.freeze({
      open: this.book.size,
      chronic,
      healed: this.healedCount,
      chronicHealed: this.chronicHealedCount,
      meanHealMs: this.healedCount === 0 ? 0 : Math.round(this.healedMsTotal / this.healedCount),
      refused: this.refusedCount,
    })
  }

  /** 清空（卸载用）。 */
  clear(): void {
    this.book.clear()
    this.history.length = 0
  }
}
