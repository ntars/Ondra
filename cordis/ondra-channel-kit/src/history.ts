/**
 * 对端历史：一份**每通道独立、仅在内存、上限 12 条**的环形缓冲。
 *
 * ## 为什么是工厂而不是「按 id 取」的注册表
 *
 * `history(id)` 看起来更省事，但它会让插件本体持有状态，而状态一旦在
 * 公共层里，就有两个已知的坏处：
 *
 * 1. **关掉通道不释放**——适配器卸载了，缓冲还挂在插件里，凭 id 谁也找不到它；
 * 2. **两个适配器可能共用一份**——只要它们拼出了同一个 id，就串味了。
 *    而串味正是 master-plan §16.2-4 要防的事（「跨渠道串味会毁人格连续性」）。
 *
 * 所以：**每次造新的**，实例归适配器。插件本体零状态，`stats()` 挂在实例上。
 *
 * ## 为什么满了挤掉最旧的，而不是拒绝新的
 *
 * 通道场景里「最新那句话」永远比「十二条之前那句」重要。而拒收会让
 * 「她记得十二句前、却忘了刚刚那句」——恰好是最容易被用户察觉的那种错。
 * 挤掉的条数计入 `stats().evicted`，不静默。
 */

import type { PeerEntry, PeerHistory, PeerHistoryStats, PeerRole, PushOutcome } from './types.js'
import { PEER_HISTORY_LIMIT, PEER_TEXT_MAX } from './types.js'

/**
 * 取角色，非法值**按对端处理**。
 *
 * 方向是刻意的：认不出来时当成「用户说的话」，最坏是她的上下文里多一句
 * 别人的话；当成「自己说的」则会让模型以为那些话是自己讲的。
 * @param value 待判的值。
 */
function roleOf(value: unknown): PeerRole {
  return value === 'self' ? 'self' : 'peer'
}

/** 一份对端历史。 */
export class PeerHistoryBuffer implements PeerHistory {
  /** 上限。 */
  readonly capacity: number

  private entries: PeerEntry[] = []
  private pushed = 0
  private evicted = 0
  private rejected = 0

  /**
   * @param capacity 上限；省略取 12。**大于 12 会被压回 12**（见 `settings.ts`）。
   */
  constructor(capacity: number = PEER_HISTORY_LIMIT) {
    const wanted = Number.isFinite(capacity) ? Math.trunc(capacity) : PEER_HISTORY_LIMIT
    this.capacity = Math.min(PEER_HISTORY_LIMIT, Math.max(1, wanted))
  }

  /** 当前条数。 */
  get size(): number {
    return this.entries.length
  }

  /** 收一条。 */
  push(entry: PeerEntry): PushOutcome {
    const text = typeof entry === 'object' && entry !== null && typeof entry.text === 'string' ? entry.text : ''

    // 空正文（含只有空白）不收：它会占掉一格，却什么信息都没有。
    if (text.trim() === '') {
      this.rejected += 1
      return Object.freeze({ accepted: false, size: this.entries.length, evicted: false, truncated: false })
    }

    const truncated = text.length > PEER_TEXT_MAX
    const stored = truncated ? text.slice(0, PEER_TEXT_MAX) : text
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0

    this.entries.push(Object.freeze({ role: roleOf(entry.role), text: stored, at }))
    this.pushed += 1

    let didEvict = false
    while (this.entries.length > this.capacity) {
      this.entries.shift()
      this.evicted += 1
      didEvict = true
    }

    return Object.freeze({
      accepted: true,
      size: this.entries.length,
      evicted: didEvict,
      truncated,
    })
  }

  /** 只读全部（从旧到新）。 */
  all(): readonly PeerEntry[] {
    return this.entries.slice()
  }

  /** 清空。 */
  clear(): void {
    this.entries = []
  }

  /** 统计快照。 */
  stats(): PeerHistoryStats {
    return Object.freeze({
      capacity: this.capacity,
      size: this.entries.length,
      pushed: this.pushed,
      evicted: this.evicted,
      rejected: this.rejected,
    })
  }

  /** 转成对话链能吃的历史形状。 */
  messages(options?: { readonly includeSelf?: boolean }): readonly {
    readonly role: 'user' | 'assistant'
    readonly content: string
  }[] {
    const includeSelf = options?.includeSelf !== false
    const out: { readonly role: 'user' | 'assistant'; readonly content: string }[] = []
    for (const entry of this.entries) {
      if (entry.role === 'self' && !includeSelf) continue
      out.push(
        Object.freeze({
          role: entry.role === 'self' ? ('assistant' as const) : ('user' as const),
          content: entry.text,
        }),
      )
    }
    return out
  }
}
