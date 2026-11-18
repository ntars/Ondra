/**
 * 记忆服务：一个 Map 加四条规则。
 *
 * 为什么不拆成「抽取 / 去重 / 衰减 / 召回」四个插件：它们改的是同一份数据，
 * 拆开之后「谁最后写」要靠事件顺序去猜，而顺序一错，记忆就会自相矛盾。
 * 合并成一个服务，写入只有一条路径，读的时候才敢解释「为什么是这条」。
 */
import type { MemoryPoint, RecallHit } from './types.js'
import { completeConfig, type ConfigShape } from './settings.js'

export class MemoryStore {
  private readonly points = new Map<string, MemoryPoint>()
  private config: ConfigShape

  constructor(config: ConfigShape = completeConfig()) {
    this.config = config
  }

  configure(next: ConfigShape): void {
    this.config = next
  }

  /** 写入一条。重复文本不新建，只累加引用——这就是「去重」。 */
  remember(text: string, kind: MemoryPoint['kind'] = 'fact', now = Date.now()): MemoryPoint {
    const trimmed = text.trim()
    if (!trimmed) throw new Error('记忆正文不能为空')
    for (const p of this.points.values()) {
      if (p.text === trimmed) {
        p.lastUsedAt = now
        p.hits += 1
        return p
      }
    }
    const point: MemoryPoint = {
      id: `m_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      text: trimmed,
      kind,
      createdAt: now,
      lastUsedAt: now,
      hits: 0,
      links: [],
    }
    this.points.set(point.id, point)
    this.evictIfNeeded()
    return point
  }

  /** 两件事连起来。双向存，读时取并集，避免「A 认识 B、B 不认识 A」。 */
  link(a: string, b: string): boolean {
    const pa = this.points.get(a)
    const pb = this.points.get(b)
    if (!pa || !pb || a === b) return false
    if (!pa.links.includes(b)) pa.links.push(b)
    if (!pb.links.includes(a)) pb.links.push(a)
    return true
  }

  /** 召回：关键词 + 最近被用到 + 一跳邻居，三者取大。 */
  recall(query: string, now = Date.now()): RecallHit[] {
    if (!this.config.enable) return []
    const q = query.trim().toLowerCase()
    const hits: RecallHit[] = []
    for (const p of this.points.values()) {
      if (this.expired(p, now)) continue
      let score = 0
      let reason: RecallHit['reason'] = 'recent'
      if (q && p.text.toLowerCase().includes(q)) {
        score = 3
        reason = 'keyword'
      } else if (p.links.some(id => this.points.get(id)?.text.toLowerCase().includes(q))) {
        score = 2
        reason = 'linked'
      } else if (this.config.decay) {
        score = Math.max(0, 1 - (now - p.lastUsedAt) / (30 * 864e5))
      }
      if (score <= 0) continue
      hits.push({ point: p, score: score + p.hits * 0.05, reason })
    }
    return hits
      .sort((x, y) => y.score - x.score)
      .slice(0, this.config.recallLimit)
  }

  /** 被召回就记一次引用：衰减看的是这个时间，不是写入时间。 */
  touch(ids: readonly string[], now = Date.now()): void {
    for (const id of ids) {
      const p = this.points.get(id)
      if (!p) continue
      p.lastUsedAt = now
      p.hits += 1
    }
  }

  snapshot(): MemoryPoint[] {
    return [...this.points.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  }

  private expired(p: MemoryPoint, now: number): boolean {
    if (this.config.retainDays === 0) return false
    return now - p.createdAt > this.config.retainDays * 864e5
  }

  /** 超容量时按 lastUsedAt 淘汰——不是按写入时间，越常用越该留下。 */
  private evictIfNeeded(): void {
    const overflow = this.points.size - this.config.capacity
    if (overflow <= 0) return
    const oldest = [...this.points.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    for (const p of oldest.slice(0, overflow)) this.points.delete(p.id)
  }
}
