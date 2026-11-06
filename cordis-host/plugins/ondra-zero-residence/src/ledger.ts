/**
 * 内存账本：**指针 id → 元数据**。正文是否在这里，取决于有没有存储后端。
 *
 * ## 为什么内存里可以没有正文
 *
 * 「零常驻」这个词对本插件自己也成立：启动时只把索引（id / 会话 / 序号 / 字数 / 指纹）
 * 读进内存，正文按需从库里取。512 条 × 4000 字全读进来是 2MB 常驻——
 * 一个号称零常驻的插件自己先常驻 2MB，说不过去。
 *
 * 例外只有一种：**没有存储后端、且用户显式关掉了 `require-durable`**。
 * 那时正文只能放内存，且进程退出即丢；`stats().durable` 会是 `false`，
 * README 里也写明「这是你自己选的」。
 *
 * ## 满了为什么不淘汰
 *
 * 与 O-139 的伤口账本同一条理由：淘汰最老的记录 = 删掉一条别人手里还握着指针的证据。
 * 之后 `recall` 会返回 `not-found`，而调用方以为「压缩是安全的」。
 * 所以满了就拒收新记录并计数（`byReason.ledger-full`），让人看见。
 */

import { pointerOf } from './pointer.js'
import type { ZrRecord, ZrRecordView } from './types.js'

/** 账本条目：元数据 +（可能）正文。 */
export interface ZrEntry extends ZrRecord {
  /** 正文。有存储后端时**不填**（按需从库里取）。 */
  readonly text?: string
}

/**
 * 把条目摊成对外的记录视图。
 *
 * 逐字段列出来而不是 `{...entry}`：展开语法会把 `text` 一起带出去，
 * 而 `ledger()` 的契约是**不倒正文**——差一个字段，审计接口就成了泄露接口。
 * @param entry 账本条目。
 */
function viewOf(entry: ZrEntry): ZrRecordView {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    ordinal: entry.ordinal,
    chars: entry.chars,
    fnv: entry.fnv,
    createdAt: entry.createdAt,
    pointer: pointerOf(entry.id, entry.chars),
  }
}

/** 内存账本。 */
export class ZrLedger {
  /** id → 条目。id 全局唯一（指纹里已经含了会话）。 */
  private readonly byId = new Map<string, ZrEntry>()

  /** 会话 → 该会话的 id 集合（只用于列举与序号分配）。 */
  private readonly bySession = new Map<string, Set<string>>()

  constructor(private readonly capacity: number) {}

  /** 当前条数。 */
  get size(): number {
    return this.byId.size
  }

  /** 容量上限。 */
  get limit(): number {
    return this.capacity
  }

  /**
   * 取一条（只含元数据）。
   * @param id 指针 id。
   */
  get(id: string): ZrEntry | undefined {
    return this.byId.get(id)
  }

  /** id 是否已被占用（任何会话）。 */
  has(id: string): boolean {
    return this.byId.has(id)
  }

  /**
   * 还能不能再放这么多条。
   * @param extra 待放条数。
   */
  canHold(extra: number): boolean {
    return this.byId.size + extra <= this.capacity
  }

  /**
   * 这个会话里下一个序号。
   * @param sessionId 会话 id。
   */
  nextOrdinal(sessionId: string): number {
    const ids = this.bySession.get(sessionId)
    if (ids === undefined || ids.size === 0) return 0
    let max = -1
    for (const id of ids) {
      const entry = this.byId.get(id)
      if (entry !== undefined && entry.ordinal > max) max = entry.ordinal
    }
    return max + 1
  }

  /**
   * 放一条。**越界时拒收**（返回 false），不淘汰。
   * @param entry 条目。
   */
  put(entry: ZrEntry): boolean {
    if (!this.byId.has(entry.id) && !this.canHold(1)) return false
    this.byId.set(entry.id, entry)
    let ids = this.bySession.get(entry.sessionId)
    if (ids === undefined) {
      ids = new Set<string>()
      this.bySession.set(entry.sessionId, ids)
    }
    ids.add(entry.id)
    return true
  }

  /**
   * 列账。省略会话就是全部会话。
   * @param sessionId 会话 id。
   */
  list(sessionId?: string): readonly ZrRecordView[] {
    const out: ZrRecordView[] = []
    if (sessionId === undefined) {
      for (const entry of this.byId.values()) out.push(viewOf(entry))
    } else {
      const ids = this.bySession.get(sessionId)
      if (ids !== undefined) {
        for (const id of ids) {
          const entry = this.byId.get(id)
          if (entry !== undefined) out.push(viewOf(entry))
        }
      }
    }
    // 单会话按序号倒序（新的在前）；跨会话时序号不可比，只能按时刻。
    if (sessionId === undefined) {
      out.sort((a, b) => b.createdAt - a.createdAt)
    } else {
      out.sort((a, b) => (a.ordinal === b.ordinal ? b.createdAt - a.createdAt : b.ordinal - a.ordinal))
    }
    return out
  }

  /**
   * 某会话（或全部）的字符总数。
   * @param sessionId 会话 id；省略为全部。
   */
  charsOf(sessionId?: string): number {
    if (sessionId === undefined) {
      let total = 0
      for (const entry of this.byId.values()) total += entry.chars
      return total
    }
    const ids = this.bySession.get(sessionId)
    if (ids === undefined) return 0
    let total = 0
    for (const id of ids) total += this.byId.get(id)?.chars ?? 0
    return total
  }

  /** 清空。 */
  clear(): void {
    this.byId.clear()
    this.bySession.clear()
  }
}
