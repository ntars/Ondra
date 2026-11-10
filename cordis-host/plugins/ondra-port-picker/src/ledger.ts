/**
 * 账本：记住「最近发出去的号」，防同一个进程里两个人拿到同一个。
 *
 * ## 它不是锁，这一点必须写在最前面
 *
 * 锁的语义是「我占着，别人拿不到」。账本做不到：进程一崩，账本跟着消失，
 * 而端口可能还被别人用着。所以：
 *
 * - **只在内存**，不落盘。落了盘的账本会在崩溃后留下一堆「永远被占」的假记录。
 * - **有 TTL**，过期允许再发。一个真的被长期使用的号，应当由持有方 `release()`
 *   或干脆别走本包。
 * - **不跨进程**。两个进程各自有账本，互相看不见。
 *
 * ## 读方法不做清理
 *
 * `has()` / `list()` 只**忽略**过期项，不删。删是写操作，放在 `prune()` 里由
 * `pick()` 触发。理由很具体：一个「每次读都会顺手改内部状态」的容器，在并发调用
 * 下没法推理——而这里恰好会被并发调用（两个插件同时启动）。
 */

import type { PickedPort } from './types.js'

/** 进程内账本。 */
export class PortLedger {
  readonly #entries = new Map<number, PickedPort>()
  readonly #now: () => number
  readonly #ttlMs: () => number

  /**
   * @param now 取当前时刻（Unix 毫秒）。
   * @param ttlMs 取 TTL（用函数而不是值：配置改了要立刻生效）。
   */
  constructor(now: () => number, ttlMs: () => number) {
    this.#now = now
    this.#ttlMs = ttlMs
  }

  /**
   * 这个号现在还在账上吗（过期的不算）。
   * @param port 端口号。
   */
  has(port: number): boolean {
    const entry = this.#entries.get(port)
    if (entry === undefined) return false
    return this.#now() < entry.expiresAt
  }

  /**
   * 记一笔。同一个号重复记时**以新记录为准**（调用方刚拿到它）。
   * @param entry 记录。
   */
  add(entry: PickedPort): void {
    this.#entries.set(entry.port, entry)
  }

  /**
   * 划掉一个号。
   * @param port 端口号。
   * @returns 真的划掉了为 `true`；本来就没有（或已过期）为 `false`。
   */
  drop(port: number): boolean {
    const alive = this.has(port)
    this.#entries.delete(port)
    return alive
  }

  /** 清掉过期项。**写操作**，只由 `pick()` 调用。 */
  prune(): void {
    const now = this.#now()
    for (const [port, entry] of this.#entries) {
      if (now >= entry.expiresAt) this.#entries.delete(port)
    }
  }

  /** 账本快照（已剔除过期项，按端口升序）。 */
  list(): readonly PickedPort[] {
    const now = this.#now()
    const out: PickedPort[] = []
    for (const entry of this.#entries.values()) {
      if (now < entry.expiresAt) out.push(entry)
    }
    out.sort((a, b) => a.port - b.port)
    return out
  }

  /** 清空（卸载时用）。 */
  clear(): void {
    this.#entries.clear()
  }

  /**
   * 按当前 TTL 算过期时刻。集中一处，避免「写记录时用旧的 TTL」。
   * @param pickedAt 发出时刻。
   */
  expiryOf(pickedAt: number): number {
    return pickedAt + this.#ttlMs()
  }
}
