/**
 * 指标纯算法。**不碰 ctx、不读文件、不写库**——只做数学。
 *
 * 拆出来的理由和 O-003 的 `time.ts` 一样：指标口径是本插件唯一容易被"顺手改一下"
 * 的地方，单独成文件才能被逐条对照测试，也才能在 README 里指着它说
 * 「口径就写在这七十行里」。
 *
 * 三条口径（写在这里，因为这是它们唯一的真源）：
 *
 * 1. `recall@k = 命中真值数 ÷ 真值总数`（trec_eval 的 `recall`）。
 *    分子只看前 k 位。真值总数是**题目自己声明的**，不是「本轮返回了几条」——
 *    用返回条数当分母的话，返回越少分越高，这是最好笑也最常见的错。
 *
 * 2. `hit@k = 前 k 位是否至少命中一条`（0/1）。
 *    单真值题上与 `recall@k` 相等；多真值题上它是"有没有沾到"，
 *    `recall@k` 是"沾到多少"。两个都报，因为"沾到但漏了两条"必须可见。
 *
 * 3. `MRR = 平均(1 / 首个命中名次)`，**没命中记 0 且进分母**。
 *    剔除失败题的 MRR 只统计"答对的题答得多靠前"，天然偏高。
 */

import type { CaseKind, CaseResult, MetricBlock, MetricDelta } from './types.js'

/** 均值；空数组返回 0（而不是 NaN）。 */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

/**
 * 前 k 位里命中的真值数 ÷ 真值总数。
 *
 * @param hits 命中 id 列表（**已排序**）。
 * @param expected 真值 id 集合。
 * @param k 只看前多少位。
 */
export function recallAtOf(hits: readonly string[], expected: readonly string[], k: number): number {
  if (expected.length === 0) return 0
  if (k <= 0) return 0
  const truth = new Set(expected)
  let found = 0
  const limit = Math.min(k, hits.length)
  for (let index = 0; index < limit; index += 1) {
    const id = hits[index]
    if (id !== undefined && truth.has(id)) found += 1
  }
  return found / expected.length
}

/**
 * 前 k 位是否至少命中一条。
 *
 * @param hits 命中 id 列表。
 * @param expected 真值 id 集合。
 * @param k 只看前多少位。
 */
export function hitAtOf(hits: readonly string[], expected: readonly string[], k: number): boolean {
  if (expected.length === 0) return false
  if (k <= 0) return false
  const truth = new Set(expected)
  const limit = Math.min(k, hits.length)
  for (let index = 0; index < limit; index += 1) {
    const id = hits[index]
    if (id !== undefined && truth.has(id)) return true
  }
  return false
}

/**
 * 首个命中的名次（从 1 起）；无命中返回 `null`。
 *
 * **不截断**：哪怕第 800 位才命中，返回的也是 800。截断会让
 * 「MRR 0.001」变成「MRR 0」，两者含义完全不同（一个是"很靠后"，一个是"没有"）。
 *
 * @param hits 命中 id 列表。
 * @param expected 真值 id 集合。
 */
export function firstRankOf(hits: readonly string[], expected: readonly string[]): number | null {
  if (expected.length === 0) return null
  const truth = new Set(expected)
  for (let index = 0; index < hits.length; index += 1) {
    const id = hits[index]
    if (id !== undefined && truth.has(id)) return index + 1
  }
  return null
}

/**
 * 倒数名次。无命中返回 **0**（不是 `null`、不是跳过）。
 *
 * 这一行就是「MRR 不许剔除失败题」这条口径的机器版本。
 * @param firstRank 首个名次。
 */
export function reciprocalRankOf(firstRank: number | null): number {
  if (firstRank === null || firstRank < 1) return 0
  return 1 / firstRank
}

/** 判断一题是否进入 recall / MRR 的分母。 */
export function isGradable(item: CaseResult): boolean {
  if (item.kind === 'fabricated') return false
  if (item.resolution === 'missing' || item.resolution === 'ambiguous') return false
  if (item.expected === 0) return false
  return true
}

/** 展平后的一行指标（具名而不内联：它是对比表与界面共同的形状）。 */
export interface MetricRow {
  /** 指标名，如 `recall@3`。 */
  readonly key: string
  /** 值。 */
  readonly value: number
}

/**
 * 由一组逐题结果算出一个指标块。
 *
 * 分母的两处剔除都在这里，且只在这里：
 * - `fabricated` 不进 recall（它没有真值），只进 `avoidRate`；
 * - `missing` / `ambiguous` 两边都不进（题目不可判，不是系统失败）。
 *
 * @param items 逐题结果。
 * @param ks k 列表。
 */
export function metricBlockOf(items: readonly CaseResult[], ks: readonly number[]): MetricBlock {
  const graded = items.filter(item => isGradable(item))
  const fabricated = items.filter(item => item.kind === 'fabricated')

  const recall: Record<string, number> = {}
  const hitRate: Record<string, number> = {}
  for (const k of ks) {
    const key = String(k)
    recall[key] = mean(graded.map(item => item.recallAt[key] ?? 0))
    hitRate[key] = mean(graded.map(item => (item.hitAt[key] === true ? 1 : 0)))
  }

  let avoidRate: number | null = null
  if (fabricated.length > 0) {
    avoidRate = mean(fabricated.map(item => (item.avoided === true ? 1 : 0)))
  }

  return Object.freeze({
    cases: items.length,
    graded: graded.length,
    recall: Object.freeze(recall),
    hitRate: Object.freeze(hitRate),
    mrr: mean(graded.map(item => item.reciprocalRank)),
    avoidRate,
  })
}

/** 按种类分组。 */
export function groupByKind(cases: readonly CaseResult[]): Readonly<Record<CaseKind, readonly CaseResult[]>> {
  return Object.freeze({
    real: cases.filter(item => item.kind === 'real'),
    paraphrase: cases.filter(item => item.kind === 'paraphrase'),
    fabricated: cases.filter(item => item.kind === 'fabricated'),
  })
}

/**
 * 比两个值。
 *
 * 阈值 1e-9：浮点求均值必有尾差，`0.6666666666666666` 与 `0.6666666666666667`
 * 会被判成「变了」。报告里出现「MRR +0.0000000000000001」会让人以为改了代码。
 * @param before 旧值。
 * @param after 新值。
 */
export function betterOf(before: number, after: number): MetricDelta['better'] {
  const diff = after - before
  if (Math.abs(diff) < 1e-9) return 'same'
  return diff > 0 ? 'up' : 'down'
}

/**
 * 生成一个指标变化。
 * @param key 指标名。
 * @param before 旧值（不可比为 `null`）。
 * @param after 新值。
 */
export function deltaOf(key: string, before: number | null, after: number): MetricDelta {
  if (before === null) {
    return Object.freeze({ key, before: null, after, delta: null, better: 'unknown' })
  }
  return Object.freeze({
    key,
    before,
    after,
    delta: after - before,
    better: betterOf(before, after),
  })
}

/**
 * 把指标块展平成「一行一个指标」，供对比与渲染。
 *
 * `avoidRate` 为 `null`（本块没有编造题）时不出现——写个 0 会被读成
 * 「编造题全都没通过」。
 * @param block 指标块。
 * @param ks k 列表。
 */
export function flattenBlock(block: MetricBlock, ks: readonly number[]): readonly MetricRow[] {
  const rows: MetricRow[] = []
  for (const k of ks) {
    rows.push({ key: `recall@${k}`, value: block.recall[String(k)] ?? 0 })
  }
  for (const k of ks) {
    rows.push({ key: `hit@${k}`, value: block.hitRate[String(k)] ?? 0 })
  }
  rows.push({ key: 'mrr', value: block.mrr })
  if (block.avoidRate !== null) rows.push({ key: 'avoidRate', value: block.avoidRate })
  return rows
}

/** 百分比文本（保留一位小数，报告里统一用它）。 */
export function percentOf(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
