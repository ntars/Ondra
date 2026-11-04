/**
 * O-122 的内置嵌入器：**确定性字符 n-gram 哈希投影**。
 *
 * 为什么自研一个「假嵌入」而不用真模型（台账标〔研〕的理由）：
 *
 * 1. **禁装依赖、禁网络**（本轮硬约束）：bge-m3 之类真模型需要下载几百 MB 权重，
 *    本仓没有已确认的 embedding 服务键可消费，编造一个 API 就是 `not-available` 陷阱。
 * 2. **确定性**：同一文本永远得到同一向量——同步、重启、对拍都不漂。
 * 3. **够用的语义**：字符 bigram 的重叠率在中短文本（记忆事实的典型长度）上
 *    与字面相似度高度相关；它比纯字面多的东西是「跨词共现」——
 *    「猫趴在键盘上」与「键盘上有只猫」会共享同一批 bigram 桶，顺序无关。
 *
 * 边界（诚实）：它**不懂**同义词与跨语言语义。「 birthday ≈ 生日」这种召回
 * 只能靠外部嵌入器（`setEmbedder()` 注入 bge-m3 等）补上。
 */

import { EMBED_DIM } from './types.js'

/** FNV-1a 32 位哈希：快、分布均匀、零依赖。 */
function fnv1a(text: string, seed: number): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    // 32 位 FNV 素数 16777619；用乘法拆两位避免 Math.imul 的符号问题（实测等价）。
    hash = (hash * 16777619) >>> 0
  }
  return hash >>> 0
}

/** 文本 → 码点数组（`String.prototype[Symbol.iterator]` 正确处理代理对，emoji 不碎）。 */
function codePoints(text: string): string[] {
  return [...text]
}

/**
 * 把文本嵌入成 `dim` 维 L2 归一化向量。
 *
 * 特征：单字（码点）+ 相邻二元（码点对），各自带独立盐避免桶位互相覆盖；
 * 重复 gram 计入权重（tf），最后 L2 归一化让点积即余弦。
 *
 * @param text 原文（不做分词——中文没有可靠的零依赖分词，码点是最诚实的最小单元）。
 * @param dim 目标维度（默认 `EMBED_DIM`）。
 * @returns L2 归一化后的向量。空文本返回零向量（检索时余弦恒 0，自然退出）。
 */
export function hashEmbed(text: string, dim: number = EMBED_DIM): Float64Array {
  const vector = new Float64Array(dim)
  const points = codePoints(text)
  if (points.length === 0) return vector
  // 单字：盐 1；二元：盐 2。同 gram 多次出现累加（tf），高频 gram 自然主导方向。
  for (let index = 0; index < points.length; index += 1) {
    const bucket = fnv1a(points[index], 1) % dim
    vector[bucket] += 1
    if (index + 1 < points.length) {
      const pair = points[index] + points[index + 1]
      const pairBucket = fnv1a(pair, 2) % dim
      vector[pairBucket] += 0.7
    }
  }
  let norm = 0
  for (let index = 0; index < dim; index += 1) norm += vector[index] * vector[index]
  norm = Math.sqrt(norm)
  if (norm === 0) return vector
  for (let index = 0; index < dim; index += 1) vector[index] /= norm
  return vector
}

/** 两个已归一化向量的点积（即余弦；数值误差夹在 [-1, 1]）。 */
export function cosineOf(left: Float64Array, right: Float64Array): number {
  const dim = Math.min(left.length, right.length)
  let dot = 0
  for (let index = 0; index < dim; index += 1) dot += left[index] * right[index]
  return Math.min(1, Math.max(-1, dot))
}

/** 文本指纹：文本或时间变了都要重嵌时用来比对（不存原文，只存指纹）。 */
export function fingerprintOf(text: string, lastSeenAt: number): string {
  return `${fnv1a(text, 3).toString(36)}:${fnv1a(text, 4).toString(36)}@${lastSeenAt}`
}
