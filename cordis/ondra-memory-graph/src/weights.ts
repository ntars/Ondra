/**
 * 边权的**纯数学**（不碰 ctx、不碰库、不碰时间）。
 *
 * 把这几件事抽出来单独放，是因为它们每一条都曾经是「看起来显然、实际会错」的地方：
 *
 * 1. **规范方向**：两端 id 按字典序排。写两行会让「只更新了一边」变成常态事故。
 * 2. **加固是 `min(1, 当前 + 步长)`**，不是「重新赋初值」——
 *    重新赋值会让「反复被提到」这件事永远积累不起来。
 * 3. **衰减是「每满一个间隔 ×factor」的步进**，且必须按游标结算：
 *    `steps = floor((now − cursor) / interval)`。若用 `now − createdAt` 每次都重算，
 *    一次夜跑与十次夜跑的结果会差 `factor^9`——手册 §9.7 专门点了这个坑。
 * 4. **圈权重是「第几圈的整体折扣」**，与边权相乘；**不沿路径连乘**
 *    （三圈连乘 0.16×0.4×0.4 = 0.026，扩散等于白做）。
 */

import { RING_WEIGHTS } from './types.js'

/** 一天的毫秒数。 */
const DAY_MS = 86400000

/** 关系名 / 记忆 id 的合法形状（与 §8.4 同一把尺子，虽然后者只约束服务键）。 */
const NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/

/**
 * 是否是合法的记忆 id / 关系名。
 * @param value 待判。
 */
export function isNameLike(value: unknown): value is string {
  return typeof value === 'string' && NAME_RE.test(value)
}

/**
 * 排成规范方向（字典序小的当 `from`）。
 * @param a 一端。
 * @param b 另一端。
 */
export function canonicalPair(a: string, b: string): { readonly from: string; readonly to: string } {
  return a <= b ? { from: a, to: b } : { from: b, to: a }
}

/**
 * 边 id：`from~to~relation`。
 *
 * 为什么不用自增主键：边是**幂等**资源（同一对记忆的同一关系只能有一行），
 * 确定性 id 让「建边」可以直接 `upsert`，不需要先查一遍再决定插还是改。
 * 为什么 `~` 安全：记忆 id 与关系名都匹配 `^[a-z][a-z0-9_-]{1,63}$`，
 * 不可能含 `~`，故拼接不会撞码。
 * @param from 起点（已规范）。
 * @param to 终点（已规范）。
 * @param relation 关系名。
 */
export function edgeIdOf(from: string, to: string, relation: string): string {
  return `${from}~${to}~${relation}`
}

/** 夹到 0–1。 */
export function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 关系预设。 */
export interface RelationProfile {
  /** 初值。 */
  readonly init: number
  /** 每次加固的增量。 */
  readonly step: number
  /** 是否荒诞联想（永不进检索、永不加固、剪枝豁免）。 */
  readonly surreal: boolean
}

/**
 * 取某个关系的预设。
 *
 * 已知的三个关系从配置里取（配置项本身就是手册原值的唯一存放处），
 * 未知关系用 `defaultInit / defaultStep` 这组中性默认——**不猜它的语义**。
 * @param relation 关系名。
 * @param config 三个已知关系的数值。
 */
export function profileOf(
  relation: string,
  config: {
    readonly sameTopicInit: number
    readonly sameTopicStep: number
    readonly cooccurInit: number
    readonly cooccurStep: number
    readonly surrealWeight: number
    readonly defaultInit: number
    readonly defaultStep: number
  },
): RelationProfile {
  if (relation === 'same_topic') {
    return { init: clampWeight(config.sameTopicInit), step: clampWeight(config.sameTopicStep), surreal: false }
  }
  if (relation === 'cooccur') {
    return { init: clampWeight(config.cooccurInit), step: clampWeight(config.cooccurStep), surreal: false }
  }
  if (relation === 'surreal') {
    return { init: clampWeight(config.surrealWeight), step: 0, surreal: true }
  }
  return { init: clampWeight(config.defaultInit), step: clampWeight(config.defaultStep), surreal: false }
}

/**
 * 加固后的权重。
 * @param current 当前权重（新建时传 `undefined`）。
 * @param profile 关系预设。
 * @param explicit 调用方显式给的权重（给了就先用它，不再加步长）。
 */
export function nextWeight(current: number | undefined, profile: RelationProfile, explicit: number | undefined): number {
  if (current === undefined) {
    return clampWeight(explicit ?? profile.init)
  }
  if (explicit !== undefined) {
    // 显式给值 = 「我确认它就是这么多」，不是「再加一点」。
    return clampWeight(explicit)
  }
  return clampWeight(current + profile.step)
}

/**
 * 距游标过去了几个衰减间隔。
 * @param cursor 上次结算时间戳。
 * @param now 当前时间戳。
 * @param intervalDays 间隔天数。
 */
export function stepsElapsed(cursor: number, now: number, intervalDays: number): number {
  const interval = Math.max(1, intervalDays) * DAY_MS
  const elapsed = now - cursor
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0
  return Math.floor(elapsed / interval)
}

/**
 * 衰减后的权重。
 * @param weight 当前权重。
 * @param steps 过去几个间隔。
 * @param factor 每间隔系数。
 */
export function decayedWeight(weight: number, steps: number, factor: number): number {
  if (steps <= 0) return clampWeight(weight)
  return clampWeight(weight * Math.pow(factor, steps))
}

/**
 * 结算后的新游标。
 *
 * **只推进整间隔**：把游标推到 `now` 会让「剩 89 天」的零头被抹掉，
 * 于是每条边每年会被多衰减一次——一年一次看不出，三年后整张图都塌了。
 * @param cursor 旧游标。
 * @param steps 过去几个间隔。
 * @param intervalDays 间隔天数。
 */
export function advancedCursor(cursor: number, steps: number, intervalDays: number): number {
  return cursor + steps * Math.max(1, intervalDays) * DAY_MS
}

/**
 * 第 `ring` 圈的权重折扣。
 * @param ring 圈号（0 = 种子本身）。
 */
export function ringWeightOf(ring: number): number {
  // 先收窄成 `readonly number[]`：`Object.freeze([...])` 推出来是 number[]，
  // 直接下标取会让 `?? 0` 变成「对非空值的判断」，编译期会被指出来。
  const table: readonly number[] = RING_WEIGHTS
  const index = Math.min(Math.max(0, Math.trunc(ring)), table.length - 1)
  return table[index]
}

/**
 * 是否该被软剪枝。
 * @param weight 权重。
 * @param below 下界。
 * @param profile 关系预设。
 * @param approved 是否人工批准。
 */
export function isPruneCandidate(
  weight: number,
  below: number,
  profile: RelationProfile,
  approved: boolean,
): boolean {
  // 荒诞联想与人工批准的边豁免：前者本来就该一直很弱，后者是人明确要求留着的。
  if (profile.surreal || approved) return false
  return weight < below
}
