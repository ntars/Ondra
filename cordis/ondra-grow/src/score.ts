/**
 * 里程分计算：**全是纯函数**，不碰 IO、不碰服务、不看时间。
 *
 * 分开成独立文件的理由：这几十行是本插件唯一有「判定」的地方，
 * 也是唯一需要反复推敲的地方（权重对不对、夹紧在哪儿、报不报分数）。
 * 它跟「从哪个服务读数」「状态存哪儿」毫无关系，混进 `service.ts` 会让
 * 「换一种读数来源」变成重写整个插件。
 */

import {
  FACTOR_TARGETS,
  FACTOR_WEIGHTS,
  GROW_LEVELS,
  LEVEL_SPECS,
  MILESTONES,
  MILESTONE_SPECS,
} from './types.js'
import type {
  FactorScore,
  GrowInput,
  GrowLevel,
  LevelSpec,
  MilestoneId,
  MilestoneSpec,
  MilestoneView,
} from './types.js'

/**
 * 把任意数夹到 0–1。
 *
 * 先判 `Number.isFinite` 再夹：`NaN` 不会被 `Math.min/max` 夹住（比较恒 false），
 * 会一路穿到 `score` 里，最后表现成「进度条不显示」而没人知道为什么。
 * @param value 原始值。
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 非负计数归零。上游读数可能是负数（脏数据）或非数（服务返回异常）。
 * @param value 原始值。
 */
export function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

/**
 * 单项因子的归一化。
 *
 * **分母为 0 时返回 0 而不是 1**：目标值被改坏（比如有人手改成 0）时，
 * 返回 1 会让「什么都没有」也拿到满分，那是最糟的失败方向。
 * @param factor 因子名。
 * @param raw 原始读数。
 */
export function factorOf(factor: keyof typeof FACTOR_WEIGHTS, raw: number): FactorScore {
  const target = FACTOR_TARGETS[factor]
  const weight = FACTOR_WEIGHTS[factor]
  const ratio = target > 0 ? clamp01(countOf(raw) / target) : 0
  return Object.freeze({
    factor,
    raw: countOf(raw),
    ratio,
    weight,
    contribution: ratio * weight,
  })
}

/**
 * 四项加权和。
 *
 * 返回的四项**顺序固定**（天数 → 互动 → 记忆 → 关系阶），
 * 因为应用外壳会按数组顺序画条，顺序一变条就串行了。
 * @param input 四项原始读数。
 */
export function factorsOf(input: GrowInput): readonly FactorScore[] {
  return Object.freeze([
    factorOf('days', input.days),
    factorOf('interactions', input.interactions),
    factorOf('memories', input.memories),
    factorOf('stage', input.stageOrder),
  ])
}

/**
 * 加权和即里程分。
 *
 * 再夹一次 0–1：权重表被改坏（合计 > 1）时不能让分数出界，
 * 否则「距离下一档还差 `-0.1`」这种读数会冒出来。
 * @param factors 四项明细。
 */
export function scoreOf(factors: readonly FactorScore[]): number {
  let sum = 0
  for (const item of factors) sum += item.contribution
  return clamp01(sum)
}

/**
 * 由分数取档位。**向下取整**：满 0.65 才「开花」，0.649 仍是「成荫」。
 * @param score 里程分。
 */
export function levelOf(score: number): GrowLevel {
  let current: GrowLevel = GROW_LEVELS[0]
  for (const id of GROW_LEVELS) {
    if (score >= LEVEL_SPECS[id].minScore) current = id
  }
  return current
}

/**
 * 下一档。
 * @param level 当前档。
 */
export function nextLevelOf(level: GrowLevel): LevelSpec | undefined {
  const index = GROW_LEVELS.indexOf(level)
  if (index < 0 || index >= GROW_LEVELS.length - 1) return undefined
  return LEVEL_SPECS[GROW_LEVELS[index + 1]]
}

/**
 * 距离下一档还差多少分。已在最高档时为 0。
 * @param score 里程分。
 * @param next 下一档。
 */
export function toNextOf(score: number, next: LevelSpec | undefined): number {
  if (next === undefined) return 0
  return clamp01(next.minScore - score)
}

/**
 * 「下一步该干什么」的一句人话。
 *
 * 三条硬纪律（都为了不让人去刷数据）：
 *
 * 1. **不出分数、不出比例、不出「还差多少」**。内感受铁律（P0 第 3 条）同一条道理：
 *    一旦可量化，人就会优化这个数，而养成本来要的是「自然过日子」。
 * 2. **只指最弱那一项**。四项全指一遍等于没指。
 * 3. **指的方向必须是「过日子」不是「打卡」**——所以写「聊聊今天」，不写「再说 20 句」。
 * @param factors 四项明细。
 * @param next 下一档（最高档时为 undefined）。
 */
export function hintOf(factors: readonly FactorScore[], next: LevelSpec | undefined): string {
  if (next === undefined) {
    return '已经走到头了。往后没有什么要攒的，照常过日子就行。'
  }
  let weakest = factors[0]
  for (const item of factors) {
    // 用差值比、不用比值：`days` 的比值天然偏高（一处 1、一处 0 时会选出 0），
    // 而差值能稳定落到「离满值最远」的那一项上。
    if (FACTOR_TARGETS[item.factor] - item.raw > FACTOR_TARGETS[weakest.factor] - weakest.raw) {
      weakest = item
    }
  }
  switch (weakest.factor) {
    case 'days':
      return '这个急不来，日子得一天天过。'
    case 'interactions':
      return '多来找她说说话吧，哪怕只是随口讲讲今天干了什么。'
    case 'memories':
      return '聊点具体的——你吃了什么、见了谁、哪句话让你不高兴，这些她才记得住。'
    case 'stage':
      return '关系是要慢慢磨的，别急着推到哪一步。'
    default:
      return '照常过日子就好。'
  }
}

/**
 * 一条里程碑的当前读数。
 *
 * 写成 `switch` 而不是 `input[spec.factor]`：后者要求索引键在 `GrowInput` 上全部存在，
 * 而 `spec.factor` 的联合里含 `'stageOrder'`（不是 `GrowInput` 的键名风格），
 * 一处不匹配就是编译错。逐分支取还顺带让「新增一种判定维度」必须显式落在这儿。
 * @param input 四项原始读数。
 * @param spec 里程碑定义。
 */
export function currentOf(input: GrowInput, spec: MilestoneSpec): number {
  switch (spec.factor) {
    case 'days':
      return countOf(input.days)
    case 'interactions':
      return countOf(input.interactions)
    case 'memories':
      return countOf(input.memories)
    case 'stageOrder':
      return countOf(input.stageOrder)
    default:
      // `stage` 这一档留给「按关系阶直接卡阈值」的将来条目，当前没有条目用它。
      return 0
  }
}

/**
 * 六条里程碑的当前状态。
 *
 * `reached` 是**读数事实**（够没够线），`celebrated` 是**落盘事实**（庆祝过没有）。
 * 两件事刻意分开：前者每轮重算、后者只写一次。混成一个字段，
 * 就会出现「庆祝过之后 reached 变 false」这种自相矛盾的读数。
 * @param input 四项原始读数。
 * @param celebrated 已庆祝集合。
 */
export function milestoneViewsOf(
  input: GrowInput,
  celebrated: readonly MilestoneId[],
): readonly MilestoneView[] {
  const done = new Set<MilestoneId>(celebrated)
  const out: MilestoneView[] = []
  for (const id of MILESTONES) {
    const spec = MILESTONE_SPECS[id]
    const current = currentOf(input, spec)
    out.push(
      Object.freeze({
        id,
        zh: spec.zh,
        reached: current >= spec.threshold,
        celebrated: done.has(id),
        current,
        threshold: spec.threshold,
      }),
    )
  }
  return Object.freeze(out)
}

/**
 * 已达条件但还没庆祝的那些。
 * @param milestones 六条状态。
 */
export function freshOf(milestones: readonly MilestoneView[]): readonly MilestoneView[] {
  return Object.freeze(milestones.filter(item => item.reached && !item.celebrated))
}
