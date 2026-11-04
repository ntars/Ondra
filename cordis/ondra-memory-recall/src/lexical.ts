/**
 * 字面族的倒排索引与两条通道（**纯计算，不碰 ctx**）。
 *
 * 两条通道对应手册 §2.3 实测里的「两路」：
 * ① **罕见词通道**：只认 IDF ≥ 门槛的查询词——它负责「专有名词、具体地名、人名」，
 *    这类词一旦命中几乎必然相关；
 * ② **二元组通道**：BM25 全量打分——它负责「普通但成套出现的词」。
 *
 * 手册实测：IDF 单路 Recall@3 21% / @5 29% / MRR 0.15；旧整句子串全 0；
 * **两路融合 50% / 64% / 0.48**。故两条都要，且必须融合（见 `fuse.ts`），
 * 不能只留一条。
 *
 * 索引是**倒排表 + 文档长度**，不是「每次查询遍历全库两两比对」：
 * 后者在 1 万条库上会让每轮对话多出几千万次字符串操作。
 *
 * 索引**只在字面分支内部**缓存（多方案纪律 §14.2：分支之间不共享缓存）。
 * 失效信号有两个：库容变化（条数）与超时（`indexTtlMs`）。O-010 不提供写事件，
 * 故「条数不变但正文被 revise 改过」只能靠超时兜——最多 30 秒的旧排序，
 * 而结果里的正文按 id 回读最新记录，用户看不到旧文本。
 */

import { bigramsOf, charLengthOf, termFreqOf } from './tokenize.js'
import type { MemoryRecordLike } from './types.js'

/** 一篇文档。 */
export interface LexicalDoc {
  /** 记忆 id。 */
  readonly id: string
  /** 词频表（二元组 → 次数）。 */
  readonly terms: Map<string, number>
  /** 归一化后的字符数。 */
  readonly length: number
}

/** 一条倒排项。 */
export interface Posting {
  /** 文档下标（指向 `LexicalIndex.docs`）。 */
  readonly doc: number
  /** 该文档里的词频。 */
  readonly tf: number
}

/** 倒排索引。 */
export interface LexicalIndex {
  /** 文档表。 */
  readonly docs: readonly LexicalDoc[]
  /** id → 文档下标。 */
  readonly byId: ReadonlyMap<string, number>
  /** 二元组 → 倒排项。 */
  readonly postings: ReadonlyMap<string, readonly Posting[]>
  /** 二元组 → 文档频次。 */
  readonly df: ReadonlyMap<string, number>
  /** 平均文档长度。 */
  readonly avgLength: number
  /** 建索引时间戳。 */
  readonly builtAt: number
}

/** 一条通道命中。 */
export interface RankedItem {
  /** 记忆 id。 */
  readonly id: string
  /** 通道原始分。 */
  readonly score: number
}

/**
 * 建索引。
 * @param records 记忆列表（已过滤掉封存项）。
 * @param at 时间戳。
 */
export function buildIndex(records: readonly MemoryRecordLike[], at: number): LexicalIndex {
  const docs: LexicalDoc[] = []
  const byId = new Map<string, number>()
  const postings = new Map<string, Posting[]>()
  let totalLength = 0

  for (const record of records) {
    // 摘要一并入索引：摘要往往是用户原话的浓缩，召回时它比正文更容易命中。
    const source = record.summary === null || record.summary === '' ? record.text : `${record.text} ${record.summary}`
    const terms = termFreqOf(source)
    const length = charLengthOf(source)
    const index = docs.length
    docs.push({ id: record.id, terms, length })
    byId.set(record.id, index)
    totalLength += length
    for (const [gram, tf] of terms) {
      const bucket = postings.get(gram)
      if (bucket === undefined) {
        postings.set(gram, [{ doc: index, tf }])
      } else {
        bucket.push({ doc: index, tf })
      }
    }
  }

  const df = new Map<string, number>()
  for (const [gram, bucket] of postings) df.set(gram, bucket.length)

  return {
    docs,
    byId,
    postings,
    df,
    avgLength: docs.length === 0 ? 0 : totalLength / docs.length,
    builtAt: at,
  }
}

/**
 * 单个二元组的 IDF（BM25 常用形式：`ln(1 + (N - df + 0.5)/(df + 0.5))`）。
 *
 * 用 `ln(1+x)` 而不是 `ln(x)`：后者在 df 接近 N 时会变成负数，
 * 于是「这个词几乎每篇都有」反而变成减分项——那是可解释性灾难，不是特性。
 * @param index 索引。
 * @param gram 二元组。
 */
export function idfOf(index: LexicalIndex, gram: string): number {
  const total = index.docs.length
  if (total === 0) return 0
  const df = index.df.get(gram) ?? 0
  if (df === 0) return 0
  return Math.log(1 + (total - df + 0.5) / (df + 0.5))
}

/**
 * 罕见词通道：只认 IDF ≥ `rareIdf` 的查询词，按命中词的 IDF 之和排序。
 *
 * 一条命中都没有时返回空数组——**这条通道宁可空着，也不降门槛凑数**：
 * 降门槛后它会退化成「二元组通道的低配版」，两路融合就失去意义。
 * @param index 索引。
 * @param queryGrams 查询的二元组。
 * @param rareIdf IDF 门槛。
 */
export function searchRare(index: LexicalIndex, queryGrams: readonly string[], rareIdf: number): RankedItem[] {
  const scores = new Map<string, number>()
  for (const gram of queryGrams) {
    const idf = idfOf(index, gram)
    if (idf < rareIdf) continue
    const bucket = index.postings.get(gram)
    if (bucket === undefined) continue
    for (const posting of bucket) {
      const id = index.docs.at(posting.doc)?.id
      if (id === undefined) continue
      scores.set(id, (scores.get(id) ?? 0) + idf)
    }
  }
  return toRanked(scores)
}

/**
 * 二元组通道：BM25。
 *
 * `score = Σ idf(t) × tf×(k1+1) / (tf + k1×(1−b+b×dl/avgdl))`
 * @param index 索引。
 * @param queryGrams 查询的二元组。
 * @param k1 词频饱和参数（手册 1.2）。
 * @param b 长度归一项（手册 0.75）。
 */
export function searchBigram(
  index: LexicalIndex,
  queryGrams: readonly string[],
  k1: number,
  b: number,
): RankedItem[] {
  const scores = new Map<string, number>()
  const avgLength = index.avgLength === 0 ? 1 : index.avgLength
  for (const gram of queryGrams) {
    const bucket = index.postings.get(gram)
    if (bucket === undefined) continue
    const idf = idfOf(index, gram)
    if (idf <= 0) continue
    for (const posting of bucket) {
      const doc = index.docs.at(posting.doc)
      if (doc === undefined) continue
      const norm = 1 - b + (b * doc.length) / avgLength
      const denom = posting.tf + k1 * norm
      if (denom <= 0) continue
      const contribution = (idf * (posting.tf * (k1 + 1))) / denom
      scores.set(doc.id, (scores.get(doc.id) ?? 0) + contribution)
    }
  }
  return toRanked(scores)
}

/**
 * 查询里有哪些二元组在库中**根本不存在**。
 *
 * 用途是给「未命中」一句能照做的话（手册裁决⑨：检索为空不退回，但段标题要写出未命中），
 * 以及解释「为什么一条都没想起来」。
 * @param index 索引。
 * @param queryGrams 查询的二元组。
 */
export function unknownGramsOf(index: LexicalIndex, queryGrams: readonly string[]): readonly string[] {
  return queryGrams.filter(gram => !index.df.has(gram))
}

/**
 * 把分数表排成有序列表。
 *
 * 排序必须**确定**：分数相同时按 id 升序。否则同一句话两次查询的先后会变，
 * 表现为「她刚才想起的事，这会儿又忘了」——而日志里两条分数一模一样，查不出原因。
 * @param scores 分数表。
 */
function toRanked(scores: ReadonlyMap<string, number>): RankedItem[] {
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => (right.score === left.score ? (left.id < right.id ? -1 : 1) : right.score - left.score))
}

/**
 * 查询词表（去重后的二元组）。
 * @param text 查询文本。
 */
export function queryGramsOf(text: string): readonly string[] {
  return bigramsOf(text)
}
