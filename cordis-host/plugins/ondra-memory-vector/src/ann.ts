/**
 * O-122 的近似检索：**IVF-lite（k-means 分桶倒排）**。
 *
 * 为什么需要它：文档数 > 1000 后（台账裁决④的向量档），逐条暴力余弦每次查询
 * 都要 O(n×dim) 次乘加；分桶后查询只扫最近的几个桶，成本降到 O(√n×dim) 量级。
 *
 * 为什么不引入 sqlite-vec / hnswlib（手册 §11.5 的预案）：
 * **禁装依赖**（本轮硬约束），且索引要与三个存储后端的「结构对位」纪律兼容。
 * 故自研一个 ~100 行的确定性 k-means IVF，README 里登记「临时自研 + 替换计划」。
 *
 * 确定性纪律：初始中心按**固定步长**从向量池选取（不随机）、迭代顺序稳定——
 * 同一批文档永远得到同一套桶，重启不漂、对拍可复现。
 */

/** 一个已建好的分桶索引。 */
export interface IvfIndex {
  /** 桶中心（每个都是 L2 归一化向量）。 */
  readonly centers: readonly Float64Array[]
  /** 桶 → 该桶内文档下标（指向构建时传入的数组）。 */
  readonly buckets: readonly (readonly number[])[]
}

/** k-means 迭代轮数。8 轮对「分桶加速」这个用途足够收敛，再多只是烧时间。 */
const KMEANS_ROUNDS = 8

/** 桶数上限。64 个中心 × 128 维的质心表常驻内存不到 32KB，收益已饱和。 */
const MAX_CLUSTERS = 64

/** 建索引时的最小文档数。低于它暴力比分桶还快，直接返回 null 走 flat。 */
export const IVF_MIN_DOCS = 200

/**
 * 用 L2 归一化向量池构建 IVF 索引。
 * @param vectors 文档向量（顺序与文档一一对应）。
 * @returns 索引；文档数不足 `IVF_MIN_DOCS` 时返回 null（调用方走暴力）。
 */
export function buildIvf(vectors: readonly Float64Array[]): IvfIndex | null {
  const total = vectors.length
  if (total < IVF_MIN_DOCS) return null
  const dim = vectors[0].length
  const clusterCount = Math.min(MAX_CLUSTERS, Math.max(2, Math.ceil(total / 32)))

  // 初始中心：固定步长采样，确定性。
  const step = Math.max(1, Math.floor(total / clusterCount))
  const centers: Float64Array[] = []
  for (let index = 0; index < clusterCount; index += 1) {
    const source = vectors[(index * step) % total]
    centers.push(new Float64Array(source))
  }
  const assignments = new Int32Array(total)

  // Lloyd 迭代：分配 → 重算中心。中心未归一化会导致「大簇引力」失真，每轮重新归一化。
  for (let round = 0; round < KMEANS_ROUNDS; round += 1) {
    // 分配。
    for (let docIndex = 0; docIndex < total; docIndex += 1) {
      let best = 0
      let bestDot = -Infinity
      for (let centerIndex = 0; centerIndex < centers.length; centerIndex += 1) {
        let dot = 0
        const center = centers[centerIndex]
        const vector = vectors[docIndex]
        for (let d = 0; d < dim; d += 1) dot += center[d] * vector[d]
        if (dot > bestDot) {
          bestDot = dot
          best = centerIndex
        }
      }
      assignments[docIndex] = best
    }
    // 重算中心：累加成员向量后 L2 归一化（球面上均值的方向）。
    const sums: Float64Array[] = centers.map(() => new Float64Array(dim))
    const counts = new Int32Array(centers.length)
    for (let docIndex = 0; docIndex < total; docIndex += 1) {
      const centerIndex = assignments[docIndex]
      counts[centerIndex] += 1
      const sum = sums[centerIndex]
      const vector = vectors[docIndex]
      for (let d = 0; d < dim; d += 1) sum[d] += vector[d]
    }
    for (let centerIndex = 0; centerIndex < centers.length; centerIndex += 1) {
      const sum = sums[centerIndex]
      if (counts[centerIndex] === 0) {
        // 空簇：沿用旧中心（不挪，避免抖动；下一轮可能重新拿到成员）。
        continue
      }
      let norm = 0
      for (let d = 0; d < dim; d += 1) norm += sum[d] * sum[d]
      norm = Math.sqrt(norm)
      if (norm === 0) continue
      const center = centers[centerIndex]
      for (let d = 0; d < dim; d += 1) center[d] = sum[d] / norm
    }
  }

  // 最终分配 + 建桶。
  const buckets: number[][] = centers.map(() => [])
  for (let docIndex = 0; docIndex < total; docIndex += 1) {
    let best = 0
    let bestDot = -Infinity
    for (let centerIndex = 0; centerIndex < centers.length; centerIndex += 1) {
      let dot = 0
      const center = centers[centerIndex]
      const vector = vectors[docIndex]
      for (let d = 0; d < dim; d += 1) dot += center[d] * vector[d]
      if (dot > bestDot) {
        bestDot = dot
        best = centerIndex
      }
    }
    assignments[docIndex] = best
    buckets[best].push(docIndex)
  }
  return { centers, buckets }
}

/**
 * 用 IVF 索引做近似最近邻。
 * @param index 已建索引。
 * @param vectors 与建索引时同一数组（顺序必须一致——本函数只返回下标）。
 * @param query 已归一化的查询向量。
 * @param probes 探桶数（多探更准、更慢；默认 3 覆盖 ≈ 最相关簇 + 两个邻域）。
 * @param limit 返回条数上限。
 * @returns 按相似度降序的 { 下标, 余弦 } 列表。
 */
export function ivfSearch(
  index: IvfIndex,
  vectors: readonly Float64Array[],
  query: Float64Array,
  probes: number,
  limit: number,
): { readonly index: number; readonly score: number }[] {
  // 选桶：查询向量与各中心的点积取 top-probes。
  const centerScores: { centerIndex: number; dot: number }[] = []
  for (let centerIndex = 0; centerIndex < index.centers.length; centerIndex += 1) {
    let dot = 0
    const center = index.centers[centerIndex]
    for (let d = 0; d < query.length; d += 1) dot += center[d] * query[d]
    centerScores.push({ centerIndex, dot })
  }
  centerScores.sort((left, right) => right.dot - left.dot)
  const probeCount = Math.max(1, Math.min(probes, centerScores.length))
  const candidates: { index: number; score: number }[] = []
  for (let probeIndex = 0; probeIndex < probeCount; probeIndex += 1) {
    const bucket = index.buckets[centerScores[probeIndex].centerIndex]
    for (const docIndex of bucket) {
      const vector = vectors[docIndex]
      let dot = 0
      for (let d = 0; d < query.length; d += 1) dot += vector[d] * query[d]
      candidates.push({ index: docIndex, score: Math.min(1, Math.max(-1, dot)) })
    }
  }
  candidates.sort((left, right) => right.score - left.score)
  return candidates.length > limit ? candidates.slice(0, limit) : candidates
}
