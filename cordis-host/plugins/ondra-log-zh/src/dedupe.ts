/**
 * O-004 的写放大保护（手册 §8.3：同一错误每秒 1000 条时去重）。
 *
 * 规则只有三条：
 * 1. 同键在窗口内**只放行第一条**，其余只累加计数；
 * 2. 窗口到期由外部定时器**主动扫**，把「另有 N 条」补写出去 ——
 *    不能等同一个键下次出现才补：错误爆发完就停时，那条补充永远写不出来，
 *    用户只会看到「只错了一次」；
 * 3. 键数量有上限，超了按最早开始时间淘汰 —— 否则「每秒一千种不同的错」
 *    会把内存吃成第二个故障源。
 */

/** 桶里记的标签：决定补充行写到哪一层、长什么样。 */
export interface DedupeLabel {
  /** 目标层。 */
  readonly layer: 'human' | 'code'
  /** 行前缀，例如 `WARN [ondra.memory] `。 */
  readonly prefix: string
}

/** 一次窗口到期后要补写的汇总。 */
export interface DedupeSummary {
  /** 原标签。 */
  readonly label: DedupeLabel
  /** 被折叠的条数（不含放行的那一条）。 */
  readonly suppressed: number
}

/** 窗口内的计数桶。 */
interface Bucket {
  readonly label: DedupeLabel
  readonly start: number
  count: number
}

/** 写放大保护器。 */
export class AmplificationGuard {
  private readonly buckets = new Map<string, Bucket>()
  private readonly windowMs: number
  private readonly maxKeys: number
  private suppressedTotal = 0

  constructor(windowMs: number, maxKeys: number) {
    this.windowMs = Math.max(1, Math.floor(windowMs))
    this.maxKeys = Math.max(1, Math.floor(maxKeys))
  }

  /** 累计被折叠的条数（只增不减，供统计）。 */
  get suppressed(): number {
    return this.suppressedTotal
  }

  /** 当前桶数量（供自检与压力测试观察）。 */
  get size(): number {
    return this.buckets.size
  }

  /**
   * 判定一条是否放行。
   * @param key 去重键。
   * @param at 当前毫秒时间戳。
   * @param label 命中时要用的标签。
   * @returns true = 写下去；false = 被折叠。
   */
  hit(key: string, at: number, label: DedupeLabel): boolean {
    const bucket = this.buckets.get(key)
    if (bucket && at - bucket.start < this.windowMs) {
      bucket.count += 1
      return false
    }
    this.buckets.set(key, { label, start: at, count: 0 })
    this.enforceCap()
    return true
  }

  /**
   * 扫掉到期窗口，返回需要补写的汇总。
   * @param at 当前毫秒时间戳。
   */
  sweep(at: number): DedupeSummary[] {
    const expired: DedupeSummary[] = []
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.start < this.windowMs) continue
      this.buckets.delete(key)
      if (bucket.count > 0) {
        this.suppressedTotal += bucket.count
        expired.push({ label: bucket.label, suppressed: bucket.count })
      }
    }
    return expired
  }

  /**
   * 桶数量超上限时，按「开始时间最早」淘汰。
   *
   * 淘汰前把这些桶的计数计入总折叠数：它们确实被吞掉了，
   * 统计里不能假装没发生。**不补写汇总**——那正是上限要防的洪泛。
   */
  private enforceCap(): void {
    if (this.buckets.size <= this.maxKeys) return
    const ordered = [...this.buckets.entries()].sort((a, b) => a[1].start - b[1].start)
    const overflow = this.buckets.size - this.maxKeys
    for (let index = 0; index < overflow; index += 1) {
      const entry = ordered[index]
      if (!entry) break
      this.suppressedTotal += entry[1].count
      this.buckets.delete(entry[0])
    }
  }
}
