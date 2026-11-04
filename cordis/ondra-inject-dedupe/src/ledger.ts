/**
 * 账本：**谁进过上下文**。
 *
 * 纯数据结构，不碰 `ctx`、不碰 IO、不碰时间（时刻由调用方传入）。
 *
 * ## 一、为什么记账键不是 id 本身（本轮最关键的一条）
 *
 * O-036 的条目 id 带**块前缀**：同一条记忆这轮作为钉住是 `pin:<factId>`，
 * 下轮作为召回是 `mem:<factId>`。按 id 记账，她这轮说「你之前说想去冰岛」，
 * 下轮还说得出口——因为在她眼里那是两条不同的东西。
 *
 * 故本插件把 id 归到「别名族」再记账：
 *
 * ```
 *   mem:<factId>   ─┐
 *                   ├─→  fact:<factId>     （共用一族）
 *   pin:<factId>   ─┘
 *
 *   promise:<id>   ───→  promise:<id>      （承诺 id 与记忆 id 不同源，**不跨族展开**）
 *   无前缀 id      ───→  <id>              （认不出格式就原样记，绝不猜）
 * ```
 *
 * **为什么只让 mem/pin 同族**：O-036 的 `PinRecord.factId` 与记忆主键同源（有据），
 * 而承诺 id、待办 id 是各自表的主键，**没有任何依据说明它们与记忆 id 同源**。
 * 若为了「多挡一点」把所有前缀都并成一族，一个 `promise:7` 会把 `mem:7` 也挡掉——
 * 那是拿「省字」换「丢一条无关的记忆」，方向反了。
 *
 * ## 二、容量与挤出的取舍
 *
 * 满了就把「最久没被记上」的那条挤出。被挤出的条目下次可能再注入一次——
 * 这是**已知且刻意接受**的代价（README 已知限制 2）。反向选择（满了就拒绝新记账）
 * 更糟：拒绝记账会让新条目每轮都重复注入，而那正是要修的 bug。
 */

/** id 拆解结果。 */
export interface IdParts {
  /** 块前缀（`mem` / `pin` / `promise` / `''`）。 */
  readonly prefix: string
  /** 原始 id。 */
  readonly ref: string
}

/** 与记忆主键同源的前缀。**只有这两个**，加第三个要有依据。 */
const FACT_PREFIXES: ReadonlySet<string> = new Set(['mem', 'pin'])

/** 别名族的族名。 */
const FACT_FAMILY = 'fact'

/**
 * 拆 id。
 *
 * 只在**第一个**冒号处切：`a:b:c` → `a` / `b:c`，保证 `idsOfKey(keyOfId(id))` 能原样还原。
 * @param id 条目 id。
 */
export function parseId(id: string): IdParts {
  const at = id.indexOf(':')
  if (at <= 0) return { prefix: '', ref: id }
  return { prefix: id.slice(0, at), ref: id.slice(at + 1) }
}

/**
 * id → 记账键。
 * @param id 条目 id；空串返回空串（调用方应跳过）。
 */
export function keyOfId(id: string): string {
  if (id === '') return ''
  const parts = parseId(id)
  if (parts.prefix === '') return parts.ref
  if (FACT_PREFIXES.has(parts.prefix)) return `${FACT_FAMILY}:${parts.ref}`
  return `${parts.prefix}:${parts.ref}`
}

/**
 * 记账键 → 交回 O-036 的 id 形态。
 *
 * `fact:x` 出两个（`mem:x` 与 `pin:x`）：O-036 用**精确 id 比较**判已见，
 * 只给一个就会漏掉另一块。其余族原样出。
 * @param key 记账键。
 */
export function idsOfKey(key: string): readonly string[] {
  if (key === '') return []
  const at = key.indexOf(':')
  if (at < 0) return [key]
  const family = key.slice(0, at)
  const ref = key.slice(at + 1)
  if (family === FACT_FAMILY) return [`mem:${ref}`, `pin:${ref}`]
  return [`${family}:${ref}`]
}

/** 一次批量记账的结果。 */
export interface AddOutcome {
  /** 新记上几条。 */
  readonly added: number
  /** 本来就在账本里几条。 */
  readonly skipped: number
  /** 因容量被挤出几条。 */
  readonly evicted: number
}

/**
 * 单会话账本。
 *
 * 用 `Map` 的插入顺序当「最久没被记上」的顺序：命中已存在的键时先 `delete` 再 `set`，
 * 让它回到队尾（写时 LRU）。这样高频出现的记忆不会被低频的新记录挤掉。
 */
export class Ledger {
  private readonly seen = new Map<string, number>()
  private evictedCount = 0
  private releaseCount = 0

  /**
   * @param capacity 容量上限（> 0，由配置夹住）。
   */
  constructor(private readonly capacity: number) {}

  /** 已记条数。 */
  get size(): number {
    return this.seen.size
  }

  /** 容量上限。 */
  get capacityLimit(): number {
    return this.capacity
  }

  /** 累计挤出条数。 */
  get evicted(): number {
    return this.evictedCount
  }

  /** 被释放过几次。 */
  get releases(): number {
    return this.releaseCount
  }

  /**
   * 是否记过。
   * @param key 记账键。
   */
  has(key: string): boolean {
    return this.seen.has(key)
  }

  /**
   * 记一条。已存在则刷新顺序（不增计数）。
   * @param key 记账键；空串忽略。
   * @param at 时刻。
   */
  add(key: string, at: number): 'added' | 'skipped' {
    if (key === '') return 'skipped'
    if (this.seen.has(key)) {
      this.seen.delete(key)
      this.seen.set(key, at)
      return 'skipped'
    }
    this.seen.set(key, at)
    // 上限至少 50（配置夹住），这里再兜一次，防止直接 new Ledger(0) 时把刚记的也挤掉。
    const cap = this.capacity > 0 ? this.capacity : 1
    while (this.seen.size > cap) {
      const oldest = this.seen.keys().next()
      if (oldest.done === true) break
      this.seen.delete(oldest.value)
      this.evictedCount += 1
    }
    return 'added'
  }

  /**
   * 批量记账。
   * @param keys 记账键。
   * @param at 时刻。
   */
  addAll(keys: readonly string[], at: number): AddOutcome {
    let added = 0
    let skipped = 0
    const before = this.evictedCount
    for (const key of keys) {
      if (this.add(key, at) === 'added') added += 1
      else skipped += 1
    }
    return { added, skipped, evicted: this.evictedCount - before }
  }

  /**
   * 摘掉一条（`resurface()` 用）。
   * @param key 记账键。
   */
  drop(key: string): boolean {
    return this.seen.delete(key)
  }

  /**
   * 清空（释放已见）。
   * @returns 清掉几条。
   */
  clear(): number {
    const n = this.seen.size
    this.seen.clear()
    this.releaseCount += 1
    return n
  }

  /**
   * 最近的若干个键（**最新在前**）。
   * @param count 取几个。
   */
  recent(count: number): readonly string[] {
    const all = Array.from(this.seen.keys())
    return all.slice(Math.max(0, all.length - count)).reverse()
  }

  /** 全部键（交回 O-036 前要先展开成 id 形态）。 */
  keys(): readonly string[] {
    return Array.from(this.seen.keys())
  }
}

/** 一本账里的一个会话槽。 */
interface Slot {
  readonly ledger: Ledger
  /** 最近一次被用到（会话级 LRU 的依据）。 */
  at: number
}

/**
 * 多会话账本。
 *
 * 会话数上限刻意存在：`conversationId` 由调用方给，若它把时间戳当 id，
 * 内存会无限长。超限时挤掉**最久没用的整本账**——该会话下次整块重注一次（只多花字）。
 */
export class LedgerBook {
  private readonly slots = new Map<string, Slot>()

  /**
   * @param capacity 单会话容量。
   * @param maxConversations 会话数上限（>= 1）。
   */
  constructor(
    private readonly capacity: number,
    private readonly maxConversations: number,
  ) {}

  /**
   * 取一本账（没有就新建），并刷新「最近使用」。
   *
   * 刻意**没有** `create` 开关：曾经的 `get(create: false)` 让「读」也变成「用」，
   * 于是界面每几秒一次的 `snapshot()` 会把正在聊的会话挤成最旧。
   * 只读场景一律走 `peek()`。
   * @param conversationId 会话 id。
   * @param at 时刻。
   */
  get(conversationId: string, at: number): Ledger {
    const slot = this.slots.get(conversationId)
    if (slot !== undefined) {
      slot.at = at
      return slot.ledger
    }
    const ledger = new Ledger(this.capacity)
    this.slots.set(conversationId, { ledger, at })
    this.evict()
    return ledger
  }

  /**
   * 只读地看一眼一本账，**不刷新「最近使用」**。
   *
   * 与 `get()` 的区别很重要：界面每隔几秒调一次 `snapshot()`，
   * 若那也算「使用」，正在看 A 会话就会把**真正在聊的 B** 挤成最旧——
   * 下一次 B 的 `begin()` 会整块重注一遍（多花字），而界面上一切正常。
   * @param conversationId 会话 id。
   */
  peek(conversationId: string): Ledger | undefined {
    const slot = this.slots.get(conversationId)
    return slot === undefined ? undefined : slot.ledger
  }

  /**
   * 释放一个会话的已见。
   * @param conversationId 会话 id。
   */
  release(conversationId: string): number {
    const slot = this.slots.get(conversationId)
    if (slot === undefined) return 0
    return slot.ledger.clear()
  }

  /**
   * 释放全部会话的已见。
   *
   * 刻意**保留**会话槽（不删 Map 项）：删了会让 `snapshot()` 当场查不到这个会话，
   * 界面上的「已记 0 条」与「这个会话不存在」长得一样，而它们是两件事。
   */
  releaseAll(): number {
    let total = 0
    for (const slot of this.slots.values()) total += slot.ledger.clear()
    return total
  }

  /** 当前会话数。 */
  count(): number {
    return this.slots.size
  }

  /** 全部会话合计已记条数。 */
  totalSeen(): number {
    let total = 0
    for (const slot of this.slots.values()) total += slot.ledger.size
    return total
  }

  /** 全部会话累计挤出条数。 */
  totalEvicted(): number {
    let total = 0
    for (const slot of this.slots.values()) total += slot.ledger.evicted
    return total
  }

  /**
   * 按最近使用时刻挤掉多余的会话。
   *
   * 只在新建时调用：`get()` 是热路径（每轮一次），每次都排序没必要。
   */
  private evict(): void {
    const cap = this.maxConversations > 0 ? this.maxConversations : 1
    while (this.slots.size > cap) {
      let oldestId: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [id, slot] of this.slots) {
        if (slot.at < oldestAt) {
          oldestAt = slot.at
          oldestId = id
        }
      }
      if (oldestId === undefined) break
      this.slots.delete(oldestId)
    }
  }
}
