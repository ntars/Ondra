/**
 * 图谱服务：建边、1 跳邻居、批量关联度、扩散、衰减、剪枝。
 * **只碰 `memory_link` 一张表，不写 `memory_fact` 的任何一列**（裁决⑪）。
 *
 * 六个方法的时间语义（每个都由调用方决定时机，本插件**不装定时器**）：
 *
 * | 方法 | 谁在什么时候调 |
 * |---|---|
 * | `link()` | 写入新记忆之后（O-011/O-012 判完重）、夜跑共现加固（O-019） |
 * | `relatedness()` | 每次召回（O-014 的图谱因子） |
 * | `diffuse()` | 水波纹路径（O-018）、那年今日（O-049） |
 * | `decay()` | 夜跑第 2 步（O-019） |
 * | `prune()` | 夜跑第 3 步（O-019） |
 * | `forgetOf()` | `forget()` 之后（O-017 或调用方） |
 *
 * **为什么不装定时器**：插件装载顺序不确定，定时器跑在第几个插件之后是运气；
 * 而衰减 / 剪枝都是写操作，交给一个不知道第几个装载的定时器，排查成本远高于收益。
 * 这与 O-013 的 `autoScan` 默认关闭是同一条理由。
 */

import type { EdgeStore } from './store.js'
import { profileOf } from './weights.js'
import type { RelationProfile } from './weights.js'
import {
  advancedCursor,
  canonicalPair,
  clampWeight,
  decayedWeight,
  edgeIdOf,
  isNameLike,
  isPruneCandidate,
  nextWeight,
  ringWeightOf,
  stepsElapsed,
} from './weights.js'
import { DIFFUSE_MIN_WEIGHT, HUB_CAP, RELATION_PRESETS } from './types.js'
import type { Config } from './settings.js'
import type {
  DiffuseItem,
  DiffuseResult,
  DiffuseRing,
  GraphEdge,
  GraphIssue,
  GraphService,
  GraphStats,
  GraphUnavailableReason,
  KnownRelation,
  LinkInput,
  LinkResult,
  LogLike,
  MemoryCoreLike,
  Neighbor,
} from './types.js'

/** 问题缓冲上限。 */
const MAX_ISSUES = 20

/** 取错误文本。 */
function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** 图谱实现。 */
export class GraphRepository implements GraphService {
  private readonly store: EdgeStore | undefined
  private readonly storePresent: boolean
  private readonly core: MemoryCoreLike | undefined
  private readonly settings: Config
  private readonly log: LogLike
  private readonly now: () => number

  private ensured = false
  private ensureFailed = false
  private readonly issues: GraphIssue[] = []
  private readonly counters = {
    links: 0,
    reinforced: 0,
    refused: 0,
    decayed: 0,
    pruned: 0,
    unlinked: 0,
  }

  /**
   * @param store 边表仓库（可能缺席）。
   * @param storePresent 存储端口是否在位（用来区分 `no-store` 与 `schema-failed`）。
   * @param core 记忆内核（只用来验端点，可能缺席）。
   * @param settings 已补全的配置。
   * @param log 日志。
   * @param now 时间源（注入以便对拍）。
   */
  constructor(
    store: EdgeStore | undefined,
    storePresent: boolean,
    core: MemoryCoreLike | undefined,
    settings: Config,
    log: LogLike,
    now: () => number,
  ) {
    this.store = store
    this.storePresent = storePresent
    this.core = core
    this.settings = settings
    this.log = log
    this.now = now
  }

  /**
   * 建表（幂等）。由入口在 `ctx.effect` 里调一次。
   * @returns 是否可用。
   */
  ready(): boolean {
    if (this.ensured) return true
    if (this.store === undefined) return false
    this.ensured = this.store.ensure()
    if (!this.ensured) this.ensureFailed = true
    return this.ensured
  }

  /** 是否可用。 */
  get available(): boolean {
    return this.reason === undefined
  }

  /**
   * 不可用原因（内部）。
   *
   * 注意「还没 ready()」**不算不可用**：`ready()` 是入口在 `ctx.effect` 里调的，
   * 把「尚未初始化」判成失败会让装载期的一次 `stats()` 把插件标成坏掉。
   * 真正的建表失败由 `ensureFailed` 表达。
   */
  get reason(): GraphUnavailableReason | undefined {
    if (!this.settings.enable) return 'disabled'
    if (!this.storePresent || this.store === undefined) return 'no-store'
    if (this.ensureFailed) return 'schema-failed'
    return undefined
  }

  /* ------------------------------ 建边 ------------------------------ */

  /**
   * 建边或加固。
   * @param input 入参。
   */
  link(input: LinkInput): LinkResult {
    const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : this.now()
    const relation = typeof input.relation === 'string' && input.relation.length > 0 ? input.relation : 'same_topic'
    const from = input.from
    const to = input.to

    if (!isNameLike(from) || !isNameLike(to)) {
      this.issue('bad-endpoint', `端点 id 不合规（要求 ^[a-z][a-z0-9_-]{1,63}$）：${String(from)} / ${String(to)}`)
      this.counters.refused += 1
      return { created: false, refusal: 'bad-endpoint' }
    }
    if (!isNameLike(relation)) {
      this.issue('bad-relation', `关系名不合规（要求 ^[a-z][a-z0-9_-]{1,63}$）：${relation}`)
      this.counters.refused += 1
      return { created: false, refusal: 'bad-relation' }
    }
    if (from === to) {
      // 自环没有任何语义：它既不能扩散到别处，也不该占一个枢纽名额。
      this.issue('self-loop', `拒绝自环：${from}`)
      this.counters.refused += 1
      return { created: false, refusal: 'self-loop' }
    }
    const store = this.store
    if (store === undefined || this.reason !== undefined) {
      return { created: false, refusal: 'unavailable' }
    }

    const { from: a, to: b } = canonicalPair(from, to)
    const id = edgeIdOf(a, b, relation)
    const profile = this.profileFor(relation)

    // 端点校验：不在记忆库里只记 issue 仍写——表间无外键，硬拒会让
    // 「先建边、后写记忆」的调用方全挂。
    if (this.settings.validateEndpoints) {
      this.checkEndpoint(a)
      this.checkEndpoint(b)
    }

    try {
      const existing = store.getById(id)
      if (existing !== undefined) {
        const weight = nextWeight(existing.weight, profile, input.weight)
        const hits = existing.hits + 1
        store.patch(id, {
          weight,
          hits,
          lastFiredAt: at,
          ...(input.approved === undefined ? {} : { approved: input.approved }),
        })
        this.counters.reinforced += 1
        return {
          created: false,
          edge: { ...existing, weight, hits, lastFiredAt: at, approved: input.approved ?? existing.approved },
        }
      }

      // 枢纽度上限：建链与扩散共用同一个常量。
      const degreeA = store.edgesTouching(a, this.settings.hubCap + 1).length
      const degreeB = store.edgesTouching(b, this.settings.hubCap + 1).length
      if (degreeA >= this.settings.hubCap || degreeB >= this.settings.hubCap) {
        this.issue('hub-full', `枢纽度已满（上限 ${this.settings.hubCap}）：${degreeA >= this.settings.hubCap ? a : b}`)
        this.counters.refused += 1
        return { created: false, refusal: 'hub-full' }
      }
      if (store.countAll() >= this.settings.maxEdges) {
        // 到上限**拒绝新建**而不是淘汰一条旧边：删边比写不进去更难查。
        this.issue('edge-limit', `边表已达上限 ${this.settings.maxEdges}，拒绝新建`)
        this.counters.refused += 1
        return { created: false, refusal: 'edge-limit' }
      }

      const weight = nextWeight(undefined, profile, input.weight)
      const edge: GraphEdge = {
        id,
        from: a,
        to: b,
        relation,
        weight,
        hits: 1,
        lastFiredAt: at,
        decayedAt: at,
        createdAt: at,
        approved: input.approved === true,
        surreal: profile.surreal,
      }
      store.upsert(edge)
      this.counters.links += 1
      return { created: true, edge }
    } catch (error) {
      this.log.warn('建边失败（%s）：%s', id, messageOf(error))
      return { created: false, refusal: 'bad-endpoint' }
    }
  }

  /**
   * 删边。
   * @param from 一端。
   * @param to 另一端。
   * @param relation 关系名；省略删这一对的所有关系。
   */
  unlink(from: string, to: string, relation?: string): number {
    const store = this.store
    if (store === undefined) return 0
    if (!isNameLike(from) || !isNameLike(to)) return 0
    const { from: a, to: b } = canonicalPair(from, to)
    let removed = 0
    try {
      if (relation !== undefined) {
        removed += store.deleteById(edgeIdOf(a, b, relation))
      } else {
        for (const known of Object.keys(RELATION_PRESETS) as KnownRelation[]) {
          removed += store.deleteById(edgeIdOf(a, b, known))
        }
      }
      this.counters.unlinked += removed
    } catch (error) {
      this.log.warn('删边失败：%s', messageOf(error))
    }
    return removed
  }

  /* ------------------------------ 查询 ------------------------------ */

  /**
   * 1 跳邻居（双向）。
   * @param id 记忆 id。
   * @param options 门槛 / 是否含荒诞 / 上限。
   */
  neighbors(
    id: string,
    options?: { readonly minWeight?: number; readonly includeSurreal?: boolean; readonly limit?: number },
  ): readonly Neighbor[] {
    const store = this.store
    if (store === undefined || !isNameLike(id)) return []
    const minWeight = typeof options?.minWeight === 'number' ? clampWeight(options.minWeight) : 0
    const includeSurreal = options?.includeSurreal === true
    const limit =
      typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
        ? Math.trunc(options.limit)
        : this.settings.hubCap

    const out = new Map<string, Neighbor>()
    for (const edge of store.edgesTouching(id, limit)) {
      if (!includeSurreal && edge.surreal) continue
      if (edge.weight < minWeight) continue
      const other = edge.from === id ? edge.to : edge.from
      if (other === id) continue
      const key = `${other}~${edge.relation}`
      const previous = out.get(key)
      if (previous === undefined || edge.weight > previous.weight) {
        out.set(key, { id: other, relation: edge.relation, weight: edge.weight, surreal: edge.surreal })
      }
    }
    return [...out.values()]
      .sort((left, right) => (right.weight === left.weight ? (left.id < right.id ? -1 : 1) : right.weight - left.weight))
      .slice(0, limit)
  }

  /**
   * 批量关联度：每个 id 与任一种子的最大边权。
   *
   * 实现是「两次 `in` 查询」而不是「每个候选查一次」：种子最多 3 个、
   * 候选可能上百，逐条查会变成上百次往返。
   * @param ids 待评估。
   * @param seeds 种子。
   * @param options 门槛。
   */
  relatedness(
    ids: readonly string[],
    seeds: readonly string[],
    options?: { readonly minWeight?: number },
  ): Readonly<Record<string, number>> {
    const store = this.store
    const acc = new Map<string, number>()
    if (store === undefined || ids.length === 0 || seeds.length === 0) return {}
    const minWeight = typeof options?.minWeight === 'number' ? clampWeight(options.minWeight) : 0
    const seedSet = new Set(seeds)
    const idSet = new Set(ids)

    const consider = (edge: GraphEdge, other: string): void => {
      if (!idSet.has(other) || seedSet.has(other)) return
      if (edge.surreal) return
      if (edge.weight < minWeight) return
      const previous = acc.get(other)
      if (previous === undefined || edge.weight > previous) acc.set(other, edge.weight)
    }

    for (const edge of store.edgesWithSideIn(seeds, 'from')) consider(edge, edge.to)
    for (const edge of store.edgesWithSideIn(seeds, 'to')) consider(edge, edge.from)
    return Object.fromEntries(acc)
  }

  /**
   * 1 跳（可到 3 跳）扩散。
   * @param seedIds 种子。
   * @param options 圈数与门槛。
   */
  diffuse(
    seedIds: readonly string[],
    options?: { readonly maxRings?: number; readonly minWeight?: number },
  ): DiffuseResult {
    const seeds = [...new Set(seedIds.filter(isNameLike))]
    if (seeds.length === 0 || this.store === undefined) {
      return { seeds, rings: [], visited: seeds, ringsDone: 0 }
    }
    const maxRings = Math.min(
      3,
      Math.max(
        1,
        typeof options?.maxRings === 'number' && Number.isFinite(options.maxRings)
          ? Math.trunc(options.maxRings)
          : this.settings.maxRings,
      ),
    )
    const minWeight =
      typeof options?.minWeight === 'number' ? clampWeight(options.minWeight) : this.settings.diffuseMinWeight

    const visited = new Set<string>(seeds)
    let frontier = [...seeds]
    const rings: DiffuseRing[] = []

    for (let ring = 1; ring <= maxRings; ring += 1) {
      const collected = new Map<string, DiffuseItem>()
      for (const node of frontier) {
        for (const neighbor of this.neighbors(node, { minWeight, includeSurreal: false, limit: this.settings.hubCap })) {
          if (visited.has(neighbor.id)) continue
          // 圈权重是「第几圈的整体折扣」，与边权相乘；**不沿路径连乘**。
          const score = clampWeight(ringWeightOf(ring) * neighbor.weight)
          const previous = collected.get(neighbor.id)
          if (previous === undefined || score > previous.score) {
            collected.set(neighbor.id, {
              id: neighbor.id,
              via: node,
              relation: neighbor.relation,
              weight: neighbor.weight,
              score,
              ring,
            })
          }
        }
      }
      const items = [...collected.values()].sort((left, right) =>
        right.score === left.score ? (left.id < right.id ? -1 : 1) : right.score - left.score,
      )
      if (items.length === 0) break
      for (const item of items) visited.add(item.id)
      rings.push({ ring, items })
      frontier = items.map(item => item.id)
    }

    return { seeds, rings, visited: [...visited], ringsDone: rings.length }
  }

  /* ------------------------------ 维护 ------------------------------ */

  /**
   * 边衰减：每满 `decayDays` 天 ×`decayFactor`，按 `decayed_at` 游标结算。
   *
   * **游标只推进整间隔**：推到 `now` 会把零头抹掉，每条边每年多衰减一次。
   * @param at 时间戳。
   */
  decay(at?: number): number {
    const store = this.store
    if (store === undefined) return 0
    const now = typeof at === 'number' && Number.isFinite(at) ? at : this.now()
    let changed = 0
    store.forEachEdge(this.settings.pageSize, edge => {
      const cursor = edge.decayedAt > 0 ? edge.decayedAt : edge.lastFiredAt > 0 ? edge.lastFiredAt : edge.createdAt
      const steps = stepsElapsed(cursor, now, this.settings.decayDays)
      if (steps <= 0) return
      const weight = decayedWeight(edge.weight, steps, this.settings.decayFactor)
      const nextCursor = advancedCursor(cursor, steps, this.settings.decayDays)
      try {
        store.patch(edge.id, { weight, decayedAt: nextCursor })
        changed += 1
      } catch (error) {
        this.log.warn('衰减边失败（%s）：%s', edge.id, messageOf(error))
      }
    })
    this.counters.decayed += changed
    return changed
  }

  /**
   * 软剪枝：权重 < `pruneBelow` 压到 `pruneTo`，`surreal` 与 `approved` 豁免。
   * @param at 时间戳。
   */
  prune(at?: number): number {
    const store = this.store
    if (store === undefined) return 0
    const now = typeof at === 'number' && Number.isFinite(at) ? at : this.now()
    let changed = 0
    store.forEachEdge(this.settings.pageSize, edge => {
      const profile = this.profileFor(edge.relation)
      if (!isPruneCandidate(edge.weight, this.settings.pruneBelow, profile, edge.approved)) return
      try {
        store.patch(edge.id, { weight: clampWeight(this.settings.pruneTo) })
        changed += 1
      } catch (error) {
        this.log.warn('剪枝边失败（%s）：%s', edge.id, messageOf(error))
      }
    })
    if (changed > 0) this.log.debug?.(`软剪枝：${changed} 条边被压到 ${this.settings.pruneTo}（当前时间 ${now}）`)
    this.counters.pruned += changed
    return changed
  }

  /**
   * 清掉某个记忆的全部边（记忆被 `forget()` 之后调）。
   * @param id 记忆 id。
   */
  forgetOf(id: string): number {
    const store = this.store
    if (store === undefined || !isNameLike(id)) return 0
    try {
      const removed = store.deleteTouching(id)
      this.counters.unlinked += removed
      return removed
    } catch (error) {
      this.log.warn('清边失败（%s）：%s', id, messageOf(error))
      return 0
    }
  }

  /**
   * 取一条边。
   * @param from 一端。
   * @param to 另一端。
   * @param relation 关系名。
   */
  edgeOf(from: string, to: string, relation: string): GraphEdge | undefined {
    const store = this.store
    if (store === undefined || !isNameLike(from) || !isNameLike(to) || !isNameLike(relation)) return undefined
    const { from: a, to: b } = canonicalPair(from, to)
    return store.getById(edgeIdOf(a, b, relation))
  }

  /** 统计快照。 */
  stats(): GraphStats {
    const store = this.store
    const provider = store === undefined ? 'none' : 'edge-store'
    const reason = this.reason
    if (store === undefined || reason !== undefined) {
      return {
        available: false,
        ...(reason === undefined ? {} : { reason }),
        provider,
        edges: 0,
        byRelation: emptyRelationCounts(),
        surreal: 0,
        approved: 0,
        avgWeight: 0,
        counters: { ...this.counters },
        issues: [...this.issues],
      }
    }
    const byRelation = emptyRelationCounts()
    for (const relation of Object.keys(RELATION_PRESETS) as KnownRelation[]) {
      byRelation[relation] = store.countWhere('relation', relation)
    }
    let sum = 0
    let seen = 0
    store.forEachEdge(this.settings.pageSize, edge => {
      sum += edge.weight
      seen += 1
    })
    return {
      available: true,
      provider,
      edges: store.countAll(),
      byRelation,
      surreal: store.countWhere('surreal', 1),
      approved: store.countWhere('approved', 1),
      avgWeight: seen === 0 ? 0 : sum / seen,
      counters: { ...this.counters },
      issues: [...this.issues],
    }
  }

  /* ------------------------------ 内部 ------------------------------ */

  /** 取关系预设。 */
  private profileFor(relation: string): RelationProfile {
    return profileOf(relation, this.settings)
  }

  /**
   * 校验端点存在。不在就记 issue——**但仍让写入继续**（表间无外键）。
   * @param id 端点。
   */
  private checkEndpoint(id: string): void {
    const core = this.core
    if (core === undefined || !core.available) return
    try {
      if (core.getFact(id) === undefined) {
        this.issue('bad-endpoint', `端点不在记忆库里：${id}（边照写，等记忆补上；若永远补不上就是孤儿边）`)
      }
    } catch {
      // 校验失败不该阻断建边。
    }
  }

  /** 记一条 issue（环形缓冲，最多 20 条）。 */
  private issue(code: GraphIssue['code'], detail: string, id?: string): void {
    if (this.issues.length >= MAX_ISSUES) {
      this.issues.shift()
      if (!this.issues.some(item => item.code === 'too-many-issues')) {
        this.issues.push({ code: 'too-many-issues', detail: `问题超过 ${MAX_ISSUES} 条，只保留最近的` })
      }
    }
    this.issues.push({ code, detail, ...(id === undefined ? {} : { id }) })
    if (code === 'hub-full' || code === 'edge-limit') {
      this.log.warn('建边被拒（%s）：%s', code, detail)
    } else {
      this.log.debug?.('建边告警（%s）：%s', code, detail)
    }
  }
}

/** 空的按关系计数。 */
function emptyRelationCounts(): Record<KnownRelation, number> {
  return { same_topic: 0, cooccur: 0, surreal: 0 }
}

/** 扩散门槛原样导出，便于 O-014 与自检脚本对齐同一个数。 */
export { DIFFUSE_MIN_WEIGHT, HUB_CAP }
