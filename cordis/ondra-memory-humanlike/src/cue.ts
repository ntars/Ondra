/**
 * 「被话头勾起」的**纯算法**：二元组重合 + 概率闸。
 *
 * ## 这一层与 O-014 的分工（别重做检索）
 *
 * O-014 已经回答「这句话命中了哪些记忆」。本插件回答的是**下一步**：
 * 「命中了不等于会想起来」——手册 §2.3 给了一个概率：
 *
 * ```
 * p = 0.10 + 重合比 × 0.55 + R × 0.35
 * ```
 *
 * 所以 `cue()` 的入参是**候选**（通常来自 `recall.search().hits`），
 * 不是查询。本插件**不建倒排索引**：建了就是第二套分词、第二份 IDF，
 * 两套索引对同一句话给出不同候选，而日志全正常。
 *
 * ## 「重合比」的分母是话头，不是记忆
 *
 * 分母取 `queryGrams.size`（这句话有多少二元组被这条记忆接住）。
 * 换成「除以记忆的二元组数」会让**长记忆天然占优**——一条 200 字的记忆
 * 只要沾到两个词，分母就很大、比值很小；而一条 10 字的短记忆沾到两个词就接近 1。
 * 产品上要的是「这句话有多少被接住」，不是「这条记忆有多纯」。
 *
 * **这是覆盖率，不是判重口径。** 判重（0.4 包含度）只有 O-012 一处；
 * 这里算出的数只进概率公式，**不参与任何「是不是同一条」的判定**，
 * 所以不构成第二把尺子。
 */

/** 勾起用到的配置子集。 */
export interface CueSettings {
  /** 概率基底。 */
  readonly cueBaseProbability: number
  /** 重合比权重。 */
  readonly cueOverlapWeight: number
  /** 强度权重。 */
  readonly cueStrengthWeight: number
  /** 最少共享二元组数。 */
  readonly minSharedGrams: number
}

/**
 * 比对用的归一化：NFKC（全角→半角）+ 折叠空白。
 *
 * 与 O-011 的 `normalizeForMatch` 同一口径，但**刻意不 import**（跨插件禁 import）。
 * 两边都只做这两步，改动时需同步——口径漂移的后果是「同一条记忆在提炼时能匹配、
 * 在勾起时匹配不上」，不报错。
 * @param text 原文。
 */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/[\s\u3000]+/g, ' ').trim()
}

/**
 * 取字符二元组集合。
 *
 * **只保留字母、汉字与数字**，标点与空白全部丢弃。
 * 理由：不去标点的话，`，。` 这种组合会与任何一句带逗号的话共享二元组，
 * 于是「重合 ≥1」这道闸门形同虚设——每次都能过，只是概率低一点。
 * @param text 原文。
 */
export function bigrams(text: string): ReadonlySet<string> {
  const chars = [...normalizeText(text)].filter(char => /[\p{L}\p{N}]/u.test(char))
  const out = new Set<string>()
  for (let index = 0; index + 1 < chars.length; index += 1) {
    out.add(`${chars[index]}${chars[index + 1]}`)
  }
  return out
}

/**
 * 两个集合的共享二元组个数。
 * @param left 集合 A。
 * @param right 集合 B。
 */
export function sharedGramCount(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  // 遍历小的一侧：集合大小差一个数量级时能省一个量级的比较。
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let shared = 0
  for (const gram of small) {
    if (large.has(gram)) shared += 1
  }
  return shared
}

/**
 * 重合比 = 共享二元组 / 话头的二元组数。
 * @param queryGrams 话头的二元组。
 * @param textGrams 记忆的二元组。
 */
export function overlapRatio(queryGrams: ReadonlySet<string>, textGrams: ReadonlySet<string>): number {
  if (queryGrams.size === 0) return 0
  return sharedGramCount(queryGrams, textGrams) / queryGrams.size
}

/**
 * 想起概率。
 *
 * 三项权重相加恰为 1.0（0.10 + 0.55 + 0.35），所以概率天然落在 `[0,1]`；
 * 仍然夹一次，防止有人把三项配成大于 1 之后算出 1.7 这种「概率」。
 * @param overlap 重合比 0–1。
 * @param strength 当前强度 0–1。
 * @param settings 配置子集。
 */
export function cueProbability(overlap: number, strength: number, settings: CueSettings): number {
  const o = Number.isFinite(overlap) ? Math.min(1, Math.max(0, overlap)) : 0
  const r = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0
  const p =
    settings.cueBaseProbability + o * settings.cueOverlapWeight + r * settings.cueStrengthWeight
  return Math.min(1, Math.max(0, p))
}
