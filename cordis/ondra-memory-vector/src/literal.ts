/**
 * O-122 的字面侧打分：**字符 bigram 包含率**。
 *
 * 为什么本插件要自带一个字面打分（O-014 不是有 2-gram 倒排吗）：
 *
 * 1. **不能 import O-014**（§15.5 禁跨包 import），且依赖它会成环：O-014 消费本插件。
 * 2. 混合模式（300–1000 条）需要「字面 + 向量」两路各自出分再 RRF；
 *    本插件的字面侧只服务这个内部融合，**刻意不做** BM25 / IDF / 时间半衰——
 *    那些是 O-014 的五因子职责，做进这里就是第二套检索模型（§12 多方案纪律的反面）。
 *
 * 口径：查询 bigram 集合中有多少比例出现在文档里（**查全导向**）。
 * 查询短、文档长，用「文档包含查询的程度」比 Jaccard 更贴合「找同一条记忆」的场景。
 */

/** 取文本的字符 bigram 集合（码点级；单字文本退化为单字集合）。 */
export function bigramsOf(text: string): Set<string> {
  const points = [...text]
  const grams = new Set<string>()
  if (points.length === 1) {
    grams.add(points[0])
    return grams
  }
  for (let index = 0; index + 1 < points.length; index += 1) {
    grams.add(points[index] + points[index + 1])
  }
  return grams
}

/**
 * 字面相似度 0–1：查询 bigram 的包含率。
 * 查询为空返回 0（没有证据就不给分）。
 */
export function literalScoreOf(queryGrams: Set<string>, docGrams: Set<string>): number {
  if (queryGrams.size === 0) return 0
  let hits = 0
  for (const gram of queryGrams) {
    if (docGrams.has(gram)) hits += 1
  }
  return hits / queryGrams.size
}

/**
 * RRF（Reciprocal Rank Fusion，k=60）两路融合。
 *
 * k=60 与 O-014 的 `RRF_K` 同值——同一仓里同一算法不该有两个魔法数来源，
 * 但跨包 import 被禁止，这里以注释锚定「与 O-014 的 RRF_K 保持一致」；
 * 若 O-014 改值，本文件须同步（维护纪律）。
 */
export const HYBRID_RRF_K = 60

/**
 * 两路排名列表融合成最终分。
 * @param listA 路一（字面），已按分降序。
 * @param listB 路二（向量），已按分降序。
 * @returns 融合后的 id → RRF 分（0–1 内，相对量；最大理论值 2/(k+1)）。
 */
export function rrfFuse(
  listA: readonly { readonly id: string }[],
  listB: readonly { readonly id: string }[],
): Map<string, number> {
  const fused = new Map<string, number>()
  for (let index = 0; index < listA.length; index += 1) {
    const entry = listA[index]
    const score = fused.get(entry.id) ?? 0
    fused.set(entry.id, score + 1 / (HYBRID_RRF_K + index + 1))
  }
  for (let index = 0; index < listB.length; index += 1) {
    const entry = listB[index]
    const score = fused.get(entry.id) ?? 0
    fused.set(entry.id, score + 1 / (HYBRID_RRF_K + index + 1))
  }
  return fused
}
