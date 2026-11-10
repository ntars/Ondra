/**
 * 生活层的选择与措辞（纯函数）。
 *
 * ## 六类活动怎么分到三个标签上
 *
 * ```
 * 烧脑 focus  → 学习
 * 放松 relax  → 看书 / 刷视频 / 发呆 / 群里冒泡
 * 创造 create → 写日记
 * ```
 *
 * 手册只给了「六类活动」与「三个标签」，没给映射。这里按语义分：
 * 读书与看视频都是放松（不是学习），写日记是产出（创造），发呆与冒泡是歇着。
 * 映射写在 `KINDS_BY_TAG` 一处，面板与日志都从它派生。
 *
 * ## 心情差为什么只调权重、不换类别
 *
 * 手册 §3.7 说「心情差时优先放松/安慰型兴趣」。**优先不等于强制**：
 * 一个连着三天心情差的人若只会刷视频，第四天看起来就像坏了。
 * 所以只把放松类乘 2.5、烧脑类乘 0.5——她大概率去歇着，但仍有小概率
 * 翻开那本烧脑的书。这条概率留在日志里（`mood` 与权重都进 `plan()`）。
 *
 * ## 权重怎么长、怎么掉
 *
 * 做完一次 ×1.15（上限 3），长期没碰按半衰期掉（下限 0.05）。
 * 只加权不衰减 → 前十次之后永远是同一件事；只衰减不加权 → 兴趣表没有记忆。
 */

import type { ActivityKind, Interest, InterestTag, InterestView, Retention } from './types.js'
import { hash32, unitOf } from './seed.js'

/** 种子兴趣（一装就有）。 */
export interface SeedInterest {
  readonly label: string
  readonly tag: InterestTag
}

/** 标签 → 可选活动类别。**唯一映射**，面板与日志都从这里取。 */
export const KINDS_BY_TAG: Readonly<Record<InterestTag, readonly ActivityKind[]>> = Object.freeze({
  focus: Object.freeze(['study'] as const),
  relax: Object.freeze(['read', 'video', 'daze', 'chat'] as const),
  create: Object.freeze(['diary'] as const),
})

/** 出厂兴趣表：八个，三个标签都有。 */
export const SEED_INTERESTS: readonly SeedInterest[] = Object.freeze([
  { label: '天文', tag: 'focus' },
  { label: '旧硬件', tag: 'focus' },
  { label: '日语', tag: 'focus' },
  { label: '老电影', tag: 'relax' },
  { label: '做饭', tag: 'relax' },
  { label: '植物', tag: 'relax' },
  { label: '随笔', tag: 'create' },
  { label: '模型', tag: 'create' },
])

/**
 * 探索池：出厂不在表里的八个。
 *
 * 刻意与种子**完全不重名**：重名会让「探索出新兴趣」在日志里看起来像
 * 「又把旧兴趣加了一遍」，而权重会凭空多一份。
 */
export const EXPLORE_POOL: readonly SeedInterest[] = Object.freeze([
  { label: '手冲咖啡', tag: 'relax' },
  { label: '老唱片', tag: 'relax' },
  { label: '城市散步', tag: 'relax' },
  { label: '云', tag: 'relax' },
  { label: '小工具', tag: 'focus' },
  { label: '摄影', tag: 'create' },
  { label: '星座', tag: 'focus' },
  { label: '昆虫', tag: 'focus' },
])

/** 每类活动的时长（分钟）。自定值：只为让笔记读起来有分量，不参与任何判定。 */
export const DURATION_MIN: Readonly<Record<ActivityKind, number>> = Object.freeze({
  study: 45,
  read: 40,
  video: 30,
  diary: 25,
  daze: 15,
  chat: 20,
})

/** 权重上限：再高就等于「只会做这一件事」。 */
export const WEIGHT_CEIL = 3

/** 权重下限：留一点火种，别彻底归零（归零就再也抽不到它了）。 */
export const WEIGHT_FLOOR = 0.05

/** 做一次之后乘的系数。 */
export const WEIGHT_GROW = 1.15

/** 由标签短语派生稳定 id。中文不能直接做英文 id，用哈希。 */
export function idOf(label: string): string {
  return 'i-' + hash32(label).toString(36)
}

/**
 * 按半衰期衰减后的权重。
 * @param interest 兴趣。
 * @param at 当前时刻。
 * @param halfLifeHours 半衰期（小时）。
 */
export function effectiveWeightOf(interest: Interest, at: number, halfLifeHours: number): number {
  const halfLifeMs = Math.max(1, halfLifeHours) * 3_600_000
  const elapsed = Math.max(0, at - interest.lastAt)
  const factor = Math.pow(0.5, elapsed / halfLifeMs)
  const value = interest.weight * factor
  return Math.round(Math.max(WEIGHT_FLOOR, value) * 1000) / 1000
}

/**
 * 把一条落盘兴趣转成面板视图。
 * @param interest 兴趣。
 * @param at 当前时刻。
 * @param halfLifeHours 半衰期。
 */
export function viewOf(interest: Interest, at: number, halfLifeHours: number): InterestView {
  return Object.freeze({
    id: interest.id,
    label: interest.label,
    tag: interest.tag,
    weight: interest.weight,
    effectiveWeight: effectiveWeightOf(interest, at, halfLifeHours),
    lastAt: interest.lastAt,
    times: interest.times,
    source: interest.source,
  })
}

/**
 * 造一条新兴趣。
 * @param seed 标签与类别。
 * @param at 创建时刻。
 * @param source 来源。
 */
export function buildInterest(seed: SeedInterest, at: number, source: Interest['source']): Interest {
  return Object.freeze({
    id: idOf(seed.label),
    label: seed.label,
    tag: seed.tag,
    weight: 1,
    lastAt: at,
    times: 0,
    source,
  })
}

/** 选一次活动的入参。 */
export interface PickOptions {
  /** 当前时刻。 */
  readonly at: number
  /** 心情（0–1），`undefined` 表示读不到，按中性处理。 */
  readonly mood: number | undefined
  /** 心情低的阈值。 */
  readonly moodLowThreshold: number
  /** 探索概率。 */
  readonly exploreRate: number
  /** 半衰期（小时）。 */
  readonly halfLifeHours: number
  /** 确定性种子（`自然日#槽号`）。 */
  readonly slot: string
}

/** 一次选择的结果。 */
export interface PickResult {
  /** 选中或探索出的兴趣（视图）。 */
  readonly interest: InterestView
  /** 是否探索。 */
  readonly explore: boolean
  /** 活动类别。 */
  readonly kind: ActivityKind
  /** 时长（分钟）。 */
  readonly minutes: number
  /** 新兴趣的落盘形状；只有探索时才有。 */
  readonly created?: Interest
}

/** 心情权重：心情差就多歇着，但仍留小概率去碰烧脑的东西。 */
export function moodFactorOf(tag: InterestTag, mood: number | undefined, threshold: number): number {
  if (mood === undefined || mood >= threshold) return 1
  if (tag === 'relax') return 2.5
  if (tag === 'focus') return 0.5
  return 1
}

/**
 * 选一次活动。**不改状态、不写盘**。
 * @param interests 现有兴趣表。
 * @param options 入参。
 * @returns 选择结果；兴趣表为空时 `undefined`。
 */
export function pickActivity(
  interests: readonly Interest[],
  options: PickOptions,
): PickResult | undefined {
  if (interests.length === 0) return undefined

  // 1. 先判探索：哈希取一次 `[0,1)`，小于概率就探索。
  const roll = unitOf(options.slot, 'explore')
  if (roll < options.exploreRate) {
    const owned = new Set(interests.map(item => item.id))
    const fresh = EXPLORE_POOL.filter(item => !owned.has(idOf(item.label)))
    if (fresh.length > 0) {
      const index = Math.floor(unitOf(options.slot, 'explore-pick') * fresh.length) % fresh.length
      const picked = fresh[index]
      const created = buildInterest(picked, options.at, 'explored')
      return finish(created, true, options)
    }
    // 池子已经全被探索完：不重复造同名兴趣（那等于凭空多一份权重），落回普通抽取。
  }

  // 2. 普通抽取：有效权重 × 心情系数。
  const scored = interests.map(item => ({
    item,
    score:
      effectiveWeightOf(item, options.at, options.halfLifeHours) *
      moodFactorOf(item.tag, options.mood, options.moodLowThreshold),
  }))
  const total = scored.reduce((sum, entry) => sum + entry.score, 0)
  if (total <= 0) {
    // 全部权重为 0（只可能来自被手工改过的存档）：退化到「第一个」，至少不空转。
    return finish(interests[0], false, options)
  }

  let cursor = unitOf(options.slot, 'interest') * total
  for (const entry of scored) {
    cursor -= entry.score
    if (cursor <= 0) return finish(entry.item, false, options)
  }
  // 浮点误差落到最后一个（不会越过 total 太多）。
  return finish(scored[scored.length - 1].item, false, options)
}

/**
 * 给选中的兴趣定类别与时长。类别只从该标签的类别表里取，用哈希决定。
 * @param interest 兴趣（落盘或新建）。
 * @param explore 是否探索。
 * @param options 入参。
 */
function finish(interest: Interest, explore: boolean, options: PickOptions): PickResult {
  const kinds = KINDS_BY_TAG[interest.tag]
  const index = Math.floor(unitOf(options.slot, 'kind', interest.id) * kinds.length) % kinds.length
  const kind = kinds[index]
  return {
    interest: viewOf(interest, options.at, options.halfLifeHours),
    explore,
    kind,
    minutes: DURATION_MIN[kind],
    created: explore ? interest : undefined,
  }
}

/**
 * 一条笔记的正文。**不写评价、不写情绪**：那是 O-031/O-040 的事。
 * @param kind 类别。
 * @param label 兴趣名。
 */
export function noteTextOf(kind: ActivityKind, label: string): string {
  switch (kind) {
    case 'study':
      return '翻着' + label + '的资料，学了一会儿'
    case 'read':
      return '看了会儿' + label
    case 'video':
      return '刷了会儿跟' + label + '有关的视频'
    case 'diary':
      return '在本子上写了几行，写的是' + label
    case 'daze':
      return '发了会儿呆，想着' + label
    case 'chat':
      return '在群里冒了个泡，聊到' + label
  }
}

/**
 * 保留期：有内容沉淀的进长期（记忆候选），纯消遣进临时（1 天工作记忆）。
 * @param kind 类别。
 */
export function retentionOf(kind: ActivityKind): Retention {
  if (kind === 'study' || kind === 'read' || kind === 'diary') return 'long'
  return 'temp'
}
