/**
 * 融合的**两条实现**（多方案纪律 §12：能融就融 → 参数化；不能融 → 各自成函数）。
 *
 * - `rrfFuse()`：Reciprocal Rank Fusion。`fused += 1/(k + rank)`，只看名次不看分数。
 *   它解决的是**尺度混合**：BM25 分可以到 12，余弦相似度只到 1，识别分又是另一套；
 *   直接加权等于让量纲决定排序，权重变成装饰。
 * - `weightedRank()`：裁决⑦ 的五因子加权和。它是「手册已落地」的那一套，
 *   留作 LEGACY，靠配置 `fuse: 'weighted'` 切回。
 *
 * 两者**互不调用、互不共享缓存**：切换模式不该让另一条路径的结果影响这一条。
 * 它们唯一的共同输入是「同一批候选与同一批因子」。
 *
 * 排序必须**确定**：分数相同按 id 升序。RRF 的名次分很容易打平（两条都只被
 * 一条通道命中且名次相同），若不定序，同一句话两次查询的先后会随机漂。
 */

import type { RankedItem } from './lexical.js'
import type { RecallChannel, RecallPathHit } from './types.js'

/** 一条通道的命中列表。 */
export interface ChannelList {
  /** 通道名。 */
  readonly channel: RecallChannel
  /** 命中（已按通道内部分数降序）。 */
  readonly items: readonly RankedItem[]
}

/** 融合后的一条。 */
export interface FusedEntry {
  /** 记忆 id。 */
  readonly id: string
  /** 名次融合分。 */
  readonly fused: number
  /** 来自哪些通道、各是什么名次。 */
  readonly paths: readonly RecallPathHit[]
}

/**
 * RRF 融合。
 *
 * @param lists 各通道命中列表（顺序即 `paths` 的输出顺序）。
 * @param k RRF 常数（手册 60）。
 */
export function rrfFuse(lists: readonly ChannelList[], k: number): Map<string, FusedEntry> {
  const safeK = k > 0 ? k : 60
  const acc = new Map<string, { fused: number; paths: RecallPathHit[] }>()

  for (const list of lists) {
    let rank = 0
    for (const item of list.items) {
      rank += 1
      const contribution = 1 / (safeK + rank)
      const path: RecallPathHit = {
        channel: list.channel,
        rank,
        raw: item.score,
        rrf: contribution,
      }
      const existing = acc.get(item.id)
      if (existing === undefined) {
        acc.set(item.id, { fused: contribution, paths: [path] })
      } else {
        existing.fused += contribution
        existing.paths.push(path)
      }
    }
  }

  const out = new Map<string, FusedEntry>()
  for (const [id, entry] of acc) {
    out.set(id, { id, fused: entry.fused, paths: entry.paths })
  }
  return out
}

/** 加权模式的一条。 */
export interface WeightedEntry {
  /** 记忆 id。 */
  readonly id: string
  /** 五因子加权和（已归一化）。 */
  readonly score: number
}

/**
 * 加权模式：把已算好的五因子分排成有序列表。
 *
 * 这里不重算因子——因子由 `score.ts` 算一次，两种模式共用同一份，
 * 免得「切了模式之后因子含义悄悄变了」。
 * @param scores id → 加权分。
 */
export function weightedRank(scores: ReadonlyMap<string, number>): WeightedEntry[] {
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => (right.score === left.score ? (left.id < right.id ? -1 : 1) : right.score - left.score))
}

/**
 * 平局裁决：名次分**完全相等**时，用五因子加权分定先后。
 *
 * 手册 §2.3 硬规矩②「新鲜度与权重只做平局裁决，不参与主导排序」——
 * 这个函数就是那条规矩的唯一落点。判等用 `1e-9` 而不是 `===`：
 * RRF 的分是 `1/(60+n)` 连加，浮点累加会让「理论相等」变成「差 2.7e-17」。
 * @param left 左。
 * @param right 右。
 * @param priorOf 取先验分。
 */
export function compareFused(
  left: FusedEntry,
  right: FusedEntry,
  priorOf: (id: string) => number,
): number {
  const delta = right.fused - left.fused
  if (Math.abs(delta) > 1e-9) return delta
  const priorDelta = priorOf(right.id) - priorOf(left.id)
  if (Math.abs(priorDelta) > 1e-12) return priorDelta
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}
